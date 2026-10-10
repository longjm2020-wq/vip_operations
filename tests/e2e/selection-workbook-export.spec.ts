import { expect, test, type Download, type Page } from "@playwright/test";
import Excel from "exceljs";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";
import { parseSelectionWorkbook } from "../../apps/web/src/selection-workbook.js";

type ExportRow = Record<string, unknown> & { id: string };
const archiveTableId = "777";
const pictureUrl = "https://export-images.example.test/photo.png";
const row = (id: number, values: Record<string, unknown> = {}): ExportRow => ({
  id: String(id), sortOrder: id, xutiStyleNo: "", images: [], labelImages: [], extraFields: {},
  createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
  defaultCellAccess: "read", cellAccess: {}, ...values,
});

async function fixture(page: Page, initialRows: ExportRow[]) {
  let currentRows = initialRows;
  const downloads: Download[] = [];
  const syncRequests: { tableId: string | null; known: unknown }[] = [];
  const writes: string[] = [];
  let preferences = selectionLayoutSchema.parse({
    columns: [
      { key: "xutiStyleNo", label: "序缇款号", width: 160, type: "text" },
      { key: "supplierStyleNo", label: "供应商款号", width: 140, type: "text" },
      { key: "supplierCode", label: "供应商编码", width: 140, type: "text" },
      { key: "material", label: "材质", width: 180, type: "text" },
      { key: "vipPrice", label: "唯品价", width: 120, type: "currency" },
      { key: "images", label: "图片", width: 120, type: "image" },
      { key: "custom:note", label: "自定义备注", width: 140, custom: true, type: "text" },
      { key: "custom:photos", label: "自定义图片", width: 120, custom: true, type: "image" },
    ],
    rowHeight: "compact", pageSize: 500,
  });
  page.on("download", download => downloads.push(download));
  await page.route("https://export-images.example.test/**", route => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="white"/></svg>',
  }));
  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = {
      id: "101", displayName: "商品档案导出测试", roleCodes: [], csrfToken: "fixture",
      permissions: ["product.read"],
    };
    if (path.endsWith("/product-archive-table")) data = {
      id: archiveTableId, initialLayout: "selection", canEdit: false, canManage: false,
      fields: preferences.columns, references: {}, layoutGeneration: 0,
    };
    if (path.endsWith("/revision")) data = { revision: "archive-export-fixture" };
    if (path.endsWith("/sync")) {
      syncRequests.push({ tableId: url.searchParams.get("tableId"), known: request.postDataJSON().known });
      data = {
        revision: "archive-export-fixture",
        index: currentRows.map(record => ({ id: record.id, token: record.updatedAt })),
        data: currentRows,
      };
    }
    if (path.endsWith("/layout-preferences")) {
      if (request.method() === "POST") preferences = request.postDataJSON().preferences;
      data = { preferences, revision: 1, sharedPreferences: null, sharedRevision: 0, canEditShared: false };
    }
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (["PATCH", "DELETE"].includes(request.method()) ||
      request.method() === "POST" && (/\/style-selections$/.test(path) || path.includes("/import"))) writes.push(path);
    await route.fulfill({ json: { data } });
  });
  await page.goto("/products");
  await expect(page.getByRole("heading", { name: "商品档案", exact: true })).toBeVisible();
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(initialRows.length);
  await expect(page.getByRole("button", { name: "导出", exact: true })).toBeEnabled();
  return {
    downloads, syncRequests, writes,
    refreshWith: (records: ExportRow[]) => { currentRows = records; },
  };
}

async function exportAllVisibleRows(page: Page) {
  await page.getByRole("checkbox", { name: "选择全部可见行", exact: true }).check();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByRole("menuitem", { name: "导出 Excel", exact: true }).click();
}

test("商品档案全选有款号资料和空白草稿可下载，草稿格式和空图片配置不进入 Excel", async ({ page }) => {
  const state = await fixture(page, [
    row(101, { xutiStyleNo: "0001", supplierCode: "0007", material: "纯棉100%", vipPrice: "0.00" }),
    row(102, { xutiStyleNo: "ARCHIVE-2", material: "羊毛100%" }),
    row(103, { rowColor: "BLUE", cellColors: { material: "GREEN" }, cellTextColors: { material: "#cf1322" }, extraFields: { "custom:photos": "[]" } }),
    row(104, { xutiStyleNo: "  ", material: "\n ", extraFields: { "custom:note": " ", "custom:photos": "[ ]" } }),
  ]);
  const syncCount = state.syncRequests.length;
  const ready = page.waitForEvent("download");
  await exportAllVisibleRows(page);
  const download = await ready;
  const book = new Excel.Workbook();
  const file = (await download.path())!;
  await book.xlsx.readFile(file);
  const sheet = book.getWorksheet("选款资料")!;
  expect(sheet.rowCount).toBe(3);
  expect(sheet.getColumn(4).values.slice(2)).toEqual(["0001", "ARCHIVE-2"]);
  expect(sheet.getCell("F2").value).toBe("0007");
  expect(sheet.getCell("K2").value).toBe("0.00");
  const buffer = await book.xlsx.writeBuffer();
  const parsed = await parseSelectionWorkbook(buffer as unknown as ArrayBuffer);
  expect(parsed).toHaveLength(2);
  expect(parsed[0]).toMatchObject({ xutiStyleNo: "0001", supplierCode: "0007", vipPrice: "0.00" });
  await expect.poll(() => state.syncRequests.length).toBe(syncCount + 1);
  expect(state.syncRequests.at(-1)).toEqual({ tableId: archiveTableId, known: {} });
  expect(state.writes).toEqual([]);
});

test("有内容的自定义字段、零金额和图片缺号不能静默跳过，提示原导出范围位置和供应商资料", async ({ page }) => {
  const state = await fixture(page, [
    row(101, { xutiStyleNo: "ARCHIVE-1" }),
    row(102),
    row(103, { extraFields: { "custom:note": "已填写的资料" } }),
    row(104, { vipPrice: 0 }),
    row(105, { images: [{ id: "photo", url: pictureUrl, color: "" }] }),
    row(106, { supplierStyleNo: "SUPPLIER-6", supplierCode: "CODE-6" }),
  ]);
  await exportAllVisibleRows(page);
  await expect(page.getByText(
    "导出范围内有 4 条已填写内容的记录缺少序缇款号：第 3 条、第 4 条、第 5 条、第 6 条（供应商款号：SUPPLIER-6；供应商编码：CODE-6）。请补齐后导出，空白行会自动忽略",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByRole("button", { name: "导出", exact: true })).toBeEnabled();
  expect(state.downloads).toEqual([]);
  expect(state.writes).toEqual([]);
});

test("商品档案全选仅空白草稿时提示没有可导出的款式并且不下载空文件", async ({ page }) => {
  const state = await fixture(page, [
    row(101, { rowColor: "PINK", cellAlignments: { material: "left" } }),
    row(102, { xutiStyleNo: "\n ", extraFields: { "custom:photos": "[]" } }),
  ]);
  await exportAllVisibleRows(page);
  await expect(page.getByText("没有可导出的款式", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "导出", exact: true })).toBeEnabled();
  expect(state.downloads).toEqual([]);
  expect(state.writes).toEqual([]);
});

test("导出重新读取后发现空草稿隐藏字段仍拒绝，不能通过忽略空行绕过当前查看权限", async ({ page }) => {
  const visible = [row(101, { xutiStyleNo: "ARCHIVE-1" }), row(102)];
  const state = await fixture(page, visible);
  const syncCount = state.syncRequests.length;
  state.refreshWith([visible[0], { ...visible[1], hiddenCells: ["material"] }]);
  await exportAllVisibleRows(page);
  await expect(page.getByText("选中款式包含禁止查看的字段，请联系管理员调整权限后导出", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "导出", exact: true })).toBeEnabled();
  expect(state.syncRequests.length).toBe(syncCount + 1);
  expect(state.syncRequests.at(-1)).toEqual({ tableId: archiveTableId, known: {} });
  expect(state.downloads).toEqual([]);
  expect(state.writes).toEqual([]);
});

import { expect, test, type Download, type Page } from "@playwright/test";
import Excel from "exceljs";
import { selectionLayoutSchema, type SelectionLayout } from "../../packages/contracts/src/selection-layout.js";
import { selectionSheetColumns } from "../../apps/web/src/selection-workbook.js";

const rowValues = (row: Excel.Row) => Array.isArray(row.values) ? row.values.slice(1) : [];
type ExportRow = Record<string, unknown> & { id: string };
const archiveTableId = "777";
const pictureUrl = "https://export-images.example.test/photo.png";
const row = (id: number, values: Record<string, unknown> = {}): ExportRow => ({
  id: String(id), sortOrder: id, xutiStyleNo: "", images: [], labelImages: [], extraFields: {},
  createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
  defaultCellAccess: "read", cellAccess: { "custom:note": "read", "custom:photos": "read" }, ...values,
});

async function fixture(page: Page, initialRows: ExportRow[], initialPreferences?: SelectionLayout) {
  let currentRows = initialRows;
  const downloads: Download[] = [];
  const syncRequests: { tableId: string | null; known: unknown }[] = [];
  const layoutRequests: { tableId: string | null; shared: string | null }[] = [];
  const writes: string[] = [];
  let preferences = initialPreferences ?? selectionLayoutSchema.parse({
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
      layoutRequests.push({ tableId: url.searchParams.get("tableId"), shared: url.searchParams.get("shared") });
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
    downloads, syncRequests, layoutRequests, writes,
    refreshWith: (records: ExportRow[]) => { currentRows = records; },
    refreshPreferences: (next: SelectionLayout) => { preferences = next; },
  };
}

async function exportAllVisibleRows(page: Page) {
  await page.getByRole("checkbox", { name: "选择全部可见行", exact: true }).check();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByRole("menuitem", { name: "导出 Excel", exact: true }).click();
}

test("商品档案导出当前可见列的顺序和自定义字段，自动跳过仅格式或空图片的草稿", async ({ page }) => {
  const state = await fixture(page, [
    row(101, { xutiStyleNo: "0001", supplierCode: "0007", material: "纯棉100%", vipPrice: "0.00", extraFields: { "custom:note": "新增备注" } }),
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
  const sheet = book.getWorksheet("表格资料")!;
  expect(sheet.rowCount).toBe(3);
  expect(rowValues(sheet.getRow(1))).toEqual(["序缇款号", "供应商款号", "供应商编码", "材质", "唯品价", "图片", "自定义备注", "自定义图片"]);
  expect(sheet.getColumn(1).values.slice(2)).toEqual(["0001", "ARCHIVE-2"]);
  expect(sheet.getCell("C2").value).toBe("0007");
  expect(sheet.getCell("E2").value).toBe("0.00");
  expect(sheet.getCell("G2").value).toBe("新增备注");
  expect(book.getWorksheet("选款资料")).toBeUndefined();
  await expect.poll(() => state.syncRequests.length).toBe(syncCount + 1);
  expect(state.syncRequests.at(-1)).toEqual({ tableId: archiveTableId, known: {} });
  expect(state.layoutRequests.at(-1)).toEqual({ tableId: archiveTableId, shared: "true" });
  expect(state.writes).toEqual([]);
});

test("可见字段资料快照逐行保留缺款号、自定义内容、零金额和图片记录", async ({ page }) => {
  const state = await fixture(page, [
    row(101, { xutiStyleNo: "ARCHIVE-1" }),
    row(102),
    row(103, { extraFields: { "custom:note": "已填写的资料" } }),
    row(104, { vipPrice: 0 }),
    row(105, { images: [{ id: "photo", url: pictureUrl, color: "" }] }),
    row(106, { supplierStyleNo: "SUPPLIER-6", supplierCode: "CODE-6" }),
  ]);
  const ready = page.waitForEvent("download");
  await exportAllVisibleRows(page);
  const book = new Excel.Workbook();
  await book.xlsx.readFile((await (await ready).path())!);
  const sheet = book.getWorksheet("表格资料")!;
  expect(sheet.rowCount).toBe(6);
  expect(sheet.getCell("G3").text).toBe("已填写的资料");
  expect(sheet.getCell("E4").text).toBe("0");
  expect(sheet.getCell("F5").text).toBe("见图片明细");
  expect(sheet.getCell("B6").text).toBe("SUPPLIER-6");
  expect(sheet.getCell("C6").text).toBe("CODE-6");
  expect(rowValues(book.getWorksheet("图片明细")!.getRow(2))).toEqual(["5", "6", "图片", "", pictureUrl]);
  await expect(page.getByRole("button", { name: "导出", exact: true })).toBeEnabled();
  expect(state.downloads).toHaveLength(1);
  expect(state.writes).toEqual([]);
});

test("商品档案全选仅空白草稿时提示没有可导出的资料并且不下载空文件", async ({ page }) => {
  const state = await fixture(page, [
    row(101, { rowColor: "PINK", cellAlignments: { material: "left" } }),
    row(102, { xutiStyleNo: "\n ", extraFields: { "custom:photos": "[]" } }),
  ]);
  await exportAllVisibleRows(page);
  await expect(page.getByText("没有可导出的资料", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "导出", exact: true })).toBeEnabled();
  expect(state.downloads).toEqual([]);
  expect(state.writes).toEqual([]);
});

test("导出重新读取查看权限，禁止查看的单元格仅保留遮罩且不输出隐藏真实内容", async ({ page }) => {
  const visible = [row(101, { xutiStyleNo: "ARCHIVE-1" }), row(102)];
  const state = await fixture(page, visible);
  const syncCount = state.syncRequests.length;
  state.refreshWith([visible[0], { ...visible[1], material: "DENIED_MATERIAL_SECRET", hiddenCells: ["material"] }]);
  const ready = page.waitForEvent("download");
  await exportAllVisibleRows(page);
  const book = new Excel.Workbook();
  await book.xlsx.readFile((await (await ready).path())!);
  expect(book.getWorksheet("表格资料")!.rowCount).toBe(3);
  expect(book.getWorksheet("表格资料")!.getCell("D3").text).toBe("••••");
  expect(JSON.stringify(book.model)).not.toContain("DENIED_MATERIAL_SECRET");
  await expect(page.getByRole("button", { name: "导出", exact: true })).toBeEnabled();
  expect(state.syncRequests.length).toBe(syncCount + 1);
  expect(state.syncRequests.at(-1)).toEqual({ tableId: archiveTableId, known: {} });
  expect(state.downloads).toHaveLength(1);
  expect(state.writes).toEqual([]);
});

test("导出重新核验布局，撤销的私有与系统字段、隐藏图片列不会进入主表或图片明细", async ({ page }) => {
  const preferences = selectionLayoutSchema.parse({
    columns: [
      { key: "custom:note", label: "私有备注", width: 140, custom: true, visibility: "PRIVATE", type: "text" },
      { key: "xutiStyleNo", label: "旧款号名称", width: 160, type: "text" },
      { key: "images", label: "产品图片", width: 120, type: "image" },
      { key: "custom:creator", label: "创建人", width: 140, custom: true, type: "creator" },
      { key: "custom:photos", label: "证据图片", width: 120, custom: true, type: "image" },
      { key: "supplierCode", label: "旧供应商编码", width: 140, type: "text" },
    ],
    rowHeight: "compact", pageSize: 500,
  });
  const records = [row(101, {
    xutiStyleNo: "0001", supplierCode: "0019", createdBy: "55", createdByName: "REVOKED_CREATOR_SECRET",
    images: [{ id: "secret", url: "https://export-images.example.test/HIDDEN_IMAGE_SECRET.png", color: "" }],
    cellAccess: { "custom:note": "read", "custom:photos": "read", "custom:creator": "read" },
    extraFields: { "custom:note": "PRIVATE_NOTE_SECRET", "custom:photos": JSON.stringify([{ id: "custom-secret", url: "https://export-images.example.test/DELETED_PHOTO_SECRET.png", color: "" }]) },
  })];
  const state = await fixture(page, records, preferences);
  state.refreshPreferences(selectionLayoutSchema.parse({
    ...preferences,
    columns: [
      { ...preferences.columns[5], label: "供应商编码" },
      { ...preferences.columns[1], label: "款号" },
      preferences.columns[2],
      { ...preferences.columns[4], deleted: true },
    ],
    hiddenColumns: ["images"],
  }));
  const ready = page.waitForEvent("download");
  await exportAllVisibleRows(page);
  const book = new Excel.Workbook();
  await book.xlsx.readFile((await (await ready).path())!);
  expect(rowValues(book.getWorksheet("表格资料")!.getRow(1))).toEqual(["款号", "供应商编码"]);
  expect(rowValues(book.getWorksheet("表格资料")!.getRow(2))).toEqual(["0001", "0019"]);
  expect(book.getWorksheet("图片明细")).toBeUndefined();
  for (const secret of ["REVOKED_CREATOR_SECRET", "PRIVATE_NOTE_SECRET", "HIDDEN_IMAGE_SECRET", "DELETED_PHOTO_SECRET"]) expect(JSON.stringify(book.model)).not.toContain(secret);
  expect(state.layoutRequests.at(-1)).toEqual({ tableId: archiveTableId, shared: "true" });
  expect(state.writes).toEqual([]);
});

test("导入下载模板保持标准固定字段，不受当前表格自定义列影响", async ({ page }) => {
  const state = await fixture(page, [row(101, { xutiStyleNo: "0001" })]);
  const syncCount = state.syncRequests.length;
  const ready = page.waitForEvent("download");
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page.getByRole("menuitem", { name: "下载模板", exact: true }).click();
  const download = await ready;
  const book = new Excel.Workbook();
  await book.xlsx.readFile((await download.path())!);
  expect(download.suggestedFilename()).toBe("选款登记导入模板.xlsx");
  expect(book.getWorksheet("选款资料")!.rowCount).toBe(1);
  expect(rowValues(book.getWorksheet("选款资料")!.getRow(1))).toEqual(selectionSheetColumns.map(([, label]) => label));
  expect(book.getWorksheet("表格资料")).toBeUndefined();
  expect(state.syncRequests.length).toBe(syncCount);
  expect(state.writes).toEqual([]);
});

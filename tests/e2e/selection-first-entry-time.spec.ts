import { expect, test, type Locator, type Page } from "@playwright/test";
import { projectSelectionSharedLayout, selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";

type Row = Record<string, any>;
const firstEntryTime = "2026-10-16T06:30:00.000Z";
const firstEntryDisplay = "2026-10-16 14:30:00";
const originalTime = "2026-10-14T01:02:03.000Z";
const systemTimeKey = "custom:first-entry-created";

async function fixture(page: Page, path = "/style-selections") {
  let revision = 1, layoutRevision = 1;
  let preferences = selectionLayoutSchema.parse({ columns: [
    { key: "registrationBatch", label: "创建时间", type: "createdTime", timeDisplay: "datetime", width: 180 },
    { key: "xutiStyleNo", label: "序缇款号", type: "text", width: 125 },
    { key: "supplierStyleNo", label: "供应商款号", type: "text", width: 125 },
    { key: "images", label: "图片", type: "image", width: 100 },
    { key: "supplyPriceExclTax", label: "供货价", type: "number", width: 100 },
    { key: "labelImages", label: "洗唛/吊牌图", type: "image", width: 100 },
    { key: "material", label: "成分", type: "text", width: 125 },
    { key: systemTimeKey, label: "自动创建时间", type: "createdTime", timeDisplay: "datetime", width: 180, custom: true, ownerId: "101", visibility: "PUBLIC", fieldRevision: 1 },
  ], rowHeight: "compact", pageSize: 200, sort: "sortOrder", direction: "asc" });
  const records: Row[] = Array.from({ length: 4 }, (_, index) => ({
    id: String(index + 1), sortOrder: index + 1,
    xutiStyleNo: index === 1 ? "EXISTING-STYLE" : "", supplierStyleNo: "", material: "",
    images: [], labelImages: [], extraFields: {}, supplyPriceExclTax: index === 2 ? "88" : null,
    createdAt: index === 1 ? originalTime : null, creationTimePending: index !== 1,
    updatedAt: "2026-10-16T00:00:00.001Z", defaultCellAccess: "edit", policyRevision: 0,
  }));
  const writes: { id: string; body: Row }[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), apiPath = new URL(request.url()).pathname;
    let data: unknown = [];
    if (apiPath.endsWith("/auth/me")) data = { id: "101", displayName: "首录时间测试", roleCodes: ["SUPER_ADMIN"], csrfToken: "fixture", permissions: ["selection.read", "selection.manage", "product.read", "product.update", "product.create", "project.read", "project.create"] };
    if (apiPath.endsWith("/product-archive-table")) data = { id: "3", initialLayout: "selection", fields: [], references: {}, canEdit: true, canManage: true };
    if (apiPath.endsWith("/project-tables/7")) data = { id: "7", name: "首录协作表", initialLayout: "selection", canEdit: true, canManage: true };
    if (apiPath.endsWith("/revision")) data = { revision: `first-entry-${revision}` };
    if (apiPath.endsWith("/sync")) data = { revision: `first-entry-${revision}`, index: records.map(row => ({ id: row.id, token: row.updatedAt })), data: records };
    if (apiPath.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (apiPath.endsWith("/protection")) data = { settings: defaultProtection, revision: 0, canManage: false };
    if (apiPath.endsWith("/layout-preferences")) {
      if (request.method() === "POST") { preferences = selectionLayoutSchema.parse(request.postDataJSON().preferences); layoutRevision++; }
      data = { preferences, revision: layoutRevision, sharedPreferences: projectSelectionSharedLayout(preferences), sharedRevision: layoutRevision, canEditShared: true };
    }
    const record = records.find(row => apiPath.endsWith(`/style-selections/${row.id}`));
    if (record && request.method() === "PATCH") {
      const body = request.postDataJSON(); writes.push({ id: record.id, body });
      if (body.expectedUpdatedAt !== record.updatedAt) return route.fulfill({ status: 409, json: { error: { code: "EDIT_CONFLICT", message: "记录已被其他用户修改" } } });
      const next = { ...record, ...body, extraFields: { ...record.extraFields, ...body.extraFields } };
      const hasEntry = String(next.xutiStyleNo || "").trim() || String(next.supplierStyleNo || "").trim() || next.images?.length;
      if (Object.hasOwn(body, "createdAt") && (!body.createdAt || record.creationTimePending && !hasEntry)) {
        const message = !body.createdAt ? "创建时间不能为空" : "首次填写创建时间前，请先填写图片、序缇款号或供应商款号";
        return route.fulfill({ status: 400, json: { error: { code: "VALIDATION_ERROR", message, details: { fieldErrors: { createdAt: [message] } } } } });
      }
      const createdAt = Object.hasOwn(body, "createdAt") ? body.createdAt : record.creationTimePending && hasEntry ? firstEntryTime : record.createdAt;
      delete next.expectedUpdatedAt; delete next.ensureTrailingBlank;
      Object.assign(record, next, { createdAt, creationTimePending: !createdAt, updatedAt: new Date(Date.UTC(2026, 9, 16) + ++revision).toISOString() });
      data = record;
    }
    await route.fulfill({ json: { data } });
  });
  await page.route("https://supplier.example.test/**", route => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6h70AAAAASUVORK5CYII=", "base64") }));
  await page.goto(path);
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(4);
  return { records, writes, row: (id: string) => records.find(row => row.id === id)! };
}

const cell = (page: Page, id: string, key: string) => page.locator(`td[data-selection-row="${id}"][data-selection-column="${key}"]`);
const createdCell = (page: Page, id: string) => cell(page, id, "registrationBatch");
const createdInput = (page: Page, id: string) => createdCell(page, id).locator("input,textarea");
const input = (page: Page, id: string, key: string) => cell(page, id, key).locator("input,textarea").first();
async function paste(target: Locator, text: string) {
  // Focus the grid cell itself; clicking an empty photo cell opens its gallery.
  await target.focus();
  await target.evaluate((element, value) => {
    const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", value);
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  }, text);
}

for (const [label, path] of [["选款登记", "/style-selections"], ["商品档案", "/products"], ["项目协作表格", "/project-tables/7"]]) {
  test(`${label}待首录时间在内置列、自建列和编辑栏均留空，供应商款号首录后显示并保留`, async ({ page }) => {
    const state = await fixture(page, path);
    await expect(createdInput(page, "1")).toHaveValue("");
    await expect(cell(page, "1", systemTimeKey)).toHaveText("");
    await createdCell(page, "1").click();
    await expect(page.getByRole("group", { name: "单元格编辑栏", exact: true }).getByRole("textbox", { name: "编辑创建时间", exact: true })).toHaveValue("");
    await cell(page, "1", systemTimeKey).click();
    await expect(page.getByRole("group", { name: "单元格编辑栏", exact: true }).getByRole("textbox")).toHaveValue("");
    await expect(createdCell(page, "1")).not.toContainText(/未记录|保存后生成/u);
    await input(page, "1", "supplierStyleNo").fill("FIRST-SUPPLIER-001");
    await expect.poll(() => state.row("1").creationTimePending).toBe(false);
    await expect(createdInput(page, "1")).toHaveValue(firstEntryDisplay);
    await expect(cell(page, "1", systemTimeKey)).toHaveText(firstEntryDisplay);
    await input(page, "1", "supplierStyleNo").fill("");
    await expect.poll(() => state.row("1").supplierStyleNo || "").toBe("");
    expect(state.row("1").createdAt).toBe(firstEntryTime);
    await page.reload();
    await expect(createdInput(page, "1")).toHaveValue(firstEntryDisplay);
    await expect(cell(page, "1", systemTimeKey)).toHaveText(firstEntryDisplay);
  });
}

test("价格、成分、洗唛图片和格式不算首录，首次填序缇款号才显示时间", async ({ page }) => {
  const state = await fixture(page);
  await input(page, "1", "supplyPriceExclTax").fill("99");
  await expect.poll(() => state.row("1").supplyPriceExclTax).toBe("99");
  await input(page, "1", "material").fill("仅填写成分");
  await expect.poll(() => state.row("1").material).toBe("仅填写成分");
  await paste(cell(page, "1", "labelImages"), "https://supplier.example.test/label.png");
  await expect.poll(() => state.row("1").labelImages.length).toBe(1);
  await cell(page, "1", "material").click();
  await page.getByRole("button", { name: "右对齐", exact: true }).click();
  await expect.poll(() => state.row("1").cellAlignments?.material).toBe("right");
  expect(state.row("1").createdAt).toBeNull();
  expect(state.row("1").creationTimePending).toBe(true);
  await expect(createdInput(page, "1")).toHaveValue("");
  await expect(cell(page, "1", systemTimeKey)).toHaveText("");
  expect(state.writes.every(write => !Object.hasOwn(write.body, "createdAt"))).toBe(true);
  await input(page, "1", "xutiStyleNo").fill("FIRST-XUTI-001");
  await expect.poll(() => state.row("1").createdAt).toBe(firstEntryTime);
  await expect(createdInput(page, "1")).toHaveValue(firstEntryDisplay);
  await input(page, "1", "xutiStyleNo").fill("");
  await expect.poll(() => state.row("1").xutiStyleNo || "").toBe("");
  expect(state.row("1").createdAt).toBe(firstEntryTime);
});

test("首次添加产品图片记录时间，已有创建时间修改其他资料保持原时间", async ({ page }) => {
  const state = await fixture(page);
  await paste(cell(page, "1", "images"), "https://supplier.example.test/product.png");
  await expect.poll(() => state.row("1").images.length).toBe(1);
  expect(state.row("1").createdAt).toBe(firstEntryTime);
  await expect(createdInput(page, "1")).toHaveValue(firstEntryDisplay);
  await input(page, "2", "material").fill("已有款新成分");
  await expect.poll(() => state.row("2").material).toBe("已有款新成分");
  expect(state.row("2").createdAt).toBe(originalTime);
  expect(state.writes.find(write => write.id === "2")?.body).not.toHaveProperty("createdAt");
});

test("首次只填日期给出明确错误，同时补齐款号后保存指定日期，已有日期可修改但不能清空", async ({ page }) => {
  const state = await fixture(page);
  await createdInput(page, "1").fill("2025/4/22 0:42");
  await expect(createdCell(page, "1")).toHaveClass(/selection-cell-error/u);
  await expect(createdCell(page, "1")).toHaveAttribute("title", /图片|序缇款号|供应商款号/u);
  expect(state.row("1").createdAt).toBeNull();
  expect(state.row("1").creationTimePending).toBe(true);
  await input(page, "1", "xutiStyleNo").fill("MANUAL-FIRST-001");
  await expect.poll(() => state.row("1").createdAt).toBe("2025-04-21T16:42:00.000Z");
  await expect(createdInput(page, "1")).toHaveValue("2025-04-22 00:42:00");
  await expect(createdCell(page, "1")).not.toHaveClass(/selection-cell-error/u);
  await createdInput(page, "1").fill("2025-04-23 10:20:30");
  await expect.poll(() => state.row("1").createdAt).toBe("2025-04-23T02:20:30.000Z");
  await expect(page.getByRole("button", { name: "撤销", exact: true })).toBeEnabled();
  // Empty fill sends Delete; enter text editing so it does not invoke the
  // grid's separate whole-cell clearing command, which preserves system time.
  await createdInput(page, "1").dblclick();
  await createdInput(page, "1").fill("");
  await expect(createdInput(page, "1")).toHaveValue("");
  await expect(createdCell(page, "1")).toHaveClass(/selection-cell-error/u);
  await expect(createdCell(page, "1")).toHaveAttribute("title", /不能为空/u);
  expect(state.row("1").createdAt).toBe("2025-04-23T02:20:30.000Z");
});

test("Excel日期与款号一并粘贴可首录多行，保存的是文件日期而非当前时间", async ({ page }) => {
  const state = await fixture(page);
  await paste(createdCell(page, "3"), "2025/4/22 0:42\tEXCEL-FIRST-003\n2025/4/23 1:05\tEXCEL-FIRST-004");
  await expect.poll(() => state.row("3").createdAt).toBe("2025-04-21T16:42:00.000Z");
  await expect.poll(() => state.row("4").createdAt).toBe("2025-04-22T17:05:00.000Z");
  await expect(createdInput(page, "3")).toHaveValue("2025-04-22 00:42:00");
  await expect(createdInput(page, "4")).toHaveValue("2025-04-23 01:05:00");
  expect(state.row("3").creationTimePending).toBe(false);
  expect(state.row("4").creationTimePending).toBe(false);
  expect(state.row("3").supplyPriceExclTax).toBe("88");
  await page.reload();
  await expect(createdInput(page, "3")).toHaveValue("2025-04-22 00:42:00");
  await expect(createdInput(page, "4")).toHaveValue("2025-04-23 01:05:00");
});

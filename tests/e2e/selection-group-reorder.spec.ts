import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  projectSelectionSharedLayout,
  selectionLayoutSchema,
  type SelectionLayoutSnapshot,
} from "../../packages/contracts/src/selection-layout.js";

const keys = ["xutiStyleNo", "supplierStyleNo", "supplierCode", "color", "sizeRange", "material"];
const labels = ["序缇款号", "供应商款号", "供应商编码", "颜色", "尺码范围", "材质"];

async function fixture(page: Page, options: { readonly?: boolean; protected?: boolean; shared?: boolean; fixedColumns?: string[] } = {}) {
  const preferences = selectionLayoutSchema.parse({
    columns: keys.map((key, index) => ({ key, label: labels[index], width: 120 })),
    fixedColumns: options.fixedColumns || [],
    rowHeight: "compact",
  });
  let layout: SelectionLayoutSnapshot = {
    preferences, revision: 1,
    sharedRevision: options.shared ? 1 : 0,
    sharedPreferences: options.shared ? projectSelectionSharedLayout(preferences) : null,
    canEditShared: !options.readonly,
  };
  const rows = Array.from({ length: 7 }, (_, index) => ({
    id: String(100 + index), xutiStyleNo: `GROUP-${index}`, supplierStyleNo: `SUPPLIER-${index}`,
    supplierCode: `CODE-${index}`, color: "黑色", sizeRange: "M", material: "棉",
    images: [], labelImages: [], extraFields: {}, sortOrder: index + 1,
    updatedAt: "2026-10-10T00:00:00.000Z",
    defaultCellAccess: "edit",
    cellAccess: options.protected && index === 6 ? { material: "read" } : {},
  }));
  const patches: { id: string; body: Record<string, unknown> }[] = [];
  const layoutWrites: Record<string, unknown>[] = [];
  let revision = 0;
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = {
      id: "10", displayName: "成组调序测试", roleCodes: [], csrfToken: "fixture",
      permissions: options.readonly ? ["selection.read"] : ["selection.read", "selection.manage"],
    };
    if (path.endsWith("/revision")) data = { revision: `group-${revision}` };
    if (path.endsWith("/sync")) {
      const sorted = [...rows].sort((left, right) => left.sortOrder - right.sortOrder);
      data = { revision: `group-${revision}`, index: sorted.map(row => ({ id: row.id, token: row.updatedAt })), data: sorted };
    }
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        layoutWrites.push(body);
        layout = { ...layout, preferences: body.preferences, revision: layout.revision + 1 };
      }
      data = layout;
    }
    const row = rows.find(item => path.endsWith(`/style-selections/${item.id}`));
    if (row && route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      patches.push({ id: row.id, body });
      if (typeof body.sortOrder === "number") row.sortOrder = body.sortOrder;
      row.updatedAt = new Date(Date.UTC(2026, 9, 10) + ++revision).toISOString();
      data = row;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(7);
  await expect.poll(() => columnOrder(page)).toEqual(keys);
  return {
    patches, layoutWrites,
    savedColumnOrder: () => layout.preferences!.columns.map(column => column.key),
    savedRowOrder: () => [...rows].sort((left, right) => left.sortOrder - right.sortOrder).map(row => Number(row.id) - 100),
  };
}

const header = (page: Page, key: string) => page.locator(`thead th[data-selection-column="${key}"]`);
const rowAxis = (page: Page, index: number) => page.locator(`td[data-reorder-axis="row"][data-reorder-key="${100 + index}"]`);
const columnOrder = (page: Page) => page.locator("thead th[data-selection-column]").evaluateAll(elements => elements.map(element => element.getAttribute("data-selection-column")));
const rowOrder = (page: Page) => page.locator("tr[data-selection-row]").evaluateAll(elements => elements.map(element => Number(element.getAttribute("data-selection-row")) - 100));
const selectedColumns = (page: Page) => page.locator("thead th[data-column-selected]").evaluateAll(elements => elements.map(element => element.getAttribute("data-selection-column")));
const selectedRows = (page: Page) => page.locator("td[data-reorder-axis='row'].selection-axis-active").evaluateAll(elements => elements.map(element => Number(element.getAttribute("data-reorder-key")) - 100));

async function drag(page: Page, from: Locator, to: Locator, options: { shift?: boolean; escape?: boolean } = {}) {
  const start = (await from.boundingBox())!, end = (await to.boundingBox())!;
  if (options.shift) await page.keyboard.down("Shift");
  await page.mouse.move(start.x + 18, start.y + 12);
  await page.mouse.down();
  await page.mouse.move(end.x + 18, end.y + 12, { steps: 8 });
  if (options.escape) await page.keyboard.press("Escape");
  await page.mouse.up();
  if (options.shift) await page.keyboard.up("Shift");
}

test("a selected column group moves from either header without Shift and keeps its order and selection", async ({ page }) => {
  const state = await fixture(page);
  await drag(page, header(page, "supplierStyleNo"), header(page, "supplierCode"));
  await expect.poll(() => selectedColumns(page)).toEqual(["supplierStyleNo", "supplierCode"]);
  await drag(page, header(page, "supplierCode"), header(page, "material"));
  await expect.poll(() => columnOrder(page)).toEqual(["xutiStyleNo", "color", "sizeRange", "material", "supplierStyleNo", "supplierCode"]);
  await expect.poll(() => selectedColumns(page)).toEqual(["supplierStyleNo", "supplierCode"]);
  await drag(page, header(page, "supplierStyleNo"), header(page, "xutiStyleNo"), { shift: true });
  const finalOrder = ["supplierStyleNo", "supplierCode", "xutiStyleNo", "color", "sizeRange", "material"];
  await expect.poll(() => columnOrder(page)).toEqual(finalOrder);
  await expect.poll(() => selectedColumns(page)).toEqual(["supplierStyleNo", "supplierCode"]);
  await expect.poll(state.savedColumnOrder).toEqual(finalOrder);
  await page.reload();
  await expect.poll(() => columnOrder(page)).toEqual(finalOrder);
});

test("Shift clicks extend and shrink a column range while Shift dragging preserves the frozen group", async ({ page }) => {
  await fixture(page);
  await header(page, "supplierStyleNo").click();
  await header(page, "color").click({ modifiers: ["Shift"] });
  await expect.poll(() => selectedColumns(page)).toEqual(["supplierStyleNo", "supplierCode", "color"]);
  await header(page, "supplierCode").click({ modifiers: ["Shift"] });
  await expect.poll(() => selectedColumns(page)).toEqual(["supplierStyleNo", "supplierCode"]);
  expect(await columnOrder(page)).toEqual(keys);
  await drag(page, header(page, "supplierCode"), header(page, "material"), { shift: true });
  await expect.poll(() => columnOrder(page)).toEqual(["xutiStyleNo", "color", "sizeRange", "material", "supplierStyleNo", "supplierCode"]);
  await expect.poll(() => selectedColumns(page)).toEqual(["supplierStyleNo", "supplierCode"]);
});

test("a Shift drag from outside the column selection moves only its own source", async ({ page }) => {
  await fixture(page);
  await drag(page, header(page, "supplierStyleNo"), header(page, "supplierCode"));
  await drag(page, header(page, "sizeRange"), header(page, "xutiStyleNo"), { shift: true });
  await expect.poll(() => columnOrder(page)).toEqual(["sizeRange", "xutiStyleNo", "supplierStyleNo", "supplierCode", "color", "material"]);
});

test("dropping inside a selected column group, pressing Escape or dropping outside headers leaves the order unchanged", async ({ page }) => {
  const state = await fixture(page);
  await drag(page, header(page, "supplierStyleNo"), header(page, "supplierCode"));
  await drag(page, header(page, "supplierCode"), header(page, "supplierStyleNo"));
  expect(await columnOrder(page)).toEqual(keys);
  await drag(page, header(page, "supplierStyleNo"), header(page, "material"), { shift: true, escape: true });
  expect(await columnOrder(page)).toEqual(keys);
  await expect(page.locator("[data-reorder-target]")).toHaveCount(0);
  await drag(page, header(page, "supplierCode"), page.locator("thead .selection-index"));
  expect(await columnOrder(page)).toEqual(keys);
  await expect.poll(() => selectedColumns(page)).toEqual(["supplierStyleNo", "supplierCode"]);
  expect(state.layoutWrites).toHaveLength(0);
});

test("a selected row group moves from either row number and persists without changing cell data", async ({ page }) => {
  const state = await fixture(page);
  await drag(page, rowAxis(page, 1), rowAxis(page, 2));
  await expect.poll(() => selectedRows(page)).toEqual([1, 2]);
  await drag(page, rowAxis(page, 2), rowAxis(page, 5));
  await expect.poll(() => rowOrder(page)).toEqual([0, 3, 4, 5, 1, 2, 6]);
  await expect.poll(() => selectedRows(page)).toEqual([1, 2]);
  await expect.poll(state.savedRowOrder).toEqual([0, 3, 4, 5, 1, 2, 6]);
  await expect(page.getByRole("button", { name: /删除行$/ })).toBeEnabled();
  await drag(page, rowAxis(page, 1), rowAxis(page, 0), { shift: true });
  const finalOrder = [1, 2, 0, 3, 4, 5, 6];
  await expect.poll(() => rowOrder(page)).toEqual(finalOrder);
  await expect.poll(() => selectedRows(page)).toEqual([1, 2]);
  await expect.poll(state.savedRowOrder).toEqual(finalOrder);
  await expect(page.getByRole("button", { name: /删除行$/ })).toBeEnabled();
  expect(state.patches.every(patch => Object.keys(patch.body).every(key => ["sortOrder", "expectedUpdatedAt", "ensureTrailingBlank"].includes(key)))).toBe(true);
  await page.reload();
  await expect.poll(() => rowOrder(page)).toEqual(finalOrder);
  await expect(page.locator('td[data-selection-row="101"][data-selection-column="supplierStyleNo"] textarea')).toHaveValue("SUPPLIER-1");
});

test("checkbox-selected nonadjacent rows move together in their existing manual order", async ({ page }) => {
  await fixture(page);
  await page.getByRole("checkbox", { name: "选择 GROUP-3", exact: true }).check();
  await page.getByRole("checkbox", { name: "选择 GROUP-1", exact: true }).check();
  await drag(page, rowAxis(page, 3), rowAxis(page, 0));
  await expect.poll(() => rowOrder(page)).toEqual([1, 3, 0, 2, 4, 5, 6]);
  await expect.poll(() => selectedRows(page)).toEqual([1, 3]);
});

test("row group drops within the group and canceled row drags make no writes", async ({ page }) => {
  const state = await fixture(page);
  await drag(page, rowAxis(page, 1), rowAxis(page, 2));
  await drag(page, rowAxis(page, 2), rowAxis(page, 1), { shift: true });
  expect(await rowOrder(page)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  await drag(page, rowAxis(page, 1), rowAxis(page, 5), { escape: true });
  expect(await rowOrder(page)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  await expect(page.locator("[data-reorder-target]")).toHaveCount(0);
  await expect.poll(() => selectedRows(page)).toEqual([1, 2]);
  expect(state.patches).toHaveLength(0);
});

test("readonly users cannot move selected rows or public column groups", async ({ page }) => {
  const state = await fixture(page, { readonly: true, shared: true });
  await drag(page, rowAxis(page, 1), rowAxis(page, 2));
  await drag(page, rowAxis(page, 2), rowAxis(page, 5));
  expect(await rowOrder(page)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  await drag(page, rowAxis(page, 1), rowAxis(page, 5), { shift: true });
  expect(await rowOrder(page)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(state.patches).toHaveLength(0);
  await drag(page, header(page, "supplierStyleNo"), header(page, "supplierCode"));
  await drag(page, header(page, "supplierCode"), header(page, "material"));
  await expect(page.getByText("公开列和公共布局需要表格编辑权限；你仍可设置自己的私有字段。", { exact: true })).toBeVisible();
  expect(await columnOrder(page)).toEqual(keys);
  expect(state.layoutWrites).toHaveLength(0);
});

test("a protected cell prevents row group movement while selection remains available", async ({ page }) => {
  const state = await fixture(page, { protected: true });
  await drag(page, rowAxis(page, 1), rowAxis(page, 2));
  await expect.poll(() => selectedRows(page)).toEqual([1, 2]);
  await drag(page, rowAxis(page, 2), rowAxis(page, 5), { shift: true });
  await expect(page.getByText("存在受保护或他人认领的行，不能调整行顺序", { exact: true })).toBeVisible();
  expect(await rowOrder(page)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  await expect.poll(() => selectedRows(page)).toEqual([1, 2]);
  expect(state.patches).toHaveLength(0);
});

test("column groups cannot move across the fixed-column boundary in either direction", async ({ page }) => {
  const state = await fixture(page, { fixedColumns: ["xutiStyleNo", "supplierStyleNo"] });
  const warning = page.getByText("请在同一固定区域或字段分组内调整顺序；跨区域移动请先取消固定或切换全部字段", { exact: true }).last();
  await expect(page.locator("thead th[data-fixed-column]")).toHaveCount(2);
  await drag(page, header(page, "xutiStyleNo"), header(page, "supplierStyleNo"));
  await expect.poll(() => selectedColumns(page)).toEqual(["xutiStyleNo", "supplierStyleNo"]);
  await drag(page, header(page, "supplierStyleNo"), header(page, "material"));
  await expect(warning).toBeVisible();
  expect(await columnOrder(page)).toEqual(keys);
  await expect.poll(() => selectedColumns(page)).toEqual(["xutiStyleNo", "supplierStyleNo"]);
  await drag(page, header(page, "supplierCode"), header(page, "color"));
  await expect.poll(() => selectedColumns(page)).toEqual(["supplierCode", "color"]);
  await drag(page, header(page, "color"), header(page, "xutiStyleNo"), { shift: true });
  await expect(warning).toBeVisible();
  expect(await columnOrder(page)).toEqual(keys);
  await expect.poll(() => selectedColumns(page)).toEqual(["supplierCode", "color"]);
  await expect(page.locator("thead th[data-fixed-column]")).toHaveCount(2);
  expect(state.layoutWrites).toHaveLength(0);
});

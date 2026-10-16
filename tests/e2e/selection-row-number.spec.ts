import { expect, test, type Page } from "@playwright/test";
import { projectSelectionSharedLayout, selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";

const targetId = "1025", targetStyle = "XFW28-31962L";
async function fixture(page: Page, userId: string, filtered: boolean, entry = "/style-selections") {
  let revision = 1, layoutRevision = 1;
  const rows = Array.from({ length: 30 }, (_, index) => ({
    id: String(1001 + index), rowNumber: 45 + index, sortOrder: 45 + index,
    xutiStyleNo: index === 24 ? targetStyle : `NUMBER-${index + 1}`,
    material: index < 6 ? "隐藏" : "保留", images: [], labelImages: [], extraFields: {},
    createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:00:00.001Z",
    defaultCellAccess: "edit", policyRevision: 0,
  }));
  let preferences = selectionLayoutSchema.parse({ columns: [
    { key: "xutiStyleNo", label: "序缇款号", width: 200, type: "text" },
    { key: "material", label: "成分", width: 200, type: "text" },
  ], pageSize: 20, rowHeight: "compact", sort: "sortOrder", direction: filtered ? "desc" : "asc", followShared: false,
  columnFilters: filtered ? { material: { mode: "equals", value: "保留" } } : {},
  });
  const writes: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: userId, displayName: `编号用户${userId}`, csrfToken: "fixture", roleCodes: [], permissions: ["selection.read", "selection.manage", "selection.protect", "product.read", "product.update", "product.create", "project.read", "project.create"] };
    if (path.endsWith("/product-archive-table")) data = { id: "3", initialLayout: "selection", fields: [], references: {}, canEdit: true, canManage: true };
    if (path.endsWith("/project-tables/7")) data = { id: "7", name: "共享编号表", initialLayout: "selection", canEdit: true, canManage: true };
    if (path.endsWith("/revision")) data = { revision: `numbers-${revision}` };
    if (path.endsWith("/sync")) {
      const body = request.postDataJSON(), ordered = [...rows].sort((a, b) => body.direction === "desc" ? b.sortOrder - a.sortOrder : a.sortOrder - b.sortOrder);
      data = { revision: `numbers-${revision}`, index: ordered.map(row => ({ id: row.id, token: `${row.updatedAt}:${row.rowNumber}` })), data: ordered };
    }
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/protection")) data = { settings: defaultProtection, revision: 0, canManage: true };
    if (path.endsWith("/layout-preferences")) {
      if (request.method() === "POST") { preferences = selectionLayoutSchema.parse(request.postDataJSON().preferences); layoutRevision++; }
      data = { preferences, revision: layoutRevision, sharedPreferences: projectSelectionSharedLayout(preferences), sharedRevision: layoutRevision, canEditShared: true };
    }
    if (request.method() === "PATCH") writes.push(path);
    await route.fulfill({ json: { data } });
  });
  await page.goto(entry);
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(20);
  return { rows, writes, renumber() { rows.forEach(row => row.rowNumber++); revision++; } };
}

const row = (page: Page) => page.locator(`tr[data-selection-row="${targetId}"]`);
const cell = (page: Page) => row(page).locator('td[data-selection-column="xutiStyleNo"]');

for (const [label, entry] of [["选款登记", "/style-selections"], ["商品档案", "/products"], ["项目协作表格", "/project-tables/7"]]) {
  test(`${label}不同用户筛选排序分页后的同一款号保持共享行号`, async ({ page, browser }) => {
    await fixture(page, "101", false, entry);
    await page.locator(".ant-pagination-item-2").click();
    await expect(row(page).locator(".selection-row-number")).toHaveText("69");
    await expect(row(page)).toHaveAttribute("aria-rowindex", "6");
    const other = await browser.newContext({ baseURL: "http://127.0.0.1:5174" });
    try {
      const filtered = await other.newPage();
      await fixture(filtered, "201", true, entry);
      await expect(row(filtered).locator(".selection-row-number")).toHaveText("69");
      await expect(row(filtered)).toHaveAttribute("aria-rowindex", "7");
      await filtered.getByRole("textbox", { name: "搜索选款", exact: true }).fill(targetStyle);
      await expect(filtered.locator("tr[data-selection-row]")).toHaveCount(1);
      await expect(row(filtered).locator(".selection-row-number")).toHaveText("69");
      await expect(row(filtered)).toHaveAttribute("aria-rowindex", "2");
      await cell(filtered).click();
      await expect(filtered.locator(".selection-editor-label")).toHaveText("69 · 序缇款号");
      await filtered.getByRole("button", { name: "展开单元格详情", exact: true }).click();
      const detail = filtered.getByRole("dialog", { name: "单元格详情", exact: true });
      await expect(detail.getByText("69 · 序缇款号", { exact: true })).toBeVisible();
      await detail.getByRole("button", { name: "收起单元格详情", exact: true }).click();
      await cell(filtered).focus(); await filtered.keyboard.press("Control+f");
      const find = filtered.getByRole("dialog", { name: "查找/替换", exact: true });
      await find.getByLabel("查找内容", { exact: true }).fill(targetStyle);
      await find.getByRole("button", { name: "查找全部", exact: true }).click();
      await expect(find.getByRole("button", { name: "定位第 69 行 序缇款号", exact: true })).toBeVisible();
      await find.getByRole("button", { name: "关闭", exact: true }).click();
    } finally { await other.close(); }
  });
}

test("保护行候选显示共享编号，服务器只重编号也会同步且不产生编辑历史", async ({ page }) => {
  const state = await fixture(page, "101", true);
  await page.getByRole("textbox", { name: "搜索选款", exact: true }).fill(targetStyle);
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(1);
  await cell(page).click();
  await page.getByRole("button", { name: "保护区域", exact: true }).click();
  await page.getByRole("menuitem", { name: "区域权限", exact: true }).click();
  await page.getByRole("button", { name: "添加保护区域", exact: false }).click();
  const protection = page.getByRole("dialog", { name: "设置保护区域", exact: true });
  await expect(protection.getByText(`69 · ${targetStyle}`, { exact: true })).toBeVisible();
  await protection.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("dialog", { name: "保护区域", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
  state.renumber();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(row(page).locator(".selection-row-number")).toHaveText("70");
  await expect(page.locator(".selection-editor-label")).toHaveText("70 · 序缇款号");
  await expect(row(page)).toHaveAttribute("aria-rowindex", "2");
  expect(state.writes).toEqual([]);
  await expect(page.getByRole("button", { name: "撤销", exact: true })).toBeDisabled();
});

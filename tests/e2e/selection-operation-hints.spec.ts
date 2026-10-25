import { expect, test, type Page } from "@playwright/test";
import { projectSelectionSharedLayout, selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

async function openTable(page: Page, entry: string) {
  const preferences = selectionLayoutSchema.parse({
    columns: [
      { key: "xutiStyleNo", label: "序缇款号", width: 140, type: "text" },
      { key: "supplierStyleNo", label: "供应商款号", width: 140, type: "text" },
    ],
  });
  const rows = Array.from({ length: 20 }, (_, index) => ({
    id: String(index + 1), xutiStyleNo: `HINT-${index + 1}`, supplierStyleNo: `SUPPLIER-${index + 1}`,
    sortOrder: index, images: [], labelImages: [], extraFields: {}, updatedAt: "2026-10-11T00:00:00Z",
  }));
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "提示测试", csrfToken: "fixture", roleCodes: ["SUPER_ADMIN"], permissions: ["selection.read", "selection.manage", "product.read", "product.manage", "project.read", "project.create"] };
    if (path.endsWith("/product-archive-table")) data = { id: "3", initialLayout: "selection", fields: [], references: {}, canEdit: true, canManage: true };
    if (path.endsWith("/project-tables/7")) data = { id: "7", name: "提示协作表", initialLayout: "selection", canEdit: true, canManage: true };
    if (path.endsWith("/revision")) data = { revision: "rows" };
    if (path.endsWith("/sync")) data = { revision: "rows", index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) data = { preferences, revision: 1, sharedPreferences: projectSelectionSharedLayout(preferences), sharedRevision: 1, canEditShared: true };
    await route.fulfill({ json: { data } });
  });
  await page.goto(entry);
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(20);
}

async function expectFooterAndScrollableContent(page: Page) {
  await expect(page.locator(".selection-bottom-bar, .content > .page-footer")).toHaveCount(0);
  const footer = page.locator(".selection-bulk-add"), sheet = page.locator(".selection-sheet");
  const before = await footer.boundingBox();
  expect(before).not.toBeNull();
  expect(Math.abs(before!.y + before!.height - page.viewportSize()!.height)).toBeLessThanOrEqual(3);
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox!.height).toBeGreaterThan(100);
  expect(sheetBox!.y + sheetBox!.height).toBeLessThanOrEqual(before!.y + 1);
  await sheet.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator("tr[data-selection-row]").last()).toBeInViewport();
  expect(await footer.boundingBox()).toEqual(before);
}

async function expectHints(page: Page) {
  const panel = page.locator(".ant-popover:visible");
  await expect(panel.getByText("表格操作提示", { exact: true })).toBeVisible();
  await expect(panel).toContainText("空白行自动保存");
  await expect(panel).toContainText("Ctrl/Cmd+C");
  await expect(panel).toContainText("Ctrl/Cmd+V");
  await expect(panel).toContainText("整组调序");
  await expect(panel).toContainText("图片支持网址、本地上传和粘贴");
}

for (const [label, entry] of [["选款登记", "/style-selections"], ["商品档案", "/products"], ["项目协作表格", "/project-tables/7"]]) {
  test(`${label}：底部提示可悬停和点击打开，分页固定在可滚动内容下方`, async ({ page }) => {
    await openTable(page, entry);
    await expectFooterAndScrollableContent(page);
    const trigger = page.getByRole("button", { name: "表格操作提示", exact: true });
    await expect(trigger).toBeVisible();
    await trigger.hover();
    await expectHints(page);
    await page.mouse.move(1, 1);
    await expect(page.locator(".ant-popover:visible")).toHaveCount(0);
    await trigger.click();
    await expectHints(page);
  });
}

test("窄屏：点击提示图标即可查看说明，底栏持续可见", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 850 });
  await openTable(page, "/products");
  await expectFooterAndScrollableContent(page);
  await page.getByRole("button", { name: "表格操作提示", exact: true }).click();
  await expectHints(page);
  await expect.poll(async () => {
    const panel = await page.locator(".ant-popover:visible").boundingBox();
    return panel !== null && panel.x >= 0 && panel.x + panel.width <= 431;
  }).toBe(true);
});

test("颜色映射列表与批量表格：简洁提示保持显式保存流程", async ({ page }) => {
  const writes: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(path);
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "提示测试", csrfToken: "fixture", roleCodes: ["SUPER_ADMIN"], permissions: ["product.read", "product.update"] };
    if (path.endsWith("/color-mappings")) data = [{ id: "1", code: "001", name: "提示仓库", address: "", status: "ACTIVE" }];
    await route.fulfill({ json: { data, total: Array.isArray(data) ? data.length : undefined } });
  });
  await page.goto("/color-mappings");
  await expect(page.getByRole("cell", { name: "提示仓库", exact: true })).toBeVisible();
  await expect(page.locator(".content > .page-footer")).toBeHidden();
  await page.getByRole("button", { name: "表格编辑 / Excel 导入", exact: true }).click();
  const sheet = page.locator(".sheet-workspace");
  await expect(sheet).toBeVisible();
  await expect(page.locator(".sheet-help")).toHaveCount(0);
  const save = page.getByRole("button", { name: "保存表格", exact: true });
  await expect(save).toBeDisabled();
  const trigger = sheet.getByRole("button", { name: "表格操作提示", exact: true });
  await trigger.hover();
  const panel = page.locator(".ant-popover:visible");
  await expect(panel).toContainText("修改后统一保存");
  await expect(panel).not.toContainText("自动保存");
  await page.mouse.move(1, 1);
  await expect(panel).toHaveCount(0);
  await trigger.click();
  await expect(panel).toContainText("修改后统一保存");
  await page.getByRole("textbox", { name: "第1行 参考颜色名称", exact: true }).fill("修改待保存");
  await expect(save).toBeVisible();
  await expect(save).toBeEnabled();
  expect(writes).toEqual([]);
});

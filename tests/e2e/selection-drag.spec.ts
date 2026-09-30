import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ id: `drag-${index}`, xutiStyleNo: `DRAG-${index}`, supplierStyleNo: `Supplier ${index}`, color: "白色/黑色", sizeRange: "S/M/L", registrationBatch: "2026-10-01", sortOrder: index, images: [], labelImages: [], updatedAt: "2026-10-01T00:00:00Z" }));
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "drag-tester", displayName: "拖选测试", permissions: ["selection.read", "selection.manage"], roleCodes: [], csrfToken: "fixture" };
    if (path.endsWith("/revision")) data = { revision: "drag-fixture" };
    if (path.endsWith("/sync")) {
      const q = route.request().postDataJSON().q;
      const matches = q ? rows.filter(row => `${row.xutiStyleNo} ${row.supplierStyleNo} ${row.color}`.includes(q)) : rows;
      data = { revision: "drag-fixture", index: matches.map(row => ({ id: row.id, token: "1" })), data: matches };
    }
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(page.locator('td[data-selection-column="xutiStyleNo"]')).toHaveCount(20);
});

test("stationary edge drag extends the range without selecting page text and stops on release", async ({ page }) => {
  const sheet = page.locator(".selection-sheet");
  const start = await page.locator('td[data-selection-row="drag-0"][data-selection-column="xutiStyleNo"]').boundingBox();
  const bounds = await sheet.boundingBox();
  await page.mouse.move(start!.x + 30, start!.y + 60);
  await page.mouse.down();
  await page.mouse.move(start!.x + 30, bounds!.y + bounds!.height - 8, { steps: 12 });
  await expect.poll(() => sheet.evaluate(element => element.scrollTop)).toBeGreaterThan(300);
  await expect.poll(() => page.locator('td[data-selection-column="xutiStyleNo"].selection-cell-active').count()).toBeGreaterThan(5);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  expect(await page.locator("thead .selection-cell-active").count()).toBe(0);
  await page.mouse.up();
  const stoppedAt = await sheet.evaluate(element => element.scrollTop);
  await page.waitForTimeout(150);
  expect(await sheet.evaluate(element => element.scrollTop)).toBe(stoppedAt);
  await expect(sheet).not.toHaveClass(/selection-dragging/);
});

test("column drag scrolls horizontally and leaves the header without a blue outline", async ({ page }) => {
  const sheet = page.locator(".selection-sheet");
  const header = page.getByRole("columnheader", { name: "选择整列：序缇款号", exact: true });
  const start = await header.boundingBox(), bounds = await sheet.boundingBox();
  await page.mouse.move(start!.x + 20, start!.y + 20);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width - 8, start!.y + 20, { steps: 10 });
  await expect.poll(() => sheet.evaluate(element => element.scrollLeft)).toBeGreaterThan(100);
  await expect.poll(() => page.locator("td.selection-cell-active").count()).toBeGreaterThan(40);
  expect(await header.evaluate(element => getComputedStyle(element).outlineStyle)).toBe("none");
  expect(await page.locator("thead .selection-cell-active").count()).toBe(0);
  expect(await sheet.evaluate(element => element.scrollTop)).toBe(0);
  await page.keyboard.press("Escape");
  await expect(sheet).not.toHaveClass(/selection-dragging/);
  await page.mouse.up();
});

test("row drag extends whole rows and double clicking retains normal text selection", async ({ page }) => {
  const sheet = page.locator(".selection-sheet");
  const row = page.getByLabel("选择第1行", { exact: true });
  const start = await row.boundingBox(), bounds = await sheet.boundingBox();
  await page.mouse.move(start!.x + 20, start!.y + 30);
  await page.mouse.down();
  await page.mouse.move(start!.x + 20, bounds!.y + bounds!.height - 8, { steps: 10 });
  await expect.poll(() => sheet.evaluate(element => element.scrollTop)).toBeGreaterThan(200);
  await expect.poll(() => page.locator(".selection-axis-active").count()).toBeGreaterThan(4);
  expect(await sheet.evaluate(element => element.scrollLeft)).toBe(0);
  await page.mouse.up();
  await sheet.evaluate(element => { element.scrollTop = 0; });
  const input = page.locator('td[data-selection-row="drag-0"] textarea[aria-label="供应商款号"]');
  await input.dblclick();
  await input.evaluate(element => { const editor = element as HTMLTextAreaElement; editor.focus(); editor.setSelectionRange(0, 8); });
  expect(await input.evaluate(element => { const editor = element as HTMLTextAreaElement; return editor.value.slice(editor.selectionStart, editor.selectionEnd); })).toBe("Supplier");
  expect(await input.evaluate(element => getComputedStyle(element).userSelect)).toBe("text");
});

test("existing fields initialize without losing data and allow a saved tag type", async ({ page }) => {
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  const manager = page.locator(".selection-field-manager");
  await expect(manager.getByText("内置", { exact: true })).toHaveCount(0);
  await expect(manager.getByText("未设置", { exact: true })).toHaveCount(16);
  await page.getByRole("button", { name: "编辑字段颜色", exact: true }).click();
  await page.getByLabel("字段类型", { exact: true }).click();
  await page.getByText("自定义标签", { exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator('td[data-selection-column="color"] .selection-custom-tags')).toHaveCount(20);
  await page.reload();
  await expect(page.locator('td[data-selection-column="color"] .selection-custom-tags')).toHaveCount(20);
  await expect(page.locator('td[data-selection-row="drag-0"][data-selection-column="color"]')).toContainText("白色");
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "初始化字段类型", exact: true }).click();
  await expect(manager.getByText("未设置", { exact: true })).toHaveCount(16);
  await expect(page.locator('td[data-selection-row="drag-0"][data-selection-column="color"]')).toContainText("黑色");
});

test("multiple full style numbers search exactly and color grouping is absent", async ({ page }) => {
  const search = page.getByLabel("序缇款号精确搜索", { exact: true });
  await search.fill("DRAG-1，DRAG-3,\nDRAG-10,DRAG-1");
  await expect(page.locator('td[data-selection-column="xutiStyleNo"]')).toHaveCount(3);
  await expect(page.locator('tr[data-selection-row="drag-11"]')).toHaveCount(0);
  await search.fill("DRAG-");
  await expect(page.locator('td[data-selection-column="xutiStyleNo"]')).toHaveCount(0);
  await search.fill("");
  await expect(page.locator('td[data-selection-column="xutiStyleNo"]')).toHaveCount(20);
  await page.locator(".selection-tool-select").first().click();
  await expect(page.getByText("按颜色分组", { exact: true })).toHaveCount(0);
  await expect(page.getByText("按登记批次分组", { exact: true })).toBeVisible();
  await expect(page.getByText("按供应商编码分组", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".selection-tool-select").nth(1).click();
  const options = page.locator(".ant-select-dropdown:visible .ant-select-item-option-content");
  await expect(options).toHaveText(["手动排序", "最近修改", "最新登记", "登记批次", "配置排序字段"]);
});

test("top right search unifies exact styles and keywords without the toolbar filter button", async ({ page }) => {
  await expect(page.getByRole("button", { name: "筛选", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "筛选颜色", exact: true })).toBeVisible();
  await page.getByLabel("序缇款号精确搜索", { exact: true }).fill("Supplier 12");
  await expect(page.locator('td[data-selection-column="xutiStyleNo"]')).toHaveCount(0);
  await page.getByLabel("搜索方式", { exact: true }).click();
  await page.getByText("关键词", { exact: true }).click();
  const search = page.getByLabel("关键词搜索", { exact: true });
  await expect(search).toHaveValue("Supplier 12");
  await expect(page.locator('td[data-selection-column="xutiStyleNo"]')).toHaveCount(1);
  await expect(page.locator('tr[data-selection-row="drag-12"]')).toBeVisible();
  await search.fill("");
  await expect(page.locator('td[data-selection-column="xutiStyleNo"]')).toHaveCount(20);
  await page.getByLabel("搜索方式", { exact: true }).click();
  await page.getByText("款号精确", { exact: true }).click();
  const manyStyles = Array.from({ length: 20 }, (_, index) => `DRAG-${index}`).join(",");
  await page.getByLabel("序缇款号精确搜索", { exact: true }).fill(manyStyles);
  await page.getByLabel("搜索方式", { exact: true }).click();
  await page.getByText("关键词", { exact: true }).click();
  await expect(page.getByLabel("关键词搜索", { exact: true })).toHaveValue("");
  await page.getByLabel("搜索方式", { exact: true }).click();
  await page.getByText("款号精确", { exact: true }).click();
  await expect(page.getByLabel("序缇款号精确搜索", { exact: true })).toHaveValue(manyStyles);
});

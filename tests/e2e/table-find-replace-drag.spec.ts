import { expect, test, type Locator, type Page } from "@playwright/test";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

async function fixture(page: Page) {
  const rows = Array.from({ length: 60 }, (_, index) => ({
    id: String(index + 1), xutiStyleNo: `DRAG-${index + 1}`, material: "棉质",
    sortOrder: index + 1, images: [], labelImages: [], extraFields: {},
    updatedAt: "2026-10-11T00:00:00Z", defaultCellAccess: "edit", cellAccess: {},
  }));
  let preferences = selectionLayoutSchema.parse({ columns: [
    { key: "xutiStyleNo", label: "序缇款号", type: "text", width: 140 },
    { key: "material", label: "成分", type: "text", width: 160 },
  ], rowHeight: "compact", pageSize: 200 });
  let revision = 1, layoutRevision = 1;
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "拖动测试", csrfToken: "fixture", roleCodes: [], permissions: ["selection.read", "selection.manage"] };
    if (path.endsWith("/revision")) data = { revision: String(revision) };
    if (path.endsWith("/sync")) data = { revision: String(revision), index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows };
    if (path.endsWith("/style-counts")) data = rows.map(row => ({ xutiStyleNo: row.xutiStyleNo, count: 1 }));
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) {
      if (request.method() === "POST") { preferences = selectionLayoutSchema.parse(request.postDataJSON().preferences); layoutRevision++; }
      data = { preferences, revision: layoutRevision, sharedPreferences: null, sharedRevision: 0, canEditShared: true };
    }
    const target = rows.find(row => path.endsWith(`/style-selections/${row.id}`));
    if (target && request.method() === "PATCH") {
      Object.assign(target, request.postDataJSON(), { updatedAt: new Date(1791676800000 + ++revision).toISOString() });
      data = target;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(page.locator('td[data-selection-row="1"][data-selection-column="material"]')).toBeVisible();
  await page.getByRole("button", { name: /查找\/替换$/ }).click();
  const dialog = page.getByRole("dialog", { name: "查找/替换", exact: true });
  await expect(dialog.getByLabel("查找内容", { exact: true })).toBeFocused();
  await expect(dialog).toHaveCSS("width", "480px");
  return { rows, dialog };
}

async function move(page: Page, dialog: Locator, dx: number, dy: number) {
  const title = (await dialog.locator(".table-find-replace-title").boundingBox())!;
  const x = title.x + 50, y = title.y + title.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

test("紧凑查找面板拖动后可输入、查找和关闭；后方表格编辑、滚动及 Ctrl+H 继续可用", async ({ page }) => {
  const { rows, dialog } = await fixture(page), initial = (await dialog.boundingBox())!;
  await move(page, dialog, 320, 100);
  const moved = (await dialog.boundingBox())!;
  expect(moved.x).toBeCloseTo(initial.x + 320, 0);
  expect(moved.y).toBeCloseTo(initial.y + 100, 0);
  await dialog.getByLabel("查找内容", { exact: true }).fill("棉质");
  await dialog.getByRole("button", { name: "查找全部", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("找到 60 个匹配单元格");
  await dialog.getByLabel("替换为", { exact: true }).fill("麻质");
  expect((await dialog.boundingBox())!.x).toBeCloseTo(moved.x, 0);
  expect((await dialog.boundingBox())!.y).toBeCloseTo(moved.y, 0);
  const results = dialog.getByRole("group", { name: "查找结果", exact: true });
  expect(await results.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const editor = page.locator('td[data-selection-row="1"][data-selection-column="material"]').getByLabel("成分", { exact: true });
  await editor.fill("背景编辑");
  await editor.press("Tab");
  await expect.poll(() => rows[0].material).toBe("背景编辑");
  const sheet = page.locator(".selection-sheet");
  await sheet.hover({ position: { x: 100, y: 200 } });
  await page.mouse.wheel(0, 450);
  await expect.poll(() => sheet.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  await sheet.evaluate(element => { element.scrollTop = 0; });
  await editor.focus();
  await page.keyboard.press("Control+h");
  await expect(dialog.getByLabel("查找内容", { exact: true })).toBeFocused();
  await expect(dialog.getByLabel("查找内容", { exact: true })).toHaveValue("棉质");
  await expect(dialog.getByLabel("替换为", { exact: true })).toHaveValue("麻质");
  expect((await dialog.boundingBox())!.x).toBeCloseTo(moved.x, 0);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await editor.focus();
  await page.keyboard.press("Control+h");
  await expect(dialog.getByLabel("查找内容", { exact: true })).toBeFocused();
  expect((await dialog.boundingBox())!.x).toBeCloseTo(moved.x, 0);
  expect((await dialog.boundingBox())!.y).toBeCloseTo(moved.y, 0);
});

test("拖动边界与缩小视口保持标题和关闭按钮可见，放大后保留位置", async ({ page }) => {
  const { dialog } = await fixture(page);
  await move(page, dialog, 3000, 3000);
  const edge = (await dialog.boundingBox())!;
  expect(edge.x + edge.width).toBeLessThanOrEqual(1440);
  expect(edge.y + edge.height).toBeLessThanOrEqual(1000);
  await dialog.getByLabel("查找内容", { exact: true }).fill("棉质");
  await dialog.getByRole("button", { name: "查找全部", exact: true }).click();
  await expect.poll(async () => {
    const bounds = (await dialog.boundingBox())!;
    return bounds.y + bounds.height <= 1000;
  }).toBe(true);
  expect((await dialog.boundingBox())!.y).toBeLessThan(edge.y);
  await page.setViewportSize({ width: 390, height: 500 });
  const title = dialog.locator(".table-find-replace-title"), close = dialog.getByRole("button", { name: "关闭", exact: true });
  await expect.poll(async () => {
    const bounds = (await dialog.boundingBox())!;
    return bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 500;
  }).toBe(true);
  await expect(title).toBeVisible();
  await expect(close).toBeInViewport();
  await dialog.getByLabel("查找内容", { exact: true }).fill("棉质");
  await dialog.getByRole("button", { name: "查找全部", exact: true }).click();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const narrow = (await dialog.boundingBox())!;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(async () => (await dialog.boundingBox())!.x).toBeCloseTo(narrow.x, 0);
  await expect.poll(async () => (await dialog.boundingBox())!.y).toBeCloseTo(narrow.y, 0);
  await close.click();
  await expect(dialog).not.toBeVisible();
});

test("真实触摸 Pointer 拖动与取消后可再次拖动和输入", async ({ page }) => {
  const { dialog } = await fixture(page), before = (await dialog.boundingBox())!;
  const title = (await dialog.locator(".table-find-replace-title").boundingBox())!;
  const touch = await page.context().newCDPSession(page);
  const x = title.x + 50, y = title.y + title.height / 2;
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 120, y: y + 90 }] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await expect.poll(async () => (await dialog.boundingBox())!.x).toBeCloseTo(before.x + 120, 0);
  await expect.poll(async () => (await dialog.boundingBox())!.y).toBeCloseTo(before.y + 90, 0);
  await move(page, dialog, -60, -40);
  expect((await dialog.boundingBox())!.x).toBeCloseTo(before.x + 60, 0);
  expect((await dialog.boundingBox())!.y).toBeCloseTo(before.y + 50, 0);
  await dialog.getByLabel("查找内容", { exact: true }).fill("触摸后输入");
  await expect(dialog.getByLabel("查找内容", { exact: true })).toHaveValue("触摸后输入");
});

import { expect, test, type Locator, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { projectSelectionSharedLayout, selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

async function fixture(page: Page) {
  await page.addInitScript(() => {
    const request = window.fetch.bind(window);
    window.fetch = (input, init) => init?.keepalive && String(input).includes("/api/v1/")
      ? Promise.resolve(new Response('{"data":null}', { headers: { "Content-Type": "application/json" } }))
      : request(input, init);
  });
  const preferences = selectionLayoutSchema.parse({ columns: [
    { key: "xutiStyleNo", label: "序缇款号", type: "text" },
    { key: "material", label: "成分", type: "text" },
    { key: "custom:long", label: "长标题", type: "text", custom: true, visibility: "PUBLIC", textConfig: { countMode: "characters", maxLength: 30 } },
    { key: "custom:short", label: "短标题", type: "text", custom: true, visibility: "PUBLIC" },
  ], columnGroups: [{ id: "materials", name: "资料", columnKeys: ["material"] }] });
  const rows = [{ id: "1", xutiStyleNo: "FLOAT-001", material: "面料：100%桑蚕丝", images: [], labelImages: [], extraFields: {}, updatedAt: "2026-10-11T00:00:00Z" }];
  const writes: unknown[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "拖动测试", csrfToken: "fixture", roleCodes: ["SUPER_ADMIN"], permissions: ["selection.read", "selection.manage", "selection.protect", "product.read", "product.manage", "project.read", "project.create"] };
    if (path.endsWith("/revision")) data = { revision: "1" };
    if (path.endsWith("/sync")) data = { revision: "1", index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) data = { preferences, revision: 1, sharedPreferences: projectSelectionSharedLayout(preferences), sharedRevision: 1, canEditShared: true };
    if (path.endsWith("/ai-titles/status")) data = { ready: true, message: "AI 标题服务已就绪" };
    if (path.endsWith("/ai-titles/generate")) data = { planToken: "fixture-title-token-abcdefghijklmnop", expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), model: "fixture-model", warnings: [], rows: [{ id: "1", xutiStyleNo: "FLOAT-001", expectedUpdatedAt: rows[0].updatedAt, evidence: ["面料100%桑蚕丝", "图片识别圆领盘扣背心"], warnings: [], titles: [{ key: "custom:long", label: "长标题", kind: "long", value: "【100桑蚕丝】锦纨春秋冬新中式国风提花盘扣圆领背心女马甲", minCharacters: 29, maxLength: 30, countMode: "characters" }, { key: "custom:short", label: "短标题", kind: "short", value: "锦纨春盘扣女马甲", minCharacters: 1, maxLength: 30, countMode: "characters" }] }] };
    if (path.endsWith("/import/preview")) data = { rows: [], fields: [], fieldRevision: "11111111111111111111111111111111", layoutRevision: 1, created: 1, updated: 0, skipped: 0 };
    if (/\/style-selections\/1$/.test(path) && request.method() === "PATCH") writes.push(request.postDataJSON());
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(1);
  return { writes };
}
async function drag(page: Page, handle: Locator, dx: number, dy: number) {
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + Math.min(30, box.width / 2), box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(30, box.width / 2) + dx, box.y + box.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
}
async function stableBox(dialog: Locator) {
  await expect(dialog).toBeVisible();
  // Wait for opening motion and ResizeObserver clamping without a fixed sleep.
  await dialog.evaluate(element => new Promise<void>(resolve => {
    let previous = "", stable = 0;
    const frame = () => {
      const box = element.getBoundingClientRect(), current = [box.x, box.y, box.width, box.height].join(":");
      stable = current === previous && !element.getAnimations().some(animation => animation.playState === "running") ? stable + 1 : 0;
      previous = current;
      if (stable >= 3) resolve(); else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
  return (await dialog.boundingBox())!;
}
async function expectBounded(page: Page, dialog: Locator) {
  await expect.poll(async () => {
    const rect = (await dialog.boundingBox())!, viewport = page.viewportSize()!;
    return rect.x >= 7 && rect.y >= 7 && rect.x + rect.width <= viewport.width - 7 && (rect.height > viewport.height - 16 || rect.y + rect.height <= viewport.height - 7);
  }).toBe(true);
}

test("字段分组标题自由拖动，输入和关闭正常，重新打开恢复默认位置", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "字段分组", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "配置字段分组", exact: true }), initial = await stableBox(dialog);
  await drag(page, dialog.locator(".ant-modal-header"), 170, 95);
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.x - initial.x)).toBe(170);
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.y - initial.y)).toBe(95);
  const beforeInput = (await dialog.boundingBox())!;
  await dialog.getByRole("textbox").first().fill("修改草稿名称");
  expect(Math.round((await dialog.boundingBox())!.x)).toBe(Math.round(beforeInput.x));
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "字段分组", exact: true }).click();
  const reopened = await stableBox(dialog);
  expect(Math.round(reopened.x)).toBe(Math.round(initial.x));
  expect(Math.round(reopened.y)).toBe(Math.round(initial.y));
  await expect(dialog.getByRole("textbox").first()).toHaveValue("资料");
  expect(state.writes).toHaveLength(0);
});

test("Excel 弹窗拖至窗口边界仍可选择覆盖和上传，Escape 关闭", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: /^导入$/ }).click();
  await page.getByRole("menuitem", { name: "从 Excel 导入商品", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "从 Excel 导入商品", exact: true });
  await stableBox(dialog);
  await drag(page, dialog.locator(".ant-modal-header"), -2000, -1000);
  await expectBounded(page, dialog);
  const topLeft = (await dialog.boundingBox())!;
  expect(Math.round(topLeft.x)).toBe(8); expect(Math.round(topLeft.y)).toBe(8);
  await dialog.getByRole("radio", { name: "覆盖，仅更新本次填写的字段", exact: true }).check();
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("选款资料");
  sheet.addRow(["序缇款号", "成分"]); sheet.addRow(["NEW-001", "面料：100%棉"]);
  await dialog.locator('input[type="file"]').setInputFiles({ name: "拖动后上传.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await book.xlsx.writeBuffer()) });
  await expect(dialog).toContainText("已读取：拖动后上传.xlsx · 1 款");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("AI 弹窗拖动后候选展开和浏览器缩小时保持可见，候选输入不触发移动", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: /AI 商品标题$/ }).click();
  const dialog = page.getByRole("dialog", { name: "AI 商品标题生成", exact: true });
  await stableBox(dialog);
  await drag(page, dialog.locator(".ant-modal-header"), 350, 500);
  await expectBounded(page, dialog);
  await dialog.getByRole("button", { name: "生成候选标题", exact: true }).click();
  await expect(dialog.getByLabel("FLOAT-001 长标题候选")).toBeVisible();
  await expectBounded(page, dialog);
  await dialog.getByText("查看生成依据", { exact: true }).click();
  await expect(dialog).toContainText("图片识别圆领盘扣背心");
  await page.setViewportSize({ width: 1000, height: 750 });
  await expectBounded(page, dialog);
  const before = await stableBox(dialog);
  await dialog.getByLabel("FLOAT-001 短标题候选").fill("庭春漾盘扣女马甲");
  const after = (await dialog.boundingBox())!;
  expect(Math.round(after.x)).toBe(Math.round(before.x));
  expect(Math.round(after.y)).toBe(Math.round(before.y));
  expect(state.writes).toHaveLength(0);
});

test("现有查找窗口不重复拖动，整表确认弹窗可移动且取消不写入", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: /查找\/替换$/ }).click();
  const find = page.getByRole("dialog", { name: "查找/替换", exact: true }), before = await stableBox(find);
  await expect(find).not.toHaveClass(/floating-panel-movable/);
  await drag(page, find.locator(".table-find-replace-title"), 110, 75);
  const moved = (await find.boundingBox())!;
  expect(Math.round(moved.x - before.x)).toBe(110); expect(Math.round(moved.y - before.y)).toBe(75);
  await find.getByLabel("查找内容", { exact: true }).fill("桑蚕丝");
  await find.getByLabel("替换为", { exact: true }).fill("棉");
  await find.getByRole("button", { name: "全部替换", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "确认替换整表范围的内容？", exact: true }), original = await stableBox(confirmation);
  await expect(confirmation).toHaveClass(/floating-panel-movable/);
  await drag(page, confirmation.locator(".ant-modal-confirm-title"), -140, 90);
  await expect.poll(async () => Math.round((await confirmation.boundingBox())!.x - original.x)).toBe(-140);
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(find).toBeVisible();
  expect(state.writes).toHaveLength(0);
});

test("吸附字段管理 Popover 和侧边 Drawer 不登记拖动，标题内控件可编辑", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  const popover = page.locator(".ant-popover").filter({ has: page.locator(".selection-field-manager") });
  await expect(popover).toBeVisible();
  const before = await stableBox(popover);
  await drag(page, popover.locator(".selection-field-manager").first(), 80, 45);
  const after = (await popover.boundingBox())!;
  expect(Math.round(after.x)).toBe(Math.round(before.x)); expect(Math.round(after.y)).toBe(Math.round(before.y));
  await expect(popover.locator("[data-floating-panel-handle]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    const reactPath = "/node_modules/.vite/deps/react.js", domPath = "/node_modules/.vite/deps/react-dom_client.js", antdPath = "/node_modules/.vite/deps/antd.js";
    const { default: React } = await import(reactPath), { default: { createRoot } } = await import(domPath), { Drawer, Modal, Input, Button } = await import(antdPath);
    const host = document.createElement("div"); document.body.append(host);
    createRoot(host).render(React.createElement(React.Fragment, null,
      React.createElement(Drawer, { open: true, title: "固定侧边栏", mask: false, width: 300 }, "侧栏内容"),
      React.createElement(Modal, { open: true, mask: false, styles: { wrapper: { pointerEvents: "none" }, container: { pointerEvents: "auto" } }, title: React.createElement("div", null, "含控件标题", React.createElement(Input, { "aria-label": "标题内输入", style: { width: 160 } }), React.createElement(Button, { "aria-label": "标题内按钮" }, "按钮")), width: 480, footer: null }, "弹窗内容")));
  });
  const drawer = page.locator(".ant-drawer-content-wrapper"), drawerInitial = await stableBox(drawer);
  await drag(page, drawer.locator(".ant-drawer-header"), -100, 90);
  const drawerAfter = (await drawer.boundingBox())!;
  expect(Math.round(drawerAfter.x)).toBe(Math.round(drawerInitial.x)); expect(Math.round(drawerAfter.y)).toBe(Math.round(drawerInitial.y));
  await expect(drawer.locator("[data-floating-panel-handle]")).toHaveCount(0);
  const modal = page.locator(".ant-modal").filter({ has: page.getByLabel("标题内输入", { exact: true }) });
  const modalInitial = await stableBox(modal);
  await modal.getByLabel("标题内输入", { exact: true }).fill("仍可输入");
  await drag(page, modal.getByLabel("标题内按钮", { exact: true }), 70, 40);
  await expect(modal.getByLabel("标题内输入", { exact: true })).toHaveValue("仍可输入");
  const modalAfter = (await modal.boundingBox())!;
  expect(Math.round(modalAfter.x)).toBe(Math.round(modalInitial.x)); expect(Math.round(modalAfter.y)).toBe(Math.round(modalInitial.y));
});

test("隐藏标题的竞品图片卡片可用叠加握柄拖动，图片两侧无新增边框", async ({ page }) => {
  await fixture(page);
  await page.evaluate(async () => {
    const reactPath = "/node_modules/.vite/deps/react.js", domPath = "/node_modules/.vite/deps/react-dom_client.js", previewPath = "/src/competitor-product-preview.tsx";
    const { default: React } = await import(reactPath), { default: { createRoot } } = await import(domPath), { CompetitorProductPreviewDialog } = await import(previewPath);
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    root.render(React.createElement(CompetitorProductPreviewDialog, { product: { title: "商品图", styleCode: "PREVIEW-1", imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='320'%3E%3Crect width='400' height='320' fill='%23ead9cd'/%3E%3C/svg%3E", salePrice: 200, materialInfo: "100%桑蚕丝", productUrl: "https://example.test/product" }, onClose: () => root.unmount() }));
  });
  const dialog = page.getByRole("dialog", { name: "商品预览", exact: true }), initial = await stableBox(dialog);
  const grip = dialog.getByRole("button", { name: "移动窗口", exact: true });
  await expect(grip).toBeVisible();
  await drag(page, grip, -120, 85);
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.x - initial.x)).toBe(-120);
  const image = dialog.locator(".competitor-product-preview-image"), bounds = (await dialog.boundingBox())!, picture = (await image.boundingBox())!;
  expect(Math.round(picture.x)).toBe(Math.round(bounds.x));
  expect(Math.round(picture.width)).toBe(Math.round(bounds.width));
  await grip.focus(); await page.keyboard.press("ArrowRight");
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.x - bounds.x)).toBe(16);
  await dialog.locator(".ant-modal-close").click();
  await expect(dialog).not.toBeVisible();
});

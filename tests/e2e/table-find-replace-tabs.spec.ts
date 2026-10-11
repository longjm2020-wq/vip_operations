import { expect, test, type Locator, type Page } from "@playwright/test";
import { selectionLayoutSchema, type SelectionField } from "../../packages/contracts/src/selection-layout.js";

type Row = Record<string, any>;
const columns: SelectionField[] = [
  { key: "xutiStyleNo", label: "序缇款号", type: "text", width: 140 },
  { key: "material", label: "成分", type: "text", width: 160 },
  { key: "custom:note", label: "备注", type: "text", custom: true, width: 160 },
];
const makeRow = (id: number): Row => ({
  id: String(id), xutiStyleNo: `TABS-${id}`, material: "前缀棉质后缀", extraFields: { "custom:note": "棉质备注" },
  sortOrder: id, images: [], labelImages: [], updatedAt: "2026-10-11T00:00:00Z", defaultCellAccess: "edit", cellAccess: {},
});
const cell = (page: Page, id: string, key: string) => page.locator(`td[data-selection-row="${id}"][data-selection-column="${key}"]`);
const findDialog = (page: Page) => page.getByRole("dialog", { name: "查找/替换", exact: true });
const confirmation = (page: Page) => page.getByRole("dialog", { name: "确认替换整表范围的内容？", exact: true });

async function fixture(page: Page, entry = "/style-selections", count = 3) {
  const rows = Array.from({ length: count }, (_, index) => makeRow(index + 1));
  let preferences = selectionLayoutSchema.parse({ columns, pageSize: 20, rowHeight: "compact" });
  const patches: { id: string; body: Row }[] = [];
  let revision = 1;
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "分页查找测试", csrfToken: "fixture", roleCodes: [], permissions: ["selection.read", "selection.manage", "product.read", "product.update", "product.create", "project.read", "project.create"] };
    if (path.endsWith("/product-archive-table")) data = { id: "3", initialLayout: "selection", fields: [], references: {}, canEdit: true, canManage: true };
    if (path.endsWith("/project-tables/7")) data = { id: "7", name: "查找协作表", initialLayout: "selection", canEdit: true, canManage: true };
    if (path.endsWith("/revision")) data = { revision: String(revision) };
    if (path.endsWith("/sync")) data = { revision: String(revision), index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows };
    if (path.endsWith("/style-counts")) data = rows.map(row => ({ xutiStyleNo: row.xutiStyleNo, count: 1 }));
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) {
      if (request.method() === "POST") preferences = selectionLayoutSchema.parse(request.postDataJSON().preferences);
      data = { preferences, revision: 1, sharedPreferences: null, sharedRevision: 0, canEditShared: true };
    }
    const target = rows.find(row => path.endsWith(`/style-selections/${row.id}`));
    if (target && request.method() === "PATCH") {
      const body = request.postDataJSON(); patches.push({ id: target.id, body });
      Object.assign(target, body, { extraFields: { ...target.extraFields, ...body.extraFields }, updatedAt: new Date(1791676800000 + ++revision).toISOString() });
      data = target;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto(entry);
  await expect(cell(page, "1", "material")).toBeVisible();
  return {
    rows, patches,
    revokeMaterial: () => { for (const row of rows) Object.assign(row, { cellAccess: { material: "read" }, updatedAt: new Date(1791676800000 + ++revision).toISOString() }); },
  };
}

async function chooseScope(page: Page, dialog: Locator, label: string) {
  await dialog.getByRole("combobox", { name: "查找范围", exact: true }).click();
  await page.locator(".ant-select-dropdown:visible").getByText(label, { exact: true }).click();
}

for (const [label, entry] of [["选款登记", "/style-selections"], ["商品档案", "/products"], ["协作表", "/project-tables/7"]]) {
  test(`${label} Ctrl+F 与 Ctrl+H 切换 TAB；原生选中文本优先于整格内容，已打开时保留条件`, async ({ page }) => {
    const state = await fixture(page, entry), editor = cell(page, "1", "material").getByLabel("成分", { exact: true });
    await editor.click();
    await editor.press("Home");
    await editor.press("ArrowRight");
    await editor.press("ArrowRight");
    await editor.press("Shift+ArrowRight");
    await editor.press("Shift+ArrowRight");
    await expect.poll(() => editor.evaluate(element => (element as HTMLTextAreaElement).value.slice((element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd))).toBe("棉质");
    await page.keyboard.press("Control+f");
    const dialog = findDialog(page);
    await expect(dialog.getByRole("tab", { name: /查找/ })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByLabel("查找内容", { exact: true })).toHaveValue("棉质");
    await expect(dialog.getByLabel("查找内容", { exact: true })).toBeFocused();
    await expect(dialog.getByLabel("替换为", { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "替换当前", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /全部替换$/ })).toHaveCount(0);
    await dialog.getByRole("button", { name: "查找全部", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("找到 6 个匹配单元格");
    await page.keyboard.press("Control+h");
    await expect(dialog.getByRole("tab", { name: /替换/ })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByLabel("查找内容", { exact: true })).toHaveValue("棉质");
    await dialog.getByLabel("替换为", { exact: true }).fill("麻质");
    await dialog.getByRole("tab", { name: /查找/ }).click();
    await expect(dialog.getByLabel("替换为", { exact: true })).toHaveCount(0);
    await dialog.getByRole("tab", { name: /替换/ }).click();
    await expect(dialog.getByLabel("替换为", { exact: true })).toHaveValue("麻质");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await cell(page, "2", "xutiStyleNo").click();
    await page.keyboard.press("Control+f");
    await expect(dialog.getByLabel("查找内容", { exact: true })).toHaveValue("TABS-2");
    expect(state.patches).toHaveLength(0);
  });
}

test("选中整列跨逻辑分页替换，只更新该列并默认使用打开时的选区", async ({ page }) => {
  const state = await fixture(page, "/style-selections", 25);
  await page.getByRole("columnheader", { name: "选择整列：成分", exact: true }).click();
  await page.keyboard.press("Control+h");
  const dialog = findDialog(page);
  await expect(dialog.getByText("打开时的选区", { exact: true })).toBeVisible();
  await dialog.getByLabel("查找内容", { exact: true }).fill("棉质");
  await dialog.getByLabel("替换为", { exact: true }).fill("麻质");
  await dialog.getByRole("button", { name: "查找全部", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("找到 25 个匹配单元格，可替换 25 个");
  await dialog.getByRole("button", { name: "定位第 25 行 成分", exact: true }).click();
  await expect(cell(page, "25", "material")).toBeVisible();
  await dialog.getByRole("button", { name: /全部替换$/ }).click();
  await expect.poll(() => state.rows.filter(row => row.material === "前缀麻质后缀").length).toBe(25);
  await expect(confirmation(page)).toHaveCount(0);
  expect(state.patches).toHaveLength(25);
  expect(state.patches.every(patch => Object.hasOwn(patch.body, "material") && !Object.hasOwn(patch.body, "extraFields") && !Object.hasOwn(patch.body, "xutiStyleNo"))).toBe(true);
  expect(state.rows.every(row => row.extraFields["custom:note"] === "棉质备注")).toBe(true);
});

test("鼠标拖选矩形区域只替换区域中两行两列，不替换第三行或款号", async ({ page }) => {
  const state = await fixture(page);
  const start = (await cell(page, "1", "material").boundingBox())!, end = (await cell(page, "2", "custom:note").boundingBox())!;
  await page.mouse.move(start.x + 10, start.y + 10);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width - 10, end.y + end.height - 10, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator("td.selection-cell-active")).toHaveCount(4);
  await page.keyboard.press("Control+h");
  const dialog = findDialog(page);
  await expect(dialog.getByText("打开时的选区", { exact: true })).toBeVisible();
  await dialog.getByLabel("查找内容", { exact: true }).fill("棉质");
  await dialog.getByLabel("替换为", { exact: true }).fill("麻质");
  await dialog.getByRole("button", { name: "查找全部", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("找到 4 个匹配单元格，可替换 4 个");
  await dialog.getByRole("button", { name: /全部替换$/ }).click();
  await expect.poll(() => state.rows[1].extraFields["custom:note"]).toBe("麻质备注");
  expect(state.rows.map(row => row.material)).toEqual(["前缀麻质后缀", "前缀麻质后缀", "前缀棉质后缀"]);
  expect(state.rows.map(row => row.extraFields["custom:note"])).toEqual(["麻质备注", "麻质备注", "棉质备注"]);
  expect(state.rows.map(row => row.xutiStyleNo)).toEqual(["TABS-1", "TABS-2", "TABS-3"]);
  expect(state.patches).toHaveLength(2);
  await expect(confirmation(page)).toHaveCount(0);
});

test("整表全部替换必须确认；取消不写入，重新选择区域后不会执行旧的整表替换", async ({ page }) => {
  const state = await fixture(page);
  await cell(page, "1", "material").click();
  await page.keyboard.press("Control+h");
  const dialog = findDialog(page);
  await dialog.getByLabel("查找内容", { exact: true }).fill("棉质");
  await dialog.getByLabel("替换为", { exact: true }).fill("麻质");
  await dialog.getByRole("button", { name: /全部替换$/ }).click();
  const confirm = confirmation(page);
  await expect(confirm).toBeVisible();
  expect(state.patches).toHaveLength(0);
  await page.keyboard.press("Control+f");
  await expect(dialog.getByRole("tab", { name: /替换/ })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByLabel("查找内容", { exact: true })).toHaveValue("棉质");
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirm).not.toBeVisible();
  expect(state.patches).toHaveLength(0);
  await chooseScope(page, dialog, "打开时的选区");
  await dialog.getByLabel("替换为", { exact: true }).fill("丝质");
  await dialog.getByRole("button", { name: /全部替换$/ }).click();
  await expect.poll(() => state.rows[0].material).toBe("前缀丝质后缀");
  expect(state.rows[1].material).toBe("前缀棉质后缀");
  expect(state.patches).toHaveLength(1);
  await chooseScope(page, dialog, "当前筛选的可见字段");
  await dialog.getByLabel("替换为", { exact: true }).fill("麻质");
  await dialog.getByRole("button", { name: /全部替换$/ }).click();
  await expect(confirm).toBeVisible();
  expect(state.patches).toHaveLength(1);
  await confirm.getByRole("button", { name: "确认全部替换", exact: true }).click();
  await expect.poll(() => state.rows.filter(row => row.extraFields["custom:note"] === "麻质备注").length).toBe(3);
  expect(state.rows.map(row => row.material)).toEqual(["前缀丝质后缀", "前缀麻质后缀", "前缀麻质后缀"]);
  expect(state.patches).toHaveLength(4);
});

test("确认等待期间权限变化会阻止原整表替换，不能写入旧目标", async ({ page }) => {
  await page.clock.install();
  const state = await fixture(page);
  await page.getByRole("button", { name: /查找\/替换$/ }).click();
  const dialog = findDialog(page);
  await dialog.getByLabel("查找内容", { exact: true }).fill("前缀棉质后缀");
  await dialog.getByLabel("替换为", { exact: true }).fill("新材质");
  await dialog.getByRole("button", { name: "查找全部", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("可替换 3 个");
  await dialog.getByRole("button", { name: /全部替换$/ }).click();
  await expect(confirmation(page)).toBeVisible();
  state.revokeMaterial();
  await page.clock.runFor(10050);
  await expect(dialog.getByRole("status")).toContainText("可替换 0 个");
  await confirmation(page).getByRole("button", { name: "确认全部替换", exact: true }).click();
  await expect(page.locator(".ant-message")).toContainText("变化");
  expect(state.patches).toHaveLength(0);
  expect(state.rows.every(row => row.material === "前缀棉质后缀")).toBe(true);
});

test("选择整表后即使范围显示选区，全部替换仍需整表提醒", async ({ page }) => {
  const state = await fixture(page);
  await cell(page, "1", "material").click();
  await page.keyboard.press("Control+a");
  await expect(page.locator("td.selection-cell-active")).toHaveCount(9);
  await page.keyboard.press("Control+h");
  const dialog = findDialog(page);
  await expect(dialog.getByText("打开时的选区", { exact: true })).toBeVisible();
  await dialog.getByLabel("查找内容", { exact: true }).fill("棉质");
  await dialog.getByLabel("替换为", { exact: true }).fill("麻质");
  await dialog.getByRole("button", { name: /全部替换$/ }).click();
  await expect(confirmation(page)).toBeVisible();
  expect(state.patches).toHaveLength(0);
  await confirmation(page).getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirmation(page)).not.toBeVisible();
  expect(state.patches).toHaveLength(0);
});

test("页面搜索与无关字段编辑弹窗中的 Ctrl+F/H 不被表格拦截", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    (window as any).__findShortcutEvents = [];
    window.addEventListener("keydown", event => {
      if (event.ctrlKey && ["f", "h"].includes(event.key.toLowerCase())) (window as any).__findShortcutEvents.push(event.defaultPrevented);
    });
  });
  await page.getByLabel("搜索选款", { exact: true }).focus();
  await page.keyboard.press("Control+f");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+h");
  await expect(findDialog(page)).toHaveCount(0);
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "编辑字段成分", exact: true }).click();
  const unrelated = page.getByRole("dialog", { name: "编辑字段", exact: true });
  await unrelated.getByLabel("字段名称", { exact: true }).focus();
  await page.keyboard.press("Control+f");
  await page.keyboard.press("Control+h");
  await expect(findDialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__findShortcutEvents)).toEqual([false, false, false, false]);
});

test("ERP 列选择与 Shift 点选区域替换保持待保存，Ctrl+F 可预填原生选中的文字", async ({ page }) => {
  const writes: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(path);
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "ERP 查找测试", csrfToken: "fixture", roleCodes: [], permissions: ["warehouse.read", "warehouse.manage"] };
    if (path.endsWith("/warehouses")) data = [1, 2, 3].map(id => ({ id: String(id), code: `WARE-${id}`, name: `棉质${id}仓`, address: `棉质${id}地址`, status: "ACTIVE" }));
    await route.fulfill({ json: { data, total: Array.isArray(data) ? data.length : undefined } });
  });
  await page.goto("/warehouses");
  await page.getByRole("button", { name: "表格编辑 / Excel 导入", exact: true }).click();
  const sheet = page.locator(".sheet-workspace"), dialog = findDialog(page);
  const firstName = sheet.getByRole("textbox", { name: "第1行 仓库名称", exact: true });
  await firstName.focus();
  await firstName.press("Home");
  await firstName.press("Shift+ArrowRight");
  await firstName.press("Shift+ArrowRight");
  await page.keyboard.press("Control+f");
  await expect(dialog.getByRole("tab", { name: /查找/ })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByLabel("查找内容", { exact: true })).toHaveValue("棉质");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await sheet.getByRole("columnheader", { name: "选择整列：仓库名称", exact: true }).click();
  await page.keyboard.press("Control+h");
  await expect(dialog.getByText("打开时的选区", { exact: true })).toBeVisible();
  await dialog.getByLabel("查找内容", { exact: true }).fill("棉质");
  await dialog.getByLabel("替换为", { exact: true }).fill("麻质");
  await dialog.getByRole("button", { name: "查找全部", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("找到 3 个匹配单元格");
  await dialog.getByRole("button", { name: /全部替换$/ }).click();
  await expect(firstName).toHaveValue("麻质1仓");
  await expect(sheet.getByRole("textbox", { name: "第3行 仓库名称", exact: true })).toHaveValue("麻质3仓");
  await expect(sheet.getByRole("textbox", { name: "第1行 地址", exact: true })).toHaveValue("棉质1地址");
  await expect(page.getByRole("button", { name: "保存表格", exact: true })).toBeEnabled();
  await expect(confirmation(page)).toHaveCount(0);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await firstName.click();
  await sheet.getByRole("textbox", { name: "第2行 地址", exact: true }).click({ modifiers: ["Shift"] });
  await page.keyboard.press("Control+h");
  await expect(dialog.getByText("打开时的选区", { exact: true })).toBeVisible();
  await dialog.getByLabel("查找内容", { exact: true }).fill("棉质");
  await dialog.getByLabel("替换为", { exact: true }).fill("丝质");
  await dialog.getByRole("button", { name: "查找全部", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("找到 2 个匹配单元格");
  await dialog.getByRole("button", { name: /全部替换$/ }).click();
  await expect(sheet.getByRole("textbox", { name: "第1行 地址", exact: true })).toHaveValue("丝质1地址");
  await expect(sheet.getByRole("textbox", { name: "第2行 地址", exact: true })).toHaveValue("丝质2地址");
  await expect(sheet.getByRole("textbox", { name: "第3行 地址", exact: true })).toHaveValue("棉质3地址");
  expect(writes).toEqual([]);
});

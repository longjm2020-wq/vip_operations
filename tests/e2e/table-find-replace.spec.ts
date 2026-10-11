import { expect, test, type Page } from "@playwright/test";
import { selectionLayoutSchema, type SelectionField } from "../../packages/contracts/src/selection-layout.js";
import { joinChoiceValues } from "../../packages/contracts/src/selection-field-validation.js";

type Row = Record<string, any>;
const basic: SelectionField[] = [
  { key: "xutiStyleNo", label: "序缇款号", type: "text", width: 140 },
  { key: "material", label: "成分", type: "text", width: 160 },
];
const row = (id: number, extra: Row = {}): Row => ({ id: String(id), xutiStyleNo: `FIND-${id}`, material: "棉质", sortOrder: id, images: [], labelImages: [], extraFields: {}, updatedAt: "2026-10-11T00:00:00Z", defaultCellAccess: "edit", cellAccess: {}, ...extra });
const cell = (page: Page, id: string, key: string) => page.locator(`td[data-selection-row="${id}"][data-selection-column="${key}"]`);

async function fixture(page: Page, entry = "/style-selections", options: { columns?: SelectionField[]; rows?: Row[]; hidden?: string[] } = {}) {
  const rows = options.rows || [row(1), row(2)];
  let preferences = selectionLayoutSchema.parse({ columns: options.columns || basic, hiddenColumns: options.hidden || [], pageSize: 20, rowHeight: "compact" });
  const patches: { id: string; body: Row }[] = [];
  let revision = 1, layoutRevision = 1, reject = false;
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "替换测试", csrfToken: "fixture", roleCodes: [], permissions: ["selection.read", "selection.manage", "product.read", "product.update", "product.create", "project.read", "project.create"] };
    if (path.endsWith("/product-archive-table")) data = { id: "3", initialLayout: "selection", fields: [], references: {}, canEdit: true, canManage: true };
    if (path.endsWith("/project-tables/7")) data = { id: "7", name: "查找协作表", initialLayout: "selection", canEdit: true, canManage: true };
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
      const body = request.postDataJSON(); patches.push({ id: target.id, body });
      if (reject) { await route.fulfill({ status: 403, json: { error: { code: "REGION_FORBIDDEN", message: "该单元格编辑权限已变化" } } }); return; }
      Object.assign(target, body, { extraFields: { ...target.extraFields, ...body.extraFields }, updatedAt: new Date(1791676800000 + ++revision).toISOString() });
      data = target;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto(entry);
  await expect(cell(page, rows[0].id, "xutiStyleNo")).toBeVisible();
  return { rows, patches, denyWrites: () => { reject = true; } };
}

async function open(page: Page, shortcut = false) {
  if (shortcut) {
    await cell(page, "1", "xutiStyleNo").click();
    await page.keyboard.press("Control+h");
  } else await page.getByRole("button", { name: /查找\/替换$/ }).click();
  const dialog = page.getByRole("dialog", { name: "查找/替换", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function confirmWholeTable(page: Page) {
  const confirmation = page.getByRole("dialog", { name: "确认替换整表范围的内容？", exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "确认全部替换", exact: true }).click();
  await expect(confirmation).not.toBeVisible();
}

for (const [label, entry] of [["选款登记", "/style-selections"], ["商品档案", "/products"], ["协作表", "/project-tables/7"]]) {
  test(`${label} Ctrl+H 查找全部跨分页定位，并逐次和批量自动保存`, async ({ page }) => {
    const rows = Array.from({ length: 25 }, (_, index) => row(index + 1, { material: index === 24 ? "终页棉质" : "棉质" }));
    const state = await fixture(page, entry, { rows }), dialog = await open(page, true);
    await dialog.getByLabel("查找内容", { exact: true }).fill("棉质");
    await dialog.getByRole("button", { name: "查找全部", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("找到 25 个匹配单元格，可替换 25 个");
    await dialog.getByRole("button", { name: "定位第 25 行 成分", exact: true }).click();
    await expect(cell(page, "25", "material")).toHaveClass(/selection-cell-active/);
    await expect(cell(page, "1", "material")).toHaveCount(0);
    await dialog.getByLabel("替换为", { exact: true }).fill("麻质");
    await dialog.getByRole("button", { name: /替换当前$/ }).click();
    await expect.poll(() => state.rows[24].material).toBe("终页麻质");
    expect(state.patches).toHaveLength(1);
    await expect(dialog.getByRole("button", { name: /全部替换$/ })).toBeEnabled();
    await dialog.getByRole("button", { name: /全部替换$/ }).click();
    await confirmWholeTable(page);
    await expect.poll(() => state.rows.filter(row => row.material.includes("麻质")).length).toBe(25);
    expect(state.patches).toHaveLength(25);
    expect(state.patches.every(patch => Object.hasOwn(patch.body, "material") && !Object.hasOwn(patch.body, "xutiStyleNo"))).toBe(true);
  });
}

test("只查找可见授权内容，只读匹配跳过；服务端权限变化保留未保存草稿", async ({ page }) => {
  const columns: SelectionField[] = [...basic, { key: "custom:hidden", label: "隐藏内容", type: "text", custom: true, width: 100 }, { key: "custom:secret", label: "无权查看", type: "text", custom: true, width: 100 }];
  const state = await fixture(page, "/style-selections", { columns, hidden: ["custom:hidden"], rows: [
    row(1, { extraFields: { "custom:hidden": "棉质", "custom:secret": "棉质" }, cellAccess: { "custom:secret": "deny" } }),
    row(2, { cellAccess: { material: "read", "custom:secret": "deny" }, extraFields: { "custom:hidden": "棉质", "custom:secret": "棉质" } }),
  ] });
  const dialog = await open(page);
  await dialog.getByLabel("查找内容", { exact: true }).fill("棉质");
  await dialog.getByRole("button", { name: "查找全部", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("找到 2 个匹配单元格，可替换 1 个");
  await expect(dialog.getByRole("group", { name: "查找结果" })).not.toContainText("隐藏内容");
  await expect(dialog.getByRole("group", { name: "查找结果" })).not.toContainText("无权查看");
  await dialog.getByLabel("替换为", { exact: true }).fill("麻质");
  await dialog.getByRole("button", { name: /全部替换$/ }).click();
  await confirmWholeTable(page);
  await expect.poll(() => state.rows[0].material).toBe("麻质");
  expect(state.rows[1].material).toBe("棉质"); expect(state.patches).toHaveLength(1);
  await expect(dialog.getByRole("button", { name: /全部替换$/ })).toBeDisabled();
  await dialog.getByLabel("查找内容", { exact: true }).fill("麻质");
  await dialog.getByLabel("替换为", { exact: true }).fill("丝质");
  state.denyWrites();
  await dialog.getByRole("button", { name: /全部替换$/ }).click();
  await confirmWholeTable(page);
  await expect(page.getByRole("button", { name: "未保存 · 重试", exact: true })).toBeVisible();
  expect(state.rows[0].material).toBe("麻质"); expect(state.patches).toHaveLength(2);
  await expect(cell(page, "1", "material").getByLabel("成分", { exact: true })).toHaveValue("丝质");
});

for (const [label, columns, rows, query, replacement, error] of [
  ["单选候选", [...basic, { key: "custom:choice", label: "类目", type: "single", custom: true, width: 100, options: ["棉衣", "麻衣"] }], [row(1, { material: "棉衣", extraFields: { "custom:choice": "棉衣" } }), row(2, { material: "棉衣" })], "棉衣", "无效类目", "请选择已配置的选项"],
  ["字数上限", [...basic, { key: "custom:short", label: "短标题", type: "text", custom: true, width: 100, textConfig: { countMode: "han", maxLength: 2 } }], [row(1, { material: "棉衣", extraFields: { "custom:short": "棉衣" } }), row(2, { material: "棉衣" })], "棉衣", "很长标题", "最多2个汉字"],
  ["重复款号", basic, [row(1, { xutiStyleNo: "DUP-1" }), row(2, { xutiStyleNo: "DUP-2" })], "DUP-1", "DUP-2", "序缇款号与其他记录重复"],
] as [string, SelectionField[], Row[], string, string, string][]) {
  test(`${label}不合法时全部替换整批不改，不发出自动保存`, async ({ page }) => {
    const state = await fixture(page, "/style-selections", { columns, rows });
    const before = structuredClone(state.rows), dialog = await open(page);
    await dialog.getByLabel("查找内容", { exact: true }).fill(query);
    await dialog.getByLabel("替换为", { exact: true }).fill(replacement);
    await dialog.getByRole("button", { name: /全部替换$/ }).click();
    await confirmWholeTable(page);
    await expect(page.locator(".ant-message")).toContainText(error);
    await expect(page.locator(".ant-message")).toContainText("本次替换未应用");
    expect(state.rows).toEqual(before); expect(state.patches).toHaveLength(0);
    await expect(page.getByRole("button", { name: "未保存 · 重试", exact: true })).toHaveCount(0);
    if (label !== "重复款号") await expect(cell(page, "1", "material").getByLabel("成分", { exact: true })).toHaveValue("棉衣");
    else await expect(cell(page, "1", "xutiStyleNo").getByLabel("序缇款号", { exact: true })).toHaveValue("DUP-1");
  });
}

test("单选、多选含斜杠的完整标签正确替换和保存", async ({ page }) => {
  const options = ["女士皮衣/皮草", "女士睡衣/家居服", "女式外套"];
  const columns: SelectionField[] = [...basic, { key: "custom:single", label: "单选类目", type: "single", custom: true, width: 180, options }, { key: "custom:multiple", label: "多选类目", type: "multiple", custom: true, width: 220, options }];
  const state = await fixture(page, "/style-selections", { columns, rows: [row(1, { extraFields: { "custom:single": options[0], "custom:multiple": joinChoiceValues([options[0], options[2]]) } })] });
  const dialog = await open(page, true);
  await dialog.getByLabel("查找内容", { exact: true }).fill(options[0]);
  await dialog.getByLabel("替换为", { exact: true }).fill(options[1]);
  await dialog.getByRole("button", { name: "查找全部", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("找到 2 个匹配单元格，可替换 2 个");
  await dialog.getByRole("button", { name: /全部替换$/ }).click();
  await confirmWholeTable(page);
  await expect.poll(() => state.rows[0].extraFields["custom:single"]).toBe(options[1]);
  expect(state.rows[0].extraFields["custom:multiple"]).toBe(joinChoiceValues([options[1], options[2]]));
  expect(state.patches).toHaveLength(1);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.reload();
  await expect(cell(page, "1", "custom:single").locator(".selection-choice-pill")).toHaveText(options[1]);
  await expect(cell(page, "1", "custom:multiple").locator(".selection-choice-pill")).toHaveText([options[1], options[2]]);
});

test("ERP表格 Drawer Ctrl+H 支持标题和保存入口，替换待保存、撤销及移出前行", async ({ page }) => {
  const writes: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(path);
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "替换测试", csrfToken: "fixture", roleCodes: [], permissions: ["warehouse.read", "warehouse.manage"] };
    if (path.endsWith("/warehouses")) data = [{ id: "1", code: "WARE-1", name: "棉质一仓", address: "", status: "ACTIVE" }, { id: "2", code: "WARE-2", name: "棉质二仓", address: "", status: "ACTIVE" }];
    await route.fulfill({ json: { data, total: Array.isArray(data) ? data.length : undefined } });
  });
  await page.goto("/warehouses");
  await page.getByRole("button", { name: "表格编辑 / Excel 导入", exact: true }).click();
  const sheet = page.locator(".sheet-workspace"), save = page.getByRole("button", { name: "保存表格", exact: true });
  await expect(save).toBeDisabled();
  const dialog = page.getByRole("dialog", { name: "查找/替换", exact: true });
  await page.keyboard.press("Control+h");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".ant-drawer-title").click();
  await page.keyboard.press("Control+h");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await sheet.getByRole("textbox", { name: "第1行 仓库名称", exact: true }).focus();
  await page.keyboard.press("Control+h");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("查找内容", { exact: true }).fill("棉质");
  await dialog.getByLabel("替换为", { exact: true }).fill("麻质");
  await dialog.getByRole("button", { name: "查找全部", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("找到 2 个匹配单元格，可替换 2 个");
  await dialog.getByRole("button", { name: /全部替换$/ }).click();
  await confirmWholeTable(page);
  await expect(save).toBeEnabled();
  await expect(sheet.getByRole("textbox", { name: "第1行 仓库名称", exact: true })).toHaveValue("麻质一仓");
  await expect(sheet.getByRole("textbox", { name: "第2行 仓库名称", exact: true })).toHaveValue("麻质二仓");
  expect(writes).toEqual([]);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await save.focus();
  await page.keyboard.press("Control+h");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await sheet.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(sheet.getByRole("textbox", { name: "第1行 仓库名称", exact: true })).toHaveValue("棉质一仓");
  await expect(sheet.getByRole("textbox", { name: "第2行 仓库名称", exact: true })).toHaveValue("棉质二仓");
  expect(writes).toEqual([]);

  await sheet.getByRole("textbox", { name: "第2行 仓库名称", exact: true }).focus();
  await page.keyboard.press("Control+h");
  await dialog.getByLabel("查找内容", { exact: true }).fill("棉质");
  await dialog.getByLabel("替换为", { exact: true }).fill("丝质");
  await dialog.getByRole("combobox", { name: "查找范围", exact: true }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("打开时的选区", { exact: true }).click();
  await dialog.getByRole("button", { name: "查找全部", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("找到 1 个匹配单元格");
  await sheet.getByRole("checkbox", { name: "选择第1行", exact: true }).check();
  await sheet.getByRole("button", { name: "移出选中行", exact: true }).click();
  await expect(sheet.getByRole("textbox", { name: "第1行 仓库名称", exact: true })).toHaveValue("棉质二仓");
  await sheet.getByRole("textbox", { name: "第1行 仓库名称", exact: true }).focus();
  await page.keyboard.press("Control+h");
  await expect(dialog.getByText("打开时的选区", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("找到 1 个匹配单元格");
  await dialog.getByRole("button", { name: /全部替换$/ }).click();
  await expect(sheet.getByRole("textbox", { name: "第1行 仓库名称", exact: true })).toHaveValue("丝质二仓");
  expect(writes).toEqual([]);
});

test("打开时的选区冻结，查找定位其他行后仍仅替换原选区", async ({ page }) => {
  const state = await fixture(page);
  await cell(page, "1", "material").click();
  await page.keyboard.press("Control+h");
  const dialog = page.getByRole("dialog", { name: "查找/替换", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("查找内容", { exact: true }).fill("棉质");
  const chooseScope = async (name: string) => {
    await dialog.getByRole("combobox", { name: "查找范围", exact: true }).click();
    await page.locator(".ant-select-dropdown:visible").getByText(name, { exact: true }).click();
    await dialog.getByRole("button", { name: "查找全部", exact: true }).click();
  };
  await chooseScope("打开时的选区");
  await expect(dialog.getByRole("status")).toContainText("找到 1 个匹配单元格");
  await expect(dialog.getByRole("button", { name: "定位第 1 行 成分", exact: true })).toBeVisible();
  await chooseScope("当前筛选的可见字段");
  await expect(dialog.getByRole("status")).toContainText("找到 2 个匹配单元格");
  await dialog.getByRole("button", { name: "定位第 2 行 成分", exact: true }).click();
  await expect(cell(page, "2", "material")).toHaveClass(/selection-cell-active/);
  await cell(page, "2", "xutiStyleNo").click();
  await page.keyboard.press("Control+h");
  await chooseScope("打开时的选区");
  await expect(dialog.getByRole("status")).toContainText("找到 1 个匹配单元格");
  await expect(dialog.getByRole("button", { name: "定位第 2 行 成分", exact: true })).toHaveCount(0);
  await dialog.getByLabel("替换为", { exact: true }).fill("麻质");
  await dialog.getByRole("button", { name: /全部替换$/ }).click();
  await expect.poll(() => state.rows[0].material).toBe("麻质");
  expect(state.rows[1].material).toBe("棉质");
  expect(state.patches).toHaveLength(1);
});

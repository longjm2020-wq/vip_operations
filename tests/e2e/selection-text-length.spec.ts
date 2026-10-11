import { expect, test, type Page } from "@playwright/test";
import { projectSelectionSharedLayout, selectionLayoutSchema, type SelectionField } from "../../packages/contracts/src/selection-layout.js";

const key = "custom:limited-text";
async function fixture(page: Page, path = "/style-selections", options: { value?: string; config?: SelectionField["textConfig"]; fallback?: boolean; readonly?: boolean; builtin?: boolean; unshared?: boolean } = {}) {
  const textKey = options.builtin ? "material" : key;
  let shared = !options.unshared;
  let preferences = selectionLayoutSchema.parse({
    columns: [
      { key: "xutiStyleNo", label: "序缇款号", width: 140, type: "text" },
      { key: textKey, label: "款式说明", width: 180, ...(!options.builtin ? { custom: true, ownerId: "101", visibility: "PUBLIC" } : {}), ...(options.fallback ? { fallbackType: "text" } : { type: "text" }), textConfig: options.config },
    ], rowHeight: "loose",
  }), revision = 1, dataRevision = 0;
  const rows = [1, 2].map(id => ({ id: String(id), xutiStyleNo: `LIMIT-${id}`, material: options.builtin && id === 1 ? options.value || "" : "", sortOrder: id, images: [], labelImages: [], extraFields: { [key]: !options.builtin && id === 1 ? options.value || "" : "" }, updatedAt: "2026-10-11T00:00:00.000Z" }));
  const patches: Record<string, unknown>[] = [];
  const layoutWrites: Record<string, unknown>[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), apiPath = new URL(request.url()).pathname;
    let data: unknown = [];
    if (apiPath.endsWith("/auth/me")) data = { id: "101", displayName: "文本限制测试", roleCodes: ["SUPER_ADMIN"], csrfToken: "fixture", permissions: ["selection.read", "product.read", "project.read", ...(!options.readonly ? ["selection.manage", "product.manage", "project.create"] : [])] };
    if (apiPath.endsWith("/product-archive-table")) data = { id: "3", initialLayout: "selection", fields: [], references: {}, canEdit: !options.readonly, canManage: !options.readonly };
    if (apiPath.endsWith("/project-tables/7")) data = { id: "7", name: "文本限制协作表", initialLayout: "selection", canEdit: !options.readonly, canManage: !options.readonly };
    if (apiPath.endsWith("/revision")) data = { revision: `text-${dataRevision}` };
    if (apiPath.endsWith("/sync")) data = { revision: `text-${dataRevision}`, index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows };
    if (apiPath.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (apiPath.endsWith("/layout-preferences")) {
      if (request.method() === "POST") { const body = request.postDataJSON(); layoutWrites.push(body); preferences = selectionLayoutSchema.parse(body.preferences); revision++; if (body.sharedChanges?.columns) shared = true; }
      data = { preferences, revision, sharedRevision: shared ? revision : 0, sharedPreferences: shared ? projectSelectionSharedLayout(preferences) : null, canEditShared: !options.readonly };
    }
    const row = rows.find(item => apiPath.endsWith(`/style-selections/${item.id}`));
    if (row && request.method() === "PATCH") {
      const body = request.postDataJSON(); patches.push(body);
      Object.assign(row, body, { extraFields: { ...row.extraFields, ...body.extraFields }, updatedAt: new Date(Date.UTC(2026, 9, 11) + ++dataRevision).toISOString() });
      data = row;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto(path);
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(2);
  return { patches, layoutWrites, config: () => preferences.columns.find(field => field.key === textKey)?.textConfig, savedValue: () => options.builtin ? rows[0].material : rows[0].extraFields[key] };
}
const input = (page: Page) => page.locator(`td[data-selection-row="1"][data-selection-column="${key}"]`).getByLabel("款式说明", { exact: true });
const counter = (page: Page) => page.locator(".selection-editor-bar > .selection-text-length");
async function editField(page: Page) {
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "编辑字段款式说明", exact: true }).click();
  return page.getByRole("dialog", { name: "编辑字段", exact: true });
}

for (const [label, path] of [["选款登记", "/style-selections"], ["商品档案", "/products"], ["项目协作表格", "/project-tables/7"]]) {
  test(`${label}设置字符上限共享保存、保留超限草稿，顶部和详情修正后保存`, async ({ page }) => {
    const state = await fixture(page, path), dialog = await editField(page);
    await dialog.getByRole("spinbutton", { name: "文本字数上限", exact: true }).fill("4");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(state.config).toEqual({ countMode: "characters", maxLength: 4 });
    expect(state.layoutWrites.at(-1)?.sharedChanges).toMatchObject({ columns: expect.arrayContaining([expect.objectContaining({ key, textConfig: { countMode: "characters", maxLength: 4 } })]) });
    await page.reload();
    await expect(input(page)).toBeVisible();
    await input(page).dblclick();
    await input(page).fill("汉字🌼AB");
    await expect(input(page)).toHaveValue("汉字🌼AB");
    await expect(input(page)).not.toHaveAttribute("maxlength", /.+/);
    await expect(input(page)).toHaveAttribute("aria-invalid", "true");
    await expect(counter(page)).toHaveText("字符 5 / 4 · 超出上限");
    await expect(page.getByRole("button", { name: "未保存 · 重试", exact: true })).toBeVisible();
    expect(state.patches).toHaveLength(0);
    const editor = page.getByRole("group", { name: "单元格编辑栏", exact: true }).getByLabel("款式说明", { exact: true });
    await editor.fill("汉字🌼A");
    await expect.poll(state.savedValue).toBe("汉字🌼A");
    await expect(counter(page)).toHaveText("字符 4 / 4");
    await page.getByRole("button", { name: "展开单元格详情", exact: true }).click();
    const detail = page.getByRole("dialog", { name: "单元格详情", exact: true });
    await detail.getByLabel("单元格详情内容", { exact: true }).fill("字🌼");
    await expect.poll(state.savedValue).toBe("字🌼");
    await expect(detail.locator(".selection-text-length")).toHaveText("字符 2 / 4");
  });
}

test("汉字计数排除英文表情，降低上限拒绝已填内容，清空上限保留内容并取消额外限制", async ({ page }) => {
  const state = await fixture(page, "/style-selections", { value: "女ABC🌼", config: { countMode: "characters", maxLength: 8 } });
  const dialog = await editField(page);
  await dialog.getByRole("spinbutton", { name: "文本字数上限", exact: true }).fill("3");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText(/现有内容与设置不兼容/)).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(state.config()).toEqual({ countMode: "characters", maxLength: 8 });
  await dialog.getByRole("combobox", { name: "文本计数方式", exact: true }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("汉字数", { exact: true }).click();
  await dialog.getByRole("spinbutton", { name: "文本字数上限", exact: true }).fill("1");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(state.config).toEqual({ countMode: "han", maxLength: 1 });
  await input(page).dblclick();
  await input(page).fill("女ABC🌼 123");
  await expect.poll(state.savedValue).toBe("女ABC🌼 123");
  await expect(counter(page)).toHaveText("汉字 1 / 1");
  const clear = await editField(page);
  await clear.getByRole("spinbutton", { name: "文本字数上限", exact: true }).fill("");
  await clear.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(state.config).toBeUndefined();
  await input(page).dblclick();
  await input(page).fill("女装ABC🌼");
  await expect.poll(state.savedValue).toBe("女装ABC🌼");
  await expect(counter(page)).toHaveCount(0);
});

test("回退文本类型计数空格换行，组合输入及网格粘贴均保留超限草稿且不发出写入", async ({ page }) => {
  const state = await fixture(page, "/style-selections", { config: { countMode: "characters", maxLength: 3 }, fallback: true });
  await input(page).dblclick();
  await input(page).dispatchEvent("compositionstart", { data: "汉" });
  await input(page).fill("汉字🌼A");
  await input(page).dispatchEvent("compositionend", { data: "汉字" });
  await expect(input(page)).toHaveValue("汉字🌼A");
  await expect(counter(page)).toHaveText("字符 4 / 3 · 超出上限");
  await expect(page.getByRole("button", { name: "未保存 · 重试", exact: true })).toBeVisible();
  expect(state.patches).toHaveLength(0);
  await input(page).fill("汉\n ");
  await expect(counter(page)).toHaveText("字符 3 / 3");
  await expect.poll(state.savedValue).toBe("汉\n ");
  await input(page).press("Escape");
  await page.locator(`td[data-selection-row="1"][data-selection-column="${key}"]`).evaluate(element => {
    const transfer = new DataTransfer(); transfer.setData("text/plain", "汉字🌼A\nABCD");
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  await expect(input(page)).toHaveValue("汉字🌼A");
  await expect(page.locator(`td[data-selection-row="2"][data-selection-column="${key}"] textarea`)).toHaveValue("ABCD");
  await expect(page.getByRole("button", { name: "未保存 · 重试", exact: true })).toBeVisible();
  expect(state.patches).toHaveLength(1);
});

test("未建立共享布局时首个业务文本限制发布共享列，刷新后仍可读取", async ({ page }) => {
  const state = await fixture(page, "/style-selections", { value: "棉", builtin: true, unshared: true });
  const dialog = await editField(page);
  await dialog.getByRole("spinbutton", { name: "文本字数上限", exact: true }).fill("6");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(state.config).toEqual({ countMode: "characters", maxLength: 6 });
  await expect.poll(() => state.layoutWrites.length).toBe(1);
  expect(state.layoutWrites[0].sharedRevision).toBe(0);
  expect(state.layoutWrites[0].sharedChanges).toMatchObject({ columns: expect.arrayContaining([expect.objectContaining({ key: "material", textConfig: { countMode: "characters", maxLength: 6 } })]) });
  expect(Object.keys(state.layoutWrites[0].sharedChanges as object)).toEqual(["columns"]);
  await page.reload();
  const builtinInput = page.locator('td[data-selection-row="1"][data-selection-column="material"]').getByLabel("款式说明", { exact: true });
  await builtinInput.dblclick();
  await expect(counter(page)).toHaveText("字符 1 / 6");
  await builtinInput.fill("棉麻羊毛化纤混纺");
  await expect(counter(page)).toHaveText("字符 8 / 6 · 超出上限");
  await expect(page.getByRole("button", { name: "未保存 · 重试", exact: true })).toBeVisible();
  expect(state.patches).toHaveLength(0);
});

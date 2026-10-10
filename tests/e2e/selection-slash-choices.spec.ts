import { expect, test, type Locator, type Page } from "@playwright/test";
import { selectionLayoutSchema, type SelectionField, type SelectionLayoutSnapshot } from "../../packages/contracts/src/selection-layout.js";
import { joinChoiceValues } from "../../packages/contracts/src/selection-field-validation.js";

const categories = [
  "半截裙", "连衣裙", "女士皮衣/皮草", "女士睡衣/家居服", "女式T恤", "女式背心", "女式衬衫",
  "女式打底裤", "女式打底衫", "女式大衣", "女式风衣", "女式礼服", "女式马夹", "女式套装",
  "女式外套", "女式卫衣", "女式休闲裤", "女式羊毛衫", "女式羊绒衫", "女式羽绒服", "女式针织衫",
];
const slashCategories = categories.slice(2, 4);
const cell = (page: Page, key: string, row = "slash-1") => page.locator(`td[data-selection-row="${row}"][data-selection-column="${key}"]`);
const savedCategoryField: SelectionField = {
  key: "custom:categories", label: "三级类目", width: 220, custom: true, type: "multiple",
  ownerId: "10", visibility: "PRIVATE", fieldRevision: 1, options: categories,
  optionColors: { [slashCategories[0]]: "red", [slashCategories[1]]: "blue" },
};

async function fixture(page: Page, initial?: { field: SelectionField; firstValue: string }) {
  let layout: SelectionLayoutSnapshot = {
    preferences: selectionLayoutSchema.parse({
      columns: [{ key: "xutiStyleNo", label: "序缇款号", width: 120 }, ...(initial ? [initial.field] : [])],
      rowHeight: "compact", pageSize: 100,
    }),
    revision: 1, sharedPreferences: null, sharedRevision: 0, canEditShared: true,
  };
  const rows: Record<string, any>[] = [1, 2, 3].map(id => ({
    id: `slash-${id}`, xutiStyleNo: `SLASH-${id}`, sortOrder: id,
    updatedAt: "2026-10-10T00:00:00.000Z", images: [], labelImages: [],
    extraFields: id === 1 && initial ? { [initial.field.key]: initial.firstValue } : {},
    defaultCellAccess: "edit", cellAccess: {},
  }));
  let revision = 0;
  const patches: Record<string, any>[] = [];
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = {
      id: "10", displayName: "斜杠选项测试", roleCodes: [], csrfToken: "fixture",
      permissions: ["selection.read", "selection.manage"],
    };
    if (path.endsWith("/revision")) data = { revision: String(revision) };
    if (path.endsWith("/sync")) data = {
      revision: String(revision), index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows,
    };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) {
      if (route.request().method() === "POST") {
        const preferences = selectionLayoutSchema.parse(route.request().postDataJSON().preferences);
        preferences.columns = preferences.columns.map(field => field.custom ? { ...field, fieldRevision: 1 } : field);
        layout = { ...layout, preferences, revision: layout.revision + 1 };
      }
      data = layout;
    }
    const row = rows.find(row => path.endsWith(`/style-selections/${row.id}`));
    if (row && route.request().method() === "PATCH") {
      const body = route.request().postDataJSON(); patches.push(body);
      Object.assign(row, body, {
        extraFields: { ...row.extraFields, ...body.extraFields },
        updatedAt: new Date(1791590400000 + ++revision).toISOString(),
      });
      data = row;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(cell(page, "xutiStyleNo")).toContainText("SLASH-1");
  return { rows, patches, savedField: () => layout.preferences!.columns.find(field => field.label === "三级类目") };
}

async function openNewField(page: Page, type = "多选") {
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "添加字段", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加字段", exact: true });
  await dialog.getByLabel("字段名称", { exact: true }).fill("三级类目");
  await dialog.getByLabel("字段类型", { exact: true }).fill(type);
  await page.locator(".ant-select-dropdown:visible").getByText(type, { exact: true }).click();
  return dialog;
}

async function setColor(page: Page, dialog: Locator, option: string, color: string) {
  await dialog.getByLabel(`标签颜色：${option}`, { exact: true }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: new RegExp(`^${color}$`) }).click();
  await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
}

test("create slash-bearing category choices, autosave two complete colored labels and preserve them after reload", async ({ page }) => {
  const state = await fixture(page);
  const dialog = await openNewField(page);
  await dialog.getByLabel("字段选项", { exact: true }).fill(categories.join("\n"));
  await expect(dialog.getByText(/^有效选项：21 \/ 100/)).toBeVisible();
  await expect(dialog.locator(".selection-option-color-settings label > .selection-choice-pill")).toHaveCount(21);
  await setColor(page, dialog, slashCategories[0], "陶红");
  await setColor(page, dialog, slashCategories[1], "雾蓝");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => state.savedField()?.options).toEqual(categories);
  const field = state.savedField()!;
  expect(field.ownerId).toBe("10");
  expect(field.visibility).toBe("PRIVATE");
  expect(field.optionColors?.[slashCategories[0]]).toBe("red");
  expect(field.optionColors?.[slashCategories[1]]).toBe("blue");
  const target = cell(page, field.key);
  await target.click();
  await target.getByRole("button", { name: "展开三级类目选项", exact: true }).click();
  for (const option of slashCategories) {
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: option }).click();
  }
  await cell(page, "xutiStyleNo").click();
  await expect.poll(() => state.rows[0].extraFields[field.key]).toContain(slashCategories[0]);
  await expect.poll(() => state.rows[0].extraFields[field.key]).toContain(slashCategories[1]);
  await expect(target.locator(".selection-choice-pill")).toHaveCount(2);
  for (const [index, color] of ["rgb(170, 91, 76)", "rgb(85, 115, 153)"].entries()) {
    await expect(target.locator(".selection-choice-pill").nth(index)).toHaveText(slashCategories[index]);
    await expect(target.locator(".selection-choice-pill").nth(index)).toHaveCSS("background-color", color);
  }
  expect(state.patches.length).toBeGreaterThan(0);
  await page.reload();
  await expect(target.locator(".selection-choice-pill")).toHaveCount(2);
  await expect(target.locator(".selection-choice-pill").nth(0)).toHaveText(slashCategories[0]);
  await expect(target.locator(".selection-choice-pill").nth(0)).toHaveCSS("background-color", "rgb(170, 91, 76)");
  await expect(target.locator(".selection-choice-pill").nth(1)).toHaveText(slashCategories[1]);
  await expect(target.locator(".selection-choice-pill").nth(1)).toHaveCSS("background-color", "rgb(85, 115, 153)");

  await target.click({ position: { x: 2, y: 2 } });
  await page.getByRole("button", { name: "展开单元格详情", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "单元格详情", exact: true });
  const detailContent = detail.getByRole("textbox", { name: "单元格详情内容", exact: true });
  await expect(detailContent).toHaveValue(slashCategories.join("；"));
  expect(await detailContent.inputValue()).not.toContain("@choices");
  await expect(detailContent).toHaveAttribute("readonly", "");
  await detail.getByRole("button", { name: "收起单元格详情", exact: true }).click();
  await expect(detail).toHaveCount(0);

  await page.getByRole("button", { name: "筛选三级类目", exact: true }).click();
  const panel = page.locator(".selection-filter-panel:visible");
  await panel.getByRole("textbox", { name: "搜索筛选选项", exact: true }).fill("女士皮衣");
  await expect(panel.locator(".selection-filter-values").getByRole("checkbox")).toHaveCount(1);
  await expect(panel.locator(".selection-filter-values").getByRole("checkbox")).toHaveAccessibleName(/^女士皮衣\/皮草.*女士睡衣\/家居服\s*\(1\)$/);
  await panel.getByRole("button", { name: "取消", exact: true }).click();

  await target.getByRole("button", { name: `编辑三级类目标签：${slashCategories[0]}`, exact: true }).click();
  await target.getByRole("button", { name: `移除${slashCategories[0]}`, exact: true }).click();
  await cell(page, "xutiStyleNo").click();
  await expect(target.locator(".selection-choice-pill")).toHaveCount(1);
  await expect(target.locator(".selection-choice-pill")).toHaveText(slashCategories[1]);
  await expect.poll(() => state.rows[0].extraFields[field.key]).not.toContain(slashCategories[0]);
  await page.reload();
  await expect(target.locator(".selection-choice-pill")).toHaveText(slashCategories[1]);
  await expect(target.locator(".selection-choice-pill")).toHaveCSS("background-color", "rgb(85, 115, 153)");
});

test("copy readable slash choices and paste them after a fresh page load without exposing the transport marker", async ({ page }) => {
  const firstValue = joinChoiceValues(slashCategories);
  const state = await fixture(page, { field: savedCategoryField, firstValue });
  await cell(page, savedCategoryField.key).click({ position: { x: 2, y: 2 } });
  const copied = await page.locator(".selection-sheet table").evaluate(element => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    return clipboardData.getData("text/plain");
  });
  expect(JSON.parse(copied)).toEqual(slashCategories);
  expect(copied).not.toContain("@choices");
  // Reload clears the component's remembered single-cell copy and exercises
  // the same text parser used for externally supplied clipboard content.
  await page.reload();
  const target = cell(page, savedCategoryField.key, "slash-2");
  await target.click({ position: { x: 2, y: 2 } });
  await target.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  }, copied);
  await cell(page, "xutiStyleNo").click();
  await expect.poll(() => state.rows[1].extraFields[savedCategoryField.key]).toBe(firstValue);
  await expect(target.locator(".selection-choice-pill")).toHaveCount(2);
  await expect(target.locator(".selection-choice-pill").nth(0)).toHaveText(slashCategories[0]);
  await expect(target.locator(".selection-choice-pill").nth(1)).toHaveText(slashCategories[1]);
  await page.reload();
  await expect(target.locator(".selection-choice-pill")).toHaveCount(2);
  await expect(target.locator(".selection-choice-pill").nth(0)).toHaveCSS("background-color", "rgb(170, 91, 76)");
  await expect(target.locator(".selection-choice-pill").nth(1)).toHaveCSS("background-color", "rgb(85, 115, 153)");
});

test("changing a populated slash multiple-choice field to text is rejected and preserves its labels", async ({ page }) => {
  const firstValue = joinChoiceValues(slashCategories);
  const state = await fixture(page, { field: savedCategoryField, firstValue });
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "编辑字段三级类目", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑字段", exact: true });
  await dialog.getByLabel("字段类型", { exact: true }).fill("文本");
  await page.locator(".ant-select-dropdown:visible").getByText("文本", { exact: true }).click();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("已有含 / 的多选内容，请先调整内容后再修改字段类型", { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(state.savedField()?.type).toBe("multiple");
  expect(state.rows[0].extraFields[savedCategoryField.key]).toBe(firstValue);
  expect(state.patches).toHaveLength(0);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.reload();
  const target = cell(page, savedCategoryField.key);
  await expect(target.locator(".selection-choice-pill")).toHaveCount(2);
  await expect(target.locator(".selection-choice-pill").nth(0)).toHaveText(slashCategories[0]);
  await expect(target.locator(".selection-choice-pill").nth(1)).toHaveText(slashCategories[1]);
});

test("single choice accepts a complete slash label and retains it after autosave and reload", async ({ page }) => {
  const state = await fixture(page);
  const dialog = await openNewField(page, "单选");
  await dialog.getByLabel("字段选项", { exact: true }).fill(slashCategories.join("\n"));
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => state.savedField()?.options).toEqual(slashCategories);
  const key = state.savedField()!.key, target = cell(page, key);
  await target.click();
  await target.getByRole("button", { name: "展开三级类目选项", exact: true }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: slashCategories[0] }).click();
  await cell(page, "xutiStyleNo").click();
  await expect.poll(() => state.rows[0].extraFields[key]).toBe(slashCategories[0]);
  await page.reload();
  await expect(target.locator(".selection-choice-pill")).toHaveCount(1);
  await expect(target.locator(".selection-choice-pill")).toHaveText(slashCategories[0]);
});

for (const validation of [
  { name: "empty choices", text: "", error: "请填写至少1个选项，每行一个" },
  { name: "over 100 distinct choices", text: Array.from({ length: 101 }, (_, index) => `类目${index + 1}`).join("\n"), error: "有效选项共101项，最多100项" },
  { name: "an overlength choice", text: "类".repeat(81), error: "第1个选项超过80字（当前81字）" },
]) {
  test(`field creation explains ${validation.name} without saving an invalid definition`, async ({ page }) => {
    const state = await fixture(page);
    const dialog = await openNewField(page);
    await dialog.getByLabel("字段选项", { exact: true }).fill(validation.text);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText(validation.error, { exact: true }).last()).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(state.savedField()).toBeUndefined();
    expect(state.patches).toHaveLength(0);
  });
}

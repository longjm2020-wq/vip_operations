import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, readonly = false, max = 30, multiple = true) {
  const rows: Record<string, any>[] = [1, 2].map(id => ({
    id: String(id), xutiStyleNo: `TAG-${id}`, color: "黑色/白色", sizeRange: "M/L", sortOrder: id,
    updatedAt: "2026-10-10T00:00:00Z", images: [{ id: "photo", url: "https://example.test/tag.jpg", color: "黑色" }], labelImages: [],
    extraFields: { "custom:standard": multiple ? "粉色/红色/青色" : "粉色", "custom:fixed": "红色", "custom:choice": "规范" },
    defaultCellAccess: "edit", cellAccess: id === 2 ? { images: "read", "custom:standard": "read" } : {},
  }));
  await page.addInitScript(({ max, multiple }) => {
    localStorage.setItem("selection-field-types-initialized-v2", "1");
    localStorage.setItem("style-selection-custom-columns-v1", JSON.stringify([
      { key: "custom:standard", label: "标准颜色", width: 120, custom: true, type: "tags", tagConfig: { allowCustom: true, multiple, max, order: "selection", color: "blue" } },
      { key: "custom:fixed", label: "候选颜色", width: 120, custom: true, type: "tags", options: ["红色", "蓝色"], tagConfig: { allowCustom: false, multiple: true, max: 30, order: "selection", color: "orange" } },
      { key: "custom:choice", label: "核对", width: 120, custom: true, type: "single", options: ["规范", "不规范"] },
    ]));
  }, { max, multiple });
  let revision = 0, layout = { preferences: null as any, revision: 0 };
  const patches: any[] = [];
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let data: any = [];
    if (path.endsWith("/auth/me")) data = { id: "1", displayName: "标签测试", roleCodes: [], csrfToken: "test", permissions: readonly ? ["selection.read"] : ["selection.read", "selection.manage"] };
    if (path.endsWith("/revision")) data = { revision: String(revision) };
    if (path.endsWith("/sync")) data = { revision: String(revision), index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) {
      if (route.request().method() === "POST") layout = { preferences: route.request().postDataJSON().preferences, revision: layout.revision + 1 };
      data = layout;
    }
    const row = rows.find(row => path.endsWith(`/style-selections/${row.id}`));
    if (row && route.request().method() === "PATCH") {
      const body = route.request().postDataJSON(); patches.push(body);
      Object.assign(row, body, { extraFields: { ...row.extraFields, ...body.extraFields }, updatedAt: new Date(1791590400000 + ++revision).toISOString() }); data = row;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(cell(page, "1", "color")).toBeVisible();
  return { rows, patches };
}
const cell = (page: Page, row: string, column: string) => page.locator(`td[data-selection-row="${row}"][data-selection-column="${column}"]`);

test("click a free label to edit one item, validate, cancel and keep native text shortcuts", async ({ page }) => {
  const { rows, patches } = await fixture(page);
  const target = cell(page, "1", "custom:standard");
  await target.getByRole("button", { name: "编辑标准颜色标签：红色", exact: true }).click();
  const editor = target.getByRole("textbox", { name: "编辑标准颜色标签：红色", exact: true });
  await expect(editor).toBeFocused();
  await editor.fill("玫红");
  await editor.press("Control+A");
  await editor.press("Backspace");
  await expect(editor).toHaveValue("");
  await expect(target).toContainText("粉色");
  await editor.fill("粉色"); await editor.press("Enter");
  await expect(page.getByText("当前单元格已有同名标签", { exact: true })).toBeVisible();
  await editor.fill("红/黑"); await editor.press("Enter");
  await expect(page.getByText("单个标签不能包含 /", { exact: true })).toBeVisible();
  await editor.fill("玫红"); await editor.press("Escape");
  await expect(target.getByRole("button", { name: "编辑标准颜色标签：红色", exact: true })).toBeVisible();
  expect(patches).toHaveLength(0);
  await target.getByRole("button", { name: "编辑标准颜色标签：红色", exact: true }).click();
  await editor.fill("玫红");
  await editor.dispatchEvent("compositionstart");
  await editor.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(editor).toBeVisible();
  expect(patches).toHaveLength(0);
  await editor.dispatchEvent("compositionend");
  await editor.press("Enter");
  await expect.poll(() => rows[0].extraFields["custom:standard"]).toBe("粉色/玫红/青色");
  expect(rows[1].extraFields["custom:standard"]).toBe("粉色/红色/青色");
  await target.getByRole("button", { name: "编辑标准颜色标签：青色", exact: true }).click();
  await target.getByRole("textbox").fill("浅青");
  await cell(page, "1", "xutiStyleNo").click();
  await expect.poll(() => rows[0].extraFields["custom:standard"]).toBe("粉色/玫红/浅青");
});

test("bound color edit preserves its photos and rejects protected photo relabeling", async ({ page }) => {
  const { rows } = await fixture(page);
  const target = cell(page, "1", "color");
  await target.getByRole("button", { name: "编辑颜色标签：黑色", exact: true }).click();
  await target.getByRole("textbox").fill("墨黑"); await target.getByRole("textbox").press("Enter");
  await expect.poll(() => rows[0].color).toBe("墨黑/白色");
  expect(rows[0].images).toEqual([{ id: "photo", url: "https://example.test/tag.jpg", color: "墨黑" }]);
  const protectedCell = cell(page, "2", "color");
  await protectedCell.getByRole("button", { name: "编辑颜色标签：黑色", exact: true }).click();
  await protectedCell.getByRole("textbox").fill("墨黑"); await protectedCell.getByRole("textbox").press("Enter");
  await expect(page.getByText("关联图片受保护，请先取得图片编辑权限再修改颜色", { exact: true })).toBeVisible();
  expect(rows[1].color).toBe("黑色/白色");
  await protectedCell.getByRole("textbox").press("Escape");
  await expect(cell(page, "2", "custom:standard").getByRole("button")).toHaveCount(0);
});

test("restricted and single choice labels open existing choices without changing definitions", async ({ page }) => {
  const { rows } = await fixture(page);
  const fixed = cell(page, "1", "custom:fixed");
  await fixed.getByRole("button", { name: "编辑候选颜色标签：红色", exact: true }).click();
  await expect(fixed.getByRole("combobox")).toBeVisible();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: /^蓝色$/ }).click();
  await expect.poll(() => rows[0].extraFields["custom:fixed"]).toBe("红色/蓝色");
  await cell(page, "1", "xutiStyleNo").click();
  const choice = cell(page, "1", "custom:choice");
  await choice.getByRole("button", { name: "编辑核对标签：规范", exact: true }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: /^不规范$/ }).click();
  await expect.poll(() => rows[0].extraFields["custom:choice"]).toBe("不规范");
});

test("read-only label cells stay readable and expose no inline editors", async ({ page }) => {
  await fixture(page, true);
  for (const column of ["color", "sizeRange", "custom:standard", "custom:fixed", "custom:choice"]) {
    await expect(cell(page, "1", column).getByRole("button")).toHaveCount(0);
    await expect(cell(page, "1", column).getByRole("textbox")).toHaveCount(0);
  }
  await expect(cell(page, "1", "custom:standard")).toContainText("红色");
});

test("append consecutive tags in the same cell and keep only committed entries on cancel", async ({ page }) => {
  const { rows, patches } = await fixture(page);
  const target = cell(page, "1", "custom:standard");
  await target.click();
  await target.getByRole("button", { name: "添加标准颜色标签", exact: true }).click();
  const add = target.getByRole("textbox", { name: "编辑标准颜色标签", exact: true });
  await add.fill("金色"); await add.press("Enter");
  await expect(add).toBeFocused(); await expect(add).toHaveValue("");
  await expect(target.getByRole("button", { name: "编辑标准颜色标签：金色", exact: true })).toBeVisible();
  await add.fill("银色"); await add.press("Enter");
  await expect(add).toBeFocused(); await expect(add).toHaveValue("");
  await add.fill("取消这项"); await add.press("Escape");
  await expect.poll(() => rows[0].extraFields["custom:standard"]).toBe("粉色/红色/青色/金色/银色");
  expect(rows[1].extraFields["custom:standard"]).toBe("粉色/红色/青色");
  expect(patches.flatMap(body => Object.values(body.extraFields || {}))).not.toContain("粉色/红色/青色/金色/银色/取消这项");
  await target.getByRole("button", { name: "编辑标准颜色标签：红色", exact: true }).click();
  await target.getByRole("textbox", { name: "编辑标准颜色标签：红色", exact: true }).fill("朱红");
  await target.getByRole("textbox", { name: "编辑标准颜色标签：红色", exact: true }).press("Enter");
  await expect(add).toBeFocused();
  await add.press("Enter");
  await expect(add).toHaveCount(0);
  await expect.poll(() => rows[0].extraFields["custom:standard"]).toBe("粉色/朱红/青色/金色/银色");
});

test("appending stops at the configured limit and blur saves one final tag", async ({ page }) => {
  const { rows } = await fixture(page, false, 4);
  const target = cell(page, "1", "custom:standard");
  await target.click();
  await target.getByRole("button", { name: "添加标准颜色标签", exact: true }).click();
  await target.getByRole("textbox", { name: "编辑标准颜色标签", exact: true }).fill("金色");
  await cell(page, "1", "xutiStyleNo").click();
  await expect.poll(() => rows[0].extraFields["custom:standard"]).toBe("粉色/红色/青色/金色");
  await target.click();
  await expect(target.getByRole("button", { name: "添加标准颜色标签", exact: true })).toHaveCount(0);
  await target.getByRole("button", { name: "编辑标准颜色标签：金色", exact: true }).click();
  await target.getByRole("textbox").fill("银色"); await target.getByRole("textbox").press("Enter");
  await expect(target.getByRole("textbox")).toHaveCount(0);
  await expect.poll(() => rows[0].extraFields["custom:standard"]).toBe("粉色/红色/青色/银色");
});

test("single-tag fields allow replacement but do not offer a second tag", async ({ page }) => {
  const { rows } = await fixture(page, false, 30, false);
  const target = cell(page, "1", "custom:standard");
  await target.click({ position: { x: 3, y: 3 } });
  await expect(target.getByRole("button", { name: "添加标准颜色标签", exact: true })).toHaveCount(0);
  await target.getByRole("button", { name: "编辑标准颜色标签：粉色", exact: true }).click();
  await target.getByRole("textbox").fill("金色"); await target.getByRole("textbox").press("Enter");
  await expect(target.getByRole("textbox")).toHaveCount(0);
  await expect.poll(() => rows[0].extraFields["custom:standard"]).toBe("金色");
});

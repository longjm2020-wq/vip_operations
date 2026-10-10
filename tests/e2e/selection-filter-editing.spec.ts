import { expect, test, type Page } from "@playwright/test";
import { selectionLayoutSchema, type SelectionLayoutSnapshot } from "../../packages/contracts/src/selection-layout.js";

const fieldKey = "custom:execution-standard";
const rowId = "editing-empty";

async function fixture(page: Page, options: { permission?: "readonly" | "read" | "deny"; filtered?: boolean } = {}) {
  let revision = 0;
  let layout: SelectionLayoutSnapshot = {
    preferences: selectionLayoutSchema.parse({
      columns: [
        { key: "xutiStyleNo", label: "序缇款号", width: 160, type: "text" },
        { key: fieldKey, label: "执行标准", width: 240, custom: true, type: "text" },
      ],
      rowHeight: "compact",
      pageSize: 500,
    }),
    revision: 1,
    sharedPreferences: null,
    sharedRevision: 0,
    canEditShared: options.permission !== "readonly",
  };
  const initialValue = options.permission === "read" || options.permission === "deny" ? "受保护原始标准" : "";
  const rows = [initialValue, "", "已有标准"].map((standard, index) => ({
    id: index === 0 ? rowId : `editing-${index}`,
    xutiStyleNo: `EDITING-${index}`,
    sortOrder: index + 1,
    images: [],
    labelImages: [],
    extraFields: { [fieldKey]: standard },
    updatedAt: "2026-10-10T00:00:00.000Z",
    defaultCellAccess: "edit",
    cellAccess: options.permission === "read" || options.permission === "deny" ? { [fieldKey]: options.permission } : {},
  }));
  const writes: { id: string; body: Record<string, unknown> }[] = [];
  await page.addInitScript(() => localStorage.setItem("selection-field-types-initialized-v2", "1"));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = {
      id: "101", displayName: "筛选编辑测试", roleCodes: [], csrfToken: "fixture",
      permissions: options.permission === "readonly" ? ["selection.read"] : ["selection.read", "selection.manage"],
    };
    if (path.endsWith("/revision")) data = { revision: `filter-editing-${revision}` };
    if (path.endsWith("/sync")) data = {
      revision: `filter-editing-${revision}`,
      index: rows.map((row) => ({ id: row.id, token: row.updatedAt })),
      data: rows,
    };
    if (path.endsWith("/layout-preferences")) {
      if (request.method() === "POST") layout = {
        ...layout, preferences: request.postDataJSON().preferences, revision: layout.revision + 1,
      };
      data = layout;
    }
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    const row = rows.find((candidate) => path.endsWith(`/style-selections/${candidate.id}`));
    if (row && request.method() === "PATCH") {
      const body = request.postDataJSON();
      writes.push({ id: row.id, body });
      Object.assign(row, body, {
        extraFields: { ...row.extraFields, ...body.extraFields },
        updatedAt: new Date(Date.UTC(2026, 9, 10) + ++revision).toISOString(),
      });
      data = row;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(3);
  if (options.filtered !== false) {
    await page.getByRole("button", { name: "筛选执行标准", exact: true }).click();
    const filter = page.locator(".selection-filter-panel:visible");
    await filter.locator(".selection-filter-values").getByRole("checkbox", { name: /^已有标准\s*\(1\)$/ }).uncheck();
    await filter.getByRole("button", { name: "确认", exact: true }).click();
    await expect(filter).toHaveCount(0);
    await expect(page.locator("tr[data-selection-row]")).toHaveCount(2);
    await expect(page.locator('tr[data-selection-row="editing-2"]')).toHaveCount(0);
  }
  return { writes, savedValue: () => rows[0].extraFields[fieldKey] };
}

const row = (page: Page) => page.locator(`tr[data-selection-row="${rowId}"]`);
const cell = (page: Page) => page.locator(`td[data-selection-row="${rowId}"][data-selection-column="${fieldKey}"]`);
const cellInput = (page: Page) => cell(page).getByLabel("执行标准", { exact: true });
const barInput = (page: Page) => page.getByRole("group", { name: "单元格编辑栏", exact: true }).getByLabel("执行标准", { exact: true });

test("空白列筛选下执行标准逐字输入期间保留当前行和焦点并保存完整内容", async ({ page }) => {
  const state = await fixture(page);
  const input = cellInput(page);
  await input.dblclick();
  await expect(input).toBeEditable();
  await expect(input).toBeFocused();
  await input.pressSequentially("G");
  await expect(row(page), "首字符不应立即使正在编辑的空白筛选行消失").toBeVisible();
  await expect.poll(state.savedValue).toBe("G");
  await expect(input).toBeFocused();
  await input.pressSequentially("B/T 15557-2025", { delay: 40 });
  await expect(input).toHaveValue("GB/T 15557-2025");
  await page.getByRole("button", { name: "筛选序缇款号", exact: true }).focus();
  await expect(row(page), "离开编辑位置后应恢复空白列筛选").toHaveCount(0);
  await expect.poll(state.savedValue).toBe("GB/T 15557-2025");
  expect(state.writes.at(-1)?.body.extraFields).toEqual({ [fieldKey]: "GB/T 15557-2025" });
});

test("空白列筛选下执行标准中文组合输入不会中断或卸载输入框", async ({ page }) => {
  const state = await fixture(page);
  const input = cellInput(page);
  await input.dblclick();
  await input.dispatchEvent("compositionstart", { data: "" });
  await input.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "zhi");
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "zhi", isComposing: true }));
  });
  await expect(row(page), "中文组合阶段不应因候选文本不再为空而卸载当前行").toBeVisible();
  await expect(input).toBeFocused();
  await input.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "执行标准");
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "执行标准", isComposing: true }));
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "执行标准" }));
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "执行标准", isComposing: false }));
  });
  await expect(input).toHaveValue("执行标准");
  await input.pressSequentially(" GB/T 15557-2025", { delay: 30 });
  await expect(input).toHaveValue("执行标准 GB/T 15557-2025");
  await page.getByRole("button", { name: "筛选序缇款号", exact: true }).focus();
  await expect(row(page), "中文组合结束并离开编辑位置后应恢复空白列筛选").toHaveCount(0);
  await expect.poll(state.savedValue).toBe("执行标准 GB/T 15557-2025");
});

test("空白列筛选下顶部编辑栏可持续输入执行标准并保存完整内容", async ({ page }) => {
  const state = await fixture(page);
  await cellInput(page).click();
  const input = barInput(page);
  await expect(input).toBeEditable();
  await input.click();
  await input.pressSequentially("G");
  await expect(row(page), "顶部栏首字符不应立即使其当前行从筛选结果中消失").toBeVisible();
  await expect.poll(state.savedValue).toBe("G");
  await expect(input).toBeEditable();
  await expect(input).toBeFocused();
  await input.pressSequentially("B/T 15557-2025", { delay: 40 });
  await expect(input).toHaveValue("GB/T 15557-2025");
  await page.getByRole("button", { name: "筛选序缇款号", exact: true }).focus();
  await expect(row(page), "离开顶部编辑栏后应恢复空白列筛选").toHaveCount(0);
  await expect.poll(state.savedValue).toBe("GB/T 15557-2025");
});

test("同格在单元格、顶部栏和详情窗口之间切换可连续编辑，重新筛选后结束保留当前行", async ({ page }) => {
  const state = await fixture(page);
  await cellInput(page).dblclick();
  await cellInput(page).pressSequentially("GB/T", { delay: 30 });
  await expect(row(page)).toBeVisible();
  await barInput(page).click();
  await expect(barInput(page)).toHaveValue("GB/T");
  await barInput(page).press("End");
  await barInput(page).pressSequentially(" 15557", { delay: 30 });
  await page.getByRole("button", { name: "展开单元格详情", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "单元格详情", exact: true });
  const detailInput = detail.getByLabel("单元格详情内容", { exact: true });
  await expect(detailInput).toHaveValue("GB/T 15557");
  await detailInput.click();
  await detailInput.press("End");
  await detailInput.pressSequentially("-2025", { delay: 30 });
  await expect(row(page)).toBeVisible();
  await barInput(page).click();
  await barInput(page).press("End");
  await barInput(page).pressSequentially("（执行标准）", { delay: 30 });
  const complete = "GB/T 15557-2025（执行标准）";
  await expect(cellInput(page)).toHaveValue(complete);
  await expect(barInput(page)).toHaveValue(complete);
  await expect(detailInput).toHaveValue(complete);
  await expect.poll(state.savedValue).toBe(complete);
  await expect(barInput(page)).toBeFocused();
  expect(await page.locator("tr[data-selection-row]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-selection-row"))))
    .toEqual([rowId, "editing-1"]);
  await page.screenshot({ path: ".local/selection-filter-editing-review.png" });

  await page.getByRole("button", { name: "筛选执行标准", exact: true }).click();
  const filter = page.locator(".selection-filter-panel:visible");
  await filter.locator(".selection-filter-values").getByRole("checkbox", { name: /^\(空白\)\s*\(1\)$/ }).uncheck();
  await filter.locator(".selection-filter-values").getByRole("checkbox", { name: /^已有标准\s*\(1\)$/ }).check();
  await filter.getByRole("button", { name: "确认", exact: true }).click();
  await expect(row(page)).toHaveCount(0);
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(1);
  await expect(page.locator('tr[data-selection-row="editing-2"]')).toBeVisible();
  expect(state.savedValue()).toBe(complete);
});

for (const permission of ["readonly", "read", "deny"] as const) {
  test(`执行标准 ${permission} 权限在单元格、顶部栏和详情窗口继续生效`, async ({ page }) => {
    const state = await fixture(page, { permission, filtered: false });
    await cell(page).click();
    if (permission === "deny") {
      await expect(cell(page).getByLabel("受保护内容", { exact: true })).toBeVisible();
      await expect(cellInput(page)).toHaveCount(0);
      await expect(barInput(page)).toBeDisabled();
      await expect(barInput(page)).toHaveValue("••••");
      await expect(page.getByRole("button", { name: "展开单元格详情", exact: true })).toBeDisabled();
      expect(await row(page).innerHTML()).not.toContain("受保护原始标准");
    } else {
      await expect(cellInput(page)).toBeDisabled();
      await expect(barInput(page)).toBeDisabled();
      await page.getByRole("button", { name: "展开单元格详情", exact: true }).click();
      const detailInput = page.getByRole("dialog", { name: "单元格详情", exact: true }).getByLabel("单元格详情内容", { exact: true });
      await expect(detailInput).toHaveAttribute("readonly", "");
      const original = state.savedValue();
      await detailInput.click();
      await page.keyboard.type("无法覆盖");
      await expect(detailInput).toHaveValue(original);
      expect(state.savedValue()).toBe(original);
    }
    expect(state.writes).toEqual([]);
  });
}

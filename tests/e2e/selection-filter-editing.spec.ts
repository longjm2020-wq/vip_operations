import { expect, test, type Locator, type Page } from "@playwright/test";
import { selectionLayoutSchema, type SelectionLayoutSnapshot } from "../../packages/contracts/src/selection-layout.js";

const fieldKey = "custom:execution-standard";
const rowId = "editing-empty";

async function fixture(page: Page, options: {
  permission?: "readonly" | "read" | "deny";
  filtered?: boolean;
  type?: "text" | "single" | "multiple";
  values?: string[];
  pageSize?: number;
} = {}) {
  let revision = 0;
  let rejectSharedWrite = false;
  let layout: SelectionLayoutSnapshot = {
    preferences: selectionLayoutSchema.parse({
      columns: [
        { key: "xutiStyleNo", label: "序缇款号", width: 160, type: "text" },
        { key: fieldKey, label: "执行标准", width: 240, custom: true, type: options.type || "text", options: options.type && options.type !== "text" ? ["女士皮衣/皮草", "女士睡衣/家居服", "已有标准"] : undefined },
      ],
      rowHeight: "compact",
      pageSize: options.pageSize || 500,
    }),
    revision: 1,
    sharedPreferences: null,
    sharedRevision: 0,
    canEditShared: options.permission !== "readonly",
  };
  const initialValue = options.permission === "read" || options.permission === "deny" ? "受保护原始标准" : "";
  const rows = (options.values || [initialValue, "", "已有标准"]).map((standard, index) => ({
    id: index === 0 ? rowId : `editing-${index}`,
    xutiStyleNo: `EDITING-${index}`,
    sortOrder: index + 1,
    images: [],
    labelImages: [],
    extraFields: { [fieldKey]: standard },
    createdAt: new Date(Date.UTC(2026, 9, 9) + index * 1000).toISOString(),
    updatedAt: "2026-10-10T00:00:00.000Z",
    defaultCellAccess: "edit",
    cellAccess: (options.permission === "read" || options.permission === "deny" ? { [fieldKey]: options.permission } : {}) as Record<string, string>,
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
    if (path.endsWith("/sync")) {
      const { sort = "sortOrder", direction = "asc" } = request.postDataJSON() as { sort?: "sortOrder" | "createdAt" | "updatedAt"; direction?: string };
      const sorted = [...rows].sort((left, right) => (sort === "sortOrder" ? left.sortOrder - right.sortOrder : left[sort].localeCompare(right[sort])) * (direction === "asc" ? 1 : -1));
      data = {
        revision: `filter-editing-${revision}`,
        index: sorted.map((row) => ({ id: row.id, token: row.updatedAt })),
        data: sorted,
      };
    }
    if (path.endsWith("/layout-preferences")) {
      if (request.method() === "POST") layout = {
        ...layout, preferences: request.postDataJSON().preferences, revision: layout.revision + 1,
      };
      data = layout;
    }
    if (path.endsWith("/shared-view")) {
      if (request.method() === "POST" && rejectSharedWrite) {
        rejectSharedWrite = false;
        await route.fulfill({ status: 409, json: { error: { message: "共享筛选保存失败，请重试" } } });
        return;
      }
      data = { revision: 0, view: { filters: {}, sort: null } };
    }
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
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(Math.min(rows.length, options.pageSize || 500));
  if (options.filtered !== false) {
    await page.getByRole("button", { name: "筛选执行标准", exact: true }).click();
    const filter = page.locator(".selection-filter-panel:visible");
    await filter.locator(".selection-filter-values").getByRole("checkbox", { name: /^已有标准\s*\(1\)$/ }).uncheck();
    await filter.getByRole("button", { name: "确认", exact: true }).click();
    await expect(filter).toHaveCount(0);
    await expect(page.locator("tr[data-selection-row]")).toHaveCount(Math.min(rows.filter(item => !item.extraFields[fieldKey]).length, options.pageSize || 500));
  }
  const touch = () => new Date(Date.UTC(2026, 9, 10) + ++revision).toISOString();
  return {
    writes, rows, savedValue: () => rows[0].extraFields[fieldKey],
    setAccess: (access: "read" | "deny") => { rows[0].cellAccess = { [fieldKey]: access }; rows[0].updatedAt = touch(); },
    removeRow: (id: string) => { const index = rows.findIndex(item => item.id === id); rows.splice(index, 1); touch(); },
    addBlankRow: () => { const id = `editing-new-${rows.length}`; rows.push({ ...rows[0], id, xutiStyleNo: id, sortOrder: 100, extraFields: { [fieldKey]: "" }, cellAccess: {}, updatedAt: touch() }); return id; },
    rejectNextSharedWrite: () => { rejectSharedWrite = true; },
  };
}

const row = (page: Page) => page.locator(`tr[data-selection-row="${rowId}"]`);
const cell = (page: Page) => page.locator(`td[data-selection-row="${rowId}"][data-selection-column="${fieldKey}"]`);
const cellInput = (page: Page) => cell(page).getByLabel("执行标准", { exact: true });
const barInput = (page: Page) => page.getByRole("group", { name: "单元格编辑栏", exact: true }).getByLabel("执行标准", { exact: true });
const visibleRows = (page: Page) => page.locator("tr[data-selection-row]").evaluateAll(elements => elements.map(element => element.getAttribute("data-selection-row")));
async function reconfirm(page: Page) {
  await page.getByRole("button", { name: "筛选执行标准", exact: true }).click();
  const panel = page.locator(".selection-filter-panel:visible");
  await panel.getByRole("button", { name: "确认", exact: true }).click();
  await expect(panel).toHaveCount(0);
}
async function changeSort(page: Page, label: string) {
  await page.getByRole("combobox", { name: "排序方式", exact: true }).click();
  await page.locator(".ant-select-dropdown:visible").getByText(label, { exact: true }).click();
}
async function shiftDrag(page: Page, from: Locator, to: Locator) {
  const start = (await from.boundingBox())!, end = (await to.boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.move(start.x + 18, start.y + 12);
  await page.mouse.down();
  await page.mouse.move(end.x + 18, end.y + 12, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
}

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
  await expect(row(page), "离开编辑位置后仍保留已筛出的行，方便逐行补填").toBeVisible();
  await expect.poll(state.savedValue).toBe("GB/T 15557-2025");
  expect(state.writes.at(-1)?.body.extraFields).toEqual({ [fieldKey]: "GB/T 15557-2025" });
  await reconfirm(page);
  await expect(row(page), "再次确认同一空白筛选条件后才移除已填写行").toHaveCount(0);
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
  await expect(row(page), "中文组合结束并离开编辑位置后仍保留当前结果").toBeVisible();
  await expect.poll(state.savedValue).toBe("执行标准 GB/T 15557-2025");
  await reconfirm(page);
  await expect(row(page)).toHaveCount(0);
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
  await expect(row(page), "离开顶部编辑栏后仍保留已筛出的行").toBeVisible();
  await expect.poll(state.savedValue).toBe("GB/T 15557-2025");
  await reconfirm(page);
  await expect(row(page)).toHaveCount(0);
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

test("空白筛选下连续补填两行，Esc、换格与取消筛选面板均不重筛，清除立即生效", async ({ page }) => {
  const state = await fixture(page);
  await cellInput(page).dblclick();
  await cellInput(page).fill("第一行已补填");
  await expect.poll(state.savedValue).toBe("第一行已补填");
  await cellInput(page).press("Escape");
  const second = page.locator(`td[data-selection-row="editing-1"][data-selection-column="${fieldKey}"]`).getByLabel("执行标准", { exact: true });
  await second.dblclick();
  await second.fill("第二行已补填");
  await expect.poll(() => state.rows[1].extraFields[fieldKey]).toBe("第二行已补填");
  expect(await visibleRows(page)).toEqual([rowId, "editing-1"]);

  await page.getByRole("button", { name: "筛选执行标准", exact: true }).click();
  const panel = page.locator(".selection-filter-panel:visible");
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(await visibleRows(page), "打开后取消不能使刚填好的两行跳走").toEqual([rowId, "editing-1"]);

  await page.getByRole("button", { name: "筛选执行标准", exact: true }).click();
  await panel.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(await visibleRows(page), "清除无需再确认，恢复全部三行").toEqual([rowId, "editing-1", "editing-2"]);
});

for (const type of ["single", "multiple"] as const) {
  test(`空白筛选下${type === "single" ? "单选" : "多选"}填写完整斜杠标签后换格仍留在结果，重新确认才移除`, async ({ page }) => {
    const state = await fixture(page, { type });
    await cell(page).click();
    await cell(page).getByRole("button", { name: "展开执行标准选项", exact: true }).click();
    const labels = type === "single" ? ["女士皮衣/皮草"] : ["女士皮衣/皮草", "女士睡衣/家居服"];
    for (const label of labels) await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: label }).click();
    await page.locator(`td[data-selection-row="editing-1"][data-selection-column="xutiStyleNo"]`).click();
    await expect.poll(state.savedValue).toContain(labels[0]);
    await expect(cell(page).locator(".selection-choice-pill")).toHaveCount(labels.length);
    expect(await visibleRows(page)).toEqual([rowId, "editing-1"]);
    await reconfirm(page);
    await expect(row(page)).toHaveCount(0);
    expect(await visibleRows(page)).toEqual(["editing-1"]);
  });
}

test("分页前后保留空白筛选的成员与顺序，返回首页仍显示已填写的原行", async ({ page }) => {
  const state = await fixture(page, { values: [...Array<string>(22).fill(""), "已有标准"], pageSize: 20 });
  const before = await visibleRows(page);
  await cellInput(page).dblclick();
  await cellInput(page).fill("首页已补填");
  await expect.poll(state.savedValue).toBe("首页已补填");
  await page.locator(".selection-pagination .ant-pagination-next button").click();
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(2);
  expect(await visibleRows(page)).toEqual(["editing-20", "editing-21"]);
  await page.locator(".selection-pagination .ant-pagination-prev button").click();
  await expect(row(page)).toBeVisible();
  expect(await visibleRows(page)).toEqual(before);
  await expect(cellInput(page)).toHaveValue("首页已补填");
  await reconfirm(page);
  await expect(row(page)).toHaveCount(0);
  expect((await visibleRows(page))[0]).toBe("editing-1");
});

test("空白筛选下拖行更新保留顺序、拖列不会触发重筛，均可保存布局和顺序", async ({ page }) => {
  const state = await fixture(page, { values: ["", "", "", "已有标准"] });
  await cellInput(page).dblclick();
  await cellInput(page).fill("已补填仍可拖动");
  await expect.poll(state.savedValue).toBe("已补填仍可拖动");
  await shiftDrag(page,
    page.locator(`td[data-reorder-axis="row"][data-reorder-key="${rowId}"]`),
    page.locator('td[data-reorder-axis="row"][data-reorder-key="editing-1"]'));
  await expect.poll(() => visibleRows(page), "拖行后应立即反映新的顺序，仍保留已填行").toEqual(["editing-1", rowId, "editing-2"]);
  await expect.poll(() => [...state.rows].sort((left, right) => left.sortOrder - right.sortOrder).map(item => item.id)).toEqual(["editing-1", rowId, "editing-2", "editing-3"]);

  await shiftDrag(page, page.locator('thead th[data-selection-column="xutiStyleNo"]'), page.locator(`thead th[data-selection-column="${fieldKey}"]`));
  await expect.poll(() => page.locator("thead th[data-selection-column]").evaluateAll(elements => elements.map(element => element.getAttribute("data-selection-column")))).toEqual([fieldKey, "xutiStyleNo"]);
  expect(await visibleRows(page), "只移动字段位置不会重新套用空白条件").toEqual(["editing-1", rowId, "editing-2"]);
  await expect(cellInput(page)).toHaveValue("已补填仍可拖动");
  await reconfirm(page);
  await expect.poll(() => visibleRows(page)).toEqual(["editing-1", "editing-2"]);
});

test("基础排序在手动与最新登记之间反复切换时重筛并使用当前请求及缓存的正确顺序", async ({ page }) => {
  const state = await fixture(page, { values: ["", "", "", "", "", "已有标准"] });
  await cellInput(page).dblclick();
  await cellInput(page).fill("手动排序中已补填");
  await expect.poll(state.savedValue).toBe("手动排序中已补填");
  await changeSort(page, "最新登记");
  await expect.poll(() => visibleRows(page)).toEqual(["editing-4", "editing-3", "editing-2", "editing-1"]);
  await changeSort(page, "手动排序");
  await expect.poll(() => visibleRows(page), "返回已缓存的手动排序也必须使用升序").toEqual(["editing-1", "editing-2", "editing-3", "editing-4"]);
  await changeSort(page, "最新登记");
  await expect.poll(() => visibleRows(page)).toEqual(["editing-4", "editing-3", "editing-2", "editing-1"]);
  const newestInput = page.locator(`td[data-selection-row="editing-4"][data-selection-column="${fieldKey}"]`).getByLabel("执行标准", { exact: true });
  await newestInput.dblclick();
  await newestInput.fill("最新登记中已补填");
  await expect.poll(() => state.rows[4].extraFields[fieldKey]).toBe("最新登记中已补填");
  expect(await visibleRows(page)).toEqual(["editing-4", "editing-3", "editing-2", "editing-1"]);
  await changeSort(page, "手动排序");
  await expect.poll(() => visibleRows(page), "再次排序才移除新填好的行，剩余行仍按当前顺序排列").toEqual(["editing-1", "editing-2", "editing-3"]);
});

test("共享筛选提交失败不结束当前结果保留，取消失败面板也不会重筛", async ({ page }) => {
  const state = await fixture(page);
  await cellInput(page).dblclick();
  await cellInput(page).fill("共享提交失败时保留");
  await expect.poll(state.savedValue).toBe("共享提交失败时保留");
  await page.getByRole("button", { name: "筛选执行标准", exact: true }).click();
  const panel = page.locator(".selection-filter-panel:visible");
  await panel.getByRole("switch", { name: "筛选对所有人可见", exact: true }).check();
  state.rejectNextSharedWrite();
  await panel.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByText("共享筛选保存失败，请重试", { exact: true })).toBeVisible();
  await expect(panel).toBeVisible();
  expect(await visibleRows(page)).toEqual([rowId, "editing-1"]);
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(await visibleRows(page)).toEqual([rowId, "editing-1"]);
  await expect(cellInput(page)).toHaveValue("共享提交失败时保留");
});

test("保留的筛选结果使用最新权限：编辑权限撤回即时禁用，查看权限撤回即时移除", async ({ page }) => {
  await page.clock.install();
  const state = await fixture(page);
  await cellInput(page).dblclick();
  await cellInput(page).fill("补填后仍在结果");
  await expect.poll(state.savedValue).toBe("补填后仍在结果");
  state.setAccess("read");
  await page.clock.fastForward(31_000);
  await expect(row(page)).toBeVisible();
  await expect(cellInput(page), "保留位置不应保留已撤回的编辑权限").toBeDisabled();
  state.setAccess("deny");
  await page.clock.fastForward(31_000);
  await expect(row(page), "保留位置不应保留不可查看字段的筛选结果").toHaveCount(0);
  expect(await visibleRows(page)).toEqual(["editing-1"]);
});

test("远端新增匹配行可加入，删除行立即移除，已补填的原行仍保留", async ({ page }) => {
  await page.clock.install();
  const state = await fixture(page);
  await cellInput(page).dblclick();
  await cellInput(page).fill("原筛选行已补填");
  await expect.poll(state.savedValue).toBe("原筛选行已补填");
  const added = state.addBlankRow();
  state.removeRow("editing-1");
  await page.clock.fastForward(31_000);
  await expect(page.locator(`tr[data-selection-row="${added}"]`)).toBeVisible();
  await expect(page.locator('tr[data-selection-row="editing-1"]')).toHaveCount(0);
  expect(await visibleRows(page)).toEqual([rowId, added]);
  await expect(cellInput(page)).toHaveValue("原筛选行已补填");
});

test("仅全局搜索没有列筛选时沿用编辑暂留，离开单元格后按搜索条件移除", async ({ page }) => {
  const state = await fixture(page, { filtered: false, values: ["独有待填内容", "", "已有标准"] });
  await page.getByRole("textbox", { name: "搜索选款", exact: true }).fill("独有待填内容");
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(1);
  await cellInput(page).dblclick();
  await cellInput(page).fill("替换后不匹配");
  await expect.poll(state.savedValue).toBe("替换后不匹配");
  await expect(row(page)).toBeVisible();
  await page.getByRole("button", { name: "筛选序缇款号", exact: true }).focus();
  await expect(row(page), "手动重筛语义仅针对列筛选，不改变搜索编辑暂留").toHaveCount(0);
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

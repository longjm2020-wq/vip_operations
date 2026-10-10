import { expect, test, type Locator, type Page } from "@playwright/test";
import Excel from "exceljs";
import { selectionLayoutSchema, type SelectionLayoutSnapshot } from "../../packages/contracts/src/selection-layout.js";
import type { SelectionView } from "../../packages/contracts/src/selection-view.js";

const materials = ["面料：桑蚕丝100%", "桑蚕丝/棉", "填充物：桑蚕丝100%", "羊毛100%", "纯棉100%", "粘纤100%"];
const numericField = "custom:amount";

async function fixture(page: Page, options: {
  readonly?: boolean;
  materials?: string[];
  numberValues?: (number | string)[];
  rowFormatting?: { rowColor?: string; cellColors?: Record<string, string>; cellTextColors?: Record<string, string> }[];
} = {}) {
  const values = options.materials || materials;
  let layout: SelectionLayoutSnapshot = {
    preferences: selectionLayoutSchema.parse({
      columns: [
        { key: "xutiStyleNo", label: "序缇款号", width: 120 },
        { key: "material", label: "材质", width: 260 },
        ...(options.numberValues ? [{ key: numericField, label: "数值", width: 120, custom: true, type: "number" }] : []),
      ],
      rowHeight: "compact", pageSize: 500,
    }),
    revision: 1, sharedPreferences: null, sharedRevision: 0, canEditShared: !options.readonly,
  };
  let shared: { revision: number; view: SelectionView } = { revision: 0, view: { filters: {}, sort: null } };
  const rows = values.map((material, index) => ({
    id: `filter-${index}`, xutiStyleNo: `FILTER-${index}`, material,
    sortOrder: index + 1, images: [], labelImages: [],
    extraFields: options.numberValues ? { [numericField]: options.numberValues[index] } : {},
    updatedAt: "2026-10-10T00:00:00.000Z", defaultCellAccess: "edit", cellAccess: {},
    ...options.rowFormatting?.[index],
  }));
  const sharedWrites: { revision: number; view: SelectionView }[] = [];
  const rowWrites: string[] = [];
  let rejectSharedWrite = false;
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = {
      id: "10", displayName: "筛选搜索测试", roleCodes: [], csrfToken: "fixture",
      permissions: options.readonly ? ["selection.read"] : ["selection.read", "selection.manage"],
    };
    if (path.endsWith("/revision")) data = { revision: "filter-fixture" };
    if (path.endsWith("/sync")) data = {
      revision: "filter-fixture", index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows,
    };
    if (path.endsWith("/layout-preferences")) {
      if (route.request().method() === "POST") layout = { ...layout, preferences: route.request().postDataJSON().preferences, revision: layout.revision + 1 };
      data = layout;
    }
    if (path.endsWith("/shared-view")) {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        sharedWrites.push(body);
        if (rejectSharedWrite) {
          rejectSharedWrite = false;
          await route.fulfill({ status: 409, json: { error: { message: "共享筛选保存失败，请重试" } } });
          return;
        }
        shared = { revision: shared.revision + 1, view: body.view };
      }
      data = shared;
    }
    if (route.request().method() === "PATCH" && /\/style-selections\/[^/]+$/.test(path)) rowWrites.push(path);
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(values.length);
  return {
    sharedWrites, rowWrites,
    savedFilter: () => layout.preferences!.columnFilters.material,
    savedView: (): SelectionView => ({ filters: layout.preferences!.columnFilters, sort: layout.preferences!.columnSort }),
    rejectNextSharedWrite: () => { rejectSharedWrite = true; },
  };
}

const visibleRows = (page: Page) => page.locator("tr[data-selection-row]").evaluateAll(elements => elements.map(element => element.getAttribute("data-selection-row")));
async function openFilter(page: Page, label = "材质") {
  await page.getByRole("button", { name: `筛选${label}`, exact: true }).click();
  const panel = page.locator(".selection-filter-panel:visible");
  await expect(panel).toBeVisible();
  return panel;
}
const queryInput = (panel: Locator) => panel.getByRole("textbox", { name: "搜索筛选选项", exact: true });
const optionCheckbox = (panel: Locator, value: string) => {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return panel.locator(".selection-filter-values").getByRole("checkbox", { name: new RegExp(`^${escaped}\\s*\\(\\d+\\)$`) });
};
async function confirm(panel: Locator) {
  await panel.getByRole("button", { name: "确认", exact: true }).click();
  await expect(panel).toHaveCount(0);
}

async function selectPanelOption(page: Page, panel: Locator, label: string, value: string) {
  const select = panel.getByRole("combobox", { name: label, exact: true });
  await select.click();
  const option = page.locator(".ant-select-dropdown:visible").getByText(value, { exact: true });
  // AntD virtualizes long condition lists. Arrow navigation exposes the
  // remaining choices without reaching into Select's internal state.
  for (let step = 0; step < 20 && !await option.count(); step++) await select.press("ArrowDown");
  await option.click();
}

const optionOrder = (panel: Locator) => panel.locator(".selection-filter-values span[title]")
  .evaluateAll(elements => elements.map(element => element.getAttribute("title")));

test("searching for silk applies the visible matching options and exports the same draft result", async ({ page }) => {
  const state = await fixture(page);
  const panel = await openFilter(page);
  await queryInput(panel).fill("桑蚕丝");
  await expect(panel.locator(".selection-filter-values").getByRole("checkbox")).toHaveCount(3);
  const downloadReady = page.waitForEvent("download");
  await panel.getByRole("button", { name: /导出$/ }).click();
  await page.getByRole("menuitem", { name: "导出本列筛选结果", exact: true }).click();
  const download = await downloadReady;
  const book = new Excel.Workbook();
  await book.xlsx.readFile((await download.path())!);
  expect(book.worksheets[0].rowCount).toBe(4);
  expect(book.worksheets[0].getColumn(1).values.slice(2)).toEqual(["FILTER-0", "FILTER-1", "FILTER-2"]);
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-0", "filter-1", "filter-2"]);
  await expect(page.getByRole("button", { name: /^清除列筛选/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "使用共享筛选", exact: true })).toHaveCount(0);
  await expect.poll(() => state.savedFilter()?.values?.slice().sort()).toEqual(materials.slice(0, 3).sort());
  expect(state.sharedWrites).toHaveLength(0);
  expect(state.rowWrites).toHaveLength(0);
});

test("clearing option search preserves the original checkbox draft including excluded nonmatching values", async ({ page }) => {
  await fixture(page);
  const panel = await openFilter(page);
  await optionCheckbox(panel, "羊毛100%").uncheck();
  await queryInput(panel).fill("桑蚕丝");
  await expect(panel.locator(".selection-filter-values").getByRole("checkbox")).toHaveCount(3);
  await queryInput(panel).fill("");
  await expect(optionCheckbox(panel, "羊毛100%")).not.toBeChecked();
  await expect(optionCheckbox(panel, "纯棉100%")).toBeChecked();
  await expect(optionCheckbox(panel, "面料：桑蚕丝100%")).toBeChecked();
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-0", "filter-1", "filter-2", "filter-4", "filter-5"]);
});

test("canceling a searched draft retains the previously applied selection and reopens with its original checkboxes", async ({ page }) => {
  await fixture(page);
  let panel = await openFilter(page);
  await optionCheckbox(panel, "羊毛100%").uncheck();
  await confirm(panel);
  const retained = ["filter-0", "filter-1", "filter-2", "filter-4", "filter-5"];
  await expect.poll(() => visibleRows(page)).toEqual(retained);
  panel = await openFilter(page);
  await optionCheckbox(panel, "纯棉100%").uncheck();
  await queryInput(panel).fill("桑蚕丝");
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(await visibleRows(page)).toEqual(retained);
  panel = await openFilter(page);
  await expect(queryInput(panel)).toHaveValue("");
  await expect(optionCheckbox(panel, "羊毛100%")).not.toBeChecked();
  await expect(optionCheckbox(panel, "纯棉100%")).toBeChecked();
});

test("unchecking one searched option applies only the remaining matching values", async ({ page }) => {
  const state = await fixture(page);
  const panel = await openFilter(page);
  await queryInput(panel).fill("桑蚕丝");
  await optionCheckbox(panel, "桑蚕丝/棉").uncheck();
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-0", "filter-2"]);
  await expect.poll(() => state.savedFilter()?.values?.slice().sort()).toEqual([materials[0], materials[2]].sort());
});

test("a search without matching options confirms an empty table instead of clearing the filter", async ({ page }) => {
  const state = await fixture(page);
  const panel = await openFilter(page);
  await queryInput(panel).fill("没有这种成分");
  await expect(panel.getByText("没有匹配的选项", { exact: true })).toBeVisible();
  await confirm(panel);
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(0);
  await expect.poll(() => state.savedFilter()?.values).toEqual([]);
});

test("multiple whitespace-separated keywords match any keyword", async ({ page }) => {
  await fixture(page);
  const panel = await openFilter(page);
  await queryInput(panel).fill("  桑蚕丝   羊毛  ");
  await expect(panel.locator(".selection-filter-values").getByRole("checkbox")).toHaveCount(4);
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-0", "filter-1", "filter-2", "filter-3"]);
});

test("search confirmation includes matching options beyond the first 200 rendered candidates", async ({ page }) => {
  const values = [...Array.from({ length: 205 }, (_, index) => `桑蚕丝-${String(index).padStart(3, "0")}`), "纯棉"];
  const state = await fixture(page, { materials: values });
  const panel = await openFilter(page);
  await queryInput(panel).fill("桑蚕丝");
  await expect(panel.locator(".selection-filter-values").getByRole("checkbox")).toHaveCount(200);
  await panel.getByRole("button", { name: "加载更多（剩余 5 项）", exact: true }).click();
  await expect(panel.locator(".selection-filter-values").getByRole("checkbox")).toHaveCount(205);
  await queryInput(panel).fill("");
  await queryInput(panel).fill("桑蚕丝");
  await expect(panel.locator(".selection-filter-values").getByRole("checkbox")).toHaveCount(200);
  await confirm(panel);
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(205);
  await expect(page.locator('tr[data-selection-row="filter-204"]')).toHaveCount(1);
  await expect(page.locator('tr[data-selection-row="filter-205"]')).toHaveCount(0);
  await expect.poll(() => state.savedFilter()?.values?.length).toBe(205);
});

test("readonly users can apply a personal searched filter without publishing a shared view", async ({ page }) => {
  const state = await fixture(page, { readonly: true });
  const panel = await openFilter(page);
  await expect(panel.getByRole("switch", { name: "筛选对所有人可见", exact: true })).toBeDisabled();
  await queryInput(panel).fill("桑蚕丝");
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-0", "filter-1", "filter-2"]);
  expect(state.sharedWrites).toHaveLength(0);
  expect(state.rowWrites).toHaveLength(0);
});

test("editors explicitly share only the searched and checked result", async ({ page }) => {
  const state = await fixture(page);
  const panel = await openFilter(page);
  await queryInput(panel).fill("桑蚕丝");
  await optionCheckbox(panel, "桑蚕丝/棉").uncheck();
  await panel.getByRole("switch", { name: "筛选对所有人可见", exact: true }).click();
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-0", "filter-2"]);
  expect(state.sharedWrites).toHaveLength(1);
  expect(state.sharedWrites[0].view.filters.material.values?.slice().sort()).toEqual([materials[0], materials[2]].sort());
  expect(state.rowWrites).toHaveLength(0);
});

test("clearing a personal column filter applies immediately and preserves other filters and committed sort", async ({ page }) => {
  const state = await fixture(page);
  let panel = await openFilter(page, "序缇款号");
  for (const value of ["FILTER-0", "FILTER-2", "FILTER-5"]) await optionCheckbox(panel, value).uncheck();
  await panel.getByRole("button", { name: /降序$/ }).click();
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-4", "filter-3", "filter-1"]);

  panel = await openFilter(page);
  await queryInput(panel).fill("桑蚕丝");
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-1"]);
  await expect.poll(() => state.savedFilter()?.values).toEqual([materials[1]]);
  const otherFilter = state.savedView().filters.xutiStyleNo;

  panel = await openFilter(page);
  await panel.getByRole("button", { name: /升序$/ }).click();
  await queryInput(panel).fill("没有这种成分");
  await panel.getByRole("button", { name: "清除筛选", exact: true }).click();

  await expect(panel).toHaveCount(0);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-4", "filter-3", "filter-1"]);
  await expect.poll(() => state.savedView()).toEqual({
    filters: { xutiStyleNo: otherFilter }, sort: { key: "xutiStyleNo", direction: "desc" },
  });
  expect(state.sharedWrites).toHaveLength(0);
  expect(state.rowWrites).toHaveLength(0);
});

test("clearing a shared column filter publishes and applies immediately without confirming", async ({ page }) => {
  const state = await fixture(page);
  let panel = await openFilter(page);
  await queryInput(panel).fill("桑蚕丝");
  await panel.getByRole("switch", { name: "筛选对所有人可见", exact: true }).click();
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-0", "filter-1", "filter-2"]);

  panel = await openFilter(page);
  await expect(panel.getByRole("switch", { name: "筛选对所有人可见", exact: true })).toBeChecked();
  await queryInput(panel).fill("羊毛");
  await panel.getByRole("button", { name: "清除筛选", exact: true }).click();

  await expect(panel).toHaveCount(0);
  await expect.poll(() => visibleRows(page)).toEqual(materials.map((_, index) => `filter-${index}`));
  expect(state.sharedWrites).toHaveLength(2);
  expect(state.sharedWrites[1]).toEqual({ revision: 1, view: { filters: {}, sort: null } });
  await expect.poll(() => state.savedView()).toEqual({ filters: {}, sort: null });
  expect(state.rowWrites).toHaveLength(0);
});

test("failed shared filter clearing retains the applied filter and draft panel and can be retried", async ({ page }) => {
  const state = await fixture(page);
  let panel = await openFilter(page);
  await queryInput(panel).fill("桑蚕丝");
  await panel.getByRole("switch", { name: "筛选对所有人可见", exact: true }).click();
  await confirm(panel);
  const retained = ["filter-0", "filter-1", "filter-2"];
  await expect.poll(() => visibleRows(page)).toEqual(retained);
  await expect.poll(() => state.savedFilter()?.values?.slice().sort()).toEqual(materials.slice(0, 3).sort());

  panel = await openFilter(page);
  await optionCheckbox(panel, materials[1]).uncheck();
  state.rejectNextSharedWrite();
  await panel.getByRole("button", { name: "清除筛选", exact: true }).click();

  await expect(page.getByText("共享筛选保存失败，请重试", { exact: true })).toBeVisible();
  await expect(panel).toBeVisible();
  await expect(optionCheckbox(panel, materials[0])).toBeChecked();
  await expect(optionCheckbox(panel, materials[1])).not.toBeChecked();
  await expect(optionCheckbox(panel, materials[3])).not.toBeChecked();
  expect(await visibleRows(page)).toEqual(retained);
  expect(state.savedFilter()?.values?.slice().sort()).toEqual(materials.slice(0, 3).sort());
  expect(state.sharedWrites).toHaveLength(2);
  expect(state.sharedWrites[1]).toEqual({ revision: 1, view: { filters: {}, sort: null } });
  await expect(panel.getByRole("button", { name: "清除筛选", exact: true })).toBeEnabled();

  await panel.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect.poll(() => visibleRows(page)).toEqual(materials.map((_, index) => `filter-${index}`));
  expect(state.sharedWrites).toHaveLength(3);
  expect(state.rowWrites).toHaveLength(0);
});

test("升序、降序和取消排序在确认后改变表格顺序，取消草稿不改变已提交顺序", async ({ page }) => {
  const state = await fixture(page, { materials: ["30", "2", "10", ""] });
  let panel = await openFilter(page);
  await panel.getByRole("button", { name: /升序$/ }).click();
  expect(await visibleRows(page)).toEqual(["filter-0", "filter-1", "filter-2", "filter-3"]);
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-1", "filter-2", "filter-0", "filter-3"]);
  panel = await openFilter(page);
  await panel.getByRole("button", { name: /降序$/ }).click();
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-0", "filter-2", "filter-1", "filter-3"]);
  panel = await openFilter(page);
  await panel.getByRole("button", { name: "取消排序", exact: true }).click();
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(await visibleRows(page)).toEqual(["filter-0", "filter-2", "filter-1", "filter-3"]);
  panel = await openFilter(page);
  await panel.getByRole("button", { name: "取消排序", exact: true }).click();
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-0", "filter-1", "filter-2", "filter-3"]);
  await expect.poll(() => state.savedView().sort).toBeNull();
  expect(state.sharedWrites).toHaveLength(0);
  expect(state.rowWrites).toHaveLength(0);
});

test("选项支持名称和计数排序，全选、反选、重复项及唯一项均作用于当前候选值", async ({ page }) => {
  const state = await fixture(page, { materials: ["B", "A", "B", "", "C", "B", "A"] });
  let panel = await openFilter(page);
  await expect.poll(() => optionOrder(panel)).toEqual(["", "A", "B", "C"]);
  await selectPanelOption(page, panel, "选项排序", "名称 ↓");
  await expect.poll(() => optionOrder(panel)).toEqual(["C", "B", "A", ""]);
  await selectPanelOption(page, panel, "选项排序", "计数 ↑");
  await expect.poll(() => optionOrder(panel)).toEqual(["", "C", "A", "B"]);
  await selectPanelOption(page, panel, "选项排序", "计数 ↓");
  await expect.poll(() => optionOrder(panel)).toEqual(["B", "A", "C", ""]);
  await selectPanelOption(page, panel, "选项排序", "名称 ↑");
  await expect.poll(() => optionOrder(panel)).toEqual(["", "A", "B", "C"]);

  const all = panel.getByRole("checkbox", { name: "全选(4)", exact: true });
  await all.uncheck();
  for (const value of ["", "A", "B", "C"]) {
    await expect(optionCheckbox(panel, value || "(空白)")).not.toBeChecked();
  }
  await panel.getByRole("button", { name: "反选", exact: true }).click();
  await expect(all).toBeChecked();
  await panel.getByRole("button", { name: "重复项", exact: true }).click();
  await expect(optionCheckbox(panel, "A")).toBeChecked();
  await expect(optionCheckbox(panel, "B")).toBeChecked();
  await expect(optionCheckbox(panel, "C")).not.toBeChecked();
  await expect(optionCheckbox(panel, "(空白)")).not.toBeChecked();
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-0", "filter-1", "filter-2", "filter-5", "filter-6"]);
  panel = await openFilter(page);
  await panel.getByRole("button", { name: "唯一项", exact: true }).click();
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-3", "filter-4"]);
  panel = await openFilter(page);
  await queryInput(panel).fill("B");
  await panel.getByRole("checkbox", { name: "全选(1)", exact: true }).check();
  await queryInput(panel).fill("");
  await expect(optionCheckbox(panel, "A")).not.toBeChecked();
  await expect(optionCheckbox(panel, "B")).toBeChecked();
  await expect(optionCheckbox(panel, "C")).toBeChecked();
  await expect(optionCheckbox(panel, "(空白)")).toBeChecked();
  await panel.getByRole("checkbox", { name: "全选(4)", exact: true }).check();
  await confirm(panel);
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(7);
  expect(state.sharedWrites).toHaveLength(0);
  expect(state.rowWrites).toHaveLength(0);
});

test("背景填色、字体颜色和不限颜色实际过滤对应格式且不修改原始单元格", async ({ page }) => {
  const state = await fixture(page, {
    materials: ["A", "B", "C", "D"],
    rowFormatting: [
      { cellColors: { material: "BLUE" }, cellTextColors: { material: "#cf1322" } },
      { rowColor: "BLUE", cellTextColors: { material: "#0958d9" } },
      { cellColors: { material: "GREEN" }, cellTextColors: { material: "#cf1322" } },
      {},
    ],
  });
  let panel = await openFilter(page);
  await panel.getByRole("tab", { name: "按颜色", exact: true }).click();
  await panel.getByRole("checkbox", { name: "绿色 (1)", exact: true }).uncheck();
  await panel.getByRole("checkbox", { name: "无填色 (1)", exact: true }).uncheck();
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-0", "filter-1"]);
  panel = await openFilter(page);
  await panel.getByRole("tab", { name: "按颜色", exact: true }).click();
  await selectPanelOption(page, panel, "颜色类型", "字体颜色");
  await panel.getByRole("checkbox", { name: "蓝色 (1)", exact: true }).uncheck();
  await panel.getByRole("checkbox", { name: "默认字体 (1)", exact: true }).uncheck();
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-0", "filter-2"]);
  panel = await openFilter(page);
  await panel.getByRole("tab", { name: "按颜色", exact: true }).click();
  await panel.getByRole("button", { name: "不限颜色", exact: true }).click();
  await confirm(panel);
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(4);
  expect(state.sharedWrites).toHaveLength(0);
  expect(state.rowWrites).toHaveLength(0);
});

test("文本条件的包含、排除、等值、首尾及空值筛选均可确认生效", async ({ page }) => {
  const state = await fixture(page, { materials: ["Alpha Silk", "Silk Beta", "Alpha Cotton", "", "ALPHA"] });
  const cases = [
    { condition: "包含", value: "silk", rows: ["filter-0", "filter-1"] },
    { condition: "不包含", value: "silk", rows: ["filter-2", "filter-3", "filter-4"] },
    { condition: "等于", value: "alpha", rows: ["filter-4"] },
    { condition: "不等于", value: "alpha", rows: ["filter-0", "filter-1", "filter-2", "filter-3"] },
    { condition: "开头是", value: "alpha", rows: ["filter-0", "filter-2", "filter-4"] },
    { condition: "结尾是", value: "beta", rows: ["filter-1"] },
    { condition: "为空", rows: ["filter-3"] },
    { condition: "不为空", rows: ["filter-0", "filter-1", "filter-2", "filter-4"] },
  ];
  for (const sample of cases) {
    const panel = await openFilter(page);
    await panel.getByRole("tab", { name: "按条件", exact: true }).click();
    await selectPanelOption(page, panel, "筛选条件", sample.condition);
    if (sample.value !== undefined) await panel.getByRole("textbox", { name: "条件值", exact: true }).fill(sample.value);
    else await expect(panel.getByRole("textbox", { name: "条件值", exact: true })).toHaveCount(0);
    await confirm(panel);
    await expect.poll(() => visibleRows(page), sample.condition).toEqual(sample.rows);
  }
  expect(state.sharedWrites).toHaveLength(0);
  expect(state.rowWrites).toHaveLength(0);
});

test("大小条件按数值比较，区间缺少端点会阻止提交并在补齐后包含两个端点", async ({ page }) => {
  const state = await fixture(page, { materials: ["", "2", "10", "20", "30"] });
  for (const sample of [
    { condition: "大于 / 晚于", rows: ["filter-3", "filter-4"] },
    { condition: "大于等于", rows: ["filter-2", "filter-3", "filter-4"] },
    { condition: "小于 / 早于", rows: ["filter-1"] },
    { condition: "小于等于", rows: ["filter-1", "filter-2"] },
  ]) {
    const panel = await openFilter(page);
    await panel.getByRole("tab", { name: "按条件", exact: true }).click();
    await selectPanelOption(page, panel, "筛选条件", sample.condition);
    await panel.getByRole("textbox", { name: "条件值", exact: true }).fill("10");
    await confirm(panel);
    await expect.poll(() => visibleRows(page), sample.condition).toEqual(sample.rows);
  }
  const retained = await visibleRows(page);
  const saved = state.savedView();
  const panel = await openFilter(page);
  await panel.getByRole("tab", { name: "按条件", exact: true }).click();
  await selectPanelOption(page, panel, "筛选条件", "介于");
  await panel.getByRole("textbox", { name: "条件值", exact: true }).fill("");
  await panel.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByText("请填写区间的开始值和结束值", { exact: true })).toBeVisible();
  await expect(panel).toBeVisible();
  expect(await visibleRows(page)).toEqual(retained);
  expect(state.savedView()).toEqual(saved);
  await panel.getByRole("textbox", { name: "条件值", exact: true }).fill("2");
  await panel.getByRole("button", { name: "确认", exact: true }).click();
  await expect(panel).toBeVisible();
  expect(await visibleRows(page)).toEqual(retained);
  await panel.getByRole("textbox", { name: "结束值", exact: true }).fill("20");
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-1", "filter-2", "filter-3"]);
  expect(state.sharedWrites).toHaveLength(0);
  expect(state.rowWrites).toHaveLength(0);
});

test("导出选项与计数采用当前搜索和排序并保留勾选状态，不改变已应用筛选", async ({ page }) => {
  const state = await fixture(page, { materials: ["Silk", "Silk", "Cotton", "Silk Blend", "Silk", ""] });
  const panel = await openFilter(page);
  await queryInput(panel).fill("Silk");
  await optionCheckbox(panel, "Silk Blend").uncheck();
  await selectPanelOption(page, panel, "选项排序", "计数 ↓");
  const ready = page.waitForEvent("download");
  await panel.getByRole("button", { name: /导出$/ }).click();
  await page.getByRole("menuitem", { name: "导出选项与计数", exact: true }).click();
  const download = await ready;
  const book = new Excel.Workbook();
  await book.xlsx.readFile((await download.path())!);
  const sheet = book.worksheets[0];
  expect(sheet.getRow(1).values).toEqual([undefined, "材质", "数量", "已勾选"]);
  expect(sheet.getRow(2).values).toEqual([undefined, "Silk", 3, "是"]);
  expect(sheet.getRow(3).values).toEqual([undefined, "Silk Blend", 1, "否"]);
  expect(sheet.rowCount).toBe(3);
  await expect(panel).toBeVisible();
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(6);
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(state.savedView()).toEqual({ filters: {}, sort: null });
  expect(state.sharedWrites).toHaveLength(0);
  expect(state.rowWrites).toHaveLength(0);
});

test("自定义数字列按负数和小数数值升降排序，从文本列导出的结果保留数字列顺序", async ({ page }) => {
  const state = await fixture(page, {
    materials: ["A", "B", "C", "D", "E", "F"],
    numberValues: [-1.2, -10, 2.05, 2.5, -1.05, ""],
  });
  let panel = await openFilter(page, "数值");
  await panel.getByRole("button", { name: /升序$/ }).click();
  await confirm(panel);
  await expect.poll(() => visibleRows(page)).toEqual(["filter-1", "filter-0", "filter-4", "filter-2", "filter-3", "filter-5"]);
  panel = await openFilter(page, "数值");
  await panel.getByRole("button", { name: /降序$/ }).click();
  await confirm(panel);
  const descending = ["filter-3", "filter-2", "filter-4", "filter-0", "filter-1", "filter-5"];
  await expect.poll(() => visibleRows(page)).toEqual(descending);
  await expect.poll(() => state.savedView().sort).toEqual({ key: numericField, direction: "desc" });

  panel = await openFilter(page, "材质");
  const ready = page.waitForEvent("download");
  await panel.getByRole("button", { name: /导出$/ }).click();
  await page.getByRole("menuitem", { name: "导出本列筛选结果", exact: true }).click();
  const download = await ready;
  const book = new Excel.Workbook();
  await book.xlsx.readFile((await download.path())!);
  expect(book.worksheets[0].getColumn(1).values.slice(2)).toEqual(["FILTER-3", "FILTER-2", "FILTER-4", "FILTER-0", "FILTER-1", "FILTER-5"]);
  expect(book.worksheets[0].getColumn(3).values.slice(2)).toEqual(["D", "C", "E", "A", "B", "F"]);
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(await visibleRows(page)).toEqual(descending);
  expect(state.sharedWrites).toHaveLength(0);
  expect(state.rowWrites).toHaveLength(0);
});

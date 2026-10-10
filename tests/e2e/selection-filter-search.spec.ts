import { expect, test, type Locator, type Page } from "@playwright/test";
import Excel from "exceljs";
import { selectionLayoutSchema, type SelectionLayoutSnapshot } from "../../packages/contracts/src/selection-layout.js";
import type { SelectionView } from "../../packages/contracts/src/selection-view.js";

const materials = ["面料：桑蚕丝100%", "桑蚕丝/棉", "填充物：桑蚕丝100%", "羊毛100%", "纯棉100%", "粘纤100%"];

async function fixture(page: Page, options: { readonly?: boolean; materials?: string[] } = {}) {
  const values = options.materials || materials;
  let layout: SelectionLayoutSnapshot = {
    preferences: selectionLayoutSchema.parse({
      columns: [{ key: "xutiStyleNo", label: "序缇款号", width: 120 }, { key: "material", label: "材质", width: 260 }],
      rowHeight: "compact", pageSize: 500,
    }),
    revision: 1, sharedPreferences: null, sharedRevision: 0, canEditShared: !options.readonly,
  };
  let shared: { revision: number; view: SelectionView } = { revision: 0, view: { filters: {}, sort: null } };
  const rows = values.map((material, index) => ({
    id: `filter-${index}`, xutiStyleNo: `FILTER-${index}`, material,
    sortOrder: index + 1, images: [], labelImages: [], extraFields: {},
    updatedAt: "2026-10-10T00:00:00.000Z", defaultCellAccess: "edit", cellAccess: {},
  }));
  const sharedWrites: { revision: number; view: SelectionView }[] = [];
  const rowWrites: string[] = [];
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
  };
}

const visibleRows = (page: Page) => page.locator("tr[data-selection-row]").evaluateAll(elements => elements.map(element => element.getAttribute("data-selection-row")));
async function openFilter(page: Page) {
  await page.getByRole("button", { name: "筛选材质", exact: true }).click();
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
  await expect(panel.getByRole("button", { name: "加载更多（剩余 5 项）", exact: true })).toBeVisible();
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

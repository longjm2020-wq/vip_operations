import { expect, test, type Page } from "@playwright/test";
import { selectionLayoutSchema, type SelectionLayoutSnapshot } from "../../packages/contracts/src/selection-layout.js";

// Every application API request is fulfilled here. These regressions need only
// the local frontend and never connect to a database or a deployed workspace.
const tableId = "1000";
const totalRows = 1391;
const pageSize = 1000;
const rowId = (index: number) => String(index + 10000);
const styleNo = (index: number) => `PERF-${String(index).padStart(4, "0")}`;
type RowHeight = "compact" | "normal" | "loose" | "extra";

async function fixture(page: Page, options: {
  rowHeight?: RowHeight; grouped?: boolean; totalRows?: number; pageSize?: number;
  archive?: boolean; firstSync?: Promise<void>; failFirstSync?: boolean; waitForReady?: boolean;
} = {}) {
  let revision = 0;
  let rejectSync = !!options.failFirstSync;
  let layout: SelectionLayoutSnapshot = {
    preferences: selectionLayoutSchema.parse({
      columns: [
        { key: "xutiStyleNo", label: "序缇款号", width: 140, type: "text" },
        { key: "supplierStyleNo", label: "供应商款号", width: 140, type: "text" },
        { key: "material", label: "材质", width: 180, type: "text" },
        { key: "supplierCode", label: "供应商编码", width: 140, type: "text" },
        { key: "custom:standard", label: "执行标准", width: 180, custom: true, type: "text" },
        { key: "custom:check", label: "核对结果", width: 140, custom: true, type: "single", options: ["已核对", "待核对"] },
        { key: "vipPrice", label: "唯品价格", width: 120, type: "text" },
        { key: "images", label: "款式图片", width: 120, type: "image" },
        { key: "labelImages", label: "洗唛/吊牌图", width: 120, type: "image" },
        { key: "registrationBatch", label: "创建时间", width: 160, type: "createdTime" },
      ],
      pageSize: options.pageSize || pageSize,
      rowHeight: options.rowHeight || "compact",
      groupBy: options.grouped ? "supplier" : "none",
      statistics: { visible: ["count"], format: "plain" },
    }),
    revision: 1,
    sharedPreferences: null,
    sharedRevision: 0,
    canEditShared: true,
  };
  const rows = Array.from({ length: options.totalRows ?? totalRows }, (_, index) => ({
    id: rowId(index),
    version: 1,
    sortOrder: index + 1,
    xutiStyleNo: styleNo(index),
    supplierStyleNo: `SUPPLIER-${index}`,
    supplierCode: `GROUP-${Math.floor(index / 250)}`,
    material: `棉${index % 3 ? "95% 氨纶5%" : "100%"}`,
    vipPrice: String(100 + index),
    extraFields: { "custom:standard": `标准-${index}`, "custom:check": index % 2 ? "已核对" : "待核对" },
    images: index % 10 === 0 ? [{ id: `image-${index}`, url: `/api/v1/style-selections/images/perf-${index}?tableId=${tableId}`, color: "" }] : [],
    labelImages: [],
    cellColors: {},
    createdAt: new Date(Date.UTC(2026, 9, 11) + index * 1000).toISOString(),
    updatedAt: "2026-10-11T00:00:00.000Z",
    cellAccess: {},
    defaultCellAccess: "edit",
  }));
  const writes: { id: string; body: Record<string, unknown> }[] = [];
  const requests: { method: string; path: string; table: string | null }[] = [];
  await page.addInitScript(() => localStorage.setItem("selection-field-types-initialized-v2", "1"));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    requests.push({ method: request.method(), path, table: url.searchParams.get("tableId") });
    if (path.includes("/style-selections/images/")) {
      await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="60"><rect width="40" height="60" fill="#e9dccd"/></svg>' });
      return;
    }
    if (path.endsWith("/events")) {
      await route.fulfill({ contentType: "text/event-stream", body: "event: ready\ndata: {}\n\n" });
      return;
    }
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = {
      id: "101", displayName: "表格性能测试", roleCodes: [], csrfToken: "fixture",
      permissions: ["project.read", "selection.read", "selection.manage", "product.read", "product.update"],
    };
    if (path.endsWith(`/project-tables/${tableId}`)) data = {
      id: tableId, name: "共享性能测试", initialLayout: "selection", visibility: "PUBLIC", canEdit: true, canManage: true,
    };
    if (path.endsWith("/product-archive-table")) data = {
      id: tableId, initialLayout: "selection", canEdit: true, canManage: true, fields: layout.preferences!.columns, references: {},
    };
    if (path.endsWith("/revision")) data = { revision: `perf-${revision}` };
    if (path.endsWith("/sync")) {
      // Development StrictMode may abort and restart the initial request.
      // Hold every attempt until the test releases the same network gate.
      await options.firstSync;
      if (rejectSync) {
        await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "读取暂时失败" } } });
        return;
      }
      const known = (request.postDataJSON().known || {}) as Record<string, string>;
      data = {
        revision: `perf-${revision}`,
        index: rows.map((row) => ({ id: row.id, token: row.updatedAt })),
        data: rows.filter((row) => known[row.id] !== row.updatedAt),
      };
    }
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) {
      if (request.method() === "POST") layout = { ...layout, preferences: request.postDataJSON().preferences, revision: layout.revision + 1 };
      data = layout;
    }
    if (path.endsWith("/protection")) data = {
      revision: 0, canManage: true,
      settings: { enabled: false, claimsEnabled: false, autoHide: false, hiddenReaders: [], regions: [], autoHideRegions: [] },
    };
    const savedRow = rows.find((candidate) => path.endsWith(`/style-selections/${candidate.id}`));
    if (savedRow && request.method() === "PATCH") {
      const body = request.postDataJSON();
      writes.push({ id: savedRow.id, body });
      Object.assign(savedRow, body, {
        extraFields: { ...savedRow.extraFields, ...body.extraFields },
        version: savedRow.version + 1,
        updatedAt: new Date(Date.UTC(2026, 9, 11) + ++revision).toISOString(),
      });
      data = savedRow;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto(options.archive ? "/products" : `/project-tables/${tableId}`);
  if (options.waitForReady !== false) {
    await expect(cell(page, 0, "xutiStyleNo")).toHaveText(styleNo(0));
    await expect(page.locator(".selection-sheet table")).toHaveAttribute("aria-rowcount", String(Math.min(rows.length, options.pageSize || pageSize) + 1));
  }
  return { rows, writes, requests, layout: () => layout, recover: () => { rejectSync = false; } };
}

const mountedRows = (page: Page) => page.locator(".selection-sheet tbody tr[data-selection-row]");
const cell = (page: Page, index: number, column: string) => page.locator(`td[data-selection-row="${rowId(index)}"][data-selection-column="${column}"]`);
async function expectBoundedRows(page: Page) {
  await expect.poll(() => mountedRows(page).count()).toBeGreaterThan(0);
  expect(await mountedRows(page).count()).toBeLessThan(100);
}
async function copySelection(page: Page) {
  return page.locator(".selection-sheet table").evaluate((element) => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    return clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
  });
}

test("archive first open shows loading for a saved 5000-row page without redundant revision or count reads", async ({ page }) => {
  let finish!: () => void;
  const firstSync = new Promise<void>(resolve => { finish = resolve; });
  const state = await fixture(page, { archive: true, totalRows: 5105, pageSize: 5000, firstSync, waitForReady: false });
  try {
    await expect(page.getByRole("status").filter({ hasText: "正在加载表格资料" })).toBeVisible();
    await expect(page.locator(".selection-sheet")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".selection-pagination")).toContainText("加载中");
    await expect(page.locator(".selection-pagination")).not.toContainText("共 0 条");
    await expect(page.getByText(/暂无数据，点击添加一行/u)).toHaveCount(0);
    await expect(page.getByText("正在读取选款登记…", { exact: true })).toHaveCount(0);
    expect(state.requests.some(request => request.path.endsWith("/sync"))).toBe(true);
    expect(state.requests.filter(request => /\/(revision|style-counts)$/.test(request.path))).toEqual([]);
    await page.screenshot({ path: ".local/selection-open-loading-20261020.png" });
  } finally { finish(); }
  await expect(cell(page, 0, "xutiStyleNo")).toHaveText(styleNo(0));
  await expect(page.locator(".selection-sheet table")).toHaveAttribute("aria-rowcount", "5001");
  await expect(page.locator(".selection-pagination")).toContainText("共 5105 条");
  await expect(page.getByRole("status").filter({ hasText: "正在加载表格资料" })).toHaveCount(0);
  await expectBoundedRows(page);
  await page.locator(".selection-sheet").evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(cell(page, 4999, "xutiStyleNo")).toBeInViewport();
  expect(state.writes).toEqual([]);
  expect(state.requests.filter(request => request.path.endsWith("/style-counts"))).toEqual([]);
});

test("first-load failure is not presented as an empty table and can be retried", async ({ page }) => {
  const state = await fixture(page, { archive: true, failFirstSync: true, waitForReady: false });
  await expect(page.getByRole("status").filter({ hasText: "加载失败" })).toBeVisible();
  await expect(page.locator(".selection-pagination")).toContainText("尚未加载");
  await expect(page.locator(".selection-pagination")).not.toContainText("共 0 条");
  await expect(page.getByText(/暂无数据，点击添加一行/u)).toHaveCount(0);
  state.recover();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(cell(page, 0, "xutiStyleNo")).toHaveText(styleNo(0));
  await expect(page.locator(".selection-pagination")).toContainText("共 1391 条");
  await expect(page.getByRole("status").filter({ hasText: "加载失败" })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

for (const rowHeight of ["compact", "normal", "loose", "extra"] as const) {
  test(`1000 row page mounts a bounded viewport and keeps correct scroll positions (${rowHeight})`, async ({ page }) => {
    const state = await fixture(page, { rowHeight });
    await expectBoundedRows(page);
    await expect(cell(page, 999, "xutiStyleNo")).toHaveCount(0);
    const sheet = page.locator(".selection-sheet");
    await sheet.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(cell(page, 999, "xutiStyleNo")).toHaveText(styleNo(999));
    await expect(cell(page, 999, "xutiStyleNo")).toBeInViewport();
    await expect(cell(page, 999, "xutiStyleNo").locator("..")).toHaveAttribute("aria-rowindex", "1001");
    await expect(cell(page, 0, "xutiStyleNo")).toHaveCount(0);
    await expectBoundedRows(page);
    await sheet.evaluate((element) => { element.scrollTop = 0; });
    await expect(cell(page, 0, "xutiStyleNo")).toHaveText(styleNo(0));
    await expectBoundedRows(page);
    expect(state.writes).toEqual([]);
  });
}

test("whole column selection and copy include 1000 page records outside the mounted viewport", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("columnheader", { name: "选择整列：序缇款号", exact: true }).click();
  await expect(page.getByLabel("选区统计", { exact: true })).toContainText("计数=1000");
  const copied = (await copySelection(page)).split("\n");
  expect(copied).toHaveLength(pageSize);
  expect(copied[0]).toBe(styleNo(0));
  expect(copied.at(-1)).toBe(styleNo(999));
  expect(copied).not.toContain(styleNo(1000));
  await page.locator(".selection-sheet").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(cell(page, 999, "xutiStyleNo")).toHaveClass(/selection-cell-active/);
  await expectBoundedRows(page);
  expect(state.writes).toEqual([]);
});

test("5000 row option persists, keeps rendering and images bounded, and includes every offscreen row in copy", async ({ page }) => {
  const state = await fixture(page, { totalRows: 5105 });
  await page.locator(".selection-pagination .ant-select").click();
  await page.locator(".ant-select-dropdown:visible").getByText("5000 条/页", { exact: true }).click();
  await expect(page.locator(".selection-sheet table")).toHaveAttribute("aria-rowcount", "5001");
  await expectBoundedRows(page);
  await expect.poll(() => state.layout().preferences!.pageSize).toBe(5000);
  const imagesRequested = () => new Set(state.requests.filter(request => request.path.includes("/style-selections/images/")).map(request => request.path)).size;
  expect(imagesRequested()).toBeLessThan(40);
  await page.getByRole("columnheader", { name: "选择整列：序缇款号", exact: true }).click();
  await expect(page.getByLabel("选区统计", { exact: true })).toContainText("计数=5000");
  const copied = (await copySelection(page)).split("\n");
  expect(copied).toHaveLength(5000);
  expect(copied[0]).toBe(styleNo(0));
  expect(copied.at(-1)).toBe(styleNo(4999));
  expect(copied).not.toContain(styleNo(5000));
  await page.locator(".selection-sheet").evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(cell(page, 4999, "xutiStyleNo")).toHaveText(styleNo(4999));
  await expect(cell(page, 4999, "xutiStyleNo")).toBeInViewport();
  await expectBoundedRows(page);
  expect(imagesRequested()).toBeLessThan(50);
  await page.locator(".selection-pagination .ant-pagination-item-2").click();
  await expect(page.locator(".selection-sheet table")).toHaveAttribute("aria-rowcount", "106");
  await expect(cell(page, 5104, "xutiStyleNo")).toHaveText(styleNo(5104));
  await expect.poll(() => state.layout().preferences!.page).toBe(2);
  await page.reload();
  await expect(page.locator(".selection-sheet table")).toHaveAttribute("aria-rowcount", "106");
  await expect(page.locator(".selection-pagination")).toContainText("5000 条/页");
  expect(state.writes).toEqual([]);
});

test("find mounts and reveals unmounted results within a grouped page and across pages", async ({ page }) => {
  const state = await fixture(page, { grouped: true });
  await expectBoundedRows(page);
  await expect(cell(page, 999, "xutiStyleNo")).toHaveCount(0);
  await page.getByRole("button", { name: /查找\/替换/ }).click();
  const find = page.getByRole("dialog", { name: "查找/替换", exact: true });
  await find.getByRole("textbox", { name: "查找内容", exact: true }).fill(styleNo(999));
  await find.getByRole("button", { name: "查找全部", exact: true }).click();
  await expect(cell(page, 999, "xutiStyleNo")).toBeVisible();
  await expect(cell(page, 999, "xutiStyleNo")).toBeInViewport();
  await expect(cell(page, 999, "xutiStyleNo")).toHaveClass(/selection-cell-active/);
  await expectBoundedRows(page);
  await find.getByRole("textbox", { name: "查找内容", exact: true }).fill(styleNo(1390));
  await find.getByRole("button", { name: "查找全部", exact: true }).click();
  await expect(cell(page, 1390, "xutiStyleNo")).toBeVisible();
  await expect(cell(page, 1390, "xutiStyleNo")).toBeInViewport();
  await expect(cell(page, 1390, "xutiStyleNo")).toHaveClass(/selection-cell-active/);
  await expect(page.locator(".selection-sheet table")).toHaveAttribute("aria-rowcount", "392");
  await expectBoundedRows(page);
  expect(state.writes).toEqual([]);
});

test("typing and autosave keep the editor focused and unrelated visible row DOM stable", async ({ page }) => {
  const state = await fixture(page);
  await cell(page, 0, "material").click();
  const editor = page.getByRole("group", { name: "单元格编辑栏", exact: true }).getByRole("textbox", { name: "材质", exact: true });
  await editor.fill("");
  await page.evaluate((id) => {
    const target = document.querySelector<HTMLElement>(`tr[data-selection-row="${id}"]`)!;
    const tracked = window as typeof window & { perfNeighbor?: Element; perfMutations?: number; perfObserver?: MutationObserver; perfDetails?: unknown[] };
    tracked.perfNeighbor = target;
    tracked.perfMutations = 0; tracked.perfDetails = [];
    tracked.perfObserver = new MutationObserver((mutations) => {
      // React restores input name/type attributes during controlled input work.
      // Count changes to visible content, values and presentation instead.
      const visible = mutations.filter(item => item.type !== "attributes" || !["name", "type"].includes(item.attributeName || ""));
      tracked.perfMutations! += visible.length;
      tracked.perfDetails!.push(...visible.map(item => ({ type: item.type, attribute: item.attributeName, tag: (item.target as Element).tagName })));
    });
    tracked.perfObserver.observe(target, { attributes: true, childList: true, characterData: true, subtree: true });
  }, rowId(5));
  await editor.pressSequentially("已核对：棉95% 氨纶5%", { delay: 20 });
  await expect(editor).toBeFocused();
  await expect.poll(() => state.rows[0].material).toBe("已核对：棉95% 氨纶5%");
  await expect(editor).toBeFocused();
  await expect(cell(page, 0, "material")).toContainText("已核对：棉95% 氨纶5%");
  const untouched = await page.evaluate((id) => {
    const tracked = window as typeof window & { perfNeighbor?: Element; perfMutations?: number; perfObserver?: MutationObserver; perfDetails?: unknown[] };
    const unchanged = tracked.perfNeighbor === document.querySelector(`tr[data-selection-row="${id}"]`);
    const mutations = tracked.perfMutations;
    tracked.perfObserver?.disconnect();
    return { unchanged, mutations, details: tracked.perfDetails };
  }, rowId(5));
  expect(untouched.mutations, JSON.stringify(untouched)).toBe(0);
  expect(untouched.unchanged).toBe(true);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].id).toBe(rowId(0));
  expect(state.requests.filter((request) => request.path.includes("/style-selections") && request.method === "PATCH").every((request) => request.table === tableId)).toBe(true);
  await page.locator(".selection-sheet").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(cell(page, 999, "xutiStyleNo")).toHaveText(styleNo(999));
  // The editor's source row remains mounted when it leaves the scroll viewport.
  await expect(cell(page, 0, "material")).toHaveCount(1);
  await expect(editor).toBeFocused();
  await editor.pressSequentially("；滚动后继续核对", { delay: 20 });
  await expect.poll(() => state.rows[0].material).toBe("已核对：棉95% 氨纶5%；滚动后继续核对");
  await expect(editor).toBeFocused();
  expect(state.writes).toHaveLength(2);
  await expectBoundedRows(page);
});

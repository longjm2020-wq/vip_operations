import { expect, test, type Page } from "@playwright/test";
import { projectSelectionSharedLayout, selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

const columns = [
  { key: "registrationBatch", label: "创建时间", width: 180, type: "createdTime" },
  { key: "xutiStyleNo", label: "序缇款号", width: 140, type: "text" },
  { key: "supplierCode", label: "供应商编码", width: 140, type: "text" },
];
const calendarRows = [
  "2026-06-30T16:00:01Z", // Beijing July 1, Q3.
  "2025-12-31T16:00:00Z", // Beijing January 1, Q1.
  "2026-03-31T16:00:00Z", // Beijing April 1, Q2.
  "2026-06-30T15:59:59Z", // Beijing June 30, Q2.
  "2026-06-30T16:10:22Z", // Same Beijing day as row 1, different seconds.
  "2025-12-31T15:59:59Z", // Beijing December 31 in the prior year.
].map((createdAt, index) => ({
  id: String(index + 1), xutiStyleNo: `CALENDAR-${index + 1}`, createdAt,
  // Legacy batch and manual order intentionally disagree with creation time.
  registrationBatch: index % 2 ? "2040-01-01" : "1999-12-31",
  sortOrder: index + 1, supplierCode: "SUPPLIER", images: [], labelImages: [], extraFields: {},
  updatedAt: "2026-10-11T00:00:00Z", cellAccess: {} as Record<string, string>,
  hiddenCells: [] as string[], defaultCellAccess: "edit",
}));

async function fixture(page: Page, entry: string, options: {
  preferences?: Record<string, unknown>;
  rows?: typeof calendarRows;
} = {}) {
  await page.addInitScript(() => {
    // Keep navigation teardown/presence outside these assertions from reaching
    // a real API when the test page closes.
    let leaving = false;
    window.addEventListener("pagehide", () => { leaving = true; });
    const request = window.fetch.bind(window);
    window.fetch = (input, init) => (leaving || init?.keepalive) && String(input).includes("/api/v1/")
      ? Promise.resolve(new Response('{"data":null}', { headers: { "Content-Type": "application/json" } }))
      : request(input, init);
  });
  // Omit sort/direction in the default fixture: the real snapshot contract must
  // supply the new default, rather than a fixture hard-coding it for the UI.
  let preferences = { columns, rowHeight: "compact", pageSize: 20, ...options.preferences };
  let sharedPreferences = projectSelectionSharedLayout(selectionLayoutSchema.parse(preferences));
  let revision = 1;
  const rows = structuredClone(options.rows || calendarRows);
  const syncRequests: { sort: string; direction: string }[] = [];
  const writes: Record<string, unknown>[] = [];
  const rowWrites: Record<string, unknown>[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = {
      id: "101", displayName: "创建时间分组测试", csrfToken: "fixture", roleCodes: [],
      permissions: ["selection.read", "selection.manage", "product.read", "product.manage", "project.read", "project.create"],
    };
    if (path.endsWith("/product-archive-table")) data = { id: "3", initialLayout: "selection", fields: columns, references: {}, canEdit: true, canManage: true };
    if (path.endsWith("/project-tables/7")) data = { id: "7", name: "创建时间分组协作表", initialLayout: "selection", canEdit: true, canManage: true };
    if (path.endsWith("/revision")) data = { revision: "calendar-rows" };
    if (path.endsWith("/sync")) {
      const body = request.postDataJSON();
      syncRequests.push({ sort: body.sort, direction: body.direction });
      const ordered = [...rows].sort((left, right) => {
        // registrationBatch is the API's creation-time alias. Deliberately
        // honor the request: a UI incorrectly requesting manual order fails.
        const result = ["registrationBatch", "createdAt"].includes(body.sort)
          ? Date.parse(left.createdAt) - Date.parse(right.createdAt)
          : left.sortOrder - right.sortOrder;
        return (body.direction === "desc" ? -1 : 1) * result;
      });
      data = { revision: "calendar-rows", index: ordered.map(row => ({ id: row.id, token: row.updatedAt })), data: ordered };
    }
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        writes.push(body);
        preferences = body.preferences;
        if (body.sharedChanges) sharedPreferences = { ...sharedPreferences, ...body.sharedChanges };
        revision++;
      }
      data = { preferences, revision, sharedPreferences, sharedRevision: revision, canEditShared: true };
    }
    const row = rows.find(item => path.endsWith(`/style-selections/${item.id}`));
    if (row && request.method() === "PATCH") {
      const body = request.postDataJSON();
      rowWrites.push(body);
      Object.assign(row, body, { updatedAt: `2026-10-11T00:00:${String(rowWrites.length).padStart(2, "0")}Z` });
      data = row;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto(entry);
  await expect(page.locator("tr[data-selection-row]").first()).toBeVisible();
  return { syncRequests, writes, rowWrites, rows, saved: () => selectionLayoutSchema.parse(preferences) };
}

async function choose(page: Page, control: "分组方式" | "排序方式", option: string) {
  await page.getByRole("combobox", { name: control, exact: true }).click();
  await page.locator(".ant-select-dropdown:visible").getByText(option, { exact: true }).click();
}
const rowIds = (page: Page) => page.locator("tr[data-selection-row]").evaluateAll(elements => elements.map(element => element.getAttribute("data-selection-row")));
const groupHeaders = (page: Page) => page.locator(".selection-group-row td").evaluateAll(elements => elements.map(element => ({
  label: element.childNodes[0]?.textContent || "", count: element.querySelector("span")?.textContent || "",
})));

for (const [label, entry] of [["选款登记", "/style-selections"], ["商品档案", "/products"], ["项目协作表格", "/project-tables/7"]]) {
  test(`${label}：无旧排序设置时真实请求创建时间升序，忽略登记批次并可切换降序`, async ({ page }) => {
    const state = await fixture(page, entry);
    await expect(page.locator(".selection-tool-select").filter({ has: page.getByRole("combobox", { name: "排序方式", exact: true }) })).toContainText("创建时间 ↑");
    await expect.poll(() => state.syncRequests[0]).toEqual({ sort: "registrationBatch", direction: "asc" });
    await expect.poll(() => rowIds(page)).toEqual(["6", "2", "3", "4", "1", "5"]);
    await choose(page, "排序方式", "创建时间 ↓");
    await expect.poll(() => state.syncRequests.at(-1)).toEqual({ sort: "registrationBatch", direction: "desc" });
    await expect.poll(() => rowIds(page)).toEqual(["5", "1", "4", "3", "2", "6"]);
    await expect.poll(() => state.saved().direction).toBe("desc");
    await page.reload();
    await expect.poll(() => rowIds(page)).toEqual(["5", "1", "4", "3", "2", "6"]);
    expect(state.saved().sort).toBe("registrationBatch");
  });
}

test("创建时间按北京时间年、自然季度、月、日聚合，同日不同秒合并且日期显示格式不改变分组", async ({ page }) => {
  const state = await fixture(page, "/products", {
    preferences: { columns: columns.map(column => column.key === "registrationBatch" ? { ...column, timeDisplay: "date" } : column) },
  });
  for (const [option, expected] of [
    ["按创建时间（年）分组", [["2025年", "1 条"], ["2026年", "5 条"]]],
    ["按创建时间（季度）分组", [["2025年第4季度", "1 条"], ["2026年第1季度", "1 条"], ["2026年第2季度", "2 条"], ["2026年第3季度", "2 条"]]],
    ["按创建时间（月）分组", [["2025-12", "1 条"], ["2026-01", "1 条"], ["2026-04", "1 条"], ["2026-06", "1 条"], ["2026-07", "2 条"]]],
    ["按创建时间（日）分组", [["2025-12-31", "1 条"], ["2026-01-01", "1 条"], ["2026-04-01", "1 条"], ["2026-06-30", "1 条"], ["2026-07-01", "2 条"]]],
  ] as const) {
    await choose(page, "分组方式", option);
    await expect.poll(() => groupHeaders(page)).toEqual(expected.map(([label, count]) => ({ label, count })));
  }
  await expect.poll(() => state.saved().groupBy).toBe("createdTime:day");
  await page.reload();
  await expect.poll(() => groupHeaders(page)).toEqual([
    { label: "2025-12-31", count: "1 条" }, { label: "2026-01-01", count: "1 条" },
    { label: "2026-04-01", count: "1 条" }, { label: "2026-06-30", count: "1 条" },
    { label: "2026-07-01", count: "2 条" },
  ]);
  await page.locator('td[data-selection-row="5"][data-selection-column="registrationBatch"]').locator("input,textarea").fill("2027-01-02");
  await expect.poll(() => state.rows.find(row => row.id === "5")?.createdAt).toBe("2027-01-01T16:00:00.000Z");
  expect(state.rowWrites).toHaveLength(1);
  expect(state.rowWrites[0]).not.toHaveProperty("registrationBatch");
  await choose(page, "分组方式", "按创建时间（年）分组");
  await expect.poll(() => groupHeaders(page)).toEqual([
    { label: "2025年", count: "1 条" }, { label: "2026年", count: "4 条" }, { label: "2027年", count: "1 条" },
  ]);
  await choose(page, "分组方式", "按创建时间（日）分组");
  await expect.poll(() => groupHeaders(page)).toEqual([
    { label: "2025-12-31", count: "1 条" }, { label: "2026-01-01", count: "1 条" },
    { label: "2026-04-01", count: "1 条" }, { label: "2026-06-30", count: "1 条" },
    { label: "2026-07-01", count: "1 条" }, { label: "2027-01-02", count: "1 条" },
  ]);
});

test("旧批次分组升级为创建时间日分组，受保护创建时间不泄漏日期或年份", async ({ page }) => {
  const rows = [...calendarRows, {
    ...calendarRows[0], id: "7", xutiStyleNo: "PROTECTED-TIME", sortOrder: 7,
    createdAt: "2201-09-23T01:02:03Z", registrationBatch: "SECRET-BATCH",
    cellAccess: { registrationBatch: "deny" }, hiddenCells: ["registrationBatch"],
  }];
  await fixture(page, "/style-selections", { preferences: { groupBy: "batch" }, rows });
  await expect.poll(() => groupHeaders(page)).toEqual([
    { label: "2025-12-31", count: "1 条" }, { label: "2026-01-01", count: "1 条" },
    { label: "2026-04-01", count: "1 条" }, { label: "2026-06-30", count: "1 条" },
    { label: "2026-07-01", count: "2 条" }, { label: "受保护内容", count: "1 条" },
  ]);
  await expect(page.locator('td[data-selection-row="7"][data-selection-column="registrationBatch"]')).not.toContainText("2201");
  for (const option of ["按创建时间（年）分组", "按创建时间（季度）分组", "按创建时间（月）分组"]) {
    await choose(page, "分组方式", option);
    await expect(page.locator(".selection-group-row").last()).toContainText("受保护内容");
    await expect(page.locator(".selection-sheet")).not.toContainText("2201");
    await expect(page.locator(".selection-sheet")).not.toContainText("SECRET-BATCH");
  }
});

test("已保存手动排序保留，分组和排序切换重置到第一页且刷新保存个人偏好", async ({ page }) => {
  const rows = Array.from({ length: 60 }, (_, index) => ({
    ...calendarRows[0], id: String(index + 1), xutiStyleNo: `PAGE-${index + 1}`,
    sortOrder: index + 1, createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }));
  const state = await fixture(page, "/project-tables/7", { rows, preferences: { sort: "sortOrder", direction: "asc", page: 2 } });
  await expect(page.locator(".selection-pagination .ant-pagination-item-active")).toHaveAttribute("title", "2");
  await expect.poll(() => state.syncRequests[0]).toEqual({ sort: "sortOrder", direction: "asc" });
  await expect(page.locator("tr[data-selection-row]").first()).toHaveAttribute("data-selection-row", "21");
  await page.reload();
  await expect(page.locator(".selection-pagination .ant-pagination-item-active")).toHaveAttribute("title", "2");
  await choose(page, "分组方式", "按创建时间（年）分组");
  await expect(page.locator(".selection-pagination .ant-pagination-item-active")).toHaveAttribute("title", "1");
  await expect(page.locator("tr[data-selection-row]").first()).toHaveAttribute("data-selection-row", "1");
  await expect.poll(() => state.saved().groupBy).toBe("createdTime:year");
  expect(state.saved().sort).toBe("sortOrder");
  await page.locator('.selection-pagination .ant-pagination-item[title="2"]').click();
  await expect(page.locator("tr[data-selection-row]").first()).toHaveAttribute("data-selection-row", "21");
  await choose(page, "排序方式", "创建时间 ↓");
  await expect(page.locator(".selection-pagination .ant-pagination-item-active")).toHaveAttribute("title", "1");
  await expect(page.locator("tr[data-selection-row]").first()).toHaveAttribute("data-selection-row", "60");
  await expect.poll(() => [state.saved().page, state.saved().sort, state.saved().direction]).toEqual([1, "registrationBatch", "desc"]);
  await page.reload();
  await expect(page.locator("tr[data-selection-row]").first()).toHaveAttribute("data-selection-row", "60");
  await expect.poll(() => groupHeaders(page)).toEqual([{ label: "2026年", count: "20 条" }]);
  await expect(page.locator(".selection-pagination")).toContainText("共 60 条");
});

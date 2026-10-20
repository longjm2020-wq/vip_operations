import { expect, test, type Page } from "@playwright/test";
import { selectionLayoutSchema, projectSelectionSharedLayout } from "../../packages/contracts/src/selection-layout.js";

type Row = Record<string, any>;
async function fixture(page: Page, path = "/products", permissions = ["product.read", "product.update"]) {
  await page.addInitScript(() => {
    const request = window.fetch.bind(window);
    window.fetch = (input, init) => init?.keepalive && String(input).includes("/api/v1/")
      ? Promise.resolve(new Response('{"data":null}', { headers: { "Content-Type": "application/json" } }))
      : request(input, init);
  });
  let preferences = selectionLayoutSchema.parse({ columns: [
    { key: "xutiStyleNo", label: "序缇款号", type: "text" },
    { key: "material", label: "成分", type: "text" },
  ] });
  let layoutRevision = 1;
  const rows = [{ id: "1", xutiStyleNo: "TOOL-001", material: "面料：100%桑蚕丝", images: [], labelImages: [], extraFields: {}, updatedAt: "2026-10-20T00:00:00Z" }];
  const mappings: Record<string, Row[]> = {
    "color-mappings": [{ id: "11", code: "001", name: "黑色", status: "ACTIVE" }],
    "size-mappings": [{ id: "21", code: "004", name: "L", status: "ACTIVE" }],
  };
  const mappingRequests: { resource: string; method: string; query: string | null; tableId: string | null }[] = [];
  const gridWrites: Row[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
    const match = /\/(color-mappings|size-mappings)(?:\/(\d+))?$/.exec(pathname);
    let data: unknown = [], total: number | undefined;
    if (pathname.endsWith("/auth/me")) data = { id: "101", displayName: "工具箱测试", roleCodes: [], csrfToken: "fixture", permissions: ["selection.read", "selection.manage", "project.read", "project.create", ...permissions] };
    if (pathname.endsWith("/product-archive-table")) data = { id: "3", initialLayout: "selection", fields: [], references: {}, canEdit: true, canManage: true };
    if (pathname.endsWith("/project-tables/7")) data = { id: "7", name: "工具箱协作表", initialLayout: "selection", canEdit: true, canManage: true };
    if (pathname.endsWith("/revision")) data = { revision: "1" };
    if (pathname.endsWith("/sync")) data = { revision: "1", index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows };
    if (pathname.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (pathname.endsWith("/layout-preferences")) {
      if (request.method() === "POST") { preferences = selectionLayoutSchema.parse(request.postDataJSON().preferences); layoutRevision++; }
      data = { preferences, revision: layoutRevision, sharedPreferences: projectSelectionSharedLayout(preferences), sharedRevision: layoutRevision, canEditShared: true };
    }
    if (/\/style-selections(?:\/\d+|\/bulk)$/.test(pathname) && request.method() !== "GET") gridWrites.push(request.postDataJSON());
    if (match) {
      const [, resource, id] = match, method = request.method(), query = url.searchParams.get("q");
      mappingRequests.push({ resource, method, query, tableId: url.searchParams.get("tableId") });
      if (method === "POST") mappings[resource].push({ ...request.postDataJSON(), id: "99" });
      if (method === "PATCH") Object.assign(mappings[resource].find(row => row.id === id)!, request.postDataJSON());
      if (method === "DELETE") mappings[resource] = mappings[resource].filter(row => row.id !== id);
      data = method === "GET" ? mappings[resource].filter(row => !query || `${row.code} ${row.name}`.includes(query)) : { id: id || "99" };
      total = Array.isArray(data) ? data.length : undefined;
    }
    await route.fulfill({ json: { data, ...(total === undefined ? {} : { total }) } });
  });
  await page.goto(path);
  if (!path.includes("mappings")) await expect(page.locator("tr[data-selection-row]")).toHaveCount(1);
  return { mappings, mappingRequests, gridWrites };
}

for (const [label, path] of [["商品档案", "/products"], ["选款登记", "/style-selections"], ["项目协作表格", "/project-tables/7"]]) {
  test(`${label}工具箱复用共用映射，保存刷新且搜索不改变表格`, async ({ page }) => {
    const state = await fixture(page, path);
    const search = page.getByRole("textbox", { name: "搜索选款", exact: true });
    await search.fill("TOOL-001");
    const cell = page.locator('td[data-selection-row="1"][data-selection-column="material"]');
    await cell.click();
    const selectedClass = await cell.getAttribute("class");
    await page.getByRole("button", { name: "工具箱", exact: true }).click();
    const toolbox = page.getByRole("dialog", { name: "工具箱", exact: true });
    await expect(toolbox.getByRole("cell", { name: "黑色", exact: true })).toBeVisible();
    await expect(page.locator(".topbar .page-search-control")).toHaveCount(1);
    await toolbox.getByRole("textbox", { name: "搜索编码或名称", exact: true }).fill("黑色");
    await toolbox.getByRole("textbox", { name: "搜索编码或名称", exact: true }).press("Enter");
    await expect.poll(() => state.mappingRequests.some(request => request.query === "黑色")).toBe(true);
    await expect(search).toHaveValue("TOOL-001");
    await expect(page).toHaveURL(new RegExp(`${path.replaceAll("/", "\\/")}$`));

    await toolbox.getByRole("button", { name: "编辑", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "编辑资料", exact: true });
    await editor.getByLabel("参考颜色名称", { exact: true }).fill("黑色（修订）");
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect(editor).not.toBeVisible();
    await expect(toolbox.getByRole("cell", { name: "黑色（修订）", exact: true })).toBeVisible();
    await toolbox.getByRole("tab", { name: "尺码映射", exact: true }).click();
    await expect(toolbox.getByRole("cell", { name: "L", exact: true })).toBeVisible();
    await expect(toolbox.getByRole("textbox", { name: "搜索编码或名称", exact: true })).toHaveValue("");
    await toolbox.getByRole("button", { name: /新建资料$/ }).click();
    const add = page.getByRole("dialog", { name: "新建资料", exact: true });
    await add.getByLabel("尺码代码（3 位）", { exact: true }).fill("006");
    await add.getByLabel("尺码名称", { exact: true }).fill("2XL");
    await add.getByRole("button", { name: "保存", exact: true }).click();
    await expect(add).not.toBeVisible();
    const size = toolbox.getByRole("row").filter({ hasText: "2XL" });
    await expect(size).toBeVisible();
    await size.getByRole("button", { name: "删除", exact: true }).click();
    await page.getByRole("button", { name: "确定", exact: true }).click();
    await expect(size).toHaveCount(0);
    await toolbox.getByRole("button", { name: "表格编辑 / Excel 导入", exact: true }).click();
    const batch = page.getByRole("dialog", { name: "尺码映射 · 表格编辑", exact: true });
    await expect(batch).toBeVisible();
    await batch.getByRole("button", { name: "关闭", exact: true }).click();
    await toolbox.getByRole("tab", { name: "颜色映射", exact: true }).click();
    await expect(toolbox.getByRole("cell", { name: "黑色（修订）", exact: true })).toBeVisible();
    if (label === "商品档案") await toolbox.screenshot({ path: test.info().outputPath("toolbox-mappings.png") });
    await toolbox.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(toolbox).not.toBeVisible();
    await expect(search).toHaveValue("TOOL-001");
    await expect(cell).toHaveAttribute("class", selectedClass!);
    expect(state.gridWrites).toEqual([]);
    expect(state.mappingRequests.every(request => request.tableId === null)).toBe(true);
    await expect(page.locator(".ant-layout-sider a[href='/color-size-mappings']")).toHaveCount(0);
  });
}

test("表格编辑者仅有商品查看权限时可查看映射但不能维护", async ({ page }) => {
  const state = await fixture(page, "/project-tables/7", ["product.read"]);
  await page.getByRole("button", { name: "工具箱", exact: true }).click();
  const toolbox = page.getByRole("dialog", { name: "工具箱", exact: true });
  for (const tab of ["颜色映射", "尺码映射"]) {
    await toolbox.getByRole("tab", { name: tab, exact: true }).click();
    await expect(toolbox.getByRole("table")).toBeVisible();
    await expect(toolbox.getByRole("button", { name: /(?:编辑|删除|新建资料|表格编辑 \/ Excel 导入)$/ })).toHaveCount(0);
  }
  expect(state.mappingRequests.every(request => request.method === "GET")).toBe(true);
});

test("无商品查看权限不显示入口，旧网址也不读取映射", async ({ page }) => {
  const state = await fixture(page, "/style-selections", []);
  await expect(page.getByRole("button", { name: "工具箱", exact: true })).toHaveCount(0);
  expect(state.mappingRequests).toEqual([]);
  await page.goto("/color-size-mappings");
  await expect(page.getByRole("alert")).toContainText("需要商品查看权限");
  expect(state.mappingRequests).toEqual([]);
});

test("旧尺码映射收藏网址继续可用，搜索在映射区域内", async ({ page }) => {
  const state = await fixture(page, "/size-mappings");
  await expect(page).toHaveURL(/\/color-size-mappings\?tab=size$/);
  await expect(page.getByRole("tab", { name: "尺码映射", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("cell", { name: "L", exact: true })).toBeVisible();
  await expect(page.locator(".topbar .page-search-control")).toHaveCount(0);
  await expect(page.locator(".color-size-mappings").getByRole("textbox", { name: "搜索编码或名称", exact: true })).toBeVisible();
  expect(state.mappingRequests.every(request => request.method === "GET")).toBe(true);
});

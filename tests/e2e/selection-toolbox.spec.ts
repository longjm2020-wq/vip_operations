import { expect, test, type Page } from "@playwright/test";
import Excel from "exceljs";
import { readFile } from "node:fs/promises";
import { read as readXls, utils as xlsUtils } from "xlsx";
import { selectionLayoutSchema, projectSelectionSharedLayout } from "../../packages/contracts/src/selection-layout.js";

type Row = Record<string, any>;
test("表格复制编号保留选区和只读规则，禁止查看内容不能复制", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).copiedCodes = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { (window as any).copiedCodes.push(text); } } });
  });
  const state = await fixture(page, "/products", ["product.read"]);
  const material = page.locator('td[data-selection-column="material"][data-selection-row="1"]');
  const style = page.locator('td[data-selection-column="xutiStyleNo"][data-selection-row="1"]');
  await material.click();
  await style.hover();
  await style.getByRole("button", { name: "复制序缇款号 TOOL-001", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).copiedCodes)).toEqual(["TOOL-001"]);
  await expect(material).toHaveClass(/selection-cell-active/);
  await expect(style).not.toHaveClass(/selection-cell-active/);
  expect(state.gridWrites).toEqual([]);
  state.rows[0].cellAccess = { xutiStyleNo: "deny" };
  await page.reload();
  await expect(style.getByLabel("受保护内容")).toBeVisible();
  await expect(style.getByRole("button", { name: /复制/ })).toHaveCount(0);
});

test("建档预览复制完整条形码，不触发原表键盘编辑", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).copiedCodes = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { (window as any).copiedCodes.push(text); } } });
  });
  const state = await fixture(page, "/products", ["product.read"], true);
  await page.locator('td[data-selection-row="1"][data-selection-column="xutiStyleNo"]').click();
  const tool = await openTool(page, "唯品会商品建档");
  await tool.getByRole("button", { name: "生成建档资料", exact: true }).click();
  const copy = tool.getByRole("button", { name: "复制条形码 TOOL-001019002", exact: true });
  await copy.focus();
  await copy.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).copiedCodes)).toEqual(["TOOL-001019002"]);
  await expect(tool.getByRole("status")).toContainText("已生成 1 款、6 条商品资料");
  expect(state.gridWrites).toEqual([]);
});

async function fixture(page: Page, path = "/products", permissions = ["product.read", "product.update"], jushuitan = false) {
  await page.addInitScript(() => {
    const request = window.fetch.bind(window);
    window.fetch = (input, init) => init?.keepalive && String(input).includes("/api/v1/")
      ? Promise.resolve(new Response('{"data":null}', { headers: { "Content-Type": "application/json" } }))
      : request(input, init);
  });
  let preferences = selectionLayoutSchema.parse({ columns: [
    { key: "xutiStyleNo", label: "序缇款号", type: "text" },
    { key: "material", label: "成分", type: "text" },
    ...(jushuitan ? [
      { key: "custom:standardColor", label: "标准颜色", type: "tags", custom: true },
      { key: "color", label: "供应商颜色", type: "tags" },
      { key: "sizeRange", label: "尺码范围", type: "tags" },
      { key: "custom:category", label: "三级类目", type: "text", custom: true },
      { key: "custom:long", label: "长标题", type: "text", custom: true },
      { key: "custom:short", label: "短标题", type: "text", custom: true },
      { key: "supplierStyleNo", label: "供应商款号", type: "text" },
      { key: "supplierCode", label: "供应商名称", type: "text" },
      { key: "supplyPriceExclTax", label: "供货价（不含税）", type: "currency" },
      { key: "vipPrice", label: "唯品价", type: "currency" },
      { key: "tagPrice", label: "吊牌价", type: "currency" },
      { key: "custom:safety", label: "安全类别", type: "text", custom: true },
      { key: "custom:standard", label: "执行标准", type: "text", custom: true },
    ] : []),
  ] });
  let layoutRevision = 1;
  const rows: Row[] = [{ id: "1", xutiStyleNo: "TOOL-001", material: "面料：100%桑蚕丝", images: [], labelImages: [], extraFields: {}, updatedAt: "2026-10-20T00:00:00Z" }];
  const mappings: Record<string, Row[]> = {
    "color-mappings": [{ id: "11", code: "001", name: "黑色", status: "ACTIVE" }],
    "size-mappings": [{ id: "21", code: "004", name: "L", status: "ACTIVE" }],
  };
  if (jushuitan) {
    Object.assign(rows[0], { color: "蓝紫/咖粉", sizeRange: "S/M/L", supplierStyleNo: "SUP-001", supplierCode: "S22",
      supplyPriceExclTax: "490", vipPrice: "1080", tagPrice: "4410",
      extraFields: { "custom:standardColor": "蓝色/咖色", "custom:category": "半截裙", "custom:long": "建档长标题",
        "custom:short": "建档短标题", "custom:safety": "C类", "custom:standard": "执行标准示例" } });
    rows.push({ ...structuredClone(rows[0]), id: "2", xutiStyleNo: "UNSELECTED-002" });
    mappings["color-mappings"] = [{ id: "11", code: "019", name: "蓝色", status: "ACTIVE" }, { id: "12", code: "009", name: "咖色", status: "ACTIVE" }];
    mappings["size-mappings"] = ["S", "M", "L"].map((name, index) => ({ id: String(index + 21), code: String(index + 2).padStart(3, "0"), name, status: "ACTIVE" }));
  }
  const detailRequests: string[] = [];
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
    const detailId = /\/style-selections\/(\d+)$/.exec(pathname)?.[1];
    if (detailId && request.method() === "GET") { data = rows.find(row => row.id === detailId); detailRequests.push(detailId); }
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
  if (!path.includes("mappings")) await expect(page.locator("tr[data-selection-row]")).toHaveCount(rows.length);
  return { mappings, mappingRequests, gridWrites, rows, detailRequests };
}

async function openTool(page: Page, name: string) {
  const entry = page.getByRole("button", { name: "工具箱", exact: true });
  await expect(entry).toHaveText("工具箱");
  await entry.click();
  const menu = page.getByRole("dialog", { name: "工具箱", exact: true });
  await expect(menu.getByRole("table")).toHaveCount(0);
  await menu.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  return page.getByRole("dialog", { name, exact: true });
}

for (const [label, path] of [["商品档案", "/products"], ["选款登记", "/style-selections"], ["项目协作表格", "/project-tables/7"]]) {
  test(`${label}工具箱复用共用映射，保存刷新且搜索不改变表格`, async ({ page }) => {
    const state = await fixture(page, path);
    const search = page.getByRole("textbox", { name: "搜索选款", exact: true });
    await search.fill("TOOL-001");
    const cell = page.locator('td[data-selection-row="1"][data-selection-column="material"]');
    await cell.click();
    const selectedClass = await cell.getAttribute("class");
    const toolbox = await openTool(page, "颜色尺码映射");
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
    const menu = page.getByRole("dialog", { name: "工具箱", exact: true });
    await expect(menu.getByRole("button", { name: /^聚水潭商品建档/ })).toBeVisible();
    await expect(menu.getByRole("button", { name: /^唯品会商品建档/ })).toBeVisible();
    await menu.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(search).toHaveValue("TOOL-001");
    await expect(cell).toHaveAttribute("class", selectedClass!);
    expect(state.gridWrites).toEqual([]);
    expect(state.mappingRequests.every(request => request.tableId === null)).toBe(true);
    await expect(page.locator(".ant-layout-sider a[href='/color-size-mappings']")).toHaveCount(0);
  });
}

test("表格编辑者仅有商品查看权限时可查看映射但不能维护", async ({ page }) => {
  const state = await fixture(page, "/project-tables/7", ["product.read"]);
  const toolbox = await openTool(page, "颜色尺码映射");
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

test("聚水潭建档只展开选中款式，预览并下载真实模板格式文件", async ({ page }) => {
  const state = await fixture(page, "/products", ["product.read"], true);
  await page.locator('td[data-selection-row="1"][data-selection-column="xutiStyleNo"]').click();
  const tool = await openTool(page, "聚水潭商品建档");
  await expect(tool.getByText("已选 1 款", { exact: true })).toBeVisible();
  await tool.getByRole("button", { name: "生成建档资料", exact: true }).click();
  await expect(tool.getByText("已生成 1 款、6 条商品资料", { exact: true })).toBeVisible();
  await expect(tool.locator(".copyable-code-value").filter({ hasText: /^TOOL-001019002$/ })).toBeVisible();
  await tool.screenshot({ path: test.info().outputPath("jushuitan-preview.png") });
  const downloadPromise = page.waitForEvent("download");
  await tool.getByRole("button", { name: "下载 Excel", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^聚水潭商品建档_.*\.xlsx$/);
  const book = new Excel.Workbook();
  await book.xlsx.readFile((await download.path())!);
  const sheet = book.getWorksheet("商品资料")!;
  expect(sheet.rowCount).toBe(7);
  expect(sheet.columnCount).toBe(38);
  expect(sheet.getCell("B2").text).toBe("TOOL-001019002");
  expect(sheet.getCell("B7").text).toBe("TOOL-001009004");
  expect(sheet.getCell("AG2").value).toBe(588);
  expect(sheet.getCell("AH2").text).toBe("155/64A(S)");
  expect(sheet.getCell("AI5").text).toBe("咖粉");
  expect(sheet.getCell("K2").text).toBe("S22");
  expect(sheet.getCell("Y2").text).toBe("S22");
  expect(state.detailRequests.every(id => id === "1")).toBe(true);
  expect(state.mappingRequests.every(request => request.method === "GET" && !request.tableId)).toBe(true);
  expect(state.gridWrites).toEqual([]);
});

test("没有选中款式不会处理全表", async ({ page }) => {
  const state = await fixture(page, "/style-selections", ["product.read"], true);
  const tool = await openTool(page, "聚水潭商品建档");
  await expect(tool.getByRole("alert")).toContainText("勾选款式行");
  await expect(tool.getByRole("button", { name: "生成建档资料", exact: true })).toBeDisabled();
  await expect(tool.getByRole("button", { name: "下载 Excel", exact: true })).toBeDisabled();
  expect(state.detailRequests).toEqual([]);
});

test("缺少映射阻止导出，补齐后可重新生成", async ({ page }) => {
  const state = await fixture(page, "/project-tables/7", ["product.read"], true);
  state.mappings["color-mappings"][0].status = "INACTIVE";
  await page.locator('td[data-selection-row="1"][data-selection-column="xutiStyleNo"]').click();
  const tool = await openTool(page, "聚水潭商品建档");
  await expect(tool.getByText("已选 1 款", { exact: true })).toBeVisible();
  await tool.getByRole("button", { name: "生成建档资料", exact: true }).click();
  await expect(tool.getByRole("alert")).toContainText("唯一启用的三位色码");
  await expect(tool.getByRole("button", { name: "下载 Excel", exact: true })).toBeDisabled();
  state.mappings["color-mappings"][0].status = "ACTIVE";
  await tool.getByRole("button", { name: "生成建档资料", exact: true }).click();
  await expect(tool.getByText("已生成 1 款、6 条商品资料", { exact: true })).toBeVisible();
});

test("预览后权限变化阻止下载旧资料并重新生成留空字段", async ({ page }) => {
  const state = await fixture(page, "/products", ["product.read"], true);
  await page.locator('td[data-selection-row="1"][data-selection-column="xutiStyleNo"]').click();
  const tool = await openTool(page, "聚水潭商品建档");
  await expect(tool.getByText("已选 1 款", { exact: true })).toBeVisible();
  await tool.getByRole("button", { name: "生成建档资料", exact: true }).click();
  await expect(tool.getByText("已生成 1 款、6 条商品资料", { exact: true })).toBeVisible();
  let downloads = 0;
  page.on("download", () => downloads++);
  state.rows[0].hiddenCells = ["material"];
  await tool.getByRole("button", { name: "下载 Excel", exact: true }).click();
  await expect(tool.getByRole("alert")).toContainText("查看权限或颜色尺码映射已变化");
  await expect(tool.getByRole("button", { name: "下载 Excel", exact: true })).toBeDisabled();
  expect(downloads).toBe(0);
  await tool.getByRole("button", { name: "生成建档资料", exact: true }).click();
  await expect(tool.getByText("已生成 1 款、6 条商品资料", { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await tool.getByRole("button", { name: "下载 Excel", exact: true }).click();
  const book = new Excel.Workbook();
  await book.xlsx.readFile((await (await downloadPromise).path())!);
  expect(book.getWorksheet("商品资料")!.getCell("AJ2").text).toBe("");
});

test("唯品会建档只展开选中款式并下载真实29列XLS", async ({ page }) => {
  const state = await fixture(page, "/products", ["product.read"], true);
  await page.locator('td[data-selection-row="1"][data-selection-column="xutiStyleNo"]').click();
  const tool = await openTool(page, "唯品会商品建档");
  await expect(tool.getByText("已选 1 款", { exact: true })).toBeVisible();
  await tool.getByRole("button", { name: "生成建档资料", exact: true }).click();
  await expect(tool.getByText("已生成 1 款、6 条商品资料", { exact: true })).toBeVisible();
  await expect(tool.locator(".copyable-code-value").filter({ hasText: /^TOOL-001019002$/ })).toBeVisible();
  await tool.screenshot({ path: test.info().outputPath("vip-registration-preview.png") });
  const downloadPromise = page.waitForEvent("download");
  await tool.getByRole("button", { name: "下载 Excel", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^唯品会商品建档_.*\.xls$/);
  const path = test.info().outputPath("vip-registration.xls");
  await download.saveAs(path);
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 8).toString("hex")).toBe("d0cf11e0a1b11ae1");
  const book = readXls(bytes, { type: "buffer" });
  expect(book.SheetNames).toEqual(["商品资料"]);
  const sheet = book.Sheets["商品资料"];
  expect(sheet["!ref"]).toBe("A1:AC7");
  expect(sheet.A2.v).toBe("序缇");
  expect(sheet.C2.v).toBe("TOOL-001019");
  expect(sheet.D2.v).toBe("TOOL-001019002");
  expect(sheet.D7.v).toBe("TOOL-001009004");
  expect(sheet.K5.v).toBe("咖粉");
  expect(sheet.L2.v).toBe(4410);
  expect(sheet.M2.v).toBe("普通商品");
  const data = xlsUtils.sheet_to_json<(string | number)[]>(sheet, { header: 1, defval: "" });
  expect(data[1].slice(5, 11)).toEqual(["", "半截裙", "", "S", "", "蓝紫"]);
  expect(JSON.stringify(data)).not.toContain("UNSELECTED");
  expect(state.detailRequests.every(id => id === "1")).toBe(true);
  expect(state.gridWrites).toEqual([]);
});

test("唯品会没有选中款式时不读取或生成全表", async ({ page }) => {
  const state = await fixture(page, "/style-selections", ["product.read"], true);
  const tool = await openTool(page, "唯品会商品建档");
  await expect(tool.getByRole("alert")).toContainText("勾选款式行");
  await expect(tool.getByRole("button", { name: "生成建档资料", exact: true })).toBeDisabled();
  await expect(tool.getByRole("button", { name: "下载 Excel", exact: true })).toBeDisabled();
  expect(state.detailRequests).toEqual([]);
});

test("唯品会缺少映射会阻止导出，补齐后重新生成", async ({ page }) => {
  const state = await fixture(page, "/project-tables/7", ["product.read"], true);
  state.mappings["color-mappings"][0].status = "INACTIVE";
  await page.locator('td[data-selection-row="1"][data-selection-column="xutiStyleNo"]').click();
  const tool = await openTool(page, "唯品会商品建档");
  await expect(tool.getByText("已选 1 款", { exact: true })).toBeVisible();
  await tool.getByRole("button", { name: "生成建档资料", exact: true }).click();
  await expect(tool.getByRole("alert")).toContainText("唯一启用的三位色码");
  await expect(tool.getByRole("button", { name: "下载 Excel", exact: true })).toBeDisabled();
  state.mappings["color-mappings"][0].status = "ACTIVE";
  await tool.getByRole("button", { name: "生成建档资料", exact: true }).click();
  await expect(tool.getByText("已生成 1 款、6 条商品资料", { exact: true })).toBeVisible();
});

test("唯品会下载前核验权限变化，隐藏标题不会导出旧值", async ({ page }) => {
  const state = await fixture(page, "/products", ["product.read"], true);
  await page.locator('td[data-selection-row="1"][data-selection-column="xutiStyleNo"]').click();
  const tool = await openTool(page, "唯品会商品建档");
  await expect(tool.getByText("已选 1 款", { exact: true })).toBeVisible();
  await tool.getByRole("button", { name: "生成建档资料", exact: true }).click();
  await expect(tool.getByText("已生成 1 款、6 条商品资料", { exact: true })).toBeVisible();
  let downloads = 0;
  page.on("download", () => downloads++);
  state.rows[0].hiddenCells = ["custom:long"];
  await tool.getByRole("button", { name: "下载 Excel", exact: true }).click();
  await expect(tool.getByRole("alert")).toContainText("查看权限或颜色尺码映射已变化");
  await expect(tool.getByRole("button", { name: "下载 Excel", exact: true })).toBeDisabled();
  expect(downloads).toBe(0);
  await tool.getByRole("button", { name: "生成建档资料", exact: true }).click();
  await expect(tool.getByText("已生成 1 款、6 条商品资料", { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await tool.getByRole("button", { name: "下载 Excel", exact: true }).click();
  const book = readXls(await readFile((await (await downloadPromise).path())!), { type: "buffer" });
  expect(book.Sheets["商品资料"].E2?.v || "").toBe("");
  expect(JSON.stringify(book.Sheets["商品资料"])).not.toContain("建档长标题");
});

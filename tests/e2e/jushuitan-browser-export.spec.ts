import { expect, test, type Page } from "@playwright/test";
import * as XLSX from "xlsx";
import { collectJstState } from "../../apps/worker/src/jushuitan-browser-state.js";
import {
  exportJstInventory,
  verifyJstScope,
} from "../../apps/worker/src/jushuitan-browser-export.js";
import { jushuitanScope } from "../../packages/contracts/src/jushuitan-inventory.js";
import type { JstTarget } from "../../apps/api/src/integrations/jushuitan/export-file.js";
import {
  JstLoginInputTracker,
  jstLoginMasks,
} from "../../apps/worker/src/jushuitan-login-input.js";

test("登录输入只返回位置与填写状态，绑定目标且不遮盖协议复选框", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("https://www.erp321.com/fixture-login", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<input aria-label="登录账号"><input type="password" aria-label="登录密码"><input type="checkbox" aria-label="协议"><button>登录</button>',
    }),
  );
  await page.goto("https://www.erp321.com/fixture-login");
  const tracker = new JstLoginInputTracker();
  expect(await tracker.current(page)).toBeNull();
  await page.getByLabel("登录账号").click();
  const account = (await tracker.current(page))!;
  expect(account.label).toBe("账号");
  expect(account.filled).toBe(false);
  await tracker.fill(page, account.id, "fixture-account");
  expect(await page.getByLabel("登录账号").inputValue()).toBe(
    "fixture-account",
  );
  expect(await tracker.current(page)).toMatchObject({
    id: account.id,
    filled: true,
  });
  expect(JSON.stringify(await tracker.current(page))).not.toContain(
    "fixture-account",
  );
  await page.getByLabel("登录密码").click();
  const password = (await tracker.current(page))!;
  expect(password.id).not.toBe(account.id);
  expect(password.label).toBe("密码");
  await expect(
    tracker.fill(page, account.id, "wrong-destination"),
  ).rejects.toThrow("输入框已改变");
  await expect(page.getByLabel("登录密码")).toHaveValue("");
  await tracker.fill(page, password.id, "fixture-password");
  expect(JSON.stringify(await tracker.current(page))).not.toContain(
    "fixture-password",
  );
  const masks = jstLoginMasks(page);
  expect(await masks[0].count()).toBe(2);
  await page.getByRole("checkbox").check();
  expect(await tracker.current(page)).toBeNull();
});

test("会话收集跳过禁止存储的内嵌页，保留主站会话供新窗口核验", async ({
  page,
}) => {
  await page.route("https://www.erp321.com/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body:
        new URL(route.request().url()).pathname === "/epaas"
          ? '<script>sessionStorage.setItem("fixture-session", "fixture-value")</script><iframe sandbox="allow-scripts" src="https://www.erp321.com/fixture-sandbox"></iframe>'
          : "<p>Sandbox content</p>",
    }),
  );
  await page.goto("https://www.erp321.com/epaas");
  await page.screenshot({ mask: jstLoginMasks(page), timeout: 5000 });
  const state = await collectJstState(page.context());
  expect(state.sessionStorage).toEqual([
    {
      origin: "https://www.erp321.com",
      entries: [{ name: "fixture-session", value: "fixture-value" }],
    },
  ]);
});

const code = "0000123456789012345678";
const target: JstTarget = {
  sku_code: code,
  barcode: null,
  color_name: "粉色",
  size_name: "L",
};
const native = [code, code, "粉色;L", 5, 0, 0, 0, 0, 0, 5, 12];
const alias = ["OTHER-粉色-L", code, "粉色;L", 10, 1, 0, 0, 25, 0, 9, 0];
function excel(rows: unknown[][], withStyles = false) {
  const b = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    b,
    XLSX.utils.aoa_to_sheet([
      [
        "商品编码",
        "其它属性5",
        "颜色及规格",
        "实际库存数",
        "订单占有数",
        "销退仓库存",
        "进货仓库存",
        "采购在途数",
        "调拨在途数",
        "可用数",
        "虚拟库存数",
        ...(withStyles ? ["款式编码"] : []),
      ],
      ...rows,
    ]),
    "库存",
  );
  return XLSX.write(b, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
async function erpFixture(
  page: Page,
  mode:
    | "valid"
    | "outside"
    | "unscoped"
    | "color_difference"
    | "outside_style"
    | "stale_count" = "valid",
  options: {
    homeOnly?: boolean;
    hiddenDuplicate?: boolean;
    companyScope?: boolean;
    wrongWarehouse?: boolean;
    resetWarehouse?: boolean;
    tours?: boolean;
    styleQueries?: boolean;
    styleMaxLength?: number;
    delayedQueryWithoutSpinner?: boolean;
  } = {},
) {
  const downloads: string[] = [];
  await page.route("https://**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture-count") {
      await new Promise((resolve) =>
        setTimeout(resolve, options.delayedQueryWithoutSpinner ? 2500 : 100),
      );
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ count: Number(url.searchParams.get("count")) }),
      });
    }
    if (url.pathname === "/fixture-export.xlsx") {
      downloads.push(url.search);
      const mapping = url.searchParams.get("kind") === "mapped_code";
      let records =
        mode === "outside"
          ? [["UNREQUESTED", "", "粉色;L", 8, 0, 0, 0, 0, 0, 8, 0]]
          : mapping
            ? [
                native,
                mode === "color_difference"
                  ? alias.map((v, i) => (i === 2 ? "黑色;L" : v))
                  : alias,
              ]
            : [native];
      if (options.styleQueries) {
        const styles = (url.searchParams.get("codes") ?? "").split(",");
        records = styles.includes("XFA16X31196L")
          ? [
              [
                ...native,
                mode === "outside_style" ? "UNREQUESTED-STYLE" : "XFA16X31196L",
              ],
              [
                "NOT-ON-WEBSITE",
                "",
                "其它色;S",
                99,
                0,
                0,
                0,
                0,
                0,
                99,
                0,
                "XFA16X31196L",
              ],
            ]
          : [[...alias, "XFA16-31196L"]];
      }
      return route.fulfill({
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers: {
          "Content-Disposition": 'attachment; filename="inventory.xlsx"',
        },
        body: excel(records, options.styleQueries),
      });
    }
    if (url.pathname === "/epaas")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<header>${jushuitanScope.company}</header>
          ${options.tours ? '<div id="logo-tour" style="position:fixed;inset:0;z-index:100;background:#0002">点击Logo图标，可快速搜索菜单！<button onclick="this.parentElement.remove()">知道了</button></div>' : ""}
          <aside id="current-scope" style="position:absolute;left:10px;top:80px;writing-mode:vertical-rl;width:20px;height:240px">${options.companyScope ? jushuitanScope.company : options.wrongWarehouse ? "其它分仓" : jushuitanScope.warehouse}</aside>
          <div role="dialog" id="warehouse-picker" hidden><span>${jushuitanScope.warehouse}</span><span>所有仓储</span></div>
          <button ${options.homeOnly ? "" : 'role="tab"'} id="inventory-entry">商品库存</button>
          ${options.hiddenDuplicate ? '<iframe hidden src="https://src.erp321.com/stockInventoryManagement?old=1"></iframe>' : ""}
          <div id="inventory" style="margin-left:50px">${options.homeOnly ? "" : '<iframe style="width:1200px;height:800px" src="https://src.erp321.com/stockInventoryManagement"></iframe>'}</div>
          <script>
            const scope=document.getElementById('current-scope'),picker=document.getElementById('warehouse-picker');
            scope.onclick=()=>picker.hidden=false;
            picker.querySelector('span').onclick=()=>{scope.textContent=${JSON.stringify(jushuitanScope.warehouse)};picker.hidden=true;};
            document.getElementById('inventory-entry').onclick=()=>{
              if(!document.getElementById('inventory').children.length)document.getElementById('inventory').innerHTML='<iframe style="width:1200px;height:800px" src="https://src.erp321.com/stockInventoryManagement"></iframe>';
            };
            window.addEventListener('message',event=>{if(event.data==='reset-warehouse')scope.textContent='其它分仓';});
          </script>`,
      });
    if (url.pathname !== "/stockInventoryManagement") return route.abort();
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `
      <p>实际库存数 商品编码</p>
      ${options.tours ? '<div id="inventory-tour" style="position:fixed;inset:0;z-index:100;background:#0002">当前是库存视角，您可以点击切换视角或返回旧版库存<button onclick="this.parentElement.remove()">我知道了</button></div>' : ""}
      ${options.styleQueries ? `<span class="goods-input-affix-wrapper"><button id="style-match" aria-label="匹配方式：模糊匹配，点击切换为精确匹配">模</button><input id="i_id" ${options.styleMaxLength ? `maxlength="${options.styleMaxLength}"` : ""}></span>` : '<input id="i_id">'}<input id="supplier_sku_id"><input id="supplier_i_id">
      <span class="goods-input-affix-wrapper"><button id="match" aria-label="匹配方式：模糊匹配，点击切换为精确匹配">模</button><input id="sku_id"></span>
      <div class="select-input-container"><button role="combobox" id="attribute">选择其它属性</button><input placeholder="请输入" id="mapped"></div>
      <div id="options" hidden class="goods-select-item-option-content"><span>其它属性5</span></div>
      <button id="reset">重 置</button><button id="search">搜 索</button><button id="export">导 出</button>
      <a hidden id="download">导出库存</a><p id="count">共99999条</p><div id="loading" hidden class="goods-spin-spinning">加载中</div>
      <output hidden id="query-records"></output>
      <script>
        const byId=id=>document.getElementById(id);let kind='sku_code',query='';const observedQueries=[];
        byId('match').onclick=()=>{byId('match').setAttribute('aria-label','匹配方式：精确匹配，点击切换为模糊匹配');};
        if(byId('style-match'))byId('style-match').onclick=()=>byId('style-match').setAttribute('aria-label','匹配方式：精确匹配，点击切换为模糊匹配');
        byId('attribute').onclick=()=>byId('options').hidden=false;
        byId('options').onclick=()=>byId('options').hidden=true;
        const load=(count)=>{byId('loading').hidden=${options.delayedQueryWithoutSpinner ? "true" : "false"};byId('export').disabled=true;fetch('/fixture-count?count='+count).then(response=>response.json()).then(data=>{byId('count').textContent='共'+data.count+'条';byId('loading').hidden=true;byId('export').disabled=false;});};
        byId('reset').onclick=()=>{byId('reset').dataset.count=String(Number(byId('reset').dataset.count||0)+1);document.querySelectorAll('input').forEach(i=>i.value='');${options.resetWarehouse ? "parent.postMessage('reset-warehouse','*');" : ""}load(99999);};
        byId('search').onclick=()=>{
          kind=byId('i_id').value?'style_code':byId('sku_id').value?'sku_code':'mapped_code';query=byId(kind==='style_code'?'i_id':kind==='sku_code'?'sku_id':'mapped').value;
          observedQueries.push({kind,codes:query.split(',')});byId('query-records').textContent=JSON.stringify(observedQueries);
          const count=kind==='style_code'?(query.split(',').includes('XFA16X31196L')?2:query.split(',').includes('XFA16-31196L')?1:0):(byId('sku_id').value&&byId('mapped').value)||${JSON.stringify(mode)}==='unscoped'||(${JSON.stringify(mode)}==='stale_count'&&observedQueries.length===1)?99999:!query.split(',').includes(${JSON.stringify(code)})?0:kind==='mapped_code'?2:1;
          load(count);
        };
        byId('export').onclick=()=>{byId('download').hidden=false;byId('download').href='/fixture-export.xlsx?kind='+kind+'&codes='+encodeURIComponent(query);};
      </script>`,
    });
  });
  await page.goto("https://www.erp321.com/epaas");
  return downloads;
}
test("两类款号各导出一份，按明确商品编码汇总且不纳入网站外商品", async ({
  page,
}) => {
  const downloads = await erpFixture(page, "valid", { styleQueries: true });
  const result = await exportJstInventory(
    page,
    [{ ...target, style_no: "XFA16X31196L" }],
    async () => {},
    async () => {},
  );
  expect(downloads).toHaveLength(2);
  expect(
    downloads.map((query) => new URLSearchParams(query).get("codes")),
  ).toEqual(["XFA16X31196L", "XFA16-31196L"]);
  expect(result.report.records[0].physical_qty).toBe(15);
  expect(result.report.sources).toHaveLength(2);
  expect(result.report.exportedCount).toBe(3);
  expect(result.files).toHaveLength(2);
  await expect(page.frameLocator("iframe").locator("#reset")).toHaveAttribute(
    "data-count",
    "1",
  );
});
test("查询加载标志缺失或晚出现时，等待请求完成再读取条数和导出", async ({
  page,
}) => {
  const downloads = await erpFixture(page, "valid", {
    styleQueries: true,
    delayedQueryWithoutSpinner: true,
  });
  const result = await exportJstInventory(
    page,
    [{ ...target, style_no: "XFA16X31196L" }],
    async () => {},
    async () => {},
  );
  expect(downloads).toHaveLength(2);
  expect(result.report.exportedCount).toBe(3);
  expect(result.report.records[0].physical_qty).toBe(15);
});
test("款号查询按输入框容量拆批，保留两类格式的完整查询范围", async ({
  page,
}) => {
  await erpFixture(page, "valid", { styleQueries: true, styleMaxLength: 30 });
  const targets = [
    { ...target, style_no: "XFA16X31196L" },
    { ...target, sku_code: "SECOND", style_no: "XFW28X31926L" },
    { ...target, sku_code: "THIRD", style_no: "H49XJMX16579" },
  ];
  const result = await exportJstInventory(
    page,
    targets,
    async () => {},
    async () => {},
  );
  expect(result.report.records[0].physical_qty).toBe(15);
  const queries = JSON.parse(
    await page.frameLocator("iframe").locator("#query-records").innerText(),
  ) as { kind: string; codes: string[] }[];
  expect(queries).toHaveLength(4);
  expect(
    queries.every(
      (query) =>
        query.kind === "style_code" && query.codes.join(",").length <= 30,
    ),
  ).toBe(true);
  expect(queries.flatMap((query) => query.codes)).toEqual([
    "XFA16X31196L",
    "XFW28X31926L",
    "H49XJMX16579",
    "XFA16-31196L",
    "XFW28-31926L",
    "H49-JM-16579",
  ]);
});
test("即使商品条码匹配，也拒绝款号筛选范围外的导出文件", async ({ page }) => {
  await erpFixture(page, "outside_style", { styleQueries: true });
  await expect(
    exportJstInventory(
      page,
      [{ ...target, style_no: "XFA16X31196L" }],
      async () => {},
      async () => {},
    ),
  ).rejects.toThrow("款号范围外");
});
test("云端流程仅查询网站编码和属性5，等待重置完成，并按原始SKU去重", async ({
  page,
}) => {
  const downloads = await erpFixture(page),
    stages: string[] = [];
  const result = await exportJstInventory(
    page,
    [target, { ...target, sku_code: "MISSING" }],
    async () => {},
    async (stage) => {
      stages.push(stage);
    },
  );
  expect(downloads).toHaveLength(2);
  for (const query of downloads)
    expect(new URLSearchParams(query).get("codes")).toBe(`${code},MISSING`);
  expect(result.report.sources).toHaveLength(2);
  expect(result.report.records).toHaveLength(1);
  expect(result.report.records[0]).toMatchObject({
    sku_code: code,
    physical_qty: 15,
    available_qty: 14,
    virtual_qty: 12,
    in_transit_qty: 25,
  });
  expect(result.files).toHaveLength(2);
  expect(stages).toContain("查询其它属性5（第1/1批）");
  await expect(page.frameLocator("iframe").locator("#reset")).toHaveAttribute(
    "data-count",
    "1",
  );
});

test("属性5使用较小批次仍覆盖所有网站编码和最后一个余数批次", async ({
  page,
}) => {
  await erpFixture(page);
  const targets = [
    target,
    ...Array.from({ length: 200 }, (_, index) => ({
      ...target,
      sku_code: `MISSING-${index}`,
    })),
  ];
  await exportJstInventory(
    page,
    targets,
    async () => {},
    async () => {},
  );
  const queries = JSON.parse(
    await page.frameLocator("iframe").locator("#query-records").innerText(),
  ) as { kind: string; codes: string[] }[];
  for (const [kind, sizes] of [
    ["sku_code", [200, 1]],
    ["mapped_code", [50, 50, 50, 50, 1]],
  ] as const) {
    const matching = queries.filter((query) => query.kind === kind);
    expect(matching.map((query) => query.codes.length)).toEqual(sizes);
    expect(matching.flatMap((query) => query.codes)).toEqual(
      targets.map((row) => row.sku_code),
    );
  }
  await expect(page.frameLocator("iframe").locator("#reset")).toHaveAttribute(
    "data-count",
    "1",
  );
});

test("颜色描述不同仍按明确编码汇总，并继续完成全部批次", async ({ page }) => {
  await erpFixture(page, "color_difference");
  const targets = [
    target,
    ...Array.from({ length: 200 }, (_, index) => ({
      ...target,
      sku_code: `MISSING-${index}`,
    })),
  ];
  const result = await exportJstInventory(
    page,
    targets,
    async () => {},
    async () => {},
  );
  const queries = JSON.parse(
    await page.frameLocator("iframe").locator("#query-records").innerText(),
  );
  expect(queries).toHaveLength(7);
  expect(result.report.records[0].physical_qty).toBe(15);
  expect(result.report.sources).toHaveLength(2);
  expect(result.report.sources[1].color_size).toBe("黑色;L");
});

test("查询出现旧的全仓条数时重试相同条件，范围确认后才导出", async ({
  page,
}) => {
  const downloads = await erpFixture(page, "stale_count");
  const result = await exportJstInventory(
    page,
    [target],
    async () => {},
    async () => {},
  );
  const queries = JSON.parse(
    await page.frameLocator("iframe").locator("#query-records").innerText(),
  );
  expect(queries).toHaveLength(3);
  expect(queries[0]).toEqual(queries[1]);
  expect(downloads).toHaveLength(2);
  expect(result.report.records[0].physical_qty).toBe(15);
});

test("关闭已识别的新手引导后才能切换精确匹配并导出", async ({ page }) => {
  const downloads = await erpFixture(page, "valid", {
    tours: true,
    hiddenDuplicate: true,
  });
  const result = await exportJstInventory(
    page,
    [target],
    async () => {},
    async () => {},
  );
  expect(downloads).toHaveLength(2);
  expect(result.report.records[0].physical_qty).toBe(15);
  await expect(page.locator("#logo-tour")).toHaveCount(0);
  await expect(
    page.frameLocator("#inventory iframe").locator("#inventory-tour"),
  ).toHaveCount(0);
});

test("会话恢复后从首页打开库存并选择杭州总仓，忽略隐藏的旧库存页", async ({
  page,
}) => {
  await erpFixture(page, "valid", {
    homeOnly: true,
    companyScope: true,
    hiddenDuplicate: true,
  });
  const frame = await verifyJstScope(page);
  await page.screenshot({ mask: jstLoginMasks(page), timeout: 5000 });
  await expect(
    frame.getByRole("button", { name: "导 出", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#current-scope")).toHaveText(
    jushuitanScope.warehouse,
  );
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("仓库仅出现在候选列表时不通过，查询重置改变仓库时不导出", async ({
  page,
}) => {
  await erpFixture(page, "valid", { wrongWarehouse: true });
  await page.locator("#current-scope").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(verifyJstScope(page)).rejects.toThrow("当前仓库无法确认");
  await page.unrouteAll();
  const downloads = await erpFixture(page, "valid", { resetWarehouse: true });
  await expect(
    exportJstInventory(
      page,
      [target],
      async () => {},
      async () => {},
    ),
  ).rejects.toThrow("当前仓库无法确认");
  expect(downloads).toHaveLength(0);
});

test("库存查询内容可见，账号密码验证码仍遮盖", async ({ page }) => {
  await page.route("https://src.erp321.com/stockInventoryManagement", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<input id="sku_id" value="000123"><input placeholder="请输入" value="杭州总仓"><input type="password" hidden><input autocomplete="username"><input autocomplete="one-time-code"><input placeholder="请输入账号">',
    }),
  );
  await page.goto("https://src.erp321.com/stockInventoryManagement");
  const masks = jstLoginMasks(page);
  expect(await masks[0].count()).toBe(4);
  expect(
    await masks[0].evaluateAll((elements) =>
      elements.some((e) => e.id === "sku_id"),
    ),
  ).toBe(false);
  await page.locator('input[type="password"]').evaluate((element) => {
    (element as HTMLElement).hidden = false;
  });
  expect(await jstLoginMasks(page)[0].count()).toBe(6);
  await page.screenshot({ mask: jstLoginMasks(page), timeout: 5000 });
});
test("导出出现范围外商品时拒绝发布", async ({ page }) => {
  await erpFixture(page, "outside");
  await expect(
    exportJstInventory(
      page,
      [target],
      async () => {},
      async () => {},
    ),
  ).rejects.toThrow("范围外");
});
test("筛选未生效时不导出全仓，零匹配也不导出全仓", async ({ page }) => {
  const downloads = await erpFixture(page, "unscoped");
  await expect(
    exportJstInventory(
      page,
      [target],
      async () => {},
      async () => {},
    ),
  ).rejects.toThrow("查询返回条数异常");
  expect(downloads).toHaveLength(0);
  await page.unrouteAll();
  const empty = await erpFixture(page);
  const result = await exportJstInventory(
    page,
    [{ ...target, sku_code: "MISSING" }],
    async () => {},
    async () => {},
  );
  expect(empty).toHaveLength(0);
  expect(result.report.records).toHaveLength(0);
});

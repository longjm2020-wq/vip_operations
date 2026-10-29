import { expect, test, type Page } from "@playwright/test";
import * as XLSX from "xlsx";
import { exportJstInventory } from "../../apps/worker/src/jushuitan-browser-export.js";
import { jushuitanScope } from "../../packages/contracts/src/jushuitan-inventory.js";
import type { JstTarget } from "../../apps/api/src/integrations/jushuitan/export-file.js";

const code = "0000123456789012345678";
const target: JstTarget = {
  sku_code: code,
  barcode: null,
  color_name: "粉色",
  size_name: "L",
};
const native = [code, code, "粉色;L", 5, 0, 0, 0, 0, 0, 5, 12];
const alias = ["OTHER-粉色-L", code, "粉色;L", 10, 1, 0, 0, 25, 0, 9, 0];
function excel(rows: unknown[][]) {
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
      ],
      ...rows,
    ]),
    "库存",
  );
  return XLSX.write(b, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
async function erpFixture(
  page: Page,
  mode: "valid" | "outside" | "unscoped" = "valid",
) {
  const downloads: string[] = [];
  await page.route("https://**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture-export.xlsx") {
      downloads.push(url.search);
      const mapping = url.searchParams.get("kind") === "mapped_code";
      const records =
        mode === "outside"
          ? [["UNREQUESTED", "", "粉色;L", 8, 0, 0, 0, 0, 0, 8, 0]]
          : mapping
            ? [native, alias]
            : [native];
      return route.fulfill({
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers: {
          "Content-Disposition": 'attachment; filename="inventory.xlsx"',
        },
        body: excel(records),
      });
    }
    if (url.pathname === "/epaas")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<p>${jushuitanScope.company}</p><button role="tab">商品库存</button><iframe style="width:1200px;height:800px" src="https://src.erp321.com/stockInventoryManagement"></iframe>`,
      });
    if (url.pathname !== "/stockInventoryManagement") return route.abort();
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `
      <p>${jushuitanScope.warehouse}</p><p>实际库存数 商品编码</p>
      <input id="i_id"><input id="supplier_sku_id"><input id="supplier_i_id">
      <span class="goods-input-affix-wrapper"><button id="match" aria-label="匹配方式：模糊匹配，点击切换为精确匹配">模</button><input id="sku_id"></span>
      <div class="select-input-container"><button role="combobox" id="attribute">选择其它属性</button><input placeholder="请输入" id="mapped"></div>
      <div id="options" hidden class="goods-select-item-option-content"><span>其它属性5</span></div>
      <button id="reset">重 置</button><button id="search">搜 索</button><button id="export">导出</button>
      <a hidden id="download">导出库存</a><p id="count">共99999条</p><div id="loading" hidden class="goods-spin-spinning">加载中</div>
      <script>
        const byId=id=>document.getElementById(id);let kind='sku_code',query='';
        byId('match').onclick=()=>{byId('match').setAttribute('aria-label','匹配方式：精确匹配，点击切换为模糊匹配');};
        byId('attribute').onclick=()=>byId('options').hidden=false;
        byId('options').onclick=()=>byId('options').hidden=true;
        const load=(count)=>{byId('loading').hidden=false;byId('export').disabled=true;setTimeout(()=>{byId('count').textContent='共'+count+'条';byId('loading').hidden=true;byId('export').disabled=false;},100);};
        byId('reset').onclick=()=>{document.querySelectorAll('input').forEach(i=>i.value='');load(99999);};
        byId('search').onclick=()=>{
          kind=byId('sku_id').value?'sku_code':'mapped_code';query=byId(kind==='sku_code'?'sku_id':'mapped').value;
          const count=${JSON.stringify(mode)}==='unscoped'?99999:!query.split(',').includes(${JSON.stringify(code)})?0:kind==='mapped_code'?2:1;
          load(count);
        };
        byId('export').onclick=()=>{byId('download').hidden=false;byId('download').href='/fixture-export.xlsx?kind='+kind+'&codes='+encodeURIComponent(query);};
      </script>`,
    });
  });
  await page.goto("https://www.erp321.com/epaas");
  return downloads;
}
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

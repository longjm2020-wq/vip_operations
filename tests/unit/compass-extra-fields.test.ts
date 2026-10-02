import { describe, expect, it } from "vitest";
import { compassRatios, normalizeCompassWorkbook, parseCompassSearch } from "../../packages/contracts/src/compass-analytics.js";
import { productReferenceTargets, splitProductReferences } from "../../apps/web/src/compass-product-references.js";

describe("Compass batch identifiers and report image references", () => {
  it("accepts mixed separators, ignores blank and duplicate codes, and keeps single fuzzy searches", () => {
    expect(parseCompassSearch(" XFA1，xfa1,\r\n AR-2\n0000123,, ")).toEqual({text:"XFA1，xfa1,\r\n AR-2\n0000123,,",batch:true,codes:["xfa1","ar-2","0000123"]});
    expect(parseCompassSearch("衬衫")).toEqual({text:"衬衫",batch:false,codes:["衬衫"]});
    expect(parseCompassSearch(",，\n").text).toBe("");
    expect(() => parseCompassSearch(Array.from({length:101},(_,i)=>`A${i}`).join(","))).toThrow("100");
    expect(() => parseCompassSearch("A".repeat(151))).toThrow("150");
  });
  it("matches full codes next to Chinese prose and preserves longer codes and escaped symbols", () => {
    const targets = [{code:"XFA1",image:"https://a.example.test/1.jpg"},{code:"XFA1L029",image:"https://a.example.test/2.jpg"},{code:"BC.1",image:"https://a.example.test/3.jpg"}];
    const text = "核查XFA1L029条码与XFA1款号、BC.1；不匹配XFA1L030或AXFA1。";
    const parts = splitProductReferences(text,targets);
    expect(parts.map(p=>p.text).join("")).toBe(text);
    expect(parts.filter(p=>p.target).map(p=>p.target!.code)).toEqual(["XFA1L029","XFA1","BC.1"]);
    expect(splitProductReferences("没有图片的编码",[])).toEqual([{text:"没有图片的编码",target:undefined}]);
  });
  it("takes only available HTTPS snapshot pictures and deduplicates codes", () => {
    const targets = productReferenceTargets({dataThrough:"2026-10-01",periods:[],dailyStyle:[],dimensions:[{dimension:"style",days:7,top10:[{code:"X1",image:"https://a.example.test/1.jpg"},{code:"X2",image:"javascript:alert(1)"},{code:"X3"},{code:"X1",image:"https://a.example.test/2.jpg"}]}]});
    expect(targets).toEqual([{code:"X1",image:"https://a.example.test/1.jpg"}]);
  });
});

describe("Compass non-additive fields and weighted rates", () => {
  const headers=["日期","P_SPU_ID","款号","销售额","销售量","销售额(不含拒退)","销售量(不含拒退)","退货件数","退货金额","可售库存","售龄","首次上架时间"];
  const row=["2026-10-01","1","ST-1","100","2","90","1","1","10","8","234","2026-02-10 11:56:42"];
  it("preserves report age and the first listed timestamp without inventing missing values", () => {
    const report=normalizeCompassWorkbook([headers,row],"款号.xlsx");
    expect(report.records[0]).toMatchObject({saleAge:234,firstListedAt:"2026-02-10 11:56:42"});
    const noMetadata=normalizeCompassWorkbook([headers.slice(0,10),row.slice(0,10)],"旧报表.xlsx");
    expect(noMetadata.records[0]).toMatchObject({saleAge:null,firstListedAt:null});
    const invalid=[...row]; invalid[11]="2026-02-30 11:56:42";
    expect(()=>normalizeCompassWorkbook([headers,invalid],"错误日期.xlsx")).toThrow("首次上架");
    invalid[11]=row[11]; invalid[10]="1.5";
    expect(()=>normalizeCompassWorkbook([headers,invalid],"错误售龄.xlsx")).toThrow("售龄");
  });
  it("recomputes rates from counts, preserving missing and zero denominator behavior", () => {
    expect(compassRatios({favorites:12,cartUsers:20,detailViews:100,exchangesQty:2,returnsQty:5,rejectedQty:1,salesQty:10})).toMatchObject({favoriteRate:.12,cartRate:.2,exchangeRate:.2,rejectedReturnRate:.6});
    expect(compassRatios({favorites:0,cartUsers:2,detailViews:0,exchangesQty:2,returnsQty:5,rejectedQty:null,salesQty:10})).toMatchObject({favoriteRate:null,cartRate:null,exchangeRate:.2,rejectedReturnRate:null});
  });
});

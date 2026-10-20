import { describe, expect, it } from "vitest";
import Excel from "exceljs";
import type { SelectionField } from "../../packages/contracts/src/selection-layout.js";
import { joinChoiceValues } from "../../packages/contracts/src/selection-field-validation.js";
import {
  buildJushuitanProducts, jushuitanGarmentKind, jushuitanHeaders, jushuitanSizeLabel,
  readJushuitanSources, type JushuitanMappings,
} from "../../apps/web/src/jushuitan-products.js";
import { createJushuitanWorkbook } from "../../apps/web/src/jushuitan-workbook.js";
import { loadJushuitanMappings, loadJushuitanSources } from "../../apps/web/src/jushuitan-data.js";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

const field = (key: string, label: string, type: SelectionField["type"] = "text"): SelectionField =>
  ({ key, label, type, custom: key.startsWith("custom:"), width: 120 });
const fields = [
  field("xutiStyleNo", "序缇款号"), field("color", "供应商颜色"), field("sizeRange", "尺码范围"),
  field("custom:color", "标准颜色", "multiple"), field("custom:category", "三级类目"),
  field("custom:long", "长标题"), field("custom:short", "短标题"), field("supplierStyleNo", "供应商款号"),
  field("supplierCode", "供应商名称"), field("supplyPriceExclTax", "供货价（不含税）"),
  field("tagPrice", "吊牌价"), field("vipPrice", "唯品价"), field("material", "成分"),
  field("custom:safety", "安全类别"), field("custom:standard", "执行标准"),
];
const sample = () => ({
  id: "1", xutiStyleNo: "XFW33X31865L", color: "蓝紫/咖粉", sizeRange: "S/M/L",
  supplierStyleNo: "ZDFLX16077", supplierCode: "S22", supplyPriceExclTax: "490", tagPrice: "4410", vipPrice: "1080",
  material: "面料：100%桑蚕丝\n里料：100%聚酯纤维",
  extraFields: { "custom:color": "蓝色/咖色", "custom:category": "半截裙", "custom:long": "模板长标题",
    "custom:short": "模板短标题", "custom:safety": "GB18401-2010 C类", "custom:standard": "GB/T 18132-2016" } as Record<string, string>,
});
const mappings: JushuitanMappings = {
  colors: [{ code: "019", name: "蓝色", status: "ACTIVE" }, { code: "009", name: "咖色", status: "ACTIVE" }],
  sizes: [{ code: "002", name: "S", status: "ACTIVE" }, { code: "003", name: "M", status: "ACTIVE" }, { code: "004", name: "L", status: "ACTIVE" }],
};
const generate = (row = sample(), map = mappings) => buildJushuitanProducts(readJushuitanSources([row], fields), map);

describe("聚水潭模板生成", () => {
  it("reproduces the six sample SKUs, constants, positional supplier columns and calculated values", () => {
    const result = generate();
    expect(result.issues).toEqual([]);
    expect(result.styleCount).toBe(1);
    expect(result.rows).toHaveLength(6);
    expect(result.rows.map(row => row[1])).toEqual(["XFW33X31865L019002", "XFW33X31865L019003", "XFW33X31865L019004", "XFW33X31865L009002", "XFW33X31865L009003", "XFW33X31865L009004"]);
    expect(result.rows[0]).toEqual([
      "XFW33X31865L", "XFW33X31865L019002", "模板长标题", "模板短标题", "蓝色;S", "半截裙", "", "序缇质造-唯品会",
      "ZDFLX16077", "", "S22", "", "", "", "唯品会链接", "启用", "是", "成品", "", "", "", "", "", "",
      "S22", 4410, 1080, 490, "", "", "", "", 588, "155/64A(S)", "蓝紫", "面料：100%桑蚕丝\n里料：100%聚酯纤维", "GB18401-2010 C类", "GB/T 18132-2016",
    ]);
    expect(result.rows.map(row => row[34])).toEqual(["蓝紫", "蓝紫", "蓝紫", "咖粉", "咖粉", "咖粉"]);
  });
  it("exports a reloadable workbook with exactly the 38 template columns and no instruction rows", async () => {
    const row = sample();
    row.xutiStyleNo = "00001";
    row.extraFields["custom:long"] = "=literal title";
    const data = generate(row).rows;
    const book = await createJushuitanWorkbook(data);
    const copy = new Excel.Workbook();
    await copy.xlsx.load(await book.xlsx.writeBuffer());
    expect(copy.worksheets).toHaveLength(1);
    const sheet = copy.getWorksheet("商品资料")!;
    expect(sheet.columnCount).toBe(38);
    expect(sheet.rowCount).toBe(7);
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(jushuitanHeaders);
    expect(sheet.getCell("A2").value).toBe("00001");
    expect(sheet.getCell("B2").value).toBe("00001019002");
    expect(sheet.getCell("C2").value).toBe("=literal title");
    expect(sheet.getCell("AG2").value).toBe(588);
    expect(sheet.getCell("AB2").numFmt).toBe("0.00");
    expect(sheet.getCell("K2").value).toBe(sheet.getCell("Y2").value);
  });
  it.each([
    ["半截裙", "lower"], ["女式休闲裤", "lower"], ["连衣裙", "upper"], ["女式羽绒服", "upper"], ["套装", undefined],
  ])("recognizes garment category %s", (category, kind) => expect(jushuitanGarmentKind(category)).toBe(kind));
  it.each([
    ["XS", "lower", "150/60A(XS)"], ["S", "upper", "155/80A(S)"], ["M", "upper", "160/84A(M)"],
    ["L", "upper", "165/88A(L)"], ["XXL", "lower", "175/80A(2XL)"], ["3XL", "upper", "180/100A(3XL)"],
    ["均码", "lower", "160/68A(F)"], ["F", "upper", "160/84A(F)"], ["165", "upper", undefined],
  ] as const)("calculates %s %s", (size, kind, label) => expect(jushuitanSizeLabel(size, kind)).toBe(label));
  it("requires an explicit decision for unrecognized categories and unequal color lists", () => {
    const row = sample(); row.color = "供应商色"; row.extraFields["custom:category"] = "套装";
    const sources = readJushuitanSources([row], fields);
    expect(buildJushuitanProducts(sources, mappings).issues.some(issue => issue.message.includes("号型规则"))).toBe(true);
    expect(buildJushuitanProducts(sources, mappings, { "1": { kind: "upper" } }).issues.filter(issue => issue.severity === "error")).toHaveLength(2);
    const result = buildJushuitanProducts(sources, mappings, { "1": { kind: "upper", supplierColors: { 蓝色: "供应商色", 咖色: "供应商色" } } });
    expect(result.issues).toEqual([]);
    expect(result.rows[0][33]).toBe("155/80A(S)");
  });
  it("rejects duplicate styles, alias collisions, missing/stopped/void and ambiguous mapping codes", () => {
    const duplicate = readJushuitanSources([sample(), { ...sample(), id: "2" }], fields);
    expect(buildJushuitanProducts(duplicate, mappings).issues.some(issue => issue.message.includes("同款号"))).toBe(true);
    for (const colors of [
      [], [{ ...mappings.colors[0], status: "INACTIVE" }], [{ ...mappings.colors[0], code: "044" }],
      [...mappings.colors, { ...mappings.colors[0], code: "099" }],
    ]) expect(generate(sample(), { ...mappings, colors }).issues.some(issue => issue.severity === "error")).toBe(true);
    const row = sample(); row.sizeRange = "XXL/2XL";
    const result = generate(row, { ...mappings, sizes: [{ code: "006", name: "2XL", status: "ACTIVE" }] });
    expect(result.issues.some(issue => issue.message.includes("商品编码") && issue.message.includes("重复"))).toBe(true);
  });
  it("distinguishes zero and missing money, rounds half-up, and rejects invalid prices", () => {
    const row = sample(); row.supplyPriceExclTax = "0"; row.vipPrice = "";
    expect(generate(row).rows[0].slice(26, 28)).toEqual(["", 0]);
    expect(generate(row).rows[0][32]).toBe(0);
    row.supplyPriceExclTax = "0.03";
    expect(generate(row).rows[0][32]).toBe(0.04);
    row.supplyPriceExclTax = "-1";
    expect(generate(row).issues.some(issue => issue.severity === "error")).toBe(true);
  });
  it("preserves slash-bearing choice labels and uses their exact mappings", () => {
    const row = sample();
    row.extraFields["custom:color"] = joinChoiceValues(["黑/白", "咖色"]);
    const result = generate(row, { ...mappings, colors: [{ code: "025", name: "黑/白", status: "ACTIVE" }, mappings.colors[1]] });
    expect(result.rows[0][4]).toBe("黑/白;S");
    expect(result.issues).toEqual([]);
  });
  it("never leaks denied, unregistered, deleted or ambiguous source values", () => {
    const row = sample();
    const protectedRow = { ...row, cellAccess: Object.fromEntries(fields.map(field => [field.key, "read"])), hiddenCells: ["material"] };
    protectedRow.cellAccess["custom:long"] = "deny";
    delete protectedRow.cellAccess["custom:safety"];
    const projected = readJushuitanSources([protectedRow], fields.filter(field => field.key !== "custom:short"));
    const result = buildJushuitanProducts(projected, mappings);
    const serialized = JSON.stringify(result.rows);
    for (const secret of ["模板长标题", "模板短标题", row.material, row.extraFields["custom:safety"]]) expect(serialized).not.toContain(secret);
    expect(result.rows[0][2]).toBe("");
    const forbidden = { ...protectedRow, cellAccess: { ...protectedRow.cellAccess, "custom:color": "deny" } };
    expect(buildJushuitanProducts(readJushuitanSources([forbidden], fields), mappings).rows).toEqual([]);
    const ambiguous = readJushuitanSources([row], [...fields, field("custom:other", "长标题")]);
    expect(buildJushuitanProducts(ambiguous, mappings).rows[0][2]).toBe("");
    const removed = readJushuitanSources([row], fields.map(field => field.key === "custom:long" ? { ...field, deleted: true } : field));
    expect(buildJushuitanProducts(removed, mappings).rows[0][2]).toBe("");
  });
  it("does not restore a previously selected supplier color after permission revocation", () => {
    const sources = readJushuitanSources([{ ...sample(), hiddenCells: ["color"] }], fields);
    const result = buildJushuitanProducts(sources, mappings, { "1": { supplierColors: { 蓝色: "蓝紫" } } });
    expect(result.issues.some(issue => issue.message.includes("供应商颜色已变化"))).toBe(true);
    expect(JSON.stringify(result.rows)).not.toContain("蓝紫");
  });
  it("resolves archive references to names without emitting raw reference IDs", () => {
    const row = sample();
    row.extraFields["custom:product:categoryId"] = "18";
    row.extraFields["custom:product:defaultSupplierId"] = "20";
    const cols = [...fields.filter(field => !["custom:category", "supplierCode"].includes(field.key)),
      field("custom:product:categoryId", "分类"), field("custom:product:defaultSupplierId", "供应商")];
    const sources = readJushuitanSources([row], cols, { categoryId: [{ id: "18", name: "半截裙" }], defaultSupplierId: [{ id: "20", name: "测试供应商" }] });
    expect(buildJushuitanProducts(sources, mappings).rows[0][10]).toBe("测试供应商");
  });
});

describe("聚水潭读取范围", () => {
  it("reads only selected records with fresh registered fields and does not perform writes", async () => {
    const calls: string[] = [];
    const request = async (path: string) => {
      calls.push(path);
      if (path.includes("layout-preferences")) return { data: { preferences: selectionLayoutSchema.parse({ columns: fields }), revision: 1 } };
      return { data: sample() };
    };
    expect((await loadJushuitanSources(["1"], request))[0].values.style).toBe(sample().xutiStyleNo);
    expect(calls).toEqual(["/style-selections/layout-preferences?shared=true", "/style-selections/1"]);
    await expect(loadJushuitanSources([], request)).rejects.toThrow("勾选");
    await expect(loadJushuitanSources(Array(501).fill("1"), request)).rejects.toThrow("500");
  });
  it("reads subsequent pages of active mappings and rejects an incomplete response", async () => {
    const calls: string[] = [];
    const result = await loadJushuitanMappings(async path => {
      calls.push(path);
      return path.includes("color-mappings")
        ? { data: [{ code: path.includes("page=1&") ? "001" : "002", name: "测试色", status: "ACTIVE" }], total: 2 }
        : { data: mappings.sizes, total: 3 };
    });
    expect(result.colors).toHaveLength(2);
    expect(calls.every(path => path.includes("status=ACTIVE") && !path.includes("tableId"))).toBe(true);
    await expect(loadJushuitanMappings(async () => ({ data: [], total: 2 }))).rejects.toThrow("不完整");
  });
});

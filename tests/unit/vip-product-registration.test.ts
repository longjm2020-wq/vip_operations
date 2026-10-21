import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { read, utils } from "xlsx";
import type { SelectionField } from "../../packages/contracts/src/selection-layout.js";
import { buildVipRegistration, readVipRegistrationSources, vipRegistrationHeaders } from "../../apps/web/src/vip-product-registration.js";
import { createVipRegistrationFile } from "../../apps/web/src/vip-registration-workbook.js";
import type { RegistrationMappings } from "../../apps/web/src/product-registration-sources.js";

const template = JSON.parse(await readFile(new URL("../fixtures/vip-registration-template.json", import.meta.url), "utf8"));
const field = (key: string, label: string, type: SelectionField["type"] = "text"): SelectionField =>
  ({ key, label, type, custom: key.startsWith("custom:"), width: 120 });
const fields = [field("xutiStyleNo", "序缇款号"), field("color", "供应商颜色", "tags"), field("sizeRange", "尺码范围", "tags"),
  field("custom:color", "标准颜色", "tags"), field("custom:category", "三级类目"), field("custom:long", "长标题"), field("tagPrice", "吊牌价")];
const sample = () => ({
  id: "1", xutiStyleNo: "XFW33X31865L", color: "蓝紫/咖粉", sizeRange: "S/M/L", tagPrice: "4410",
  extraFields: { "custom:color": "蓝色/咖色", "custom:category": "半截裙", "custom:long": template.examples[0][4] } as Record<string, string>,
});
const mappings: RegistrationMappings = {
  colors: [{ code: "019", name: "蓝色", status: "ACTIVE" }, { code: "009", name: "咖色", status: "ACTIVE" }],
  sizes: ["S", "M", "L"].map((name, index) => ({ code: `00${index + 2}`, name, status: "ACTIVE" })),
};
const generate = (row = sample(), map = mappings) => buildVipRegistration(readVipRegistrationSources([row], fields), map);

describe("唯品会商品建档模板", () => {
  it("matches all 29 headers and every cell of the six supplied sample rows", () => {
    const result = generate();
    expect(vipRegistrationHeaders).toEqual(template.headers);
    expect(result).toEqual({ rows: template.examples, styleCount: 1, issues: [] });
  });
  it("writes real BIFF8 XLS with Chinese text, text barcodes and numeric prices", async () => {
    const source = sample(); source.xutiStyleNo = "00001"; source.extraFields["custom:long"] = "=SUM(1,2)";
    const data = generate(source).rows;
    const bytes = await createVipRegistrationFile(data);
    expect([...bytes.slice(0, 8)]).toEqual([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const book = read(bytes, { type: "array", cellNF: true });
    expect(book.SheetNames).toEqual([template.sheetName]);
    const sheet = book.Sheets[template.sheetName];
    expect(utils.sheet_to_json(sheet, { header: 1, defval: "" })).toEqual([[...template.headers], ...data]);
    expect(sheet["!ref"]).toBe("A1:AC7");
    expect(sheet.B2).toMatchObject({ t: "s", v: "00001", z: "@" });
    expect(sheet.C2.v).toBe("00001019");
    expect(sheet.D2).toMatchObject({ t: "s", v: "00001019002" });
    expect(sheet.E2).toMatchObject({ t: "s", v: "=SUM(1,2)" });
    expect(sheet.E2.f).toBeUndefined();
    expect(sheet.L2).toMatchObject({ t: "n", v: 4410, z: "0.00" });
  });
  it("retains template blanks instead of substituting short title, standard color, size or limit price", () => {
    const source = sample();
    source.extraFields["custom:short"] = "不要填入副标题";
    source.extraFields["custom:limit"] = "899";
    const result = buildVipRegistration(readVipRegistrationSources([source], [...fields,
      field("custom:short", "短标题"), field("custom:limit", "唯品吊牌限价")]), mappings);
    expect(result.rows[0].slice(5, 13)).toEqual(["", "半截裙", "", "S", "", "蓝紫", 4410, "普通商品"]);
    expect(result.rows[0].slice(13)).toEqual(Array(16).fill(""));
    expect(JSON.stringify(result)).not.toContain("不要填入副标题");
  });
  it("preserves source size names and accepts mapped numeric sizes without garment-size inference", () => {
    const source = sample(); source.sizeRange = "XXL/165"; source.extraFields["custom:category"] = "套装";
    const result = generate(source, { ...mappings, sizes: [{ code: "006", name: "2XL", status: "ACTIVE" }, { code: "025", name: "165", status: "ACTIVE" }] });
    expect(result.issues).toEqual([]);
    expect(result.rows.map(row => row[8])).toEqual(["XXL", "165", "XXL", "165"]);
    expect(result.rows[0][3]).toBe("XFW33X31865L019006");
  });
  it("requires explicit color pairing for unequal lists and never restores a revoked color", () => {
    const source = sample(); source.color = "共同色";
    const sources = readVipRegistrationSources([source], fields);
    expect(buildVipRegistration(sources, mappings).issues.filter(issue => issue.severity === "error")).toHaveLength(2);
    const override = { "1": { supplierColors: { 蓝色: "共同色", 咖色: "共同色" } } };
    const corrected = buildVipRegistration(sources, mappings, override);
    expect(corrected.issues).toEqual([]);
    expect(corrected.rows.every(row => row[10] === "共同色")).toBe(true);
    const revoked = buildVipRegistration(readVipRegistrationSources([{ ...source, hiddenCells: ["color"] }], fields), mappings, override);
    expect(revoked.issues.some(issue => issue.message.includes("供应商颜色已变化"))).toBe(true);
    expect(JSON.stringify(revoked.rows)).not.toContain("共同色");
  });
  it("blocks absent, inactive, void and ambiguous mappings, duplicate styles and alias barcodes", () => {
    for (const colors of [[], [{ ...mappings.colors[0], status: "INACTIVE" }], [{ ...mappings.colors[0], code: "044" }],
      [...mappings.colors, { ...mappings.colors[0], code: "099" }]]) {
      expect(generate(sample(), { ...mappings, colors }).issues.some(issue => issue.severity === "error")).toBe(true);
    }
    expect(generate(sample(), { ...mappings, sizes: [] }).issues.some(issue => issue.message.includes("尺码码"))).toBe(true);
    expect(buildVipRegistration(readVipRegistrationSources([sample(), { ...sample(), id: "2" }], fields), mappings)
      .issues.some(issue => issue.message.includes("同款号"))).toBe(true);
    const source = sample(); source.sizeRange = "XXL/2XL";
    expect(generate(source, { ...mappings, sizes: [{ code: "006", name: "2XL", status: "ACTIVE" }] }).issues
      .some(issue => issue.message.includes("条形码") && issue.message.includes("重复"))).toBe(true);
  });
  it("distinguishes blank, zero and invalid tag prices without using other price fields", () => {
    const source = sample(); source.tagPrice = "0";
    expect(generate(source).rows[0][11]).toBe(0);
    source.tagPrice = "";
    expect(generate(source).rows[0][11]).toBe("");
    expect(generate(source).issues.some(issue => issue.message.includes("吊牌价为空"))).toBe(true);
    source.tagPrice = "￥4,410.25";
    expect(generate(source).rows[0][11]).toBe(4410.25);
    for (const price of ["-1", "1.001", "NaN"]) {
      source.tagPrice = price;
      expect(generate(source).issues.some(issue => issue.severity === "error")).toBe(true);
    }
  });
  it("only reads registered accessible template fields, with required permissions blocking generation", () => {
    const source = sample();
    const protectedRow = { ...source, cellAccess: Object.fromEntries(fields.map(field => [field.key, "read"])), hiddenCells: ["color"] };
    protectedRow.cellAccess["custom:long"] = "deny";
    const result = buildVipRegistration(readVipRegistrationSources([protectedRow], fields.filter(field => field.key !== "tagPrice")), mappings);
    expect(result.rows[0][4]).toBe(""); expect(result.rows[0][10]).toBe(""); expect(result.rows[0][11]).toBe("");
    expect(result.issues.every(issue => issue.severity === "warning")).toBe(true);
    delete protectedRow.cellAccess["custom:color"];
    const forbidden = buildVipRegistration(readVipRegistrationSources([protectedRow], fields), mappings);
    expect(forbidden.rows).toEqual([]);
    expect(forbidden.issues.some(issue => issue.severity === "error")).toBe(true);
    for (const columns of [
      [...fields, field("custom:other", "长标题")],
      fields.map(field => field.key === "custom:long" ? { ...field, deleted: true } : field),
    ]) expect(buildVipRegistration(readVipRegistrationSources([source], columns), mappings).rows[0][4]).toBe("");
  });
  it("rejects malformed, oversized or unrepresentable exports before writing", async () => {
    await expect(createVipRegistrationFile([])).rejects.toThrow("格式不完整");
    await expect(createVipRegistrationFile([["one column"]])).rejects.toThrow("格式不完整");
    const rows = generate().rows; rows[0][4] = "字".repeat(32768);
    await expect(createVipRegistrationFile(rows)).rejects.toThrow("文字长度");
  });
});

import { describe, expect, it } from "vitest";
import { selectionFieldSchema, selectionLayoutSchema, type SelectionField } from "../../packages/contracts/src/selection-layout.js";
import {
  defaultVipTagPriceLimitConfig,
  defaultVipTagPriceLimitRules,
  isSelectionComputedField,
  matchVipTagPriceLimit,
  normalizeVipTagPriceCategory,
  resolveVipTagPriceLimit,
  selectionVipTagPriceLimitConfigSchema,
} from "../../packages/contracts/src/selection-vip-tag-price-limit.js";

const field = (sourceKey = "custom:category"): SelectionField => ({
  key: "custom:price-limit", label: "唯品吊牌限价", width: 100, custom: true,
  type: "vipTagPriceLimit", vipTagPriceLimitConfig: defaultVipTagPriceLimitConfig(sourceKey),
});

describe("唯品吊牌限价 contracts", () => {
  it("contains all 18 user-supplied defaults and provides independent editable copies", () => {
    const first = defaultVipTagPriceLimitConfig("custom:first"), second = defaultVipTagPriceLimitConfig("custom:second");
    expect(first.rules).toHaveLength(18);
    expect(Object.fromEntries(defaultVipTagPriceLimitRules.map(rule => [rule.category, rule.limit]))).toEqual({
      半截裙: 899, 连衣裙: 2799, "女士皮衣/皮草": 19999, 女式T恤: 1499, 女式背心: 899,
      女式衬衫: 1999, 女式打底衫: 599, 女式大衣: 3999, 女式风衣: 1799, 女式礼服: 2999,
      女式马夹: 1299, 女式外套: 1599, 女式卫衣: 899, 女式休闲裤: 1799, 女式羊毛衫: 1599,
      女式羊绒衫: 3999, 女式羽绒服: 12999, 女式针织衫: 999,
    });
    first.rules[0].limit = 1;
    first.rules.push({ category: "新增三级类目", limit: 299.99 });
    expect(second.rules[0].limit).toBe(899);
    expect(defaultVipTagPriceLimitRules).toHaveLength(18);
    expect(matchVipTagPriceLimit(first, "新增三级类目")).toBe(299.99);
  });

  it("matches normalized complete labels without fuzzy matches or slash splitting", () => {
    const config = defaultVipTagPriceLimitConfig("custom:category");
    expect(normalizeVipTagPriceCategory(" 女式Ｔ恤 ")).toBe("女式T恤");
    expect(matchVipTagPriceLimit(config, " 女式Ｔ恤 ")).toBe(1499);
    expect(matchVipTagPriceLimit(config, "女士皮衣／皮草")).toBe(19999);
    expect(matchVipTagPriceLimit(config, "@choices//v1:[\"女士皮衣/皮草\"]")).toBe(19999);
    for (const raw of ["", " \n ", null, undefined, 899, ["半截裙"], "半截", "女式马甲", "半截裙/连衣裙", "@choices//v1:[]", "@choices//v1:[\"半截裙\",\"连衣裙\"]", "@choices//v1:broken"])
      expect(matchVipTagPriceLimit(config, raw), String(raw)).toBeNull();
  });

  it("allows new/removed rules and zero but rejects ambiguous rules and invalid money", () => {
    expect(selectionVipTagPriceLimitConfigSchema.parse({ sourceKey: " category ", rules: [] })).toEqual({ sourceKey: "category", rules: [] });
    expect(selectionVipTagPriceLimitConfigSchema.parse({ sourceKey: "category", rules: [{ category: " 新类目 ", limit: 0 }] }).rules[0]).toEqual({ category: "新类目", limit: 0 });
    for (const limit of [-1, NaN, Infinity, 1.001, 1000000000])
      expect(selectionVipTagPriceLimitConfigSchema.safeParse({ sourceKey: "category", rules: [{ category: "半截裙", limit }] }).success).toBe(false);
    for (const invalid of [
      { sourceKey: "", rules: [] },
      { sourceKey: "category", rules: [{ category: " ", limit: 899 }] },
      { sourceKey: "category", rules: [{ category: "女式T恤", limit: 10 }, { category: " 女式Ｔ恤 ", limit: 20 }] },
      { sourceKey: "category", rules: [{ category: "半截裙", limit: 899, extra: true }] },
    ]) expect(selectionVipTagPriceLimitConfigSchema.safeParse(invalid).success).toBe(false);
    const config = { sourceKey: "category", rules: [{ category: "半截裙", limit: 0 }] };
    expect(matchVipTagPriceLimit(config, "半截裙")).toBe(0);
    expect(matchVipTagPriceLimit({ ...config, rules: [...config.rules, ...config.rules] }, "半截裙")).toBeNull();
    expect(matchVipTagPriceLimit({ ...config, rules: [{ category: "半截裙", limit: NaN }] }, "半截裙")).toBeNull();
    expect(matchVipTagPriceLimit({ ...config, rules: [{ category: "半截裙", limit: 1.00000001 }] }, "半截裙")).toBeNull();
  });

  it("keeps configuration across type changes while requiring valid active references", () => {
    const initial = field(), config = initial.vipTagPriceLimitConfig;
    expect(selectionLayoutSchema.parse({ columns: [initial] }).columns[0].vipTagPriceLimitConfig).toEqual(config);
    expect(selectionFieldSchema.parse({ ...initial, type: "text" }).vipTagPriceLimitConfig).toEqual(config);
    expect(selectionFieldSchema.safeParse({ ...initial, vipTagPriceLimitConfig: undefined }).success).toBe(false);
    expect(selectionFieldSchema.safeParse({ ...initial, type: undefined, fallbackType: "vipTagPriceLimit", vipTagPriceLimitConfig: undefined }).success).toBe(false);
    expect(selectionFieldSchema.safeParse({ ...initial, vipTagPriceLimitConfig: { ...config, sourceKey: initial.key } }).success).toBe(false);
    expect(isSelectionComputedField(initial)).toBe(true);
    expect(isSelectionComputedField({ type: "createdTime" })).toBe(false);
    expect(isSelectionComputedField({ fallbackType: "vipTagPriceLimit" })).toBe(true);
  });

  it("uses the configured custom/builtin source and never saved target values", () => {
    expect(resolveVipTagPriceLimit(field(), { extraFields: { "custom:category": "半截裙", "custom:price-limit": "123" } })).toBe(899);
    expect(resolveVipTagPriceLimit(field("supplierCode"), { supplierCode: "连衣裙", extraFields: { supplierCode: "半截裙" } })).toBe(2799);
    expect(resolveVipTagPriceLimit(field(), { "custom:category": "半截裙", extraFields: { "custom:price-limit": "123" } })).toBeNull();
    expect(resolveVipTagPriceLimit({ ...field(), type: "text" }, { extraFields: { "custom:category": "半截裙" } })).toBeNull();
    expect(resolveVipTagPriceLimit(field(), { extraFields: { "custom:category": "待新增" } })).toBeNull();
  });

  it("does not derive hidden or unauthorized source values", () => {
    const row = { extraFields: { "custom:category": "半截裙" } };
    expect(resolveVipTagPriceLimit(field(), { ...row, cellAccess: { "custom:category": "read" } })).toBe(899);
    expect(resolveVipTagPriceLimit(field(), { ...row, cellAccess: {} })).toBeNull();
    expect(resolveVipTagPriceLimit(field(), { ...row, cellAccess: { "custom:category": "deny" } })).toBeNull();
    expect(resolveVipTagPriceLimit(field(), { ...row, hiddenCells: ["custom:category"] })).toBeNull();
    expect(resolveVipTagPriceLimit(field("supplierCode"), { supplierCode: "半截裙", cellAccess: { supplierCode: "deny" } })).toBeNull();
    expect(resolveVipTagPriceLimit(field("supplierCode"), { supplierCode: "半截裙", cellAccess: {}, defaultCellAccess: "deny" })).toBeNull();
  });

  it("resolves archive category ids only through caller-provided authorized labels", () => {
    const archiveField = field("custom:product:categoryId"), row = { extraFields: { "custom:product:categoryId": "42" }, cellAccess: { "custom:product:categoryId": "read" } };
    expect(resolveVipTagPriceLimit(archiveField, row, { categoryNames: { "42": "半截裙" } })).toBe(899);
    expect(resolveVipTagPriceLimit(archiveField, row)).toBeNull();
    expect(resolveVipTagPriceLimit(archiveField, row, { categoryNames: { "43": "半截裙" } })).toBeNull();
    expect(resolveVipTagPriceLimit(archiveField, { ...row, cellAccess: {} }, { categoryNames: { "42": "半截裙" } })).toBeNull();
  });
});

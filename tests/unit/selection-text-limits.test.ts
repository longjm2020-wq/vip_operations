import { describe, expect, it } from "vitest";
import { selectionFieldSchema, type SelectionField } from "../../packages/contracts/src/selection-layout.js";
import { countTextCharacters, fieldTextCount, fieldTextLengthError, fieldValueError } from "../../packages/contracts/src/selection-field-validation.js";

const field = (countMode: "characters" | "han" = "characters", maxLength = 4): SelectionField => ({
  key: "custom:text-limit", label: "文本", custom: true, type: "text", width: 100,
  textConfig: { countMode, maxLength },
});
describe("text field limits", () => {
  it("counts Unicode code points, Han, spaces and newlines without deleting content", () => {
    const value = "汉𠀀A😀 \n";
    expect(countTextCharacters(value, "characters")).toBe(6);
    expect(countTextCharacters(value, "han")).toBe(2);
    expect(countTextCharacters("e\u0301👨‍👩‍👧‍👦", "characters")).toBe(9);
    expect(fieldTextLengthError(field("characters", 6), value)).toBeNull();
    expect(fieldTextLengthError(field("characters", 5), value)).toContain("当前6");
    expect(fieldTextLengthError(field("han", 2), value)).toBeNull();
    expect(fieldTextLengthError(field("han", 1), value)).toContain("个汉字");
    expect(value).toBe("汉𠀀A😀 \n");
  });
  it("matches the existing stored normalization for each kind of text", () => {
    expect(fieldTextCount(field(), " 中 \n")).toBe(4);
    expect(fieldTextCount({ ...field(), key: "material", custom: false }, " 中 \n")).toBe(1);
    expect(fieldTextCount({ ...field(), key: "custom:product:name" }, " 中 \n")).toBe(1);
    expect(fieldTextCount({ ...field(), key: "custom:product:remark" }, " 中 \n")).toBe(4);
    expect(fieldTextCount({ ...field(), key: "color", custom: false }, "红 / 蓝/红")).toBe(3);
    expect(fieldTextCount({ ...field(), key: "sizeRange", custom: false }, "XL / S/XL")).toBe(4);
    expect(fieldTextCount({ ...field(), key: "vipPrice", custom: false }, "1")).toBe(4);
    expect(fieldTextLengthError({ ...field("characters", 1), key: "vipPrice", custom: false }, "1")).toContain("当前4");
    expect(fieldTextCount({ ...field(), key: "registrationBatch", custom: false }, new Date("2026-10-11T00:00:00Z"))).toBe(10);
    expect(fieldTextLengthError(field("characters", 3), " \n  ")).toContain("当前4");
  });
  it("keeps a saved config inactive until text is the effective type", () => {
    expect(fieldTextLengthError({ ...field(), type: "number" }, "123456")).toBeNull();
    expect(fieldTextLengthError({ ...field(), type: undefined, fallbackType: "text" }, "123456")).toBeTruthy();
    expect(fieldTextLengthError({ ...field(), type: undefined, fallbackType: "number" }, "123456")).toBeNull();
    expect(fieldTextLengthError({ ...field(), textConfig: undefined }, "123456")).toBeNull();
  });
  it("counts canonical money strings exactly without floating-point rounding", () => {
    const price = { ...field("characters", 17), key: "tagPrice", custom: false };
    expect(fieldTextCount(price, "99999999999999.99")).toBe(17);
    expect(fieldTextLengthError(price, "99999999999999.99")).toBeNull();
    expect(fieldTextCount(price, "0001.5")).toBe(4);
    expect(fieldTextCount(price, "0000")).toBe(4);
  });
  it("does not weaken the original text storage maximum in Han mode", () => {
    expect(fieldValueError(field("han", 1), "A".repeat(2001))).toBe("内容最多2000字");
    expect(fieldValueError(field("han", 1), " ".repeat(2001))).toBe("内容最多2000字");
    expect(fieldValueError(field("characters", 2000), "😀".repeat(1001))).toBe("内容最多2000字");
    expect(fieldValueError(field("han", 1), "中" + "A".repeat(1999))).toBeNull();
  });
  it.each([0, -1, 2001, 1.5, NaN, Infinity])("rejects invalid configured maxima %s", maxLength => {
    expect(selectionFieldSchema.safeParse(field("characters", maxLength)).success).toBe(false);
  });
  it("supports optional limits and validates the count mode and extra keys", () => {
    expect(selectionFieldSchema.safeParse({ ...field(), textConfig: undefined }).success).toBe(true);
    expect(selectionFieldSchema.safeParse(field("han", 2000)).success).toBe(true);
    expect(selectionFieldSchema.safeParse({ ...field(), textConfig: { countMode: "bytes", maxLength: 1 } }).success).toBe(false);
    expect(selectionFieldSchema.safeParse({ ...field(), textConfig: { countMode: "han", maxLength: 1, truncate: true } }).success).toBe(false);
  });
});

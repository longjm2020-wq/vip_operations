import { describe, expect, it } from "vitest";
import { cellNumberFormatSchema, formatSelectionValue } from "../../packages/contracts/src/selection-format.js";
const show = (value: unknown, type: string, extra = {}) => formatSelectionValue(value, cellNumberFormatSchema.parse({ type, ...extra }));
describe("selection display formats", () => {
  it("formats prices and percentages without changing source strings", () => {
    const value = "1234.5";
    expect(show(value, "currency")).toBe("¥ 1,234.50");
    expect(show(value, "thousands", { decimals: 0 })).toBe("1,235");
    expect(show("0.95", "percent", { decimals: 0 })).toBe("95%");
    expect(show("-12", "accounting")).toBe("¥ (12.00)");
    expect(show("0", "accounting")).toBe("¥ —");
    expect(value).toBe("1234.5");
  });
  it("preserves empty, nonnumeric and unsafe identifier values", () => {
    expect(show(null, "number")).toBe("");
    expect(show("羊毛", "currency")).toBe("羊毛");
    expect(show("6228486666666666666", "number")).toBe("6228486666666666666");
    expect(show("00123", "text")).toBe("00123");
    expect(show("00123", "general")).toBe("00123");
    expect(show("12abc", "number")).toBe("12abc");
  });
  it("validates dates and times instead of guessing or normalizing invalid values", () => {
    expect(show("2026-09-28", "date")).toBe("2026/9/28");
    expect(show("2026-02-30", "date")).toBe("2026-02-30");
    expect(show("9:05", "time")).toBe("09:05:00");
    expect(show("25:00", "time")).toBe("25:00");
  });
  it("supports fraction, scientific, padded and custom preset formats", () => {
    expect(show("0.5", "fraction")).toBe("1/2");
    expect(show("-1.25", "fraction")).toBe("-1 1/4");
    expect(show("0.96", "scientific", { decimals: 1 })).toBe("9.6E-1");
    expect(show("12", "special")).toBe("000012");
    expect(show("1234.5", "custom", { pattern: "#,##0.00" })).toBe("1,234.50");
    expect(show("0.95", "custom", { pattern: "0%" })).toBe("95%");
  });
  it("rejects unsupported types, unbounded precision and arbitrary custom patterns", () => {
    for (const value of [{ type: "unknown" }, { type: "number", decimals: 99 }, { type: "custom", pattern: "arbitrary" }]) expect(cellNumberFormatSchema.safeParse(value).success).toBe(false);
  });
});

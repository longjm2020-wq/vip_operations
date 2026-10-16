import { describe, expect, it } from "vitest";
import {
  compassInventoryReference,
  modeReference,
  estimatedReturns,
  medianReference,
  inventoryReferenceWindow,
} from "../../packages/contracts/src/compass-inventory-reference.js";
import { normalizeCompassWorkbook } from "../../packages/contracts/src/compass-analytics.js";

describe("inventory median references and rolling calendar windows", () => {
  it("uses a true median instead of the most frequent value and preserves central observations", () => {
    expect(medianReference([0, 0, 2, 100])).toEqual({ value: 1, values: [0, 2], samples: 4, method: "median" });
    expect(medianReference([9, 1, 3])).toEqual({ value: 3, values: [3], samples: 3, method: "median" });
    expect(medianReference([0.1, 0.2]).value).toBe(0.15);
  });
  it("includes explicit zeroes and rates above 100% but excludes invalid or missing observations", () => {
    expect(medianReference([0, 0, 1.5, 2, null, undefined, -1, NaN, Infinity])).toEqual({ value: 0.75, values: [0, 1.5], samples: 4, method: "median" });
    expect(medianReference([null, -1, NaN])).toEqual({ value: null, values: [], samples: 0, method: "median" });
  });
  it.each([
    ["3d", "2026-10-15", "2026-10-13", 3],
    ["7d", "2026-10-15", "2026-10-09", 7],
    ["15d", "2026-10-15", "2026-10-01", 15],
    ["30d", "2026-10-15", "2026-09-16", 30],
    ["3m", "2026-05-31", "2026-03-01", 92],
    ["3m", "2024-05-31", "2024-03-01", 92],
    ["6m", "2026-10-15", "2026-04-16", 183],
    ["1y", "2024-02-29", "2023-03-01", 366],
  ] as const)("anchors %s at %s with calendar boundaries", (period, end, start, days) => {
    expect(inventoryReferenceWindow(period, end, days)).toEqual({ period, start_date: start, end_date: end, days, covered_days: days, complete: true, method: "median" });
    expect(inventoryReferenceWindow(period, end, days - 1).complete).toBe(false);
  });
  it("does not invent an anchor date before a complete source exists", () => {
    expect(inventoryReferenceWindow("30d", null)).toMatchObject({ start_date: null, end_date: null, days: 0, complete: false });
  });
});

describe("Compass inventory modal references", () => {
  it("uses the most frequent sales quantity rather than an arithmetic daily average", () => {
    expect(modeReference([1, 1, 1, 3, 3, 5])).toEqual({
      value: 1,
      values: [1],
      frequency: 3,
      samples: 6,
    });
  });
  it("averages every tied distinct mode once, including the user's 1/3/5 example", () => {
    expect(modeReference([1, 1, 1, 3, 3, 3, 5, 5, 5, 7])).toEqual({
      value: 3,
      values: [1, 3, 5],
      frequency: 3,
      samples: 10,
    });
    expect(modeReference([1, 1, 4, 4, 9]).value).toBe(2.5);
  });
  it("counts explicit zeroes but does not turn missing cells into zeroes", () => {
    expect(modeReference([0, 0, 1, null, undefined, -1, NaN]).value).toBe(0);
    expect(modeReference([null, undefined])).toEqual({
      value: null,
      values: [],
      frequency: 0,
      samples: 0,
    });
    expect(modeReference([0, 0]).value).toBe(0);
  });
  it("applies the same tied-mode logic to percentages without a 100% clamp", () => {
    expect(modeReference([0.1, 0.1, 0.3, 0.3, 0.5, 0.5]).value).toBe(0.3);
    expect(modeReference([1.5, 1.5, 0]).value).toBe(1.5);
  });
  it("retains fractional means and uses decimal multiplication for estimates", () => {
    expect(modeReference([0.1, 0.2]).value).toBe(0.15);
    expect(estimatedReturns(3, 0.1)).toBe(0.3);
    expect(estimatedReturns(null, 0.1)).toBeNull();
    expect(estimatedReturns(5, null)).toBeNull();
    expect(estimatedReturns(5, 0)).toBe(0);
  });
  it("uses report percentages even when daily sales are zero, and preserves incomplete totals", () => {
    const reference = compassInventoryReference([
      { date: "2026-10-01", salesQty: 0, reportedReturnRate: 0 },
      { date: "2026-10-02", salesQty: 2, reportedReturnRate: 0.5 },
      { date: "2026-10-03", salesQty: null, reportedReturnRate: null },
    ]);
    expect(reference.dailySales.value).toBe(1);
    expect(reference.returnRate.value).toBe(0.25);
    expect(reference.salesQty).toBeNull();
    expect(reference.recordedDays).toBe(3);
  });
  it("does not mix distinct platform records for the same barcode and day", () => {
    const reference = compassInventoryReference([
      { date: "2026-10-01", salesQty: 1, reportedReturnRate: 0 },
      { date: "2026-10-01", salesQty: 5, reportedReturnRate: 0.2 },
    ]);
    expect(reference.ambiguous).toBe(true);
    expect(reference.dailySales.value).toBeNull();
    expect(reference.returnRate.value).toBeNull();
    expect(reference.salesQty).toBeNull();
  });
});

describe("original daily return rate normalization", () => {
  const headers = [
    "日期",
    "P_SPU_ID",
    "款号",
    "销售额",
    "销售量",
    "销售额(不含拒退)",
    "销售量(不含拒退)",
    "退货件数",
    "退货金额",
    "可售库存",
    "退货率(退货件数/销售量)",
  ];
  const row = ["2026-10-01", "123", "ST-1", "0", "0", "0", "0", "0", "0", "3"];
  it.each([
    ["0.0%", 0],
    ["16.7%", 0.167],
    ["20％", 0.2],
    ["150.0%", 1.5],
    ["20", 0.2],
    ["—", null],
  ])("retains %s as the report's percentage", (raw, value) => {
    expect(
      normalizeCompassWorkbook([headers, [...row, String(raw)]], "report.xlsx")
        .records[0].reportedReturnRate,
    ).toBe(value);
  });
  it("distinguishes an absent column from a missing cell and rejects invalid rates", () => {
    expect(
      normalizeCompassWorkbook([headers.slice(0, -1), row], "legacy.xlsx")
        .records[0].reportedReturnRate,
    ).toBeUndefined();
    expect(
      normalizeCompassWorkbook([headers, [...row, ""]], "empty.xlsx").records[0]
        .reportedReturnRate,
    ).toBeNull();
    for (const value of ["-10%", "bad%"])
      expect(() =>
        normalizeCompassWorkbook([headers, [...row, value]], "invalid.xlsx"),
      ).toThrow("退货率");
  });
});

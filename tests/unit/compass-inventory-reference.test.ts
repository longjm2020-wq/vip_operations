import { describe, expect, it } from "vitest";
import {
  compassInventoryReference,
  modeReference,
  estimatedReturns,
  frequentReference,
  dailySalesReference,
  returnRateReference,
  MIN_FREQUENT_SAMPLE_DAYS,
  roundToWholePercent,
  inventoryReferenceWindow,
} from "../../packages/contracts/src/compass-inventory-reference.js";
import { normalizeCompassWorkbook } from "../../packages/contracts/src/compass-analytics.js";

describe("inventory frequent-value references (高频均值) and rolling calendar windows", () => {
  const days = (values: (number | null)[]) =>
    values.map((value, index) => ({ date: `2026-10-${String(index + 1).padStart(2, "0")}`, value }));
  it("averages the two most frequent non-zero daily values", () => {
    // 3 appears 4 days, 5 appears 3 days, 9 once, zeros ignored: (3 + 5) / 2 = 4.
    expect(frequentReference(days([0, 3, 5, 3, 0, 5, 3, 9, 5, 3, 0]))).toEqual({
      value: 4, values: [3, 5], frequencies: [4, 3], samples: 11, nonZeroSamples: 8, method: "frequent",
    });
    expect(frequentReference(days([2, 2, 1])).value).toBe(1.5);
  });
  it("uses the only non-zero value alone, zero when every day is zero and null without data", () => {
    expect(frequentReference(days([0, 4, 0, 4]))).toMatchObject({ value: 4, values: [4], frequencies: [2] });
    expect(frequentReference(days([0, 0, 0]))).toMatchObject({ value: 0, values: [], samples: 3, nonZeroSamples: 0 });
    expect(frequentReference(days([null, null]))).toMatchObject({ value: null, values: [], samples: 0 });
    expect(frequentReference([{ value: -1 }, { value: Number.NaN }, { value: Infinity }, { value: undefined }]).value).toBeNull();
  });
  it("breaks frequency ties by the most recent date, then the larger value", () => {
    // 1, 2 and 6 each occur twice; 6 and 1 are the latest.
    expect(frequentReference(days([2, 6, 1, 2, 6, 1])).values).toEqual([1, 6]);
    expect(frequentReference(days([1, 2, 6, 1, 2, 6])).values).toEqual([6, 2]);
    expect(frequentReference([{ value: 1 }, { value: 7 }, { value: 4 }]).values).toEqual([7, 4]);
    // Frequency still wins over recency.
    expect(frequentReference(days([5, 5, 5, 1, 2])).values).toEqual([5, 2]);
  });
  it("rounds daily return rates to whole percents before counting and rounds the result", () => {
    // 75.68% → 76%, 76.2% → 76%, 74.6% → 75%, 0.4% → 0% (ignored).
    const rates = frequentReference(days([0.7568, 0.762, 0.746, 0.75, 0.004, 0.755]), { wholePercent: true });
    expect(rates).toMatchObject({ values: [0.76, 0.75], frequencies: [3, 2], nonZeroSamples: 5, samples: 6 });
    expect(rates.value).toBe(0.76); // (76% + 75%) / 2 = 75.5% → 76%
    expect(frequentReference(days([0.2, 0.2, 0.31]), { wholePercent: true }).value).toBe(0.26); // 25.5% → 26%
    expect(frequentReference(days([1.5, 1.5]), { wholePercent: true }).value).toBe(1.5);
    expect(roundToWholePercent(0.7568)).toBe(0.76);
    expect(roundToWholePercent(0.745)).toBe(0.75);
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
    expect(inventoryReferenceWindow(period, end, days)).toEqual({ period, start_date: start, end_date: end, days, covered_days: days, complete: true, method: "frequent" });
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
    // Zero days are ignored: the only non-zero sales (2) and rate (50%) are used alone.
    expect(reference.dailySales.value).toBe(2);
    expect(reference.returnRate.value).toBe(0.5);
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

describe("sell-through correction (动销天数占比) and small-sample protection (样本不足)", () => {
  const days = (values: (number | null)[]) =>
    values.map((value, index) => ({ date: `2026-09-${String(index + 1).padStart(2, "0")}`, value }));
  it("keeps (R1+R2)/2 for display and scales it by the selling-day share for inventory maths", () => {
    // 30 valid days, 15 with sales: 4 on 8 days, 3 on 4 days, 5 on 3 days → (4 + 3) / 2 = 3.5; 3.5 × 50% = 1.75.
    const sales = [...Array(8).fill(4), ...Array(4).fill(3), ...Array(3).fill(5), ...Array(15).fill(0)];
    const result = dailySalesReference(days(sales));
    expect(result).toMatchObject({
      value: 3.5, values: [4, 3], frequencies: [8, 4], samples: 30, nonZeroSamples: 15,
      sellThroughRatio: 0.5, effectiveValue: 1.75, effectiveMethod: "frequent_x_ratio", sampleInsufficient: false,
    });
    // The task example: 高频均值 4 with 15 / 30 selling days → 2.
    const example = dailySalesReference(days([...Array(10).fill(4), 4, 4, 4, 4, 4, ...Array(15).fill(0)]));
    expect(example).toMatchObject({ value: 4, sellThroughRatio: 0.5, effectiveValue: 2 });
  });
  it("falls back to the period average when fewer than 5 days had sales", () => {
    expect(MIN_FREQUENT_SAMPLE_DAYS).toBe(5);
    // 2, 2, 5 on 3 of 30 days: display (2 + 5) / 2 = 3.5, inventory uses 9 / 30 = 0.3.
    const result = dailySalesReference(days([2, 2, 5, ...Array(27).fill(0)]));
    expect(result).toMatchObject({
      value: 3.5, nonZeroSamples: 3, sellThroughRatio: 0.1, sampleInsufficient: true,
      effectiveMethod: "period_average", effectiveValue: 0.3, validTotal: 9,
    });
    // Exactly 5 selling days is enough.
    expect(dailySalesReference(days([1, 1, 1, 2, 2, 0, 0, 0, 0, 0])).sampleInsufficient).toBe(false);
    // Missing cells are excluded from both total and days.
    expect(dailySalesReference(days([6, null, 0, 0])).effectiveValue).toBe(2);
  });
  it("handles all-zero and empty periods", () => {
    expect(dailySalesReference(days([0, 0, 0]))).toMatchObject({ value: 0, sellThroughRatio: 0, effectiveValue: 0, sampleInsufficient: true });
    expect(dailySalesReference(days([null]))).toMatchObject({ value: null, sellThroughRatio: null, effectiveValue: null, sampleInsufficient: false });
  });
  it("keeps the rounded frequent return rate with enough samples and never applies the sell-through ratio", () => {
    const rows = [0.2, 0.2, 0.2, 0.3, 0.3, 0, 0, 0].map((rate, index) => ({ date: `2026-09-0${index + 1}`, salesQty: rate ? 10 : 0, rate }));
    expect(returnRateReference(rows)).toMatchObject({ value: 0.25, frequentValue: 0.25, sampleInsufficient: false, fallback: null });
  });
  it("uses period returns / period sales for return rates with fewer than 5 non-zero days", () => {
    // Day returns: 10 × 50% = 5, 30 × 10% = 3 → 8 / 40 = 20%; the frequent value would be 30%.
    const rows = [
      { date: "2026-09-01", salesQty: 10, rate: 0.5 }, { date: "2026-09-02", salesQty: 30, rate: 0.1 },
      { date: "2026-09-03", salesQty: 0, rate: 0 },
    ];
    expect(returnRateReference(rows)).toMatchObject({ value: 0.2, frequentValue: 0.3, nonZeroSamples: 2, sampleInsufficient: true, fallback: "sales_weighted" });
    // A selling day without a rate (or a missing sales cell) keeps the frequent value with the hint.
    expect(returnRateReference([...rows, { date: "2026-09-04", salesQty: 5, rate: null }])).toMatchObject({ value: 0.3, sampleInsufficient: true, fallback: null });
    expect(returnRateReference([...rows, { date: "2026-09-04", salesQty: null, rate: 0.2 }])).toMatchObject({ value: 0.15, fallback: null }); // 20% (latest) and 10% tie-break
    // No sales at all: nothing to weight by.
    expect(returnRateReference([{ date: "2026-09-01", salesQty: 0, rate: 0.4 }])).toMatchObject({ value: 0.4, fallback: null, sampleInsufficient: true });
  });
});

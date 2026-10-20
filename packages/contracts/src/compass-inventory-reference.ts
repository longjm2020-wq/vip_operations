import { Decimal } from "decimal.js";
import type { InventoryReferencePeriod } from "./inventory-summary.js";
import { shiftCompassDate } from "./compass-analytics.js";

export type InventoryReferenceMethod = "frequent" | "median" | "mode" | "mean";
/** 高频均值 is the default: ignore zero days and average the two most frequent values. */
export const inventoryReferenceMethodLabels = { frequent: "高频均值", median: "中位数", mode: "众数（并列取均值）", mean: "平均值" } as const;
export type StatisticalReference = {
  value: number | null; values: number[]; samples: number;
  method: InventoryReferenceMethod; frequency?: number;
};

export type MedianReference = {
  value: number | null;
  values: number[];
  samples: number;
  method: "median";
};

export function medianReference(values: (number | null | undefined)[]): MedianReference {
  const sorted = values.filter((value): value is number =>
    value != null && Number.isFinite(value) && value >= 0,
  ).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const central = sorted.length
    ? sorted.length % 2 ? [sorted[middle]] : [sorted[middle - 1], sorted[middle]]
    : [];
  return {
    value: central.length
      ? central.reduce((total, value) => total.plus(value), new Decimal(0))
          .div(central.length).toDecimalPlaces(8).toNumber()
      : null,
    values: central,
    samples: sorted.length,
    method: "median",
  };
}

export type FrequentReference = {
  value: number | null;
  /** R1 and R2 (or R1 alone) in rank order, after any per-day rounding. */
  values: number[];
  /** How many days each of `values` occurred. */
  frequencies: number[];
  /** Valid daily observations, including explicit zeroes. */
  samples: number;
  /** Valid daily observations that are not zero (after rounding). */
  nonZeroSamples: number;
  method: "frequent";
};

export type FrequentObservation = { date?: string; value: number | null | undefined };

/** Rounds a ratio to a whole percent, half up: 0.7568 → 0.76 (76%). */
export function roundToWholePercent(value: number): number {
  return new Decimal(value).mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).div(100).toNumber();
}

/**
 * 高频均值: ignore zero days, rank the remaining distinct values by how many days
 * they occurred (R1 most frequent, R2 second) and use (R1 + R2) / 2.
 * - Only one distinct non-zero value: use it alone.
 * - Every valid day is zero: 0. No valid day: null (missing cells are never zero).
 * - Equal frequency: the value that occurred on the most recent date ranks first
 *   (then the larger value, for observations without dates).
 * `wholePercent` rounds each daily ratio to a whole percent before counting and
 * rounds the result the same way (used for return rates).
 */
export function frequentReference(
  observations: FrequentObservation[],
  { wholePercent = false }: { wholePercent?: boolean } = {},
): FrequentReference {
  const stats = new Map<number, { count: number; latest: string }>();
  let samples = 0, nonZeroSamples = 0;
  for (const { date = "", value: raw } of observations) {
    if (raw == null || !Number.isFinite(raw) || raw < 0) continue;
    const value = wholePercent ? roundToWholePercent(raw) : raw;
    samples++;
    if (value === 0) continue;
    nonZeroSamples++;
    const current = stats.get(value);
    if (current) {
      current.count++;
      if (date > current.latest) current.latest = date;
    } else stats.set(value, { count: 1, latest: date });
  }
  const ranked = [...stats]
    .sort(([valueA, a], [valueB, b]) =>
      b.count - a.count ||
      (a.latest === b.latest ? 0 : a.latest < b.latest ? 1 : -1) ||
      valueB - valueA)
    .slice(0, 2);
  const values = ranked.map(([value]) => value);
  let value: number | null = samples ? 0 : null;
  if (values.length) {
    const mean = values.reduce((sum, item) => sum.plus(item), new Decimal(0)).div(values.length);
    value = wholePercent ? roundToWholePercent(mean.toNumber()) : mean.toDecimalPlaces(8).toNumber();
  }
  return {
    value,
    values,
    frequencies: ranked.map(([, stat]) => stat.count),
    samples,
    nonZeroSamples,
    method: "frequent",
  };
}

/** Fewer non-zero days than this make the frequent value unreliable (样本不足). */
export const MIN_FREQUENT_SAMPLE_DAYS = 5;

export type DailySalesReference = FrequentReference & {
  /** 动销天数占比 = non-zero valid days / valid days (null without valid days). */
  sellThroughRatio: number | null;
  /** Daily sales used for coverage days and replenishment. */
  effectiveValue: number | null;
  sampleInsufficient: boolean;
  /** How effectiveValue was derived. */
  effectiveMethod: "frequent_x_ratio" | "period_average" | null;
  /** Sum of valid daily sales (missing cells excluded), the numerator of the period average. */
  validTotal: number;
  minSampleDays: number;
};

export type ReturnRateReference = FrequentReference & {
  /** (R1 + R2) / 2 before any small-sample fallback. */
  frequentValue: number | null;
  sampleInsufficient: boolean;
  /** "sales_weighted": Σ(daily sales × daily rate) / Σ daily sales, i.e. period returns / period sales. */
  fallback: "sales_weighted" | null;
  minSampleDays: number;
};

/**
 * Sell-through correction for downstream inventory maths. The displayed 高频均值 only describes
 * selling days, so it is scaled by the share of valid days that had sales. With fewer than
 * MIN_FREQUENT_SAMPLE_DAYS selling days the plain period average (total ÷ valid days) is used.
 */
export function dailySalesReference(observations: FrequentObservation[]): DailySalesReference {
  const frequent = frequentReference(observations);
  const valid = observations
    .map(item => item.value)
    .filter((value): value is number => value != null && Number.isFinite(value) && value >= 0);
  const ratio = frequent.samples ? new Decimal(frequent.nonZeroSamples).div(frequent.samples) : null;
  const sampleInsufficient = frequent.samples > 0 && frequent.nonZeroSamples < MIN_FREQUENT_SAMPLE_DAYS;
  const validTotal = valid.reduce((sum, value) => sum.plus(value), new Decimal(0));
  let effectiveValue: number | null = null;
  let effectiveMethod: DailySalesReference["effectiveMethod"] = null;
  if (frequent.samples && sampleInsufficient) {
    effectiveValue = validTotal.div(frequent.samples).toDecimalPlaces(8).toNumber();
    effectiveMethod = "period_average";
  } else if (frequent.value != null && ratio) {
    effectiveValue = new Decimal(frequent.value).mul(ratio).toDecimalPlaces(8).toNumber();
    effectiveMethod = "frequent_x_ratio";
  }
  return {
    ...frequent,
    sellThroughRatio: ratio ? ratio.toDecimalPlaces(8).toNumber() : null,
    effectiveValue,
    sampleInsufficient,
    effectiveMethod,
    validTotal: validTotal.toNumber(),
    minSampleDays: MIN_FREQUENT_SAMPLE_DAYS,
  };
}

/**
 * Return rate stays the rounded (R1 + R2) / 2. It is a per-sold-unit ratio, so no sell-through
 * scaling applies. With fewer than MIN_FREQUENT_SAMPLE_DAYS non-zero rate days the period rate
 * Σ(sales × rate) / Σ sales is used: each daily rate is returns ÷ sales of that day, so this equals
 * period returns ÷ period sales. It needs every selling day's rate; otherwise the frequent value stays.
 */
export function returnRateReference(days: { date?: string; salesQty: number | null; rate: number | null | undefined }[]): ReturnRateReference {
  const frequent = frequentReference(days.map(day => ({ date: day.date, value: day.rate })), { wholePercent: true });
  const sampleInsufficient = frequent.samples > 0 && frequent.nonZeroSamples < MIN_FREQUENT_SAMPLE_DAYS;
  let value = frequent.value, fallback: ReturnRateReference["fallback"] = null;
  if (sampleInsufficient) {
    const validRate = (rate: unknown): rate is number => typeof rate === "number" && Number.isFinite(rate) && rate >= 0;
    const complete = days.every(day => day.salesQty != null && (day.salesQty === 0 || validRate(day.rate)));
    const sales = days.reduce((sum, day) => sum.plus(day.salesQty || 0), new Decimal(0));
    if (complete && sales.gt(0)) {
      const returns = days.reduce((sum, day) => day.salesQty ? sum.plus(new Decimal(day.salesQty).mul(day.rate!)) : sum, new Decimal(0));
      value = roundToWholePercent(returns.div(sales).toNumber());
      fallback = "sales_weighted";
    }
  }
  return { ...frequent, value, frequentValue: frequent.value, sampleInsufficient, fallback, minSampleDays: MIN_FREQUENT_SAMPLE_DAYS };
}

export type InventoryReferenceWindow = {
  period: InventoryReferencePeriod;
  start_date: string | null;
  end_date: string | null;
  days: number;
  covered_days: number;
  complete: boolean;
  method: InventoryReferenceMethod;
};

export function inventoryReferenceWindow(
  period: InventoryReferencePeriod,
  endDate: string | null,
  coveredDays = 0,
): InventoryReferenceWindow {
  if (!endDate) return {
    period, start_date: null, end_date: null, days: 0,
    covered_days: 0, complete: false, method: "frequent",
  };
  let startDate: string;
  if (period.endsWith("d")) {
    startDate = shiftCompassDate(endDate, 1 - Number(period.slice(0, -1)));
  } else {
    const date = new Date(endDate + "T00:00:00Z");
    const months = period === "1y" ? 12 : Number(period.slice(0, -1));
    const year = date.getUTCFullYear(), month = date.getUTCMonth() - months;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const previous = new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)))
      .toISOString().slice(0, 10);
    startDate = shiftCompassDate(previous, 1);
  }
  const days = Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 1;
  return { period, start_date: startDate, end_date: endDate, days,
    covered_days: coveredDays, complete: coveredDays === days, method: "frequent" };
}

export type ModeReference = {
  value: number | null;
  values: number[];
  frequency: number;
  samples: number;
};

// Each tied distinct value contributes once, irrespective of its frequency.
// Explicit zeroes are observations; absent/invalid values are not zeroes.
export function modeReference(
  values: (number | null | undefined)[],
): ModeReference {
  const counts = new Map<number, number>();
  for (const value of values) {
    if (value != null && Number.isFinite(value) && value >= 0)
      counts.set(value, (counts.get(value) || 0) + 1);
  }
  const samples = [...counts.values()].reduce((a, b) => a + b, 0);
  const frequency = Math.max(0, ...counts.values());
  const modes = [...counts]
    .filter(([, count]) => count === frequency)
    .map(([value]) => value)
    .sort((a, b) => a - b);
  return {
    value: modes.length
      ? modes
          .reduce((sum, value) => sum.plus(value), new Decimal(0))
          .div(modes.length)
          .toDecimalPlaces(8)
          .toNumber()
      : null,
    values: modes,
    frequency,
    samples,
  };
}

export type CompassReferenceDay = {
  date: string;
  salesQty: number | null;
  reportedReturnRate?: number | null;
};

export function statisticalReference(values: (number | null | undefined)[], method: InventoryReferenceMethod): StatisticalReference {
  if (method === "frequent") return frequentReference(values.map((value) => ({ value })));
  if (method === "median") return medianReference(values);
  if (method === "mode") return { ...modeReference(values), method: "mode" };
  const valid = values.filter((value): value is number => value != null && Number.isFinite(value) && value >= 0);
  return { method: "mean", values: [], samples: valid.length,
    value: valid.length ? valid.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(valid.length).toDecimalPlaces(8).toNumber() : null };
}

export type InventoryReferenceMethods = { dailySales: InventoryReferenceMethod; returnRate: InventoryReferenceMethod };
export const defaultInventoryReferenceMethods: InventoryReferenceMethods = { dailySales: "frequent", returnRate: "frequent" };

export function compassInventoryReference(days: CompassReferenceDay[], methods: InventoryReferenceMethods = defaultInventoryReferenceMethods) {
  const uniqueDates = new Set(days.map((day) => day.date));
  const ambiguous = uniqueDates.size !== days.length;
  const sales = days.map((day) =>
    day.salesQty != null &&
    Number.isSafeInteger(day.salesQty) &&
    day.salesQty >= 0
      ? day.salesQty
      : null,
  );
  // 高频均值 keeps its 动销占比 / 样本不足 details; other methods use the plain statistic.
  const dailySales: StatisticalReference | DailySalesReference = methods.dailySales === "frequent"
    ? dailySalesReference(ambiguous ? [] : days.map((day, index) => ({ date: day.date, value: sales[index] })))
    : statisticalReference(ambiguous ? [] : sales, methods.dailySales);
  const returnRate: StatisticalReference | ReturnRateReference = methods.returnRate === "frequent"
    ? returnRateReference(ambiguous ? [] : days.map((day, index) => ({ date: day.date, salesQty: sales[index], rate: day.reportedReturnRate })))
    : statisticalReference(ambiguous ? [] : days.map((day) => day.reportedReturnRate), methods.returnRate);
  return {
    ambiguous,
    dailySales,
    returnRate,
    // A missing sales cell must not silently become zero in the total.
    salesQty:
      !ambiguous && sales.length > 0 && sales.every((value) => value !== null)
        ? sales
            .reduce((sum, value) => sum.plus(value!), new Decimal(0))
            .toNumber()
        : null,
    recordedDays: uniqueDates.size,
  };
}

export function estimatedReturns(
  salesQty: number | null,
  returnRate: number | null,
) {
  return salesQty == null || returnRate == null
    ? null
    : new Decimal(salesQty).mul(returnRate).toDecimalPlaces(4).toNumber();
}

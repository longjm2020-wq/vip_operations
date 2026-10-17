import { Decimal } from "decimal.js";
import type { InventoryReferencePeriod } from "./inventory-summary.js";
import { shiftCompassDate } from "./compass-analytics.js";

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

export type InventoryReferenceWindow = {
  period: InventoryReferencePeriod;
  start_date: string | null;
  end_date: string | null;
  days: number;
  covered_days: number;
  complete: boolean;
  method: "frequent";
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

export function compassInventoryReference(days: CompassReferenceDay[]) {
  const uniqueDates = new Set(days.map((day) => day.date));
  const ambiguous = uniqueDates.size !== days.length;
  const sales = days.map((day) =>
    day.salesQty != null &&
    Number.isSafeInteger(day.salesQty) &&
    day.salesQty >= 0
      ? day.salesQty
      : null,
  );
  return {
    ambiguous,
    dailySales: frequentReference(
      ambiguous ? [] : days.map((day, index) => ({ date: day.date, value: sales[index] })),
    ),
    returnRate: frequentReference(
      ambiguous ? [] : days.map((day) => ({ date: day.date, value: day.reportedReturnRate })),
      { wholePercent: true },
    ),
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

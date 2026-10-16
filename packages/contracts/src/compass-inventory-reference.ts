import { Decimal } from "decimal.js";
import type { InventoryReferencePeriod } from "./inventory-summary.js";
import { shiftCompassDate } from "./compass-analytics.js";

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

export type InventoryReferenceWindow = {
  period: InventoryReferencePeriod;
  start_date: string | null;
  end_date: string | null;
  days: number;
  covered_days: number;
  complete: boolean;
  method: "median";
};

export function inventoryReferenceWindow(
  period: InventoryReferencePeriod,
  endDate: string | null,
  coveredDays = 0,
): InventoryReferenceWindow {
  if (!endDate) return {
    period, start_date: null, end_date: null, days: 0,
    covered_days: 0, complete: false, method: "median",
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
    covered_days: coveredDays, complete: coveredDays === days, method: "median" };
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
    dailySales: medianReference(ambiguous ? [] : sales),
    returnRate: medianReference(
      ambiguous ? [] : days.map((day) => day.reportedReturnRate),
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

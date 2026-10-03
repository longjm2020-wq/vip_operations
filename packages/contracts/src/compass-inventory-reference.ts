import { Decimal } from "decimal.js";

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
    dailySales: modeReference(ambiguous ? [] : sales),
    returnRate: modeReference(
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

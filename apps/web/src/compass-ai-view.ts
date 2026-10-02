export type VisualSummary = {
  salesAmount?: unknown;
  salesQty?: unknown;
  returnsQty?: unknown;
  returnRate?: unknown;
  saleableStock?: unknown;
};
export type VisualPeriod = {
  days: number;
  summary: VisualSummary;
  startDate: string;
  endDate: string;
};
export type VisualTop = VisualSummary & {
  code: string;
  returnsAmount?: unknown;
};
export type CompassVisuals = {
  dataThrough: string;
  periods: VisualPeriod[];
  dailyStyle: { date: string; salesAmount: unknown; returnsAmount: unknown }[];
  dimensions: {
    dimension: "style" | "article" | "barcode";
    days: number;
    top10: VisualTop[];
  }[];
};
export function metricNumber(value: unknown): number | null {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
export function dailyAverage(period?: VisualPeriod) {
  const sales = metricNumber(period?.summary.salesAmount);
  return sales == null || !period || period.days <= 0
    ? null
    : sales / period.days;
}
export function relativeChange(
  current: number | null,
  previous: number | null,
) {
  return current == null || previous == null || previous <= 0
    ? null
    : current / previous - 1;
}
export function attentionItems(top: VisualTop[]) {
  return top
    .filter(
      (row) =>
        ((metricNumber(row.salesQty) || 0) > 0 &&
          metricNumber(row.saleableStock) === 0) ||
        (metricNumber(row.returnsQty) || 0) > 0,
    )
    .sort(
      (a, b) =>
        Number(
          metricNumber(b.saleableStock) === 0 &&
            (metricNumber(b.salesQty) || 0) > 0,
        ) -
          Number(
            metricNumber(a.saleableStock) === 0 &&
              (metricNumber(a.salesQty) || 0) > 0,
          ) ||
        (metricNumber(b.returnsQty) || 0) - (metricNumber(a.returnsQty) || 0),
    );
}

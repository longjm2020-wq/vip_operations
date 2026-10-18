import { Decimal } from "decimal.js";
// Estimates never count anticipated returns as received stock.
export function calculateReference(row: Record<string, any>) {
  if (row.daily_sales == null)
    return { ...row, coverage_days: null, replenishment_qty: null };
  const daily = new Decimal(row.daily_sales),
    available = new Decimal(row.available_qty),
    supply = available
      .plus(row.in_transit_qty)
      .plus(row.transfer_transit_qty)
      .plus(row.incoming_qty);
  return {
    ...row,
    coverage_days: daily.isZero()
      ? null
      : available.div(daily).toDecimalPlaces(1).toNumber(),
    replenishment_qty: Decimal.max(
      0,
      daily.mul(row.target_days || 14).minus(supply),
    )
      .ceil()
      .toNumber(),
  };
}

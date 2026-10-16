import {
  rows,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import {
  compassInventoryReference,
  estimatedReturns,
  type CompassReferenceDay,
  type InventoryReferenceWindow,
} from "../../../../../packages/contracts/src/compass-inventory-reference.js";

export async function applyCompassReferences(
  data: Row[],
  tx: Tx,
  source: Row | null,
  window: InventoryReferenceWindow,
) {
  const code = (row: Row) =>
    String(row.barcode || "").trim() || String(row.sku_code || "").trim();
  const codes = [...new Set(data.map(code).filter(Boolean))];
  // Pin the source chosen by the inventory page query. A concurrent replacement
  // must not make the displayed coverage and values come from different reports.
  const records = source
    ? await rows(
        tx,
        `
    SELECT r.barcode,r.business_date::text AS business_date,r.payload,d.normalization_version
    FROM compass_barcode_history_records r JOIN compass_barcode_history_days d USING(business_date)
    WHERE r.barcode=ANY($1::text[])
      AND r.business_date BETWEEN $2::date AND $3::date`,
        codes,
        window.start_date,
        window.end_date,
      )
    : [];
  const byBarcode = new Map<string, CompassReferenceDay[]>();
  const legacyBarcodes = new Set<string>();
  for (const record of records) {
    if (!record.barcode) continue;
    const days = byBarcode.get(record.barcode) || [];
    days.push({
      date: record.business_date,
      salesQty: record.payload.metrics.salesQty,
      reportedReturnRate: record.payload.reportedReturnRate,
    });
    byBarcode.set(record.barcode, days);
    if (record.normalization_version < 3) legacyBarcodes.add(record.barcode);
  }
  return data.map((row) => {
    const barcode = code(row);
    const reference = compassInventoryReference(window.complete ? byBarcode.get(barcode) || [] : []);
    const estimate = estimatedReturns(
      reference.salesQty,
      reference.returnRate.value,
    );
    return {
      ...row,
      daily_sales: reference.dailySales.value ?? row.daily_sales,
      return_rate: reference.returnRate.value ?? row.return_rate,
      estimated_returns: estimate ?? row.estimated_returns,
      channel_reference: {
        source: source
          ? {
              id: source.id,
              file_name: source.file_name,
              start_date: source.start_date,
              end_date: source.end_date,
            }
          : null,
        barcode,
        window,
        daily_sales: reference.dailySales,
        return_rate: reference.returnRate,
        estimated_returns: {
          value: estimate,
          sales_qty: reference.salesQty,
          return_rate: reference.returnRate.value,
          samples: reference.dailySales.samples,
        },
        sales_qty: reference.salesQty,
        recorded_days: reference.recordedDays,
        reason: !source
          ? "NO_COMPLETE_REPORT"
          : !window.complete
            ? "INCOMPLETE_PERIOD"
          : reference.ambiguous
            ? "AMBIGUOUS_BARCODE"
            : !reference.recordedDays
              ? "NO_MATCH"
              : null,
        needs_return_rate_import: legacyBarcodes.has(barcode),
      },
    };
  });
}

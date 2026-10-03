import {
  rows,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import {
  compassInventoryReference,
  estimatedReturns,
  type CompassReferenceDay,
} from "../../../../../packages/contracts/src/compass-inventory-reference.js";

export async function applyCompassReferences(data: Row[], tx: Tx) {
  const code = (row: Row) =>
    String(row.barcode || "").trim() || String(row.sku_code || "").trim();
  const codes = [...new Set(data.map(code).filter(Boolean))];
  // Query only the current page's complete text identifiers. The active report
  // and its records are read together; staging and superseded imports are ignored.
  const records = await rows(
    tx,
    `
    SELECT i.id::text AS source_id,i.file_name,(i.end_date-29)::text AS start_date,
      i.end_date::text AS end_date,i.normalization_version,
      r.barcode,r.business_date::text AS business_date,r.payload
    FROM compass_active_imports a JOIN compass_imports i ON i.id=a.import_id
    LEFT JOIN compass_records r ON r.import_id=i.id AND r.barcode=ANY($1::text[])
      AND r.business_date BETWEEN i.end_date-29 AND i.end_date
    WHERE a.dimension='barcode' AND i.dimension='barcode' AND i.status='COMPLETE'
      AND i.start_date<=i.end_date-29`,
    codes,
  );
  const first = records[0];
  const source = first
    ? {
        id: first.source_id,
        file_name: first.file_name,
        start_date: first.start_date,
        end_date: first.end_date,
      }
    : null;
  const byBarcode = new Map<string, CompassReferenceDay[]>();
  for (const record of records) {
    if (!record.barcode) continue;
    const days = byBarcode.get(record.barcode) || [];
    days.push({
      date: record.business_date,
      salesQty: record.payload.metrics.salesQty,
      reportedReturnRate: record.payload.reportedReturnRate,
    });
    byBarcode.set(record.barcode, days);
  }
  return data.map((row) => {
    const barcode = code(row);
    const reference = compassInventoryReference(byBarcode.get(barcode) || []);
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
        source,
        barcode,
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
          : reference.ambiguous
            ? "AMBIGUOUS_BARCODE"
            : !reference.recordedDays
              ? "NO_MATCH"
              : null,
        needs_return_rate_import: !!source && first.normalization_version < 3,
      },
    };
  });
}

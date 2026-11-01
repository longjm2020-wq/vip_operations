import { z } from "zod";
import { db, one, rows, type Row, type Tx } from "../../../../../packages/database/src/index.js";
import { fail, id, parse, requirePermission, type Actor } from "../../core.js";
import { inventoryReferencePeriodSchema } from "../../../../../packages/contracts/src/inventory-summary.js";
import { compassInventoryReference, inventoryReferenceWindow } from "../../../../../packages/contracts/src/compass-inventory-reference.js";
import { evaluateInventoryFormula, inventoryFormulaFields, parseInventoryFormula } from "../../../../../packages/contracts/src/inventory-formula.js";
import { shiftCompassDate } from "../../../../../packages/contracts/src/compass-analytics.js";
import { inventoryCalculationFields } from "./calculation-fields.js";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const trendQuery = z.object({ skuId: id, fieldId: id.optional(), period: inventoryReferencePeriodSchema,
  endDate: dateSchema.optional() }).strict();
const quantity = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
};
const snake = (key: string) => key.replace(/[A-Z]/g, letter => "_" + letter.toLowerCase());

export async function inventoryTrend(actor: Actor, input: unknown, tx: Tx = db): Promise<Row> {
  requirePermission(actor, "inventory.read");
  const query = parse(trendQuery, input);
  if (tx === db) return db.$transaction(async snapshot => {
    await snapshot.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return inventoryTrend(actor, query, snapshot);
  }, { isolationLevel: "RepeatableRead", timeout: 15000 });
  const sku = await one(tx, `SELECT s.id::text,s.sku_code,s.barcode,s.color_name,s.size_name,p.style_no,
    COALESCE(NULLIF(trim(s.barcode),''),trim(s.sku_code)) AS report_code
    FROM skus s JOIN products p ON p.id=s.product_id WHERE s.id=$1::bigint`, query.skuId);
  if (!sku) fail("NOT_FOUND", "商品不存在，请刷新库存明细", 404);
  const fields = await inventoryCalculationFields(actor.id, tx);
  const field = query.fieldId ? fields.find(item => item.id === query.fieldId) : null;
  if (query.fieldId && !field) fail("NOT_FOUND", "计算字段不存在或不再公开，请重新选择", 404);
  const [scope] = await rows(tx, `SELECT s.warehouse_name,
    (SELECT min(business_date)::text FROM jushuitan_inventory_history_days WHERE warehouse_name=s.warehouse_name) AS history_start_date,
    (SELECT i.end_date::text FROM compass_active_imports a JOIN compass_imports i ON i.id=a.import_id
      WHERE a.dimension='barcode' AND i.status='COMPLETE') AS report_end_date,
    ((now() AT TIME ZONE 'Asia/Shanghai')::date-1)::text AS yesterday
    FROM jushuitan_inventory_settings s WHERE s.id=1`);
  const window = inventoryReferenceWindow(query.period, query.endDate ?? scope.report_end_date ?? scope.yesterday);
  const start = window.start_date!, end = window.end_date!;
  const salesRows = await rows(tx, `SELECT d.business_date::text AS date,d.file_name,d.normalization_version,
    r.entity_key,r.payload->'metrics'->'salesQty' AS sales_qty,
    (SELECT count(*)::int FROM skus WHERE COALESCE(NULLIF(trim(barcode),''),trim(sku_code))=$1) AS sku_count
    FROM compass_barcode_history_days d LEFT JOIN compass_barcode_history_records r
      ON r.business_date=d.business_date AND r.barcode=$1
    WHERE d.business_date BETWEEN $2::date AND $3::date ORDER BY d.business_date`, sku.report_code, start, end);
  const stockRows = await rows(tx, `SELECT d.business_date::text AS date,d.captured_at,d.run_id,
    r.sku_code,r.physical_qty,r.reserved_qty,r.in_transit_qty,r.transfer_transit_qty,r.incoming_qty,r.return_qty
    FROM jushuitan_inventory_history_days d LEFT JOIN jushuitan_inventory_history_records r
      ON r.business_date=d.business_date AND r.warehouse_name=d.warehouse_name AND r.sku_id=$1::bigint AND r.sku_code=$2
    WHERE d.warehouse_name=$3 AND d.business_date BETWEEN $4::date AND $5::date
    ORDER BY d.business_date`, query.skuId, sku.sku_code, scope.warehouse_name, start, end);
  const sales = new Map<string, Row[]>();
  for (const row of salesRows) sales.set(row.date, [...(sales.get(row.date) ?? []), row]);
  const stocks = new Map(stockRows.map(row => [row.date, row]));
  const formula = field ? parseInventoryFormula(field.formula) : null;
  const points: Row[] = [];
  const referenceDays = salesRows.filter(row => row.entity_key != null).map(row => ({ date: row.date, salesQty: quantity(row.sales_qty) }));
  const legacyAmbiguous = salesRows.some(row => row.entity_key != null && row.normalization_version < 3 && row.sku_count > 1);
  const reference = compassInventoryReference(referenceDays);
  for (let date = start; date <= end; date = shiftCompassDate(date, 1)) {
    const records = sales.get(date), sale = records?.[0], stock = stocks.get(date);
    const ambiguous = !!records && (records.length > 1 || (sale!.entity_key != null && sale!.normalization_version < 3 && sale!.sku_count > 1));
    const rawSales = quantity(sale?.sales_qty);
    const salesQty = !ambiguous && rawSales != null && rawSales >= 0 ? rawSales : null;
    const values = Object.fromEntries(inventoryFormulaFields.map(item => [item.key, quantity(stock?.[snake(item.key)])]));
    const stockQty = formula && stock?.sku_code ? evaluateInventoryFormula(formula, values) : null;
    const previous = points.at(-1)?.stockQty;
    const delta = stockQty != null && previous != null ? stockQty - previous : null;
    points.push({ date, salesQty, stockQty,
      salesState: !sale ? "NO_REPORT" : ambiguous ? "AMBIGUOUS" : !sale.entity_key ? "NO_RECORD" : salesQty == null ? "UNKNOWN" : "RECORDED",
      stockState: !field ? "NO_FIELD" : !stock ? "NO_SNAPSHOT" : !stock.sku_code ? "NO_MATCH" : stockQty == null ? "UNKNOWN" : "RECORDED",
      stockDelta: delta != null && Math.abs(delta) <= Number.MAX_SAFE_INTEGER ? Number(delta.toFixed(4)) : null,
      snapshotAt: stock?.captured_at ?? null, sourceFile: sale?.file_name ?? null });
  }
  return { sku, startDate: start, endDate: end, period: query.period, warehouseName: scope.warehouse_name, stockHistoryStartDate: scope.history_start_date,
    field: field ? { id: field.id, name: field.name, formula: field.formula, revision: field.revision } : null,
    coverage: { days: window.days, reportDays: sales.size, salesDays: points.filter(point => point.salesQty != null).length,
      stockDays: points.filter(point => point.stockQty != null).length },
    periodSalesQty: sales.size === window.days && !legacyAmbiguous ? reference.salesQty : null,
    ambiguousSales: reference.ambiguous || legacyAmbiguous, points };
}

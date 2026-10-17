import {
  db,
  rows,
  snake,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import { fail, pagination, parse } from "../../core.js";
import { balanceFilters } from "./service.js";
import { calculateReference } from "../../../../../packages/contracts/src/inventory-reference.js";
import {
  inventoryDimensionSchema,
  inventoryReportMatchSchema,
  inventoryReferencePeriodSchema,
  inventoryStockFields,
} from "../../../../../packages/contracts/src/inventory-summary.js";
import { applyCompassReferences } from "./compass-reference.js";
import { applyCompassImages } from "./compass-images.js";

export async function inventorySummary(q: Row, tx: Tx = db) {
  // A report import can replace whole history days while a page is loading.
  // Match coverage, pagination, reference values and images must share a snapshot.
  if (tx === db) return db.$transaction(async (snapshot) => {
    await snapshot.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return inventorySummarySnapshot(q, snapshot);
  }, { isolationLevel: "RepeatableRead", timeout: 15000 });
  return inventorySummarySnapshot(q, tx);
}

async function inventorySummarySnapshot(q: Row, tx: Tx) {
  const dimension = parse(inventoryDimensionSchema, q.dimension ?? "sku");
  const reportMatch = parse(inventoryReportMatchSchema, q.reportMatch ?? "all");
  const referencePeriod = parse(inventoryReferencePeriodSchema, q.referencePeriod ?? "30d");
  const referenceStart = referencePeriod.endsWith("d")
    ? `i.end_date-${Number(referencePeriod.slice(0, -1)) - 1}`
    : `(i.end_date-interval '${referencePeriod === "1y" ? 12 : Number(referencePeriod.slice(0, -1))} months'+interval '1 day')::date`;
  const p = pagination(q),
    { vals, conditions } = balanceFilters(q);
  const skuView = dimension === "sku";
  const groupKey = skuView
    ? "'sku:'||s.id::text"
    : dimension === "style"
      ? "'style:'||pr.id::text"
      : "'article:'||pr.id::text||':'||CASE WHEN trim(COALESCE(ref.article_no,''))<>'' THEN 'code:'||trim(ref.article_no) ELSE 'sku:'||s.id::text END";
  const stockFields = inventoryStockFields.map(snake);
  const reportCondition =
    !skuView || reportMatch === "all"
      ? "true"
      : reportMatch === "matched"
        ? "compass_matched"
        : "NOT compass_matched";
  // One statement keeps the page and full filtered totals on the same snapshot.
  // Shipment quantities are aggregated before the stock join to avoid multiplying
  // a balance when a SKU has several purchase and transfer packages.
  const result = await rows(
    tx,
    `WITH compass_source AS (
      SELECT i.id,i.file_name,i.start_date,i.end_date,i.normalization_version
      FROM compass_active_imports a JOIN compass_imports i ON i.id=a.import_id
      WHERE a.dimension='barcode' AND i.dimension='barcode' AND i.status='COMPLETE'
    ), reference_window AS (
      SELECT ${referenceStart} AS start_date,i.end_date FROM compass_source i
    ), history_coverage AS (
      SELECT count(d.business_date)::int AS covered_days
      FROM reference_window i JOIN compass_barcode_history_days d ON d.business_date BETWEEN i.start_date AND i.end_date
    ), shipment_stock AS (
      SELECT i.sku_id,sh.warehouse_id,
        COALESCE(sum(i.quantity) FILTER (WHERE sh.purchase_order_id IS NOT NULL AND sh.status IN ('SHIPPED','DELIVERED')),0) AS in_transit_qty,
        COALESCE(sum(i.quantity) FILTER (WHERE sh.transfer_id IS NOT NULL AND sh.status IN ('SHIPPED','DELIVERED')),0) AS transfer_transit_qty,
        COALESCE(sum(i.qualified_qty-i.putaway_qty) FILTER (WHERE sh.status='INSPECTED'),0) AS incoming_qty
      FROM inventory_shipment_items i JOIN inventory_shipments sh ON sh.id=i.shipment_id
      GROUP BY i.sku_id,sh.warehouse_id
    ), stock AS (
      SELECT ${groupKey} AS group_key,s.id AS sku_id,s.product_id,s.sku_code,s.barcode,s.color_name,s.size_name,
        EXISTS(SELECT 1 FROM reference_window i JOIN compass_barcode_history_records r
          ON r.barcode=COALESCE(NULLIF(trim(s.barcode),''),trim(s.sku_code))
          AND r.business_date BETWEEN i.start_date AND i.end_date) AS compass_matched,
        pr.style_no,pr.name AS product_name,pr.main_image_url,
        pr.custom_fields->>'f00000000000000000000000000000001' AS supplier_style_code,
        w.id AS warehouse_id,w.name AS warehouse_name,
        COALESCE(b.physical_qty,0) AS physical_qty,COALESCE(b.reserved_qty,0) AS reserved_qty,
        COALESCE(b.damaged_qty,0) AS damaged_qty,
        COALESCE(b.physical_qty-b.reserved_qty-b.damaged_qty,0) AS available_qty,
        COALESCE(sh.in_transit_qty,0) AS in_transit_qty,COALESCE(sh.transfer_transit_qty,0) AS transfer_transit_qty,
        COALESCE(sh.incoming_qty,0) AS incoming_qty,
        NULLIF(trim(ref.article_no),'') AS article_no,ref.daily_sales::text AS daily_sales,
        ref.return_rate::text AS return_rate,ref.estimated_returns,ref.target_days,ref.source_note,ref.reference_date
      FROM skus s JOIN products pr ON pr.id=s.product_id CROSS JOIN warehouses w
      LEFT JOIN inventory_balances b ON b.sku_id=s.id AND b.warehouse_id=w.id
      LEFT JOIN inventory_sku_references ref ON ref.sku_id=s.id
      LEFT JOIN shipment_stock sh ON sh.sku_id=s.id AND sh.warehouse_id=w.id
      WHERE ${conditions.join(" AND ")}
    ), grouped AS (
      SELECT group_key AS id,min(sku_id) AS sort_id,min(product_id) AS product_id,
        bool_or(compass_matched) AS compass_matched,
        ${skuView ? "min(sku_id)" : "NULL::bigint"} AS sku_id,
        ${skuView ? "min(sku_code)" : "CASE WHEN count(DISTINCT sku_id)=1 THEN min(sku_code) END"} AS sku_code,
        ${skuView ? "min(barcode)" : "NULL::text"} AS barcode,
        min(style_no) AS style_no,min(product_name) AS product_name,min(main_image_url) AS main_image_url,
        min(supplier_style_code) AS supplier_style_code,
        ${dimension === "style" ? "NULL::text" : "min(article_no)"} AS article_no,
        CASE WHEN count(DISTINCT color_name)=1 THEN min(color_name) ELSE '多颜色' END AS color_name,
        ${skuView ? "min(size_name)" : "NULL::text"} AS size_name,
        CASE WHEN count(DISTINCT warehouse_id)=1 THEN min(warehouse_id) END AS warehouse_id,
        CASE WHEN count(DISTINCT warehouse_id)=1 THEN min(warehouse_name) ELSE '全部仓库' END AS warehouse_name,
        ${stockFields.map((k) => `sum(${k}) AS ${k}`).join(",")},
        ${[
          "daily_sales",
          "return_rate",
          "estimated_returns",
          "target_days",
          "source_note",
          "reference_date",
        ]
          .map((k) => `${skuView ? `max(${k})` : "NULL"} AS ${k}`)
          .join(",")}
      FROM stock GROUP BY group_key
    ), coverage AS (
      SELECT count(*)::int AS coverage_total,count(*) FILTER(WHERE compass_matched)::int AS coverage_matched
      FROM grouped
    ), filtered AS (
      SELECT * FROM grouped WHERE ${reportCondition}
    ), totals AS (
      SELECT count(*)::int AS group_count,
        ${stockFields.map((k) => `COALESCE(sum(${k}),0) AS total_${k}`).join(",")}
      FROM filtered
    )
    SELECT totals.*,coverage.*,i.id::text AS source_id,i.file_name AS source_file_name,
      i.start_date::text AS source_start_date,i.end_date::text AS source_end_date,i.normalization_version AS source_version,
      rw.start_date::text AS window_start_date,rw.end_date::text AS window_end_date,hc.covered_days AS window_covered_days,page.*
    FROM totals CROSS JOIN coverage CROSS JOIN history_coverage hc LEFT JOIN compass_source i ON true
    LEFT JOIN reference_window rw ON true LEFT JOIN LATERAL (
      SELECT * FROM filtered ORDER BY ${skuView ? "compass_matched DESC," : ""}sort_id,id LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}
    ) page ON true`,
    ...vals,
  );
  const quantity = (value: unknown) => {
    const n = Number(String(value));
    if (!Number.isSafeInteger(n) || n < 0)
      fail("INVENTORY_SUMMARY_RANGE", "库存汇总数量超出可展示范围", 422);
    return n;
  };
  const first = result[0];
  const source = first.source_id
    ? {
        id: first.source_id,
        file_name: first.source_file_name,
        start_date: first.source_start_date,
        end_date: first.source_end_date,
        normalization_version: first.source_version,
      }
    : null;
  const window = {
    period: referencePeriod,
    start_date: first.window_start_date || null,
    end_date: first.window_end_date || null,
    days: first.window_start_date
      ? Math.round((Date.parse(first.window_end_date) - Date.parse(first.window_start_date)) / 86400000) + 1
      : 0,
    covered_days: first.window_covered_days,
    complete: false,
    method: "frequent" as const,
  };
  window.complete = !!source && window.days > 0 && window.covered_days === window.days;
  const totals = Object.fromEntries(
    stockFields.map((k) => [k, quantity(first["total_" + k])]),
  );
  const data = result
    .filter((r) => r.id != null)
    .map((r) => {
      const record = Object.fromEntries(
        Object.entries(r).filter(
          ([k]) =>
            !k.startsWith("total_") &&
            !k.startsWith("source_") &&
            !k.startsWith("coverage_") &&
            !k.startsWith("window_") &&
            !["group_count", "sort_id"].includes(k),
        ),
      );
      for (const k of stockFields) record[k] = quantity(record[k]);
      return record;
    });
  const references = skuView
    ? (await applyCompassReferences(data, tx, source, window)).map(calculateReference)
    : data;
  return {
    data:
      dimension === "style"
        ? references
        : await applyCompassImages(references, tx, source),
    ...p,
    total: first.group_count,
    totals,
    dimension,
    ...(skuView
      ? {
          report_coverage: {
            total: first.coverage_total,
            matched: first.coverage_matched,
            unmatched: first.coverage_total - first.coverage_matched,
            source,
            window,
          },
        }
      : {}),
  };
}

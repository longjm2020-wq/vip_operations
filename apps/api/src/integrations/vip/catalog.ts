import { db, one, rows } from "../../../../../packages/database/src/index.js";
import { pagination, parse } from "../../core.js";
import { listingCatalogQuerySchema } from "./listing.js";

export const listingCatalogCte = `WITH observations AS (
  SELECT c.*,l.state AS last_known_listing_state,l.result_code,l.last_changed_at,l.time_warning,
    l.checked_at,l.last_error AS listing_error,
    CASE WHEN c.style_no='' THEN 'barcode:'||lower(c.barcode) ELSE 'style:'||c.style_no END AS style_key,
    CASE WHEN l.last_error IS NOT NULL THEN 'ERROR' WHEN l.checked_at IS NULL THEN 'UNKNOWN'
      WHEN l.checked_at<now()-interval '2 hours' THEN 'STALE' ELSE l.state END AS barcode_listing_state
  FROM vop_catalog c LEFT JOIN vop_listing_states l ON l.namespace=c.namespace AND l.barcode_key=lower(c.barcode)
), unique_barcodes AS (
  SELECT DISTINCT namespace,style_key,lower(barcode) AS barcode_key,barcode_listing_state FROM observations
), style_counts AS (
  SELECT namespace,style_key,count(*) AS style_barcode_count,
    count(*) FILTER(WHERE barcode_listing_state='LISTED') AS style_listed_count,
    count(*) FILTER(WHERE barcode_listing_state='UNLISTED') AS style_unlisted_count,
    count(*) FILTER(WHERE barcode_listing_state IN ('UNKNOWN','ERROR','STALE')) AS style_unknown_count,
    CASE WHEN bool_and(barcode_listing_state='LISTED') THEN 'LISTED'
      WHEN bool_and(barcode_listing_state='UNLISTED') THEN 'UNLISTED'
      WHEN bool_and(barcode_listing_state IN ('LISTED','UNLISTED')) THEN 'PARTIAL'
      WHEN bool_and(barcode_listing_state='UNPUBLISHED') THEN 'UNPUBLISHED'
      WHEN bool_and(barcode_listing_state='NOT_FOUND') THEN 'NOT_FOUND' ELSE 'UNKNOWN' END AS style_listing_state
  FROM unique_barcodes GROUP BY namespace,style_key
), catalog AS (
  SELECT o.*,g.style_barcode_count,g.style_listed_count,g.style_unlisted_count,g.style_unknown_count,g.style_listing_state
  FROM observations o JOIN style_counts g ON g.namespace=o.namespace AND g.style_key=o.style_key
)`;

export async function platformCatalog(query: Record<string, unknown>) {
  const p = pagination(query);
  const filter = parse(listingCatalogQuerySchema, query);
  const where = filter.state ? "WHERE c.style_listing_state=$1" : "";
  const values: string[] = filter.state ? [filter.state] : [];
  const list = await rows(
    db,
    `${listingCatalogCte}
    SELECT c.namespace,c.external_key,c.barcode,c.style_no,c.product_name,c.cooperation_no,c.warehouse,c.source_updated_at,
      c.barcode_listing_state,c.last_known_listing_state,c.result_code,c.time_warning,c.listing_error,
      c.style_listing_state,c.style_barcode_count,c.style_listed_count,c.style_unlisted_count,c.style_unknown_count,
      to_char(c.checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS listing_checked_at,
      to_char(c.last_changed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_listing_change_at,
      d.detail,to_char(d.synced_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS detail_synced_at,
      to_char(c.synced_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS synced_at
    FROM catalog c LEFT JOIN vop_product_details d ON d.namespace=c.namespace AND d.barcode=c.barcode ${where}
    ORDER BY c.synced_at DESC,c.namespace,c.external_key LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    ...values,
    p.pageSize,
    (p.page - 1) * p.pageSize,
  );
  const total = (await one(
    db,
    `${listingCatalogCte} SELECT count(*) AS total FROM catalog c ${where}`,
    ...values,
  ))!.total;
  return { items: list, total: Number(total), ...p };
}

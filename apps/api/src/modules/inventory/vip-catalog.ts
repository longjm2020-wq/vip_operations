import {
  rows,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import type { InventoryDimension } from "../../../../../packages/contracts/src/inventory-summary.js";
import { listingCatalogCte } from "../../integrations/vip/catalog.js";
import { imageUrl } from "../../integrations/vip/details.js";

const code = (value: unknown) => String(value ?? "").trim();
const barcode = (row: Row) =>
  (code(row.barcode) || code(row.sku_code)).toLowerCase();
const emptyTimes = {
  listing_checked_at: null,
  last_listing_change_at: null,
  last_listing_change_type: null,
  time_warning: null,
};

/** One row per matching key, so status filters cannot multiply stock balances.
 * Keep the same namespace/style ambiguity rules as the page projection below.
 * Style state always covers the full platform style, before inventory filters.
 */
export const inventoryListingCte = `${listingCatalogCte}, inventory_catalog_keys AS (
  SELECT DISTINCT namespace,style_no,lower(barcode) AS barcode_key,barcode_listing_state,style_listing_state
  FROM catalog
), inventory_barcode_status AS (
  SELECT barcode_key,count(*) AS matches,min(style_no) AS style_no,
    min(barcode_listing_state) AS barcode_listing_state
  FROM inventory_catalog_keys GROUP BY barcode_key
), inventory_style_status AS (
  SELECT style_no,CASE WHEN count(DISTINCT namespace)=1 THEN min(style_listing_state) ELSE 'AMBIGUOUS' END AS style_listing_state
  FROM inventory_catalog_keys GROUP BY style_no
)`;

/** Read existing observations once per page, in the inventory query's snapshot.
 * Never join catalog rows into inventory sums or select an arbitrary vendor.
 */
export async function applyVipInventoryCatalog(
  data: Row[],
  dimension: InventoryDimension,
  tx: Tx,
): Promise<Row[]> {
  if (!data.length) return data;
  const styles = [
    ...new Set(data.map((row) => code(row.style_no)).filter(Boolean)),
  ];
  const barcodes = [
    ...new Set(
      dimension === "sku"
        ? data.map(barcode).filter(Boolean)
        : dimension === "article"
          ? data.flatMap((row) => row.inventory_barcode_keys ?? [])
          : [],
    ),
  ];
  const catalog = await rows(
    tx,
    `${listingCatalogCte}
    SELECT DISTINCT ON (c.namespace,c.style_no,lower(c.barcode)) c.namespace,c.style_no,lower(c.barcode) AS barcode_key,
      c.barcode_listing_state,c.last_known_listing_state,(c.listing_error IS NOT NULL) AS listing_error,
      c.style_listing_state,c.style_barcode_count,c.style_listed_count,c.style_unlisted_count,c.style_unknown_count,
      to_char(c.checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS listing_checked_at,
      to_char(c.last_changed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_listing_change_at,
      c.last_change_type AS last_listing_change_type,c.time_warning,
      d.detail->'images'->>0 AS platform_image,
      d.detail->'productImages'->>0 AS platform_variant_image,
      to_char(d.synced_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS image_synced_at
    FROM catalog c LEFT JOIN vop_product_details d ON d.namespace=c.namespace AND d.barcode=c.barcode
    WHERE c.style_no=ANY($1::text[]) OR lower(c.barcode)=ANY($2::text[])
    ORDER BY c.namespace,c.style_no,lower(c.barcode),d.synced_at DESC NULLS LAST,c.source_updated_at DESC,c.external_key`,
    styles,
    barcodes,
  );
  const byStyle = new Map<string, Row[]>(),
    byBarcode = new Map<string, Row[]>();
  for (const row of catalog) {
    for (const [map, key] of [
      [byStyle, row.style_no],
      [byBarcode, row.barcode_key],
    ] as const) {
      const group = map.get(key) ?? [];
      group.push(row);
      map.set(key, group);
    }
  }
  return data.map((row) => {
    const { inventory_barcode_keys: memberCodes, ...inventory } = row;
    const styleRows = byStyle.get(code(row.style_no)) ?? [];
    const namespaces = new Set(styleRows.map((item) => item.namespace));
    const style = namespaces.size === 1 ? styleRows[0] : undefined;
    const result: Row = {
      ...inventory,
      // Unlabelled archive main images and legacy mixed platform galleries
      // are style representatives, not evidence of this row's color.
      main_image_url:
        dimension !== "style" &&
        (!inventory.inventory_image || row.color_name === "多颜色")
          ? null
          : inventory.main_image_url,
      ...emptyTimes,
      listing_scope: dimension === "sku" ? "barcode" : "style",
      barcode_listing_state: "UNMATCHED",
      last_known_listing_state: null,
      listing_error: false,
      style_listing_state:
        style?.style_listing_state ??
        (namespaces.size > 1 ? "AMBIGUOUS" : "UNMATCHED"),
      ...Object.fromEntries(
        [
          "style_barcode_count",
          "style_listed_count",
          "style_unlisted_count",
          "style_unknown_count",
        ].map((key) => [key, style ? Number(style[key]) : null]),
      ),
    };
    if (dimension !== "style" && row.color_name === "多颜色")
      delete result.inventory_image;
    const useImage = (candidates: Row[]) => {
      // Only explicitly separated product pictures can override an exact
      // Compass color match. Old mixed galleries remain usable for style view.
      const imageField =
        dimension === "style" ? "platform_image" : "platform_variant_image";
      const image = candidates
        .filter(
          (item) =>
            typeof item[imageField] === "string" && imageUrl(item[imageField]),
        )
        .sort(
          (a, b) =>
            (b.image_synced_at ?? "").localeCompare(a.image_synced_at ?? "") ||
            a.barcode_key.localeCompare(b.barcode_key),
        )[0];
      if (image) {
        result.main_image_url = imageUrl(image[imageField]);
        result.inventory_image = {
          source: "vip",
          matched_by: dimension,
          style_no: image.style_no,
          barcode: image.barcode_key,
          synced_at: image.image_synced_at,
        };
      }
    };
    if (dimension === "sku") {
      const candidates = byBarcode.get(barcode(row)) ?? [];
      // A barcode used for another style or by multiple connections is not a safe match.
      const sameStyle = candidates.filter(
        (item) => item.style_no === code(row.style_no),
      );
      const matched =
        sameStyle.length === 1 && candidates.length === 1
          ? sameStyle[0]
          : undefined;
      if (!matched) {
        result.barcode_listing_state =
          candidates.length > 1
            ? "AMBIGUOUS"
            : candidates.length
              ? "CONFLICT"
              : "UNMATCHED";
        return result;
      }
      for (const key of [
        ...Object.keys(emptyTimes),
        "barcode_listing_state",
        "last_known_listing_state",
        "listing_error",
      ])
        result[key] = matched[key];
      useImage([matched]);
      return result;
    }
    if (!style) return result;
    if (dimension === "style") useImage(styleRows);
    else if (row.color_name !== "多颜色" && Array.isArray(memberCodes))
      useImage(
        styleRows.filter(
          (item) =>
            memberCodes.includes(item.barcode_key) &&
            byBarcode.get(item.barcode_key)?.length === 1,
        ),
      );
    // The aggregate dates describe the entire known platform style, not this
    // warehouse, article, or current page. Missing checks must remain missing.
    const checks = styleRows
      .map((item) => item.listing_checked_at)
      .filter(Boolean)
      .sort();
    result.listing_checked_at =
      checks.length === styleRows.length ? checks[0] : null;
    result.time_warning = styleRows.some((item) => item.time_warning)
      ? "LISTING_TIME_UNVERIFIED"
      : null;
    const latest =
      styleRows
        .map((item) => item.last_listing_change_at)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null;
    result.last_listing_change_at = latest;
    const operations = new Set(
      styleRows
        .filter((item) => item.last_listing_change_at === latest)
        .map((item) => item.last_listing_change_type),
    );
    result.last_listing_change_type =
      latest && operations.size === 1 ? [...operations][0] : null;
    return result;
  });
}

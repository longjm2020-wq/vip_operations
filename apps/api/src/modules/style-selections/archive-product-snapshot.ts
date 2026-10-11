import { archiveFieldIds } from "../../../../../packages/contracts/src/product-archive.js";
import { camel, type Row } from "../../../../../packages/database/src/index.js";

/** Read-only counterpart of migration 049's sync_product_archive_record INSERT.
 * A missing archive row must be checked as the existing product it represents;
 * previewing an import must not create that row merely to discover its values.
 */
export function archiveProductSnapshot(raw: Row, actorId: string): Row {
  const item = camel(raw), custom: Row = item.customFields || {};
  const extras: Row = {};
  for (const key of ["name", "categoryId", "brandId", "defaultSupplierId", "year", "season", "remark", "status"])
    extras["custom:product:" + key] = item[key] == null ? "" : String(item[key]);
  Object.assign(extras, Object.fromEntries(Object.entries(custom).map(([key, value]) => ["custom:product:" + key, value == null ? "" : String(value)])));
  return { product_id: item.id, xuti_style_no: item.styleNo,
    supplier_style_no: custom[archiveFieldIds.supplierStyle] ?? null,
    color: custom[archiveFieldIds.customColor] ?? null,
    size_range: custom[archiveFieldIds.sizeRange] ?? null,
    material: custom[archiveFieldIds.composition] ?? null,
    supply_price_excl_tax: custom[archiveFieldIds.unitPrice] === "" ? null : custom[archiveFieldIds.unitPrice] ?? null,
    tag_price: item.tagPrice ?? null,
    images: item.mainImageUrl ? [{ id: `product-${item.id}`, url: item.mainImageUrl, color: "" }] : [],
    extra_fields: extras, created_by: actorId, updated_by: actorId,
    created_at: item.createdAt, updated_at: item.updatedAt };
}

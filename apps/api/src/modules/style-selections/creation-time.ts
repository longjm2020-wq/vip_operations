import { selectionScope, selectionSchema } from "../../../../../packages/database/src/selection-scope.js";
import { one, type Row, type Tx } from "../../../../../packages/database/src/index.js";
import { formatSelectionCreatedTime } from "../../../../../packages/contracts/src/selection-created-time.js";
import { fail } from "../../core.js";

export const selectionCreatedTimeRevision = "content-created-time-v2";

/** Physical row creation remains audit metadata; the business date can be pending. */
export function selectionCreatedAtSql() {
  const scope = selectionScope.getStore();
  if (scope) selectionSchema(scope);
  return "s.content_created_at";
}

export function selectionBusinessCreatedAt(row: Row | null | undefined): unknown {
  if (!row) return null;
  if (Object.hasOwn(row, "content_created_at")) return row.content_created_at;
  if (Object.hasOwn(row, "contentCreatedAt")) return row.contentCreatedAt;
  return row.created_at ?? row.createdAt ?? null;
}
export function hasSelectionCreationContent(row: Row): boolean {
  return !!String((Object.hasOwn(row, "xutiStyleNo") ? row.xutiStyleNo : row.xuti_style_no) ?? "").trim()
    || !!String((Object.hasOwn(row, "supplierStyleNo") ? row.supplierStyleNo : row.supplier_style_no) ?? "").trim()
    || Array.isArray(row.images) && row.images.length > 0;
}
export async function validateSelectionCreatedTimeWrite(tx: Tx, before: Row | null, patch: Row) {
  if (!Object.hasOwn(patch, "createdAt") || selectionBusinessCreatedAt(before) !== null) return;
  if (hasSelectionCreationContent({ ...(before || {}), ...patch })) return;
  const scope = selectionScope.getStore();
  if (scope) {
    const table = await one(tx, "SELECT initial_layout,system_key FROM public.project_tables WHERE id=$1::bigint", scope);
    if (table && table.system_key !== "PRODUCT_ARCHIVE" && ["blank", "empty"].includes(table.initial_layout)) return;
  }
  fail("CREATION_TIME_PENDING", "请先填写商品图片、序缇款号或供应商款号中的任意一项，再填写创建时间；首次录入也可同时导入历史日期", 400);
}

export const selectionCreatedAtText = (value: unknown) => formatSelectionCreatedTime(value);

/** Creation time is metadata, but searching/sorting its business column must respect that column's protection. */
export function readableSelectionCreatedAt(row: Record<string, any>) {
  return row.hiddenCells?.includes("registrationBatch") || row.cellAccess?.registrationBatch === "deny"
    ? null : row.createdAt;
}

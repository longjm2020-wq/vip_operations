import { selectionScope, selectionSchema } from "../../../../../packages/database/src/selection-scope.js";
import { formatSelectionCreatedTime } from "../../../../../packages/contracts/src/selection-created-time.js";

export const selectionCreatedTimeRevision = "system-created-time-v1";

/** Keep the original sheet timestamp for audit; archived products supply their own creation time. */
export function selectionCreatedAtSql() {
  const scope = selectionScope.getStore();
  if (!scope) return "s.created_at";
  selectionSchema(scope); // Workspace IDs are validated before becoming an internal SQL identifier/value.
  return `COALESCE((SELECT product.created_at FROM public.products product
    JOIN public.project_tables workspace ON workspace.id=${scope}::bigint AND workspace.system_key='PRODUCT_ARCHIVE'
    WHERE product.id=s.product_id),s.created_at)`;
}

export const selectionCreatedAtText = (value: unknown) => formatSelectionCreatedTime(value);

/** Creation time is metadata, but searching/sorting its business column must respect that column's protection. */
export function readableSelectionCreatedAt(row: Record<string, any>) {
  return row.hiddenCells?.includes("registrationBatch") || row.cellAccess?.registrationBatch === "deny"
    ? null : row.createdAt;
}

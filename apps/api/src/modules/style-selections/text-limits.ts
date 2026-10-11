import { rows, camel, snake, type Row, type Tx } from "../../../../../packages/database/src/index.js";
import { selectionScope, selectionSchema } from "../../../../../packages/database/src/selection-scope.js";
import { selectionFieldSchema, type SelectionField } from "../../../../../packages/contracts/src/selection-layout.js";
import { fieldValueError } from "../../../../../packages/contracts/src/selection-field-validation.js";
import { selectionFields } from "../../../../../packages/contracts/src/selection-protection.js";
import { archiveMappedFields } from "../../../../../packages/contracts/src/product-archive-table.js";
import { fail } from "../../core.js";

export async function lockTextDefinitions(tx: Tx, workspace = selectionScope.getStore() || "default") {
  await rows(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text", `selection-layout-shared:${workspace}`);
}

export function textLimitDefinitions(registry: Row[]): SelectionField[] {
  return registry.flatMap(row => {
    const parsed = selectionFieldSchema.safeParse(row.definition);
    return parsed.success && ((parsed.data.type || parsed.data.fallbackType || "text") === "text" || parsed.data.textConfig) ? [parsed.data] : [];
  });
}

export function assertTextPatch(fields: SelectionField[], patch: Row) {
  for (const field of fields) {
    const container = field.key.startsWith("custom:") ? patch.extraFields : patch;
    if (!container || !Object.hasOwn(container, field.key)) continue;
    const issue = (field.type || field.fallbackType || "text") === "text"
      ? fieldValueError(field, container[field.key]) : null;
    if (issue) fail("VALIDATION_ERROR", `字段「${field.label}」：${issue}`, 400);
  }
}

/** The definition lock prevents a row write racing a successful limit reduction. */
export async function assertPersistedTextLimit(tx: Tx, field: SelectionField, previous?: SelectionField) {
  if (!field.textConfig || (field.type || field.fallbackType || "text") !== "text") return;
  if (previous && (previous.type || previous.fallbackType || "text") === "text" &&
    previous.textConfig?.countMode === field.textConfig.countMode &&
    previous.textConfig.maxLength === field.textConfig.maxLength) return;
  const custom = field.key.startsWith("custom:");
  if (!custom && !selectionFields.includes(field.key))
    fail("VALIDATION_ERROR", "文本限制字段无效，请重新读取表格", 400);
  const valueSql = custom ? "extra_fields->>$1" : snake(field.key);
  let cursor = "0";
  for (;;) {
    const batch = await rows(tx, `SELECT id,${valueSql} AS value FROM style_selections WHERE id>$${custom ? 2 : 1}::bigint ORDER BY id LIMIT 500`, ...(custom ? [field.key, cursor] : [cursor]));
    for (const row of batch)
      if (fieldValueError(field, row.value))
        fail("VALIDATION_ERROR", `字段「${field.label}」已有内容超过所设上限，请先调整内容或提高限制；本次设置未保存`, 400);
    if (batch.length < 500) return;
    cursor = String(batch[batch.length - 1].id);
  }
}

/** Product details/imports are mirrored by database triggers, outside sheet persist(). */
export async function assertArchiveProductTextLimits(tx: Tx, product: Row) {
  const tables = await rows(tx, "SELECT id FROM public.project_tables WHERE system_key='PRODUCT_ARCHIVE'");
  for (const table of tables) {
    const workspace = String(table.id);
    // Product writers and archive layout updates take the business lock first.
    await lockTextDefinitions(tx, workspace);
    const fields = textLimitDefinitions(await rows(tx, "SELECT definition FROM public.selection_field_registry WHERE workspace_key=$1", workspace));
    if (!fields.length) continue;
    const row = camel(product), extras: Row = {};
    for (const key of ["name", "categoryId", "brandId", "defaultSupplierId", "year", "season", "remark", "status"])
      extras["custom:product:" + key] = row[key];
    for (const [key, value] of Object.entries(row.customFields || {}))
      extras["custom:product:" + key] = value;
    const patch: Row = { xutiStyleNo: row.styleNo, tagPrice: row.tagPrice, extraFields: extras };
    for (const [column, id] of Object.entries(archiveMappedFields)) patch[column] = row.customFields?.[id];
    assertTextPatch(fields, patch);
    // Trigger-created archive rows can preserve table-only fields; validate
    // their existing values as well when a product update changes the mirror.
    if (row.id) {
      const linked = await rows(tx, `SELECT * FROM "${selectionSchema(workspace)}".style_selections WHERE product_id=$1::bigint`, row.id);
      for (const existing of linked) {
        const stored = camel(existing);
        assertTextPatch(fields, { ...stored, ...patch, extraFields: { ...stored.extraFields, ...extras } });
      }
    }
  }
}

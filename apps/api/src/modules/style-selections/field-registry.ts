import { z } from "zod";
import { rows, one, type Tx, type Row } from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import { selectionFieldSchema, selectionLayoutSchema, projectSelectionSharedLayout, type SelectionField, type SelectionLayout } from "../../../../../packages/contracts/src/selection-layout.js";
import { audit, command, fail, parse, canonical, type Context } from "../../core.js";
import { assertPersistedTextLimit } from "./text-limits.js";
import { selectionFields } from "../../../../../packages/contracts/src/selection-protection.js";

const workspaceKey = () => selectionScope.getStore() || "default";
const superAdmin = (c: Context) => !!c.actor.roleCodes?.includes("SUPER_ADMIN");
export async function readFieldRegistry(tx: Tx, workspace = workspaceKey()): Promise<Row[]> {
  return rows(tx, "SELECT * FROM public.selection_field_registry WHERE workspace_key=$1 ORDER BY field_key", workspace);
}
export function registeredField(row: Row): SelectionField {
  return selectionFieldSchema.parse({ ...row.definition, ...(row.owner_id ? { ownerId: String(row.owner_id) } : {}), visibility: row.visibility, fieldRevision: row.revision });
}
function definition(field: SelectionField): SelectionField {
  const { ownerId: _owner, visibility: _scope, fieldRevision: _revision, ...value } = field;
  return value;
}
function semantic(field: SelectionField) {
  const { width: _width, ...value } = definition(field);
  return canonical(value);
}
const priceLimitField = (field: SelectionField) => (field.type || field.fallbackType) === "vipTagPriceLimit";
/** Resolve references against owned changes and canonical definitions, never forged snapshots. */
function validatePriceLimitSources(c: Context, fields: SelectionField[], registry: Row[], allowUnownedChanges = false) {
  const definitions = new Map(registry.map(row => [row.field_key, registeredField(row)]));
  for (const field of fields) {
    const saved = definitions.get(field.key);
    if (!saved || !field.key.startsWith("custom:") || superAdmin(c) || saved.ownerId === c.actor.id ||
      allowUnownedChanges && !saved.ownerId && c.actor.permissions.includes("selection.manage")) {
      definitions.set(field.key, { ...field, ownerId: saved?.ownerId || c.actor.id, visibility: saved?.visibility || "PRIVATE" });
    }
  }
  for (const field of definitions.values()) {
    if (!priceLimitField(field) || field.deleted) continue;
    if (!field.key.startsWith("custom:") || field.key.startsWith("custom:product:"))
      fail("VALIDATION_ERROR", "唯品吊牌限价须使用新建自定义字段，不能替换商品固定字段", 400);
    const sourceKey = field.vipTagPriceLimitConfig?.sourceKey;
    const source = sourceKey ? definitions.get(sourceKey) : undefined;
    // Built-in fields do not necessarily have a registry row. Their default
    // business type is text; customized definitions above retain their type.
    const builtin = !!sourceKey && ["xutiStyleNo", "supplierStyleNo", "supplierCode", "color", "sizeRange", "material", "sellingPoints"].includes(sourceKey);
    if (!sourceKey || sourceKey === field.key || !source && !builtin || source?.deleted ||
      source && !["text", "single"].includes(source.type || source.fallbackType || "text"))
      fail("VALIDATION_ERROR", "吊牌限价的三级类目来源不存在、已删除或类型不支持；请先调整关联字段", 400);
    if (source?.visibility === "PRIVATE" && !superAdmin(c) && source.ownerId !== c.actor.id && field.ownerId === c.actor.id)
      fail("FORBIDDEN", "吊牌限价的三级类目来源不可访问，请重新选择来源字段", 403);
    if (field.visibility === "PUBLIC" && source?.visibility === "PRIVATE")
      fail("VALIDATION_ERROR", "公开的吊牌限价字段不能关联私有来源，请先公开三级类目来源字段", 400);
    if (source?.visibility === "PRIVATE" && field.ownerId !== source.ownerId && !superAdmin(c))
      fail("VALIDATION_ERROR", "三级类目来源仍被自动限价字段引用，当前修改会使其不可访问；请先调整关联字段", 400);
  }
}
async function assertUnusedFieldKey(tx:Tx,key:string) {
  const orphan = await one(tx,`SELECT 1 FROM style_selections WHERE extra_fields ? $1 OR
    cell_colors ? $1 OR cell_alignments ? $1 OR cell_vertical_alignments ? $1 OR
    cell_text_colors ? $1 OR cell_number_formats ? $1 LIMIT 1`,key);
  if (orphan) fail("VALIDATION_ERROR","字段标识不可使用，请重新添加字段或选择其他目标字段",400);
}
export async function registerArchiveFields(tx: Tx, _c: Context, fields: SelectionField[], workspace = workspaceKey()) {
  for (const field of fields.filter(field => field.key.startsWith("custom:product:")))
    await rows(tx, `INSERT INTO public.selection_field_registry(workspace_key,table_id,field_key,visibility,definition)
      VALUES($1,$2::bigint,$3,'PUBLIC',$4::jsonb) ON CONFLICT(workspace_key,field_key) DO NOTHING`,
      workspace, workspace === "default" ? null : workspace, field.key, JSON.stringify(definition(field)));
}
/** Definitions and references are filtered together; even a group name can reveal a private field. */
export async function canonicalizeLayout(tx: Tx, c: Context, preferences: SelectionLayout, workspace = workspaceKey()): Promise<SelectionLayout> {
  const registry = await readFieldRegistry(tx, workspace), byKey = new Map(registry.map(row => [row.field_key, row]));
  const visible = (row: Row) => superAdmin(c) || row.visibility === "PUBLIC" || String(row.owner_id) === c.actor.id;
  let columns = preferences.columns.flatMap<SelectionField>(field => {
    if (!field.key.startsWith("custom:")) {
      const { textConfig: _clientLimit, ...value } = definition(field);
      const savedLimit = byKey.get(field.key)?.definition?.textConfig;
      return [{ ...value, ...(savedLimit ? { textConfig: savedLimit } : {}), visibility: "PUBLIC" as const }];
    }
    const row = byKey.get(field.key);
    return row && visible(row) ? [{ ...registeredField(row), width: field.width }] : [];
  });
  const present = new Set(columns.map(field => field.key));
  for (const row of registry) if (row.field_key.startsWith("custom:") && visible(row) && !present.has(row.field_key)) columns.push(registeredField(row));
  // Historical invalid references must never disclose another user's private
  // field key through an otherwise public computed definition.
  columns = columns.flatMap(field => {
    const sourceKey = field.vipTagPriceLimitConfig?.sourceKey;
    if (!sourceKey?.startsWith("custom:") || !!byKey.get(sourceKey) && visible(byKey.get(sourceKey)!)) return [field];
    // A dormant config may be kept for switching types back. Its previous
    // source identifier is still private even while the field is ordinary.
    return priceLimitField(field) ? [] : [{ ...field, vipTagPriceLimitConfig: undefined }];
  });
  const keys = new Set(columns.map(field => field.key)), permitted = (key: string) => !key.startsWith("custom:") || keys.has(key);
  const columnGroups = preferences.columnGroups.filter(group => group.columnKeys.every(permitted));
  return selectionLayoutSchema.parse({ ...preferences, columns,
    hiddenColumns: preferences.hiddenColumns.filter(permitted), fixedColumns: preferences.fixedColumns.filter(permitted), columnGroups,
    columnGroupId: columnGroups.some(group => group.id === preferences.columnGroupId) ? preferences.columnGroupId : "",
    organization: { groups: preferences.organization.groups.filter(permitted), sorts: preferences.organization.sorts.filter(permitted) },
    columnFilters: Object.fromEntries(Object.entries(preferences.columnFilters).filter(([key]) => permitted(key))),
    columnSort: preferences.columnSort && permitted(preferences.columnSort.key) ? preferences.columnSort : null,
    groupBy: preferences.groupBy.startsWith("field:") && !permitted(preferences.groupBy.slice(6)) ? "none" : preferences.groupBy,
    sort: preferences.sort.startsWith("field:") && !permitted(preferences.sort.slice(6)) ? "sortOrder" : preferences.sort,
    migrationConfig: preferences.migrationConfig ? { ...preferences.migrationConfig,
      mappings: preferences.migrationConfig.mappings.filter(mapping=>permitted(mapping.source)),
      ignoredSources: preferences.migrationConfig.ignoredSources.filter(permitted) } : null,
  });
}
async function storeDefinition(tx: Tx, workspace: string, row: Row, field: SelectionField) {
  await assertPersistedTextLimit(tx, field, registeredField(row));
  await rows(tx, `UPDATE public.selection_field_registry SET definition=$3::jsonb,revision=revision+1,updated_at=now()
    WHERE workspace_key=$1 AND field_key=$2`, workspace, row.field_key, JSON.stringify(definition(field)));
  if (row.visibility === "PUBLIC") await updatePublishedField(tx, workspace, { ...field, ownerId: row.owner_id ? String(row.owner_id) : undefined, visibility: "PUBLIC", fieldRevision: row.revision + 1 });
}
/** Register new fields as private regardless of client-supplied ownership or scope. */
export async function reconcilePersonalFields(tx: Tx, c: Context, preferences: SelectionLayout): Promise<SelectionLayout> {
  const workspace = workspaceKey(), rowsBefore = await readFieldRegistry(tx, workspace), registry = new Map(rowsBefore.map(row => [row.field_key, row]));
  validatePriceLimitSources(c, preferences.columns, rowsBefore);
  for (const field of preferences.columns.filter(field => field.key.startsWith("custom:"))) {
    const row = registry.get(field.key);
    if (!row) {
      if (!/^custom:[a-zA-Z0-9:-]+$/.test(field.key) || field.key.startsWith("custom:product:")) fail("VALIDATION_ERROR", "新增字段标识无效", 400);
      // Unknown historical values have no trustworthy owner. Creating a field
      // with their key must not silently assign those values to the requester.
      await assertUnusedFieldKey(tx,field.key);
      await rows(tx, `INSERT INTO public.selection_field_registry(workspace_key,table_id,field_key,owner_id,visibility,definition)
        VALUES($1,$2::bigint,$3,$4::bigint,'PRIVATE',$5::jsonb)`, workspace, workspace === "default" ? null : workspace, field.key, c.actor.id, JSON.stringify(definition(field)));
      await audit(tx, c, "CREATE", "selection-field", null, null, { fieldKey:field.key, label: field.label, visibility: "PRIVATE" });
    } else if ((superAdmin(c) || String(row.owner_id) === c.actor.id) && semantic(field) !== semantic(registeredField(row))) {
      if (field.fieldRevision !== row.revision) fail("CONFLICT", "字段已被更新，请重新读取后编辑", 409);
      await storeDefinition(tx, workspace, row, field);
    }
  }
  return canonicalizeLayout(tx, c, preferences, workspace);
}
export async function validateSharedFieldChanges(tx: Tx, c: Context, fields: SelectionField[]) {
  await reconcileBuiltinTextFields(tx, fields);
  const workspace = workspaceKey(), registry = new Map((await readFieldRegistry(tx, workspace)).map(row => [row.field_key, row]));
  validatePriceLimitSources(c, fields, [...registry.values()], true);
  for (const field of fields.filter(field => field.key.startsWith("custom:"))) {
    const row = registry.get(field.key);
    if (!row || row.visibility !== "PUBLIC") fail("FORBIDDEN", "私有字段不能写入公开布局", 403);
    if (semantic(field) === semantic(registeredField(row))) continue;
    if (row.owner_id && String(row.owner_id) !== c.actor.id && !superAdmin(c)) fail("FORBIDDEN", "仅创建者或超级管理员可以修改此字段设置", 403);
    if (!row.owner_id && !c.actor.permissions.includes("selection.manage")) fail("FORBIDDEN", "没有修改公共字段的权限", 403);
    if (field.fieldRevision !== row.revision) fail("CONFLICT", "字段已被更新，请重新读取后编辑", 409);
    await storeDefinition(tx, workspace, row, field);
  }
}
/** Built-in limits are shared rules; no personal layout or forged owner can change them. */
export async function reconcileBuiltinTextFields(tx: Tx, fields: SelectionField[], workspace = workspaceKey(), onlyNew = false) {
  const registry = new Map((await readFieldRegistry(tx, workspace)).map(row => [row.field_key, row]));
  for (const field of fields.filter(field => !field.key.startsWith("custom:"))) {
    const row = registry.get(field.key);
    if (onlyNew && row) continue;
    if (!field.textConfig && !row) continue;
    if (!selectionFields.includes(field.key)) fail("VALIDATION_ERROR", "文本限制字段无效，请重新读取表格", 400);
    const previous = row ? registeredField(row) : undefined;
    await assertPersistedTextLimit(tx, field, previous);
    // The whole snapshot records effective type for validation while its label,
    // width and other display settings keep using the existing shared layout.
    if (row) {
      if (semantic(field) !== semantic(previous!))
        await rows(tx, "UPDATE public.selection_field_registry SET definition=$3::jsonb,revision=revision+1,updated_at=now() WHERE workspace_key=$1 AND field_key=$2", workspace, field.key, JSON.stringify(definition(field)));
    } else {
      await rows(tx, `INSERT INTO public.selection_field_registry(workspace_key,table_id,field_key,visibility,definition)
        VALUES($1,$2::bigint,$3,'PUBLIC',$4::jsonb)`, workspace, workspace === "default" ? null : workspace, field.key, JSON.stringify(definition(field)));
    }
  }
}
async function updatePublishedField(tx: Tx, workspace: string, field: SelectionField) {
  const before = await one(tx, "SELECT fields FROM public.selection_shared_fields WHERE workspace_key=$1 FOR UPDATE", workspace);
  const previous = selectionLayoutSchema.parse({ columns: before?.fields || [] }).columns;
  const fields = previous.filter(item => item.key !== field.key);
  if (field.visibility === "PUBLIC") fields.push(field);
  await rows(tx, `INSERT INTO public.selection_shared_fields(workspace_key,table_id,fields) VALUES($1,$2::bigint,$3::jsonb)
    ON CONFLICT(workspace_key) DO UPDATE SET fields=EXCLUDED.fields,revision=selection_shared_fields.revision+1,updated_at=now()`, workspace, workspace === "default" ? null : workspace, JSON.stringify(fields));
  const layout = await one(tx, "SELECT preferences FROM public.selection_shared_layouts WHERE workspace_key=$1 FOR UPDATE", workspace);
  if (!layout) return;
  const preferences = selectionLayoutSchema.parse(layout.preferences), index = preferences.columns.findIndex(item => item.key === field.key);
  if (field.visibility === "PUBLIC") {
    if (index < 0) preferences.columns.push(field);
    else preferences.columns[index] = { ...field, width: preferences.columns[index].width };
  } else preferences.columns = preferences.columns.filter(item => item.key !== field.key);
  // Private group names and all their references must disappear from the public template.
  preferences.columnGroups = preferences.columnGroups.filter(group => !group.columnKeys.includes(field.key) || field.visibility === "PUBLIC");
  const projected = projectSelectionSharedLayout(preferences);
  await rows(tx, "UPDATE public.selection_shared_layouts SET preferences=$2::jsonb,revision=revision+1,updated_at=now() WHERE workspace_key=$1", workspace, JSON.stringify(projected));
}
export async function setFieldVisibility(c: Context, key: string, input: unknown) {
  const body = parse(z.object({ public: z.boolean(), revision: z.number().int().min(1) }).strict(), input), workspace = workspaceKey();
  return command(c, "selection.field-visibility", { key, ...body }, async tx => {
    await rows(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text", `selection-layout-shared:${workspace}`);
    const row = await one(tx, "SELECT * FROM public.selection_field_registry WHERE workspace_key=$1 AND field_key=$2 FOR UPDATE", workspace, key);
    if (!row || (String(row.owner_id) !== c.actor.id && !superAdmin(c))) fail("FORBIDDEN", "仅创建者或超级管理员可以管理字段公开范围", 403);
    if (row.revision !== body.revision) fail("CONFLICT", "字段已被更新，请重新读取", 409);
    const visibility = body.public ? "PUBLIC" : "PRIVATE";
    if (row.visibility === visibility) return registeredField(row);
    const registry = await readFieldRegistry(tx, workspace);
    if (visibility === "PRIVATE" && registry.some(item => !item.definition?.deleted && priceLimitField(item.definition) &&
      item.definition?.vipTagPriceLimitConfig?.sourceKey === key && (item.visibility === "PUBLIC" || String(item.owner_id) !== String(row.owner_id))))
      fail("VALIDATION_ERROR", "此字段仍被吊牌限价字段引用，设为私有会使来源不可访问；请先调整关联限价字段的范围、删除或更换来源", 400);
    if (visibility === "PUBLIC")
      validatePriceLimitSources(c, [{ ...registeredField(row), visibility }], registry.map(item => item.field_key === key ? { ...item, visibility } : item));
    const after = await one(tx, "UPDATE public.selection_field_registry SET visibility=$3,revision=revision+1,updated_at=now() WHERE workspace_key=$1 AND field_key=$2 RETURNING *", workspace, key, visibility);
    const field = registeredField(after!);
    await updatePublishedField(tx, workspace, field);
    await audit(tx, c, "VISIBILITY", "selection-field", null, { fieldKey:key,visibility: row.visibility }, { fieldKey:key,visibility });
    return field;
  });
}
/** Called only for a validated transfer, in the destination transaction before row writes. */
export async function registerTransferredFields(tx: Tx, c: Context, workspace: string, fields: SelectionField[]) {
  await rows(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text", `selection-layout-shared:${workspace}`);
  await reconcileBuiltinTextFields(tx, fields, workspace, true);
  validatePriceLimitSources(c, fields, await readFieldRegistry(tx, workspace), true);
  for (const field of fields.filter(field => field.key.startsWith("custom:"))) {
    const row = await one(tx, "SELECT * FROM public.selection_field_registry WHERE workspace_key=$1 AND field_key=$2 FOR UPDATE", workspace, field.key);
    if (!row) {
      await assertUnusedFieldKey(tx,field.key);
      const visibility = field.visibility === "PRIVATE" ? "PRIVATE" : "PUBLIC";
      const saved = await one(tx, `INSERT INTO public.selection_field_registry(workspace_key,table_id,field_key,owner_id,visibility,definition)
        VALUES($1,$2::bigint,$3,$4::bigint,$5,$6::jsonb) RETURNING *`, workspace, workspace === "default" ? null : workspace, field.key, c.actor.id, visibility, JSON.stringify(definition(field)));
      if (visibility === "PUBLIC") await updatePublishedField(tx, workspace, registeredField(saved!));
    } else if (semantic(field) !== semantic(registeredField(row))) {
      if (row.owner_id && String(row.owner_id) !== c.actor.id && !superAdmin(c)) fail("FORBIDDEN", "目标字段选项只能由创建者或超级管理员修改", 403);
      await storeDefinition(tx, workspace, row, field);
    }
  }
}

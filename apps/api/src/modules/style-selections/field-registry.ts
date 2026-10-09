import { z } from "zod";
import { rows, one, type Tx, type Row } from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import { selectionFieldSchema, selectionLayoutSchema, projectSelectionSharedLayout, type SelectionField, type SelectionLayout } from "../../../../../packages/contracts/src/selection-layout.js";
import { audit, command, fail, parse, canonical, type Context } from "../../core.js";

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
  const columns = preferences.columns.flatMap(field => {
    if (!field.key.startsWith("custom:")) return [{ ...definition(field), visibility: "PUBLIC" as const }];
    const row = byKey.get(field.key);
    return row && visible(row) ? [{ ...registeredField(row), width: field.width }] : [];
  });
  const present = new Set(columns.map(field => field.key));
  for (const row of registry) if (visible(row) && !present.has(row.field_key)) columns.push(registeredField(row));
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
  await rows(tx, `UPDATE public.selection_field_registry SET definition=$3::jsonb,revision=revision+1,updated_at=now()
    WHERE workspace_key=$1 AND field_key=$2`, workspace, row.field_key, JSON.stringify(definition(field)));
  if (row.visibility === "PUBLIC") await updatePublishedField(tx, workspace, { ...field, ownerId: row.owner_id ? String(row.owner_id) : undefined, visibility: "PUBLIC", fieldRevision: row.revision + 1 });
}
/** Register new fields as private regardless of client-supplied ownership or scope. */
export async function reconcilePersonalFields(tx: Tx, c: Context, preferences: SelectionLayout): Promise<SelectionLayout> {
  const workspace = workspaceKey(), registry = new Map((await readFieldRegistry(tx, workspace)).map(row => [row.field_key, row]));
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
  const workspace = workspaceKey(), registry = new Map((await readFieldRegistry(tx, workspace)).map(row => [row.field_key, row]));
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

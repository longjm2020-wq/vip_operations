import {
  camel,
  db,
  one,
  rows,
  type Tx,
  type Row,
} from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import {
  selectionLayoutSchema,
  selectionLayoutWriteSchema,
  selectionSharedLayoutSchema,
  mergeSelectionFields,
  projectSelectionSharedLayout,
  applySelectionSharedLayout,
  type SelectionField,
  type SelectionLayout,
  type SelectionLayoutSnapshot,
  type SelectionSharedLayout,
} from "../../../../../packages/contracts/src/selection-layout.js";
import { selectionBaseFields } from "../../../../../packages/contracts/src/selection-migration.js";
import {
  archiveChoiceColumns,
  archiveTableFields,
} from "../../../../../packages/contracts/src/product-archive-table.js";
import {
  command,
  fail,
  parse,
  requirePermission,
  type Context,
} from "../../core.js";
import { sharedFields } from "./shared-fields.js";
import {
  readFieldRegistry,
  reconcilePersonalFields,
  canonicalizeLayout,
  registerArchiveFields,
  validateSharedFieldChanges,
} from "./field-registry.js";

const workspaceKey = () => selectionScope.getStore() || "default";
const tableIdOf = (workspace: string) =>
  workspace === "default" ? null : workspace;

async function workspaceLock(tx: Tx, workspace: string) {
  await rows(
    tx,
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
    `selection-layout-shared:${workspace}`,
  );
}
async function personalLock(tx: Tx, c: Context, workspace: string) {
  await rows(
    tx,
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
    `selection-layout:${c.actor.id}:${workspace}`,
  );
}
async function archiveColumns(tx: Tx, workspace: string) {
  if (workspace === "default") return [];
  const table = await one(
    tx,
    "SELECT system_key FROM public.project_tables WHERE id=$1::bigint",
    workspace,
  );
  return table?.system_key === "PRODUCT_ARCHIVE"
    ? archiveTableFields(
        camel(
          await rows(
            tx,
            "SELECT * FROM public.product_fields WHERE active ORDER BY created_at,id",
          ),
        ),
      )
    : [];
}
async function rawPersonal(tx: Tx, c: Context, workspace: string) {
  const stored = await one(
    tx,
    "SELECT preferences,revision FROM public.selection_layout_preferences WHERE user_id=$1::bigint AND workspace_key=$2",
    c.actor.id,
    workspace,
  );
  const oldShared = await sharedFields(tx, workspace);
  const table =
    workspace === "default"
      ? null
      : await one(
          tx,
          "SELECT system_key,initial_layout FROM public.project_tables WHERE id=$1::bigint",
          workspace,
        );
  const canonical = await archiveColumns(tx, workspace);
  const defaults: SelectionField[] =
    table?.system_key === "PRODUCT_ARCHIVE" && table.initial_layout !== "empty"
      ? canonical
      : workspace === "default" || table?.initial_layout === "selection"
        ? selectionBaseFields
        : table?.initial_layout === "blank"
          ? [
              {
                key: "custom:text",
                label: "文本",
                width: 120,
                custom: true,
                type: "text",
              },
            ]
          : [];
  const preferences = selectionLayoutSchema.parse(
    stored?.preferences || { columns: defaults },
  );
  preferences.columns = mergeSelectionFields(
    preferences.columns,
    oldShared.fields,
  );
  if (canonical.length)
    preferences.columns = archiveChoiceColumns(preferences.columns, canonical);
  return {
    stored,
    preferences,
    canonical,
    hasOldShared: !!oldShared.fields.length,
  };
}
async function rawShared(tx: Tx, workspace: string, lock = false) {
  return one(
    tx,
    "SELECT preferences,revision FROM public.selection_shared_layouts WHERE workspace_key=$1" +
      (lock ? " FOR UPDATE" : ""),
    workspace,
  );
}
async function authoritativeShared(
  tx: Tx,
  c: Context,
  stored: Row | undefined,
  canonical: SelectionField[],
): Promise<SelectionSharedLayout | null> {
  if (!stored) return null;
  const preferences = await canonicalizeLayout(
    tx,
    c,
    selectionLayoutSchema.parse(stored.preferences),
  );
  if (canonical.length)
    preferences.columns = archiveChoiceColumns(preferences.columns, canonical);
  return projectSelectionSharedLayout(preferences);
}
async function snapshot(tx: Tx, c: Context, sharedMode: boolean) {
  const workspace = workspaceKey();
  const personal = await rawPersonal(tx, c, workspace),
    shared = await rawShared(tx, workspace);
  const registry = await readFieldRegistry(tx, workspace);
  const hasVisibleFields = registry.some(
    (field) =>
      field.visibility === "PUBLIC" ||
      String(field.owner_id) === c.actor.id ||
      c.actor.roleCodes?.includes("SUPER_ADMIN"),
  );
  const sharedPreferences = await authoritativeShared(
    tx,
    c,
    shared,
    personal.canonical,
  );
  let preferences: SelectionLayout | null =
    !personal.stored && !personal.hasOldShared && !hasVisibleFields && !shared
      ? null
      : await canonicalizeLayout(tx, c, personal.preferences);
  if (sharedPreferences)
    preferences = applySelectionSharedLayout(
      preferences || selectionLayoutSchema.parse({ columns: [] }),
      sharedPreferences,
    );
  if (preferences && personal.canonical.length)
    preferences.columns = archiveChoiceColumns(
      preferences.columns,
      personal.canonical,
    );
  const result = { preferences, revision: personal.stored?.revision || 0 };
  return sharedMode
    ? {
        ...result,
        sharedRevision: shared?.revision || 0,
        sharedPreferences,
        canEditShared: c.actor.permissions.includes("selection.manage"),
      }
    : result;
}

/** Old clients receive the original shape; both protocols enforce field visibility. */
type LegacyLayoutSnapshot = {
  preferences: SelectionLayout | null;
  revision: number;
};
type SavedLayoutSnapshot = { preferences: SelectionLayout; revision: number };
type SavedSharedLayoutSnapshot = Omit<
  SelectionLayoutSnapshot,
  "preferences"
> & { preferences: SelectionLayout };
export function layoutPreferences(
  c: Context,
  sharedMode: true,
): Promise<SelectionLayoutSnapshot>;
export function layoutPreferences(
  c: Context,
  sharedMode?: false,
): Promise<LegacyLayoutSnapshot>;
export function layoutPreferences(
  c: Context,
  sharedMode: boolean,
): Promise<LegacyLayoutSnapshot | SelectionLayoutSnapshot>;
export async function layoutPreferences(c: Context, sharedMode = false) {
  return db.$transaction((tx) => snapshot(tx, c, sharedMode), {
    isolationLevel: "RepeatableRead",
  });
}

async function savePersonal(
  tx: Tx,
  c: Context,
  workspace: string,
  preferences: SelectionLayout,
) {
  return one(
    tx,
    `INSERT INTO public.selection_layout_preferences(user_id,workspace_key,table_id,preferences) VALUES($1::bigint,$2,$3::bigint,$4::jsonb)
    ON CONFLICT(user_id,workspace_key) DO UPDATE SET preferences=EXCLUDED.preferences,revision=selection_layout_preferences.revision+1,updated_at=now()
    RETURNING revision`,
    c.actor.id,
    workspace,
    tableIdOf(workspace),
    JSON.stringify(preferences),
  );
}
async function saveShared(
  tx: Tx,
  c: Context,
  workspace: string,
  preferences: SelectionSharedLayout,
) {
  return one(
    tx,
    `INSERT INTO public.selection_shared_layouts(workspace_key,table_id,preferences,updated_by) VALUES($1,$2::bigint,$3::jsonb,$4::bigint)
    ON CONFLICT(workspace_key) DO UPDATE SET preferences=EXCLUDED.preferences,revision=selection_shared_layouts.revision+1,updated_by=EXCLUDED.updated_by,updated_at=now()
    RETURNING revision`,
    workspace,
    tableIdOf(workspace),
    JSON.stringify(preferences),
    c.actor.id,
  );
}
async function registerReferencedArchiveFields(
  tx: Tx,
  c: Context,
  preferences: SelectionLayout,
  canonical: SelectionField[],
) {
  if (!canonical.length) return;
  const referenced = new Set(preferences.columns.map((field) => field.key));
  await registerArchiveFields(
    tx,
    c,
    canonical.filter((field) => referenced.has(field.key)),
  );
}

/** Private field edits and personal state never implicitly publish a full layout. */
export function saveLayoutPreferences(
  c: Context,
  input: unknown,
  sharedMode: true,
): Promise<SavedSharedLayoutSnapshot>;
export function saveLayoutPreferences(
  c: Context,
  input: unknown,
  sharedMode?: false,
): Promise<SavedLayoutSnapshot>;
export function saveLayoutPreferences(
  c: Context,
  input: unknown,
  sharedMode: boolean,
): Promise<SavedLayoutSnapshot | SavedSharedLayoutSnapshot>;
export async function saveLayoutPreferences(
  c: Context,
  input: unknown,
  sharedMode = false,
) {
  const body = parse(selectionLayoutWriteSchema, input),
    workspace = workspaceKey();
  const modern =
    sharedMode ||
    body.sharedRevision !== undefined ||
    body.sharedChanges !== undefined;
  const publishing =
    body.sharedChanges !== undefined &&
    Object.keys(body.sharedChanges).length > 0;
  if (publishing) {
    requirePermission(c.actor, "selection.manage");
    if (body.sharedRevision === undefined)
      fail("VALIDATION_ERROR", "发布共享设置需要当前版本，请重新读取表格", 400);
  }
  await command(c, "selection.layout-preferences", body, async (tx) => {
    await workspaceLock(tx, workspace);
    await personalLock(tx, c, workspace);
    const before = await one(
      tx,
      "SELECT revision FROM public.selection_layout_preferences WHERE user_id=$1::bigint AND workspace_key=$2 FOR UPDATE",
      c.actor.id,
      workspace,
    );
    if ((before?.revision || 0) !== body.revision)
      fail(
        "CONFLICT",
        "其他设备已更新个人设置，请选择使用云端设置或保留当前设置",
        409,
      );
    // Check before owned PUBLIC semantic edits: those legitimately bump the
    // shared profile themselves in this same locked transaction.
    const sharedBefore = await rawShared(tx, workspace, true);
    if (publishing && (sharedBefore?.revision || 0) !== body.sharedRevision)
      fail("CONFLICT", "其他用户已更新共享字段或布局，请重新读取后核对", 409);
    const canonical = await archiveColumns(tx, workspace);
    await registerReferencedArchiveFields(tx, c, body.preferences, canonical);
    let preferences = await reconcilePersonalFields(tx, c, body.preferences);
    if (publishing && body.sharedChanges?.columns)
      await validateSharedFieldChanges(tx, c, body.sharedChanges.columns);
    const latestShared = await rawShared(tx, workspace, true);
    let publicPreferences = await authoritativeShared(
      tx,
      c,
      latestShared,
      canonical,
    );
    if (publishing) {
      const proposed = selectionSharedLayoutSchema.parse({
        ...(publicPreferences || projectSelectionSharedLayout(preferences)),
        ...body.sharedChanges,
      });
      const decorated = await canonicalizeLayout(
        tx,
        c,
        selectionLayoutSchema.parse(proposed),
      );
      if (canonical.length)
        decorated.columns = archiveChoiceColumns(decorated.columns, canonical);
      publicPreferences = projectSelectionSharedLayout(decorated);
      await saveShared(tx, c, workspace, publicPreferences);
    }
    preferences = await canonicalizeLayout(tx, c, preferences);
    if (publicPreferences)
      preferences = applySelectionSharedLayout(preferences, publicPreferences);
    if (canonical.length)
      preferences.columns = archiveChoiceColumns(
        preferences.columns,
        canonical,
      );
    const saved = await savePersonal(tx, c, workspace, preferences);
    // Do not retain field definitions in an idempotency response: a public
    // field may be withdrawn before this request is retried.
    return { revision: saved!.revision };
  });
  const result = await layoutPreferences(c, modern);
  if (!result.preferences)
    fail("NOT_FOUND", "表格设置已不可访问，请重新读取", 404);
  return { ...result, preferences: result.preferences };
}

/** Explicitly publishes the selected editor's existing layout once. */
export async function initializeSharedLayout(c: Context) {
  requirePermission(c.actor, "selection.manage");
  const workspace = workspaceKey();
  await command(c, "selection.layout-initialize", {}, async (tx) => {
    await workspaceLock(tx, workspace);
    await personalLock(tx, c, workspace);
    const existing = await rawShared(tx, workspace, true);
    if (existing) return { revision: existing.revision };
    const source = await rawPersonal(tx, c, workspace);
    await registerReferencedArchiveFields(
      tx,
      c,
      source.preferences,
      source.canonical,
    );
    const referenced = new Set(
      source.preferences.columns
        .filter((field) => !field.deleted)
        .map((field) => field.key),
    );
    const oldRegistry = await readFieldRegistry(tx, workspace);
    for (const field of oldRegistry) {
      if (
        field.legacy &&
        field.visibility === "PRIVATE" &&
        String(field.owner_id) === c.actor.id &&
        referenced.has(field.field_key)
      )
        await rows(
          tx,
          "UPDATE public.selection_field_registry SET visibility='PUBLIC',revision=revision+1,updated_at=now() WHERE workspace_key=$1 AND field_key=$2",
          workspace,
          field.field_key,
        );
    }
    const registry = new Map(
      (await readFieldRegistry(tx, workspace)).map((field) => [
        field.field_key,
        field,
      ]),
    );
    const selected = new Map(
      source.preferences.columns.map((field) => [field.key, field]),
    );
    source.preferences = await canonicalizeLayout(tx, c, source.preferences);
    // The explicit initializer may select this editor's legacy definitions,
    // rather than silently accepting another account's seed label or type.
    source.preferences.columns = source.preferences.columns.map((field) => {
      const registered = registry.get(field.key);
      const chosen = selected.get(field.key);
      if (
        !chosen ||
        !registered?.legacy ||
        registered.visibility !== "PUBLIC" ||
        (registered.owner_id && String(registered.owner_id) !== c.actor.id)
      )
        return field;
      return {
        ...chosen,
        visibility: "PUBLIC",
        ...(registered.owner_id
          ? { ownerId: String(registered.owner_id) }
          : {}),
        fieldRevision: registered.revision,
      };
    });
    await validateSharedFieldChanges(
      tx,
      c,
      projectSelectionSharedLayout(source.preferences).columns,
    );
    const preferences = await canonicalizeLayout(tx, c, source.preferences);
    if (source.canonical.length)
      preferences.columns = archiveChoiceColumns(
        preferences.columns,
        source.canonical,
      );
    const publicPreferences = projectSelectionSharedLayout(preferences);
    const saved = await saveShared(tx, c, workspace, publicPreferences);
    await rows(
      tx,
      `INSERT INTO public.selection_shared_fields(workspace_key,table_id,fields,updated_by) VALUES($1,$2::bigint,$3::jsonb,$4::bigint)
      ON CONFLICT(workspace_key) DO UPDATE SET fields=EXCLUDED.fields,revision=selection_shared_fields.revision+1,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      workspace,
      tableIdOf(workspace),
      JSON.stringify(publicPreferences.columns),
      c.actor.id,
    );
    await savePersonal(
      tx,
      c,
      workspace,
      applySelectionSharedLayout(preferences, publicPreferences),
    );
    return { revision: saved!.revision };
  });
  const result = await layoutPreferences(c, true);
  if (!result.preferences)
    fail("NOT_FOUND", "表格设置已不可访问，请重新读取", 404);
  return { ...result, preferences: result.preferences };
}

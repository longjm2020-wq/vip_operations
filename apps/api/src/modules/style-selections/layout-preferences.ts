import {
  camel,
  db,
  one,
  rows,
} from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import {
  selectionLayoutSchema,
  selectionLayoutWriteSchema,
  mergeSelectionFields,
} from "../../../../../packages/contracts/src/selection-layout.js";
import { selectionBaseFields } from "../../../../../packages/contracts/src/selection-migration.js";
import {
  archiveChoiceColumns,
  archiveTableFields,
} from "../../../../../packages/contracts/src/product-archive-table.js";
import { command, fail, parse, type Context } from "../../core.js";
import { sharedFields } from "./shared-fields.js";

export async function layoutPreferences(c: Context) {
  const workspace = selectionScope.getStore() || "default";
  const stored = await one(
    db,
    "SELECT preferences,revision FROM public.selection_layout_preferences WHERE user_id=$1::bigint AND workspace_key=$2",
    c.actor.id,
    workspace,
  );
  const shared = await sharedFields(db, workspace);
  if (!stored && !shared.fields.length)
    return { preferences: null, revision: 0 };
  const table =
    workspace === "default"
      ? null
      : await one(
          db,
          "SELECT system_key,initial_layout FROM public.project_tables WHERE id=$1::bigint",
          workspace,
        );
  const defaults =
    workspace === "default" || table?.initial_layout === "selection"
      ? selectionBaseFields
      : table?.initial_layout === "blank"
        ? [
            {
              key: "custom:text",
              label: "文本",
              width: 120,
              custom: true,
              type: "text" as const,
            },
          ]
        : [];
  const preferences = selectionLayoutSchema.parse(
    stored?.preferences || { columns: defaults },
  );
  preferences.columns = mergeSelectionFields(
    preferences.columns,
    shared.fields,
  );
  if (table?.system_key === "PRODUCT_ARCHIVE") {
    const canonical = archiveTableFields(
      camel(
        await rows(
          db,
          "SELECT * FROM public.product_fields WHERE active ORDER BY created_at,id",
        ),
      ),
    );
    if (!stored && table.initial_layout !== "empty")
      preferences.columns = mergeSelectionFields(canonical, shared.fields);
    return {
      revision: stored?.revision || 0,
      preferences: {
        ...preferences,
        columns: archiveChoiceColumns(preferences.columns, canonical),
      },
    };
  }
  return {
    preferences,
    revision: stored?.revision || 0,
  };
}

export async function saveLayoutPreferences(c: Context, input: unknown) {
  const body = parse(selectionLayoutWriteSchema, input),
    tableId = selectionScope.getStore() || null;
  const workspace = tableId || "default";
  // The actor and workspace come exclusively from the authenticated request.
  // Read-only users may save their own view; this never writes selection records.
  return command(c, "selection.layout-preferences", body, async (tx) => {
    await rows(
      tx,
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
      `selection-layout:${c.actor.id}:${workspace}`,
    );
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
    const shared = await sharedFields(tx, workspace);
    const preferences = selectionLayoutSchema.parse({
      ...body.preferences,
      columns: mergeSelectionFields(body.preferences.columns, shared.fields),
    });
    const saved = await one(
      tx,
      `INSERT INTO public.selection_layout_preferences(user_id,workspace_key,table_id,preferences) VALUES($1::bigint,$2,$3::bigint,$4::jsonb)
      ON CONFLICT(user_id,workspace_key) DO UPDATE SET preferences=EXCLUDED.preferences,revision=selection_layout_preferences.revision+1,updated_at=now()
      RETURNING preferences,revision`,
      c.actor.id,
      workspace,
      tableId,
      JSON.stringify(preferences),
    );
    return saved;
  });
}

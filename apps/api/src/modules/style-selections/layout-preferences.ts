import { db, one, rows } from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import { selectionLayoutWriteSchema } from "../../../../../packages/contracts/src/selection-layout.js";
import { command, fail, parse, type Context } from "../../core.js";

export async function layoutPreferences(c: Context) {
  return (
    (await one(
      db,
      "SELECT preferences,revision FROM public.selection_layout_preferences WHERE user_id=$1::bigint AND workspace_key=$2",
      c.actor.id,
      selectionScope.getStore() || "default",
    )) || { preferences: null, revision: 0 }
  );
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
    return one(
      tx,
      `INSERT INTO public.selection_layout_preferences(user_id,workspace_key,table_id,preferences) VALUES($1::bigint,$2,$3::bigint,$4::jsonb)
      ON CONFLICT(user_id,workspace_key) DO UPDATE SET preferences=EXCLUDED.preferences,revision=selection_layout_preferences.revision+1,updated_at=now()
      RETURNING preferences,revision`,
      c.actor.id,
      workspace,
      tableId,
      JSON.stringify(body.preferences),
    );
  });
}

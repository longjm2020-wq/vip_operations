import { one, type Tx } from "../../../../../packages/database/src/index.js";
import {
  mergeSelectionFields,
  selectionLayoutSchema,
  type SelectionField,
} from "../../../../../packages/contracts/src/selection-layout.js";

/** Reads are reached only through the authenticated workspace guard. No row values. */
export async function sharedFields(tx: Tx, workspace: string) {
  const stored = await one(
    tx,
    "SELECT fields,revision FROM public.selection_shared_fields WHERE workspace_key=$1",
    workspace,
  );
  return {
    fields: selectionLayoutSchema.parse({ columns: stored?.fields || [] })
      .columns,
    revision: stored?.revision || 0,
  };
}

/** Transfer commits are serialized; publish only the fields actually transmitted. */
export async function shareTransferredFields(
  tx: Tx,
  workspace: string,
  incoming: SelectionField[],
  actorId: string,
) {
  const before = await sharedFields(tx, workspace);
  const fields = selectionLayoutSchema.parse({
    columns: mergeSelectionFields(before.fields, incoming),
  }).columns;
  if (fields.length === before.fields.length) return;
  await one(
    tx,
    `INSERT INTO public.selection_shared_fields(workspace_key,table_id,fields,updated_by)
    VALUES($1,$2::bigint,$3::jsonb,$4::bigint)
    ON CONFLICT(workspace_key) DO UPDATE SET fields=EXCLUDED.fields,
    revision=selection_shared_fields.revision+1,updated_by=EXCLUDED.updated_by,updated_at=now()
    RETURNING revision`,
    workspace,
    workspace === "default" ? null : workspace,
    JSON.stringify(fields),
    actorId,
  );
}

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { camel, db, json, one, rows, type Row, type Tx } from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import { command, fail, id, parse, requirePermission, type Context } from "../../core.js";
import { isArchive } from "./archive.js";
import * as protection from "./protection.js";
import { assertTextPatch } from "./text-limits.js";
import { selectionRowNumberColumn, selectionRowNumberSource } from "./row-number.js";

const deleteInput = z.object({ rows: z.array(z.object({ id, expectedUpdatedAt: z.iso.datetime() }).strict()).min(1).max(5000) }).strict();
const restoreInput = z.object({ deletions: z.array(z.object({ rowId: id, token: z.string().uuid() }).strict()).min(1).max(5000) }).strict();
const scope = () => selectionScope.getStore() || null;
const receiptReason = (token: string) => `selection-row-delete:${token}`;
type Deletion = { rowId: string; token: string };

function unique(values: string[]) {
  if (new Set(values).size !== values.length) fail("VALIDATION_ERROR", "同一操作不能重复包含一行", 400);
}
async function lock(tx: Tx, c: Context) {
  if (await isArchive(tx)) await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
  const policy = await protection.writeLocks(tx, c);
  await rows(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text", `selection-row-history:${scope() || "default"}`);
  return policy;
}
function assertDeletable(c: Context, policy: protection.Policy, row: Row, archive: boolean) {
  protection.assertFields(policy, c, row, protection.rowFields(row));
  if (archive && row.product_id) fail("PRODUCT_IN_USE", "商品档案保留商品与库存、采购的关联；仅空白草稿行可删除或恢复。", 409);
}
async function historyAudits(tx: Tx, c: Context, action: "DELETE" | "RESTORE", entries: { id: string; before: Row | null; after: Row | null; reason: string }[]) {
  // Full row snapshots stay in immutable, server-side audit records. Responses
  // contain only receipts, IDs or freshly permission-projected rows.
  await rows(tx, `INSERT INTO public.audit_logs(actor_id,actor_label,action,entity_type,entity_id,request_id,before_data,after_data,reason,selection_table_id)
    SELECT $1::bigint,$2,$3,'style-selection',entry.id::bigint,$4,entry.before,entry.after,entry.reason,$5::bigint
    FROM jsonb_to_recordset($6::jsonb) AS entry(id text,before jsonb,after jsonb,reason text)`,
  c.actor.id, c.actor.displayName, action, c.requestId, scope(), JSON.stringify(json(entries)));
}

/** The legacy single-row route shares the exact trusted deletion receipts. */
export async function deleteSingleRow(c: Context, value: string) {
  requirePermission(c.actor, "selection.manage");
  return command(c, "style-selections/delete/" + value, {}, async tx => {
    const policy = await lock(tx, c), archive = await isArchive(tx);
    const row = await one(tx, "SELECT * FROM style_selections WHERE id=$1::bigint FOR UPDATE", value);
    if (!row) fail("NOT_FOUND", "记录不存在", 404);
    assertDeletable(c, policy, row!, archive);
    const token = randomUUID();
    await rows(tx, "DELETE FROM style_selections WHERE id=$1::bigint", value);
    await historyAudits(tx, c, "DELETE", [{ id: value, before: row!, after: null, reason: receiptReason(token) }]);
    return { id: value, token };
  });
}

/** One UI deletion is atomic, including all permission and version checks. */
export async function deleteHistoryRows(c: Context, input: unknown) {
  requirePermission(c.actor, "selection.manage");
  const body = parse(deleteInput, input);
  unique(body.rows.map(row => row.id));
  return command(c, "style-selections/history/delete-rows", body, async tx => {
    const policy = await lock(tx, c), archive = await isArchive(tx);
    const before = await rows(tx, "SELECT * FROM style_selections WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE", body.rows.map(row => row.id));
    const byId = new Map(before.map(row => [String(row.id), row]));
    for (const request of body.rows) {
      const row = byId.get(request.id);
      if (!row) fail("EDIT_CONFLICT", "选中行已被删除，请刷新后核对；本次未删除任何行", 409);
      if (new Date(row!.updated_at).toISOString() !== request.expectedUpdatedAt)
        fail("EDIT_CONFLICT", "选中行已被其他人修改，请刷新后核对；本次未删除任何行", 409);
      assertDeletable(c, policy, row!, archive);
    }
    const deletions = body.rows.map(row => ({ rowId: row.id, token: randomUUID() }));
    await rows(tx, "DELETE FROM style_selections WHERE id=ANY($1::bigint[])", body.rows.map(row => row.id));
    await historyAudits(tx, c, "DELETE", deletions.map(receipt => ({ id: receipt.rowId, before: byId.get(receipt.rowId)!, after: null, reason: receiptReason(receipt.token) })));
    return { deletions };
  }, { timeout: 120000 });
}

/** Restore only this actor's most recent deletion, never a browser snapshot. */
export async function restoreHistoryRows(c: Context, input: unknown) {
  requirePermission(c.actor, "selection.manage");
  const body = parse(restoreInput, input);
  unique(body.deletions.map(row => row.rowId));
  const result = await command(c, "style-selections/history/restore-rows", body, async tx => {
    const policy = await lock(tx, c), archive = await isArchive(tx);
    const receipts = await rows(tx, `SELECT a.entity_id::text AS row_id,a.reason,a.before_data FROM public.audit_logs a
      WHERE a.entity_type='style-selection' AND a.action='DELETE' AND a.actor_id=$1::bigint
        AND a.selection_table_id IS NOT DISTINCT FROM $2::bigint AND a.entity_id=ANY($3::bigint[])
        AND a.reason=ANY($4::text[]) AND a.occurred_at>now()-interval '24 hours' AND a.before_data IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.audit_logs newer WHERE newer.entity_type=a.entity_type AND newer.entity_id=a.entity_id
          AND newer.selection_table_id IS NOT DISTINCT FROM a.selection_table_id AND newer.id>a.id)`,
    c.actor.id, scope(), body.deletions.map(row => row.rowId), body.deletions.map(row => receiptReason(row.token)));
    const byReceipt = new Map(receipts.map(row => [`${row.row_id}:${row.reason}`, row.before_data as Row]));
    const snapshots = body.deletions.map(receipt => {
      const snapshot = byReceipt.get(`${receipt.rowId}:${receiptReason(receipt.token)}`);
      if (!snapshot || String(snapshot.id) !== receipt.rowId)
        fail("HISTORY_EXPIRED", "删除记录已失效或不属于当前用户与表格，请刷新后核对", 409);
      assertDeletable(c, policy, snapshot!, archive);
      assertTextPatch(policy.textFields || [], camel(snapshot));
      return snapshot!;
    });
    const conflicts = await rows(tx, "SELECT id FROM style_selections WHERE id=ANY($1::bigint[]) FOR UPDATE", body.deletions.map(row => row.rowId));
    if (conflicts.length) fail("EDIT_CONFLICT", "需要恢复的行已存在，请刷新后核对；本次未恢复任何行", 409);
    const styleNos = snapshots.map(row => String(row.xuti_style_no || "").trim()).filter(Boolean);
    if (new Set(styleNos).size !== styleNos.length || styleNos.length && (await rows(tx, "SELECT id FROM style_selections WHERE btrim(xuti_style_no)=ANY($1::text[]) LIMIT 1", styleNos)).length)
      fail("EDIT_CONFLICT", "恢复后的序缇款号会与现有记录重复；本次未恢复任何行", 409);
    const claimants = snapshots.flatMap(row => row.claimed_by ? [String(row.claimed_by)] : []);
    if (new Set(claimants).size !== claimants.length || claimants.length && (await rows(tx, "SELECT id FROM style_selections WHERE claimed_by=ANY($1::bigint[]) LIMIT 1", claimants)).length)
      fail("ROW_CLAIMED", "原认领人已认领其他行，请先释放认领后重试；本次未恢复任何行", 409);
    // Identity, creation time, original creator, image references, ownership and
    // migration metadata come exclusively from the immutable DELETE snapshot.
    // The modification stamp advances so old collaborator writes cannot replay.
    await rows(tx, "SELECT set_config('erp.selection_history_restore','1',true)");
    const restored = await rows(tx, `INSERT INTO style_selections OVERRIDING SYSTEM VALUE
      SELECT restored.* FROM jsonb_array_elements($1::jsonb) AS snapshot,
      LATERAL jsonb_populate_record(NULL::style_selections,snapshot || jsonb_build_object(
        'version',coalesce((snapshot->>'version')::integer,0)+1,'updated_by',$2::bigint,'updated_at',clock_timestamp())) AS restored
      RETURNING *`, JSON.stringify(json(snapshots)), c.actor.id);
    await historyAudits(tx, c, "RESTORE", restored.map(row => ({ id: String(row.id), before: null, after: row, reason: "selection-row-undo" })));
    return { ids: restored.map(row => String(row.id)) };
  }, { timeout: 120000 });
  // Never cache a projected response in idempotency records: field visibility
  // or table permissions may have changed when the same request is retried.
  return db.$transaction(async tx => {
    const policy = await protection.policy(tx);
    const restored = await rows(tx, `SELECT s.*,${selectionRowNumberColumn} ${selectionRowNumberSource} WHERE s.id=ANY($1::bigint[]) ORDER BY s.id`, result.ids);
    return { rows: restored.map(row => protection.project(policy, c.actor, row)) };
  }, { isolationLevel: "RepeatableRead" });
}

export type SelectionRowDeletionReceipt = Deletion;

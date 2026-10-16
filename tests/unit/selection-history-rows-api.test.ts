import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import type { Context } from "../../apps/api/src/core.js";
import type { Row, Tx } from "../../packages/database/src/index.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";
import { installSelectionContentCreatedTimeSchema } from "../fixtures/selection-content-created-time-schema.js";

const fixture = vi.hoisted(() => ({ database: null as PGlite | null }));
// Exercise real SQL, transaction rollback, receipts, permissions and projection.
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  const wrap = (database: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) => (await database.query<Row>(sql, parameters)).rows,
  }) as unknown as Tx;
  const transaction = async (work: (tx: Tx) => Promise<unknown>) => fixture.database!.transaction(async tx => {
    if (selectionScope.getStore()) await tx.query(`SET LOCAL search_path TO "selection_table_${selectionScope.getStore()}", public`);
    return work(wrap(tx));
  });
  return { ...original, db: { $queryRawUnsafe: (sql: string, ...parameters: unknown[]) => transaction(tx => tx.$queryRawUnsafe(sql, ...parameters)), $transaction: transaction } };
});

import { deleteHistoryRows, deleteSingleRow, restoreHistoryRows } from "../../apps/api/src/modules/style-selections/history-rows.js";
const actor = (key = randomUUID(), userId = "7"): Context => ({ actor: { id: userId, username: "editor", displayName: "Editor", permissions: ["selection.read", "selection.manage"], roleCodes: [] }, requestId: key, key });
const query = async (sql: string, values: unknown[] = []) => (await fixture.database!.query<Row>(sql, values)).rows;
const originalTime = "2020-01-01T00:00:00.000Z";
const conflict = { status: 409, response: { error: { code: "EDIT_CONFLICT" } } };
const expired = { status: 409, response: { error: { code: "HISTORY_EXPIRED" } } };
const forbidden = { status: 403, response: { error: { code: "REGION_FORBIDDEN" } } };
async function style(no = "UNDO-1", namespace = "public", extra: Row = {}) {
  return (await query(`INSERT INTO ${namespace}.style_selections(xuti_style_no,extra_fields,images,cell_owners,claimed_by,product_id,migration_locked,created_at,updated_at)
    VALUES($1,$2,$3,'{"material":"8"}',$4,$5,$6,$7,$7) RETURNING *`, [no, JSON.stringify(extra.extraFields || {}), JSON.stringify(extra.images || []), extra.claimedBy || null, extra.productId || null, !!extra.migrationLocked, originalTime]))[0];
}
const rowRequest = (row: Row) => ({ id: String(row.id), expectedUpdatedAt: new Date(row.updated_at).toISOString() });
async function settings(value: Row) { await query("UPDATE style_selection_protection SET settings=$1", [JSON.stringify({ ...defaultProtection, ...value })]); }

beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(`
    CREATE TABLE users(id bigint PRIMARY KEY,username text,display_name text);
    INSERT INTO users VALUES(7,'editor','Editor'),(8,'creator','Creator');
    CREATE TABLE project_tables(id bigint PRIMARY KEY,system_key text);
    INSERT INTO project_tables VALUES(42,NULL),(84,'PRODUCT_ARCHIVE');
    CREATE TABLE style_selections(
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,xuti_style_no text UNIQUE,supplier_style_no text,material text DEFAULT 'Original material',
      images jsonb DEFAULT '[]',label_images jsonb DEFAULT '[]',extra_fields jsonb DEFAULT '{}',
      cell_colors jsonb DEFAULT '{}',cell_alignments jsonb DEFAULT '{}',cell_vertical_alignments jsonb DEFAULT '{}',cell_text_colors jsonb DEFAULT '{}',cell_number_formats jsonb DEFAULT '{}',
      cell_owners jsonb DEFAULT '{}',claimed_by bigint UNIQUE,created_by bigint NOT NULL DEFAULT 8 REFERENCES users(id),updated_by bigint DEFAULT 8,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),version integer DEFAULT 4,
      product_id bigint,migration_locked boolean DEFAULT false,migration_target_workspace text,migration_target_row_id bigint,migrated_at timestamptz,sort_order integer DEFAULT 0
    );
    CREATE TABLE style_selection_protection(id integer PRIMARY KEY,settings jsonb,revision integer DEFAULT 1);
    CREATE TABLE selection_field_registry(workspace_key text,field_key text,owner_id bigint,visibility text,definition jsonb,revision integer DEFAULT 1,updated_at timestamptz DEFAULT now());
    CREATE TABLE idempotency_records(id bigserial,actor_id bigint,operation text,idempotency_key text,request_hash text,response_status integer,response_body jsonb);
    CREATE TABLE audit_logs(id bigserial,actor_id bigint,actor_label text,action text,entity_type text,entity_id bigint,request_id text,before_data jsonb,after_data jsonb,reason text,selection_table_id bigint,occurred_at timestamptz DEFAULT now());
    CREATE SCHEMA selection_table_42;
    CREATE TABLE selection_table_42.style_selections(LIKE public.style_selections INCLUDING ALL);
    CREATE TABLE selection_table_42.style_selection_protection(LIKE public.style_selection_protection INCLUDING ALL);
    CREATE SCHEMA selection_table_84;
    CREATE TABLE selection_table_84.style_selections(LIKE public.style_selections INCLUDING ALL);
    CREATE TABLE selection_table_84.style_selection_protection(LIKE public.style_selection_protection INCLUDING ALL);
  `);
  await installSelectionContentCreatedTimeSchema(fixture.database);
}, 30000);
beforeEach(async () => {
  await fixture.database!.exec("TRUNCATE style_selections,style_selection_protection,selection_field_registry,idempotency_records,audit_logs,selection_table_42.style_selections,selection_table_42.style_selection_protection,selection_table_84.style_selections,selection_table_84.style_selection_protection RESTART IDENTITY");
  for (const namespace of ["public", "selection_table_42", "selection_table_84"])
    await query(`INSERT INTO ${namespace}.style_selection_protection(id,settings) VALUES(1,$1)`, [JSON.stringify(defaultProtection)]);
});
afterAll(async () => { await fixture.database?.close(); });

describe("trusted table row undo", () => {
  it("lets SUPER_ADMIN delete protected claimed rows with private and unregistered historical keys", async () => {
    const key = "custom:private", orphan = "custom:removed";
    await query("INSERT INTO selection_field_registry(workspace_key,field_key,owner_id,visibility,definition) VALUES('default',$1,8,'PRIVATE',$2)", [key, JSON.stringify({ key, label: "Private", width: 100, type: "text", custom: true, deleted: true })]);
    const row = await style("SUPER-58", "public", { claimedBy: "8", extraFields: { [key]: "Private content", [orphan]: "Old content" } });
    await query("UPDATE style_selections SET cell_colors=$1", [JSON.stringify({ "custom:format-only": "RED" })]);
    await settings({ enabled: true, claimsEnabled: true, autoHide: true, autoHideRegions: [{ id: randomUUID(), name: "Hidden", scope: "sheet", rowIds: [], columnKeys: [] }], regions: [{ id: randomUUID(), name: "Deny", scope: "sheet", rowIds: [], columnKeys: [], users: {}, others: "deny" }] });
    await expect(deleteHistoryRows(actor(), { rows: [rowRequest(row)] })).rejects.toMatchObject(forbidden);
    const superContext = actor(); superContext.actor.roleCodes = ["SUPER_ADMIN"];
    const result = await deleteHistoryRows(superContext, { rows: [rowRequest(row)] });
    expect(result.deletions).toHaveLength(1);
    expect(await query("SELECT * FROM style_selections")).toHaveLength(0);
    expect(await query("SELECT * FROM audit_logs WHERE action='DELETE'")).toHaveLength(1);
  });

  it("atomically deletes and restores original IDs, creation metadata, images and ownership; responses contain no snapshot", async () => {
    const image = { id: "photo", url: "https://example.test/photo.jpg", color: "" };
    const first = await style("UNDO-1", "public", { claimedBy: "8", images: [image] }), second = await style("UNDO-2");
    const deleted = await deleteHistoryRows(actor(), { rows: [rowRequest(first), rowRequest(second)] });
    expect(deleted.deletions).toHaveLength(2);
    expect(Object.keys(deleted.deletions[0]).sort()).toEqual(["rowId", "token"]);
    expect(await query("SELECT * FROM style_selections")).toHaveLength(0);
    const c = actor(), restored = await restoreHistoryRows(c, deleted);
    expect(restored.rows).toHaveLength(2);
    expect(restored.rows[0]).toMatchObject({ id: first.id, createdAt: originalTime, createdBy: 8, updatedBy: 7, version: 5, images: [image], claimedBy: 8 });
    expect(restored.rows[0]).not.toHaveProperty("cellOwners");
    const saved = (await query("SELECT * FROM style_selections ORDER BY id"))[0];
    expect(saved.cell_owners).toEqual({ material: "8" });
    expect(new Date(saved.updated_at).getTime()).toBeGreaterThan(new Date(originalTime).getTime());
    expect((await query("SELECT response_body FROM idempotency_records WHERE operation LIKE '%restore-rows'"))[0].response_body).toEqual({ ids: [String(first.id), String(second.id)] });
    await restoreHistoryRows(c, deleted);
    expect(await query("SELECT * FROM audit_logs WHERE action='RESTORE'")).toHaveLength(2);
  });

  it("works in a project workspace without touching identical row IDs in another workspace", async () => {
    const outside = await style("OUTSIDE"), inside = await style("INSIDE", "selection_table_42");
    const receipt = await selectionScope.run("42", () => deleteSingleRow(actor(), String(inside.id)));
    await expect(restoreHistoryRows(actor(), { deletions: [{ rowId: receipt.id, token: receipt.token }] })).rejects.toMatchObject(expired);
    const saved = await selectionScope.run("42", () => restoreHistoryRows(actor(), { deletions: [{ rowId: receipt.id, token: receipt.token }] }));
    expect(saved.rows[0].xutiStyleNo).toBe("INSIDE");
    expect((await query("SELECT * FROM style_selections"))[0].id).toBe(outside.id);
    expect((await query("SELECT DISTINCT selection_table_id FROM audit_logs"))[0].selection_table_id).toBe(42);
  });

  it("rejects another actor, a forged token and any client-supplied snapshot", async () => {
    const row = await style(), receipt = await deleteSingleRow(actor(), String(row.id));
    const input = { deletions: [{ rowId: receipt.id, token: receipt.token }] };
    await expect(restoreHistoryRows(actor(randomUUID(), "8"), input)).rejects.toMatchObject(expired);
    await expect(restoreHistoryRows(actor(), { deletions: [{ rowId: receipt.id, token: randomUUID() }] })).rejects.toMatchObject(expired);
    await expect(restoreHistoryRows(actor(), { ...input, beforeData: { ...row, created_by: "7" } })).rejects.toMatchObject({ status: 400 });
    expect(await query("SELECT * FROM style_selections")).toHaveLength(0);
  });

  it("reprojects an idempotent restore retry after privacy or edit access changes", async () => {
    const key = "custom:private";
    await query("INSERT INTO selection_field_registry(workspace_key,field_key,owner_id,visibility,definition) VALUES('default',$1,8,'PUBLIC',$2)", [key, JSON.stringify({ key, label: "Private", width: 100, type: "text", custom: true })]);
    const row = await style("PRIVACY", "public", { extraFields: { [key]: "Original private content" } });
    const receipt = await deleteSingleRow(actor(), String(row.id)), input = { deletions: [{ rowId: receipt.id, token: receipt.token }] }, c = actor();
    const restored = await restoreHistoryRows(c, input);
    expect(restored.rows[0].extraFields[key]).toBe("Original private content");
    await query("UPDATE selection_field_registry SET visibility='PRIVATE'");
    const retried = await restoreHistoryRows(c, input);
    expect(retried.rows[0].extraFields).not.toHaveProperty(key);
    expect(retried.rows[0].cellAccess).not.toHaveProperty(key);
    expect((await query("SELECT extra_fields FROM style_selections"))[0].extra_fields[key]).toBe("Original private content");
    expect(await query("SELECT * FROM audit_logs WHERE action='RESTORE'")).toHaveLength(1);
    c.actor.permissions = ["selection.read"];
    await expect(restoreHistoryRows(c, input)).rejects.toMatchObject({ status: 403 });
  });

  it("binds every receipt to its row and rejects a different operation body under the same idempotency key", async () => {
    const first = await style("FIRST"), second = await style("SECOND"), c = actor();
    const firstDelete = await deleteHistoryRows(c, { rows: [rowRequest(first)] });
    await expect(deleteHistoryRows(c, { rows: [rowRequest(second)] })).rejects.toMatchObject({ status: 409, response: { error: { code: "IDEMPOTENCY_CONFLICT" } } });
    const secondDelete = await deleteHistoryRows(actor(), { rows: [rowRequest(second)] });
    await expect(restoreHistoryRows(actor(), { deletions: [{ rowId: String(first.id), token: secondDelete.deletions[0].token }, { rowId: String(second.id), token: firstDelete.deletions[0].token }] })).rejects.toMatchObject(expired);
    expect(await query("SELECT * FROM style_selections")).toHaveLength(0);
    expect(await query("SELECT * FROM audit_logs WHERE action='RESTORE'")).toHaveLength(0);
  });

  it("rejects stale deletion versions and checks all row permissions before deleting anything", async () => {
    const first = await style("FIRST"), second = await style("SECOND");
    await expect(deleteHistoryRows(actor(), { rows: [rowRequest(first), { ...rowRequest(second), expectedUpdatedAt: "2021-01-01T00:00:00.000Z" }] })).rejects.toMatchObject(conflict);
    expect(await query("SELECT * FROM audit_logs")).toHaveLength(0);
    await settings({ enabled: true, regions: [{ id: randomUUID(), name: "Protected", scope: "rows", rowIds: [String(second.id)], columnKeys: [], users: {}, others: "read" }] });
    await expect(deleteHistoryRows(actor(), { rows: [rowRequest(first), rowRequest(second)] })).rejects.toMatchObject(forbidden);
    expect(await query("SELECT * FROM style_selections")).toHaveLength(2);
  });

  it("rechecks current region rights and field privacy on restoration, preserving the entire deleted group on failure", async () => {
    const first = await style("FIRST"), second = await style("SECOND", "public", { extraFields: { "custom:private": "Preserved secret" } });
    await query("INSERT INTO selection_field_registry(workspace_key,field_key,owner_id,visibility,definition) VALUES('default','custom:private',8,'PUBLIC',$1)", [JSON.stringify({ key: "custom:private", label: "Private", width: 100, type: "text", custom: true })]);
    const receipt = await deleteHistoryRows(actor(), { rows: [rowRequest(first), rowRequest(second)] });
    await settings({ enabled: true, regions: [{ id: randomUUID(), name: "Protected", scope: "rows", rowIds: [String(first.id)], columnKeys: [], users: {}, others: "deny" }] });
    await expect(restoreHistoryRows(actor(), receipt)).rejects.toMatchObject(forbidden);
    await settings({});
    await query("UPDATE selection_field_registry SET visibility='PRIVATE'");
    await expect(restoreHistoryRows(actor(), receipt)).rejects.toMatchObject(forbidden);
    expect(await query("SELECT * FROM style_selections")).toHaveLength(0);
    expect(await query("SELECT * FROM audit_logs WHERE action='RESTORE'")).toHaveLength(0);
  });

  it("rejects duplicate styles and changed row claims without partially restoring the group", async () => {
    const first = await style("FIRST"), second = await style("SECOND", "public", { claimedBy: "8" });
    const receipt = await deleteHistoryRows(actor(), { rows: [rowRequest(first), rowRequest(second)] });
    const duplicate = await style("FIRST");
    await expect(restoreHistoryRows(actor(), receipt)).rejects.toMatchObject(conflict);
    await query("DELETE FROM style_selections WHERE id=$1", [duplicate.id]);
    await style("NEW-CLAIM", "public", { claimedBy: "8" });
    await expect(restoreHistoryRows(actor(), receipt)).rejects.toMatchObject({ status: 409, response: { error: { code: "ROW_CLAIMED" } } });
    expect(await query("SELECT * FROM style_selections WHERE xuti_style_no IN ('FIRST','SECOND')")).toHaveLength(0);
  });

  it("allows redo through a new deletion receipt and prevents old receipt replay or expiry", async () => {
    const row = await style(), first = await deleteSingleRow(actor(), String(row.id));
    const input = { deletions: [{ rowId: first.id, token: first.token }] };
    await restoreHistoryRows(actor(), input);
    const second = await deleteSingleRow(actor(), String(row.id));
    expect(second.token).not.toBe(first.token);
    await expect(restoreHistoryRows(actor(), input)).rejects.toMatchObject(expired);
    await query("UPDATE audit_logs SET occurred_at=now()-interval '25 hours' WHERE action='DELETE'");
    await expect(restoreHistoryRows(actor(), { deletions: [{ rowId: second.id, token: second.token }] })).rejects.toMatchObject(expired);
  });

  it("preserves an established timestamp when restoring a row whose three identifying values were subsequently cleared", async () => {
    const row = await style("ESTABLISHED");
    await query("UPDATE style_selections SET xuti_style_no=NULL,supplier_style_no=NULL,images='[]' WHERE id=$1", [row.id]);
    const cleared = (await query("SELECT * FROM style_selections WHERE id=$1", [row.id]))[0];
    expect(cleared.content_created_at.toISOString()).toBe(originalTime);
    const receipt = await deleteHistoryRows(actor(), { rows: [rowRequest(cleared)] });
    const restored = await restoreHistoryRows(actor(), receipt);
    expect(restored.rows[0]).toMatchObject({ createdAt: originalTime, creationTimePending: false, xutiStyleNo: null });
    expect((await query("SELECT * FROM style_selections"))[0].content_created_at.toISOString()).toBe(originalTime);
  });

  it("retains archive product and migration restrictions and requires current edit permission", async () => {
    const linked = await style("ARCHIVE", "selection_table_84", { productId: "1" });
    await expect(selectionScope.run("84", () => deleteHistoryRows(actor(), { rows: [rowRequest(linked)] }))).rejects.toMatchObject({ status: 409, response: { error: { code: "PRODUCT_IN_USE" } } });
    const locked = await style("LOCKED", "public", { migrationLocked: true });
    await expect(deleteSingleRow(actor(), String(locked.id))).rejects.toMatchObject({ status: 409, response: { error: { code: "MIGRATION_LOCKED" } } });
    const reader = actor(); reader.actor.permissions = ["selection.read"];
    await expect(deleteSingleRow(reader, String(locked.id))).rejects.toMatchObject({ status: 403 });
    await expect(restoreHistoryRows(reader, { deletions: [{ rowId: String(locked.id), token: randomUUID() }] })).rejects.toMatchObject({ status: 403 });
  });

  it("never bypasses product or migration restrictions for a historically deleted snapshot", async () => {
    // Seed trusted historical DELETE records to cover policy/schema changes;
    // the browser still supplies only its server-issued receipt and row ID.
    const token = randomUUID(), snapshot = { id: "100", created_by: "8", created_at: originalTime, updated_at: originalTime, version: 1, product_id: "1", migration_locked: false, extra_fields: {}, images: [], cell_owners: {} };
    await query("INSERT INTO audit_logs(actor_id,actor_label,action,entity_type,entity_id,request_id,before_data,reason,selection_table_id) VALUES(7,'Editor','DELETE','style-selection',100,'legacy',$1,$2,84)", [JSON.stringify(snapshot), `selection-row-delete:${token}`]);
    await expect(selectionScope.run("84", () => restoreHistoryRows(actor(), { deletions: [{ rowId: "100", token }] }))).rejects.toMatchObject({ status: 409, response: { error: { code: "PRODUCT_IN_USE" } } });
    const lockedToken = randomUUID();
    await query("INSERT INTO audit_logs(actor_id,actor_label,action,entity_type,entity_id,request_id,before_data,reason) VALUES(7,'Editor','DELETE','style-selection',100,'legacy',$1,$2)", [JSON.stringify({ ...snapshot, product_id: null, migration_locked: true }), `selection-row-delete:${lockedToken}`]);
    await expect(restoreHistoryRows(actor(), { deletions: [{ rowId: "100", token: lockedToken }] })).rejects.toMatchObject({ status: 409, response: { error: { code: "MIGRATION_LOCKED" } } });
    expect(await query("SELECT * FROM style_selections")).toHaveLength(0);
    expect(await query("SELECT * FROM selection_table_84.style_selections")).toHaveLength(0);
  });

  it("applies current text limits and limits each atomic group to 5000 distinct rows", async () => {
    const row = await style(), receipt = await deleteSingleRow(actor(), String(row.id));
    await query("INSERT INTO selection_field_registry(workspace_key,field_key,visibility,definition) VALUES('default','material','PUBLIC',$1)", [JSON.stringify({ key: "material", label: "Material", width: 100, type: "text", textConfig: { maxLength: 3, countMode: "characters" } })]);
    await expect(restoreHistoryRows(actor(), { deletions: [{ rowId: receipt.id, token: receipt.token }] })).rejects.toMatchObject({ status: 400 });
    await expect(deleteHistoryRows(actor(), { rows: [rowRequest(row), rowRequest(row)] })).rejects.toMatchObject({ status: 400 });
    await expect(restoreHistoryRows(actor(), { deletions: Array.from({ length: 5001 }, (_, index) => ({ rowId: String(index + 1), token: randomUUID() })) })).rejects.toMatchObject({ status: 400 });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import type { Context } from "../../apps/api/src/core.js";
import type { Row, Tx } from "../../packages/database/src/index.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";
import { installSelectionContentCreatedTimeSchema } from "../fixtures/selection-content-created-time-schema.js";

const fixture = vi.hoisted(() => ({ database: null as PGlite | null, queries: [] as string[] }));
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  const wrap = (database: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) => { fixture.queries.push(sql); return (await database.query<Row>(sql, parameters)).rows; },
    $executeRawUnsafe: async (sql: string, ...parameters: unknown[]) => (await database.query(sql, parameters)).affectedRows || 0,
  }) as unknown as Tx;
  const transaction = async (work: (tx: Tx) => Promise<unknown>) => fixture.database!.transaction(async tx => {
    if (selectionScope.getStore()) await tx.query(`SET LOCAL search_path TO "selection_table_${selectionScope.getStore()}", public`);
    return work(wrap(tx));
  });
  return { ...original, db: { $queryRawUnsafe: (sql: string, ...parameters: unknown[]) => transaction(tx => tx.$queryRawUnsafe(sql, ...parameters)), $transaction: transaction } };
});

import { changePhoto, list, persist, revision, styleSelectionInput, sync, write } from "../../apps/api/src/modules/style-selections/service.js";
import { detail } from "../../apps/api/src/modules/style-selections/protection.js";
import { deleteHistoryRows, restoreHistoryRows } from "../../apps/api/src/modules/style-selections/history-rows.js";
import { selectionRowNumberColumn, selectionRowNumberSource } from "../../apps/api/src/modules/style-selections/row-number.js";
import { db } from "../../packages/database/src/index.js";

const actor = (id = "7"): Context => ({ actor: { id, username: id, displayName: id, permissions: ["selection.read", "selection.manage"], roleCodes: [] }, requestId: randomUUID(), key: randomUUID() });
const sql = async (query: string, values: unknown[] = []) => (await fixture.database!.query<Row>(query, values)).rows;
const numbers = (data: Row[]) => Object.fromEntries(data.map(row => [String(row.id), row.rowNumber]));
const snapshot = async (c: Context, known: Record<string, string> = {}, extra: Row = {}) => JSON.parse(await sync(c, { known, ...extra })) as { revision: string; index: { id: string; token: string }[]; data: Row[] };
const known = (value: Awaited<ReturnType<typeof snapshot>>) => Object.fromEntries(value.index.map(item => [item.id, item.token]));

beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(`
    CREATE TABLE users(id bigint PRIMARY KEY,username text,display_name text); INSERT INTO users VALUES(7,'one','One'),(8,'two','Two');
    CREATE TABLE project_tables(id bigint PRIMARY KEY,initial_layout text,system_key text); INSERT INTO project_tables VALUES(42,'selection',NULL);
    CREATE TABLE style_selection_protection(id integer PRIMARY KEY,settings jsonb,revision integer DEFAULT 1);
    CREATE TABLE style_selections(
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,registration_batch date,images jsonb DEFAULT '[]',label_images jsonb DEFAULT '[]',
      cell_colors jsonb DEFAULT '{}',cell_alignments jsonb DEFAULT '{}',cell_vertical_alignments jsonb DEFAULT '{}',cell_text_colors jsonb DEFAULT '{}',cell_number_formats jsonb DEFAULT '{}',extra_fields jsonb DEFAULT '{}',
      xuti_style_no text UNIQUE,supplier_style_no text,supplier_code text,color text,size_range text,material text,
      supply_price_excl_tax numeric,vip_price numeric,live_price numeric,tag_price numeric,selling_points text,reorder_days integer,collection_inventory jsonb DEFAULT '[]',
      sort_order integer DEFAULT 0,row_color text DEFAULT 'NONE',created_by bigint DEFAULT 7,updated_by bigint DEFAULT 7,version integer DEFAULT 4,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),cell_owners jsonb DEFAULT '{}',claimed_by bigint,
      migration_locked boolean DEFAULT false,migration_target_workspace text,migration_target_row_id bigint,migrated_at timestamptz,product_id bigint
    );
    CREATE TABLE selection_field_registry(workspace_key text,field_key text,owner_id bigint,visibility text,definition jsonb,revision integer DEFAULT 1,updated_at timestamptz DEFAULT now());
    CREATE TABLE idempotency_records(id bigserial,actor_id bigint,operation text,idempotency_key text,request_hash text,response_status integer,response_body jsonb);
    CREATE TABLE audit_logs(id bigserial,actor_id bigint,actor_label text,action text,entity_type text,entity_id bigint,request_id text,before_data jsonb,after_data jsonb,reason text,selection_table_id bigint,occurred_at timestamptz DEFAULT now());
    CREATE SCHEMA selection_table_42; CREATE TABLE selection_table_42.style_selections(LIKE public.style_selections INCLUDING ALL); CREATE TABLE selection_table_42.style_selection_protection(LIKE public.style_selection_protection INCLUDING ALL);
  `);
  await installSelectionContentCreatedTimeSchema(fixture.database);
}, 30000);
beforeEach(async () => {
  await fixture.database!.exec("TRUNCATE style_selections,style_selection_protection,selection_field_registry,idempotency_records,audit_logs,selection_table_42.style_selections,selection_table_42.style_selection_protection RESTART IDENTITY");
  for (const namespace of ["public", "selection_table_42"]) await sql(`INSERT INTO ${namespace}.style_selection_protection VALUES(1,$1,1)`, [JSON.stringify(defaultProtection)]);
  for (const [style, order] of [["Z", 30], ["A", 10], ["M", 10], ["B", 20]]) await sql("INSERT INTO style_selections(xuti_style_no,sort_order,color) VALUES($1,$2,'白')", [style, order]);
  fixture.queries = [];
});
afterAll(async () => { await fixture.database?.close(); });

describe("shared canonical table row numbers", () => {
  it("keeps the same whole-table numbers for both actors across search, personal sorting and pagination", async () => {
    const c = actor(), base = await list(c, { sort: "sortOrder", direction: "asc", pageSize: 100 });
    expect(numbers(base.data)).toEqual({ "1": 4, "2": 2, "3": 1, "4": 3 });
    const searched = await list(actor("8"), { q: "Z", sort: "xutiStyleNo", direction: "desc", pageSize: 20 });
    expect(searched.data).toHaveLength(1);
    expect(searched.data[0]).toMatchObject({ id: 1, rowNumber: 4 });
    const page = await list(actor("8"), { sort: "xutiStyleNo", direction: "asc", pageSize: 2, page: 2 });
    expect(page.data).toHaveLength(2);
    for (const row of page.data) expect(row.rowNumber).toBe(numbers(base.data)[String(row.id)]);
    expect((await detail(actor("8"), "1")).rowNumber).toBe(4);
  });

  it("keeps numbering stable through protection projection before actor-specific filtering", async () => {
    await sql("UPDATE style_selection_protection SET settings=$1", [JSON.stringify({ ...defaultProtection, enabled: true, regions: [{ id: randomUUID(), name: "Read only", scope: "columns", rowIds: [], columnKeys: ["material"], users: {}, others: "read" }] })]);
    const first = await list(actor(), { q: "Z", sort: "supplierStyleNo", direction: "asc" });
    const second = await list(actor("8"), { q: "Z", sort: "sortOrder", direction: "desc" });
    expect(first.data[0].rowNumber).toBe(4);
    expect(second.data[0].rowNumber).toBe(4);
    expect((await snapshot(actor(), {}, { q: "Z" })).data[0].rowNumber).toBe(4);
  });

  it("invalidates known sync tokens for unchanged rows after deletion and reorder", async () => {
    const c = actor(), first = await snapshot(c), oldRevision = await revision(c);
    expect((await snapshot(c, known(first))).data).toEqual([]);
    await sql("DELETE FROM style_selections WHERE id=3");
    const removed = await snapshot(c, known(first));
    expect(numbers(removed.data)).toEqual({ "1": 3, "2": 1, "4": 2 });
    expect(removed.data.every(row => row.version === 4)).toBe(true);
    expect(removed.revision).not.toBe(first.revision);
    await sql("UPDATE style_selections SET sort_order=0 WHERE id=1");
    const reordered = await snapshot(c, known(removed));
    expect(numbers(reordered.data)).toEqual({ "1": 1, "2": 2, "4": 3 });
    expect((await revision(c)).revision).not.toBe(oldRevision.revision);
  });

  it("returns current canonical numbers from detail, write, photo and trusted restore responses", async () => {
    const saved = await write(actor(), { material: "New material" }, "4");
    expect(saved.rowNumber).toBe(3);
    const photo = await changePhoto(actor(), "4", { action: "add", image: { id: "main", url: "https://example.test/main.jpg", color: "白" } });
    expect(photo.rowNumber).toBe(3);
    const selected = await detail(actor(), "3"), c = actor();
    const receipts = await deleteHistoryRows(c, { rows: [{ id: "3", expectedUpdatedAt: selected.updatedAt }] });
    await sql("UPDATE style_selections SET sort_order=0 WHERE id=1");
    const restored = await restoreHistoryRows(c, receipts);
    expect(restored.rows[0]).toMatchObject({ id: 3, rowNumber: 2 });
    expect((await detail(c, "3")).rowNumber).toBe(2);
  });

  it("numbers workspaces independently even when saved IDs coincide", async () => {
    await sql("INSERT INTO selection_table_42.style_selections(xuti_style_no,sort_order) VALUES('WORKSPACE-Z',20),('WORKSPACE-A',10)");
    const scoped = await selectionScope.run("42", () => list(actor(), { q: "WORKSPACE-Z" }));
    expect(scoped.data[0]).toMatchObject({ id: 1, rowNumber: 2 });
    expect((await detail(actor(), "1")).rowNumber).toBe(4);
    expect((await selectionScope.run("42", () => detail(actor(), "1"))).rowNumber).toBe(2);
  });

  it("rejects client-written row numbers and keeps internal bulk writes free of global ranking", async () => {
    expect(styleSelectionInput.safeParse({ rowNumber: 99 }).success).toBe(false);
    await expect(write(actor(), { rowNumber: 99 }, "1")).rejects.toMatchObject({ status: 400 });
    fixture.queries = [];
    await db.$transaction(tx => persist(tx, actor(), { material: "Bulk internal edit" }, "1"));
    expect(fixture.queries.some(query => /row_number\(\)/.test(query))).toBe(false);
    expect((await detail(actor(), "1")).rowNumber).toBe(4);
  });

  it("ranks five thousand saved rows in one window query", async () => {
    await fixture.database!.exec("TRUNCATE style_selections RESTART IDENTITY");
    await sql("INSERT INTO style_selections(xuti_style_no,sort_order) SELECT 'PERF-' || n,5001-n FROM generate_series(1,5000) n");
    const started = performance.now();
    const ranked = await sql(`SELECT s.id,${selectionRowNumberColumn} ${selectionRowNumberSource} ORDER BY s.id`);
    const elapsed = Math.round(performance.now() - started);
    expect(ranked).toHaveLength(5000);
    expect(ranked[0]).toMatchObject({ id: 1, row_number: 5000 });
    expect(ranked.at(-1)).toMatchObject({ id: 5000, row_number: 1 });
    console.info(`5000-row canonical ranking: ${elapsed} ms in isolated PostgreSQL`);
  });
});

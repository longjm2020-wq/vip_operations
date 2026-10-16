import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installSelectionContentCreatedTimeSchema } from "../fixtures/selection-content-created-time-schema.js";

const placeholder = "2026-10-09T00:00:00.123Z", legacy = "2026-10-01T00:00:00.000Z";
const entered = "2026-10-15T03:04:05.987Z", edited = "2026-10-07T01:02:03.000Z";
const microEntered = "2026-10-15T03:04:05.987654Z";
let database: PGlite, preservedAudit: unknown[], metadata: unknown[];
const receipts = new Map<number, Record<string, any>>();
const schema = (workspace: number | null) => workspace === null ? "public" : `selection_table_${workspace}`;
const query = async (sql: string, values: unknown[] = []) => (await database.query<Record<string, any>>(sql, values)).rows;
const blank = (id: number, at: string | null = placeholder) => ({ id, created_at: at, created_by: 8, images: [], xuti_style_no: null, supplier_style_no: null });

async function audit(id: number, action: string, before: unknown, after: unknown, at: string, workspace: number | null = null) {
  await database.query("INSERT INTO audit_logs(action,entity_type,entity_id,before_data,after_data,selection_table_id,occurred_at) VALUES($1,'style-selection',$2,$3,$4,$5,$6)", [action, id, JSON.stringify(before), JSON.stringify(after), workspace, at]);
}
async function seed(id: number, options: { workspace?: number; physical?: string; before?: Record<string, any>; create?: Record<string, any> | null; at?: string; product?: number } = {}) {
  const workspace = options.workspace ?? null, before = options.before ?? blank(id);
  await database.query(`INSERT INTO ${schema(workspace)}.style_selections(id,product_id,xuti_style_no,created_at,created_by) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,8)`, [id, options.product ?? null, `STYLE-${id}`, options.physical ?? legacy]);
  if (options.create !== null) await audit(id, "CREATE", null, options.create ?? blank(id), placeholder, workspace);
  await audit(id, "UPDATE", before, { ...before, xuti_style_no: `STYLE-${id}` }, options.at ?? entered, workspace);
}

beforeAll(async () => {
  database = new PGlite();
  await database.exec(`
    CREATE TABLE project_tables(id bigint PRIMARY KEY,system_key text,initial_layout text,created_by bigint);
    INSERT INTO project_tables VALUES(23,'PRODUCT_ARCHIVE','empty',7),(24,NULL,'selection',7),(25,NULL,'blank',7);
    CREATE TABLE products(id bigint PRIMARY KEY,created_at timestamptz NOT NULL);
    INSERT INTO products VALUES(100,'${legacy}'),(101,'${placeholder}'),(102,'${legacy}');
    CREATE TABLE style_selections(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,product_id bigint,images jsonb DEFAULT '[]',
      xuti_style_no text,supplier_style_no text,created_by bigint,created_at timestamptz NOT NULL,updated_at timestamptz DEFAULT now(),version integer DEFAULT 1);
    CREATE TABLE audit_logs(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,action text,entity_type text,entity_id bigint,
      before_data jsonb,after_data jsonb,selection_table_id bigint,occurred_at timestamptz NOT NULL);
    CREATE SCHEMA selection_table_23; CREATE TABLE selection_table_23.style_selections(LIKE public.style_selections INCLUDING ALL);
    CREATE SCHEMA selection_table_24; CREATE TABLE selection_table_24.style_selections(LIKE public.style_selections INCLUDING ALL);
    CREATE SCHEMA selection_table_25; CREATE TABLE selection_table_25.style_selections(LIKE public.style_selections INCLUDING ALL);
  `);
  await seed(1); // changed legacy timestamp without an explicit date UPDATE audit
  await seed(2, { create: null, before: { id: 2, createdAt: placeholder, images: [], xutiStyleNo: null, supplierStyleNo: "" } });
  await seed(3, { before: blank(3, null) }); // independent CREATE evidence
  await seed(4, { create: null, before: blank(4, null) }); // no readable prior date
  await seed(5, { create: null, before: blank(5, null) });
  await audit(5, "CREATE", null, blank(5), placeholder, 24); // another table's ID is not evidence
  await seed(6, { before: { id: 6, created_at: placeholder } }); // partial before cannot prove blank
  await seed(7);
  await seed(8);
  await seed(9, { before: blank(9, legacy) }); // before was already changed, CREATE still proves it
  await seed(10, { physical: "2026-10-09T00:00:00.123456Z" }); // only JSON precision differs
  await seed(11);
  await audit(11, "UPDATE", { ...blank(11), xuti_style_no: "STYLE-11" }, blank(11), "2026-10-16T00:00:00Z");
  await database.query("UPDATE style_selections SET xuti_style_no=NULL WHERE id=11");
  const styles = ["XFW25-31706L", "XFW26-31688L", "XFW27-31929L", "XFW28-31708L", "XFW28-31908L"];
  for (let i = 0; i < styles.length; i++) {
    await seed(20 + i, { physical: placeholder });
    await database.query("UPDATE style_selections SET xuti_style_no=$1 WHERE id=$2", [styles[i], 20 + i]);
  }
  await seed(100, { workspace: 23, physical: placeholder, product: 100 });
  await seed(101, { workspace: 23, product: 101 });
  await seed(102, { workspace: 23, physical: placeholder, product: 102, before: blank(102, legacy) });
  await seed(1, { workspace: 24 });
  await seed(1, { workspace: 25 });
  for (const id of [40, 41, 42]) await seed(id, { at: microEntered });
  await installSelectionContentCreatedTimeSchema(database, { legacyGuard: false });
  // Prove this fixture represents a 064 mistake before applying the repair.
  expect((await query("SELECT content_created_at,created_time_source FROM style_selections WHERE id=1"))[0]).toMatchObject({ content_created_at: new Date(entered), created_time_source: "AUTO" });
  await database.query("UPDATE style_selections SET content_created_at=$1,created_time_source='EXPLICIT' WHERE id IN (7,41)", [edited]);
  // A later value that is no longer the exact 064 inference must be left alone,
  // even if it came from an older internal writer without the EXPLICIT marker.
  await database.exec("ALTER TABLE style_selections DISABLE TRIGGER selection_content_created_stamp");
  await database.query("UPDATE style_selections SET content_created_at=$1 WHERE id IN (8,42)", [edited]);
  await database.exec("ALTER TABLE style_selections ENABLE TRIGGER selection_content_created_stamp");
  for (const id of [40, 41, 42]) {
    const receipt = JSON.parse(JSON.stringify((await query("SELECT * FROM style_selections WHERE id=$1", [id]))[0]));
    receipts.set(id, receipt);
    await audit(id, "DELETE", receipt, null, "2026-10-16T01:00:00Z");
    await database.query("DELETE FROM style_selections WHERE id=$1", [id]);
  }
  preservedAudit = await query("SELECT to_jsonb(a) AS value FROM audit_logs a ORDER BY id");
  metadata = await query("SELECT id,created_at,created_by,updated_at,version FROM style_selections ORDER BY id");
  await database.exec(await readFile(new URL("../../packages/database/migrations/065_selection_preserve_legacy_created_time.sql", import.meta.url), "utf8"));
}, 30000);
afterAll(async () => { await database.close(); });

describe("preserving legacy dates with incomplete explicit-date audit coverage", () => {
  it("repairs only untouched 064 inference when before or CREATE proves legacy date changed", async () => {
    const rows = await query("SELECT id,created_at,content_created_at,created_time_source FROM style_selections WHERE id IN (1,2,3,9,11) ORDER BY id");
    for (const row of rows) expect(row).toMatchObject({ created_at: new Date(legacy), content_created_at: new Date(legacy), created_time_source: "LEGACY" });
    expect(await query("SELECT id,created_at,created_by,updated_at,version FROM style_selections ORDER BY id")).toEqual(metadata);
    expect(await query("SELECT to_jsonb(a) AS value FROM audit_logs a ORDER BY id")).toEqual(preservedAudit);
  });
  it("keeps all five proven normal first-entry dates and ignores harmless microsecond loss in JSON", async () => {
    const rows = await query("SELECT id,content_created_at,created_time_source FROM style_selections WHERE id=10 OR id BETWEEN 20 AND 24 ORDER BY id");
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row).toMatchObject({ content_created_at: new Date(entered), created_time_source: "AUTO" });
  });
  it("leaves no-prior-date, wrong-workspace and incomplete evidence unguessed", async () => {
    for (const id of [4, 5]) expect((await query("SELECT content_created_at,created_time_source FROM style_selections WHERE id=$1", [id]))[0]).toEqual({ content_created_at: new Date(entered), created_time_source: "AUTO" });
    expect((await query("SELECT content_created_at,created_time_source FROM style_selections WHERE id=6"))[0]).toEqual({ content_created_at: new Date(legacy), created_time_source: "LEGACY" });
  });
  it("preserves EXPLICIT dates and business dates changed after the original 064 inference", async () => {
    expect((await query("SELECT content_created_at,created_time_source FROM style_selections WHERE id=7"))[0]).toEqual({ content_created_at: new Date(edited), created_time_source: "EXPLICIT" });
    expect((await query("SELECT content_created_at,created_time_source FROM style_selections WHERE id=8"))[0]).toEqual({ content_created_at: new Date(edited), created_time_source: "AUTO" });
  });
  it("uses archive master legacy baseline, repairs selection projects, and preserves generic blank compatibility", async () => {
    for (const id of [100, 102]) expect((await query("SELECT content_created_at,created_time_source FROM selection_table_23.style_selections WHERE id=$1", [id]))[0]).toEqual({ content_created_at: new Date(legacy), created_time_source: "LEGACY" });
    expect((await query("SELECT content_created_at,created_time_source FROM selection_table_23.style_selections WHERE id=101"))[0]).toEqual({ content_created_at: new Date(entered), created_time_source: "AUTO" });
    expect((await query("SELECT content_created_at,created_time_source FROM selection_table_24.style_selections WHERE id=1"))[0]).toEqual({ content_created_at: new Date(legacy), created_time_source: "LEGACY" });
    expect((await query("SELECT content_created_at,created_time_source FROM selection_table_25.style_selections WHERE id=1"))[0]).toEqual({ content_created_at: new Date(legacy), created_time_source: "LEGACY" });
    expect((await query("SELECT created_at FROM products WHERE id=100"))[0]).toEqual({ created_at: new Date(legacy) });
  });
  it("protects pre-064 missing-column receipts with the guarded historical function", async () => {
    const snapshot = { ...blank(1, legacy), id: 99, xuti_style_no: "OLD-RECEIPT" };
    await audit(99, "CREATE", null, blank(99), placeholder);
    await audit(99, "UPDATE", blank(99), { ...blank(99), xuti_style_no: "OLD-RECEIPT" }, entered);
    const restored = (await query("INSERT INTO style_selections OVERRIDING SYSTEM VALUE SELECT restored.* FROM jsonb_populate_record(NULL::style_selections,$1::jsonb) restored RETURNING *", [JSON.stringify(snapshot)]))[0];
    expect(restored).toMatchObject({ created_at: new Date(legacy), content_created_at: new Date(legacy), created_time_source: "LEGACY" });
  });
  it("repairs only 064-window AUTO receipts, accepting audit microseconds truncated by JS JSON", async () => {
    const receipt = receipts.get(40)!;
    expect(receipt.content_created_at).toBe(entered);
    expect((await query("SELECT public.selection_legacy_created_time_correction($1::jsonb,NULL) AS value", [JSON.stringify(receipt)]))[0].value).toBeNull();
    await database.exec("BEGIN; SELECT set_config('erp.selection_history_restore','1',true)");
    try {
      for (const id of [40, 41, 42]) {
        const restored = (await query("INSERT INTO style_selections OVERRIDING SYSTEM VALUE SELECT restored.* FROM jsonb_populate_record(NULL::style_selections,$1::jsonb) restored RETURNING *", [JSON.stringify(receipts.get(id))]))[0];
        expect(restored).toMatchObject({ created_at: new Date(legacy), content_created_at: new Date(id === 40 ? legacy : edited), created_time_source: id === 40 ? "LEGACY" : id === 41 ? "EXPLICIT" : "AUTO" });
      }
      await database.exec("COMMIT");
    } catch (error) { await database.exec("ROLLBACK"); throw error; }
  });
  it("re-enables the write trigger after repair and does not allow content clearing to reset the date", async () => {
    const row = (await query("UPDATE style_selections SET xuti_style_no=NULL,supplier_style_no=NULL,images='[]' WHERE id=20 RETURNING *"))[0];
    expect(row).toMatchObject({ content_created_at: new Date(entered), created_time_source: "AUTO" });
  });
});

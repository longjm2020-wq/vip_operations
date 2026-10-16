import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { installSelectionContentCreatedTimeSchema } from "../fixtures/selection-content-created-time-schema.js";

let database: PGlite;
const physical = "2026-10-09T00:00:00.000Z", firstEntry = "2026-10-15T03:04:05.000Z", explicit = "2025-04-21T16:00:00.000Z";
const image = { id: "main", url: "https://example.test/main.jpg", color: "" };
const read = async (sql: string, values: unknown[] = []) => (await database.query<Record<string, any>>(sql, values)).rows;
const raw = (id: number, extra: Record<string, any> = {}) => ({ id, created_at: physical, created_by: 8, images: [], xuti_style_no: null, supplier_style_no: null, ...extra });
async function audit(id: number, action: string, before: unknown, after: unknown, at: string, workspace: number | null = null) {
  await database.query("INSERT INTO audit_logs(actor_id,actor_label,action,entity_type,entity_id,request_id,before_data,after_data,selection_table_id,occurred_at) VALUES(7,'Editor',$1,'style-selection',$2,'fixture',$3,$4,$5,$6)", [action, id, JSON.stringify(before), JSON.stringify(after), workspace, at]);
}

beforeAll(async () => {
  database = new PGlite();
  await database.exec(`
    CREATE TABLE project_tables(id bigint PRIMARY KEY,system_key text,initial_layout text,created_by bigint);
    INSERT INTO project_tables VALUES(23,'PRODUCT_ARCHIVE','empty',7),(24,NULL,'selection',7),(25,NULL,'blank',7),(26,NULL,'empty',7);
    CREATE TABLE products(id bigint PRIMARY KEY,style_no text,created_at timestamptz NOT NULL,updated_at timestamptz DEFAULT now());
    INSERT INTO products VALUES(100,'ARCHIVE-PRECREATED','${physical}',now());
    CREATE TABLE style_selections(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,product_id bigint,images jsonb DEFAULT '[]',label_images jsonb DEFAULT '[]',extra_fields jsonb DEFAULT '{}',
      xuti_style_no text,supplier_style_no text,material text,created_by bigint DEFAULT 8,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE audit_logs(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,actor_id bigint,actor_label text,action text,entity_type text,entity_id bigint,request_id text,before_data jsonb,after_data jsonb,selection_table_id bigint,occurred_at timestamptz);
    CREATE SCHEMA selection_table_23; CREATE TABLE selection_table_23.style_selections(LIKE public.style_selections INCLUDING ALL);
    CREATE SCHEMA selection_table_24; CREATE TABLE selection_table_24.style_selections(LIKE public.style_selections INCLUDING ALL);
    CREATE SCHEMA selection_table_25; CREATE TABLE selection_table_25.style_selections(LIKE public.style_selections INCLUDING ALL);
    CREATE SCHEMA selection_table_26; CREATE TABLE selection_table_26.style_selections(LIKE public.style_selections INCLUDING ALL);
    INSERT INTO style_selections(id,images,xuti_style_no,supplier_style_no,created_at,material,label_images,extra_fields) OVERRIDING SYSTEM VALUE VALUES
      (1,'${JSON.stringify([image])}',NULL,NULL,'${physical}',NULL,'[]','{}'),
      (2,'[]',NULL,'SUPPLIER','${physical}',NULL,'[]','{}'),
      (3,'[]','EXPLICIT',NULL,'${explicit}',NULL,'[]','{}'),
      (4,'[]','IMPORTED',NULL,'${explicit}',NULL,'[]','{}'),
      (5,'[]',NULL,NULL,'${physical}',NULL,'[]','{}'),
      (6,'[]',NULL,NULL,'${physical}','Material only','${JSON.stringify([image])}','${JSON.stringify({ "custom:photos": JSON.stringify([image]) })}'),
      (7,'[]','NO-HISTORY',NULL,'${physical}',NULL,'[]','{}'),
      (8,'[]','WRONG-WORKSPACE-HISTORY',NULL,'${physical}',NULL,'[]','{}'),
      (9,'[]','PARTIAL-HISTORY',NULL,'${physical}',NULL,'[]','{}');
    INSERT INTO selection_table_23.style_selections(id,product_id,xuti_style_no,created_at) OVERRIDING SYSTEM VALUE VALUES(100,100,'ARCHIVE-PRECREATED','${physical}');
    INSERT INTO selection_table_24.style_selections(id,xuti_style_no,created_at) OVERRIDING SYSTEM VALUE VALUES(1,'PROJECT','${physical}');
    INSERT INTO selection_table_25.style_selections(id,created_at) OVERRIDING SYSTEM VALUE VALUES(1,'${physical}');
    INSERT INTO selection_table_26.style_selections(id,created_at) OVERRIDING SYSTEM VALUE VALUES(1,'${physical}');
  `);
  for (const id of [1, 3, 5]) {
    await audit(id, "CREATE", null, raw(id), physical);
    await audit(id, "UPDATE", raw(id), raw(id, { images: [image] }), firstEntry);
  }
  await audit(2, "CREATE", null, { id: 2, createdAt: physical, images: [], xutiStyleNo: null, supplierStyleNo: "" }, physical);
  await audit(2, "UPDATE", { id: 2, createdAt: physical, images: [], xutiStyleNo: null, supplierStyleNo: "" }, { id: 2, createdAt: physical, images: [], xutiStyleNo: null, supplierStyleNo: "SUPPLIER" }, firstEntry);
  await audit(3, "UPDATE", raw(3, { images: [image] }), raw(3, { xuti_style_no: "EXPLICIT", created_at: explicit }), "2026-10-16T00:00:00Z");
  await audit(4, "CREATE", null, raw(4, { xuti_style_no: "IMPORTED", created_at: explicit }), "2026-10-16T00:00:00Z");
  await audit(5, "UPDATE", raw(5, { images: [image] }), raw(5), "2026-10-16T00:00:00Z");
  await audit(8, "UPDATE", raw(8), raw(8, { xuti_style_no: "WRONG-WORKSPACE-HISTORY" }), firstEntry, 24);
  await audit(9, "UPDATE", { id: 9, version: 1 }, raw(9, { xuti_style_no: "PARTIAL-HISTORY" }), firstEntry);
  await audit(100, "CREATE", null, raw(100), physical, 23);
  await audit(100, "UPDATE", raw(100), raw(100, { xuti_style_no: "ARCHIVE-PRECREATED", product_id: 100 }), firstEntry, 23);
  await audit(1, "CREATE", null, raw(1), physical, 24);
  await audit(1, "UPDATE", raw(1), raw(1, { xuti_style_no: "PROJECT" }), firstEntry, 24);
  const auditsBefore = await read("SELECT to_jsonb(a) AS value FROM audit_logs a ORDER BY id");
  await installSelectionContentCreatedTimeSchema(database);
  expect(await read("SELECT to_jsonb(a) AS value FROM audit_logs a ORDER BY id")).toEqual(auditsBefore);
  await database.exec(`
    CREATE UNIQUE INDEX archive_product_unique ON selection_table_23.style_selections(product_id) WHERE product_id IS NOT NULL;
    CREATE FUNCTION public.sync_product_archive_record(item public.products,workspace bigint,actor bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      EXECUTE format('INSERT INTO %I.style_selections(product_id,xuti_style_no,created_at,created_by) VALUES($1,$2,$3,$4)
        ON CONFLICT(product_id) WHERE product_id IS NOT NULL DO UPDATE SET xuti_style_no=EXCLUDED.xuti_style_no,updated_at=now()','selection_table_' || workspace)
        USING item.id,item.style_no,item.created_at,actor;
    END $$;
    CREATE TRIGGER product_archive_master_changed AFTER INSERT OR UPDATE ON products FOR EACH ROW EXECUTE FUNCTION public.product_archive_master_changed();
  `);
}, 30000);
afterAll(async () => { await database.close(); });

describe("business creation-time migration evidence", () => {
  it("repairs proven first meaningful events in snake/camel audit snapshots without changing physical dates or creators", async () => {
    const rows = await read("SELECT id,created_at,content_created_at,created_time_source,created_by FROM style_selections WHERE id IN (1,2,5) ORDER BY id");
    for (const row of rows) {
      expect(row.created_at.toISOString()).toBe(physical);
      expect(row.content_created_at.toISOString()).toBe(firstEntry);
      expect(row.created_time_source).toBe("AUTO");
      expect(row.created_by).toBe(8);
    }
  });
  it("preserves explicit date edits and initial imported dates, rather than substituting collection/import time", async () => {
    const rows = await read("SELECT id,created_at,content_created_at,created_time_source FROM style_selections WHERE id IN (3,4) ORDER BY id");
    expect(rows.map(row => [row.created_at.toISOString(), row.content_created_at.toISOString(), row.created_time_source])).toEqual([[explicit, explicit, "EXPLICIT"], [explicit, explicit, "LEGACY"]]);
  });
  it("leaves unrelated-only rows pending and does not invent a correction from incomplete or wrong-workspace audit history", async () => {
    const rows = await read("SELECT id,content_created_at,created_time_source FROM style_selections WHERE id IN (6,7,8,9) ORDER BY id");
    expect(rows[0]).toMatchObject({ content_created_at: null, created_time_source: "PENDING" });
    for (const row of rows.slice(1)) expect([row.content_created_at.toISOString(), row.created_time_source]).toEqual([physical, "LEGACY"]);
  });
  it("repairs archive and selection-layout project dates while retaining old generic-project creation behavior", async () => {
    const archive = (await read("SELECT content_created_at FROM selection_table_23.style_selections"))[0];
    const project = (await read("SELECT content_created_at FROM selection_table_24.style_selections"))[0];
    expect(archive.content_created_at.toISOString()).toBe(firstEntry);
    expect(project.content_created_at.toISOString()).toBe(firstEntry);
    for (const id of [25, 26]) expect((await read(`SELECT content_created_at FROM selection_table_${id}.style_selections`))[0].content_created_at.toISOString()).toBe(physical);
  });
  it("installs triggers in future workspaces and preserves established stamps after meaningful data is cleared", async () => {
    await database.query("INSERT INTO project_tables VALUES(27,NULL,'selection',7)");
    await database.query("SELECT public.create_project_table_workspace(27)");
    const pending = (await read("INSERT INTO selection_table_27.style_selections DEFAULT VALUES RETURNING *"))[0];
    expect(pending.content_created_at).toBeNull();
    const first = (await read("UPDATE selection_table_27.style_selections SET supplier_style_no='FIRST' WHERE id=$1 RETURNING *", [pending.id]))[0];
    expect(first.content_created_at).toBeTruthy();
    const cleared = (await read("UPDATE selection_table_27.style_selections SET supplier_style_no=NULL WHERE id=$1 RETURNING *", [pending.id]))[0];
    expect(cleared.content_created_at).toEqual(first.content_created_at);
    expect(cleared.created_at).toEqual(pending.created_at);
  });
  it("hydrates old deletion snapshots from immutable audit evidence instead of stamping the restore date", async () => {
    const before = raw(99);
    await audit(99, "CREATE", null, before, physical);
    await audit(99, "UPDATE", before, raw(99, { xuti_style_no: "RESTORED" }), firstEntry);
    const restored = (await read("INSERT INTO style_selections OVERRIDING SYSTEM VALUE SELECT restored.* FROM jsonb_populate_record(NULL::style_selections,$1::jsonb) restored RETURNING *", [JSON.stringify(raw(99, { xuti_style_no: "RESTORED" }))]))[0];
    expect(restored.content_created_at.toISOString()).toBe(firstEntry);
    expect(restored.created_at.toISOString()).toBe(physical);
    expect(restored.created_time_source).toBe("AUTO");
  });
  it("keeps an audit-corrected archive date on ordinary master synchronization and changes it only for an explicit master date edit", async () => {
    await database.query("UPDATE products SET updated_at=clock_timestamp() WHERE id=100");
    const ordinary = (await read("SELECT created_at,content_created_at,created_time_source FROM selection_table_23.style_selections WHERE product_id=100"))[0];
    expect(ordinary.created_at.toISOString()).toBe(physical);
    expect(ordinary.content_created_at.toISOString()).toBe(firstEntry);
    await database.query("UPDATE products SET created_at=$1 WHERE id=100", [explicit]);
    const edited = (await read("SELECT created_at,content_created_at,created_time_source FROM selection_table_23.style_selections WHERE product_id=100"))[0];
    expect(edited.created_at.toISOString()).toBe(physical);
    expect(edited.content_created_at.toISOString()).toBe(explicit);
    expect(edited.created_time_source).toBe("EXPLICIT");
    await database.query("INSERT INTO products(id,style_no,created_at) VALUES(101,'NEW-MASTER',$1)", [explicit]);
    const created = (await read("SELECT content_created_at,created_time_source FROM selection_table_23.style_selections WHERE product_id=101"))[0];
    expect(created.content_created_at.toISOString()).toBe(explicit);
    expect(created.created_time_source).toBe("LEGACY");
  });
});

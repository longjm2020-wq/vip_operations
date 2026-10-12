import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Context } from "../../apps/api/src/core.js";
import type { Row, Tx } from "../../packages/database/src/index.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

const fixture = vi.hoisted(() => ({ database: null as PGlite | null }));
// Keep persistence, transactions, product mirroring, permissions and audit real.
// The isolated in-memory SQL database is the only substituted boundary.
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  const wrap = (database: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) => (await database.query<Row>(sql, parameters)).rows,
    $executeRawUnsafe: async (sql: string, ...parameters: unknown[]) => (await database.query(sql, parameters)).affectedRows || 0,
  }) as unknown as Tx;
  const transaction = async (work: (tx: Tx) => Promise<unknown>) => fixture.database!.transaction(async tx => {
    if (selectionScope.getStore()) await tx.query(`SET LOCAL search_path TO "selection_table_${selectionScope.getStore()}", public`);
    return work(wrap(tx));
  });
  return { ...original, db: {
    $queryRawUnsafe: (sql: string, ...parameters: unknown[]) => transaction(tx => tx.$queryRawUnsafe(sql, ...parameters)),
    $transaction: transaction,
  } };
});

import { write, previewImport, commitImport } from "../../apps/api/src/modules/style-selections/service.js";
import { camel } from "../../packages/database/src/index.js";

const actor = (key: string, permissions = ["selection.read", "selection.manage", "product.read", "product.update", "product.create"]): Context => ({ actor: { id: "7", username: "editor", displayName: "Editor", permissions, roleCodes: [] }, requestId: key, key });
const originalTime = "2026-10-11T00:00:00.000Z", editedTime = "2020-01-01T00:00:00.000Z";
const read = async (sql: string, parameters: unknown[] = []) => camel((await fixture.database!.query<Row>(sql, parameters)).rows);
const conflict = { status: 409, response: { error: { code: "EDIT_CONFLICT" } } };

beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(`
    CREATE TABLE users(id bigint PRIMARY KEY,display_name text,username text);
    INSERT INTO users VALUES(7,'Editor','editor'),(8,'Creator','creator');
    CREATE TABLE project_tables(id bigint PRIMARY KEY,initial_layout text,system_key text);
    INSERT INTO project_tables VALUES(23,'empty','PRODUCT_ARCHIVE'),(24,'selection',NULL);
    CREATE TABLE categories(id bigserial PRIMARY KEY,code text,name text,status text,parent_id bigint);
    INSERT INTO categories(code,name,status) VALUES('CATEGORY','Category','ACTIVE');
    CREATE TABLE products(id bigserial PRIMARY KEY,style_no text,name text,category_id bigint,brand_id bigint,default_supplier_id bigint,year integer,season text,remark text,status text DEFAULT 'ACTIVE',custom_fields jsonb DEFAULT '{}',tag_price numeric,main_image_url text,updated_at timestamptz DEFAULT now(),created_at timestamptz DEFAULT now());
    CREATE TABLE product_fields(id text,name text,type text,builtin boolean DEFAULT false,options jsonb DEFAULT '[]',active boolean DEFAULT true,created_at timestamptz DEFAULT now());
    CREATE TABLE style_selection_protection(id integer PRIMARY KEY,settings jsonb,revision integer DEFAULT 1);
    CREATE TABLE style_selections(
      id bigserial PRIMARY KEY,registration_batch date,images jsonb DEFAULT '[]',label_images jsonb DEFAULT '[]',
      cell_colors jsonb DEFAULT '{}',cell_alignments jsonb DEFAULT '{}',cell_vertical_alignments jsonb DEFAULT '{}',cell_text_colors jsonb DEFAULT '{}',cell_number_formats jsonb DEFAULT '{}',extra_fields jsonb DEFAULT '{}',
      xuti_style_no text,supplier_style_no text,supplier_code text,color text,size_range text,material text,
      supply_price_excl_tax numeric,vip_price numeric,live_price numeric,tag_price numeric,selling_points text,reorder_days integer,collection_inventory jsonb DEFAULT '[]',
      sort_order integer DEFAULT 0,row_color text DEFAULT 'NONE',created_by bigint DEFAULT 8,updated_by bigint DEFAULT 8,version integer DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz DEFAULT now(),cell_owners jsonb DEFAULT '{}',claimed_by bigint,
      migration_locked boolean DEFAULT false,migration_target_workspace text,migration_target_row_id bigint,migrated_at timestamptz,product_id bigint
    );
    CREATE TABLE selection_field_registry(workspace_key text,field_key text,owner_id bigint,visibility text,definition jsonb,revision integer DEFAULT 1,updated_at timestamptz DEFAULT now());
    CREATE TABLE selection_layout_preferences(user_id bigint,workspace_key text,table_id bigint,preferences jsonb,revision integer DEFAULT 1,updated_at timestamptz DEFAULT now(),PRIMARY KEY(user_id,workspace_key));
    CREATE TABLE selection_shared_layouts(workspace_key text PRIMARY KEY,preferences jsonb,revision integer DEFAULT 1);
    CREATE TABLE selection_shared_fields(workspace_key text PRIMARY KEY,fields jsonb,revision integer DEFAULT 1);
    CREATE TABLE idempotency_records(id bigserial,actor_id bigint,operation text,idempotency_key text,request_hash text,response_status integer,response_body jsonb);
    CREATE TABLE audit_logs(id bigserial,actor_id bigint,actor_label text,action text,entity_type text,entity_id text,request_id text,before_data jsonb,after_data jsonb,reason text,selection_table_id bigint);
    CREATE SCHEMA selection_table_23;
    CREATE TABLE selection_table_23.style_selections(LIKE public.style_selections INCLUDING ALL);
    CREATE TABLE selection_table_23.style_selection_protection(LIKE public.style_selection_protection INCLUDING ALL);
    CREATE SCHEMA selection_table_24;
    CREATE TABLE selection_table_24.style_selections(LIKE public.style_selections INCLUDING ALL);
    CREATE TABLE selection_table_24.style_selection_protection(LIKE public.style_selection_protection INCLUDING ALL);
  `);
}, 30000);
beforeEach(async () => {
  await fixture.database!.exec("TRUNCATE style_selections,products,product_fields,selection_field_registry,selection_layout_preferences,selection_shared_layouts,selection_shared_fields,idempotency_records,audit_logs,style_selection_protection,selection_table_23.style_selections,selection_table_23.style_selection_protection,selection_table_24.style_selections,selection_table_24.style_selection_protection RESTART IDENTITY");
  for (const scope of ["public", "selection_table_23", "selection_table_24"])
    await fixture.database!.query(`INSERT INTO ${scope}.style_selection_protection(id,settings) VALUES(1,$1)`, [JSON.stringify(defaultProtection)]);
});
afterAll(async () => { await fixture.database?.close(); });

async function savedRow(scope = "public", productId: string | null = null, style = "TIME-1") {
  return (await read(`INSERT INTO ${scope}.style_selections(xuti_style_no,product_id,created_at,updated_at,registration_batch) VALUES($1,$2,$3,$3,'2019-01-01') RETURNING *`, [style, productId, originalTime]))[0];
}

describe("explicit built-in creation-time writes", () => {
  it("claims a new row filled only with creation time and enforces the one-active-row rule", async () => {
    await fixture.database!.query("UPDATE style_selection_protection SET settings=$1 WHERE id=1", [JSON.stringify({ ...defaultProtection, claimsEnabled: true })]);
    const saved = await write(actor("claim-time-only"), { createdAt: editedTime });
    expect(saved).toMatchObject({ createdAt: editedTime, createdBy: 7, claimedBy: 7 });
    const stored = (await read("SELECT * FROM style_selections WHERE id=$1", [saved.id]))[0];
    expect(stored.cellOwners.registrationBatch).toBe("7");
    await expect(write(actor("second-time-only"), { createdAt: originalTime })).rejects.toMatchObject({ status: 409, response: { error: { code: "ROW_CLAIMED" } } });
    expect(await read("SELECT * FROM style_selections")).toHaveLength(1);
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(1);
  });

  it.each([undefined, "24"])("updates the default or project timestamp with normal versioning and audit (%s)", async scope => {
    const row = await savedRow(scope ? `selection_table_${scope}` : "public");
    const c = actor(`edit-${scope}`), patch = { createdAt: "2020-01-01T08:00:00+08:00", expectedUpdatedAt: row.updatedAt };
    const run = () => write(c, patch, String(row.id));
    const saved = scope ? await selectionScope.run(scope, run) : await run();
    expect(saved).toMatchObject({ createdAt: editedTime, createdBy: 8, updatedBy: 7, version: 2, registrationBatch: "2019-01-01" });
    const audits = await read("SELECT * FROM audit_logs");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: "style-selection", beforeData: { createdAt: originalTime }, afterData: { createdAt: editedTime } });
    const stale = () => write(actor(`stale-${scope}`), { createdAt: originalTime, expectedUpdatedAt: row.updatedAt }, String(row.id));
    await expect(scope ? selectionScope.run(scope, stale) : stale()).rejects.toMatchObject(conflict);
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(1);
  });

  it("updates linked product creation time and the archive snapshot atomically, preserving it on ordinary edits", async () => {
    const product = (await read("INSERT INTO products(style_no,name,category_id,created_at) VALUES('TIME-PRODUCT','Product',1,$1) RETURNING *", ["2010-01-01T00:00:00.000Z"]))[0];
    const row = await savedRow("selection_table_23", String(product.id), "TIME-PRODUCT");
    const saved = await selectionScope.run("23", () => write(actor("archive-edit"), { createdAt: editedTime, expectedUpdatedAt: row.updatedAt }, String(row.id)));
    expect(saved.createdAt).toBe(editedTime);
    expect((await read("SELECT created_at FROM products WHERE id=$1", [product.id]))[0].createdAt).toBe(editedTime);
    expect((await read("SELECT created_at FROM selection_table_23.style_selections WHERE id=$1", [row.id]))[0].createdAt).toBe(editedTime);
    const audits = await read("SELECT * FROM audit_logs ORDER BY id");
    expect(audits.map((item: Row) => item.entityType)).toEqual(["products", "style-selection"]);
    expect(audits[0].beforeData.createdAt).toBe("2010-01-01T00:00:00.000Z");
    expect(audits[0].afterData.createdAt).toBe(editedTime);
    await selectionScope.run("23", () => write(actor("archive-normal"), { material: "Cotton", expectedUpdatedAt: saved.updatedAt }, String(row.id)));
    expect((await read("SELECT created_at FROM products WHERE id=$1", [product.id]))[0].createdAt).toBe(editedTime);
  });

  it("retains a content-free unlinked archive row and enforces product permission before committing a linked edit", async () => {
    const empty = await savedRow("selection_table_23", null, "");
    const saved = await selectionScope.run("23", () => write(actor("unlinked"), { createdAt: editedTime }, String(empty.id)));
    expect(saved).toMatchObject({ createdAt: editedTime, productId: null });
    expect(await read("SELECT * FROM products")).toHaveLength(0);
    const product = (await read("INSERT INTO products(style_no,name,category_id,created_at) VALUES('DENIED','Product',1,$1) RETURNING *", [originalTime]))[0];
    const row = await savedRow("selection_table_23", String(product.id), "DENIED");
    await expect(selectionScope.run("23", () => write(actor("denied-product", ["selection.read", "selection.manage"]), { createdAt: editedTime }, String(row.id)))).rejects.toMatchObject({ status: 403 });
    expect((await read("SELECT created_at,version FROM selection_table_23.style_selections WHERE id=$1", [row.id]))[0]).toMatchObject({ createdAt: originalTime, version: 1 });
    expect((await read("SELECT created_at FROM products WHERE id=$1", [product.id]))[0].createdAt).toBe(originalTime);
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(1);
  });

  it("preserves a draft's edited creation time when the product is created in a later save", async () => {
    const empty = await savedRow("selection_table_23", null, "");
    const draft = await selectionScope.run("23", () => write(actor("draft-time"), { createdAt: editedTime, expectedUpdatedAt: empty.updatedAt }, String(empty.id)));
    const saved = await selectionScope.run("23", () => write(actor("draft-product"), { xutiStyleNo: "DRAFT-PRODUCT", expectedUpdatedAt: draft.updatedAt }, String(empty.id)));
    expect(saved).toMatchObject({ createdAt: editedTime, createdBy: 8 });
    expect(saved.productId).toBeTruthy();
    expect((await read("SELECT created_at FROM products WHERE id=$1", [saved.productId]))[0].createdAt).toBe(editedTime);
    expect((await read("SELECT created_at FROM selection_table_23.style_selections WHERE id=$1", [empty.id]))[0].createdAt).toBe(editedTime);
  });

  it("records ownership on the same protected column used by multi-row paste and rejects invalid timestamps before saving", async () => {
    const first = await savedRow(), second = await savedRow("public", null, "TIME-2");
    for (const row of [first, second]) await write(actor(`paste-${row.id}`), { createdAt: editedTime, expectedUpdatedAt: row.updatedAt }, String(row.id));
    expect((await read("SELECT created_at,cell_owners,version FROM style_selections ORDER BY id")).map((row: Row) => [row.createdAt, row.cellOwners.registrationBatch, row.version])).toEqual([[editedTime, "7", 2], [editedTime, "7", 2]]);
    for (const createdAt of [null, "", "2026-02-30T00:00:00Z", "2026-10-11 00:00:00"])
      await expect(write(actor(`invalid-${createdAt}`), { createdAt }, String(first.id))).rejects.toMatchObject({ status: 400 });
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(2);
  });
});

const importPayload = (plan: Awaited<ReturnType<typeof previewImport>>) => ({ rows: plan.rows, fields: plan.fields,
  fieldRevision: plan.fieldRevision, layoutRevision: plan.layoutRevision, existingStrategy: plan.existingStrategy });
const importInput = (values: Row[], existingStrategy: "OVERWRITE" | "SKIP" = "OVERWRITE") => ({ rows: values, existingStrategy });

describe("atomic creation-time Excel imports", () => {
  it("overwrites timestamps in default and ordinary project tables without replacing the legacy batch or other values", async () => {
    for (const scope of [undefined, "24"]) {
      const table = scope ? `selection_table_${scope}.style_selections` : "style_selections";
      const row = await savedRow(scope ? `selection_table_${scope}` : "public");
      await fixture.database!.query(`UPDATE ${table} SET material='Original material' WHERE id=$1`, [row.id]);
      const run = async () => {
        const c = actor(`import-overwrite-${scope}`), plan = await previewImport(c, importInput([{ xutiStyleNo: "TIME-1", createdAt: editedTime }]));
        expect(plan).toMatchObject({ updated: 1, created: 0, skipped: 0, fields: [
          { header: "创建时间", key: "registrationBatch", type: "createdTime", isNew: false },
          { header: "序缇款号", key: "xutiStyleNo", isNew: false },
        ] });
        expect(plan.rows[0]).toMatchObject({ operation: "UPDATE", changedFields: ["创建时间"] });
        await commitImport(c, importPayload(plan));
      };
      await (scope ? selectionScope.run(scope, run) : run());
      expect((await read(`SELECT created_at,registration_batch,material,created_by,version,cell_owners FROM ${table}`))[0]).toMatchObject({
        createdAt: editedTime, registrationBatch: "2019-01-01T00:00:00.000Z", material: "Original material", createdBy: 8, version: 2, cellOwners: { registrationBatch: "7" },
      });
    }
  });

  it("retains skipped timestamps and imports supplied timestamps for new rows", async () => {
    await savedRow();
    const c = actor("import-skip"), plan = await previewImport(c, importInput([
      { xutiStyleNo: "TIME-1", createdAt: editedTime }, { xutiStyleNo: "TIME-NEW", createdAt: "2025-04-22T00:42:00+08:00" },
    ], "SKIP"));
    expect(plan).toMatchObject({ updated: 0, created: 1, skipped: 1 });
    await commitImport(c, importPayload(plan));
    const rows = await read("SELECT xuti_style_no,created_at,created_by,version FROM style_selections ORDER BY id");
    expect(rows).toEqual([
      { xutiStyleNo: "TIME-1", createdAt: originalTime, createdBy: 8, version: 1 },
      { xutiStyleNo: "TIME-NEW", createdAt: "2025-04-21T16:42:00.000Z", createdBy: 7, version: 1 },
    ]);
  });

  it("preserves omitted and blank timestamps while ordinary fields can still update", async () => {
    for (const [index] of [undefined, null, "", "  "].entries()) await savedRow("public", null, `BLANK-${index}`);
    const c = actor("import-blank"), plan = await previewImport(c, importInput([undefined, null, "", "  "].map((createdAt, index) => ({
      xutiStyleNo: `BLANK-${index}`, ...(index ? { createdAt } : {}), material: "Changed material",
    }))));
    expect(plan.updated).toBe(4);
    expect(plan.rows.every(row => !Object.hasOwn(row.values, "createdAt"))).toBe(true);
    await commitImport(c, importPayload(plan));
    expect((await read("SELECT created_at,material FROM style_selections")).every((row: Row) => row.createdAt === originalTime && row.material === "Changed material")).toBe(true);
    const timestampOnly = await previewImport(actor("blank-only"), importInput([{ xutiStyleNo: "BLANK-0", createdAt: "" }]));
    expect(timestampOnly).toMatchObject({ updated: 0, skipped: 1 });
  });

  it("normalizes a creation-time fieldValues header and rejects duplicate or invalid timestamps", async () => {
    await savedRow();
    const c = actor("field-value-time"), plan = await previewImport(c, importInput([{ xutiStyleNo: "TIME-1", fieldValues: { 创建时间: "2025/4/22 0:42" } }]));
    expect(plan.rows[0].values).toEqual({ xutiStyleNo: "TIME-1", createdAt: "2025-04-21T16:42:00.000Z" });
    await commitImport(c, importPayload(plan));
    expect((await read("SELECT created_at FROM style_selections"))[0].createdAt).toBe("2025-04-21T16:42:00.000Z");
    for (const value of [
      { createdAt: editedTime, fieldValues: { 创建时间: "2025-04-22" } },
      { fieldValues: { 创建时间: "2025-02-30" } },
      { createdAt: "2025-04-22 00:42:00" },
      { createdAt: "2025-02-30T00:42:00+08:00" },
    ]) await expect(previewImport(actor("invalid-import"), importInput([{ xutiStyleNo: "TIME-1", ...value }]))).rejects.toMatchObject({ status: 400 });
    expect((await read("SELECT created_at FROM style_selections"))[0].createdAt).toBe("2025-04-21T16:42:00.000Z");
  });

  it("updates linked products and newly created products using the supplied instant", async () => {
    const product = (await read("INSERT INTO products(style_no,name,category_id,created_at) VALUES('TIME-PRODUCT','Original name',1,$1) RETURNING *", ["2010-01-01T00:00:00.000Z"]))[0];
    await savedRow("selection_table_23", String(product.id), "TIME-PRODUCT");
    await selectionScope.run("23", async () => {
      const c = actor("archive-import"), plan = await previewImport(c, importInput([
        { xutiStyleNo: "TIME-PRODUCT", createdAt: editedTime }, { xutiStyleNo: "NEW-PRODUCT", createdAt: "2025-04-22T00:42:00+08:00" },
      ]));
      expect(plan).toMatchObject({ updated: 1, created: 1 });
      await commitImport(c, importPayload(plan));
    });
    expect(await read("SELECT style_no,name,created_at FROM products ORDER BY id")).toEqual([
      { styleNo: "TIME-PRODUCT", name: "Original name", createdAt: editedTime },
      { styleNo: "NEW-PRODUCT", name: "NEW-PRODUCT", createdAt: "2025-04-21T16:42:00.000Z" },
    ]);
    expect((await read("SELECT created_at FROM selection_table_23.style_selections ORDER BY id")).map((row: Row) => row.createdAt)).toEqual([editedTime, "2025-04-21T16:42:00.000Z"]);
    const audits = await read("SELECT entity_type,before_data,after_data FROM audit_logs WHERE entity_type='products' ORDER BY id");
    expect(audits[0]).toMatchObject({ beforeData: { createdAt: "2010-01-01T00:00:00.000Z" }, afterData: { createdAt: editedTime } });
  });

  it.each([undefined, "23"])("uses the built-in timestamp despite a same-named private system field and keeps other system fields read-only (%s)", async scope => {
    const table = scope ? `selection_table_${scope}.style_selections` : "style_selections";
    await savedRow(scope ? `selection_table_${scope}` : "public");
    const custom = { key: "custom:time", label: "创建时间", type: "createdTime", width: 120, custom: true };
    const other = { key: "custom:automatic", label: "自动建档", type: "createdTime", width: 120, custom: true };
    for (const field of [custom, other]) await fixture.database!.query("INSERT INTO selection_field_registry(workspace_key,field_key,owner_id,visibility,definition) VALUES($1,$2,$3,'PRIVATE',$4)", [scope || "default", field.key, field === custom ? "8" : "7", JSON.stringify(field)]);
    const run = async () => {
      const c = actor("same-label-time"), plan = await previewImport(c, importInput([{ xutiStyleNo: "TIME-1", createdAt: editedTime }]));
      expect(plan.fields.find(field => field.header === "创建时间")).toMatchObject({ key: "registrationBatch", isNew: false });
      await commitImport(c, importPayload(plan));
      await expect(previewImport(actor("other-system"), importInput([{ xutiStyleNo: "TIME-1", fieldValues: { 自动建档: "2020-01-01" } }]))).rejects.toMatchObject({ status: 400 });
    };
    await (scope ? selectionScope.run(scope, run) : run());
    expect((await read(`SELECT created_at,extra_fields FROM ${table}`))[0]).toMatchObject({ createdAt: editedTime });
    expect((await read(`SELECT extra_fields FROM ${table}`))[0].extraFields).not.toHaveProperty(custom.key);
  });

  it("stores an old registration batch independently from the imported creation timestamp", async () => {
    await savedRow();
    const c = actor("legacy-and-time"), plan = await previewImport(c, importInput([{ xutiStyleNo: "TIME-1", registrationBatch: "2018-02-01", createdAt: editedTime }]));
    await commitImport(c, importPayload(plan));
    expect((await read("SELECT registration_batch,created_at FROM style_selections"))[0]).toEqual({ registrationBatch: "2018-02-01T00:00:00.000Z", createdAt: editedTime });
  });

  it("enforces built-in protection, hidden columns and archive product permissions before any import writes", async () => {
    const row = await savedRow();
    const region = { id: "123e4567-e89b-42d3-a456-426614174000", name: "Creation", scope: "columns", rowIds: [], columnKeys: ["registrationBatch"], users: {}, others: "read" };
    await fixture.database!.query("UPDATE style_selection_protection SET settings=$1", [JSON.stringify({ ...defaultProtection, enabled: true, regions: [region] })]);
    await expect(previewImport(actor("protected-import"), importInput([{ xutiStyleNo: "TIME-1", createdAt: originalTime }]))).rejects.toMatchObject({ status: 403 });
    await fixture.database!.query("UPDATE style_selection_protection SET settings=$1", [JSON.stringify(defaultProtection)]);
    await fixture.database!.query("INSERT INTO selection_layout_preferences(user_id,workspace_key,preferences) VALUES(7,'default',$1)", [JSON.stringify(selectionLayoutSchema.parse({ columns: [{ key: "registrationBatch", label: "创建时间", type: "createdTime", width: 120 }], hiddenColumns: ["registrationBatch"] }))]);
    await expect(previewImport(actor("hidden-import"), importInput([{ xutiStyleNo: "TIME-1", createdAt: editedTime }]))).rejects.toMatchObject({ status: 403 });
    const product = (await read("INSERT INTO products(style_no,name,category_id,created_at) VALUES('PRODUCT-DENIED','Product',1,$1) RETURNING *", [originalTime]))[0];
    await savedRow("selection_table_23", String(product.id), "PRODUCT-DENIED");
    await expect(selectionScope.run("23", () => previewImport(actor("product-denied-import", ["selection.read", "selection.manage"]), importInput([{ xutiStyleNo: "PRODUCT-DENIED", createdAt: editedTime }])))).rejects.toMatchObject({ status: 403 });
    expect((await read("SELECT created_at,version FROM style_selections WHERE id=$1", [row.id]))[0]).toMatchObject({ createdAt: originalTime, version: 1 });
    expect((await read("SELECT created_at FROM products"))[0].createdAt).toBe(originalTime);
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(0);
  });

  it("rejects a changed product version and rolls back every row in the batch", async () => {
    for (const number of ["PRODUCT-FIRST", "PRODUCT-SECOND"]) {
      const product = (await read("INSERT INTO products(style_no,name,category_id,created_at) VALUES($1,'Product',1,$2) RETURNING *", [number, originalTime]))[0];
      await savedRow("selection_table_23", String(product.id), number);
    }
    await selectionScope.run("23", async () => {
      const c = actor("stale-import"), plan = await previewImport(c, importInput([
        { xutiStyleNo: "PRODUCT-FIRST", createdAt: editedTime }, { xutiStyleNo: "PRODUCT-SECOND", createdAt: editedTime },
      ]));
      await fixture.database!.query("UPDATE products SET updated_at=updated_at+interval '1 second' WHERE style_no='PRODUCT-SECOND'");
      await expect(commitImport(c, importPayload(plan))).rejects.toMatchObject(conflict);
    });
    expect((await read("SELECT created_at FROM products")).map((row: Row) => row.createdAt)).toEqual([originalTime, originalTime]);
    expect((await read("SELECT created_at,version FROM selection_table_23.style_selections")).map((row: Row) => [row.createdAt, row.version])).toEqual([[originalTime, 1], [originalTime, 1]]);
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(0);
  });
});

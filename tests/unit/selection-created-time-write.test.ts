import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Context } from "../../apps/api/src/core.js";
import type { Row, Tx } from "../../packages/database/src/index.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";
import { selectionLayoutSchema, selectionSharedLayoutSchema } from "../../packages/contracts/src/selection-layout.js";
import { installSelectionContentCreatedTimeSchema } from "../fixtures/selection-content-created-time-schema.js";

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
  await installSelectionContentCreatedTimeSchema(fixture.database);
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
  it("keeps saved blank identities pending when only unrelated data, label images, custom images or formatting changes", async () => {
    const first = await write(actor("save-blank"), {});
    expect(first).toMatchObject({ createdAt: null, creationTimePending: true, createdBy: 7 });
    expect(first.id).toBeTruthy();
    const custom = { key: "custom:photo", label: "自定义图片", type: "image", width: 100, custom: true };
    await fixture.database!.query("INSERT INTO selection_field_registry(workspace_key,field_key,owner_id,visibility,definition) VALUES('default',$1,7,'PRIVATE',$2)", [custom.key, JSON.stringify(custom)]);
    const label = { id: "label", url: "https://example.test/label.jpg", color: "" };
    const saved = await write(actor("other-data"), { material: "Only material", supplierCode: "Only code", xutiStyleNo: " ", supplierStyleNo: " ", labelImages: [label], extraFields: { [custom.key]: JSON.stringify([label]) }, cellColors: { material: "BLUE" }, vipPrice: "10", expectedUpdatedAt: first.updatedAt }, String(first.id));
    expect(saved).toMatchObject({ createdAt: null, creationTimePending: true, createdBy: 7 });
    const raw = (await read("SELECT created_at,content_created_at,created_time_source FROM style_selections"))[0];
    expect(raw.createdAt).toBeTruthy();
    expect(raw).toMatchObject({ contentCreatedAt: null, createdTimeSource: "PENDING" });
  });

  it.each([undefined, "23", "24"])("stamps the first supplier style in a saved blank row once and preserves it after clearing (%s)", async scope => {
    const row = await savedRow(scope ? `selection_table_${scope}` : "public", null, "");
    const run = async () => {
      const saved = await write(actor(`supplier-first-${scope}`), { supplierStyleNo: " SUPPLIER-FIRST ", expectedUpdatedAt: row.updatedAt }, String(row.id));
      expect(saved).toMatchObject({ creationTimePending: false, createdBy: 8, supplierStyleNo: "SUPPLIER-FIRST" });
      expect(new Date(saved.createdAt).getTime()).toBeGreaterThan(new Date(originalTime).getTime());
      const cleared = await write(actor(`clear-first-${scope}`), { supplierStyleNo: null, images: [], expectedUpdatedAt: saved.updatedAt }, String(row.id));
      expect(cleared).toMatchObject({ createdAt: saved.createdAt, creationTimePending: false, createdBy: 8 });
      const renamed = await write(actor(`refill-first-${scope}`), { supplierStyleNo: "SECOND", expectedUpdatedAt: cleared.updatedAt }, String(row.id));
      expect(renamed.createdAt).toBe(saved.createdAt);
      const edited = await write(actor(`explicit-cleared-${scope}`), { supplierStyleNo: null, createdAt: editedTime, expectedUpdatedAt: renamed.updatedAt }, String(row.id));
      expect(edited.createdAt).toBe(editedTime);
    };
    await (scope ? selectionScope.run(scope, run) : run());
    expect((await read(`SELECT created_at,content_created_at,created_time_source,created_by FROM ${scope ? `selection_table_${scope}.` : ""}style_selections`))[0]).toMatchObject({ createdAt: originalTime, contentCreatedAt: editedTime, createdTimeSource: "EXPLICIT", createdBy: 8 });
  });

  it("stamps an authorized first product image independently of a read-only date column and survives idempotent retry", async () => {
    const row = await savedRow("public", null, "");
    await fixture.database!.query("UPDATE style_selection_protection SET settings=$1", [JSON.stringify({ ...defaultProtection, enabled: true, autoHide: true,
      regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Date readonly", scope: "columns", rowIds: [], columnKeys: ["registrationBatch"], users: {}, others: "read" }],
      autoHideRegions: [{ id: "123e4567-e89b-42d3-a456-426614174001", name: "Own date", scope: "columns", rowIds: [], columnKeys: ["registrationBatch"] }] })]);
    const c = actor("first-image"), image = { id: "product", url: "https://example.test/product.jpg", color: "" }, patch = { images: [image], expectedUpdatedAt: row.updatedAt };
    const saved = await write(c, patch, String(row.id)), retried = await write(c, patch, String(row.id));
    expect(saved).toMatchObject({ creationTimePending: false, createdBy: 8, version: 2 });
    expect(saved.createdAt).toBeTruthy();
    expect(retried.createdAt).toBe(saved.createdAt);
    expect((await read("SELECT cell_owners FROM style_selections"))[0].cellOwners).toMatchObject({ images: "7", registrationBatch: "7" });
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(1);
  });

  it.each(["blank", "empty"])("preserves physical creation dates in new generic %s project workspaces", async initial => {
    await fixture.database!.query("INSERT INTO project_tables(id,initial_layout) VALUES(25,$1)", [initial]);
    await fixture.database!.query("SELECT public.create_project_table_workspace(25)");
    const saved = await selectionScope.run("25", () => write(actor(`generic-${initial}`), {}));
    expect(saved).toMatchObject({ creationTimePending: false, createdBy: 7 });
    expect(saved.createdAt).toBeTruthy();
    const raw = (await read("SELECT created_at,content_created_at FROM selection_table_25.style_selections"))[0];
    expect(raw.contentCreatedAt).toBe(raw.createdAt);
    await fixture.database!.exec("DROP SCHEMA selection_table_25 CASCADE; DELETE FROM project_tables WHERE id=25");
  });
  it("requires meaningful content before a date can claim a new row and enforces the one-active-row rule", async () => {
    await fixture.database!.query("UPDATE style_selection_protection SET settings=$1 WHERE id=1", [JSON.stringify({ ...defaultProtection, claimsEnabled: true })]);
    await expect(write(actor("reject-time-only"), { createdAt: editedTime })).rejects.toMatchObject({ status: 400, response: { error: { code: "CREATION_TIME_PENDING" } } });
    const saved = await write(actor("claim-time-only"), { xutiStyleNo: "FIRST", createdAt: editedTime });
    expect(saved).toMatchObject({ createdAt: editedTime, createdBy: 7, claimedBy: 7 });
    const stored = (await read("SELECT * FROM style_selections WHERE id=$1", [saved.id]))[0];
    expect(stored.cellOwners.registrationBatch).toBe("7");
    await expect(write(actor("second-time-only"), { xutiStyleNo: "SECOND", createdAt: originalTime })).rejects.toMatchObject({ status: 409, response: { error: { code: "ROW_CLAIMED" } } });
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
    expect(audits[0]).toMatchObject({ entityType: "style-selection", beforeData: { createdAt: originalTime }, afterData: { createdAt: originalTime, contentCreatedAt: editedTime, createdTimeSource: "EXPLICIT" } });
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
    expect((await read("SELECT created_at,content_created_at FROM selection_table_23.style_selections WHERE id=$1", [row.id]))[0]).toMatchObject({ createdAt: originalTime, contentCreatedAt: editedTime });
    const audits = await read("SELECT * FROM audit_logs ORDER BY id");
    expect(audits.map((item: Row) => item.entityType)).toEqual(["products", "style-selection"]);
    expect(audits[0].beforeData.createdAt).toBe("2010-01-01T00:00:00.000Z");
    expect(audits[0].afterData.createdAt).toBe(editedTime);
    await selectionScope.run("23", () => write(actor("archive-normal"), { material: "Cotton", expectedUpdatedAt: saved.updatedAt }, String(row.id)));
    expect((await read("SELECT created_at FROM products WHERE id=$1", [product.id]))[0].createdAt).toBe(editedTime);
  });

  it("retains a content-free unlinked archive row and enforces product permission before committing a linked edit", async () => {
    const empty = await savedRow("selection_table_23", null, "");
    await expect(selectionScope.run("23", () => write(actor("unlinked"), { createdAt: editedTime }, String(empty.id)))).rejects.toMatchObject({ status: 400, response: { error: { code: "CREATION_TIME_PENDING" } } });
    expect(empty).toMatchObject({ contentCreatedAt: null, productId: null });
    expect(await read("SELECT * FROM products")).toHaveLength(0);
    const product = (await read("INSERT INTO products(style_no,name,category_id,created_at) VALUES('DENIED','Product',1,$1) RETURNING *", [originalTime]))[0];
    const row = await savedRow("selection_table_23", String(product.id), "DENIED");
    await expect(selectionScope.run("23", () => write(actor("denied-product", ["selection.read", "selection.manage"]), { createdAt: editedTime }, String(row.id)))).rejects.toMatchObject({ status: 403 });
    expect((await read("SELECT created_at,version FROM selection_table_23.style_selections WHERE id=$1", [row.id]))[0]).toMatchObject({ createdAt: originalTime, version: 1 });
    expect((await read("SELECT created_at FROM products WHERE id=$1", [product.id]))[0].createdAt).toBe(originalTime);
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(0);
  });

  it("preserves a draft's edited creation time when the product is created in a later save", async () => {
    const empty = await savedRow("selection_table_23", null, "");
    const draft = await selectionScope.run("23", () => write(actor("draft-time"), { supplierStyleNo: "SUPPLIER-DRAFT", createdAt: editedTime, expectedUpdatedAt: empty.updatedAt }, String(empty.id)));
    const saved = await selectionScope.run("23", () => write(actor("draft-product"), { xutiStyleNo: "DRAFT-PRODUCT", expectedUpdatedAt: draft.updatedAt }, String(empty.id)));
    expect(saved).toMatchObject({ createdAt: editedTime, createdBy: 8 });
    expect(saved.productId).toBeTruthy();
    expect((await read("SELECT created_at FROM products WHERE id=$1", [saved.productId]))[0].createdAt).toBe(editedTime);
    expect((await read("SELECT created_at,content_created_at FROM selection_table_23.style_selections WHERE id=$1", [empty.id]))[0]).toMatchObject({ createdAt: originalTime, contentCreatedAt: editedTime });
  });

  it("records ownership on the same protected column used by multi-row paste and rejects invalid timestamps before saving", async () => {
    const first = await savedRow(), second = await savedRow("public", null, "TIME-2");
    for (const row of [first, second]) await write(actor(`paste-${row.id}`), { createdAt: editedTime, expectedUpdatedAt: row.updatedAt }, String(row.id));
    expect((await read("SELECT content_created_at AS created_at,cell_owners,version FROM style_selections ORDER BY id")).map((row: Row) => [row.createdAt, row.cellOwners.registrationBatch, row.version])).toEqual([[editedTime, "7", 2], [editedTime, "7", 2]]);
    for (const createdAt of [null, "", "2026-02-30T00:00:00Z", "2026-10-11 00:00:00"])
      await expect(write(actor(`invalid-${createdAt}`), { createdAt }, String(first.id))).rejects.toMatchObject({ status: 400 });
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(2);
  });
  it("marks an explicitly supplied date as authoritative even when its value matches the current automatic timestamp", async () => {
    const row = await savedRow();
    const saved = await write(actor("same-date-explicit"), { createdAt: originalTime, expectedUpdatedAt: row.updatedAt }, String(row.id));
    expect(saved.createdAt).toBe(originalTime);
    expect((await read("SELECT created_at,content_created_at,created_time_source FROM style_selections"))[0]).toEqual({ createdAt: originalTime, contentCreatedAt: originalTime, createdTimeSource: "EXPLICIT" });
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
      expect((await read(`SELECT content_created_at AS created_at,registration_batch,material,created_by,version,cell_owners FROM ${table}`))[0]).toMatchObject({
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
    const rows = await read("SELECT xuti_style_no,content_created_at AS created_at,created_by,version FROM style_selections ORDER BY id");
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
    expect((await read("SELECT content_created_at AS created_at FROM style_selections"))[0].createdAt).toBe("2025-04-21T16:42:00.000Z");
    for (const value of [
      { createdAt: editedTime, fieldValues: { 创建时间: "2025-04-22" } },
      { fieldValues: { 创建时间: "2025-02-30" } },
      { createdAt: "2025-04-22 00:42:00" },
      { createdAt: "2025-02-30T00:42:00+08:00" },
    ]) await expect(previewImport(actor("invalid-import"), importInput([{ xutiStyleNo: "TIME-1", ...value }]))).rejects.toMatchObject({ status: 400 });
    expect((await read("SELECT content_created_at AS created_at FROM style_selections"))[0].createdAt).toBe("2025-04-21T16:42:00.000Z");
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
    expect((await read("SELECT content_created_at AS created_at FROM selection_table_23.style_selections ORDER BY id")).map((row: Row) => row.createdAt)).toEqual([editedTime, "2025-04-21T16:42:00.000Z"]);
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
    expect((await read(`SELECT content_created_at AS created_at,extra_fields FROM ${table}`))[0]).toMatchObject({ createdAt: editedTime });
    expect((await read(`SELECT extra_fields FROM ${table}`))[0].extraFields).not.toHaveProperty(custom.key);
  });

  it("stores an old registration batch independently from the imported creation timestamp", async () => {
    await savedRow();
    const c = actor("legacy-and-time"), plan = await previewImport(c, importInput([{ xutiStyleNo: "TIME-1", registrationBatch: "2018-02-01", createdAt: editedTime }]));
    await commitImport(c, importPayload(plan));
    expect((await read("SELECT registration_batch,content_created_at AS created_at FROM style_selections"))[0]).toEqual({ registrationBatch: "2018-02-01T00:00:00.000Z", createdAt: editedTime });
  });

  it.each(["hidden", "deleted", "missing"])("imports native creation metadata without changing a %s built-in display column or private system mirror", async mode => {
    const product = (await read("INSERT INTO products(style_no,name,category_id,created_at) VALUES('VIRTUAL-TIME','Product',1,$1) RETURNING *", [originalTime]))[0];
    const row = await savedRow("selection_table_23", String(product.id), "VIRTUAL-TIME");
    const mirror = { key: "custom:creation-mirror", label: "创建时间", type: "createdTime", width: 168, custom: true, ownerId: "7", visibility: "PRIVATE" };
    const style = { key: "xutiStyleNo", label: "序缇款号", type: "text", width: 142 };
    const builtIn = { key: "registrationBatch", label: "创建时间", type: "createdTime", width: 191, ...(mode === "deleted" ? { deleted: true } : {}) };
    const columns = mode === "missing" ? [style] : [style, builtIn];
    const hiddenColumns = mode === "hidden" ? ["registrationBatch"] : [];
    const personal = selectionLayoutSchema.parse({ columns: [...columns, mirror], hiddenColumns, fixedColumns: ["xutiStyleNo"], rowHeight: "loose" });
    const shared = selectionSharedLayoutSchema.parse({ columns, hiddenColumns, fixedColumns: ["xutiStyleNo"], rowHeight: "loose" });
    await fixture.database!.query("INSERT INTO selection_field_registry(workspace_key,field_key,owner_id,visibility,definition) VALUES('23',$1,7,'PRIVATE',$2)", [mirror.key, JSON.stringify(mirror)]);
    await fixture.database!.query("INSERT INTO selection_layout_preferences(user_id,workspace_key,table_id,preferences,revision) VALUES(7,'23',23,$1,4)", [JSON.stringify(personal)]);
    await fixture.database!.query("INSERT INTO selection_shared_layouts(workspace_key,preferences,revision) VALUES('23',$1,9)", [JSON.stringify(shared)]);
    await fixture.database!.query("UPDATE selection_table_23.style_selections SET extra_fields=$1 WHERE id=$2", [JSON.stringify({ [mirror.key]: "Original private value" }), row.id]);
    const beforePersonal = await read("SELECT * FROM selection_layout_preferences"), beforeShared = await read("SELECT * FROM selection_shared_layouts"), beforeRegistry = await read("SELECT * FROM selection_field_registry");
    await selectionScope.run("23", async () => {
      const c = actor(`virtual-time-${mode}`), plan = await previewImport(c, importInput([{ xutiStyleNo: "VIRTUAL-TIME", createdAt: editedTime }]));
      expect(plan).toMatchObject({ updated: 1, created: 0 });
      expect(plan.fields.find(field => field.header === "创建时间")).toMatchObject({ key: "registrationBatch", type: "createdTime", isNew: false });
      expect(await commitImport(c, importPayload(plan))).toMatchObject({ updated: 1, fieldsCreated: 0 });
    });
    expect((await read("SELECT created_at FROM products WHERE id=$1", [product.id]))[0].createdAt).toBe(editedTime);
    expect((await read("SELECT content_created_at AS created_at,extra_fields FROM selection_table_23.style_selections WHERE id=$1", [row.id]))[0]).toEqual({ createdAt: editedTime, extraFields: expect.objectContaining({ [mirror.key]: "Original private value" }) });
    expect(await read("SELECT * FROM selection_layout_preferences")).toEqual(beforePersonal);
    expect(await read("SELECT * FROM selection_shared_layouts")).toEqual(beforeShared);
    expect(await read("SELECT * FROM selection_field_registry")).toEqual(beforeRegistry);
    expect(await read("SELECT * FROM audit_logs WHERE action='IMPORT_FIELDS'")).toHaveLength(0);
  });

  it("enforces built-in protection despite a hidden column and archive product permissions before any import writes", async () => {
    const row = await savedRow();
    const region = { id: "123e4567-e89b-42d3-a456-426614174000", name: "Creation", scope: "columns", rowIds: [], columnKeys: ["registrationBatch"], users: {}, others: "read" };
    await fixture.database!.query("UPDATE style_selection_protection SET settings=$1", [JSON.stringify({ ...defaultProtection, enabled: true, regions: [region] })]);
    await expect(previewImport(actor("protected-import"), importInput([{ xutiStyleNo: "TIME-1", createdAt: originalTime }]))).rejects.toMatchObject({ status: 403 });
    await fixture.database!.query("INSERT INTO selection_layout_preferences(user_id,workspace_key,preferences) VALUES(7,'default',$1)", [JSON.stringify(selectionLayoutSchema.parse({ columns: [{ key: "registrationBatch", label: "创建时间", type: "createdTime", width: 120 }], hiddenColumns: ["registrationBatch"] }))]);
    await expect(previewImport(actor("hidden-import"), importInput([{ xutiStyleNo: "TIME-1", createdAt: editedTime }]))).rejects.toMatchObject({ status: 403 });
    await fixture.database!.query("UPDATE style_selection_protection SET settings=$1", [JSON.stringify(defaultProtection)]);
    const product = (await read("INSERT INTO products(style_no,name,category_id,created_at) VALUES('PRODUCT-DENIED','Product',1,$1) RETURNING *", [originalTime]))[0];
    await savedRow("selection_table_23", String(product.id), "PRODUCT-DENIED");
    await expect(selectionScope.run("23", () => previewImport(actor("product-denied-import", ["selection.read", "selection.manage"]), importInput([{ xutiStyleNo: "PRODUCT-DENIED", createdAt: editedTime }])))).rejects.toMatchObject({ status: 403 });
    expect((await read("SELECT created_at,version FROM style_selections WHERE id=$1", [row.id]))[0]).toMatchObject({ createdAt: originalTime, version: 1 });
    expect((await read("SELECT created_at FROM products"))[0].createdAt).toBe(originalTime);
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(0);
  });

  it.each(["private", "claimed", "locked"])("does not bypass %s access through the native timestamp binding", async mode => {
    const row = await savedRow();
    if (mode === "private") await fixture.database!.query("INSERT INTO selection_field_registry(workspace_key,field_key,owner_id,visibility,definition) VALUES('default','registrationBatch',8,'PRIVATE',$1)", [JSON.stringify({ key: "registrationBatch", label: "创建时间", type: "createdTime", width: 120, deleted: true })]);
    if (mode === "claimed") {
      await fixture.database!.query("UPDATE style_selection_protection SET settings=$1", [JSON.stringify({ ...defaultProtection, claimsEnabled: true })]);
      await fixture.database!.query("UPDATE style_selections SET claimed_by=8 WHERE id=$1", [row.id]);
    }
    if (mode === "locked") await fixture.database!.query("UPDATE style_selections SET migration_locked=true WHERE id=$1", [row.id]);
    await expect(previewImport(actor(`virtual-denied-${mode}`), importInput([{ xutiStyleNo: "TIME-1", createdAt: editedTime }]))).rejects.toMatchObject({ status: mode === "locked" ? 409 : 403 });
    expect((await read("SELECT created_at,version FROM style_selections WHERE id=$1", [row.id]))[0]).toMatchObject({ createdAt: originalTime, version: 1 });
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

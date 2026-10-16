import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { defaultVipTagPriceLimitConfig } from "../../packages/contracts/src/selection-vip-tag-price-limit.js";
import type { Context } from "../../apps/api/src/core.js";
import type { Row, Tx } from "../../packages/database/src/index.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";
import { selectionBaseFields } from "../../packages/contracts/src/selection-migration.js";
import { projectSelectionSharedLayout, selectionLayoutSchema, type SelectionField } from "../../packages/contracts/src/selection-layout.js";
import { archiveFieldIds } from "../../packages/contracts/src/product-archive.js";

const fixture = vi.hoisted(() => ({ database: null as PGlite | null, mirrors: [] as Row[] }));
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
  return { ...original, db: { $queryRawUnsafe: (sql: string, ...parameters: unknown[]) => transaction(tx => tx.$queryRawUnsafe(sql, ...parameters)), $transaction: transaction } };
});
// Project approval and product mirroring are separate modules; all migration,
// field registration, permissions, token checks and row persistence use SQL.
vi.mock("../../apps/api/src/modules/projects/library.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../apps/api/src/modules/projects/library.js")>();
  return { ...original, tableAccess: async (_tx: Tx, _actor: unknown, key: string) => ({ id: key, name: key === "23" ? "商品档案" : "目标表", system_key: key === "23" ? "PRODUCT_ARCHIVE" : null, can_edit: true, can_manage: true }) };
});
vi.mock("../../apps/api/src/modules/style-selections/archive.js", () => ({
  isArchive: async () => selectionScope.getStore() === "23",
  mirrorArchiveRow: async (_tx: Tx, _c: Context, row: Row) => { fixture.mirrors.push(row); },
}));

import { preview, commit, targets } from "../../apps/api/src/modules/style-selections/migration.js";

const sourceColor: SelectionField = { key: "custom:source-standard", label: "标准颜色", type: "text", custom: true, width: 100 };
const targetColor: SelectionField = { key: "custom:target-standard", label: "标准颜色", type: "text", custom: true, width: 100 };
const photo = { id: "image-1", url: "https://example.com/white.jpg", color: "白色", colorFieldKey: sourceColor.key };
const actor = (key = "transfer"): Context => ({ actor: { id: "7", username: "editor", displayName: "Editor", permissions: ["selection.read", "selection.manage", "product.read", "product.update", "product.create", "project.read"], roleCodes: [] }, requestId: key, key });
const read = async (sql: string, parameters: unknown[] = []) => (await fixture.database!.query<Row>(sql, parameters)).rows;
async function register(scope: string, field: SelectionField, owner = "7", visibility = "PUBLIC") {
  await fixture.database!.query("INSERT INTO selection_field_registry(workspace_key,table_id,field_key,owner_id,visibility,definition) VALUES($1,$2,$3,$4,$5,$6)", [scope, scope === "default" ? null : scope, field.key, owner, visibility, JSON.stringify(field)]);
}
async function layout(scope: string, extra: SelectionField[], hidden: string[] = []) {
  const preferences = selectionLayoutSchema.parse({ columns: [...selectionBaseFields, ...extra], hiddenColumns: hidden });
  await fixture.database!.query("INSERT INTO selection_layout_preferences(user_id,workspace_key,table_id,preferences) VALUES(7,$1,$2,$3) ON CONFLICT(user_id,workspace_key) DO UPDATE SET preferences=EXCLUDED.preferences,revision=selection_layout_preferences.revision+1", [scope, scope === "default" ? null : scope, JSON.stringify(preferences)]);
}
const body = (target = "24", mapping = targetColor.key, includeBasis = true) => ({ target, rowIds: ["1"], fields: [selectionBaseFields.find(field => field.key === "xutiStyleNo")!, selectionBaseFields.find(field => field.key === "images")!, sourceColor], copyMissingFields: false, ignoredSources: [], mappings: [
  { source: "xutiStyleNo", target: "xutiStyleNo" }, { source: "images", target: "images" }, ...(includeBasis ? [{ source: sourceColor.key, target: mapping }] : []),
] });
const noWrites = async () => {
  expect(await read("SELECT * FROM selection_table_24.style_selections")).toHaveLength(0);
  expect((await read("SELECT migration_locked FROM style_selections"))[0].migration_locked).toBe(false);
  expect(await read("SELECT * FROM audit_logs")).toHaveLength(0);
};

beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(`
    CREATE TABLE users(id bigint PRIMARY KEY,display_name text,username text); INSERT INTO users VALUES(7,'Editor','editor'),(8,'Other','other');
    CREATE TABLE project_tables(id bigint PRIMARY KEY,initial_layout text,system_key text); INSERT INTO project_tables VALUES(23,'empty','PRODUCT_ARCHIVE'),(24,'selection',NULL);
    CREATE TABLE products(id bigint PRIMARY KEY,created_at timestamptz DEFAULT now());
    CREATE TABLE product_fields(id text,name text,type text,options jsonb DEFAULT '[]',active boolean DEFAULT true,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE style_selection_protection(id integer PRIMARY KEY,settings jsonb,revision integer DEFAULT 1);
    CREATE TABLE style_selections(
      id bigserial PRIMARY KEY,registration_batch date,images jsonb DEFAULT '[]',label_images jsonb DEFAULT '[]',
      cell_colors jsonb DEFAULT '{}',cell_alignments jsonb DEFAULT '{}',cell_vertical_alignments jsonb DEFAULT '{}',cell_text_colors jsonb DEFAULT '{}',cell_number_formats jsonb DEFAULT '{}',extra_fields jsonb DEFAULT '{}',
      xuti_style_no text,supplier_style_no text,supplier_code text,color text,size_range text,material text,
      supply_price_excl_tax numeric,vip_price numeric,live_price numeric,tag_price numeric,selling_points text,reorder_days integer,collection_inventory jsonb DEFAULT '[]',
      sort_order integer DEFAULT 0,row_color text DEFAULT 'NONE',created_by bigint DEFAULT 7,updated_by bigint DEFAULT 7,version integer DEFAULT 1,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),cell_owners jsonb DEFAULT '{}',claimed_by bigint,
      migration_locked boolean DEFAULT false,migration_target_workspace text,migration_target_row_id bigint,migrated_at timestamptz,product_id bigint
    );
    CREATE TABLE selection_field_registry(workspace_key text,table_id bigint,field_key text,owner_id bigint,visibility text,definition jsonb,revision integer DEFAULT 1,updated_at timestamptz DEFAULT now(),PRIMARY KEY(workspace_key,field_key));
    CREATE TABLE selection_layout_preferences(user_id bigint,workspace_key text,table_id bigint,preferences jsonb,revision integer DEFAULT 1,updated_at timestamptz DEFAULT now(),PRIMARY KEY(user_id,workspace_key));
    CREATE TABLE selection_shared_layouts(workspace_key text PRIMARY KEY,preferences jsonb,revision integer DEFAULT 1);
    CREATE TABLE selection_shared_fields(workspace_key text PRIMARY KEY,table_id bigint,fields jsonb,revision integer DEFAULT 1,updated_by bigint,updated_at timestamptz DEFAULT now());
    CREATE TABLE idempotency_records(id bigserial,actor_id bigint,operation text,idempotency_key text,request_hash text,response_status integer,response_body jsonb);
    CREATE TABLE audit_logs(id bigserial,actor_id bigint,actor_label text,action text,entity_type text,entity_id text,request_id text,before_data jsonb,after_data jsonb,reason text,selection_table_id bigint);
    CREATE SCHEMA selection_table_23; CREATE TABLE selection_table_23.style_selections(LIKE public.style_selections INCLUDING ALL); CREATE TABLE selection_table_23.style_selection_protection(LIKE public.style_selection_protection INCLUDING ALL);
    CREATE SCHEMA selection_table_24; CREATE TABLE selection_table_24.style_selections(LIKE public.style_selections INCLUDING ALL); CREATE TABLE selection_table_24.style_selection_protection(LIKE public.style_selection_protection INCLUDING ALL);
  `);
}, 30000);
beforeEach(async () => {
  fixture.mirrors = []; process.env.APP_ORIGIN = "https://app.example.com";
  await fixture.database!.exec("TRUNCATE style_selections,selection_field_registry,selection_layout_preferences,selection_shared_layouts,selection_shared_fields,idempotency_records,audit_logs,product_fields,style_selection_protection,selection_table_23.style_selections,selection_table_23.style_selection_protection,selection_table_24.style_selections,selection_table_24.style_selection_protection RESTART IDENTITY");
  for (const scope of ["public", "selection_table_23", "selection_table_24"]) await fixture.database!.query(`INSERT INTO ${scope}.style_selection_protection VALUES(1,$1,1)`, [JSON.stringify(defaultProtection)]);
  await register("default", sourceColor); await register("24", targetColor);
  await layout("default", [sourceColor]); await layout("24", [targetColor]);
  await fixture.database!.query("INSERT INTO style_selections(xuti_style_no,color,extra_fields,images) VALUES('TRANSFER-STANDARD','厂家黑',$1,$2)", [JSON.stringify({ [sourceColor.key]: "白色/灰色" }), JSON.stringify([photo])]);
});
afterAll(async () => { await fixture.database?.close(); });

describe("cross-table linked image colors", () => {
  it("does not reintroduce private source keys from dormant configs in a saved shared target layout", async () => {
    const secret: SelectionField = { key: "custom:secret-category", label: "三级类目", custom: true, width: 100, type: "text" };
    const dormant: SelectionField = { key: "custom:dormant-limit", label: "普通价格", custom: true, width: 100, type: "text", vipTagPriceLimitConfig: defaultVipTagPriceLimitConfig(secret.key) };
    await register("default", secret, "8", "PRIVATE"); await register("default", dormant);
    await fixture.database!.query("INSERT INTO selection_shared_layouts(workspace_key,preferences) VALUES('default',$1)", [JSON.stringify(projectSelectionSharedLayout(selectionLayoutSchema.parse({ columns: [dormant] })))]);
    const context = actor(); context.actor.permissions = ["selection.read", "selection.manage", "product.update"];
    const available = await selectionScope.run("23", () => targets(context));
    const fields = available.find(target => target.key === "default")!.fields;
    expect(fields.find((field: SelectionField) => field.key === dormant.key)).toMatchObject({ type: "text" });
    expect(fields.find((field: SelectionField) => field.key === dormant.key).vipTagPriceLimitConfig).toBeUndefined();
    expect(JSON.stringify(available)).not.toContain(secret.key);
  });
  it("excludes computed price-limit sources and rejects a computed target before writing", async () => {
    const computed: SelectionField = { key: "custom:price-limit", label: "吊牌限价", custom: true, width: 100, type: "vipTagPriceLimit", vipTagPriceLimitConfig: defaultVipTagPriceLimitConfig("material") };
    await register("default", computed); await register("24", computed);
    await layout("default", [sourceColor, computed]); await layout("24", [targetColor, computed]);
    await fixture.database!.query("UPDATE style_selections SET extra_fields=extra_fields || $1", [JSON.stringify({ [computed.key]: "legacy-limit" })]);
    const input = body(); input.fields.push(computed);
    const plan = await preview(actor(), input);
    expect(JSON.stringify(plan)).not.toContain("legacy-limit");
    input.mappings[0].target = computed.key;
    await expect(preview(actor(), input)).rejects.toMatchObject({ status: 400, response: { error: { message: "字段对应关系已失效，请重新配置" } } });
    await noWrites();
  });
  it("remaps a different target field key through actual preview and commit", async () => {
    const input = body(), plan = await preview(actor(), input);
    expect(plan).toMatchObject({ created: 1, updated: 0 });
    await commit(actor(), { ...input, token: plan.token });
    expect((await read("SELECT images,extra_fields,color FROM selection_table_24.style_selections"))[0]).toEqual({ images: [{ ...photo, colorFieldKey: targetColor.key }], extra_fields: { [targetColor.key]: "白色/灰色" }, color: null });
    expect((await read("SELECT migration_locked,migration_target_workspace FROM style_selections"))[0]).toEqual({ migration_locked: true, migration_target_workspace: "24" });
  });
  it("remaps a source custom basis to the canonical archive standard color", async () => {
    const key = "custom:product:" + archiveFieldIds.standardColor;
    await fixture.database!.query("INSERT INTO product_fields(id,name,type) VALUES($1,'标准颜色','text')", [archiveFieldIds.standardColor]);
    await layout("23", [{ ...targetColor, key }]);
    const input = body("23", key), plan = await preview(actor(), input);
    await commit(actor(), { ...input, token: plan.token });
    expect((await read("SELECT images,extra_fields FROM selection_table_23.style_selections"))[0]).toEqual({ images: [{ ...photo, colorFieldKey: key }], extra_fields: { [key]: "白色/灰色" } });
    expect(fixture.mirrors).toHaveLength(1);
  });
  it("removes linkage and color when mapping product images into label images", async () => {
    const input = body("24", targetColor.key, false); input.mappings[1].target = "labelImages";
    const plan = await preview(actor(), input); await commit(actor(), { ...input, token: plan.token });
    expect((await read("SELECT images,label_images FROM selection_table_24.style_selections"))[0]).toEqual({ images: [], label_images: [{ id: photo.id, url: photo.url, color: "" }] });
  });
  it("keeps a plain color label but removes cross-workspace linkage for custom images", async () => {
    const imageField: SelectionField = { key: "custom:target-photos", label: "副图", type: "image", custom: true, width: 100 };
    await register("24", imageField); await layout("24", [targetColor, imageField]);
    const input = body("24", targetColor.key, false); input.mappings[1].target = imageField.key;
    const plan = await preview(actor(), input); await commit(actor(), { ...input, token: plan.token });
    const row = (await read("SELECT images,extra_fields FROM selection_table_24.style_selections"))[0];
    expect(row.images).toEqual([]);
    expect(JSON.parse(row.extra_fields[imageField.key])).toEqual([{ id: photo.id, url: photo.url, color: "白色" }]);
    expect(JSON.stringify(row)).not.toContain(sourceColor.key);
  });
  it("rejects omitted basis mappings even if a target field happens to share its key", async () => {
    await register("24", sourceColor); await layout("24", [sourceColor]);
    await expect(preview(actor(), body("24", targetColor.key, false))).rejects.toMatchObject({ status: 400, response: { error: { message: expect.stringContaining("同时配置标准颜色") } } });
    await noWrites();
  });
  it("fails at preview for a target mapping that is not a standard color field", async () => {
    await fixture.database!.query("UPDATE selection_field_registry SET definition=jsonb_set(definition,'{label}','\"无关字段\"') WHERE workspace_key='24'");
    await expect(preview(actor(), body())).rejects.toMatchObject({ status: 400, response: { error: { message: expect.stringContaining("标准颜色字段") } } });
    await noWrites();
  });
  it("rejects a hidden target basis before transfer", async () => {
    await layout("24", [targetColor], [targetColor.key]);
    await expect(preview(actor(), body())).rejects.toMatchObject({ status: 403, response: { error: { message: expect.stringContaining("目标图片关联的标准颜色字段不可访问") } } });
    await noWrites();
  });
  it("rechecks target basis permissions at commit and rolls back all writes", async () => {
    const input = body(), plan = await preview(actor(), input);
    await fixture.database!.query("UPDATE selection_field_registry SET visibility='PRIVATE',owner_id=8,revision=revision+1 WHERE workspace_key='24'");
    let failure: any; try { await commit(actor(), { ...input, token: plan.token }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: 400, response: { error: { message: "字段对应关系已失效，请重新配置" } } });
    expect(JSON.stringify(failure.response)).not.toContain(targetColor.key);
    expect(JSON.stringify(failure.response)).not.toContain("白色");
    await noWrites();
    expect(await read("SELECT * FROM idempotency_records")).toHaveLength(0);
  });
  it.each(["hidden", "private"])("rejects an inaccessible source basis without leaking its key or colors (%s)", async mode => {
    if (mode === "hidden") await layout("default", [sourceColor], [sourceColor.key]);
    else await fixture.database!.query("UPDATE selection_field_registry SET visibility='PRIVATE',owner_id=8 WHERE workspace_key='default'");
    let failure: any; try { await preview(actor(), body()); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: 403 });
    const message = JSON.stringify(failure.response); expect(message).not.toContain(sourceColor.key); expect(message).not.toContain("白色");
    await noWrites();
  });
  it("rejects a retained image incompatibility during preview when only its basis is updated", async () => {
    await fixture.database!.query("INSERT INTO selection_table_24.style_selections(xuti_style_no,extra_fields,images) VALUES('TRANSFER-STANDARD',$1,$2)", [JSON.stringify({ [targetColor.key]: "黑色" }), JSON.stringify([{ ...photo, color: "黑色", colorFieldKey: targetColor.key }])]);
    const input = body(); input.mappings = input.mappings.filter(mapping => mapping.source !== "images");
    await expect(preview(actor(), input)).rejects.toMatchObject({ status: 400, response: { error: { message: expect.stringContaining("对应的标准颜色字段") } } });
    expect((await read("SELECT images,extra_fields FROM selection_table_24.style_selections"))[0]).toMatchObject({ images: [{ color: "黑色" }], extra_fields: { [targetColor.key]: "黑色" } });
    expect((await read("SELECT migration_locked FROM style_selections"))[0].migration_locked).toBe(false);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import Excel from "exceljs";
import type { Context } from "../../apps/api/src/core.js";
import type { Row, Tx } from "../../packages/database/src/index.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";
import { selectionBaseFields } from "../../packages/contracts/src/selection-migration.js";
import { selectionLayoutSchema, type SelectionField } from "../../packages/contracts/src/selection-layout.js";
import { archiveFieldIds } from "../../packages/contracts/src/product-archive.js";
import { selectionImportLimits } from "../../packages/contracts/src/selection-import-template.js";
import { defaultVipTagPriceLimitConfig } from "../../packages/contracts/src/selection-vip-tag-price-limit.js";

const fixture = vi.hoisted(() => ({ database: null as PGlite | null, archive: false, registryBigInt: false, mirrors: [] as Row[] }));
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  const driverRows = (sql: string, values: Row[]) => fixture.registryBigInt && /selection_field_registry/.test(sql)
    ? values.map(value => Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      ["table_id", "owner_id"].includes(key) && item !== null ? BigInt(item as number) : item,
    ]))) : values;
  const wrap = (database: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) => driverRows(sql, (await database.query<Row>(sql, parameters)).rows),
    $executeRawUnsafe: async (sql: string, ...parameters: unknown[]) => (await database.query(sql, parameters)).affectedRows || 0,
  }) as unknown as Tx;
  const database = {
    $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) => driverRows(sql, (await fixture.database!.query<Row>(sql, parameters)).rows),
    $transaction: async (work: (tx: Tx) => Promise<unknown>) => fixture.database!.transaction(async transaction => {
      if (selectionScope.getStore()) await transaction.query(`SET LOCAL search_path TO "selection_table_${selectionScope.getStore()}", public`);
      return work(wrap(transaction));
    }),
  };
  return { ...original, db: database };
});
vi.mock("../../apps/api/src/modules/style-selections/archive.js", () => ({
  isArchive: async () => fixture.archive,
  mirrorArchiveRow: async (_tx: Tx, _c: Context, row: Row) => { fixture.mirrors.push(row); },
}));

import { previewImport, commitImport, write, changePhoto } from "../../apps/api/src/modules/style-selections/service.js";
import { detail as selectionDetail } from "../../apps/api/src/modules/style-selections/protection.js";
import { create as createCollection, detail as collectionDetail, publicDetail as publicCollectionDetail, save as saveCollection, submit as submitCollection, review as reviewCollection } from "../../apps/api/src/modules/style-selections/collections.js";
import { collectionInventory } from "../../packages/contracts/src/selection-collection.js";
import { parseSelectionWorkbook } from "../../apps/web/src/selection-workbook.js";

const actor = (key = "import"): Context => ({ actor: { id: "7", username: "editor", displayName: "Editor", permissions: ["selection.read", "selection.manage", "product.read", "product.update", "product.create"], roleCodes: [] }, requestId: "import-test", key });
const input = (rows: Row[], existingStrategy: "OVERWRITE" | "SKIP" = "OVERWRITE") => ({ rows, existingStrategy });
const payload = (plan: Awaited<ReturnType<typeof previewImport>>) => ({ rows: plan.rows, fields: plan.fields, fieldRevision: plan.fieldRevision, layoutRevision: plan.layoutRevision, existingStrategy: plan.existingStrategy });
const read = async (sql: string, parameters: unknown[] = []) => (await fixture.database!.query<Row>(sql, parameters)).rows;
const field = (label: string, type: SelectionField["type"] = "text", options?: string[]): SelectionField => ({ key: "custom:" + label.charCodeAt(0), label, custom: true, width: 100, type, ...(options ? { options } : {}) });
async function register(definition: SelectionField, owner = "7", visibility = "PRIVATE") {
  await fixture.database!.query(`INSERT INTO selection_field_registry(workspace_key,field_key,owner_id,visibility,definition) VALUES('default',$1,$2,$3,$4)`, [definition.key, owner, visibility, JSON.stringify(definition)]);
}
async function style(no = "EXIST", data: Row = {}) {
  const saved = (await read("INSERT INTO style_selections(xuti_style_no,material,supplier_code,extra_fields,claimed_by,images,color) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [no, data.material || "原成分", data.supplierCode || "原编码", JSON.stringify(data.extraFields || {}), data.claimedBy || null, JSON.stringify(data.images || []), data.color || null]))[0];
  return saved;
}
async function settings(value: Row) { await fixture.database!.query("UPDATE style_selection_protection SET settings=$1,revision=revision+1", [JSON.stringify({ ...defaultProtection, ...value })]); }
async function parsedLegacyImageWorkbook(mainHeaders: string[], mainValues: unknown[], imageColor = "粉色") {
  const book = new Excel.Workbook(), main = book.addWorksheet("选款资料"), pictures = book.addWorksheet("图片明细");
  main.addRow(mainHeaders); main.addRow(mainValues);
  pictures.addRow(["序缇款号", "颜色", "图片URL"]);
  pictures.getRow(778).values = ["H49X2060", imageColor, "https://example.test/pink.jpg"];
  return parseSelectionWorkbook(await book.xlsx.writeBuffer() as unknown as ArrayBuffer);
}
async function registerArchiveStandardTags() {
  const standard = { ...field("标准颜色", "tags"), key: "custom:transferred-standard" };
  await fixture.database!.query(`INSERT INTO selection_field_registry(workspace_key,table_id,field_key,owner_id,visibility,definition)
    VALUES('23',23,$1,7,'PUBLIC',$2)`, [standard.key, JSON.stringify(standard)]);
  fixture.archive = true;
  return standard;
}
const conflict = { status: 409, response: { error: { code: "EDIT_CONFLICT" } } };
const forbidden = { status: 403, response: { error: { code: "REGION_FORBIDDEN" } } };

beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(`
    CREATE TABLE users(id bigint PRIMARY KEY,display_name text,username text,status text DEFAULT 'ACTIVE');
    INSERT INTO users VALUES(7,'Editor','editor'),(8,'Other','other');
    CREATE TABLE roles(id bigint PRIMARY KEY,code text);
    CREATE TABLE permissions(id bigint PRIMARY KEY,code text);
    CREATE TABLE user_roles(user_id bigint,role_id bigint);
    CREATE TABLE role_permissions(role_id bigint,permission_id bigint);
    INSERT INTO roles VALUES(1,'EDITOR'); INSERT INTO permissions VALUES(1,'selection.read'),(2,'selection.manage');
    INSERT INTO user_roles VALUES(7,1),(8,1); INSERT INTO role_permissions VALUES(1,1),(1,2);
    CREATE TABLE project_tables(id bigint PRIMARY KEY,initial_layout text,system_key text);
    INSERT INTO project_tables VALUES(23,'empty','PRODUCT_ARCHIVE');
    CREATE TABLE products(id bigint PRIMARY KEY,style_no text,custom_fields jsonb DEFAULT '{}',tag_price numeric,main_image_url text,updated_at timestamptz DEFAULT now(),created_at timestamptz DEFAULT now());
    CREATE TABLE product_fields(id text,name text,type text,options jsonb DEFAULT '[]',active boolean DEFAULT true,created_at timestamptz DEFAULT now());
    CREATE TABLE style_selection_protection(id integer PRIMARY KEY,settings jsonb,revision integer DEFAULT 1);
    CREATE TABLE style_selections(
      id bigserial PRIMARY KEY,registration_batch date,images jsonb DEFAULT '[]',label_images jsonb DEFAULT '[]',
      cell_colors jsonb DEFAULT '{}',cell_alignments jsonb DEFAULT '{}',cell_vertical_alignments jsonb DEFAULT '{}',cell_text_colors jsonb DEFAULT '{}',cell_number_formats jsonb DEFAULT '{}',extra_fields jsonb DEFAULT '{}',
      xuti_style_no text,supplier_style_no text,supplier_code text,color text,size_range text,material text,
      supply_price_excl_tax numeric,vip_price numeric,live_price numeric,tag_price numeric,selling_points text,reorder_days integer,collection_inventory jsonb DEFAULT '[]',
      sort_order integer DEFAULT 0,row_color text DEFAULT 'NONE',created_by bigint DEFAULT 7,updated_by bigint DEFAULT 7,version integer DEFAULT 1,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),cell_owners jsonb DEFAULT '{}',claimed_by bigint,
      migration_locked boolean DEFAULT false,migration_target_workspace text,migration_target_row_id bigint,migrated_at timestamptz,product_id bigint
    );
    CREATE TABLE selection_field_registry(workspace_key text,table_id bigint,field_key text,owner_id bigint,visibility text,definition jsonb,revision integer DEFAULT 1,updated_at timestamptz DEFAULT now(),PRIMARY KEY(workspace_key,field_key));
    CREATE TABLE selection_layout_preferences(user_id bigint,workspace_key text,table_id bigint,preferences jsonb,revision integer DEFAULT 1,updated_at timestamptz DEFAULT now(),PRIMARY KEY(user_id,workspace_key));
    CREATE TABLE selection_shared_layouts(workspace_key text PRIMARY KEY,preferences jsonb,revision integer DEFAULT 1);
    CREATE TABLE selection_shared_fields(workspace_key text PRIMARY KEY,fields jsonb,revision integer DEFAULT 1);
    CREATE TABLE idempotency_records(id bigserial,actor_id bigint,operation text,idempotency_key text,request_hash text,response_status integer,response_body jsonb);
    CREATE TABLE audit_logs(id bigserial,actor_id bigint,actor_label text,action text,entity_type text,entity_id text,request_id text,before_data jsonb,after_data jsonb,reason text,selection_table_id bigint);
    CREATE TABLE selection_collections(id bigserial PRIMARY KEY,title text,token_hash text,created_by bigint,expires_at timestamptz,closed boolean DEFAULT false,status text DEFAULT 'DRAFT',revision integer DEFAULT 1,feedback text DEFAULT '',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE selection_collection_items(collection_id bigint,selection_id bigint,position integer,source_version integer,xuti_style_no text,original jsonb,draft jsonb,status text DEFAULT 'DRAFT',feedback text DEFAULT '');
    CREATE TABLE selection_collection_events(collection_id bigint,actor_id bigint,action text);
    CREATE TABLE selection_collection_requests(collection_id bigint,request_key text,fingerprint text,result jsonb);
    CREATE SCHEMA selection_table_23;
    CREATE TABLE selection_table_23.style_selections(LIKE public.style_selections INCLUDING ALL);
    CREATE TABLE selection_table_23.style_selection_protection(LIKE public.style_selection_protection INCLUDING ALL);
    CREATE FUNCTION public.sync_product_archive_record(p products,table_id bigint,actor_id bigint) RETURNS text LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO selection_table_23.style_selections(xuti_style_no,product_id,material,color,extra_fields,created_by) VALUES(p.style_no,p.id,coalesce(p.custom_fields->>'f0000000000000000000000000000000e','产品原成分'),p.custom_fields->>'f00000000000000000000000000000003',(SELECT coalesce(jsonb_object_agg('custom:product:'||key,value),'{}') FROM jsonb_each(p.custom_fields)),actor_id); RETURN 'ok'; END $$;
  `);
}, 30000);
beforeEach(async () => {
  fixture.archive = false; fixture.registryBigInt = false; fixture.mirrors = [];
  await fixture.database!.exec(`TRUNCATE style_selections,selection_field_registry,selection_layout_preferences,selection_shared_layouts,selection_shared_fields,idempotency_records,audit_logs,products,product_fields,style_selection_protection,selection_table_23.style_selections,selection_table_23.style_selection_protection,selection_collections,selection_collection_items,selection_collection_events,selection_collection_requests RESTART IDENTITY`);
  await fixture.database!.query("INSERT INTO style_selection_protection(id,settings) VALUES(1,$1)", [JSON.stringify(defaultProtection)]);
  await fixture.database!.query("INSERT INTO selection_table_23.style_selection_protection(id,settings) VALUES(1,$1)", [JSON.stringify(defaultProtection)]);
});
afterAll(async () => { await fixture.database?.close(); });

describe("atomic Excel style import", () => {
  it("rejects importing or directly forging computed price limits without modifying stored legacy values", async () => {
    const category = field("三级类目", "single", ["半截裙", "连衣裙"]);
    const computed = { ...field("吊牌限价", "vipTagPriceLimit"), vipTagPriceLimitConfig: defaultVipTagPriceLimitConfig(category.key) };
    await register(category, "7", "PUBLIC"); await register(computed, "7", "PUBLIC");
    const before = await style("COMPUTED-LIMIT", { extraFields: { [category.key]: "半截裙", [computed.key]: "原人工值" } });
    await expect(previewImport(actor(), input([{ xutiStyleNo: "COMPUTED-LIMIT", fieldValues: { 吊牌限价: "899" } }]))).rejects.toMatchObject({ status: 400, response: { error: { message: expect.stringContaining("由系统生成") } } });
    await expect(write(actor("forge-limit"), { extraFields: { [computed.key]: "899" } }, String(before.id))).rejects.toMatchObject({ status: 400, response: { error: { message: expect.stringContaining("不能直接填写") } } });
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [before.id]))[0].extra_fields).toEqual(before.extra_fields);
    expect(await read("SELECT * FROM audit_logs")).toEqual([]);
    await write(actor("preserve-limit"), { material: "正常更新", extraFields: before.extra_fields }, String(before.id));
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [before.id]))[0].extra_fields).toEqual(before.extra_fields);
  });
  it.each(["", "供应商自定义粉"])("previews parsed legacy 颜色 detail against supplied archive standard 粉色 when supplier color is %j", async supplierColor => {
    const standard = await registerArchiveStandardTags();
    const parsed = await parsedLegacyImageWorkbook(["序缇款号", "标准颜色", "供应商颜色"], ["H49X2060", "粉色", supplierColor]);
    expect(parsed[0]).toMatchObject({ xutiStyleNo: "H49X2060", fieldValues: { 标准颜色: "粉色" }, images: [{ color: "粉色", colorFieldKey: "standard" }] });
    if (supplierColor) expect(parsed[0].color).toBe(supplierColor);
    else expect(parsed[0]).not.toHaveProperty("color");
    await selectionScope.run("23", async () => {
      const plan = await previewImport(actor(), input(parsed));
      expect(plan).toMatchObject({ created: 1, updated: 0 });
      expect(plan.fields.find(binding => binding.header === "标准颜色")).toMatchObject({ key: standard.key, type: "tags", isNew: false });
      expect(plan.fields.every(binding => !binding.isNew)).toBe(true);
      expect(plan.rows[0].values).toEqual(parsed[0]);
    });
    expect(await read("SELECT * FROM selection_table_23.style_selections")).toEqual([]);
    expect(await read("SELECT field_key FROM selection_field_registry")).toEqual([{ field_key: standard.key }]);
  });
  it("rejects parsed legacy 颜色 detail matching only supplier 粉色 when archive standard color is 白色", async () => {
    await registerArchiveStandardTags();
    const parsed = await parsedLegacyImageWorkbook(["序缇款号", "标准颜色", "供应商颜色"], ["H49X2060", "白色", "粉色"]);
    await selectionScope.run("23", async () => {
      await expect(previewImport(actor(), input(parsed))).rejects.toMatchObject({ status: 400, response: { error: {
        message: expect.stringContaining("本次导入的标准颜色「白色」"), details: {
          kind: "SELECTION_IMPORT_IMAGE_COLOR", rowIndex: 0, xutiStyleNo: "H49X2060", imageIndex: 0,
          imageSource: "import", colorSource: "import", colorFieldLabel: "标准颜色", imageColor: "粉色", allowedColors: ["白色"],
        },
      } } });
    });
    expect(await read("SELECT * FROM selection_table_23.style_selections")).toEqual([]);
  });
  it("previews parsed image-only legacy 颜色 detail using retained archive standard 粉色 with an empty supplier color", async () => {
    const standard = await registerArchiveStandardTags();
    const before = (await read(`INSERT INTO selection_table_23.style_selections(xuti_style_no,color,extra_fields)
      VALUES('H49X2060',NULL,$1) RETURNING *`, [JSON.stringify({ [standard.key]: "粉色" })]))[0];
    const parsed = await parsedLegacyImageWorkbook(["序缇款号"], ["H49X2060"]);
    expect(parsed[0]).not.toHaveProperty("fieldValues");
    expect(parsed[0]).not.toHaveProperty("color");
    await selectionScope.run("23", async () => {
      const plan = await previewImport(actor(), input(parsed));
      expect(plan).toMatchObject({ created: 0, updated: 1 });
      expect(plan.fields.find(binding => binding.header === "标准颜色")).toMatchObject({ key: standard.key, type: "tags", isNew: false });
      expect(plan.rows[0]).toMatchObject({ id: String(before.id), operation: "UPDATE", values: { images: [{ color: "粉色", colorFieldKey: "standard" }] } });
    });
    expect((await read("SELECT * FROM selection_table_23.style_selections"))[0]).toEqual(before);
    expect(await read("SELECT field_key FROM selection_field_registry")).toEqual([{ field_key: standard.key }]);
  });
  it("resolves standard-color links while leaving supplier colors intact, including ordinary edits and photo append", async () => {
    const standard = field("标准颜色", "multiple", ["白色", "灰色"]);
    await register(standard);
    const before = await style("STANDARD", { color: "供应商黑", extraFields: { [standard.key]: "旧标准色" } });
    const source = input([{ xutiStyleNo: "STANDARD", fieldValues: { 标准颜色: "白色/灰色" }, images: [
      { id: "standard", color: "白色", colorFieldKey: "standard", url: "https://example.com/standard.jpg" },
      { id: "legacy", color: "供应商黑", url: "https://example.com/legacy.jpg" },
    ] }]);
    const plan = await previewImport(actor(), source);
    expect(source.rows[0].images[0].colorFieldKey).toBe("standard");
    expect(plan.rows[0].values.images[0].colorFieldKey).toBe("standard");
    expect(await commitImport(actor(), payload(plan))).toMatchObject({ updated: 1, fieldsCreated: 0 });
    const saved = (await read("SELECT * FROM style_selections"))[0];
    expect(saved.color).toBe("供应商黑");
    expect(saved.extra_fields[standard.key]).toBe("白色/灰色");
    expect(saved.images[0].colorFieldKey).toBe(standard.key);
    await write(actor("edit-standard-image"), { images: saved.images.map((image: Row) => image.id === "standard" ? { ...image, color: "灰色" } : image) }, String(before.id));
    await changePhoto(actor("append-standard-image"), String(before.id), { action: "add", image: { id: "standard2", color: "白色", colorFieldKey: standard.key, url: "https://example.com/standard2.jpg" } });
    await changePhoto(actor("append-legacy-image"), String(before.id), { action: "add", image: { id: "legacy2", color: "供应商黑", url: "https://example.com/legacy2.jpg" } });
    expect((await read("SELECT images,color FROM style_selections"))[0]).toMatchObject({ color: "供应商黑", images: [
      { id: "standard", color: "灰色", colorFieldKey: standard.key }, { id: "legacy", color: "供应商黑" },
      { id: "standard2", color: "白色", colorFieldKey: standard.key }, { id: "legacy2", color: "供应商黑" },
    ] });
  });
  it("uses retained standard colors for image-only updates and skips blank supplied standard values", async () => {
    const standard = field("标准颜色"); await register(standard);
    await style("STANDARD-ONLY", { color: "供应商黑", extraFields: { [standard.key]: " 白色 / 灰色 " } });
    const plan = await previewImport(actor(), input([{ xutiStyleNo: "STANDARD-ONLY", fieldValues: { 标准颜色: " " }, images: [
      { id: "gray", color: "灰色", colorFieldKey: "standard", url: "https://example.com/gray.jpg" },
    ] }]));
    await commitImport(actor(), payload(plan));
    expect((await read("SELECT color,extra_fields,images FROM style_selections"))[0]).toEqual({ color: "供应商黑", extra_fields: { [standard.key]: " 白色 / 灰色 " }, images: [{ id: "gray", color: "灰色", colorFieldKey: standard.key, url: "https://example.com/gray.jpg" }] });
    const supplierOnly = await previewImport(actor("supplier-only"), input([{ xutiStyleNo: "STANDARD-ONLY", color: "新供应商色" }]));
    await commitImport(actor("supplier-only"), payload(supplierOnly));
    expect((await read("SELECT color,images FROM style_selections"))[0]).toMatchObject({ color: "新供应商色", images: [{ color: "灰色", colorFieldKey: standard.key }] });
  });
  it("reports imported or retained standard-image mismatches against the exact standard field", async () => {
    const standard = field("标准颜色"); await register(standard);
    await style("STANDARD-ERROR", { color: "供应商黑", extraFields: { [standard.key]: "白色" }, images: [{ id: "white", color: "白色", colorFieldKey: standard.key, url: "https://example.com/white.jpg" }] });
    await expect(previewImport(actor(), input([{ xutiStyleNo: "STANDARD-ERROR", images: [{ id: "wrong", color: "供应商黑", colorFieldKey: "standard", url: "https://example.com/wrong.jpg" }] }]))).rejects.toMatchObject({ status: 400, response: { error: {
      message: expect.stringContaining("系统标准颜色「白色」"), details: { kind: "SELECTION_IMPORT_IMAGE_COLOR", rowIndex: 0, xutiStyleNo: "STANDARD-ERROR", imageIndex: 0, imageSource: "import", colorSource: "existing", colorFieldLabel: "标准颜色", imageColor: "供应商黑", allowedColors: ["白色"] },
    } } });
    await expect(previewImport(actor("update-standard-only"), input([{ xutiStyleNo: "STANDARD-ERROR", fieldValues: { 标准颜色: "灰色" } }]))).rejects.toMatchObject({ status: 400, response: { error: { details: { imageSource: "existing", colorSource: "import", colorFieldLabel: "标准颜色", imageColor: "白色", allowedColors: ["灰色"] } } } });
    const saved = (await read("SELECT * FROM style_selections"))[0];
    await expect(write(actor("clear-standard-only"), { extraFields: { [standard.key]: "" } }, String(saved.id))).rejects.toMatchObject({ status: 400, response: { error: { message: "图片颜色必须来自关联的标准颜色字段" } } });
    expect(await read("SELECT * FROM audit_logs")).toEqual([]);
  });
  it.each(["ambiguous", "deleted", "unsupported"])("rejects %s standard field linkage without preview writes", async mode => {
    const standard = field("标准颜色", mode === "unsupported" ? "image" : "text");
    await register({ ...standard, ...(mode === "deleted" ? { deleted: true } : {}) });
    if (mode === "ambiguous") await register({ ...standard, key: "custom:second-standard" });
    await style("INVALID-STANDARD", { color: "厂家黑", extraFields: { [standard.key]: "白色" } });
    await expect(previewImport(actor(), input([{ xutiStyleNo: "INVALID-STANDARD", images: [{ id: "white", color: "白色", colorFieldKey: "standard", url: "https://example.com/white.jpg" }] }]))).rejects.toMatchObject({ status: mode === "deleted" ? 403 : 400 });
    expect((await read("SELECT images FROM style_selections"))[0].images).toEqual([]);
    expect(await read("SELECT * FROM audit_logs")).toEqual([]);
  });
  it("creates only the supplied standard field on valid new rows and retains complete slash choice labels", async () => {
    const plan = await previewImport(actor(), input([{ xutiStyleNo: "NEW-STANDARD", color: "厂家色", fieldValues: { 标准颜色: "白色/灰色" }, images: [{ id: "white", color: "白色", colorFieldKey: "standard", url: "https://example.com/white.jpg" }] }]));
    const binding = plan.fields.find(binding => binding.header === "标准颜色")!;
    expect(binding).toMatchObject({ isNew: true, type: "text" });
    expect(await read("SELECT * FROM selection_field_registry")).toEqual([]);
    await commitImport(actor(), payload(plan));
    expect((await read("SELECT color,extra_fields,images FROM style_selections"))[0]).toMatchObject({ color: "厂家色", extra_fields: { [binding.key]: "白色/灰色" }, images: [{ colorFieldKey: binding.key }] });
    const standard = { ...field("标准颜色", "multiple", ["米色/金色", "黑色"]), key: binding.key };
    await fixture.database!.query("UPDATE selection_field_registry SET definition=$1 WHERE field_key=$2", [JSON.stringify(standard), binding.key]);
    const choices = await previewImport(actor("slash-standard"), input([{ xutiStyleNo: "NEW-STANDARD", fieldValues: { 标准颜色: '["米色/金色","黑色"]' }, images: [{ id: "mixed", color: "米色/金色", colorFieldKey: "standard", url: "https://example.com/mixed.jpg" }] }]));
    await commitImport(actor("slash-standard"), payload(choices));
    expect((await read("SELECT images FROM style_selections"))[0].images[0]).toMatchObject({ color: "米色/金色", colorFieldKey: binding.key });
  });
  it("rejects inaccessible or arbitrary color-link fields before leaking their retained values", async () => {
    const standard = field("标准颜色"); await register(standard);
    await style("STANDARD-PRIVATE", { color: "供应商黑", extraFields: { [standard.key]: "秘密标准色" }, images: [{ id: "existing", color: "秘密标准色", colorFieldKey: standard.key, url: "https://example.com/existing.jpg" }] });
    await settings({ enabled: true, regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Standard denied", scope: "columns", rowIds: [], columnKeys: [standard.key], users: {}, others: "deny" }] });
    const image = { id: "guess", color: "猜测色", colorFieldKey: "standard", url: "https://example.com/guess.jpg" };
    await expect(previewImport(actor(), input([{ xutiStyleNo: "STANDARD-PRIVATE", images: [image] }]))).rejects.toMatchObject(forbidden);
    const before = (await read("SELECT * FROM style_selections"))[0];
    await write(actor("unrelated-private-basis"), { material: "普通修改" }, String(before.id));
    await expect(changePhoto(actor("guess-private-basis"), String(before.id), { action: "add", image: { ...image, colorFieldKey: standard.key } })).rejects.toMatchObject(forbidden);
    expect((await read("SELECT images FROM style_selections"))[0].images).toEqual(before.images);
    await settings({ enabled: false, regions: [] });
    const unrelated = field("其他字段"); await register(unrelated);
    await expect(previewImport(actor("arbitrary-link"), input([{ xutiStyleNo: "STANDARD-PRIVATE", images: [{ ...image, colorFieldKey: unrelated.key }] }]))).rejects.toMatchObject({ status: 400, response: { error: { message: expect.stringContaining("标准颜色字段") } } });
  });
  it("redacts unreadable retained standard-image details and preserves renamed existing field linkage", async () => {
    const standard = field("标准颜色"); await register(standard);
    const before = await style("STANDARD-RETAINED", { color: "厂家色", extraFields: { [standard.key]: "秘密标准色" }, images: [{ id: "old", color: "秘密标准色", colorFieldKey: standard.key, url: "https://example.com/secret.jpg" }] });
    await settings({ enabled: true, regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Images private", scope: "columns", rowIds: [], columnKeys: ["images"], users: {}, others: "deny" }] });
    let failure: unknown;
    try { await previewImport(actor(), input([{ xutiStyleNo: "STANDARD-RETAINED", fieldValues: { 标准颜色: "白色" } }])); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: 400, response: { error: { details: { colorFieldLabel: "标准颜色", imageSource: "existing", colorSource: "import", allowedColors: ["白色"] } } } });
    const details = (failure as { response: { error: { details: Row } } }).response.error.details;
    expect(details).not.toHaveProperty("imageIndex"); expect(details).not.toHaveProperty("imageColor");
    expect(JSON.stringify((failure as { response: unknown }).response)).not.toContain("秘密标准色");
    await settings({ enabled: false, regions: [] });
    await fixture.database!.query("UPDATE selection_field_registry SET definition=$1 WHERE field_key=$2", [JSON.stringify({ ...standard, label: "颜色标准" }), standard.key]);
    await changePhoto(actor("renamed-standard-link"), String(before.id), { action: "add", image: { id: "new", color: "秘密标准色", colorFieldKey: standard.key, url: "https://example.com/new.jpg" } });
    expect((await read("SELECT images FROM style_selections"))[0].images[1].colorFieldKey).toBe(standard.key);
  });
  it.each(["private", "denied", "autoHide", "deleted"])("round-trips opaque %s image links without disclosing field identifiers or enabling edits", async mode => {
    const standard = field("标准颜色");
    await register({ ...standard, ...(mode === "deleted" ? { deleted: true } : {}) }, "7", mode === "private" ? "PRIVATE" : "PUBLIC");
    const before = await style("OPAQUE", { color: "厂家黑", extraFields: { [standard.key]: "白色" }, images: [
      { id: "std", color: "白色", colorFieldKey: standard.key, url: "https://example.com/white.jpg" },
      { id: "supplier", color: "厂家黑", url: "https://example.com/black.jpg" },
    ] });
    if (mode === "denied") await settings({ enabled: true, regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Standard denied", scope: "columns", rowIds: [], columnKeys: [standard.key], users: {}, others: "deny" }] });
    if (mode === "autoHide") await settings({ autoHide: true, autoHideRegions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Standard hidden", scope: "columns", rowIds: [], columnKeys: [standard.key] }] });
    const other = { ...actor(), actor: { ...actor().actor, id: "8", username: "other" } };
    const projected = await selectionDetail(other, String(before.id));
    expect(projected.images[0].colorFieldKey).toBe("protected");
    expect(JSON.stringify(projected.images)).not.toContain(standard.key);
    if (mode === "private") expect(JSON.stringify(projected)).not.toContain(standard.key);
    await write({ ...other, key: "preserve-opaque" }, { material: "正常更新", images: projected.images }, String(before.id));
    await write({ ...other, key: "remove-other-image" }, { images: [projected.images[0]] }, String(before.id));
    expect((await read("SELECT images FROM style_selections"))[0].images).toEqual([before.images[0]]);
    for (const [name, image] of [
      ["color", { ...projected.images[0], color: "黑色" }],
      ["url", { ...projected.images[0], url: "https://example.com/changed.jpg" }],
      ["id", { ...projected.images[0], id: "new-id" }],
      ["raw-key", { ...projected.images[0], color: "黑色", colorFieldKey: standard.key }],
      ["raw-key-unchanged", { ...projected.images[0], colorFieldKey: standard.key }],
      ["removed-marker", { ...projected.images[0], color: "厂家黑", colorFieldKey: undefined }],
    ] as const) {
      let failure: unknown;
      try { await write({ ...other, key: `reject-opaque-${name}` }, { images: [image] }, String(before.id)); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ status: 403 });
      expect(JSON.stringify((failure as { response: unknown }).response)).not.toContain(standard.key);
      expect((await read("SELECT images FROM style_selections"))[0].images).toEqual([before.images[0]]);
    }
  });
  it("keeps standard-linked pictures through public collection save, submit and internal approval without exposing links", async () => {
    const standard = field("标准颜色"); await register(standard);
    const before = await style("COLLECTION-STANDARD", { color: "厂家黑", extraFields: { [standard.key]: "白色" }, images: [{ id: "std", color: "白色", colorFieldKey: standard.key, url: "https://example.com/white.jpg" }] });
    const created = await createCollection(actor("collection-create"), { title: "测试收集", ids: [String(before.id)], days: 7 });
    const publicView = await publicCollectionDetail(created.token);
    expect(JSON.stringify(publicView)).not.toContain(standard.key);
    const other = { ...actor(), actor: { ...actor().actor, id: "8", username: "other" } };
    const internalView = await collectionDetail(other, String(created.id));
    expect(JSON.stringify(internalView)).not.toContain(standard.key);
    const info = { supplierStyleNo: "SUP", color: "新厂家色", sizeRange: "F", material: "更新成分", supplyPriceExclTax: "0", sellingPoints: "柔软", reorderDays: 0, inventory: collectionInventory("新厂家色", "F", []) };
    const saved = await saveCollection(created.token, "public-save", String(before.id), { revision: publicView.revision, info });
    const submitted = await submitCollection(created.token, "public-submit", { revision: saved.revision, itemId: String(before.id) });
    await reviewCollection(actor("collection-approve"), String(created.id), { revision: submitted.revision, itemId: String(before.id), action: "approve" });
    expect((await read("SELECT color,material,images,extra_fields FROM style_selections"))[0]).toEqual({ color: "新厂家色", material: "更新成分", images: before.images, extra_fields: before.extra_fields });
    expect((await read("SELECT draft FROM selection_collection_items"))[0].draft.images).toEqual(before.images);
  });
  it("reuses an existing noncanonical archive standard-color tags field for supplied values and image-only updates", async () => {
    fixture.archive = true;
    const standard = { ...field("标准颜色", "tags"), key: "custom:transferred-standard" };
    await fixture.database!.query("INSERT INTO product_fields(id,name,type,options) VALUES($1,'标准颜色','text','[]')", [archiveFieldIds.standardColor]);
    await fixture.database!.query("INSERT INTO products(id,style_no) VALUES(1,'ARCHIVE-TRANSFERRED-STANDARD')");
    await fixture.database!.query(`INSERT INTO selection_field_registry(workspace_key,table_id,field_key,owner_id,visibility,definition)
      VALUES('23',23,$1,7,'PUBLIC',$2)`, [standard.key, JSON.stringify(standard)]);
    await fixture.database!.query(`INSERT INTO selection_layout_preferences(user_id,workspace_key,table_id,preferences)
      VALUES(7,'23',23,$1)`, [JSON.stringify(selectionLayoutSchema.parse({ columns: [...selectionBaseFields, standard] }))]);
    await fixture.database!.query(`INSERT INTO selection_table_23.style_selections(xuti_style_no,product_id,color,extra_fields)
      VALUES('ARCHIVE-TRANSFERRED-STANDARD',1,'厂家黑',$1)`, [JSON.stringify({ [standard.key]: "旧颜色" })]);
    await selectionScope.run("23", async () => {
      const plan = await previewImport(actor("archive-transferred-main"), input([{ xutiStyleNo: "ARCHIVE-TRANSFERRED-STANDARD", fieldValues: { 标准颜色: "白色/灰色" }, images: [
        { id: "white", color: "白色", colorFieldKey: "standard", url: "https://example.com/white.jpg" },
      ] }]));
      expect(plan.fields.find(binding => binding.header === "标准颜色")).toMatchObject({ key: standard.key, type: "tags", isNew: false });
      expect(await read("SELECT field_key FROM selection_field_registry")).toEqual([{ field_key: standard.key }]);
      expect(await commitImport(actor("archive-transferred-main"), payload(plan))).toMatchObject({ updated: 1, fieldsCreated: 0 });
      const imagesOnly = await previewImport(actor("archive-transferred-images"), input([{ xutiStyleNo: "ARCHIVE-TRANSFERRED-STANDARD", images: [
        { id: "gray", color: "灰色", colorFieldKey: "standard", url: "https://example.com/gray.jpg" },
      ] }]));
      expect(imagesOnly.fields.find(binding => binding.header === "标准颜色")).toMatchObject({ key: standard.key, type: "tags", isNew: false });
      expect(await commitImport(actor("archive-transferred-images"), payload(imagesOnly))).toMatchObject({ updated: 1, fieldsCreated: 0 });
    });
    expect((await read("SELECT color,extra_fields,images FROM selection_table_23.style_selections"))[0]).toEqual({ color: "厂家黑", extra_fields: { [standard.key]: "白色/灰色" }, images: [
      { id: "gray", color: "灰色", colorFieldKey: standard.key, url: "https://example.com/gray.jpg" },
    ] });
    expect(await read("SELECT field_key FROM selection_field_registry")).toEqual([{ field_key: standard.key }]);
  });
  it.each(["private", "hidden", "deleted"])("does not create an archive canonical fallback around an existing %s standard-color field", async mode => {
    fixture.archive = true;
    const standard = { ...field("标准颜色", "tags"), key: "custom:unavailable-standard", ...(mode === "deleted" ? { deleted: true } : {}) };
    await fixture.database!.query("INSERT INTO product_fields(id,name,type,options) VALUES($1,'标准颜色','text','[]')", [archiveFieldIds.standardColor]);
    await fixture.database!.query(`INSERT INTO selection_field_registry(workspace_key,table_id,field_key,owner_id,visibility,definition)
      VALUES('23',23,$1,$2,$3,$4)`, [standard.key, mode === "private" ? 8 : 7, mode === "private" ? "PRIVATE" : "PUBLIC", JSON.stringify(standard)]);
    await fixture.database!.query(`INSERT INTO selection_layout_preferences(user_id,workspace_key,table_id,preferences)
      VALUES(7,'23',23,$1)`, [JSON.stringify(selectionLayoutSchema.parse({ columns: [...selectionBaseFields, standard], hiddenColumns: mode === "hidden" ? [standard.key] : [] }))]);
    await selectionScope.run("23", async () => {
      await expect(previewImport(actor(), input([{ xutiStyleNo: "ARCHIVE-UNAVAILABLE-STANDARD", fieldValues: { 标准颜色: "白色" }, images: [
        { id: "white", color: "白色", colorFieldKey: "standard", url: "https://example.com/white.jpg" },
      ] }]))).rejects.toMatchObject({ status: 403, response: { error: { message: "导入列包含不可访问的字段，请核对字段权限和显示设置" } } });
    });
    expect(await read("SELECT field_key FROM selection_field_registry")).toEqual([{ field_key: standard.key }]);
    expect(await read("SELECT * FROM selection_table_23.style_selections")).toEqual([]);
  });
  it.each(["PUBLIC", "PRIVATE"])("resolves actual archive standard-color fields before inferred default columns without a saved layout (%s)", async visibility => {
    fixture.archive = true;
    const standard = { ...field("标准颜色", "tags"), key: "custom:registered-standard" };
    await fixture.database!.query("UPDATE project_tables SET initial_layout='selection' WHERE id=23");
    try {
      await fixture.database!.query("INSERT INTO product_fields(id,name,type,options) VALUES($1,'标准颜色','text','[]')", [archiveFieldIds.standardColor]);
      await fixture.database!.query(`INSERT INTO selection_field_registry(workspace_key,table_id,field_key,owner_id,visibility,definition)
        VALUES('23',23,$1,8,$2,$3)`, [standard.key, visibility, JSON.stringify(standard)]);
      await selectionScope.run("23", async () => {
        const preview = previewImport(actor(), input([{ xutiStyleNo: "ARCHIVE-INFERRED-STANDARD", fieldValues: { 标准颜色: "白色" }, images: [
          { id: "white", color: "白色", colorFieldKey: "standard", url: "https://example.com/white.jpg" },
        ] }]));
        if (visibility === "PRIVATE") await expect(preview).rejects.toMatchObject({ status: 403 });
        else expect((await preview).fields.find(binding => binding.header === "标准颜色")).toMatchObject({ key: standard.key, type: "tags", isNew: false });
      });
      expect(await read("SELECT field_key FROM selection_field_registry")).toEqual([{ field_key: standard.key }]);
      expect(await read("SELECT * FROM selection_layout_preferences")).toEqual([]);
    } finally {
      await fixture.database!.query("UPDATE project_tables SET initial_layout='empty' WHERE id=23");
    }
  });
  it("prefers canonical archive standard color, previews without writes, then mirrors linked images without supplier changes", async () => {
    fixture.archive = true;
    await fixture.database!.query("INSERT INTO product_fields(id,name,type,options) VALUES($1,'标准颜色','text','[]')", [archiveFieldIds.standardColor]);
    await fixture.database!.query("INSERT INTO products(id,style_no,custom_fields) VALUES(1,'ARCHIVE-STANDARD',$1)", [JSON.stringify({ [archiveFieldIds.customColor]: "厂家黑", [archiveFieldIds.standardColor]: "白色/灰色" })]);
    await selectionScope.run("23", async () => {
      const plan = await previewImport(actor(), input([{ xutiStyleNo: "ARCHIVE-STANDARD", images: [{ id: "white", color: "白色", colorFieldKey: "standard", url: "https://example.com/white.jpg" }] }]));
      expect(plan.fields.find(binding => binding.header === "标准颜色")?.key).toBe("custom:product:" + archiveFieldIds.standardColor);
      expect(await read("SELECT * FROM selection_table_23.style_selections")).toEqual([]);
      expect(await read("SELECT * FROM selection_field_registry")).toEqual([]);
      await commitImport(actor(), payload(plan));
      expect((await read("SELECT color,extra_fields,images FROM selection_table_23.style_selections"))[0]).toMatchObject({ color: "厂家黑", extra_fields: { ["custom:product:" + archiveFieldIds.standardColor]: "白色/灰色" }, images: [{ colorFieldKey: "custom:product:" + archiveFieldIds.standardColor, color: "白色" }] });
      expect((await read("SELECT visibility FROM selection_field_registry WHERE field_key=$1", ["custom:product:" + archiveFieldIds.standardColor]))[0].visibility).toBe("PUBLIC");
    });
  });
  it("identifies the exact first incompatible imported image after normalization without writing any part of the batch", async () => {
    const rows = [
      { xutiStyleNo: "FIRST", color: "白色", fieldValues: { 新字段: "一" }, images: [{ id: "one", color: "白色", url: "https://example.com/one.jpg" }] },
      { xutiStyleNo: "SECOND", color: " 白色 / 灰色 / 白色 ", fieldValues: { 新字段: "二" }, images: [
        { id: "two", color: " 白色 ", url: "https://example.com/two.jpg" },
        { id: "three", color: " 黑色 ", url: "https://example.com/three.jpg" },
        { id: "four", color: "红色", url: "https://example.com/four.jpg" },
      ] },
    ];
    const diagnostic = { kind: "SELECTION_IMPORT_IMAGE_COLOR", rowIndex: 1, xutiStyleNo: "SECOND", imageIndex: 1,
      imageSource: "import", colorSource: "import", imageColor: "黑色", allowedColors: ["白色", "灰色"] };
    await expect(previewImport(actor(), input(rows))).rejects.toMatchObject({ status: 400, response: { error: {
      code: "VALIDATION_ERROR", message: expect.stringContaining("第 2 张图片颜色「黑色」"), details: diagnostic,
    } } });
    const validRows = rows.map(row => ({ ...row, images: row.images.map(image => ({ ...image, color: "白色" })) }));
    const plan = await previewImport(actor(), input(validRows));
    plan.rows[1].values.images[1].color = " 黑色 ";
    await expect(commitImport(actor(), payload(plan))).rejects.toMatchObject({ status: 400, response: { error: { details: diagnostic } } });
    for (const table of ["style_selections", "selection_field_registry", "selection_layout_preferences", "audit_logs", "idempotency_records"])
      expect(await read(`SELECT * FROM ${table}`)).toEqual([]);
  });
  it("reports an incompatible retained image when importing only supplier colors", async () => {
    const before = await style("COLOR-ONLY", { color: "白色/黑色", images: [
      { id: "white", color: "白色", url: "https://example.com/white.jpg" },
      { id: "black", color: "黑色", url: "https://example.com/black.jpg" },
    ] });
    await expect(previewImport(actor(), input([{ xutiStyleNo: "COLOR-ONLY", color: "白色" }]))).rejects.toMatchObject({ status: 400, response: { error: {
      message: expect.stringContaining("现有第 2 张图片颜色「黑色」"), details: {
        kind: "SELECTION_IMPORT_IMAGE_COLOR", rowIndex: 0, xutiStyleNo: "COLOR-ONLY", imageIndex: 1,
        imageSource: "existing", colorSource: "import", imageColor: "黑色", allowedColors: ["白色"],
      },
    } } });
    expect((await read("SELECT * FROM style_selections"))[0]).toEqual(before);
  });
  it("reports an omitted new-row supplier color as an empty imported color, not a retained system value", async () => {
    await expect(previewImport(actor(), input([{ xutiStyleNo: "NEW-WITHOUT-COLOR", color: " ", images: [
      { id: "red", color: "红色", url: "https://example.com/red.jpg" },
    ] }]))).rejects.toMatchObject({ status: 400, response: { error: {
      message: expect.stringContaining("本次导入的供应商颜色（未填写）"), details: {
        kind: "SELECTION_IMPORT_IMAGE_COLOR", rowIndex: 0, xutiStyleNo: "NEW-WITHOUT-COLOR", imageIndex: 0,
        imageSource: "import", colorSource: "import", imageColor: "红色", allowedColors: [],
      },
    } } });
    expect(await read("SELECT * FROM style_selections")).toEqual([]);
  });
  it("uses existing readable supplier colors for image-only imports and keeps them on commit", async () => {
    const before = await style("IMAGE-ONLY", { color: "红色/白色" });
    const image = { id: "new", color: "黑色", url: "https://example.com/new.jpg" };
    await expect(previewImport(actor(), input([{ xutiStyleNo: "IMAGE-ONLY", images: [image] }]))).rejects.toMatchObject({ status: 400, response: { error: {
      message: expect.stringContaining("系统供应商颜色「红色/白色」"), details: {
        kind: "SELECTION_IMPORT_IMAGE_COLOR", rowIndex: 0, xutiStyleNo: "IMAGE-ONLY", imageIndex: 0,
        imageSource: "import", colorSource: "existing", imageColor: "黑色", allowedColors: ["红色", "白色"],
      },
    } } });
    expect((await read("SELECT * FROM style_selections"))[0]).toEqual(before);
    const plan = await previewImport(actor(), input([{ xutiStyleNo: "IMAGE-ONLY", images: [{ ...image, color: " 红色 " }] }]));
    expect(await commitImport(actor(), payload(plan))).toMatchObject({ created: 0, updated: 1 });
    expect((await read("SELECT color,images FROM style_selections"))[0]).toEqual({ color: "红色/白色", images: [{ ...image, color: "红色" }] });
  });
  it("checks requested write permissions before returning image-color diagnostics", async () => {
    const before = await style("LOCKED", { color: "白色" });
    await settings({ enabled: true, regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Images readonly", scope: "columns", rowIds: [], columnKeys: ["images"], users: {}, others: "read" }] });
    await expect(previewImport(actor(), input([{ xutiStyleNo: "LOCKED", images: [{ id: "one", color: "黑色", url: "https://example.com/one.jpg" }] }]))).rejects.toMatchObject(forbidden);
    expect((await read("SELECT * FROM style_selections"))[0]).toEqual(before);
    expect(await read("SELECT * FROM audit_logs")).toEqual([]);
  });
  it("omits unreadable retained supplier colors from both message and details", async () => {
    const before = await style("PRIVATE-COLOR", { color: "秘密颜色" });
    await settings({ enabled: true, regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Colors private", scope: "columns", rowIds: [], columnKeys: ["color"], users: {}, others: "deny" }] });
    let failure: unknown;
    try { await previewImport(actor(), input([{ xutiStyleNo: "PRIVATE-COLOR", images: [{ id: "one", color: "黑色", url: "https://example.com/one.jpg" }] }])); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: 400, response: { error: { details: {
      kind: "SELECTION_IMPORT_IMAGE_COLOR", rowIndex: 0, xutiStyleNo: "PRIVATE-COLOR", imageIndex: 0,
      imageSource: "import", colorSource: "existing", imageColor: "黑色",
    } } } });
    const body = (failure as { response: { error: { details: Row } } }).response;
    expect(body.error.details).not.toHaveProperty("allowedColors");
    expect(JSON.stringify(body)).not.toContain("秘密颜色");
    expect(JSON.stringify(body)).not.toContain("https://");
    expect((await read("SELECT * FROM style_selections"))[0]).toEqual(before);
  });
  it.each(["region", "hidden", "private", "autoHide"])("omits retained image colors protected by %s", async mode => {
    await style("PRIVATE-IMAGE", { color: "黑色/秘密图片颜色", images: [
      { id: "black", color: "黑色", url: "https://example.com/black.jpg" },
      { id: "secret", color: "秘密图片颜色", url: "https://example.com/secret.jpg" },
    ] });
    if (mode === "region") await settings({ enabled: true, regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Images private", scope: "columns", rowIds: [], columnKeys: ["images"], users: {}, others: "deny" }] });
    if (mode === "hidden") await fixture.database!.query("INSERT INTO selection_layout_preferences(user_id,workspace_key,preferences) VALUES(7,'default',$1)", [JSON.stringify(selectionLayoutSchema.parse({ columns: selectionBaseFields, hiddenColumns: ["images"] }))]);
    if (mode === "private") await register(selectionBaseFields.find(field => field.key === "images")!, "8");
    if (mode === "autoHide") {
      await fixture.database!.exec("UPDATE style_selections SET created_by=8");
      await settings({ autoHide: true, autoHideRegions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Images hidden", scope: "columns", rowIds: [], columnKeys: ["images"] }] });
    }
    const before = (await read("SELECT * FROM style_selections"))[0];
    let failure: unknown;
    try { await previewImport(actor(), input([{ xutiStyleNo: "PRIVATE-IMAGE", color: "黑色" }])); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: 400, response: { error: { details: {
      kind: "SELECTION_IMPORT_IMAGE_COLOR", rowIndex: 0, xutiStyleNo: "PRIVATE-IMAGE",
      imageSource: "existing", colorSource: "import", allowedColors: ["黑色"],
    } } } });
    const body = (failure as { response: { error: { details: Row } } }).response;
    expect(body.error.details).not.toHaveProperty("imageColor");
    expect(body.error.details).not.toHaveProperty("imageIndex");
    expect(body).toMatchObject({ error: { message: expect.stringContaining("系统已有图片") } });
    expect(JSON.stringify(body)).not.toContain("第 2 张");
    expect(JSON.stringify(body)).not.toContain("秘密图片颜色");
    expect(JSON.stringify(body)).not.toContain("secret.jpg");
    expect((await read("SELECT * FROM style_selections"))[0]).toEqual(before);
    expect(await read("SELECT * FROM audit_logs")).toEqual([]);
  });
  it("does not validate or alter colors on skipped existing rows but still validates new rows", async () => {
    const before = await style("SKIPPED", { color: "白色" });
    const plan = await previewImport(actor(), input([{ xutiStyleNo: "SKIPPED", color: "黑色", images: [{ id: "wrong", color: "红色", url: "https://example.com/red.jpg" }] }], "SKIP"));
    expect(plan.rows[0].operation).toBe("SKIP");
    expect(plan.fields).toEqual([]);
    expect(await commitImport(actor(), payload(plan))).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect((await read("SELECT * FROM style_selections"))[0]).toEqual(before);
    await expect(previewImport(actor("new-skipped"), input([{ xutiStyleNo: "NEW", color: "黑色", images: [{ id: "wrong", color: "红色", url: "https://example.com/red.jpg" }] }], "SKIP"))).rejects.toMatchObject({ status: 400, response: { error: { details: { xutiStyleNo: "NEW", imageColor: "红色" } } } });
    expect(await read("SELECT * FROM audit_logs")).toEqual([]);
    expect(await read("SELECT * FROM selection_field_registry")).toEqual([]);
  });
  it("previews and commits registered fields with Prisma-style BigInt metadata", async () => {
    const title = field("长标题");
    await register(title);
    fixture.registryBigInt = true;
    const plan = await previewImport(actor("bigint-registry"), input([
      { xutiStyleNo: "PRICE-CHECK-NORMAL", tagPrice: "50", fieldValues: { 长标题: "测试文件：普通金额" } },
      { xutiStyleNo: "PRICE-CHECK-FLOAT", tagPrice: "228", fieldValues: { 长标题: "测试文件：第3行金额" } },
    ]));
    expect(plan.created).toBe(2);
    expect(plan.fieldRevision).toMatch(/^[a-f0-9]{32}$/);
    expect(plan.fields.find(binding => binding.header === "长标题")).toMatchObject({ key: title.key, isNew: false });
    expect(await commitImport(actor("bigint-registry"), payload(plan))).toMatchObject({ created: 2, fieldsCreated: 0 });
    expect((await read("SELECT tag_price,extra_fields FROM style_selections ORDER BY id")).map(value => ({ price: value.tag_price, title: value.extra_fields[title.key] })))
      .toEqual([{ price: "50", title: "测试文件：普通金额" }, { price: "228", title: "测试文件：第3行金额" }]);
  });
  it("keeps archive public-field revisions stable with a BigInt table ID and no owner", async () => {
    const title = field("长标题");
    await fixture.database!.query(`INSERT INTO selection_field_registry(workspace_key,table_id,field_key,owner_id,visibility,definition)
      VALUES('23',23,$1,NULL,'PUBLIC',$2)`, [title.key, JSON.stringify(title)]);
    fixture.archive = true; fixture.registryBigInt = true;
    await selectionScope.run("23", async () => {
      const plan = await previewImport(actor("bigint-archive"), input([{ xutiStyleNo: "PRICE-CHECK-ARCHIVE", tagPrice: "228", fieldValues: { 长标题: "公共标题" } }]));
      const repeated = await previewImport(actor("bigint-archive"), input([{ xutiStyleNo: "PRICE-CHECK-ARCHIVE", tagPrice: "228", fieldValues: { 长标题: "公共标题" } }]));
      expect(plan.fieldRevision).toBe(repeated.fieldRevision);
      expect(plan.fields.find(binding => binding.header === "长标题")).toMatchObject({ key: title.key, isNew: false });
      expect(await commitImport(actor("bigint-archive"), payload(plan))).toMatchObject({ created: 1, fieldsCreated: 0 });
    });
    expect((await read("SELECT tag_price,extra_fields FROM selection_table_23.style_selections"))[0])
      .toMatchObject({ tag_price: "228", extra_fields: { [title.key]: "公共标题" } });
  });
  it("previews and atomically commits 5000 styles, rejecting 5001 before any writes", async () => {
    const inputRows = Array.from({ length: selectionImportLimits.maxRows }, (_, index) => ({ xutiStyleNo: `LIMIT-${index}`, material: "棉" }));
    const previewStart = performance.now();
    const plan = await previewImport(actor("large-batch"), input(inputRows));
    const previewMs = Math.round(performance.now() - previewStart);
    expect(plan.rows).toHaveLength(5000);
    expect(plan.created).toBe(5000);
    await expect(previewImport(actor("over-limit"), input([...inputRows, { xutiStyleNo: "LIMIT-5001" }]))).rejects.toMatchObject({ status: 400 });
    await expect(commitImport(actor("over-limit"), { ...payload(plan), rows: [...plan.rows, { ...plan.rows[0], values: { xutiStyleNo: "LIMIT-5001" } }] })).rejects.toMatchObject({ status: 400 });
    expect(await read("SELECT * FROM style_selections")).toHaveLength(0);
    const commitStart = performance.now();
    expect(await commitImport(actor("large-batch"), payload(plan))).toMatchObject({ created: 5000, updated: 0 });
    expect((await read("SELECT count(*)::int AS count FROM style_selections"))[0].count).toBe(5000);
    process.stdout.write(`Synthetic PGlite 5000 styles: preview ${previewMs}ms, commit ${Math.round(performance.now() - commitStart)}ms, preview JSON ${Buffer.byteLength(JSON.stringify(plan))} bytes\n`);
  }, 180000);
  it("updates supplied creation time and only provided nonblank columns, including zero, while retaining unrelated extras", async () => {
    const existing = field("短标题"), untouched = field("备注");
    await register(existing); await register(untouched);
    const before = await style("EXIST", { extraFields: { [existing.key]: "原标题", [untouched.key]: "保留备注" } });
    const plan = await previewImport(actor(), input([{ xutiStyleNo: "EXIST", vipPrice: "0", supplierCode: "", material: null, fieldValues: { 短标题: "新标题", 创建时间: "2025-04-22" } }]));
    expect(plan.rows[0].changedFields).toEqual(expect.arrayContaining(["唯品价", "短标题", "创建时间"]));
    expect(plan.rows[0].values).not.toHaveProperty("fieldValues.创建时间");
    expect(plan.rows[0].values.createdAt).toBe("2025-04-21T16:00:00.000Z");
    expect(await commitImport(actor(), payload(plan))).toMatchObject({ created: 0, updated: 1, skipped: 0, fieldsCreated: 0 });
    const after = (await read("SELECT * FROM style_selections"))[0];
    expect(after.vip_price).toBe("0"); expect(after.material).toBe("原成分"); expect(after.supplier_code).toBe("原编码");
    expect(after.extra_fields).toEqual({ [existing.key]: "新标题", [untouched.key]: "保留备注" });
    expect(after.created_at).toEqual(new Date("2025-04-21T16:00:00.000Z"));
    expect(after.created_at).not.toEqual(before.created_at);
  });
  it("SKIP preserves matched records and never registers or publishes fields from skipped rows", async () => {
    const before = await style();
    const plan = await previewImport(actor(), input([{ xutiStyleNo: "EXIST", material: "替换", fieldValues: { 新字段: "不会写" } }], "SKIP"));
    expect(plan.fields).toEqual([]); expect(plan.rows[0].operation).toBe("SKIP");
    expect(await commitImport(actor(), payload(plan))).toMatchObject({ created: 0, updated: 0, skipped: 1, fieldsCreated: 0 });
    expect((await read("SELECT * FROM style_selections"))[0]).toEqual(before);
    expect(await read("SELECT * FROM selection_field_registry")).toEqual([]);
    expect(await read("SELECT * FROM selection_layout_preferences")).toEqual([]);
    expect(await read("SELECT * FROM audit_logs")).toEqual([]);
  });
  it("creates private fields atomically in template order, appending them without moving existing columns", async () => {
    const initial = selectionLayoutSchema.parse({ columns: [selectionBaseFields[3], selectionBaseFields[0]] });
    await fixture.database!.query("INSERT INTO selection_layout_preferences(user_id,workspace_key,preferences,revision) VALUES(7,'default',$1,4)", [JSON.stringify(initial)]);
    const plan = await previewImport(actor(), input([{ xutiStyleNo: "NEW", fieldValues: { 用户备注: "甲", 短标题: "短", 安全类别: "B类", 长标题: "长" } }]));
    expect(plan.fields.map(item => item.label)).toEqual(["序缇款号", "安全类别", "长标题", "短标题", "用户备注"]);
    expect(await read("SELECT * FROM selection_field_registry")).toEqual([]);
    expect(await commitImport(actor(), payload(plan))).toMatchObject({ created: 1, updated: 0, fieldsCreated: 4 });
    const registry = await read("SELECT * FROM selection_field_registry");
    expect(registry.every(item => item.visibility === "PRIVATE" && item.owner_id === 7)).toBe(true);
    const saved = (await read("SELECT * FROM selection_layout_preferences"))[0];
    expect(saved.revision).toBe(5);
    expect(saved.preferences.columns.map((item: SelectionField) => item.label)).toEqual(["序缇款号", "创建时间", "安全类别", "长标题", "短标题", "用户备注"]);
    expect(await read("SELECT * FROM selection_shared_layouts")).toEqual([]);
    expect(await read("SELECT * FROM selection_shared_fields")).toEqual([]);
    expect(await commitImport(actor(), payload(plan))).toMatchObject({ created: 1, fieldsCreated: 4 });
    expect(await read("SELECT * FROM style_selections")).toHaveLength(1);
  });
  it("rolls back rows, new fields, layout and audits if a later row violates row claims", async () => {
    await settings({ claimsEnabled: true });
    const plan = await previewImport(actor(), input([{ xutiStyleNo: "A", fieldValues: { 新字段: "一" } }, { xutiStyleNo: "B", fieldValues: { 新字段: "二" } }]));
    await expect(commitImport(actor(), payload(plan))).rejects.toMatchObject({ status: 409, response: { error: { code: "ROW_CLAIMED" } } });
    for (const table of ["style_selections", "selection_field_registry", "selection_layout_preferences", "audit_logs", "idempotency_records"]) expect(await read(`SELECT * FROM ${table}`)).toEqual([]);
  });
  it("adds imported built-in columns to an empty project layout, preserving template order before custom fields", async () => {
    await selectionScope.run("23", async () => {
      await expect(previewImport(actor("too-many-images"), input([{ xutiStyleNo: "INVALID-IMAGES", images: Array.from({ length: 31 }, (_, index) => ({ id: String(index), url: `https://example.com/${index}.jpg` })) }]))).rejects.toMatchObject({ status: 400 });
      const plan = await previewImport(actor(), input([{ xutiStyleNo: "EMPTY-PROJECT", material: "棉", vipPrice: "0", fieldValues: { 用户备注: "新列" } }]));
      expect(plan.fields.filter(field => !field.isNew).map(field => field.label)).toEqual(["序缇款号", "成分", "唯品价"]);
      expect(await commitImport(actor(), payload(plan))).toMatchObject({ created: 1, fieldsCreated: 1 });
      const layout = (await read("SELECT preferences FROM selection_layout_preferences WHERE workspace_key='23'"))[0].preferences;
      expect(layout.columns.map((column: SelectionField) => column.label)).toEqual(["序缇款号", "成分", "唯品价", "用户备注"]);
      expect((await read("SELECT * FROM selection_table_23.style_selections"))[0]).toMatchObject({ xuti_style_no: "EMPTY-PROJECT", material: "棉", vip_price: "0" });
    });
    expect(await read("SELECT * FROM public.style_selections")).toEqual([]);
  });
  it("rejects stale row, layout and field snapshots before changing any records", async () => {
    await style();
    const plan = await previewImport(actor(), input([{ xutiStyleNo: "EXIST", fieldValues: { 新字段: "一" } }]));
    await fixture.database!.query("UPDATE style_selections SET updated_at=updated_at+interval '1 second',version=version+1");
    await expect(commitImport(actor(), payload(plan))).rejects.toMatchObject(conflict);
    expect(await read("SELECT * FROM selection_field_registry")).toEqual([]);
    const second = await previewImport(actor("second"), input([{ xutiStyleNo: "EXIST", fieldValues: { 新字段: "二" } }]));
    await settings({ enabled: true });
    await expect(commitImport(actor("second"), payload(second))).rejects.toMatchObject(conflict);
    const third = await previewImport(actor("third"), input([{ xutiStyleNo: "EXIST", fieldValues: { 新字段: "三" } }]));
    await fixture.database!.query("INSERT INTO selection_layout_preferences(user_id,workspace_key,preferences) VALUES(7,'default',$1)", [JSON.stringify(selectionLayoutSchema.parse({ columns: selectionBaseFields }))]);
    await expect(commitImport(actor("third"), payload(third))).rejects.toMatchObject(conflict);
    expect(await read("SELECT * FROM selection_field_registry")).toEqual([]);
  });
  it("does not bypass foreign private, hidden, protected or claimed cells by creating same-name fields", async () => {
    const privateField = field("长标题"); await register(privateField, "8"); await style();
    await expect(previewImport(actor(), input([{ xutiStyleNo: "EXIST", fieldValues: { 长标题: "秘密" } }]))).rejects.toMatchObject(forbidden);
    await fixture.database!.exec("DELETE FROM selection_field_registry");
    await register(privateField, "7", "PUBLIC");
    const initial = selectionLayoutSchema.parse({ columns: [...selectionBaseFields, privateField], hiddenColumns: [privateField.key] });
    await fixture.database!.query("INSERT INTO selection_layout_preferences(user_id,workspace_key,preferences) VALUES(7,'default',$1)", [JSON.stringify(initial)]);
    await expect(previewImport(actor(), input([{ xutiStyleNo: "EXIST", fieldValues: { 长标题: "隐藏" } }]))).rejects.toMatchObject(forbidden);
    await fixture.database!.exec("DELETE FROM selection_layout_preferences");
    await settings({ enabled: true, regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Locked", scope: "columns", rowIds: [], columnKeys: [privateField.key], users: {}, others: "read" }] });
    await expect(previewImport(actor(), input([{ xutiStyleNo: "EXIST", fieldValues: { 长标题: "受保护" } }]))).rejects.toMatchObject(forbidden);
    await settings({ claimsEnabled: true });
    await fixture.database!.exec("UPDATE style_selections SET claimed_by=8");
    await expect(previewImport(actor(), input([{ xutiStyleNo: "EXIST", material: "他人认领" }]))).rejects.toMatchObject(forbidden);
    expect(await read("SELECT * FROM selection_field_registry")).toHaveLength(1);
    expect(await read("SELECT * FROM audit_logs")).toEqual([]);
  });
  it("uses existing choices, image limits and text caps without splitting literal slashes", async () => {
    const single = field("三级类目", "single", ["女士皮衣/皮草", "女式外套"]);
    const multiple = field("整改", "multiple", ["换洗唛/吊牌", "缝领标"]);
    const text = { ...field("短标题"), textConfig: { countMode: "han" as const, maxLength: 2 } };
    const image = { ...field("证据图", "image"), imageConfig: { colors: false, links: true, upload: true, mobile: true, max: 1 } };
    for (const definition of [single, multiple, text, image]) await register(definition);
    const plan = await previewImport(actor(), input([{ xutiStyleNo: "NEW", fieldValues: { 三级类目: "女士皮衣/皮草", 整改: '["换洗唛/吊牌","缝领标"]', 短标题: "好看", 证据图: "https://example.com/one.jpg" } }]));
    await commitImport(actor(), payload(plan));
    const stored = (await read("SELECT extra_fields FROM style_selections"))[0].extra_fields;
    expect(stored[single.key]).toBe("女士皮衣/皮草");
    expect(stored[multiple.key]).toBe('@choices//v1:["换洗唛/吊牌","缝领标"]');
    expect(JSON.parse(stored[image.key])).toHaveLength(1);
    await expect(previewImport(actor("invalid"), input([{ xutiStyleNo: "NEW", fieldValues: { 短标题: "三个字" } }]))).rejects.toMatchObject({ status: 400 });
    await expect(previewImport(actor("invalid"), input([{ xutiStyleNo: "NEW", fieldValues: { 三级类目: "不存在" } }]))).rejects.toMatchObject({ status: 400 });
    await expect(previewImport(actor("invalid"), input([{ xutiStyleNo: "NEW", fieldValues: { 证据图: "https://example.com/1.jpg\nhttps://example.com/2.jpg" } }]))).rejects.toMatchObject({ status: 400 });
  });
  it("recognizes actual archive products even before their sheet row is synchronized", async () => {
    fixture.archive = true;
    await fixture.database!.query("INSERT INTO products(id,style_no) VALUES(99,'MASTER')");
    await selectionScope.run("23", async () => {
      const skip = await previewImport(actor(), input([{ xutiStyleNo: "MASTER", fieldValues: { 长标题: "未写入" } }], "SKIP"));
      expect(skip.rows[0]).toMatchObject({ productId: "99", operation: "SKIP" });
      await commitImport(actor(), payload(skip));
      expect(await read("SELECT * FROM selection_table_23.style_selections")).toEqual([]);
      const plan = await previewImport(actor("update"), input([{ xutiStyleNo: "MASTER", supplierCode: "新编码" }]));
      expect(plan.updated).toBe(1);
      await commitImport(actor("update"), payload(plan));
      const saved = (await read("SELECT * FROM selection_table_23.style_selections"))[0];
      expect(saved.product_id).toBe(99); expect(saved.supplier_code).toBe("新编码"); expect(saved.material).toBe("产品原成分");
    });
    expect(await read("SELECT * FROM public.style_selections")).toEqual([]);
  });
  it("checks an unsynchronized existing product as an update and preserves its color for an image-only patch", async () => {
    fixture.archive = true;
    await fixture.database!.query("INSERT INTO products(id,style_no,custom_fields) VALUES(99,'MASTER',$1)", [JSON.stringify({ [archiveFieldIds.composition]: "产品成分", [archiveFieldIds.customColor]: "红色" })]);
    const policy = { ...defaultProtection, enabled: true, regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Material readonly", scope: "columns", rowIds: [], columnKeys: ["material"], users: {}, others: "read" }] };
    await fixture.database!.query("UPDATE selection_table_23.style_selection_protection SET settings=$1,revision=revision+1", [JSON.stringify(policy)]);
    await selectionScope.run("23", async () => {
      const plan = await previewImport(actor(), input([{ xutiStyleNo: "MASTER", images: [{ id: "red", url: "https://example.com/red.jpg", color: "红色" }] }]));
      expect(plan.rows[0]).toMatchObject({ id: null, operation: "UPDATE", changedFields: ["图片"] });
      expect(await commitImport(actor(), payload(plan))).toMatchObject({ created: 0, updated: 1 });
      const saved = (await read("SELECT * FROM selection_table_23.style_selections"))[0];
      expect(saved).toMatchObject({ material: "产品成分", color: "红色", images: [{ id: "red", url: "https://example.com/red.jpg", color: "红色" }] });
    });
  });
});

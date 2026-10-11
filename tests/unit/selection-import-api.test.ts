import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Context } from "../../apps/api/src/core.js";
import type { Row, Tx } from "../../packages/database/src/index.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";
import { selectionBaseFields } from "../../packages/contracts/src/selection-migration.js";
import { selectionLayoutSchema, type SelectionField } from "../../packages/contracts/src/selection-layout.js";
import { archiveFieldIds } from "../../packages/contracts/src/product-archive.js";
import { selectionImportLimits } from "../../packages/contracts/src/selection-import-template.js";

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

import { previewImport, commitImport } from "../../apps/api/src/modules/style-selections/service.js";

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
const conflict = { status: 409, response: { error: { code: "EDIT_CONFLICT" } } };
const forbidden = { status: 403, response: { error: { code: "REGION_FORBIDDEN" } } };

beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(`
    CREATE TABLE users(id bigint PRIMARY KEY,display_name text,username text);
    INSERT INTO users VALUES(7,'Editor','editor'),(8,'Other','other');
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
    CREATE SCHEMA selection_table_23;
    CREATE TABLE selection_table_23.style_selections(LIKE public.style_selections INCLUDING ALL);
    CREATE TABLE selection_table_23.style_selection_protection(LIKE public.style_selection_protection INCLUDING ALL);
    CREATE FUNCTION public.sync_product_archive_record(p products,table_id bigint,actor_id bigint) RETURNS text LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO selection_table_23.style_selections(xuti_style_no,product_id,material,color,created_by) VALUES(p.style_no,p.id,coalesce(p.custom_fields->>'f0000000000000000000000000000000e','产品原成分'),p.custom_fields->>'f00000000000000000000000000000003',actor_id); RETURN 'ok'; END $$;
  `);
}, 30000);
beforeEach(async () => {
  fixture.archive = false; fixture.registryBigInt = false; fixture.mirrors = [];
  await fixture.database!.exec(`TRUNCATE style_selections,selection_field_registry,selection_layout_preferences,selection_shared_layouts,selection_shared_fields,idempotency_records,audit_logs,products,product_fields,style_selection_protection,selection_table_23.style_selections,selection_table_23.style_selection_protection RESTART IDENTITY`);
  await fixture.database!.query("INSERT INTO style_selection_protection(id,settings) VALUES(1,$1)", [JSON.stringify(defaultProtection)]);
  await fixture.database!.query("INSERT INTO selection_table_23.style_selection_protection(id,settings) VALUES(1,$1)", [JSON.stringify(defaultProtection)]);
});
afterAll(async () => { await fixture.database?.close(); });

describe("atomic Excel style import", () => {
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
  it("updates only provided nonblank columns, including zero, while retaining extras and creation time", async () => {
    const existing = field("短标题"), untouched = field("备注");
    await register(existing); await register(untouched);
    const before = await style("EXIST", { extraFields: { [existing.key]: "原标题", [untouched.key]: "保留备注" } });
    const plan = await previewImport(actor(), input([{ xutiStyleNo: "EXIST", vipPrice: "0", supplierCode: "", material: null, fieldValues: { 短标题: "新标题", 创建时间: "1900-01-01" } }]));
    expect(plan.rows[0].changedFields).toEqual(expect.arrayContaining(["唯品价", "短标题"]));
    expect(plan.rows[0].values).not.toHaveProperty("fieldValues.创建时间");
    expect(await commitImport(actor(), payload(plan))).toMatchObject({ created: 0, updated: 1, skipped: 0, fieldsCreated: 0 });
    const after = (await read("SELECT * FROM style_selections"))[0];
    expect(after.vip_price).toBe("0"); expect(after.material).toBe("原成分"); expect(after.supplier_code).toBe("原编码");
    expect(after.extra_fields).toEqual({ [existing.key]: "新标题", [untouched.key]: "保留备注" });
    expect(after.created_at).toEqual(before.created_at);
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

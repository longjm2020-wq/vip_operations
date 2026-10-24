import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { installSelectionContentCreatedTimeSchema } from "../fixtures/selection-content-created-time-schema.js";
import type { Context } from "../../apps/api/src/core.js";
import type { Row, Tx } from "../../packages/database/src/index.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";

const fixture = vi.hoisted(() => ({ database: null as PGlite | null, archive: true, images: [] as string[] }));
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  const wrap = (database: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) => sql.includes("pg_advisory_xact_lock") ? [] : (await database.query<Row>(sql, parameters)).rows,
    $executeRawUnsafe: async (sql: string, ...parameters: unknown[]) => (await database.query(sql, parameters)).affectedRows || 0,
  }) as unknown as Tx;
  return { ...original, db: {
    $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) => (await fixture.database!.query<Row>(sql, parameters)).rows,
    $transaction: async (work: (tx: Tx) => Promise<unknown>) => fixture.database!.transaction(transaction => work(wrap(transaction))),
  } };
});
vi.mock("../../apps/api/src/modules/style-selections/archive.js", () => ({ isArchive: async () => fixture.archive, mirrorArchiveRow: async () => undefined }));
vi.mock("../../apps/api/src/modules/style-selections/title-ai-images.js", () => ({ titleImageData: async (_context: unknown, url: string) => {
  fixture.images.push(url); return url.includes("broken") ? null : "data:image/jpeg;base64,cHJvdGVjdGVk";
} }));
import { applyStandards, generateStandards, readStandardsPlan, standardsAIStatus, standardsSource } from "../../apps/api/src/modules/style-selections/standards-ai.js";
import { standardSource } from "../../apps/api/src/modules/style-selections/standards-ai-catalog.js";
import { encryptSecret } from "../../apps/api/src/modules/analytics/secrets.js";
const safety = "custom:safety", standard = "custom:standard", title = "custom:title", category = "custom:product:categoryId";
const actor = (key = "standards"): Context => ({ actor: { id: "7", username: "editor", displayName: "Editor", permissions: ["selection.read", "selection.manage"], roleCodes: [] }, requestId: "standards-test", key });
const read = async (sql: string, values: unknown[] = []) => (await fixture.database!.query<Row>(sql, values)).rows;
const input = (ids: string[], mode = "blank") => ({ rowIds: ids, targetKeys: [safety, standard], mode });
const applyInput = (preview: Awaited<ReturnType<typeof generateStandards>>) => ({ planToken: preview.planToken, rows: preview.rows.map(row => ({ id: row.id, values: row.values.filter(value => value.value).map(({ key, value }) => ({ key, value })) })).filter(row => row.values.length) });
async function style(no: string, extra: Row = {}) {
  return (await read("INSERT INTO style_selections(xuti_style_no,material,extra_fields) VALUES($1,$2,$3) RETURNING *", [no, "面料：棉100%，梭织；里料：聚酯纤维100%；无填充", JSON.stringify({ [category]: "1", [title]: "成人女式梭织夹克外套，非贴身穿着", ...extra })]))[0];
}
let payload: Row, calls: number, handler: (products: Row[]) => unknown;
beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(`
    CREATE TABLE users(id bigint PRIMARY KEY,display_name text,username text); INSERT INTO users VALUES(7,'Editor','editor'),(8,'Other','other');
    CREATE TABLE style_selection_protection(id int PRIMARY KEY,settings jsonb,revision int DEFAULT 1);
    CREATE TABLE selection_field_registry(workspace_key text,field_key text,owner_id bigint,visibility text,definition jsonb,revision int DEFAULT 1,updated_at timestamptz DEFAULT now(),PRIMARY KEY(workspace_key,field_key));
    CREATE TABLE categories(id bigint PRIMARY KEY,name text); INSERT INTO categories VALUES(1,'女式外套');
    CREATE TABLE style_selections(
      id bigserial PRIMARY KEY,registration_batch date,images jsonb DEFAULT '[]',label_images jsonb DEFAULT '[]',
      cell_colors jsonb DEFAULT '{}',cell_alignments jsonb DEFAULT '{}',cell_vertical_alignments jsonb DEFAULT '{}',cell_text_colors jsonb DEFAULT '{}',cell_number_formats jsonb DEFAULT '{}',extra_fields jsonb DEFAULT '{}',
      xuti_style_no text,supplier_style_no text,supplier_code text,color text,size_range text,material text,
      supply_price_excl_tax numeric,vip_price numeric,live_price numeric,tag_price numeric,selling_points text,reorder_days int,collection_inventory jsonb DEFAULT '[]',
      sort_order int DEFAULT 0,row_color text DEFAULT 'NONE',created_by bigint DEFAULT 7,updated_by bigint DEFAULT 7,version int DEFAULT 1,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),cell_owners jsonb DEFAULT '{}',claimed_by bigint,
      migration_locked boolean DEFAULT false,migration_target_workspace text,migration_target_row_id bigint,migrated_at timestamptz,product_id bigint
    );
    CREATE TABLE idempotency_records(id bigserial,actor_id bigint,operation text,idempotency_key text,request_hash text,response_status int,response_body jsonb);
    CREATE TABLE audit_logs(id bigserial,actor_id bigint,actor_label text,action text,entity_type text,entity_id text,request_id text,before_data jsonb,after_data jsonb,reason text,selection_table_id bigint);
    CREATE TABLE compass_ai_settings(id int PRIMARY KEY,enabled boolean,api_key_encrypted text,verified_at timestamptz);
  `);
  await installSelectionContentCreatedTimeSchema(fixture.database);
}, 30000);
beforeEach(async () => {
  vi.stubEnv("COMPASS_MAIL_KEY", "a".repeat(64)); fixture.archive = true; fixture.images = []; calls = 0; payload = {};
  handler = products => ({ rows: products.map(product => ({ id: product.id, values: product.targets.map((target: Row) => ({ key: target.key,
    value: target.key === safety ? "GB 18401-2010 C类" : "FZ/T 81007-2022", reason: "本款成人非贴身梭织夹克，无填充", evidence: ["material", category, title] })), warnings: [] })) });
  await fixture.database!.exec("TRUNCATE style_selections,selection_field_registry,style_selection_protection,idempotency_records,audit_logs,compass_ai_settings RESTART IDENTITY");
  await fixture.database!.query("INSERT INTO style_selection_protection(id,settings) VALUES(1,$1)", [JSON.stringify(defaultProtection)]);
  for (const [key, label] of [[safety, "安全类别"], [standard, "执行标准"], [category, "三级类目"], [title, "长标题"]])
    await fixture.database!.query("INSERT INTO selection_field_registry(workspace_key,field_key,owner_id,visibility,definition) VALUES('default',$1,7,'PUBLIC',$2)", [key, JSON.stringify({ key, label, custom: true, width: 120, type: "text" })]);
  await fixture.database!.query("INSERT INTO compass_ai_settings VALUES(1,true,$1,now())", [encryptSecret("mock-provider-key-never-real")]);
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    calls++; payload = JSON.parse(init.body as string);
    const data = JSON.parse(payload.messages[1].content[0].text), result = handler(data.products);
    return new Response(JSON.stringify({ id: "test-response", model: "openai/gpt-6.1-sol", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }] }), { status: 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => { await fixture.database?.close(); });

describe("AI standard adaptation", () => {
  it("uses actual product pixels, composition, category names and title, excludes labels, then saves only blank fields with audit and idempotency", async () => {
    const row = await style("STYLE", { [safety]: "人工确认安全类别" });
    await read("UPDATE style_selections SET images=$2,label_images=$3 WHERE id=$1", [row.id, JSON.stringify([{ url: "broken-product" }, { url: "product" }]), JSON.stringify([{ url: "label" }])]);
    for (const [key, label] of [["labelImages", "商品图片"], ["custom:wash", "洗唛/吊牌图"], ["custom:hangtag", "吊牌图"]]) {
      await read("INSERT INTO selection_field_registry(workspace_key,field_key,owner_id,visibility,definition) VALUES('default',$1,7,'PUBLIC',$2)", [key, JSON.stringify({ key, label, width: 120, type: "image" })]);
      if (key.startsWith("custom:")) await read("UPDATE style_selections SET extra_fields=extra_fields || $2::jsonb WHERE id=$1", [row.id, JSON.stringify({ [key]: [{ url: key + "-excluded" }] })]);
    }
    const preview = await generateStandards(actor(), input([String(row.id)]));
    const products = JSON.parse(payload.messages[1].content[0].text).products;
    expect(products[0].facts).toEqual(expect.arrayContaining([{ key: category, label: "三级类目", value: "女式外套" }, expect.objectContaining({ key: title }), expect.objectContaining({ key: "material" })]));
    expect(products[0].imageInputs).toEqual(["product:1"]);
    expect(products[0]).not.toHaveProperty("pictures");
    expect(payload.messages[1].content.filter((item: Row) => item.type === "image_url")).toHaveLength(1);
    expect(fixture.images).toEqual(["broken-product", "product"]);
    expect(JSON.stringify(payload.messages[1].content)).not.toContain("label:1");
    expect(payload.messages[0].content).toContain("禁止作为适配依据");
    expect(payload.messages[0].content).toContain("必须忽略这些文字");
    expect(preview.rows[0].values.map(value => value.key)).toEqual([standard]);
    expect(preview.rows[0].evidence[0]).toBe("实际读取：商品图片 1 张");
    expect((await read("SELECT extra_fields FROM style_selections"))[0].extra_fields[standard]).toBeUndefined();
    expect(await applyStandards(actor(), applyInput(preview))).toMatchObject({ updatedCount: 1 });
    expect(await applyStandards(actor(), applyInput(preview))).toMatchObject({ updatedCount: 1 });
    expect((await read("SELECT extra_fields FROM style_selections"))[0].extra_fields).toMatchObject({ [standard]: "FZ/T 81007-2022", [safety]: "人工确认安全类别" });
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(1);
  });
  it("never uses label-only rows or label cells renamed as descriptors as model evidence", async () => {
    expect(standardsSource({ labelImages: [{ url: "label-only" }] }, [{ key: "labelImages", label: "成分", type: "text", width: 120 }])).toEqual({ facts: [], pictures: [] });
    const row = await style("LABEL-ONLY");
    await read("UPDATE style_selections SET material='',extra_fields='{}',label_images='[{\"url\":\"label-only\"}]' WHERE id=$1", [row.id]);
    const preview = await generateStandards(actor(), input([String(row.id)]));
    expect(fixture.images).toEqual([]); expect(calls).toBe(0);
    expect(preview.rows[0].values.every(value => !value.value)).toBe(true);
    expect(readStandardsPlan(preview.planToken, actor()).rows).toEqual([]);
  });
  it("can reassess existing values and bind each exact candidate to its signed row and field", async () => {
    const row = await style("OLD", { [safety]: "旧值", [standard]: "旧标准" });
    const preview = await generateStandards(actor(), input([String(row.id)], "replace"));
    expect(preview.rows[0].values).toEqual(expect.arrayContaining([expect.objectContaining({ previousValue: "旧值" }), expect.objectContaining({ previousValue: "旧标准" })]));
    expect(readStandardsPlan(preview.planToken, actor()).mode).toBe("replace");
    const tampered = applyInput(preview); tampered.rows[0].values[0].value = "GB 18401-2010 B类";
    await expect(applyStandards(actor(), tampered)).rejects.toMatchObject({ status: 403 });
    await applyStandards(actor(), applyInput(preview));
    expect((await read("SELECT extra_fields FROM style_selections"))[0].extra_fields[standard]).toBe("FZ/T 81007-2022");
  });
  it.each(["material", "images", "extra_fields"])("rejects concurrent %s changes atomically, even without a timestamp update", async column => {
    const first = await style("ONE"), second = await style("TWO");
    const preview = await generateStandards(actor(), input([String(first.id), String(second.id)]));
    if (column === "material") await read("UPDATE style_selections SET material='新成分' WHERE id=$1", [second.id]);
    if (column === "images") await read("UPDATE style_selections SET images='[{\"url\":\"new-product\"}]' WHERE id=$1", [second.id]);
    if (column === "extra_fields") await read("UPDATE style_selections SET extra_fields=extra_fields || $2::jsonb WHERE id=$1", [second.id, JSON.stringify({ [title]: "改为针织服装" })]);
    await expect(applyStandards(actor(), applyInput(preview))).rejects.toMatchObject({ status: 409 });
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [first.id]))[0].extra_fields[standard]).toBeUndefined();
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(0);
  });
  it("excludes private sources and images, and rejects revoked target permissions", async () => {
    const row = await style("PRIVATE");
    for (const [key, label] of [["material", "成分"], ["images", "图片"], ["labelImages", "洗唛/吊牌图"]]) await read("INSERT INTO selection_field_registry(workspace_key,field_key,owner_id,visibility,definition) VALUES('default',$1,8,'PRIVATE',$2)", [key, JSON.stringify({ key, label, width: 120, type: key === "material" ? "text" : "image" })]);
    await read("UPDATE style_selections SET images='[{\"url\":\"secret-image\"}]',label_images='[{\"url\":\"secret-label\"}]'");
    handler = products => ({ rows: products.map(product => ({ id: product.id, values: product.targets.map((target: Row) => ({ key: target.key, value: "", reason: "缺少成分与图片", evidence: [category, title] })), warnings: [] })) });
    const preview = await generateStandards(actor(), input([String(row.id)]));
    expect(JSON.stringify(payload)).not.toContain("secret-image"); expect(JSON.stringify(payload)).not.toContain("棉100"); expect(fixture.images).toEqual([]);
    expect(preview.rows[0].values.every(value => !value.value)).toBe(true);
    await read("UPDATE selection_field_registry SET owner_id=8,visibility='PRIVATE',revision=revision+1 WHERE field_key=$1", [standard]);
    await expect(generateStandards(actor(), input([String(row.id)]))).rejects.toMatchObject({ status: 403 });
  });
  it("keeps insufficient, invented, obsolete, future or falsely referenced suggestions pending without writing them", async () => {
    const row = await style("PENDING");
    for (const [code, evidence] of [["GB/T 99999-2099", ["material"]], ["GB/T 18132-2026", ["material"]], ["GB/T 18132-2008", ["material"]], ["FZ/T 81007-2022", ["product:1"]], ["FZ/T 81007-2022", ["label:1"]]] as [string, string[]][]) {
      handler = products => ({ rows: products.map(product => ({ id: product.id, values: product.targets.map((target: Row) => ({ key: target.key, value: target.key === safety ? "GB 18401-2010 C类" : code, reason: "候选依据", evidence: target.key === safety ? [category] : evidence })), warnings: [] })) });
      const preview = await generateStandards(actor(), input([String(row.id)]));
      expect(preview.rows[0].values.find(value => value.key === standard)?.value).toBe("");
      expect(readStandardsPlan(preview.planToken, actor()).rows[0].values).toEqual([{ key: safety, value: "GB 18401-2010 C类" }]);
    }
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(0);
  });
  it("blocks unauthorised workspaces, read-only users, locked rows, duplicate fields and requests outside the batch limit", async () => {
    const row = await style("SCOPE");
    fixture.archive = false; await expect(standardsAIStatus(actor())).rejects.toMatchObject({ status: 403 }); fixture.archive = true;
    const reader = actor(); reader.actor.permissions = ["selection.read"];
    await expect(generateStandards(reader, input([String(row.id)]))).rejects.toMatchObject({ status: 403 });
    await read("UPDATE style_selections SET migration_locked=true");
    expect((await generateStandards(actor(), input([String(row.id)]))).rows).toEqual([]);
    await expect(generateStandards(actor(), input(["1", "2", "3", "4", "5", "6"]))).rejects.toMatchObject({ status: 400 });
    await read("INSERT INTO selection_field_registry(workspace_key,field_key,owner_id,visibility,definition) VALUES('default','custom:duplicate',7,'PUBLIC',$1)", [JSON.stringify({ key: "custom:duplicate", label: "安全类别", type: "text", width: 120 })]);
    await expect(generateStandards(actor(), input([String(row.id)]))).rejects.toMatchObject({ status: 400 });
    expect(calls).toBe(0);
  });
  it("rejects cross-user, cross-table, tampered and expired previews", async () => {
    const row = await style("TOKEN"), preview = await generateStandards(actor(), input([String(row.id)]));
    const other = actor(); other.actor.id = "8";
    expect(() => readStandardsPlan(preview.planToken, other)).toThrow();
    expect(() => selectionScope.run("22", () => readStandardsPlan(preview.planToken, actor()))).toThrow();
    expect(() => readStandardsPlan(preview.planToken.replace(/^./, "x"), actor())).toThrow();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60000);
    expect(() => readStandardsPlan(preview.planToken, actor())).toThrow(); vi.restoreAllMocks();
  });
  it("rejects previously signed previews generated under the label-reference policy", async () => {
    const row = await style("OLD-POLICY"), preview = await generateStandards(actor(), input([String(row.id)]));
    const encoded = preview.planToken.split(".")[0];
    const oldSignature = createHmac("sha256", Buffer.from(process.env.COMPASS_MAIL_KEY!, "hex")).update("selection-standards-v1:" + encoded).digest("base64url");
    await expect(applyStandards(actor(), { ...applyInput(preview), planToken: encoded + "." + oldSignature })).rejects.toMatchObject({ status: 400 });
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(0);
  });
  it("blocks saving after target permissions change and respects the target length limit", async () => {
    const row = await style("GUARD"), preview = await generateStandards(actor(), input([String(row.id)]));
    await read("UPDATE selection_field_registry SET owner_id=8,visibility='PRIVATE',revision=revision+1 WHERE field_key=$1", [standard]);
    await expect(applyStandards(actor(), applyInput(preview))).rejects.toMatchObject({ status: 403 });
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(0);
    await read("UPDATE selection_field_registry SET owner_id=7,visibility='PUBLIC',definition=definition || '{\"textConfig\":{\"countMode\":\"characters\",\"maxLength\":5}}'::jsonb,revision=revision+1 WHERE field_key=$1", [standard]);
    const limited = await generateStandards(actor(), input([String(row.id)]));
    expect(limited.rows[0].values.find(value => value.key === standard)).toMatchObject({ value: "", reason: expect.stringContaining("字数上限不足") });
  });
  it("does not accept an adult standard for an explicitly out-of-scope category even if the model suggests one", async () => {
    const row = await style("CHILD");
    await read("UPDATE categories SET name='儿童外套' WHERE id=1");
    try {
      const preview = await generateStandards(actor(), input([String(row.id)]));
      expect(preview.rows[0].values.every(value => !value.value)).toBe(true);
      expect(readStandardsPlan(preview.planToken, actor()).rows).toEqual([]);
    } finally { await read("UPDATE categories SET name='女式外套' WHERE id=1"); }
  });
  it("honors upcoming replacement dates for new recommendations", () => {
    expect(standardSource("standard", "GB/T 18132-2016", Date.parse("2026-10-24"))).toBeDefined();
    expect(standardSource("standard", "GB/T 18132-2016", Date.parse("2027-08-01"))).toBeUndefined();
    expect(standardSource("standard", "GB/T 2665-2017", Date.parse("2027-08-01"))).toBeUndefined();
  });
});

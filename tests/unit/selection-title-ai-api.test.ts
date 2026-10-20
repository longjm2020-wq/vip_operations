import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { installSelectionContentCreatedTimeSchema } from "../fixtures/selection-content-created-time-schema.js";
import type { Context } from "../../apps/api/src/core.js";
import type { Row, Tx } from "../../packages/database/src/index.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";

const fixture = vi.hoisted(() => ({ database: null as PGlite | null, imageData: null as string | null,
  imageCalls: [] as string[], imageBlock: null as Promise<void> | null, exampleReads: 0 }));
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  const wrap = (database: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) => {
      if (sql.includes("WHERE id<>ALL")) fixture.exampleReads++;
      return (await database.query<Row>(sql, parameters)).rows;
    },
    $executeRawUnsafe: async (sql: string, ...parameters: unknown[]) => (await database.query(sql, parameters)).affectedRows || 0,
  }) as unknown as Tx;
  return { ...original, db: {
    $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) => (await fixture.database!.query<Row>(sql, parameters)).rows,
    $transaction: async (work: (tx: Tx) => Promise<unknown>) => fixture.database!.transaction(transaction => work(wrap(transaction))),
  } };
});
vi.mock("../../apps/api/src/modules/style-selections/archive.js", () => ({ isArchive: async () => false, mirrorArchiveRow: async () => undefined }));
vi.mock("../../apps/api/src/modules/style-selections/title-ai-images.js", () => ({ titleImageData: async (_context: unknown, url: string) => {
  fixture.imageCalls.push(url); await fixture.imageBlock; return fixture.imageData;
} }));
import { applyTitles, generateTitles, parseTitleAIResponse, readTitlePlan, titleAIStatus } from "../../apps/api/src/modules/style-selections/title-ai.js";
import { encryptSecret } from "../../apps/api/src/modules/analytics/secrets.js";

const longKey = "custom:long", shortKey = "custom:short", categoryKey = "custom:category";
const actor = (key = "titles"): Context => ({ actor: { id: "7", username: "editor", displayName: "Editor", permissions: ["selection.read", "selection.manage"], roleCodes: [] }, requestId: "titles-test", key });
const read = async (sql: string, parameters: unknown[] = []) => (await fixture.database!.query<Row>(sql, parameters)).rows;
const input = (rowIds: string[], targetKeys = [longKey, shortKey]) => ({ rowIds, targetKeys });
async function style(no: string, extraFields: Row = {}, material: string | null = "面料：100%桑蚕丝\n里料：95%聚酯纤维5%氨纶\n配料：水貂毛皮") {
  return (await read("INSERT INTO style_selections(xuti_style_no,material,extra_fields) VALUES($1,$2,$3) RETURNING *", [no, material, JSON.stringify({ [categoryKey]: "女士皮衣/皮草", ...extraFields })]))[0];
}
let providerPayload: Row, providerCalls: number;
let providerHandler: (products: Row[]) => unknown;
function installProvider() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    providerCalls++; providerPayload = JSON.parse(init.body as string);
    const data = JSON.parse(providerPayload.messages[1].content[0].text), result = providerHandler(data.products);
    return new Response(JSON.stringify({ id: "test-response", model: "openai/gpt-6.1-sol", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}
beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(`
    CREATE TABLE users(id bigint PRIMARY KEY,display_name text,username text); INSERT INTO users VALUES(7,'Editor','editor'),(8,'Other','other');
    CREATE TABLE style_selection_protection(id int PRIMARY KEY,settings jsonb,revision int DEFAULT 1);
    CREATE TABLE selection_field_registry(workspace_key text,field_key text,owner_id bigint,visibility text,definition jsonb,revision int DEFAULT 1,updated_at timestamptz DEFAULT now(),PRIMARY KEY(workspace_key,field_key));
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
  vi.stubEnv("COMPASS_MAIL_KEY", "a".repeat(64));
  providerCalls = 0; providerPayload = {}; fixture.imageData = null;
  fixture.imageCalls = []; fixture.imageBlock = null; fixture.exampleReads = 0;
  providerHandler = products => ({ rows: products.map(product => ({ id: product.id, titles: product.targets.map((target: Row) => ({ key: target.key, value: target.kind === "long" ? "【水貂毛拼接100桑蚕丝】锦纨春女式皮衣皮草女士外套穿搭单品" : "锦纨春女式皮衣" })), evidence: ["成分：主面料桑蚕丝，配料水貂毛皮"], warnings: ["款名需复核"] })) });
  await fixture.database!.exec("TRUNCATE style_selections,selection_field_registry,style_selection_protection,idempotency_records,audit_logs,compass_ai_settings RESTART IDENTITY");
  await fixture.database!.query("INSERT INTO style_selection_protection(id,settings) VALUES(1,$1)", [JSON.stringify(defaultProtection)]);
  for (const [key, label, type, textConfig] of [[longKey, "长标题", "text", { countMode: "characters", maxLength: 60 }], [shortKey, "短标题", "text", { countMode: "han", maxLength: 20 }], [categoryKey, "三级类目", "single", undefined]] as const) {
    await fixture.database!.query("INSERT INTO selection_field_registry(workspace_key,field_key,owner_id,visibility,definition) VALUES('default',$1,7,'PUBLIC',$2)", [key, JSON.stringify({ key, label, custom: true, width: 100, type, textConfig, options: label === "三级类目" ? ["女士皮衣/皮草"] : undefined })]);
  }
  await fixture.database!.query("INSERT INTO compass_ai_settings VALUES(1,true,$1,now())", [encryptSecret("mock-provider-key-never-real")]);
  installProvider();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => { await fixture.database?.close(); });

describe("server-authoritative AI product titles", () => {
  it("completes only long titles below 30 characters, preserves other cells and signs the operation", async () => {
    const completedTitle = "【水貂毛拼接100桑蚕丝】锦纨春女式皮衣皮草女士外套穿搭单品";
    const partial = await style("PARTIAL", { [longKey]: "【100桑蚕丝】女式皮衣", [shortKey]: "原有短标题" });
    const full = await style("FULL", { [longKey]: completedTitle });
    const longer = await style("LONGER", { [longKey]: completedTitle + "款" });
    const empty = await style("EMPTY");
    const preview = await generateTitles(actor(), { ...input([partial, full, longer, empty].map(row => String(row.id))), mode: "complete" });
    const products = JSON.parse(providerPayload.messages[1].content[0].text).products;
    expect(products.map((product: Row) => product.id)).toEqual([String(partial.id), String(empty.id)]);
    expect(products[0]).toMatchObject({ mode: "complete", targets: [{ key: longKey, currentValue: "【100桑蚕丝】女式皮衣", minCharacters: 30, maxCharacters: 30 }] });
    expect(readTitlePlan(preview.planToken, actor()).mode).toBe("complete");
    expect(preview.rows[0].titles).toMatchObject([{ previousValue: "【100桑蚕丝】女式皮衣", minCharacters: 30, maxCharacters: 30 }]);
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [partial.id]))[0].extra_fields[longKey]).toBe("【100桑蚕丝】女式皮衣");
    const body = { planToken: preview.planToken, rows: preview.rows.map(row => ({ id: row.id, titles: row.titles.map(({ key, value }) => ({ key, value })) })) };
    expect(await applyTitles(actor("complete"), body)).toMatchObject({ updatedCount: 2 });
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [partial.id]))[0].extra_fields).toMatchObject({ [longKey]: completedTitle, [shortKey]: "原有短标题" });
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [longer.id]))[0].extra_fields[longKey]).toBe(completedTitle + "款");
    expect(await applyTitles(actor("complete"), body)).toMatchObject({ updatedCount: 2 });
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(2);
  });
  it("improves a cell from its existing description without requiring another description field", async () => {
    const original = "秋冬新中式圆领盘扣女士背心马甲";
    const row = await style("DESCRIPTION", { [categoryKey]: "", [longKey]: original }, null);
    const empty = await style("EMPTY", { [categoryKey]: "" }, null);
    const improved = "【盘扣设计】秋冬新中式国风圆领女士背心马甲日常通勤外搭服饰";
    providerHandler = products => ({ rows: products.map(product => ({ id: product.id, titles: [{ key: longKey, value: improved }], evidence: ["本格原文的季节与设计描述"], warnings: [] })) });
    const preview = await generateTitles(actor(), { ...input([String(row.id), String(empty.id)], [longKey]), mode: "improve" });
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0].titles[0]).toMatchObject({ previousValue: original, value: improved });
    expect(JSON.parse(providerPayload.messages[1].content[0].text).products[0].targets[0].currentValue).toBe(original);
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [row.id]))[0].extra_fields[longKey]).toBe(original);
    await applyTitles(actor(), { planToken: preview.planToken, rows: [{ id: String(row.id), titles: [{ key: longKey, value: improved }] }] });
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [row.id]))[0].extra_fields[longKey]).toBe(improved);
  });
  it.each(["complete", "improve"] as const)("rejects concurrent edits in %s mode even when the timestamp is unchanged, without partial writes", async mode => {
    const first = await style("FIRST", { [longKey]: "原文甲" }), second = await style("SECOND", { [longKey]: "原文乙" });
    const preview = await generateTitles(actor(), { ...input([String(first.id), String(second.id)], [longKey]), mode });
    await fixture.database!.query("UPDATE style_selections SET extra_fields=extra_fields || $2::jsonb WHERE id=$1", [second.id, JSON.stringify({ [longKey]: "同事已修改原文" })]);
    await expect(applyTitles(actor(), { planToken: preview.planToken, rows: preview.rows.map(row => ({ id: row.id, titles: row.titles.map(({ key, value }) => ({ key, value })) })) })).rejects.toMatchObject({ status: 409 });
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [first.id]))[0].extra_fields[longKey]).toBe("原文甲");
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [second.id]))[0].extra_fields[longKey]).toBe("同事已修改原文");
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(0);
  });
  it.each(["complete", "improve"] as const)("keeps field visibility and edit protection authoritative in %s mode", async mode => {
    const row = await style("TARGET", { [longKey]: "已有描述" });
    await fixture.database!.query("UPDATE style_selections SET migration_locked=true WHERE id=$1", [row.id]);
    expect((await generateTitles(actor(), { ...input([String(row.id)], [longKey]), mode })).rows).toEqual([]);
    expect(providerCalls).toBe(0);
    await fixture.database!.query("UPDATE style_selections SET migration_locked=false WHERE id=$1", [row.id]);
    const preview = await generateTitles(actor(), { ...input([String(row.id)], [longKey]), mode });
    await fixture.database!.query("UPDATE selection_field_registry SET owner_id=8,visibility='PRIVATE',revision=revision+1 WHERE field_key=$1", [longKey]);
    await expect(applyTitles(actor(), { planToken: preview.planToken, rows: [{ id: String(row.id), titles: [{ key: longKey, value: preview.rows[0].titles[0].value }] }] })).rejects.toMatchObject({ status: 403 });
    await expect(generateTitles(actor(), { ...input([String(row.id)], [longKey]), mode })).rejects.toMatchObject({ status: 403 });
    expect(providerCalls).toBe(1);
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [row.id]))[0].extra_fields[longKey]).toBe("已有描述");
  });
  it("enforces exactly 30 characters in completion previews and edited results without expanding field limits", async () => {
    const row = await style("TARGET", { [longKey]: "已有长标题" });
    const preview = await generateTitles(actor(), { ...input([String(row.id)], [longKey]), mode: "complete" });
    const valid = preview.rows[0].titles[0].value;
    for (const value of [valid.slice(0, -1), valid + "款"]) {
      await expect(applyTitles(actor(), { planToken: preview.planToken, rows: [{ id: String(row.id), titles: [{ key: longKey, value }] }] })).rejects.toMatchObject({ status: 400 });
    }
    providerHandler = products => ({ rows: products.map(product => ({ id: product.id, titles: [{ key: longKey, value: valid.slice(0, -1) }], evidence: [], warnings: [] })) });
    await expect(generateTitles(actor(), { ...input([String(row.id)], [longKey]), mode: "complete" })).rejects.toMatchObject({ status: 502 });
    await fixture.database!.query("UPDATE selection_field_registry SET definition=jsonb_set(definition,'{textConfig,maxLength}','29') WHERE field_key=$1", [longKey]);
    const calls = providerCalls;
    await expect(generateTitles(actor(), { ...input([String(row.id)], [longKey]), mode: "complete" })).rejects.toMatchObject({ status: 400, response: { error: { code: "AI_TITLE_LIMIT" } } });
    expect(providerCalls).toBe(calls);
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [row.id]))[0].extra_fields[longKey]).toBe("已有长标题");
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(0);
  });
  it("cannot upgrade a blank-only signed preview or inject an unpreviewed existing field", async () => {
    const row = await style("TARGET", { [longKey]: "已有长标题" });
    const preview = await generateTitles(actor(), input([String(row.id)]));
    await expect(applyTitles(actor(), { planToken: preview.planToken, rows: [{ id: String(row.id), titles: [{ key: longKey, value: "应拒绝" }] }] })).rejects.toMatchObject({ status: 403 });
    const [encoded, signature] = preview.planToken.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(encoded, "base64url").toString()), mode: "improve" })).toString("base64url") + "." + signature;
    expect(() => readTitlePlan(forged, actor())).toThrow();
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [row.id]))[0].extra_fields[longKey]).toBe("已有长标题");
  });
  it("omits color, composition tags, ordinary synthetics and partial ratios on generation and edited application", async () => {
    const row = await style("RULES", {}, "面料：96.8%山羊绒3.2%桑蚕丝\n里料：100%聚酯纤维");
    const ordinary = providerHandler;
    providerHandler = products => ({ rows: products.map(product => ({ id: product.id, titles: product.targets.map((target: Row) => ({ key: target.key,
      value: target.kind === "long" ? "【含山羊绒桑蚕丝】庭春漾女式皮草外套日常通勤简约风穿搭单品" : "庭春漾女式皮衣" })), evidence: ["成分：贵重主材质，未把里料写入标题"], warnings: [] })) });
    const preview = await generateTitles(actor(), input([String(row.id)]));
    expect(JSON.stringify(providerPayload)).toContain("96.8%山羊绒3.2%桑蚕丝");
    expect(JSON.stringify(providerPayload)).toContain("100%聚酯纤维");
    for (const value of ["暖橙女式皮衣", "庭春漾面料皮衣", "庭春漾96.8山羊绒", "庭春漾聚酯纤维皮衣"]) {
      await expect(applyTitles(actor(), { planToken: preview.planToken, rows: [{ id: String(row.id), titles: [{ key: shortKey, value }] }] })).rejects.toMatchObject({ status: 400 });
      providerHandler = products => ({ rows: products.map(product => ({ id: product.id, titles: [{ key: shortKey, value }], evidence: ["本款资料"], warnings: [] })) });
      await expect(generateTitles(actor(), input([String(row.id)], [shortKey]))).rejects.toMatchObject({ status: 502 });
    }
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(0);
    await applyTitles(actor(), { planToken: preview.planToken, rows: preview.rows.map(candidate => ({ id: candidate.id, titles: candidate.titles.map(({ key, value }) => ({ key, value })) })) });
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [row.id]))[0].extra_fields[longKey]).toContain("含山羊绒桑蚕丝");
    providerHandler = ordinary;
  });

  it("loads examples while images are pending and reads each repeated authorized URL only once per batch", async () => {
    fixture.imageData = "data:image/jpeg;base64,AA==";
    const first = await style("FIRST"), second = await style("SECOND");
    await style("OLD", { [longKey]: "【桑蚕丝】暖橙面料旧标题", [shortKey]: "旧款名马夹" });
    const urls = ["https://a.vpimg2.com/upload/first.jpg", "https://a.vpimg2.com/upload/second.jpg"];
    await fixture.database!.query("UPDATE style_selections SET images=$1::jsonb WHERE id=ANY($2::bigint[])", [JSON.stringify([{ url: urls[0] }, { url: urls[0] }, { url: urls[1] }]), [first.id, second.id]]);
    let release!: () => void;
    fixture.imageBlock = new Promise<void>(resolve => { release = resolve; });
    const pending = generateTitles(actor(), input([String(first.id), String(second.id)]));
    try {
      await vi.waitFor(() => { expect(fixture.exampleReads).toBe(1); expect(fixture.imageCalls).toEqual([urls[0]]); });
      expect(providerCalls).toBe(0);
    } finally { release(); }
    const preview = await pending;
    expect(preview.rows).toHaveLength(2);
    expect(fixture.imageCalls).toEqual(urls);
    expect(providerCalls).toBe(1);
    expect(providerPayload.model).toBe("openai/gpt-6.1-sol");
    expect(providerPayload.max_tokens).toBe(8000);
    expect(providerPayload.reasoning).toEqual({ effort: "low" });
    expect(providerPayload.messages[1].content.filter((value: Row) => value.type === "image_url")).toHaveLength(4);
    expect(providerPayload.messages[1].content[0].text).toContain("旧款名马夹");
    expect(providerPayload.messages[1].content[0].text).not.toContain("暖橙面料旧标题");
  });

  it("reserves the existing per-user slot before settings await so simultaneous requests cannot double-call the model", async () => {
    const row = await style("CONCURRENT");
    const first = generateTitles(actor(), input([String(row.id)]));
    const second = generateTitles(actor(), input([String(row.id)]));
    await expect(second).rejects.toMatchObject({ status: 429, response: { error: { code: "AI_BUSY" } } });
    await first;
    expect(providerCalls).toBe(1);
    // A finished request always releases the slot for an explicit later retry.
    await generateTitles(actor(), input([String(row.id)]));
    expect(providerCalls).toBe(2);
  });
  it("learns only permitted examples, preserves slash labels, and fills only existing blank targets", async () => {
    await style("EXAMPLE", { [longKey]: "【桑蚕丝】旧款标题", [shortKey]: "旧款名马夹" });
    const current = await style("TARGET", { [longKey]: "已有长标题" });
    const preview = await generateTitles(actor(), input([String(current.id)]));
    expect(preview.rows[0].titles).toMatchObject([{ key: shortKey, maxLength: 20, countMode: "han" }]);
    expect(providerPayload.messages[1].content[0].text).toContain("女士皮衣/皮草");
    expect(providerPayload.messages[1].content[0].text).toContain("旧款名马夹");
    expect(providerPayload.messages[1].content[0].text).not.toContain("mock-provider-key");
    const result = await applyTitles(actor(), { planToken: preview.planToken, rows: preview.rows.map(row => ({ id: row.id, titles: row.titles.map(({ key, value }) => ({ key, value })) })) });
    expect(result.updatedCount).toBe(1);
    const saved = (await read("SELECT extra_fields FROM style_selections WHERE id=$1", [current.id]))[0].extra_fields;
    expect(saved[longKey]).toBe("已有长标题"); expect(saved[shortKey]).toBe("锦纨春女式皮衣");
  });
  it("makes no paid model call if every target is already filled", async () => {
    const row = await style("FILLED", { [longKey]: "已有长标题", [shortKey]: "已有短标题" });
    expect((await generateTitles(actor(), input([String(row.id)]))).rows).toEqual([]);
    expect(providerCalls).toBe(0);
  });
  it("sends the long-title character minimum to the model and returns it in each candidate", async () => {
    const row = await style("TARGET"), preview = await generateTitles(actor(), input([String(row.id)]));
    const request = JSON.parse(providerPayload.messages[1].content[0].text);
    expect(request.products[0].targets).toMatchObject([{ kind: "long", minCharacters: 29 }, { kind: "short", minCharacters: 1 }]);
    expect(preview.rows[0].titles).toMatchObject([{ kind: "long", minCharacters: 29 }, { kind: "short", minCharacters: 1 }]);
  });
  it("refuses incompatible blank long-title limits before a paid request while preserving filled long titles", async () => {
    await fixture.database!.query("UPDATE selection_field_registry SET definition=jsonb_set(definition,'{textConfig,maxLength}','28'::jsonb) WHERE field_key=$1", [longKey]);
    const blank = await style("BLANK");
    await expect(generateTitles(actor(), input([String(blank.id)]))).rejects.toMatchObject({ status: 400, response: { error: { code: "AI_TITLE_LIMIT", message: expect.stringContaining("字段管理") } } });
    expect(providerCalls).toBe(0);
    expect((await generateTitles(actor(), input([String(blank.id)], [shortKey]))).rows[0].titles).toMatchObject([{ key: shortKey }]);
    const filled = await style("FILLED", { [longKey]: "已有长标题" });
    expect((await generateTitles(actor(), input([String(filled.id)]))).rows[0].titles).toMatchObject([{ key: shortKey }]);
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [filled.id]))[0].extra_fields[longKey]).toBe("已有长标题");
  });
  it("rejects short AI long titles during generation and edited application without writing cells", async () => {
    const row = await style("TARGET"), ordinary = providerHandler;
    providerHandler = products => ({ rows: products.map(product => ({ id: product.id, titles: [{ key: longKey, value: "【水貂毛拼接100桑蚕丝】锦纨春女式皮衣" }], evidence: ["本款成分及类目"], warnings: [] })) });
    await expect(generateTitles(actor(), input([String(row.id)], [longKey]))).rejects.toMatchObject({ status: 502, response: { error: { message: expect.stringContaining("至少需要29个字符") } } });
    providerHandler = ordinary;
    const preview = await generateTitles(actor(), input([String(row.id)]));
    await expect(applyTitles(actor(), { planToken: preview.planToken, rows: [{ id: String(row.id), titles: [{ key: longKey, value: "【水貂毛拼接100桑蚕丝】锦纨春女式皮衣" }] }] })).rejects.toMatchObject({ status: 400, response: { error: { message: expect.stringContaining("至少需要29个字符") } } });
    const saved = (await read("SELECT extra_fields FROM style_selections WHERE id=$1", [row.id]))[0].extra_fields;
    expect(saved[longKey]).toBeUndefined(); expect(saved[shortKey]).toBeUndefined();
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(0);
  });
  it("accepts visually grounded seasons without assuming material claims from the photograph", async () => {
    fixture.imageData = "data:image/jpeg;base64,AA==";
    const row = await style("VISUAL");
    await fixture.database!.query("UPDATE style_selections SET images=$2 WHERE id=$1", [row.id, JSON.stringify([{ url: "https://a.vpimg2.com/upload/visual.jpg" }])]);
    providerHandler = products => ({ rows: products.map(product => ({ id: product.id, titles: [{ key: longKey,
      value: "【水貂毛拼接100桑蚕丝】锦纨春秋冬新中式圆领盘扣女式皮衣外搭" }], evidence: ["本款文字成分；图片可见圆领盘扣及秋冬外搭结构"], warnings: [] })) });
    const preview = await generateTitles(actor(), input([String(row.id)], [longKey]));
    expect(preview.rows[0].titles[0].value).toContain("秋冬");
    expect(preview.rows[0].warnings).not.toContain("未使用商品图片，仅依据可查看的文字资料生成");
    await expect(applyTitles(actor(), { planToken: preview.planToken, rows: [{ id: String(row.id), titles: [{ key: longKey,
      value: "【非遗手工100桑蚕丝】锦纨春秋冬新中式圆领盘扣女式皮衣外搭" }] }] })).rejects.toMatchObject({ status: 400 });
  });
  it("skips rows without visible product facts", async () => {
    const row = await style("EMPTY", { [categoryKey]: "" }, null);
    const preview = await generateTitles(actor(), input([String(row.id)]));
    expect(preview.rows).toEqual([]); expect(providerCalls).toBe(0);
  });
  it("never sends private category values or private example titles to the provider", async () => {
    await fixture.database!.query("UPDATE selection_field_registry SET owner_id=8,visibility='PRIVATE' WHERE field_key=$1", [categoryKey]);
    await style("EXAMPLE", { [categoryKey]: "隐私类目", [longKey]: "【桑蚕丝】可见标题" });
    const row = await style("TARGET", { [categoryKey]: "秘密类别" });
    await generateTitles(actor(), input([String(row.id)]));
    const payload = JSON.stringify(providerPayload); expect(payload).not.toContain("隐私类目"); expect(payload).not.toContain("秘密类别"); expect(payload).not.toContain("custom:category");
  });
  it("rejects private or nontext targets before calling the model", async () => {
    const row = await style("TARGET");
    await fixture.database!.query("UPDATE selection_field_registry SET owner_id=8,visibility='PRIVATE' WHERE field_key=$1", [longKey]);
    await expect(generateTitles(actor(), input([String(row.id)], [longKey]))).rejects.toMatchObject({ status: 403 });
    expect(providerCalls).toBe(0);
  });
  it("omits protected composition and private title examples from the paid request", async () => {
    await fixture.database!.query("UPDATE style_selection_protection SET settings=$1,revision=revision+1", [JSON.stringify({ ...defaultProtection, enabled: true, regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "成分保护", scope: "columns", rowIds: [], columnKeys: ["material"], users: {}, others: "deny" }] })]);
    await fixture.database!.query("UPDATE selection_field_registry SET owner_id=8,visibility='PRIVATE' WHERE field_key=$1", [shortKey]);
    await style("EXAMPLE", { [shortKey]: "秘密标题不可发送" });
    const row = await style("TARGET", { [shortKey]: "本款秘密短标题" });
    providerHandler = products => ({ rows: products.map(product => ({ id: product.id, titles: [{ key: longKey, value: "【女式皮衣】春影女式皮衣皮草女士外套上衣搭配穿搭单品服饰系列" }], evidence: ["三级类目"], warnings: ["成分不可查看，未使用材质卖点"] })) });
    await generateTitles(actor(), input([String(row.id)], [longKey]));
    const payload = JSON.stringify(providerPayload);
    expect(payload).not.toContain("秘密标题不可发送"); expect(payload).not.toContain("本款秘密短标题");
    expect(payload).not.toContain("95%聚酯纤维"); expect(payload).not.toContain("配料：水貂毛皮");
  });
  it("does not ask the model to fill read-only or migration-locked target rows", async () => {
    const row = await style("TARGET");
    await fixture.database!.query("UPDATE style_selections SET migration_locked=true WHERE id=$1", [row.id]);
    expect((await generateTitles(actor(), input([String(row.id)]))).rows).toEqual([]);
    expect(providerCalls).toBe(0);
  });
  it("does not generate a saved row without a readable style number", async () => {
    const row = await style("");
    expect((await generateTitles(actor(), input([String(row.id)]))).rows).toEqual([]);
    expect(providerCalls).toBe(0);
  });
  it("rolls back the entire fill when another user fills one target after preview", async () => {
    const first = await style("A"), second = await style("B");
    const preview = await generateTitles(actor(), input([String(first.id), String(second.id)]));
    await fixture.database!.query("UPDATE style_selections SET extra_fields=extra_fields || $2::jsonb,updated_at=now() WHERE id=$1", [second.id, JSON.stringify({ [shortKey]: "他人已写入" })]);
    await expect(applyTitles(actor(), { planToken: preview.planToken, rows: preview.rows.map(row => ({ id: row.id, titles: row.titles.map(({ key, value }) => ({ key, value })) })) })).rejects.toMatchObject({ status: 409 });
    const untouched = (await read("SELECT extra_fields FROM style_selections WHERE id=$1", [first.id]))[0].extra_fields;
    expect(untouched[longKey]).toBeUndefined(); expect(untouched[shortKey]).toBeUndefined();
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(0);
  });
  it("rejects revoked field permissions without writing any title", async () => {
    const row = await style("TARGET"), preview = await generateTitles(actor(), input([String(row.id)]));
    await fixture.database!.query("UPDATE selection_field_registry SET owner_id=8,visibility='PRIVATE',revision=revision+1 WHERE field_key=$1", [longKey]);
    await expect(applyTitles(actor(), { planToken: preview.planToken, rows: preview.rows.map(row => ({ id: row.id, titles: row.titles.map(({ key, value }) => ({ key, value })) })) })).rejects.toMatchObject({ status: 403 });
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [row.id]))[0].extra_fields[shortKey]).toBeUndefined();
  });
  it("rejects signed preview replay by another actor, table or forged signature", async () => {
    const row = await style("TARGET"), preview = await generateTitles(actor(), input([String(row.id)]));
    expect(() => readTitlePlan(preview.planToken, { ...actor(), actor: { ...actor().actor, id: "8" } })).toThrow();
    expect(() => selectionScope.run("23", () => readTitlePlan(preview.planToken, actor()))).toThrow();
    expect(() => readTitlePlan(preview.planToken.slice(0, -4) + "xxxx", actor())).toThrow();
  });
  it("rejects unsupported edited claims and respects the field limit on apply", async () => {
    const row = await style("TARGET"), preview = await generateTitles(actor(), input([String(row.id)]));
    await expect(applyTitles(actor(), { planToken: preview.planToken, rows: [{ id: String(row.id), titles: [{ key: longKey, value: "【非遗手工桑蚕丝】锦纨春马甲" }] }] })).rejects.toMatchObject({ status: 400 });
    await expect(applyTitles(actor(), { planToken: preview.planToken, rows: [{ id: String(row.id), titles: [{ key: shortKey, value: "马".repeat(21) }] }] })).rejects.toMatchObject({ status: 400 });
  });
  it("rejects visually unverified design claims from a text-only AI result", async () => {
    const row = await style("TARGET");
    providerHandler = products => ({ rows: products.map(product => ({ id: product.id, titles: [{ key: longKey, value: "【水貂毛拼接100桑蚕丝】锦纨春圆领盘扣马甲" }], evidence: ["主面料及配料"], warnings: [] })) });
    await expect(generateTitles(actor(), input([String(row.id)], [longKey]))).rejects.toMatchObject({ status: 502 });
    expect((await read("SELECT extra_fields FROM style_selections WHERE id=$1", [row.id]))[0].extra_fields[longKey]).toBeUndefined();
  });
  it("replays an applied idempotency key as safe identifiers without rerevealing revoked title fields", async () => {
    const row = await style("TARGET"), preview = await generateTitles(actor(), input([String(row.id)]));
    const body = { planToken: preview.planToken, rows: preview.rows.map(row => ({ id: row.id, titles: row.titles.map(({ key, value }) => ({ key, value })) })) };
    const first = await applyTitles(actor("safe-replay"), body);
    await fixture.database!.query("UPDATE selection_field_registry SET owner_id=8,visibility='PRIVATE',revision=revision+1 WHERE field_key=$1", [longKey]);
    expect(await applyTitles(actor("safe-replay"), body)).toEqual(first);
    expect(first).toEqual({ updatedCount: 1, ids: [String(row.id)] });
    expect(await read("SELECT * FROM audit_logs")).toHaveLength(1);
  });
  it("rejects changed source facts during model generation", async () => {
    const row = await style("TARGET");
    const ordinary = providerHandler;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const data = JSON.parse(JSON.parse(init.body as string).messages[1].content[0].text);
      await fixture.database!.query("UPDATE style_selections SET material='面料：100%棉',updated_at=now() WHERE id=$1", [row.id]);
      return new Response(JSON.stringify({ id: "test", model: "openai/gpt-6.1-sol", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(ordinary(data.products)) } }] }));
    }));
    await expect(generateTitles(actor(), input([String(row.id)]))).rejects.toMatchObject({ status: 409 });
  });
  it("returns only coarse readiness and does not reveal configuration secrets", async () => {
    expect(await titleAIStatus(actor())).toEqual({ ready: true, message: "AI 商品标题已就绪" });
    await fixture.database!.query("UPDATE compass_ai_settings SET verified_at=NULL");
    expect(await titleAIStatus(actor())).toEqual({ ready: false, message: expect.any(String) });
  });
  it("rejects missing, duplicate or unrequested model outputs", () => {
    const expected = [{ id: "1", keys: [longKey] }], valid = { id: "1", titles: [{ key: longKey, value: "【盘扣】马甲" }], evidence: [], warnings: [] };
    expect(() => parseTitleAIResponse({ rows: [] }, expected)).toThrow();
    expect(() => parseTitleAIResponse({ rows: [valid, valid] }, expected)).toThrow();
    expect(() => parseTitleAIResponse({ rows: [{ ...valid, titles: [{ key: shortKey, value: "马甲" }] }] }, expected)).toThrow();
  });
});

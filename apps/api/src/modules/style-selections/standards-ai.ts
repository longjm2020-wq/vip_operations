import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db, one, rows, type Row, type Tx } from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import { selectionFieldSchema, type SelectionField } from "../../../../../packages/contracts/src/selection-layout.js";
import { fieldTextLengthError, splitChoiceValues } from "../../../../../packages/contracts/src/selection-field-validation.js";
import { selectionStandardsAIApplySchema, selectionStandardsAIGenerateSchema, selectionStandardsAIModeSchema, standardsFieldKind, standardsTargetEligible, type SelectionStandardsAIPreview } from "../../../../../packages/contracts/src/selection-standards-ai.js";
import { command, fail, parse, requirePermission, type Context } from "../../core.js";
import { COMPASS_AI_ENDPOINT, COMPASS_AI_MODEL } from "../analytics/ai.js";
import { decryptSecret, encryptionReady } from "../analytics/secrets.js";
import * as protection from "./protection.js";
import { isArchive } from "./archive.js";
import { persist } from "./service.js";
import { titleImageData } from "./title-ai-images.js";
import { availableProductStandards, safetyStandard, standardSource, standardsCatalogCheckedAt, standardsSystemPrompt } from "./standards-ai-catalog.js";

const scopeKey = () => selectionScope.getStore() || "default";
const cell = (row: Row, key: string) => key.startsWith("custom:") ? row.extraFields?.[key] : row[key];
const active = new Set<string>();
const ready = (settings?: Row) => encryptionReady() && !!settings?.enabled && !!settings.api_key_encrypted && !!settings.verified_at;
async function requireArchive(c: Context) {
  requirePermission(c.actor, "selection.manage");
  if (!await db.$transaction(tx => isArchive(tx))) fail("FORBIDDEN", "请在商品档案中使用 AI 安全类别与执行标准适配", 403);
}
export async function standardsAIStatus(c: Context) {
  await requireArchive(c);
  const settings = await one(db, "SELECT enabled,api_key_encrypted,verified_at FROM public.compass_ai_settings WHERE id=1");
  return { ready: ready(settings), message: ready(settings) ? "AI 适配已就绪" : "请超级管理员在系统设置 → AI 模型设置中启用并验证模型后使用" };
}
const descriptorLabels = /^(?:三级类目|三级分类|品类|商品类目|成分|材质|材质成分|面料|主面料|里料|填充物|配料|长标题|短标题|商品名称|适用年龄|适用人群|穿着方式|织造方式|工艺|产品卖点|商品卖点)$/u;
type Fact = { key: string; label: string; value: string };
type Source = { facts: Fact[]; pictures: { url: string }[] };
function imageList(value: unknown): Row[] {
  if (Array.isArray(value)) return value.filter(item => item && typeof item === "object");
  if (typeof value === "string") { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? imageList(parsed) : []; } catch { /* Not an image cell. */ } }
  return [];
}
export function standardsSource(row: Row, fields: SelectionField[]): Source {
  const facts: Fact[] = [], pictures: Source["pictures"] = [];
  if (String(row.material || "").trim()) facts.push({ key: "material", label: "成分", value: String(row.material).slice(0, 4000) });
  const addPictures = (value: unknown) => {
    for (const image of imageList(value)) if (typeof image.url === "string" && image.url && !pictures.some(item => item.url === image.url)) pictures.push({ url: image.url });
  };
  addPictures(row.images);
  for (const field of fields) {
    if (field.deleted || row.cellAccess?.[field.key] === "deny" || field.key === "material" || field.key === "labelImages") continue;
    const value = cell(row, field.key), type = field.type || field.fallbackType || "text";
    if (type === "image" && /^(?:图片|商品图片)$/u.test(field.label)) {
      addPictures(value); continue;
    }
    if (!["text", "tags", "single", "multiple"].includes(type) || !descriptorLabels.test(field.label) || !String(value ?? "").trim()) continue;
    facts.push({ key: field.key, label: field.label, value: (type === "single" || type === "multiple" ? splitChoiceValues(field, value).join("、") : String(value)).slice(0, 4000) });
  }
  return { facts, pictures };
}
const policyFingerprint = (policy: protection.Policy, c: Context) => protection.digest([policy.settings, policy.revision, policy.fieldRevision, c.actor.id, c.actor.permissions, c.actor.roleCodes]);
async function snapshot(c: Context, ids: string[], targetKeys: string[], tx?: Tx, lock = false) {
  const read = async (connection: Tx) => {
    const policy = lock ? await protection.writeLocks(connection, c) : await protection.policy(connection);
    const fields = (await rows(connection, "SELECT definition FROM public.selection_field_registry WHERE workspace_key=$1 ORDER BY field_key", scopeKey()))
      .flatMap(row => { const result = selectionFieldSchema.safeParse(row.definition); return result.success ? [result.data] : []; });
    const targets = targetKeys.map(key => {
      const field = fields.find(item => item.key === key);
      if (!field || field.deleted || !standardsFieldKind(field.label) || (field.type || field.fallbackType || "text") !== "text" || !protection.fieldVisible(policy, c.actor, key))
        fail("AI_STANDARD_FIELD", "请选择可查看、可编辑的安全类别或执行标准文本字段", 403);
      if (fields.filter(other => !other.deleted && other.label === field.label && protection.fieldVisible(policy, c.actor, other.key)).length !== 1)
        fail("AI_STANDARD_FIELD", "存在同名安全类别或执行标准字段，请先在字段管理中区分", 400);
      return field;
    });
    const raw = await rows(connection, "SELECT * FROM style_selections WHERE id=ANY($1::bigint[]) ORDER BY id" + (lock ? " FOR UPDATE" : ""), ids);
    if (raw.length !== ids.length) fail("AI_SOURCE_CHANGED", "选中记录已删除或不存在，请刷新后重试", 409);
    const projected = raw.map(row => protection.project(policy, c.actor, row));
    const categoryKey = "custom:product:categoryId";
    const categoryIds = [...new Set(projected.map(row => cell(row, categoryKey)).filter(value => /^[1-9]\d{0,18}$/u.test(String(value || ""))))];
    if (categoryIds.length) {
      const categories = new Map((await rows(connection, "SELECT id,name FROM public.categories WHERE id=ANY($1::bigint[])", categoryIds)).map(row => [String(row.id), row.name]));
      for (const row of projected) if (cell(row, categoryKey)) row.extraFields = { ...row.extraFields, [categoryKey]: categories.get(String(cell(row, categoryKey))) || "" };
    }
    return { policy, fields, targets, raw, projected, digest: policyFingerprint(policy, c) };
  };
  return tx ? read(tx) : db.$transaction(read, { isolationLevel: "RepeatableRead" });
}
const fingerprint = (row: Row, fields: SelectionField[]) => protection.digest([row.updatedAt, row.xutiStyleNo, standardsSource(row, fields),
  fields.filter(field => standardsFieldKind(field.label)).map(field => [field.key, cell(row, field.key)])]);
const signedRowSchema = z.object({ id: z.string(), expectedUpdatedAt: z.string(), fingerprint: z.string(), values: z.array(z.object({ key: z.string(), value: z.string() }).strict()).max(2) }).strict();
const planSchema = z.object({ actor: z.string(), scope: z.string(), mode: selectionStandardsAIModeSchema, expires: z.number(), nonce: z.string().uuid(), policy: z.string(), catalog: z.string(), rows: z.array(signedRowSchema).max(5) }).strict();
type Plan = z.infer<typeof planSchema>;
function mac(encoded: string) {
  if (!encryptionReady()) fail("AI_NOT_READY", "请先配置 AI 凭据加密", 503);
  // Invalidate previews generated by the previous policy, which accepted label images.
  return createHmac("sha256", Buffer.from(process.env.COMPASS_MAIL_KEY!, "hex")).update("selection-standards-v2:" + encoded).digest();
}
function signPlan(plan: Plan) { const encoded = Buffer.from(JSON.stringify(plan)).toString("base64url"); return encoded + "." + mac(encoded).toString("base64url"); }
export function readStandardsPlan(token: string, c: Context) {
  const [encoded, signature, extra] = token.split(".");
  if (extra !== undefined || !/^[A-Za-z0-9_-]+$/u.test(encoded || "") || !/^[A-Za-z0-9_-]{43}$/u.test(signature || "") || !timingSafeEqual(mac(encoded), Buffer.from(signature, "base64url")))
    fail("AI_PLAN_INVALID", "适配预览无效，请重新生成", 400);
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { fail("AI_PLAN_INVALID", "适配预览无效，请重新生成", 400); }
  const result = planSchema.safeParse(parsed);
  if (!result.success || result.data.actor !== c.actor.id || result.data.scope !== scopeKey()) fail("AI_PLAN_INVALID", "适配预览不属于当前用户或表格", 403);
  if (result.data.expires <= Date.now() || result.data.expires > Date.now() + 31 * 60000 || result.data.catalog !== standardsCatalogCheckedAt)
    fail("AI_PLAN_EXPIRED", "适配预览已过期或标准目录已更新，请重新生成", 409);
  return result.data;
}
const responseSchema = z.object({ rows: z.array(z.object({
  id: z.string(), values: z.array(z.object({ key: z.string(), value: z.string().trim().max(100), reason: z.string().trim().min(1).max(600), evidence: z.array(z.string().max(100)).max(10) }).strict()).max(2),
  warnings: z.array(z.string().max(600)).max(6),
}).strict()).max(5) }).strict();
async function callModel(settings: Row, products: Row[]) {
  const content: Row[] = [{ type: "text", text: JSON.stringify({ catalog: availableProductStandards(), catalogCheckedAt: standardsCatalogCheckedAt,
    safetyValues: ["A", "B", "C"].map(value => safetyStandard.code + " " + value + "类"), products: products.map(({ pictures, ...product }) => ({ ...product, imageInputs: pictures.map((image: Row) => image.id) })) }) }];
  for (const product of products) for (const image of product.pictures) content.push({ type: "text", text: `本款ID ${product.id}，图片依据 ${image.id}（商品图）` }, { type: "image_url", image_url: { url: image.data, detail: "high" } });
  const response = await fetch(COMPASS_AI_ENDPOINT, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(90000),
    headers: { Authorization: "Bearer " + decryptSecret(settings.api_key_encrypted), "Content-Type": "application/json" },
    body: JSON.stringify({ model: COMPASS_AI_MODEL, stream: false, max_tokens: 7000, reasoning: { effort: "low" }, provider: { require_parameters: true, data_collection: "deny" },
      messages: [{ role: "system", content: standardsSystemPrompt }, { role: "user", content }],
      response_format: { type: "json_schema", json_schema: { name: "product_standards", strict: true, schema: {
        type: "object", additionalProperties: false, required: ["rows"], properties: { rows: { type: "array", items: {
          type: "object", additionalProperties: false, required: ["id", "values", "warnings"], properties: {
            id: { type: "string" }, warnings: { type: "array", items: { type: "string" } }, values: { type: "array", items: {
              type: "object", additionalProperties: false, required: ["key", "value", "reason", "evidence"], properties: {
                key: { type: "string" }, value: { type: "string" }, reason: { type: "string" }, evidence: { type: "array", items: { type: "string" } },
              },
            } },
          },
        } } },
      } } },
    }),
  });
  if (!response.ok) { await response.body?.cancel(); fail("AI_PROVIDER_ERROR", response.status === 402 ? "AI 余额不足，请联系管理员" : response.status === 429 ? "AI 请求过于频繁，请稍后重试" : "AI 服务暂不可用，请检查模型设置后重试", 502); }
  const text = await response.text();
  if (text.length > 200000) fail("AI_RESPONSE_INVALID", "AI 返回内容过大，未采用此结果", 502);
  let payload: Row;
  try { payload = JSON.parse(text); } catch { fail("AI_RESPONSE_INVALID", "AI 返回格式错误", 502); }
  const choice = payload.choices?.[0];
  if (payload.model !== COMPASS_AI_MODEL || !payload.id || choice?.finish_reason !== "stop" || choice?.message?.refusal || typeof choice?.message?.content !== "string") fail("AI_RESPONSE_INVALID", "AI 返回不完整，未采用此结果", 502);
  let result: unknown;
  try { result = JSON.parse(choice.message.content); } catch { fail("AI_RESPONSE_INVALID", "AI 适配格式错误", 502); }
  const parsed = responseSchema.safeParse(result);
  if (!parsed.success || parsed.data.rows.length !== products.length || new Set(parsed.data.rows.map(row => row.id)).size !== products.length) fail("AI_RESPONSE_INVALID", "AI 返回款式不完整或重复", 502);
  for (const row of parsed.data.rows) {
    const product = products.find(product => product.id === row.id);
    if (!product || row.values.length !== product.targets.length || new Set(row.values.map(value => value.key)).size !== row.values.length || row.values.some(value => !product.targets.some((target: Row) => target.key === value.key)))
      fail("AI_RESPONSE_INVALID", "AI 返回了未请求、重复或缺失的字段", 502);
  }
  return parsed.data.rows;
}

export async function generateStandards(c: Context, input: unknown): Promise<SelectionStandardsAIPreview> {
  await requireArchive(c);
  const body = parse(selectionStandardsAIGenerateSchema, input), caller = `${c.actor.id}:${scopeKey()}`;
  if (active.has(caller) || active.size >= 2) fail("AI_BUSY", "AI 适配正在生成，请稍后重试", 429);
  active.add(caller);
  try {
    const settings = await one(db, "SELECT enabled,api_key_encrypted,verified_at FROM public.compass_ai_settings WHERE id=1");
    if (!ready(settings)) fail("AI_NOT_READY", "请超级管理员先启用并验证 AI 模型", 503);
    const initial = await snapshot(c, body.rowIds, body.targetKeys), products: Row[] = [];
    for (const row of initial.projected) {
      const raw = initial.raw.find(value => String(value.id) === String(row.id))!;
      if (!String(row.xutiStyleNo || "").trim()) continue;
      const targets = initial.targets.filter(field => standardsTargetEligible(body.mode, cell(row, field.key)) && protection.access(initial.policy, c.actor, raw, field.key) === "edit");
      if (targets.length) products.push({ id: String(row.id), xutiStyleNo: row.xutiStyleNo, facts: standardsSource(row, initial.fields).facts,
        targets: targets.map(field => ({ key: field.key, label: field.label, previousValue: String(cell(row, field.key) ?? "") })), pictures: [], inputWarnings: [] });
    }
    const deadline = Date.now() + 25000, cache = new Map<string, Promise<string | null>>(); let cursor = 0;
    const readImages = async () => {
      while (cursor < products.length) {
        const product = products[cursor++], source = initial.projected.find(row => String(row.id) === product.id)!;
        const candidates = standardsSource(source, initial.fields).pictures;
        for (const image of candidates.slice(0, 6)) {
          if (Date.now() >= deadline || product.pictures.length >= 2) break;
          let pending = cache.get(image.url);
          if (!pending) { pending = titleImageData(c, image.url).catch(() => null); cache.set(image.url, pending); }
          const data = await pending;
          if (data) product.pictures.push({ id: `product:${product.pictures.length + 1}`, data });
        }
        if (!product.pictures.length) product.inputWarnings.push("本次未读取到商品图片，仅使用其他可读资料");
      }
    };
    await Promise.all([readImages(), readImages()]);
    const unchanged = async () => {
      const latest = await snapshot(c, body.rowIds, body.targetKeys);
      if (latest.digest !== initial.digest || products.some(product => fingerprint(latest.projected.find(row => String(row.id) === product.id)!, latest.fields) !== fingerprint(initial.projected.find(row => String(row.id) === product.id)!, initial.fields)))
        fail("AI_SOURCE_CHANGED", "商品资料或权限已变化，请刷新后重新适配", 409);
    };
    await unchanged();
    const withFacts = products.filter(product => product.facts.length || product.pictures.length);
    let generated: z.infer<typeof responseSchema>["rows"] = [];
    try { if (withFacts.length) generated = await callModel(settings!, withFacts); }
    catch (error) { if ((error as { getStatus?: unknown }).getStatus) throw error; fail("AI_PROVIDER_ERROR", "AI 适配请求未完成，请稍后重试；本次没有填入资料", 502); }
    const result: SelectionStandardsAIPreview["rows"] = products.map(product => {
      const candidate = generated.find(row => row.id === product.id);
      const outsideScope = product.facts.some((fact: Fact) => /^(?:三级类目|三级分类|品类|商品类目|适用年龄|适用人群)$/u.test(fact.label) && /婴幼儿|婴儿|幼儿|儿童|童装|小童|中童|大童|皮衣|皮草|防护服|消防服|防弹/u.test(fact.value));
      const evidence = new Map<string, string>(product.facts.map((fact: Fact) => [fact.key, `${fact.label}：${fact.value}`]));
      for (const image of product.pictures) evidence.set(image.id, `商品图片 ${image.id.split(":")[1]}`);
      const used = new Set<string>();
      const values = product.targets.map((target: Row) => {
        const proposed = candidate?.values.find(value => value.key === target.key), field = initial.targets.find(field => field.key === target.key)!;
        let value = proposed?.value || "", reason = proposed?.reason || "缺少可读的图片、成分、三级类目或标题，待补充资料";
        let source = standardSource(standardsFieldKind(field.label)!, value);
        if (outsideScope) { value = ""; source = undefined; reason = "本款类目或适用人群超出当前成人普通纺织服装目录，请人工核对适用标准"; }
        if (value && (!source || !proposed?.evidence.length || proposed.evidence.some(key => !evidence.has(key)))) { value = ""; source = undefined; reason = "候选标准或引用依据未通过核对，请补充资料后重新适配"; }
        const issue = value && fieldTextLengthError(field, value);
        if (issue) { value = ""; source = undefined; reason = `字段字数上限不足：${issue}。请调整字段后重试`; }
        for (const key of proposed?.evidence || []) if (evidence.has(key)) used.add(key);
        return { key: target.key as string, label: field.label, previousValue: target.previousValue as string, value, reason, source: source ? { name: source.name, url: source.url } : null };
      });
      return { id: product.id, xutiStyleNo: product.xutiStyleNo, values, evidence: [
        `实际读取：商品图片 ${product.pictures.length} 张`,
        ...[...used].map(key => evidence.get(key)!),
      ], warnings: [...product.inputWarnings, ...(candidate?.warnings || [])] };
    });
    await unchanged();
    const expires = Date.now() + 30 * 60000;
    const signedRows = result.filter(row => row.values.some(value => value.value)).map(row => {
      const source = initial.projected.find(value => String(value.id) === row.id)!;
      return { id: row.id, expectedUpdatedAt: String(source.updatedAt), fingerprint: fingerprint(source, initial.fields), values: row.values.filter(value => value.value).map(({ key, value }) => ({ key, value })) };
    });
    return { planToken: signPlan({ actor: c.actor.id, scope: scopeKey(), mode: body.mode, expires, nonce: randomUUID(), policy: initial.digest, catalog: standardsCatalogCheckedAt, rows: signedRows }),
      expiresAt: new Date(expires).toISOString(), model: COMPASS_AI_MODEL, catalogCheckedAt: standardsCatalogCheckedAt, rows: result,
      warnings: products.length === body.rowIds.length ? [] : [`跳过 ${body.rowIds.length - products.length} 款：无可处理的目标、未填写款号或没有编辑权限`] };
  } finally { active.delete(caller); }
}

export async function applyStandards(c: Context, input: unknown) {
  await requireArchive(c);
  const body = parse(selectionStandardsAIApplySchema, input), plan = readStandardsPlan(body.planToken, c);
  for (const row of body.rows) {
    const signed = plan.rows.find(value => value.id === row.id);
    if (!signed || row.values.some(value => !signed.values.some(item => item.key === value.key && item.value === value.value))) fail("AI_PLAN_INVALID", "提交内容与适配候选不一致，请重新生成", 403);
  }
  return command(c, "style-selections/ai-standards/apply", body, async tx => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    const keys = [...new Set(body.rows.flatMap(row => row.values.map(value => value.key)))];
    const current = await snapshot(c, body.rows.map(row => row.id), keys, tx, true);
    if (current.digest !== plan.policy) fail("AI_SOURCE_CHANGED", "字段设置或权限已变化，请重新适配", 409);
    const patches: { id: string; extraFields: Row; expectedUpdatedAt: string }[] = [];
    for (const change of body.rows) {
      const signed = plan.rows.find(row => row.id === change.id)!, source = current.projected.find(row => String(row.id) === change.id)!, raw = current.raw.find(row => String(row.id) === change.id)!;
      if (String(source.updatedAt) !== signed.expectedUpdatedAt || fingerprint(source, current.fields) !== signed.fingerprint) fail("AI_SOURCE_CHANGED", "商品资料已修改，请重新适配；本批没有写入任何资料", 409);
      protection.assertFields(current.policy, c, raw, change.values.map(value => value.key));
      const extraFields: Row = {};
      for (const value of change.values) {
        const field = current.targets.find(field => field.key === value.key)!;
        if (!standardsTargetEligible(plan.mode, cell(source, value.key))) fail("AI_SOURCE_CHANGED", "目标单元格已填写，请重新适配", 409);
        if (!standardSource(standardsFieldKind(field.label)!, value.value)) fail("AI_PLAN_EXPIRED", "标准目录已更新，请重新适配", 409);
        const issue = fieldTextLengthError(field, value.value);
        if (issue) fail("VALIDATION_ERROR", `${field.label}：${issue}`, 400);
        extraFields[value.key] = value.value;
      }
      await protection.assertWrite(tx, c, raw, { extraFields }, current.policy, false);
      patches.push({ id: change.id, expectedUpdatedAt: signed.expectedUpdatedAt, extraFields });
    }
    for (const patch of patches) await persist(tx, c, { extraFields: patch.extraFields, expectedUpdatedAt: patch.expectedUpdatedAt }, patch.id);
    return { ids: patches.map(patch => patch.id), updatedCount: patches.length };
  });
}

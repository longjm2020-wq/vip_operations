import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db, one, rows, type Row, type Tx } from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import { selectionFieldSchema, type SelectionField } from "../../../../../packages/contracts/src/selection-layout.js";
import { splitChoiceValues } from "../../../../../packages/contracts/src/selection-field-validation.js";
import { selectionTitleAIApplySchema, selectionTitleAIGenerateSchema, selectionTitleAIModeSchema, selectionTitleTargetEligible, selectionTitleWordingIssue, type SelectionTitleAIPreview, type SelectionTitleAIStatus, type SelectionTitleAIRow } from "../../../../../packages/contracts/src/selection-title-ai.js";
import { command, fail, parse, requirePermission, type Context } from "../../core.js";
import { COMPASS_AI_ENDPOINT, COMPASS_AI_MODEL } from "../analytics/ai.js";
import { decryptSecret, encryptionReady } from "../analytics/secrets.js";
import * as protection from "./protection.js";
import { persist } from "./service.js";
import { isArchive } from "./archive.js";
import { titleImageData } from "./title-ai-images.js";
import { productTitleSystemPrompt, titleFieldLimitIssue, titleKind, titleLimit, titleValueIssue } from "./title-ai-validation.js";

const scopeKey = () => selectionScope.getStore() || "default";
const blank = (value: unknown) => !String(value ?? "").trim();
const cell = (row: Row, key: string) => key.startsWith("custom:") ? row.extraFields?.[key] : row[key];
const active = new Set<string>();
let activeRequests = 0;
const verifiedSettings = (settings?: Row) => encryptionReady() && !!settings?.enabled && !!settings.api_key_encrypted && !!settings.verified_at;
export async function titleAIStatus(c: Context): Promise<SelectionTitleAIStatus> {
  requirePermission(c.actor, "selection.manage");
  const settings = await one(db, "SELECT enabled,api_key_encrypted,verified_at FROM public.compass_ai_settings WHERE id=1");
  return verifiedSettings(settings) ? { ready: true, message: "AI 商品标题已就绪" } : { ready: false, message: "请超级管理员在系统设置 → AI 模型设置中启用 AI 并保存并验证模型后使用" };
}
type SignedRow = { id: string; expectedUpdatedAt: string; keys: string[]; fingerprint: string; visual: boolean };
const planSchema = z.object({ actor: z.string(), scope: z.string(), mode: selectionTitleAIModeSchema.optional(), expires: z.number(), nonce: z.string().uuid(), policy: z.string(), rows: z.array(z.object({ id: z.string(), expectedUpdatedAt: z.string(), keys: z.array(z.string()).max(2), fingerprint: z.string(), visual: z.boolean() }).strict()).max(10) }).strict();
type Plan = z.infer<typeof planSchema>;
function signingKey() {
  if (!encryptionReady()) fail("AI_NOT_READY", "AI 凭据加密尚未配置，请联系管理员", 503);
  return Buffer.from(process.env.COMPASS_MAIL_KEY!, "hex");
}
export function signTitlePlan(plan: Plan) {
  const encoded = Buffer.from(JSON.stringify(plan)).toString("base64url");
  return encoded + "." + createHmac("sha256", signingKey()).update("selection-title-v1:" + encoded).digest("base64url");
}
export function readTitlePlan(token: string, c: Context): Plan {
  const pieces = token.split(".");
  if (pieces.length !== 2 || !/^[A-Za-z0-9_-]+$/u.test(pieces[0]) || !/^[A-Za-z0-9_-]{43}$/u.test(pieces[1])) fail("AI_PLAN_INVALID", "标题预览无效，请重新生成", 400);
  const expected = createHmac("sha256", signingKey()).update("selection-title-v1:" + pieces[0]).digest();
  const supplied = Buffer.from(pieces[1], "base64url");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) fail("AI_PLAN_INVALID", "标题预览无效，请重新生成", 400);
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(pieces[0], "base64url").toString("utf8")); } catch { fail("AI_PLAN_INVALID", "标题预览无效，请重新生成", 400); }
  const result = planSchema.safeParse(parsed);
  if (!result.success || result.data.actor !== c.actor.id || result.data.scope !== scopeKey()) fail("AI_PLAN_INVALID", "标题预览不属于当前用户或表格，请重新生成", 403);
  if (result.data.expires <= Date.now() || result.data.expires > Date.now() + 31 * 60_000) fail("AI_PLAN_EXPIRED", "标题预览已过期，请重新生成", 409);
  return result.data;
}
const policyFingerprint = (p: protection.Policy, c: Context) => protection.digest([p.settings, p.revision, p.fieldRevision, c.actor.id, c.actor.permissions, c.actor.roleCodes]);
function fieldDefinitions(registry: Row[]) {
  return registry.flatMap(row => { const parsed = selectionFieldSchema.safeParse(row.definition); return parsed.success ? [parsed.data] : []; });
}
function targetDefinitions(fields: SelectionField[], keys: string[], policy: protection.Policy, c: Context) {
  return keys.map(key => {
    const field = fields.find(field => field.key === key);
    if (!field || field.deleted || (field.type || field.fallbackType || "text") !== "text" || !titleKind(field) || !protection.fieldVisible(policy, c.actor, key))
      fail("AI_TITLE_FIELD", "请选择可编辑的长标题或短标题文本字段", 403);
    if (fields.filter(other => !other.deleted && other.label === field.label && protection.fieldVisible(policy, c.actor, other.key)).length !== 1)
      fail("AI_TITLE_FIELD", "存在同名标题字段，请先在字段管理中明确字段名称", 400);
    return field;
  });
}
const descriptorLabels = /^(?:三级类目|三级分类|品类|商品类目|成分|材质|季节|适用季节|适穿季节|风格|款式|款式风格|领型|袖型|袖长|图案|工艺|面料|主面料|配料|设计元素|产品卖点|商品卖点|功能|标准颜色|长标题|短标题)$/u;
function sourceFacts(projected: Row, fields: SelectionField[]) {
  const material = String(projected.material || ""), details: Record<string, string> = {};
  if (material) details.成分 = material;
  for (const field of fields) {
    if (field.deleted || !["text", "tags", "single", "multiple"].includes(field.type || field.fallbackType || "text") ||
      !descriptorLabels.test(field.label) || projected.cellAccess?.[field.key] === "deny") continue;
    const raw = cell(projected, field.key); if (blank(raw)) continue;
    const value = (field.type === "single" || field.type === "multiple") ? splitChoiceValues(field, raw).join("、") : String(raw);
    if (value.length <= 2000) details[field.label] = value;
  }
  const composition = [material, ...Object.entries(details).filter(([label]) => /面料|配料|成分|材质/u.test(label)).map(([label, value]) => label + "：" + value)].filter(Boolean).join("\n");
  const descriptive = Object.entries(details).filter(([label]) => !/^(长标题|短标题|标准颜色)$/u.test(label));
  return { material: composition, details, facts: descriptive.map(([label, value]) => label + "：" + value).join("\n") };
}
type Snapshot = { policy: protection.Policy; fields: SelectionField[]; targets: SelectionField[]; raw: Row[]; projected: Row[]; digest: string };
async function snapshot(c: Context, rowIds: string[], targetKeys: string[], tx?: Tx, lock = false): Promise<Snapshot> {
  const read = async (connection: Tx) => {
    const policy = lock ? await protection.writeLocks(connection, c) : await protection.policy(connection);
    const fields = fieldDefinitions(await rows(connection, "SELECT definition FROM public.selection_field_registry WHERE workspace_key=$1 ORDER BY field_key", scopeKey()));
    const targets = targetDefinitions(fields, targetKeys, policy, c);
    const raw = await rows(connection, "SELECT * FROM style_selections WHERE id=ANY($1::bigint[]) ORDER BY id" + (lock ? " FOR UPDATE" : ""), rowIds);
    if (raw.length !== rowIds.length) fail("AI_SOURCE_CHANGED", "选中记录不存在或已删除，请刷新后重试", 409);
    const projected = raw.map(row => protection.project(policy, c.actor, row));
    const categoryKey = "custom:product:categoryId";
    const categoryIds = [...new Set(projected.map(row => cell(row, categoryKey)).filter(value => /^[1-9]\d{0,18}$/u.test(String(value || ""))))];
    if (categoryIds.length) {
      const categories = new Map((await rows(connection, "SELECT id,name FROM public.categories WHERE id=ANY($1::bigint[])", categoryIds)).map(row => [String(row.id), row.name]));
      for (const row of projected) if (!blank(cell(row, categoryKey))) row.extraFields = { ...row.extraFields, [categoryKey]: categories.get(String(cell(row, categoryKey))) || "" };
    }
    return { policy, fields, targets, raw, projected, digest: policyFingerprint(policy, c) };
  };
  return tx ? read(tx) : db.$transaction(read, { isolationLevel: "RepeatableRead" });
}
const sourceFingerprint = (row: Row, fields: SelectionField[]) => protection.digest([String(row.updatedAt), sourceFacts(row, fields), row.images || []]);
const candidateSchema = z.object({ rows: z.array(z.object({
  id: z.string(), titles: z.array(z.object({ key: z.string(), value: z.string().trim().min(1).max(2000) }).strict()).max(2),
  evidence: z.array(z.string().max(300)).max(6), warnings: z.array(z.string().max(300)).max(6),
}).strict()).max(10) }).strict();
export function parseTitleAIResponse(content: unknown, expected: { id: string; keys: string[] }[]) {
  const result = candidateSchema.safeParse(content);
  if (!result.success || result.data.rows.length !== expected.length || new Set(result.data.rows.map(row => row.id)).size !== expected.length)
    fail("AI_RESPONSE_INVALID", "AI 返回的款式或标题格式不完整，未采用此结果", 502);
  for (const row of result.data.rows) {
    const requested = expected.find(value => value.id === row.id);
    if (!requested || new Set(row.titles.map(title => title.key)).size !== row.titles.length ||
      row.titles.some(title => !requested.keys.includes(title.key)) || (row.titles.length > 0 && row.titles.length !== requested.keys.length) ||
      (!row.titles.length && !row.warnings.length)) fail("AI_RESPONSE_INVALID", "AI 返回了未请求、重复或缺失的标题，未采用此结果", 502);
  }
  return result.data.rows;
}
async function callTitleModel(settings: Row, products: Row[], examples: Row[], preferences: unknown) {
  const content: Row[] = [{ type: "text", text: JSON.stringify({ products: products.map(({ pictures: _pictures, ...product }) => product), styleExamples: examples, preferences }) }];
  for (const product of products) for (const [index, image] of product.pictures.entries()) {
    content.push({ type: "text", text: `以下是商品 ID ${product.id} 的第 ${index + 1} 张图片；只分析这件产品的可见设计。` }, { type: "image_url", image_url: { url: image, detail: "low" } });
  }
  const response = await fetch(COMPASS_AI_ENDPOINT, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(90000),
    headers: { Authorization: "Bearer " + decryptSecret(settings.api_key_encrypted), "Content-Type": "application/json" },
    body: JSON.stringify({ model: COMPASS_AI_MODEL, stream: false, max_tokens: 8000, reasoning: { effort: "low" }, provider: { require_parameters: true, data_collection: "deny" },
      messages: [{ role: "system", content: productTitleSystemPrompt }, { role: "user", content }],
      response_format: { type: "json_schema", json_schema: { name: "selection_product_titles", strict: true, schema: {
        type: "object", additionalProperties: false, required: ["rows"], properties: { rows: { type: "array", items: {
          type: "object", additionalProperties: false, required: ["id", "titles", "evidence", "warnings"], properties: {
            id: { type: "string" }, titles: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "value"], properties: { key: { type: "string" }, value: { type: "string" } } } },
            evidence: { type: "array", items: { type: "string" } }, warnings: { type: "array", items: { type: "string" } },
          },
        } } },
      } } },
    }),
  });
  if (!response.ok) { await response.body?.cancel(); fail("AI_PROVIDER_ERROR", ({ 401: "AI 密钥无效，请联系管理员", 402: "AI 余额或额度不足，请联系管理员", 429: "AI 请求频率或额度超限，请稍后重试" } as Record<number, string>)[response.status] || "AI 服务暂不可用，请稍后重试", 502); }
  const text = await response.text();
  if (text.length > 200000) fail("AI_RESPONSE_INVALID", "AI 返回内容过大，未采用此结果", 502);
  let payload: Row;
  try { payload = JSON.parse(text); } catch { fail("AI_RESPONSE_INVALID", "AI 返回格式无效，未采用此结果", 502); }
  const choice = payload.choices?.[0];
  if (payload.model !== COMPASS_AI_MODEL || !payload.id || choice?.finish_reason !== "stop" || choice?.message?.refusal || typeof choice?.message?.content !== "string")
    fail("AI_RESPONSE_INVALID", "AI 模型标识或结果不完整，未采用此结果", 502);
  try { return JSON.parse(choice.message.content); } catch { fail("AI_RESPONSE_INVALID", "AI 标题格式无效，未采用此结果", 502); }
}

export async function generateTitles(c: Context, input: unknown): Promise<SelectionTitleAIPreview> {
  requirePermission(c.actor, "selection.manage");
  const body = parse(selectionTitleAIGenerateSchema, input), caller = `${c.actor.id}:${scopeKey()}`;
  if (active.has(caller) || activeRequests >= 2) fail("AI_BUSY", "AI 标题正在生成，请稍后重试", 429);
  // Reserve before the first await; simultaneous clicks must not race the
  // existing one-request-per-user/two-request global limit.
  active.add(caller); activeRequests++;
  try {
    const settings = await one(db, "SELECT enabled,api_key_encrypted,verified_at FROM public.compass_ai_settings WHERE id=1");
    if (!verifiedSettings(settings)) fail("AI_NOT_READY", "请超级管理员先启用并测试 AI 连接", 503);
    const initial = await snapshot(c, body.rowIds, body.targetKeys), products: Row[] = [], signedRows: SignedRow[] = [], skipped: string[] = [];
    for (const row of initial.projected) {
      const raw = initial.raw.find(value => String(value.id) === String(row.id))!;
      if (blank(row.xutiStyleNo)) { skipped.push(String(row.id)); continue; }
      const targets = initial.targets.filter(field => selectionTitleTargetEligible(body.mode, titleKind(field)!, cell(row, field.key)) && protection.access(initial.policy, c.actor, raw, field.key) === "edit");
      if (!targets.length) { skipped.push(String(row.id)); continue; }
      for (const field of targets) {
        const issue = titleFieldLimitIssue(field, body.mode);
        if (issue) fail("AI_TITLE_LIMIT", `字段「${field.label}」：${issue}`, 400);
      }
      const source = sourceFacts(row, initial.fields), pictures: string[] = [];
      products.push({ id: String(row.id), xutiStyleNo: String(row.xutiStyleNo || ""), mode: body.mode, facts: source.details, pictures,
        targets: targets.map(field => ({ key: field.key, label: field.label, kind: titleKind(field), currentValue: String(cell(row, field.key) ?? ""), ...titleLimit(field, body.mode) })),
        inputWarnings: [],
      });
      signedRows.push({ id: String(row.id), expectedUpdatedAt: String(row.updatedAt), keys: targets.map(field => field.key), fingerprint: sourceFingerprint(row, initial.fields), visual: false });
    }
    // At most two image reads run at once; a 25-second batch budget prevents slow links delaying every row.
    const imageDeadline = Date.now() + 25000; let imageCursor = 0;
    // Batch-local only: no authorized pixels or stale permissions are cached
    // across requests. Repeated photo URLs need only one download/resize.
    const imageReads = new Map<string, Promise<string | null>>();
    const pictureData = (url: string) => {
      let pending = imageReads.get(url);
      if (!pending) {
        pending = titleImageData(c, url).catch(() => null);
        imageReads.set(url, pending);
      }
      return pending;
    };
    const readPictures = async () => {
      while (imageCursor < products.length) {
        const product = products[imageCursor++], row = initial.projected.find(row => String(row.id) === product.id)!;
        const urls = [...new Set<string>((Array.isArray(row.images) ? row.images : []).map((image: Row) => String(image.url || "")).filter(Boolean))];
        // A broken first link must not hide later usable product photographs.
        // Keep preparation bounded and send at most two successfully read images.
        for (const url of urls.slice(0, 6)) {
          if (Date.now() >= imageDeadline || product.pictures.length >= 2) break;
          const data = await pictureData(url); if (data) product.pictures.push(data);
        }
        product.inputWarnings = product.pictures.length ? [] : [urls.length
          ? "商品已有图片，但本次未能读取；仅依据可查看的文字资料生成，请检查图片链接或稍后重试"
          : "没有可读取的商品图片，仅依据可查看的文字资料生成"];
        signedRows.find(value => value.id === product.id)!.visual = !!product.pictures.length;
      }
    };
    const readExamples = async (): Promise<Row[]> => {
      if (!products.length) return [];
      return db.$transaction(async tx => {
        const currentPolicy = await protection.policy(tx);
        if (policyFingerprint(currentPolicy, c) !== initial.digest) fail("AI_SOURCE_CHANGED", "生成前字段或权限已变化，请刷新后重新生成", 409);
        const sample = await rows(tx, "SELECT * FROM style_selections WHERE id<>ALL($1::bigint[]) ORDER BY updated_at DESC,id DESC LIMIT 250", body.rowIds);
        const selected: Row[] = [];
        for (const raw of sample) {
          const row = protection.project(currentPolicy, c.actor, raw);
          for (const field of initial.fields) if (titleKind(field) && !field.deleted && row.cellAccess?.[field.key] !== "deny" && !blank(cell(row, field.key))) {
            const value = String(cell(row, field.key)).slice(0, 500);
            // Learn compatible format and rhythm without encouraging older
            // color labels or composition tags in new titles.
            if (selectionTitleWordingIssue(value)) continue;
            selected.push({ kind: titleKind(field), value });
            if (selected.length >= 24) return selected;
          }
        }
        return selected;
      }, { isolationLevel: "RepeatableRead" });
    };
    // Permission-projected examples and authorized image loading are independent.
    // Await both and retain the existing latest-source check before any paid call.
    const prepared = await Promise.allSettled([readExamples(), Promise.all([readPictures(), readPictures()])]);
    for (const outcome of prepared) if (outcome.status === "rejected") throw outcome.reason;
    const examples = (prepared[0] as PromiseFulfilledResult<Row[]>).value;
    for (let index = products.length - 1; index >= 0; index--) {
      const product = products[index], source = initial.projected.find(row => String(row.id) === product.id)!;
      if (!sourceFacts(source, initial.fields).facts && !product.pictures.length && !(body.mode !== "blank" && product.targets.some((target: Row) => !blank(target.currentValue)))) { skipped.push(product.id); products.splice(index, 1); signedRows.splice(index, 1); }
    }
    const warnings = ["候选标题和款名需人工核对；系统未执行实时趋势、商标或侵权检索。", ...(skipped.length ? [`跳过 ${skipped.length} 行：没有符合本次处理方式的可编辑标题、缺少款号或产品资料。`] : [])];
    let result: SelectionTitleAIRow[] = [];
    if (products.length) {
      const beforeProvider = await snapshot(c, body.rowIds, body.targetKeys);
      if (beforeProvider.digest !== initial.digest || signedRows.some(row => sourceFingerprint(beforeProvider.projected.find(value => String(value.id) === row.id)!, beforeProvider.fields) !== row.fingerprint))
        fail("AI_SOURCE_CHANGED", "生成前产品资料或权限已变化，请刷新后重新生成", 409);
      let response: unknown;
      try { response = await callTitleModel(settings!, products, examples, body.preferences || { usePoeticName: true, instruction: "" }); }
      catch (error) { if ((error as { getStatus?: unknown }).getStatus) throw error; fail("AI_PROVIDER_ERROR", "AI 请求未完成，请检查网络或稍后重试；本次没有填入标题", 502); }
      const generated = parseTitleAIResponse(response, signedRows.map(row => ({ id: row.id, keys: row.keys })));
      result = generated.map(candidate => {
        const source = initial.projected.find(row => String(row.id) === candidate.id)!, product = products.find(row => row.id === candidate.id)!;
        const facts = sourceFacts(source, initial.fields);
        return { id: candidate.id, xutiStyleNo: product.xutiStyleNo, expectedUpdatedAt: String(source.updatedAt),
          titles: candidate.titles.map(title => {
            const field = initial.targets.find(field => field.key === title.key)!;
            const previousValue = String(cell(source, title.key) ?? "");
            const issue = titleValueIssue(field, title.value, facts.material, facts.facts, !!product.pictures.length, { mode: body.mode, existingDescription: previousValue });
            if (issue || examples.some(example => example.value === title.value)) fail("AI_TITLE_INVALID", `${field.label}候选未通过校验：${issue || "与现有标题完全重复"}；本次未采用结果`, 502);
            return { key: title.key, label: field.label, kind: titleKind(field)!, value: title.value, previousValue, ...titleLimit(field, body.mode) };
          }), evidence: [...(product.pictures.length ? [`已读取 ${product.pictures.length} 张商品图片作为生成依据`] : []), ...candidate.evidence], warnings: [...product.inputWarnings, ...candidate.warnings],
        };
      });
      const latest = await snapshot(c, body.rowIds, body.targetKeys);
      if (latest.digest !== initial.digest || signedRows.some(row => {
        const source = latest.projected.find(value => String(value.id) === row.id);
        return !source || sourceFingerprint(source, latest.fields) !== row.fingerprint;
      })) fail("AI_SOURCE_CHANGED", "生成期间产品资料或权限已变化，请刷新后重新生成", 409);
    }
    const expires = Date.now() + 30 * 60_000;
    const accepted = signedRows.filter(row => result.some(candidate => candidate.id === row.id && candidate.titles.length));
    return { planToken: signTitlePlan({ actor: c.actor.id, scope: scopeKey(), mode: body.mode, expires, nonce: randomUUID(), policy: initial.digest, rows: accepted }), expiresAt: new Date(expires).toISOString(), model: COMPASS_AI_MODEL, rows: result, warnings };
  } finally { active.delete(caller); activeRequests--; }
}

export async function applyTitles(c: Context, input: unknown) {
  requirePermission(c.actor, "selection.manage");
  const body = parse(selectionTitleAIApplySchema, input), plan = readTitlePlan(body.planToken, c);
  const mode = plan.mode || "blank";
  for (const row of body.rows) {
    const signed = plan.rows.find(value => value.id === row.id);
    if (!signed || row.titles.some(title => !signed.keys.includes(title.key))) fail("AI_PLAN_INVALID", "提交了预览之外的行或标题字段，请重新生成", 403);
  }
  const completed = await command(c, "style-selections/ai-titles/apply", body, async tx => {
    if (await isArchive(tx)) await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    const targetKeys = [...new Set(body.rows.flatMap(row => row.titles.map(title => title.key)))];
    const current = await snapshot(c, body.rows.map(row => row.id), targetKeys, tx, true);
    if (current.digest !== plan.policy) fail("AI_SOURCE_CHANGED", "字段设置或权限已变化，请重新生成标题", 409);
    const patches: { id: string; extraFields: Row; expectedUpdatedAt: string }[] = [];
    for (const change of body.rows) {
      const source = current.projected.find(row => String(row.id) === change.id)!, raw = current.raw.find(row => String(row.id) === change.id)!;
      const signed = plan.rows.find(row => row.id === change.id)!;
      if (String(source.updatedAt) !== signed.expectedUpdatedAt || sourceFingerprint(source, current.fields) !== signed.fingerprint)
        fail("AI_SOURCE_CHANGED", "产品资料已被修改，请重新生成；本次没有写入任何标题", 409);
      protection.assertFields(current.policy, c, raw, change.titles.map(title => title.key));
      const facts = sourceFacts(source, current.fields), extraFields: Row = {};
      for (const title of change.titles) {
        const field = current.targets.find(field => field.key === title.key)!;
        if (!selectionTitleTargetEligible(mode, titleKind(field)!, cell(source, title.key))) fail("AI_SOURCE_CHANGED", "目标标题已不符合本次处理方式，请重新生成；本次没有写入任何标题", 409);
        // Product images are authorized inputs to the signed preview. Do not fetch again while holding row locks.
        const issue = titleValueIssue(field, title.value, facts.material, facts.facts, signed.visual, { mode, existingDescription: String(cell(source, title.key) ?? "") });
        if (issue) fail("VALIDATION_ERROR", `字段「${field.label}」：${issue}`, 400);
        extraFields[title.key] = title.value;
      }
      const patch = { id: change.id, extraFields, expectedUpdatedAt: signed.expectedUpdatedAt };
      await protection.assertWrite(tx, c, raw, { extraFields }, current.policy, false);
      patches.push(patch);
    }
    for (const patch of patches) await persist(tx, c, { extraFields: patch.extraFields, expectedUpdatedAt: patch.expectedUpdatedAt }, patch.id);
    // Cache only identifiers, then project fresh results after the idempotent command.
    return { ids: patches.map(patch => patch.id), updatedCount: patches.length };
  });
  return { updatedCount: completed.updatedCount, ids: completed.ids };
}

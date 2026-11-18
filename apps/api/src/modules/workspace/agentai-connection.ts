import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  db,
  one,
  rows,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import {
  agentaiBaseUrl,
  agentaiModelName,
  agentaiSaveSchema,
  agentaiTestSchema,
  type AgentAiCatalogModel,
  type AgentAiModel,
  type AgentAiStatus,
  type AgentAiModelPricing,
  type AgentAiPriceChannel,
} from "../../../../../packages/contracts/src/agentai.js";
import {
  agentaiAllowedModels,
  canonicalAgentAiModel,
  isAllowedAgentAiModel,
} from "../../../../../packages/contracts/src/agentai-policy.js";
import type { AiFeatureId } from "../../../../../packages/contracts/src/ai-management.js";
import { audit, command, fail, parse, type Context } from "../../core.js";
import { aiFetch } from "../../ai-metering.js";
import { requireAIConfiguration } from "../analytics/ai.js";
import {
  decryptSecret,
  encryptSecret,
  encryptionReady,
} from "../analytics/secrets.js";
import { agentaiCatalogSnapshot } from "./agentai-catalog.js";

export { agentaiBaseUrl };
export const agentaiEndpoint = agentaiBaseUrl + "/chat/completions";
export const agentaiSource = "agentai.token6688.com";
const iso = (value: unknown) =>
  value ? new Date(String(value)).toISOString() : null;
const canonicalModel = (value: string) => canonicalAgentAiModel(value);
export const agentaiReady = (s?: Row) =>
  Boolean(
    encryptionReady() && s?.enabled && s.api_key_encrypted && s.verified_at,
  );
export const readAgentAiConnection = () =>
  one(db, "SELECT * FROM public.agentai_settings WHERE id=1");
export async function agentaiConnection() {
  const s = await readAgentAiConnection();
  if (!agentaiReady(s))
    fail("AGENTAI_NOT_READY", "请管理员先启用 AgentAI 并验证目录连接", 503);
  return s!;
}

/** Fixed endpoints only. Neither a model name nor provider data can select a URL. */
async function readJson(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
) {
  if (!response.body)
    fail("AGENTAI_RESPONSE_INVALID", "AgentAI 返回空响应", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const aborted = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        fail("AGENTAI_RESPONSE_INVALID", "AgentAI 响应超过大小限制", 502);
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Row;
    } catch {
      fail("AGENTAI_RESPONSE_INVALID", "AgentAI 返回的数据格式无效", 502);
    }
  } finally {
    signal.removeEventListener("abort", aborted);
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* cleanup never replaces the failure */
    }
  }
}
function httpFailure(response: Response) {
  void response.body?.cancel().catch(() => {});
  fail(
    "AGENTAI_REQUEST_FAILED",
    `AgentAI 请求失败（HTTP ${response.status}），请核对连接、权限与额度`,
    502,
  );
}
const safeNote = (error: unknown) => {
  const code = (
    error as { getResponse?: () => { error?: { code?: string } } }
  )?.getResponse?.()?.error?.code;
  return code === "VERSION_CONFLICT"
    ? "配置已变更，本次结果未用于新连接"
    : code === "AGENTAI_MODEL_MISMATCH"
      ? "返回型号与请求不一致，未验证通过"
      : code === "AGENTAI_CAPABILITY_UNVERIFIED"
        ? "未返回所要求的能力验证结果"
        : "AgentAI 验证未完成，请核对连接、权限与额度；未自动重试";
};
function catalog(s?: Row): AgentAiCatalogModel[] {
  const models: AgentAiCatalogModel[] =
    s?.catalog_at && Array.isArray(s.model_catalog)
      ? s.model_catalog
      : agentaiCatalogSnapshot;
  const seen = new Set<string>();
  return models.flatMap((m) => {
    if (!m || typeof m !== "object") return [];
    const model = canonicalAgentAiModel(m.model);
    const policy = agentaiAllowedModels.find((item) => item.model === model);
    if (!policy || policy.type !== m.type || seen.has(policy.model)) return [];
    seen.add(policy.model);
    return [
      {
        ...m,
        model: policy.model,
        publicId: policy.publicId,
        name: policy.name,
      },
    ];
  });
}
async function modelsView(
  s: Row,
  connection: Tx = db,
): Promise<AgentAiModel[]> {
  const checks = await rows(
    connection,
    "SELECT * FROM public.agentai_model_verifications WHERE settings_version=$1",
    s.version,
  );
  return catalog(s).map((m) => {
    const check = checks.find((v) => v.model === m.model);
    const enabled = agentaiReady(s);
    const tools = enabled && !!check?.tools_verified_at;
    const structured = enabled && !!check?.structured_verified_at;
    return {
      ...m,
      pricing: Array.isArray(s.model_prices)
        ? s.model_prices.find((p: Row) => p.model === m.model)?.pricing || null
        : null,
      id: "agentai/" + m.model,
      pdf: false,
      parameters: [
        ...(tools ? ["tools", "tool_choice"] : []),
        ...(structured ? ["structured_outputs", "response_format"] : []),
      ],
      chatVerifiedAt: enabled ? iso(check?.chat_verified_at) : null,
      toolsVerifiedAt: tools ? iso(check?.tools_verified_at) : null,
      structuredVerifiedAt: structured
        ? iso(check?.structured_verified_at)
        : null,
    };
  });
}
async function view(s: Row, connection: Tx = db): Promise<AgentAiStatus> {
  return {
    enabled: s.enabled,
    endpoint: agentaiBaseUrl,
    apiKeyConfigured: !!s.api_key_encrypted,
    encryptionReady: encryptionReady(),
    verifiedAt: iso(s.verified_at),
    errorNote: s.error_note,
    version: s.version,
    catalogAt: iso(s.catalog_at),
    models: await modelsView(s, connection),
    pricesAt: iso(s.prices_at),
    pricesGeneratedAt: iso(s.prices_generated_at),
    pricesErrorNote: s.prices_error_note || "",
    strategy: "balanced",
  };
}
export async function readAgentAi(c: Context) {
  requireAIConfiguration(c);
  return view((await readAgentAiConnection())!);
}
export async function saveAgentAi(
  c: Context,
  input: unknown,
): Promise<AgentAiStatus> {
  requireAIConfiguration(c);
  const b = parse(agentaiSaveSchema, input);
  if (b.clearKey && b.apiKey)
    fail("AGENTAI_KEY_INVALID", "填写与清除密钥不能同时进行", 400);
  return command(c, "agentai.settings", b, async (tx) => {
    const old = (await one(
      tx,
      "SELECT * FROM public.agentai_settings WHERE id=1 FOR UPDATE",
    ))!;
    if (old.version !== b.version)
      fail("VERSION_CONFLICT", "连接已被更新，请刷新后重试", 409);
    const key = b.clearKey
      ? null
      : b.apiKey
        ? encryptSecret(b.apiKey)
        : old.api_key_encrypted;
    if (b.enabled && !b.clearKey && !key)
      fail("AGENTAI_KEY_MISSING", "请先填写 AgentAI API Key", 400);
    const saved = (await one(
      tx,
      `UPDATE public.agentai_settings SET enabled=$1,api_key_encrypted=$2,
      verified_at=NULL,last_test_at=NULL,error_note='',model_prices='[]'::jsonb,prices_at=NULL,prices_generated_at=NULL,prices_etag=NULL,prices_error_note='',prices_refresh_started_at=NULL,version=version+1,updated_by=$3::bigint,updated_at=now()
      WHERE id=1 RETURNING *`,
      b.enabled && !b.clearKey,
      key,
      c.actor.id,
    ))!;
    await audit(
      tx,
      c,
      "AGENTAI_SETTINGS",
      "agentai_settings",
      1,
      { enabled: old.enabled, configured: !!old.api_key_encrypted },
      { enabled: saved.enabled, configured: !!saved.api_key_encrypted },
    );
    return view(saved, tx);
  });
}

/** Imported public metadata proves only the advertised modalities, never tools/schema support. */
export function normalizeAgentAiCatalog(
  payload: unknown,
  allowed?: Set<string>,
): AgentAiCatalogModel[] {
  const entries = (payload as Row)?.models;
  if (!Array.isArray(entries) || entries.length > 1000)
    fail("AGENTAI_RESPONSE_INVALID", "AgentAI 模型目录格式无效", 502);
  const seen = new Set<string>();
  return entries.flatMap((m: Row) => {
    const parsed = agentaiModelName.safeParse(m?.id);
    if (
      !parsed.success ||
      m.deprecated ||
      m.available !== true ||
      seen.has(parsed.data)
    )
      return [];
    const model = canonicalAgentAiModel(parsed.data);
    const policy = agentaiAllowedModels.find((item) => item.model === model);
    if (!policy || policy.type !== m.category || seen.has(policy.model))
      return [];
    if (allowed && !allowed.has(policy.model) && !allowed.has(policy.publicId))
      return [];
    if (typeof m.category !== "string" || !/^[a-z_-]{1,30}$/.test(m.category))
      return [];
    seen.add(policy.model);
    return [
      {
        model: policy.model,
        publicId: policy.publicId,
        name: policy.name,
        type: m.category,
        vision:
          Array.isArray(m.capabilities) && m.capabilities.includes("vision"),
        available: true,
        billingMode: safeText(m.billing_mode, 40),
        billingUnit: safeText(m.billing_unit, 40),
        paramSchema: sanitizeAgentAiParamSchema(m.param_schema),
      },
    ];
  });
}
function safeText(value: unknown, max = 100) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f<>]/g, "").slice(0, max)
    : "";
}
/** Keep conditional provider schemas intact while bounding untrusted JSON. */
export function sanitizeAgentAiParamSchema(
  value: unknown,
): Record<string, unknown> {
  let budget = 12000;
  const clean = (v: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 10) return undefined;
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
    if (typeof v === "string") return safeText(v, 4000);
    if (Array.isArray(v))
      return v.slice(0, 150).map((item) => clean(item, depth + 1));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .slice(0, 150)
          .flatMap(([key, item]) =>
            !["__proto__", "constructor", "prototype"].includes(key) &&
            key.length <= 100
              ? [[key, clean(item, depth + 1)]]
              : [],
          ),
      );
    return undefined;
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return clean(value, 0) as Record<string, unknown>;
}

type StoredPrice = { model: string; pricing: AgentAiModelPricing };
const nonnegative = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const safeDate = (v: unknown) =>
  typeof v === "string" && Number.isFinite(Date.parse(v))
    ? new Date(v).toISOString()
    : null;
export function normalizeAgentAiPrices(payload: unknown): StoredPrice[] {
  const p = payload as Row;
  if (!Array.isArray(p?.models) || p.models.length > 1000)
    fail("AGENTAI_PRICES_INVALID", "AgentAI 价格目录格式无效", 502);
  const seen = new Set<string>();
  return p.models.flatMap((m: Row) => {
    const model = canonicalAgentAiModel(m.name);
    if (!model || seen.has(model) || !Array.isArray(m.channel_groups))
      return [];
    seen.add(model);
    const channels: AgentAiPriceChannel[] = m.channel_groups
      .slice(0, 150)
      .flatMap((g: Row) => {
        if (!g || g.is_active !== true) return [];
        const rate = nonnegative(g.success_rate_24h);
        const source =
          g.stats_source === "live" || g.stats_source === "estimate"
            ? g.stats_source
            : "unknown";
        return [
          {
            vendor: safeText(g.vendor, 60),
            laneNo:
              typeof g.lane_no === "number" &&
              Number.isSafeInteger(g.lane_no) &&
              g.lane_no >= 0
                ? g.lane_no
                : null,
            billingUnit: safeText(g.billing_unit, 40),
            billingMethod: safeText(g.billing_method, 40),
            defaultTotalRmb: nonnegative(g.user_price_rmb),
            billedSeconds: nonnegative(g.billed_seconds),
            inputPerMillionRmb: nonnegative(g.user_price_per_million_input_rmb),
            outputPerMillionRmb: nonnegative(
              g.user_price_per_million_output_rmb,
            ),
            // Default provider statistics must never appear as measured performance.
            successRate24h:
              source === "live" && rate !== null && rate <= 100 ? rate : null,
            avgResponseSeconds:
              source === "live" ? nonnegative(g.avg_response_seconds) : null,
            statsSource: source,
          },
        ];
      });
    return [
      {
        model,
        pricing: {
          currency: "CNY",
          generatedAt: safeDate(p.generated_at),
          channels,
        },
      },
    ];
  });
}

/** Account-private, version-bound bulk price cache; no price request generates content. */
export async function refreshAgentAiPrices(c: Context): Promise<AgentAiStatus> {
  requireAIConfiguration(c);
  const s = await agentaiConnection();
  if (s.prices_at && Date.now() - new Date(s.prices_at).getTime() < 300000)
    return view(s);
  const claim = await one(
    db,
    `UPDATE public.agentai_settings SET prices_refresh_started_at=now()
    WHERE id=1 AND enabled AND version=$1 AND
    (prices_refresh_started_at IS NULL OR prices_refresh_started_at<now()-interval '5 minutes') RETURNING id`,
    s.version,
  );
  if (!claim) return view((await readAgentAiConnection())!);
  try {
    const signal = AbortSignal.timeout(20000);
    const headers: Record<string, string> = {
      Authorization: "Bearer " + decryptSecret(s.api_key_encrypted),
    };
    if (
      typeof s.prices_etag === "string" &&
      s.prices_etag.length < 200 &&
      !/[\r\n]/.test(s.prices_etag)
    )
      headers["If-None-Match"] = s.prices_etag;
    const response = await fetch(
      agentaiBaseUrl + "/skills/pricing?status=active",
      { redirect: "error", signal, headers },
    );
    let saved: Row | undefined;
    if (
      response.status === 304 &&
      s.prices_at &&
      Array.isArray(s.model_prices)
    ) {
      saved = await one(
        db,
        "UPDATE public.agentai_settings SET prices_at=now(),prices_error_note='' WHERE id=1 AND enabled AND version=$1 RETURNING *",
        s.version,
      );
    } else {
      if (!response.ok) httpFailure(response);
      const payload = await readJson(response, signal, 3 * 1024 * 1024);
      const prices = normalizeAgentAiPrices(payload);
      if (!prices.length)
        fail("AGENTAI_PRICES_INVALID", "AgentAI 未返回指定型号的账号价格", 502);
      const etag = response.headers.get("etag");
      saved = await one(
        db,
        `UPDATE public.agentai_settings SET model_prices=$2::jsonb,prices_at=now(),prices_generated_at=$3::timestamptz,prices_etag=$4,prices_error_note=''
        WHERE id=1 AND enabled AND version=$1 RETURNING *`,
        s.version,
        JSON.stringify(prices),
        safeDate(payload.generated_at),
        etag && etag.length < 200 && !/[\r\n]/.test(etag) ? etag : null,
      );
    }
    if (!saved)
      fail("VERSION_CONFLICT", "配置已变更，本次价格未用于新连接", 409);
    return view(saved);
  } catch (error) {
    await one(
      db,
      "UPDATE public.agentai_settings SET prices_error_note=$2 WHERE id=1 AND version=$1 RETURNING id",
      s.version,
      "账号价格同步未完成，请稍后重试；现有模型连接和能力验证不受影响",
    );
    throw error;
  }
}
export async function syncAgentAiModels(c: Context) {
  requireAIConfiguration(c);
  const s = await readAgentAiConnection();
  if (!encryptionReady() || !s?.enabled || !s.api_key_encrypted)
    fail("AGENTAI_NOT_READY", "请先启用并保存 AgentAI 密钥", 409);
  const signal = AbortSignal.timeout(20000);
  try {
    const authenticated = await fetch(agentaiBaseUrl + "/models", {
      redirect: "error",
      signal,
      headers: {
        Authorization: "Bearer " + decryptSecret(s.api_key_encrypted),
      },
    });
    if (!authenticated.ok) httpFailure(authenticated);
    const data = await readJson(authenticated, signal, 2 * 1024 * 1024);
    if (!Array.isArray(data.data) || data.data.length > 3000)
      fail("AGENTAI_RESPONSE_INVALID", "AgentAI 模型列表无效", 502);
    const allowed = new Set<string>(
      data.data.flatMap((m: Row) =>
        [m.id, m.public_id].filter(
          (id): id is string => typeof id === "string",
        ),
      ),
    );
    const logical = await fetch(agentaiBaseUrl + "/logical-models", {
      redirect: "error",
      signal,
    });
    if (!logical.ok) httpFailure(logical);
    const models = normalizeAgentAiCatalog(
      await readJson(logical, signal, 2 * 1024 * 1024),
      allowed,
    );
    if (!models.length)
      fail(
        "AGENTAI_RESPONSE_INVALID",
        "AgentAI 没有返回当前可用的模型目录",
        502,
      );
    const saved = await one(
      db,
      `UPDATE public.agentai_settings SET verified_at=now(),catalog_at=now(),model_catalog=$2::jsonb,error_note=''
      WHERE id=1 AND enabled AND version=$1 RETURNING *`,
      s.version,
      JSON.stringify(models),
    );
    if (!saved) fail("VERSION_CONFLICT", "配置已变更，请重新验证当前连接", 409);
    try {
      return await refreshAgentAiPrices(c);
    } catch {
      // Price availability is independent of directory or model capability verification.
      return view((await readAgentAiConnection())!);
    }
  } catch (error) {
    await one(
      db,
      "UPDATE public.agentai_settings SET verified_at=NULL,error_note=$2 WHERE id=1 AND version=$1 RETURNING id",
      s.version,
      safeNote(error),
    );
    throw error;
  }
}

export function agentaiChatBody(body: Row) {
  const fields = [
    "model",
    "messages",
    "max_tokens",
    "temperature",
    "top_p",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "tools",
    "tool_choice",
    "response_format",
    "parallel_tool_calls",
    "reasoning_effort",
    "enable_thinking",
  ];
  return {
    ...Object.fromEntries(
      fields.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]),
    ),
    stream: false,
    strategy: "balanced",
  };
}
const allowedFeatures: AiFeatureId[] = [
  "assistant_chat",
  "assistant_team",
  "assistant_employee",
  "mastra_team",
];
async function sendAgentAiChat(
  s: Row,
  body: Row,
  signal: AbortSignal,
  feature: AiFeatureId = "assistant_chat",
) {
  if (!allowedFeatures.includes(feature))
    fail("AI_MODEL_CAPABILITY", "此功能尚未接入 AgentAI 聊天线路", 409);
  if (!agentaiReady(s)) fail("AGENTAI_NOT_READY", "AgentAI 连接尚未验证", 503);
  if (!isAllowedAgentAiModel(body.model, "chat"))
    fail("AGENTAI_MODEL_UNAVAILABLE", "该 AgentAI 型号已停用，请重新选择", 409);
  return aiFetch(feature, agentaiEndpoint, {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      Authorization: "Bearer " + decryptSecret(s.api_key_encrypted),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(agentaiChatBody(body)),
  });
}
export async function postAgentAiChat(
  s: Row,
  body: Row,
  signal: AbortSignal,
  feature: AiFeatureId = "assistant_chat",
) {
  const current = await readAgentAiConnection();
  if (!current || current.version !== s.version || !agentaiReady(current))
    fail(
      "AGENTAI_NOT_READY",
      "AgentAI 连接已变更或尚未验证，未提交旧连接请求",
      409,
    );
  const requested = canonicalAgentAiModel(body.model);
  if (!isAllowedAgentAiModel(requested, "chat"))
    fail("AGENTAI_MODEL_UNAVAILABLE", "该 AgentAI 型号已停用，请重新选择", 409);
  const model = (await modelsView(current)).find(
    (m) => m.type === "chat" && m.model === requested && m.available,
  );
  if (!model?.chatVerifiedAt)
    fail("AGENTAI_MODEL_UNVERIFIED", "此 AgentAI 型号尚未完成模型验证", 409);
  if (
    (body.tools?.length && !model.toolsVerifiedAt) ||
    (body.response_format && !model.structuredVerifiedAt)
  )
    fail(
      "AGENTAI_CAPABILITY_UNVERIFIED",
      "此型号尚未验证本次所需的工具或结构化输出能力",
      409,
    );
  return sendAgentAiChat(
    current,
    { ...body, model: requested },
    signal,
    feature,
  );
}

export async function testAgentAiModel(c: Context, input: unknown) {
  requireAIConfiguration(c);
  const b = parse(agentaiTestSchema, input),
    model = canonicalModel(b.model);
  const s = await agentaiConnection();
  if (
    !catalog(s).some(
      (m) => m.model === model && m.type === "chat" && m.available,
    )
  )
    fail("AGENTAI_MODEL_UNAVAILABLE", "请选择当前目录中的聊天型号", 400);
  const claim = await one(
    db,
    `UPDATE public.agentai_settings SET last_test_at=now() WHERE id=1 AND version=$1
    AND (last_test_at IS NULL OR last_test_at<now()-interval '2 seconds') RETURNING id`,
    s.version,
  );
  if (!claim) fail("AGENTAI_TEST_BUSY", "请稍候再验证，未重复提交", 409);
  const nonce = randomUUID();
  const schema = {
    type: "object",
    properties: { token: { type: "string", const: nonce } },
    required: ["token"],
    additionalProperties: false,
  };
  const probe: Row = {
    model,
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content:
          b.capability === "tools"
            ? `Call capability_probe exactly once with token ${nonce}. Do not execute any real action.`
            : b.capability === "structured"
              ? `Return a JSON object containing only token with value ${nonce}.`
              : `Reply with exactly this token and nothing else: ${nonce}`,
      },
    ],
  };
  const reasoning = catalog(s).find((m) => m.model === model)?.paramSchema
    ?.reasoning_effort as { enum?: unknown[] } | undefined;
  const effort = ["none", "minimal", "low"].find((item) =>
    reasoning?.enum?.includes(item),
  );
  if (effort) probe.reasoning_effort = effort;
  if (b.capability === "tools")
    Object.assign(probe, {
      tools: [
        {
          type: "function",
          function: {
            name: "capability_probe",
            description: "Read-only protocol probe; no action is executed",
            parameters: schema,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "capability_probe" } },
    });
  if (b.capability === "structured")
    probe.response_format = {
      type: "json_schema",
      json_schema: { name: "capability_probe", strict: true, schema },
    };
  const column = {
    chat: "chat_verified_at",
    tools: "tools_verified_at",
    structured: "structured_verified_at",
  }[b.capability];
  try {
    const signal = AbortSignal.timeout(60000);
    const response = await sendAgentAiChat(s, probe, signal);
    if (!response.ok) httpFailure(response);
    const result = await readJson(response, signal, 300 * 1024);
    if (result.model !== model || !result.id)
      fail("AGENTAI_MODEL_MISMATCH", "返回型号与请求不一致，未验证通过", 502);
    const choice = result.choices?.[0],
      message = choice?.message;
    if (!message || message.refusal || choice.finish_reason === "length")
      fail("AGENTAI_CAPABILITY_UNVERIFIED", "未返回完整能力验证结果", 502);
    let passed = false;
    if (b.capability === "chat")
      passed =
        typeof message.content === "string" && message.content.trim() === nonce;
    else {
      const tool = message.tool_calls?.[0];
      const raw =
        b.capability === "tools" ? tool?.function?.arguments : message.content;
      let parsed: unknown;
      try {
        parsed = typeof raw === "string" ? JSON.parse(raw) : undefined;
      } catch {
        /* not verified */
      }
      passed =
        z
          .object({ token: z.literal(nonce) })
          .strict()
          .safeParse(parsed).success &&
        (b.capability !== "tools" ||
          (message.tool_calls.length === 1 &&
            !!tool.id &&
            tool.function?.name === "capability_probe"));
    }
    if (!passed)
      fail(
        "AGENTAI_CAPABILITY_UNVERIFIED",
        "模型未按请求返回能力验证结果；未执行任何工具",
        502,
      );
    await db.$transaction(async (tx) => {
      const current = await one(
        tx,
        "SELECT id FROM public.agentai_settings WHERE id=1 AND enabled AND verified_at IS NOT NULL AND version=$1 FOR UPDATE",
        s.version,
      );
      if (!current)
        fail("VERSION_CONFLICT", "配置已变更，本次模型回执未用于新连接", 409);
      await tx.$executeRawUnsafe(
        `INSERT INTO public.agentai_model_verifications(model,settings_version,chat_verified_at,${b.capability === "chat" ? "error_note" : column})
        VALUES($1,$2,now(),${b.capability === "chat" ? "''" : "now()"}) ON CONFLICT(model) DO UPDATE SET settings_version=EXCLUDED.settings_version,
        chat_verified_at=now(), tools_verified_at=CASE WHEN ${b.capability === "tools" ? "true" : "false"} THEN now() WHEN agentai_model_verifications.settings_version=$2 THEN agentai_model_verifications.tools_verified_at ELSE NULL END,
        structured_verified_at=CASE WHEN ${b.capability === "structured" ? "true" : "false"} THEN now() WHEN agentai_model_verifications.settings_version=$2 THEN agentai_model_verifications.structured_verified_at ELSE NULL END,error_note=''`,
        model,
        s.version,
      );
    });
    return view((await readAgentAiConnection())!);
  } catch (error) {
    await db.$executeRawUnsafe(
      `UPDATE public.agentai_model_verifications SET ${column}=NULL,error_note=$3 WHERE model=$1 AND settings_version=$2`,
      model,
      s.version,
      safeNote(error),
    );
    throw error;
  }
}

export async function agentaiModelCandidates() {
  const s = await readAgentAiConnection();
  if (!s) return [];
  return (await modelsView(s))
    .filter((m) => m.type === "chat" && m.available)
    .map((m) => ({
      id: m.id,
      actual: m.model,
      provider: "agentai" as const,
      name: m.name + " · AgentAI",
      displayName: m.name + " · AgentAI",
      vision: m.vision,
      pdf: false,
      structured: !!m.structuredVerifiedAt,
      parameters: m.parameters,
      chatOnly: !m.toolsVerifiedAt || !m.structuredVerifiedAt,
      chatVerifiedAt: m.chatVerifiedAt,
    }));
}

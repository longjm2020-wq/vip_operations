import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import {
  db,
  one,
  rows,
  type Row,
} from "../../../../../packages/database/src/index.js";
import type {
  AgentAiModelPricing,
  AgentAiPriceChannel,
} from "../../../../../packages/contracts/src/agentai.js";
import type { AiFeatureId } from "../../../../../packages/contracts/src/ai-management.js";
import {
  classifySmartModel,
  defaultSmartFilterPolicy,
  evaluateAndAllocateSmartModels,
  relayProbeSchema,
  relayStationSaveSchema,
  scoreModelsForRole,
  smartApplySchema,
  smartCategoryLabels,
  smartModelCategories,
  smartFilterPolicySchema,
  smartPolicySaveSchema,
  smartPresetWeights,
  smartRoleMeta,
  smartWeightsSchema,
  type EvaluatedSmartModel,
  type RawChannelCandidate,
  type RelayStationModel,
  type RelayStationProtocol,
  type RelayStationView,
  type SmartAgentRole,
  type SmartChannelOverride,
  type SmartLocalTelemetry,
  type SmartModelCategory,
  type SmartModelsOverview,
  type SmartModelsSettingsState,
} from "../../../../../packages/contracts/src/smart-models.js";
import { audit, command, fail, parse, type Context } from "../../core.js";
import { aiFetch } from "../../ai-metering.js";
import { requireAIConfiguration } from "../analytics/ai.js";
import {
  decryptSecret,
  encryptSecret,
  encryptionReady,
} from "../analytics/secrets.js";
import {
  agentaiReady,
  normalizeAgentAiPrices,
  readAgentAiConnection,
} from "./agentai-connection.js";
import type { AgentInternalImageModel, AgentInternalModel } from "./agent-models.js";

const privateV4 = new BlockList();
const privateV6 = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  privateV4.addSubnet(ip, prefix, "ipv4");
}
for (const [ip, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  privateV6.addSubnet(ip, prefix, "ipv6");
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !privateV4.check(address, "ipv4")
    : family === 6 && !privateV6.check(address, "ipv6");
}

export function normalizeRelayBaseUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    fail("RELAY_URL_INVALID", "请输入有效的 HTTPS 中转站链接", 400);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail(
      "RELAY_URL_INVALID",
      "中转站链接须为不含账号密码及查询参数的 HTTPS 地址",
      400,
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (isIP(host) && !isPublicIpAddress(host))
  ) {
    fail("RELAY_URL_INVALID", "中转站链接必须指向公开网络地址", 400);
  }
  const trimmedPath = url.pathname.replace(/\/+$/, "");
  const path = !trimmedPath || trimmedPath === "/" ? "/v1" : trimmedPath;
  return `${url.origin}${path}`;
}

async function assertPublicRelayHost(baseUrl: string) {
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true }).catch(() => []);
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicIpAddress(item.address))
  ) {
    fail("RELAY_HOST_BLOCKED", "中转站域名未解析到可用的公开网络地址", 400);
  }
}

const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);
const safeText = (v: unknown, max = 120) =>
  typeof v === "string"
    ? v.replace(/[\u0000-\u001f<>]/g, "").slice(0, max)
    : "";
const nonnegative = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

function parseSettingsRow(row?: Row): SmartModelsSettingsState {
  const preset =
    row?.preset &&
    [
      "balanced",
      "quality_first",
      "speed_cost",
      "cost_first",
      "stability_first",
      "custom",
    ].includes(String(row.preset))
      ? (row.preset as SmartModelsSettingsState["preset"])
      : "balanced";
  const parsedWeights = smartWeightsSchema.safeParse(row?.weights);
  const parsedPolicy = smartFilterPolicySchema.safeParse(row?.filter_policy);
  const rolePolicies =
    row?.role_policies && typeof row.role_policies === "object"
      ? (row.role_policies as SmartModelsSettingsState["rolePolicies"])
      : {};
  const overrides = Array.isArray(row?.channel_overrides)
    ? (row.channel_overrides as SmartChannelOverride[])
    : [];
  return {
    enabled: row?.enabled !== false,
    preset,
    weights: parsedWeights.success
      ? parsedWeights.data
      : smartPresetWeights.balanced,
    filterPolicy: parsedPolicy.success
      ? parsedPolicy.data
      : defaultSmartFilterPolicy,
    rolePolicies,
    channelOverrides: overrides,
    version: Number(row?.version || 1),
  };
}

export async function readSmartModelSettings(): Promise<SmartModelsSettingsState> {
  try {
    const row = await one(
      db,
      "SELECT * FROM public.smart_model_settings WHERE id=1",
    );
    return parseSettingsRow(row);
  } catch {
    return parseSettingsRow(undefined);
  }
}

function stationView(row: Row): RelayStationView {
  const models: RelayStationModel[] = Array.isArray(row.models_snapshot)
    ? row.models_snapshot
    : [];
  const probeStats =
    row.probe_stats && typeof row.probe_stats === "object"
      ? (row.probe_stats as Record<string, Row>)
      : {};
  const enrichedModels = models.map((m) => {
    const probe = probeStats[m.model];
    return {
      ...m,
      verifiedAt: probe?.verifiedAt ? String(probe.verifiedAt) : m.verifiedAt || null,
      lastLatencyMs:
        typeof probe?.latencyMs === "number" ? probe.latencyMs : m.lastLatencyMs ?? null,
    };
  });
  const counts: Record<SmartModelCategory, number> = {
    chat: 0,
    image: 0,
    video: 0,
    audio: 0,
    other: 0,
  };
  for (const m of enrichedModels) {
    if (smartModelCategories.includes(m.category)) counts[m.category] += 1;
    else counts.other += 1;
  }
  return {
    id: String(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    protocol: (row.protocol as RelayStationProtocol) || "auto",
    enabled: Boolean(row.enabled),
    apiKeyConfigured: Boolean(row.api_key_encrypted),
    verifiedAt: iso(row.verified_at),
    catalogAt: iso(row.catalog_at),
    pricesAt: iso(row.prices_at),
    errorNote: String(row.error_note || ""),
    version: Number(row.version || 1),
    modelCount: enrichedModels.length,
    categoryCounts: counts,
    models: enrichedModels,
  };
}

export async function listRelayStations(): Promise<RelayStationView[]> {
  try {
    const list = await rows(
      db,
      "SELECT * FROM public.ai_relay_stations ORDER BY created_at ASC, id ASC",
    );
    return list.map(stationView);
  } catch {
    return [];
  }
}

export async function saveSmartModelPolicy(
  c: Context,
  input: unknown,
): Promise<SmartModelsOverview> {
  requireAIConfiguration(c);
  const b = parse(smartPolicySaveSchema, input);
  await command(c, "smart-models.policy", b, async (tx) => {
    await tx.$executeRawUnsafe(
      "INSERT INTO public.smart_model_settings(id) VALUES(1) ON CONFLICT DO NOTHING",
    );
    const old = (await one(
      tx,
      "SELECT * FROM public.smart_model_settings WHERE id=1 FOR UPDATE",
    ))!;
    if (Number(old.version) !== b.version) {
      fail("VERSION_CONFLICT", "智选模型策略已被其他管理员修改，请刷新核对", 409);
    }
    const nextWeights =
      b.preset === "custom" ? b.weights : smartPresetWeights[b.preset];
    await one(
      tx,
      `UPDATE public.smart_model_settings
       SET enabled=$1, preset=$2, weights=$3::jsonb, filter_policy=$4::jsonb,
           role_policies=$5::jsonb, channel_overrides=$6::jsonb,
           version=version+1, updated_by=$7::bigint, updated_at=now()
       WHERE id=1 RETURNING *`,
      b.enabled,
      b.preset,
      JSON.stringify(nextWeights),
      JSON.stringify(b.filterPolicy),
      JSON.stringify(b.rolePolicies),
      JSON.stringify(b.channelOverrides),
      c.actor.id,
    );
    await audit(
      tx,
      c,
      "SMART_MODEL_POLICY",
      "smart_model_settings",
      1,
      { preset: old.preset, enabled: old.enabled },
      { preset: b.preset, enabled: b.enabled },
    );
    return { version: b.version + 1 };
  });
  return readSmartModelsOverview(c);
}

export async function saveRelayStation(
  c: Context,
  input: unknown,
): Promise<RelayStationView> {
  requireAIConfiguration(c);
  const b = parse(relayStationSaveSchema, input);
  const baseUrl = normalizeRelayBaseUrl(b.baseUrl);
  const derivedName = b.name?.trim() || new URL(baseUrl).hostname;
  if (b.clearKey && b.apiKey) {
    fail("RELAY_KEY_INVALID", "填写新密钥与清除密钥不能同时进行", 400);
  }
  if ((b.apiKey || b.enabled) && !encryptionReady()) {
    fail("MAIL_KEY_MISSING", "服务器尚未配置凭据加密密钥，请联系管理员", 503);
  }
  const saved = await command(
    c,
    "smart-models.station",
    { ...b, baseUrl, name: derivedName, apiKey: b.apiKey ? "[set]" : "" },
    async (tx) => {
      if (b.id) {
        const old = await one(
          tx,
          "SELECT * FROM public.ai_relay_stations WHERE id=$1::uuid FOR UPDATE",
          b.id,
        );
        if (!old) fail("NOT_FOUND", "算力中转站不存在", 404);
        if (Number(old.version) !== b.version) {
          fail("VERSION_CONFLICT", "中转站配置已被修改，请刷新后重试", 409);
        }
        const keyChanged = Boolean(b.apiKey || b.clearKey);
        const urlChanged = String(old.base_url) !== baseUrl;
        const encrypted = b.clearKey
          ? null
          : b.apiKey
            ? encryptSecret(b.apiKey)
            : old.api_key_encrypted;
        if (b.enabled && !encrypted) {
          fail("RELAY_KEY_MISSING", "启用中转站前请先填写 API Key", 400);
        }
        const row = (await one(
          tx,
          `UPDATE public.ai_relay_stations
           SET name=$2, base_url=$3, protocol=$4, enabled=$5, api_key_encrypted=$6,
               verified_at=CASE WHEN $7 THEN NULL ELSE verified_at END,
               catalog_at=CASE WHEN $7 THEN NULL ELSE catalog_at END,
               prices_at=CASE WHEN $7 THEN NULL ELSE prices_at END,
               error_note=CASE WHEN $7 THEN '' ELSE error_note END,
               probe_stats=CASE WHEN $7 THEN '{}'::jsonb ELSE probe_stats END,
               version=version+1, updated_by=$8::bigint, updated_at=now()
           WHERE id=$1::uuid RETURNING *`,
          b.id,
          derivedName,
          baseUrl,
          b.protocol,
          b.enabled && Boolean(encrypted),
          encrypted,
          keyChanged || urlChanged,
          c.actor.id,
        ))!;
        await audit(
          tx,
          c,
          "RELAY_STATION_SAVE",
          "ai_relay_stations",
          b.id,
          { name: old.name, baseUrl: old.base_url, enabled: old.enabled },
          { name: row.name, baseUrl: row.base_url, enabled: row.enabled },
        );
        return row;
      }

      if (!b.apiKey) {
        fail("RELAY_KEY_MISSING", "新增中转站请填写 API Key", 400);
      }
      const id = randomUUID();
      const encrypted = encryptSecret(b.apiKey);
      const row = (await one(
        tx,
        `INSERT INTO public.ai_relay_stations
         (id, name, base_url, protocol, enabled, api_key_encrypted, created_by, updated_by)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::bigint, $7::bigint)
         RETURNING *`,
        id,
        derivedName,
        baseUrl,
        b.protocol,
        b.enabled,
        encrypted,
        c.actor.id,
      ))!;
      await audit(
        tx,
        c,
        "RELAY_STATION_CREATE",
        "ai_relay_stations",
        id,
        null,
        { name: row.name, baseUrl: row.base_url, enabled: row.enabled },
      );
      return row;
    },
  );
  return stationView(saved);
}

async function readBoundedJson(response: Response, maxBytes: number) {
  if (!response.body) {
    fail("RELAY_RESPONSE_INVALID", "中转站返回空响应", 502);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        fail("RELAY_RESPONSE_INVALID", "中转站返回目录超过大小限制", 502);
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Row;
  } catch (error) {
    if ((error as { getResponse?: unknown })?.getResponse) throw error;
    fail("RELAY_RESPONSE_INVALID", "中转站返回的数据不是有效 JSON", 502);
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function parseOpenAiModelChannels(
  item: Row,
  stationName: string,
  category: SmartModelCategory,
): AgentAiPriceChannel[] {
  if (Array.isArray(item.channel_groups) && item.channel_groups.length) {
    const groups = item.channel_groups
      .slice(0, 150)
      .flatMap((g: Row): AgentAiPriceChannel[] => {
        if (!g || g.is_active === false) return [];
        const rate = nonnegative(g.success_rate_24h);
        const source =
          g.stats_source === "live" || g.stats_source === "estimate"
            ? g.stats_source
            : "unknown";
        return [
          {
            vendor: safeText(g.vendor, 60) || stationName,
            laneNo:
              typeof g.lane_no === "number" && Number.isSafeInteger(g.lane_no)
                ? g.lane_no
                : null,
            billingUnit: safeText(g.billing_unit, 40) || "token",
            billingMethod: safeText(g.billing_method, 40) || "按量计费",
            defaultTotalRmb: nonnegative(g.user_price_rmb),
            billedSeconds: nonnegative(g.billed_seconds),
            inputPerMillionRmb: nonnegative(g.user_price_per_million_input_rmb),
            outputPerMillionRmb: nonnegative(g.user_price_per_million_output_rmb),
            successRate24h:
              source === "live" && rate !== null && rate <= 100 ? rate : null,
            avgResponseSeconds:
              source === "live" ? nonnegative(g.avg_response_seconds) : null,
            statsSource: source,
          },
        ];
      });
    if (groups.length) return groups;
  }

  const inputRmb = nonnegative(item.user_price_per_million_input_rmb);
  const outputRmb = nonnegative(item.user_price_per_million_output_rmb);
  const totalRmb = nonnegative(item.user_price_rmb);
  const statsSource =
    item.stats_source === "live" || item.stats_source === "estimate"
      ? item.stats_source
      : "unknown";
  const rate = nonnegative(item.success_rate_24h);
  return [
    {
      vendor: safeText(item.owned_by || item.vendor, 60) || stationName,
      laneNo: null,
      billingUnit: category === "chat" ? "token" : "per_request",
      billingMethod: category === "chat" ? "按Token" : "按次/按量",
      defaultTotalRmb: totalRmb,
      billedSeconds: null,
      inputPerMillionRmb: inputRmb,
      outputPerMillionRmb: outputRmb,
      successRate24h:
        statsSource === "live" && rate !== null && rate <= 100 ? rate : null,
      avgResponseSeconds:
        statsSource === "live" ? nonnegative(item.avg_response_seconds) : null,
      statsSource,
    },
  ];
}

export async function syncRelayStation(
  c: Context,
  stationId: string,
): Promise<RelayStationView> {
  requireAIConfiguration(c);
  if (!encryptionReady()) {
    fail("MAIL_KEY_MISSING", "服务器尚未配置凭据加密密钥", 503);
  }
  const station = await one(
    db,
    "SELECT * FROM public.ai_relay_stations WHERE id=$1::uuid",
    stationId,
  );
  if (!station) fail("NOT_FOUND", "算力中转站不存在", 404);
  if (!station.api_key_encrypted) {
    fail("RELAY_KEY_MISSING", "请先保存该中转站的 API Key", 400);
  }
  const baseUrl = normalizeRelayBaseUrl(String(station.base_url));
  await assertPublicRelayHost(baseUrl);
  const apiKey = decryptSecret(String(station.api_key_encrypted));
  const signal = AbortSignal.timeout(25000);

  try {
    const modelsRes = await fetch(`${baseUrl}/models`, {
      redirect: "error",
      signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!modelsRes.ok) {
      void modelsRes.body?.cancel().catch(() => {});
      fail(
        "RELAY_SYNC_FAILED",
        `中转站模型目录拉取失败（HTTP ${modelsRes.status}），请核对链接与密钥`,
        502,
      );
    }
    const modelsJson = await readBoundedJson(modelsRes, 4 * 1024 * 1024);
    const list: Row[] = Array.isArray(modelsJson.data)
      ? modelsJson.data
      : Array.isArray(modelsJson.models)
        ? modelsJson.models
        : [];
    if (!list.length) {
      fail("RELAY_RESPONSE_INVALID", "中转站未返回可用模型列表", 502);
    }

    let detectedProtocol: RelayStationProtocol =
      station.protocol === "openai" ? "openai" : "openai";
    const logicalById = new Map<string, Row>();
    const pricingByModel = new Map<string, AgentAiModelPricing>();

    if (station.protocol !== "openai") {
      const [logicalRes, pricingRes] = await Promise.allSettled([
        fetch(`${baseUrl}/logical-models`, { redirect: "error", signal }),
        fetch(`${baseUrl}/skills/pricing?status=active`, {
          redirect: "error",
          signal,
          headers: { Authorization: `Bearer ${apiKey}` },
        }),
      ]);
      if (logicalRes.status === "fulfilled" && logicalRes.value.ok) {
        const logicalJson = await readBoundedJson(
          logicalRes.value,
          3 * 1024 * 1024,
        ).catch(() => null);
        if (Array.isArray(logicalJson?.models)) {
          detectedProtocol = "agentai";
          for (const lm of logicalJson.models as Row[]) {
            if (typeof lm?.id === "string") logicalById.set(lm.id, lm);
            if (typeof lm?.public_id === "string")
              logicalById.set(lm.public_id, lm);
          }
        }
      }
      if (pricingRes.status === "fulfilled" && pricingRes.value.ok) {
        const pricingJson = await readBoundedJson(
          pricingRes.value,
          4 * 1024 * 1024,
        ).catch(() => null);
        if (Array.isArray(pricingJson?.models)) {
          detectedProtocol = "agentai";
          for (const entry of pricingJson.models as Row[]) {
            const name = safeText(entry?.name || entry?.id, 140);
            if (!name || !Array.isArray(entry.channel_groups)) continue;
            const channels = parseOpenAiModelChannels(
              entry,
              String(station.name),
              classifySmartModel(name),
            );
            pricingByModel.set(name, {
              currency: "CNY",
              generatedAt: pricingJson.generated_at
                ? iso(pricingJson.generated_at)
                : null,
              channels,
            });
          }
          try {
            // Merge canonical AgentAI pricing normalization for recognized models.
            for (const item of normalizeAgentAiPrices(pricingJson)) {
              if (!pricingByModel.has(item.model)) {
                pricingByModel.set(item.model, item.pricing);
              }
            }
          } catch {
            /* Generic relay stations may not contain AgentAI's 20 curated models. */
          }
        }
      }
    }

    const seen = new Set<string>();
    const normalizedModels: RelayStationModel[] = [];
    for (const rawItem of list.slice(0, 600)) {
      const modelId = safeText(rawItem?.id || rawItem?.model, 160);
      if (!modelId || seen.has(modelId) || modelId.includes("://")) continue;
      if (rawItem?.deprecated === true || rawItem?.available === false) continue;
      seen.add(modelId);

      const lm = logicalById.get(modelId);
      const explicitType = safeText(
        lm?.category || rawItem?.category || rawItem?.type,
        30,
      );
      const outputModalities = Array.isArray(rawItem?.architecture?.output_modalities)
        ? rawItem.architecture.output_modalities
        : undefined;
      const inputModalities = Array.isArray(rawItem?.architecture?.input_modalities)
        ? rawItem.architecture.input_modalities
        : undefined;
      const endpointTypes = Array.isArray(rawItem?.supported_endpoint_types)
        ? rawItem.supported_endpoint_types
        : undefined;

      const category = classifySmartModel(
        modelId,
        explicitType,
        outputModalities,
        endpointTypes,
      );
      const capabilities = Array.isArray(lm?.capabilities)
        ? lm.capabilities
        : Array.isArray(rawItem?.capabilities)
          ? rawItem.capabilities
          : [];
      const supportedParams = Array.isArray(lm?.supported_parameters)
        ? lm.supported_parameters
        : Array.isArray(rawItem?.supported_parameters)
          ? rawItem.supported_parameters
          : [];

      const vision =
        capabilities.includes("vision") ||
        (inputModalities?.includes("image") ?? false);
      const tools =
        supportedParams.includes("tools") ||
        capabilities.includes("tools") ||
        category === "chat";
      const structured =
        supportedParams.includes("structured_outputs") ||
        supportedParams.includes("response_format") ||
        capabilities.includes("structured_outputs");

      const pricing =
        pricingByModel.get(modelId) ||
        (lm?.public_id ? pricingByModel.get(String(lm.public_id)) : undefined);
      const channels =
        pricing?.channels?.length
          ? pricing.channels
          : parseOpenAiModelChannels(rawItem, String(station.name), category);

      normalizedModels.push({
        model: modelId,
        name: safeText(lm?.display_name || rawItem?.name || modelId, 120) || modelId,
        category,
        available: true,
        vision,
        tools,
        structured,
        channels,
      });
    }

    if (!normalizedModels.length) {
      fail("RELAY_RESPONSE_INVALID", "未解析出可用模型", 502);
    }

    const updated = (await one(
      db,
      `UPDATE public.ai_relay_stations
       SET protocol=$2, verified_at=now(), catalog_at=now(),
           prices_at=CASE WHEN $3 THEN now() ELSE prices_at END,
           models_snapshot=$4::jsonb, error_note='', updated_by=$5::bigint, updated_at=now()
       WHERE id=$1::uuid AND version=$6
       RETURNING *`,
      stationId,
      station.protocol === "auto" ? detectedProtocol : station.protocol,
      pricingByModel.size > 0,
      JSON.stringify(normalizedModels),
      c.actor.id,
      station.version,
    ))!;
    if (!updated) {
      fail("VERSION_CONFLICT", "中转站配置已变更，请刷新后重试同步", 409);
    }
    return stationView(updated);
  } catch (error) {
    const note =
      error instanceof Error
        ? safeText(error.message, 200)
        : "中转站目录同步失败，请检查链接和密钥";
    await one(
      db,
      "UPDATE public.ai_relay_stations SET error_note=$2, updated_at=now() WHERE id=$1::uuid RETURNING id",
      stationId,
      note,
    ).catch(() => {});
    throw error;
  }
}

export async function probeRelayStationModel(
  c: Context,
  stationId: string,
  input: unknown,
): Promise<RelayStationView> {
  requireAIConfiguration(c);
  if (!encryptionReady()) {
    fail("MAIL_KEY_MISSING", "服务器尚未配置凭据加密密钥", 503);
  }
  const b = parse(relayProbeSchema, input);
  const station = await one(
    db,
    "SELECT * FROM public.ai_relay_stations WHERE id=$1::uuid",
    stationId,
  );
  if (!station) fail("NOT_FOUND", "算力中转站不存在", 404);
  if (!station.enabled || !station.api_key_encrypted) {
    fail("RELAY_NOT_READY", "请先启用该中转站并保存密钥", 409);
  }
  const models: RelayStationModel[] = Array.isArray(station.models_snapshot)
    ? station.models_snapshot
    : [];
  const target = models.find((m) => m.model === b.model);
  if (!target || target.category !== "chat") {
    fail("RELAY_MODEL_INVALID", "请选择已解析目录中的聊天模型进行测速验证", 400);
  }

  const baseUrl = normalizeRelayBaseUrl(String(station.base_url));
  await assertPublicRelayHost(baseUrl);
  const apiKey = decryptSecret(String(station.api_key_encrypted));
  const nonce = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(45000);

  try {
    const res = await aiFetch("assistant_chat", `${baseUrl}/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: b.model,
        max_tokens: 32,
        stream: false,
        messages: [
          {
            role: "user",
            content: `Reply with exactly this token: ${nonce}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      fail(
        "RELAY_PROBE_FAILED",
        `中转站测速失败（HTTP ${res.status}），请核对模型权限或余额`,
        502,
      );
    }
    const payload = await readBoundedJson(res, 256 * 1024);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.includes(nonce)) {
      fail("RELAY_PROBE_FAILED", "模型返回内容未通过校验，未标记已验证", 502);
    }
    const latencyMs = Math.max(1, Date.now() - startedAt);
    const probeStats =
      station.probe_stats && typeof station.probe_stats === "object"
        ? { ...(station.probe_stats as Record<string, unknown>) }
        : {};
    probeStats[b.model] = {
      verifiedAt: new Date().toISOString(),
      latencyMs,
      status: "success",
    };
    const updated = (await one(
      db,
      "UPDATE public.ai_relay_stations SET probe_stats=$2::jsonb, updated_at=now() WHERE id=$1::uuid RETURNING *",
      stationId,
      JSON.stringify(probeStats),
    ))!;
    return stationView(updated);
  } catch (error) {
    const probeStats =
      station.probe_stats && typeof station.probe_stats === "object"
        ? { ...(station.probe_stats as Record<string, unknown>) }
        : {};
    probeStats[b.model] = {
      verifiedAt: null,
      latencyMs: Date.now() - startedAt,
      status: "failed",
    };
    await one(
      db,
      "UPDATE public.ai_relay_stations SET probe_stats=$2::jsonb, updated_at=now() WHERE id=$1::uuid RETURNING id",
      stationId,
      JSON.stringify(probeStats),
    ).catch(() => {});
    throw error;
  }
}

export async function deleteRelayStation(c: Context, stationId: string) {
  requireAIConfiguration(c);
  await command(c, "smart-models.station.delete", { stationId }, async (tx) => {
    const old = await one(
      tx,
      "SELECT id, name, base_url FROM public.ai_relay_stations WHERE id=$1::uuid FOR UPDATE",
      stationId,
    );
    if (!old) fail("NOT_FOUND", "算力中转站不存在", 404);
    await tx.$executeRawUnsafe(
      "DELETE FROM public.ai_relay_stations WHERE id=$1::uuid",
      stationId,
    );
    await audit(
      tx,
      c,
      "RELAY_STATION_DELETE",
      "ai_relay_stations",
      stationId,
      { name: old.name, baseUrl: old.base_url },
      null,
    );
    return { deleted: true, id: stationId };
  });
  return { deleted: true, id: stationId };
}

async function readLocalTelemetryMap(): Promise<Map<string, SmartLocalTelemetry>> {
  const map = new Map<string, SmartLocalTelemetry>();
  try {
    const stats = await rows(
      db,
      `SELECT source, model,
        count(*)::int AS requests,
        count(*) FILTER (WHERE status IN ('success', 'responded'))::int AS succeeded,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        avg(EXTRACT(EPOCH FROM (completed_at - started_at)))
          FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL AND status IN ('success', 'responded')) AS avg_latency,
        avg(amount) FILTER (WHERE amount IS NOT NULL AND amount_unit = 'CNY') AS avg_cost_rmb
       FROM public.ai_model_usage
       WHERE started_at >= now() - interval '7 days'
         AND status IN ('success', 'responded', 'failed')
       GROUP BY source, model`,
    );
    const recentRows = await rows(
      db,
      `SELECT source, model, status, error_code
       FROM (
         SELECT source, model, status, error_code,
           row_number() OVER (PARTITION BY source, model ORDER BY started_at DESC, id DESC) AS rn
         FROM public.ai_model_usage
         WHERE started_at >= now() - interval '7 days'
           AND status IN ('success', 'responded', 'failed')
       ) ranked
       WHERE rn <= 5`,
    );
    const streakMap = new Map<string, { consecutiveFailures: number; lastError: string | null }>();
    const groupedRecent = new Map<string, Row[]>();
    for (const r of recentRows) {
      const key = `${r.source}:${r.model}`;
      const list = groupedRecent.get(key) || [];
      list.push(r);
      groupedRecent.set(key, list);
    }
    for (const [key, list] of groupedRecent.entries()) {
      let consecutiveFailures = 0;
      for (const item of list) {
        if (item.status === "failed") consecutiveFailures += 1;
        else break;
      }
      const firstFail = list.find((item) => item.status === "failed");
      streakMap.set(key, {
        consecutiveFailures,
        lastError: firstFail?.error_code ? String(firstFail.error_code) : null,
      });
    }

    for (const row of stats) {
      const key = `${row.source}:${row.model}`;
      const requests = Number(row.requests || 0);
      const succeeded = Number(row.succeeded || 0);
      const failed = Number(row.failed || 0);
      const streak = streakMap.get(key);
      map.set(key, {
        requests,
        succeeded,
        failed,
        successRate: requests > 0 ? Math.round((succeeded / requests) * 1000) / 10 : null,
        avgLatencySeconds:
          row.avg_latency !== null && row.avg_latency !== undefined
            ? Math.round(Number(row.avg_latency) * 100) / 100
            : null,
        consecutiveFailures: streak?.consecutiveFailures || 0,
        avgCostRmb:
          row.avg_cost_rmb !== null && row.avg_cost_rmb !== undefined
            ? Number(row.avg_cost_rmb)
            : null,
        lastError: streak?.lastError || null,
      });
    }
  } catch {
    /* Minimal unit tests may omit full telemetry fixtures. */
  }
  return map;
}

async function collectRawChannelCandidates(): Promise<{
  rawChannels: RawChannelCandidate[];
  stations: RelayStationView[];
}> {
  const [agentai, openrouter, bailian, stations, telemetry] = await Promise.all([
    readAgentAiConnection().catch(() => undefined),
    one(
      db,
      "SELECT enabled, api_key_encrypted IS NOT NULL AS configured, verified_at FROM public.compass_ai_settings WHERE id=1",
    ).catch(() => undefined),
    one(
      db,
      "SELECT enabled, workspace_id, api_key_encrypted IS NOT NULL AS configured, verified_at FROM public.bailian_chat_settings WHERE id=1",
    ).catch(() => undefined),
    listRelayStations(),
    readLocalTelemetryMap(),
  ]);

  const rawChannels: RawChannelCandidate[] = [];

  // 1. AgentAI models & channels
  if (agentai) {
    const isReady = agentaiReady(agentai);
    let checks: Row[] = [];
    try {
      checks = await rows(
        db,
        "SELECT * FROM public.agentai_model_verifications WHERE settings_version=$1",
        agentai.version,
      );
    } catch {
      checks = [];
    }
    const catalogModels: Row[] = Array.isArray(agentai.model_catalog)
      ? agentai.model_catalog
      : [];
    const prices: { model: string; pricing: AgentAiModelPricing }[] =
      Array.isArray(agentai.model_prices) ? agentai.model_prices : [];

    for (const m of catalogModels) {
      if (!m?.model) continue;
      const category = classifySmartModel(String(m.model), String(m.type || ""));
      const check = checks.find((v) => v.model === m.model);
      const verified =
        category === "chat" ? Boolean(isReady && check?.chat_verified_at) : isReady;
      const pricing = prices.find((p) => p.model === m.model)?.pricing;
      const localStats =
        telemetry.get(`agentai.token6688.com:${m.model}`) || null;
      const channels = pricing?.channels?.length
        ? pricing.channels
        : [
            {
              vendor: "AgentAI",
              laneNo: null,
              billingUnit: category === "chat" ? "token" : "per_request",
              billingMethod: "智能调度",
              defaultTotalRmb: null,
              billedSeconds: null,
              inputPerMillionRmb: null,
              outputPerMillionRmb: null,
              successRate24h: null,
              avgResponseSeconds: null,
              statsSource: "unknown" as const,
            },
          ];

      channels.forEach((ch, idx) => {
        rawChannels.push({
          channelKey: `agentai:${m.model}:${ch.vendor || "default"}:${ch.laneNo ?? idx}`,
          stationId: "agentai",
          stationName: "AgentAI",
          stationKind: "agentai",
          modelId: String(m.model),
          modelRef: `agentai/${m.model}`,
          modelName: String(m.name || m.model),
          category,
          available: Boolean(isReady && m.available !== false),
          vision: Boolean(m.vision),
          tools: Boolean(isReady && check?.tools_verified_at),
          structured: Boolean(isReady && check?.structured_verified_at),
          verified,
          vendor: ch.vendor || "AgentAI",
          laneNo: ch.laneNo ?? null,
          billingUnit: ch.billingUnit || "",
          billingMethod: ch.billingMethod || "",
          defaultTotalRmb: ch.defaultTotalRmb,
          inputPerMillionRmb: ch.inputPerMillionRmb,
          outputPerMillionRmb: ch.outputPerMillionRmb,
          successRate24h: ch.successRate24h,
          avgResponseSeconds: ch.avgResponseSeconds,
          statsSource: ch.statsSource,
          localTelemetry: localStats,
        });
      });
    }
  }

  // 2. Custom relay stations
  for (const st of stations) {
    if (!st.enabled) continue;
    const hostname = new URL(st.baseUrl).hostname;
    for (const m of st.models) {
      const localStats = telemetry.get(`${hostname}:${m.model}`) || null;
      const modelVerified =
        m.category === "chat" ? Boolean(m.verifiedAt) : Boolean(st.verifiedAt);
      const channels = m.channels?.length
        ? m.channels
        : [
            {
              vendor: st.name,
              laneNo: null,
              billingUnit: m.category === "chat" ? "token" : "per_request",
              billingMethod: "默认渠道",
              defaultTotalRmb: null,
              billedSeconds: null,
              inputPerMillionRmb: null,
              outputPerMillionRmb: null,
              successRate24h: null,
              avgResponseSeconds:
                m.lastLatencyMs && m.lastLatencyMs > 0
                  ? Math.round((m.lastLatencyMs / 1000) * 100) / 100
                  : null,
              statsSource:
                m.lastLatencyMs && m.lastLatencyMs > 0
                  ? ("live" as const)
                  : ("unknown" as const),
            },
          ];

      channels.forEach((ch, idx) => {
        const measuredSeconds =
          ch.statsSource === "live" && ch.avgResponseSeconds !== null
            ? ch.avgResponseSeconds
            : m.lastLatencyMs && m.lastLatencyMs > 0
              ? Math.round((m.lastLatencyMs / 1000) * 100) / 100
              : null;
        rawChannels.push({
          channelKey: `relay:${st.id}:${m.model}:${ch.vendor || "default"}:${ch.laneNo ?? idx}`,
          stationId: st.id,
          stationName: st.name,
          stationKind: "relay",
          modelId: m.model,
          modelRef: `relay/${st.id}/${m.model}`,
          modelName: m.name,
          category: m.category,
          available: Boolean(st.enabled && m.available),
          vision: m.vision,
          tools: m.tools,
          structured: m.structured,
          verified: modelVerified,
          vendor: ch.vendor || st.name,
          laneNo: ch.laneNo ?? null,
          billingUnit: ch.billingUnit || "",
          billingMethod: ch.billingMethod || "",
          defaultTotalRmb: ch.defaultTotalRmb,
          inputPerMillionRmb: ch.inputPerMillionRmb,
          outputPerMillionRmb: ch.outputPerMillionRmb,
          successRate24h: ch.successRate24h,
          avgResponseSeconds: measuredSeconds,
          statsSource:
            ch.statsSource === "live"
              ? "live"
              : measuredSeconds !== null
                ? "live"
                : ch.statsSource,
          localTelemetry: localStats,
        });
      });
    }
  }

  // 3. Built-in OpenRouter & Bailian baseline signals (from local telemetry)
  if (openrouter?.enabled && openrouter.configured && openrouter.verified_at) {
    const seenOr = new Set<string>();
    for (const [key, localStats] of telemetry.entries()) {
      if (!key.startsWith("openrouter.ai:")) continue;
      const modelId = key.slice("openrouter.ai:".length);
      if (!modelId || seenOr.has(modelId)) continue;
      seenOr.add(modelId);
      const category = classifySmartModel(modelId);
      rawChannels.push({
        channelKey: `openrouter:${modelId}`,
        stationId: "openrouter",
        stationName: "OpenRouter",
        stationKind: "openrouter",
        modelId,
        modelRef: modelId,
        modelName: modelId.split("/").at(-1) || modelId,
        category,
        available: true,
        vision: category === "chat" || category === "image",
        tools: category === "chat",
        structured: category === "chat",
        verified: localStats.succeeded > 0,
        vendor: "OpenRouter",
        laneNo: null,
        billingUnit: "credits",
        billingMethod: "OpenRouter 账单",
        defaultTotalRmb: null,
        inputPerMillionRmb: null,
        outputPerMillionRmb: null,
        successRate24h: localStats.successRate,
        avgResponseSeconds: localStats.avgLatencySeconds,
        statsSource: localStats.requests > 0 ? "live" : "unknown",
        localTelemetry: localStats,
      });
    }
  }

  if (
    bailian?.enabled &&
    bailian.configured &&
    bailian.verified_at &&
    bailian.workspace_id
  ) {
    const source = `${bailian.workspace_id}.cn-beijing.maas.aliyuncs.com`;
    const bailianModel = "deepseek-v4.1-flash-1017";
    const localStats = telemetry.get(`${source}:${bailianModel}`) || null;
    rawChannels.push({
      channelKey: `bailian:${bailianModel}`,
      stationId: "bailian",
      stationName: "阿里云百炼",
      stationKind: "bailian",
      modelId: bailianModel,
      modelRef: `bailian/${bailianModel}`,
      modelName: "DeepSeek V4.1 Flash · 百炼",
      category: "chat",
      available: true,
      vision: true,
      tools: true,
      structured: false,
      verified: true,
      vendor: "阿里云百炼 · 北京",
      laneNo: null,
      billingUnit: "token",
      billingMethod: "按Token",
      defaultTotalRmb: null,
      inputPerMillionRmb: null,
      outputPerMillionRmb: null,
      successRate24h: localStats?.successRate ?? null,
      avgResponseSeconds: localStats?.avgLatencySeconds ?? null,
      statsSource: localStats && localStats.requests > 0 ? "live" : "unknown",
      localTelemetry: localStats,
    });
  }

  return { rawChannels, stations };
}

export async function readSmartModelsOverview(
  c: Context,
): Promise<SmartModelsOverview> {
  requireAIConfiguration(c);
  const [settings, { rawChannels, stations }] = await Promise.all([
    readSmartModelSettings(),
    collectRawChannelCandidates(),
  ]);
  const evaluated = evaluateAndAllocateSmartModels(rawChannels, settings);
  return {
    settings,
    encryptionReady: encryptionReady(),
    stations,
    models: evaluated.models,
    roleAllocations: evaluated.roleAllocations,
    summary: evaluated.summary,
    generatedAt: new Date().toISOString(),
  };
}

export async function applySmartAllocations(
  c: Context,
  input: unknown = {},
): Promise<{
  applied: { feature: AiFeatureId; model: string; label: string; reason: string }[];
  skipped: { feature: AiFeatureId; reason: string }[];
}> {
  requireAIConfiguration(c);
  const b = parse(smartApplySchema, input);
  const overview = await readSmartModelsOverview(c);
  const { aiModelManagement, saveAiFeatureModel } = await import(
    "../../ai-model-management.js"
  );
  const currentMgmt = await aiModelManagement(c);

  const targets: {
    feature: AiFeatureId;
    role: SmartAgentRole;
  }[] = [
    { feature: "assistant_chat", role: "executor" },
    { feature: "assistant_employee", role: "orchestrator" },
    { feature: "compass_analysis", role: "orchestrator" },
    { feature: "product_titles", role: "executor" },
    { feature: "product_standards", role: "orchestrator" },
    { feature: "aigc_compile", role: "orchestrator" },
    { feature: "aigc_image", role: "image_design" },
    { feature: "aigc_video", role: "video_production" },
  ];

  const requestedRoles = b.roles ? new Set(b.roles) : null;
  const applied: {
    feature: AiFeatureId;
    model: string;
    label: string;
    reason: string;
  }[] = [];
  const skipped: { feature: AiFeatureId; reason: string }[] = [];

  for (const target of targets) {
    if (requestedRoles && !requestedRoles.has(target.role)) continue;
    const row = currentMgmt.features.find((f) => f.id === target.feature);
    const allocation = overview.roleAllocations.find(
      (a) => a.role === target.role,
    );
    if (!row || row.mode !== "select") {
      skipped.push({
        feature: target.feature,
        reason: "该功能不支持下拉切换默认值",
      });
      continue;
    }

    const candidates: EvaluatedSmartModel[] = [
      ...(allocation?.primary ? [allocation.primary] : []),
      ...(allocation?.backup ? [allocation.backup] : []),
      ...overview.models.filter(
        (m) => m.category === allocation?.category && !m.shielded,
      ),
    ];

    let matchedChoice = undefined;
    let matchedModel: EvaluatedSmartModel | undefined;
    for (const candidate of candidates) {
      matchedChoice = row.choices.find(
        (ch) =>
          ch.available &&
          (ch.value === candidate.modelRef ||
            ch.value.endsWith(`|${candidate.modelId}`) ||
            ch.value === candidate.modelId ||
            (candidate.stationKind === "agentai" &&
              ch.value === `agentai|${candidate.modelId}`)),
      );
      if (matchedChoice) {
        matchedModel = candidate;
        break;
      }
    }

    if (!matchedChoice || !matchedModel) {
      skipped.push({
        feature: target.feature,
        reason: `暂无已验证且满足「${row.name}」能力边界的${smartCategoryLabels[allocation?.category || "chat"]}渠道`,
      });
      continue;
    }

    if (matchedChoice.value === row.selection) {
      applied.push({
        feature: target.feature,
        model: matchedChoice.value,
        label: matchedChoice.label,
        reason: `已处于最优配置：${matchedModel.recommendReason}`,
      });
      continue;
    }

    await saveAiFeatureModel(
      { ...c, key: c.key ? `${c.key.slice(0, 80)}:${target.feature}` : undefined },
      {
        feature: target.feature,
        model: matchedChoice.value,
        revision: row.revision,
      },
    );
    applied.push({
      feature: target.feature,
      model: matchedChoice.value,
      label: matchedChoice.label,
      reason: matchedModel.recommendReason,
    });
  }

  return { applied, skipped };
}

export async function relayModelCandidates(): Promise<AgentInternalModel[]> {
  try {
    const stations = await listRelayStations();
    const out: AgentInternalModel[] = [];
    for (const st of stations) {
      if (!st.enabled || !st.apiKeyConfigured) continue;
      for (const m of st.models) {
        if (m.category !== "chat" || !m.available) continue;
        out.push({
          id: `relay/${st.id}/${m.model}`,
          actual: m.model,
          provider: "relay",
          stationId: st.id,
          stationName: st.name,
          name: `${m.name} · ${st.name}`,
          displayName: `${m.name} · ${st.name}`,
          vision: m.vision,
          pdf: false,
          structured: m.structured,
          parameters: [
            ...(m.tools ? ["tools", "tool_choice"] : []),
            ...(m.structured ? ["structured_outputs", "response_format"] : []),
          ],
          chatOnly: !m.tools || !m.structured,
          chatVerifiedAt: m.verifiedAt || null,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function postRelayStationChat(
  stationId: string,
  body: Row,
  signal: AbortSignal,
  feature: AiFeatureId = "assistant_chat",
): Promise<Response> {
  if (!encryptionReady()) {
    fail("MAIL_KEY_MISSING", "服务器尚未配置凭据加密密钥", 503);
  }
  const station = await one(
    db,
    "SELECT * FROM public.ai_relay_stations WHERE id=$1::uuid",
    stationId,
  );
  if (!station || !station.enabled || !station.api_key_encrypted) {
    fail("RELAY_NOT_READY", "算力中转站未启用或尚未保存密钥", 503);
  }
  const baseUrl = normalizeRelayBaseUrl(String(station.base_url));
  await assertPublicRelayHost(baseUrl);
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
  const payload = {
    ...Object.fromEntries(
      fields.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]),
    ),
    stream: false,
  };
  return aiFetch(feature, `${baseUrl}/chat/completions`, {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      Authorization: `Bearer ${decryptSecret(String(station.api_key_encrypted))}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function smartRankTeamModels(
  models: AgentInternalModel[],
  options: { orchestrator?: boolean; difficulty?: string },
): Promise<{
  ranked: AgentInternalModel[];
  reasons: Map<string, string>;
  shieldedIds: Set<string>;
}> {
  const reasons = new Map<string, string>();
  const shieldedIds = new Set<string>();
  try {
    const settings = await readSmartModelSettings();
    if (!settings.enabled || !models.length) {
      return { ranked: models, reasons, shieldedIds };
    }
    const { rawChannels } = await collectRawChannelCandidates();
    if (!rawChannels.length) {
      return { ranked: models, reasons, shieldedIds };
    }
    const role: SmartAgentRole =
      options.orchestrator || options.difficulty === "complex"
        ? "orchestrator"
        : "executor";
    const roleModels = scoreModelsForRole(rawChannels, settings, role);
    const scoreMap = new Map<string, EvaluatedSmartModel>();
    for (const item of roleModels) {
      scoreMap.set(item.modelRef, item);
      scoreMap.set(item.modelId, item);
      if (item.shielded) {
        shieldedIds.add(item.modelRef);
        shieldedIds.add(item.modelId);
      } else {
        reasons.set(
          item.modelRef,
          `智选模型（${smartRoleMeta[role].label} · ${item.recommendReason}）`,
        );
      }
    }
    const ranked = [...models].sort((a, b) => {
      const aShield = shieldedIds.has(a.id) || shieldedIds.has(a.actual);
      const bShield = shieldedIds.has(b.id) || shieldedIds.has(b.actual);
      if (aShield !== bShield) return Number(aShield) - Number(bShield);
      const aScore =
        scoreMap.get(a.id)?.scores.overall ??
        scoreMap.get(a.actual)?.scores.overall ??
        -1;
      const bScore =
        scoreMap.get(b.id)?.scores.overall ??
        scoreMap.get(b.actual)?.scores.overall ??
        -1;
      return bScore - aScore;
    });
    return { ranked, reasons, shieldedIds };
  } catch {
    return { ranked: models, reasons, shieldedIds };
  }
}

async function rankBySmartRole<T>(
  items: T[],
  role: SmartAgentRole,
  getKeys: (item: T) => string[],
): Promise<T[]> {
  if (items.length <= 1) return items;
  try {
    const settings = await readSmartModelSettings();
    if (!settings.enabled) return items;
    const { rawChannels } = await collectRawChannelCandidates();
    if (!rawChannels.length) return items;
    const roleModels = scoreModelsForRole(rawChannels, settings, role);
    const scoreByKey = new Map<string, number>();
    const shielded = new Set<string>();
    for (const m of roleModels) {
      scoreByKey.set(m.modelId, m.scores.overall);
      scoreByKey.set(m.modelRef, m.scores.overall);
      if (m.shielded) {
        shielded.add(m.modelId);
        shielded.add(m.modelRef);
      }
    }
    return [...items].sort((a, b) => {
      const aKeys = getKeys(a);
      const bKeys = getKeys(b);
      const aShield = aKeys.some((k) => shielded.has(k));
      const bShield = bKeys.some((k) => shielded.has(k));
      if (aShield !== bShield) return Number(aShield) - Number(bShield);
      const aScore = aKeys.reduce<number>(
        (best, k) => scoreByKey.get(k) ?? best,
        0,
      );
      const bScore = bKeys.reduce<number>(
        (best, k) => scoreByKey.get(k) ?? best,
        0,
      );
      return bScore - aScore;
    });
  } catch {
    return items;
  }
}

export function smartRankImageModels(
  imageModels: AgentInternalImageModel[],
): Promise<AgentInternalImageModel[]> {
  return rankBySmartRole(imageModels, "image_design", (m) => [m.actual, m.id]);
}

export function smartRankVideoModels<T extends { info: { model: string; id: string } }>(
  videoModels: T[],
): Promise<T[]> {
  return rankBySmartRole(videoModels, "video_production", (m) => [
    m.info.model,
    m.info.id,
  ]);
}

import { z } from "zod";
import type { AgentAiPriceChannel } from "./agentai.js";

export const smartModelCategories = [
  "chat",
  "image",
  "video",
  "audio",
  "other",
] as const;
export type SmartModelCategory = (typeof smartModelCategories)[number];
export const smartCategoryLabels: Record<SmartModelCategory, string> = {
  chat: "聊天",
  image: "图片",
  video: "视频",
  audio: "音频",
  other: "其他",
};

export const smartAgentRoles = [
  "orchestrator",
  "executor",
  "image_design",
  "video_production",
  "audio_production",
  "other_utility",
] as const;
export type SmartAgentRole = (typeof smartAgentRoles)[number];

export const smartStrategyPresets = [
  "balanced",
  "quality_first",
  "speed_cost",
  "cost_first",
  "stability_first",
  "custom",
] as const;
export type SmartStrategyPreset = (typeof smartStrategyPresets)[number];

export const smartPresetLabels: Record<SmartStrategyPreset, string> = {
  balanced: "价值最大化（均衡）",
  quality_first: "质量与能力优先",
  speed_cost: "极速低成本优先",
  cost_first: "成本极致优先",
  stability_first: "高可用稳定优先",
  custom: "自定义权重",
};

export const smartWeightsSchema = z
  .object({
    stability: z.number().min(0).max(100),
    price: z.number().min(0).max(100),
    speed: z.number().min(0).max(100),
    quality: z.number().min(0).max(100),
  })
  .strict()
  .refine(
    (w) => Math.abs(w.stability + w.price + w.speed + w.quality - 100) <= 0.01,
    "四个维度权重之和必须等于 100%",
  );
export type SmartWeights = z.infer<typeof smartWeightsSchema>;

export const smartPresetWeights: Record<
  Exclude<SmartStrategyPreset, "custom">,
  SmartWeights
> = {
  balanced: { stability: 30, price: 25, speed: 20, quality: 25 },
  quality_first: { stability: 25, price: 10, speed: 15, quality: 50 },
  speed_cost: { stability: 25, price: 35, speed: 30, quality: 10 },
  cost_first: { stability: 25, price: 45, speed: 15, quality: 15 },
  stability_first: { stability: 50, price: 15, speed: 20, quality: 15 },
};

export const smartRoleMeta: Record<
  SmartAgentRole,
  {
    label: string;
    category: SmartModelCategory;
    defaultPreset: Exclude<SmartStrategyPreset, "custom">;
    description: string;
  }
> = {
  orchestrator: {
    label: "编排与审查智能体",
    category: "chat",
    defaultPreset: "quality_first",
    description:
      "负责规划任务、做出设计决策与审查验收结果，优先匹配强推理与高稳定模型。",
  },
  executor: {
    label: "执行与检索智能体",
    category: "chat",
    defaultPreset: "speed_cost",
    description:
      "按计划执行搜索、编辑、构建与测试等高频任务，优先匹配速度更快、成本更低的模型。",
  },
  image_design: {
    label: "图像生成与设计智能体",
    category: "image",
    defaultPreset: "quality_first",
    description:
      "负责高审美视觉生成与参考图设计，优先匹配 ChatGPT Image 2.6、Google Nano Banana 2.1 等最新高质模型。",
  },
  video_production: {
    label: "视频制作智能体",
    category: "video",
    defaultPreset: "balanced",
    description:
      "负责商品与创意短片生成，综合稳定性、价格、速度与画质匹配最优视频渠道。",
  },
  audio_production: {
    label: "音频制作智能体",
    category: "audio",
    defaultPreset: "balanced",
    description:
      "负责语音合成与音色克隆，综合 4 维度自动优选低延迟高稳定音频渠道。",
  },
  other_utility: {
    label: "其他与辅助模型",
    category: "other",
    defaultPreset: "balanced",
    description: "向量检索、重排、合规识别等辅助模型按综合价值优选。",
  },
};

export const smartFilterPolicySchema = z
  .object({
    minSuccessRate: z.number().min(0).max(100).default(85),
    minScore: z.number().min(0).max(95).default(60),
    maxPriceMultiplier: z.number().min(1.1).max(20).default(2.5),
    maxChatLatencySeconds: z.number().min(5).max(300).default(45),
    maxImageLatencySeconds: z.number().min(10).max(600).default(120),
    maxVideoLatencySeconds: z.number().min(20).max(1200).default(300),
    maxAudioLatencySeconds: z.number().min(5).max(300).default(90),
    hideShielded: z.boolean().default(true),
    requireLiveStats: z.boolean().default(false),
    autoShieldOnConsecutiveFailures: z.number().int().min(1).max(10).default(2),
  })
  .strict();
export type SmartFilterPolicy = z.infer<typeof smartFilterPolicySchema>;

export const defaultSmartFilterPolicy: SmartFilterPolicy =
  smartFilterPolicySchema.parse({});

export const smartChannelOverrideSchema = z
  .object({
    channelKey: z.string().trim().min(1).max(260),
    action: z.enum(["unshield", "block", "pin"]),
    note: z.string().trim().max(120).optional(),
  })
  .strict();
export type SmartChannelOverride = z.infer<typeof smartChannelOverrideSchema>;

export const smartPolicySaveSchema = z
  .object({
    version: z.number().int().nonnegative(),
    enabled: z.boolean(),
    preset: z.enum(smartStrategyPresets),
    weights: smartWeightsSchema,
    filterPolicy: smartFilterPolicySchema,
    rolePolicies: z
      .partialRecord(
        z.enum(smartAgentRoles),
        z.enum(["balanced", "quality_first", "speed_cost", "cost_first", "stability_first"]),
      )
      .default({}),
    channelOverrides: z.array(smartChannelOverrideSchema).max(300).default([]),
  })
  .strict();
export type SmartPolicySaveInput = z.infer<typeof smartPolicySaveSchema>;

export const relayStationProtocolSchema = z.enum(["auto", "agentai", "openai"]);
export type RelayStationProtocol = z.infer<typeof relayStationProtocolSchema>;

export const relayStationSaveSchema = z
  .object({
    id: z.string().uuid().optional(),
    version: z.number().int().nonnegative().default(0),
    name: z.string().trim().min(1, "请填写中转站名称").max(80).optional(),
    baseUrl: z.string().trim().min(8, "请输入中转站链接").max(400),
    protocol: relayStationProtocolSchema.default("auto"),
    enabled: z.boolean().default(true),
    apiKey: z.string().trim().max(512).optional(),
    clearKey: z.boolean().default(false),
  })
  .strict();
export type RelayStationSaveInput = z.infer<typeof relayStationSaveSchema>;

export const relayProbeSchema = z
  .object({
    model: z.string().trim().min(1).max(180),
  })
  .strict();

export const smartApplySchema = z
  .object({
    roles: z.array(z.enum(smartAgentRoles)).min(1).max(6).optional(),
  })
  .strict();

export type SmartLocalTelemetry = {
  requests: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  avgLatencySeconds: number | null;
  consecutiveFailures: number;
  avgCostRmb: number | null;
  lastError: string | null;
};

export type RelayStationModel = {
  model: string;
  name: string;
  category: SmartModelCategory;
  available: boolean;
  vision: boolean;
  tools: boolean;
  structured: boolean;
  channels: AgentAiPriceChannel[];
  verifiedAt?: string | null;
  lastLatencyMs?: number | null;
};

export type RelayStationView = {
  id: string;
  name: string;
  baseUrl: string;
  protocol: RelayStationProtocol;
  enabled: boolean;
  apiKeyConfigured: boolean;
  verifiedAt: string | null;
  catalogAt: string | null;
  pricesAt: string | null;
  errorNote: string;
  version: number;
  modelCount: number;
  categoryCounts: Record<SmartModelCategory, number>;
  models: RelayStationModel[];
};

export type SmartDimensionScores = {
  stability: number;
  price: number;
  speed: number;
  quality: number;
  overall: number;
};

export type EvaluatedChannel = {
  channelKey: string;
  stationId: string;
  stationName: string;
  stationKind: "agentai" | "openrouter" | "bailian" | "relay" | "aigc";
  modelId: string;
  modelRef: string;
  modelName: string;
  category: SmartModelCategory;
  vendor: string;
  laneNo: number | null;
  billingUnit: string;
  billingMethod: string;
  effectivePriceRmb: number | null;
  inputPerMillionRmb: number | null;
  outputPerMillionRmb: number | null;
  defaultTotalRmb: number | null;
  priceLabel: string;
  successRate24h: number | null;
  avgResponseSeconds: number | null;
  statsSource: "live" | "estimate" | "unknown";
  localTelemetry: SmartLocalTelemetry | null;
  scores: SmartDimensionScores;
  tier: "flagship" | "standard" | "fast";
  vision: boolean;
  tools: boolean;
  structured: boolean;
  verified: boolean;
  shielded: boolean;
  shieldReasons: string[];
  overrideAction: "unshield" | "block" | "pin" | null;
  recommended: boolean;
  recommendReason: string;
};

export type EvaluatedSmartModel = {
  key: string;
  stationId: string;
  stationName: string;
  stationKind: EvaluatedChannel["stationKind"];
  modelId: string;
  modelRef: string;
  modelName: string;
  category: SmartModelCategory;
  tier: "flagship" | "standard" | "fast";
  vision: boolean;
  tools: boolean;
  structured: boolean;
  verified: boolean;
  totalChannels: number;
  activeChannels: number;
  shieldedChannels: number;
  bestChannel: EvaluatedChannel | null;
  channels: EvaluatedChannel[];
  scores: SmartDimensionScores;
  shielded: boolean;
  shieldReasons: string[];
  recommendReason: string;
};

export type RoleAllocation = {
  role: SmartAgentRole;
  label: string;
  category: SmartModelCategory;
  preset: Exclude<SmartStrategyPreset, "custom">;
  description: string;
  primary: EvaluatedSmartModel | null;
  backup: EvaluatedSmartModel | null;
  candidateCount: number;
  shieldedCount: number;
  reason: string;
};

export type SmartModelsSettingsState = {
  enabled: boolean;
  preset: SmartStrategyPreset;
  weights: SmartWeights;
  filterPolicy: SmartFilterPolicy;
  rolePolicies: Partial<Record<SmartAgentRole, Exclude<SmartStrategyPreset, "custom">>>;
  channelOverrides: SmartChannelOverride[];
  version: number;
};

export type SmartModelsOverview = {
  settings: SmartModelsSettingsState;
  encryptionReady: boolean;
  stations: RelayStationView[];
  models: EvaluatedSmartModel[];
  roleAllocations: RoleAllocation[];
  summary: {
    stationCount: number;
    totalModels: number;
    recommendedModels: number;
    shieldedModels: number;
    totalChannels: number;
    activeChannels: number;
    shieldedChannels: number;
  };
  generatedAt: string;
};

export function resolveSmartWeights(
  preset: SmartStrategyPreset,
  custom?: SmartWeights,
): SmartWeights {
  if (preset === "custom" && custom) return custom;
  return preset === "custom"
    ? smartPresetWeights.balanced
    : smartPresetWeights[preset];
}

export function classifySmartModel(
  modelId: string,
  explicitType?: string,
  outputModalities?: unknown[],
  endpointTypes?: unknown[],
): SmartModelCategory {
  const lowerType = (explicitType || "").toLowerCase();
  if (lowerType === "chat" || lowerType === "text") return "chat";
  if (lowerType === "image") return "image";
  if (lowerType === "video") return "video";
  if (lowerType === "audio" || lowerType === "speech" || lowerType === "tts")
    return "audio";

  const outputs = Array.isArray(outputModalities)
    ? outputModalities.map((v) => String(v).toLowerCase())
    : [];
  const endpoints = Array.isArray(endpointTypes)
    ? endpointTypes.map((v) => String(v).toLowerCase())
    : [];
  if (outputs.includes("video") || endpoints.some((e) => e.includes("video")))
    return "video";
  if (outputs.includes("image") || endpoints.some((e) => e.includes("image")))
    return "image";
  if (outputs.includes("audio") || endpoints.some((e) => e.includes("audio")))
    return "audio";

  const id = modelId.toLowerCase();
  if (
    /(?:embed|embedding|rerank|bge-|moderation|omni-moderation|whisper-classify|text-embedding)/.test(
      id,
    )
  )
    return "other";
  if (
    /(?:^|[-_/])(?:tts|speech|audio|voice|doubao-tts|eleven|cosyvoice|sambert|whisper|asr)(?:[-_/.]|$)/.test(
      id,
    )
  )
    return "audio";
  if (
    /(?:seedance|minimax-h|hailuo|kling|runway|sora|veo|vidu|muse-video|mu-video|grok-imagine|video-enhance|wanx|cogvideo)/.test(
      id,
    )
  )
    return "video";
  if (
    /(?:gpt-image|chatgpt-image|nano-banana|nanobanana|banana-pro|banana-2|tt-image|gt-image|gm-nb|dall-e|imagen|flux|midjourney|ideogram|sdxl|recraft|seedream|kolors)/.test(
      id,
    )
  )
    return "image";
  if (outputs.includes("text") || !lowerType || lowerType === "llm")
    return "chat";
  return "other";
}

export function inferModelQualityMeta(
  modelId: string,
  name: string,
  category: SmartModelCategory,
  caps: { vision?: boolean; tools?: boolean; structured?: boolean; verified?: boolean } = {},
): {
  qualityScore: number;
  tier: "flagship" | "standard" | "fast";
  highlights: string[];
} {
  const id = `${modelId} ${name}`.toLowerCase();
  const highlights: string[] = [];

  if (category === "image") {
    let score = 74;
    let tier: "flagship" | "standard" | "fast" = "standard";
    if (/(?:gpt-image-2\.6|chatgpt-image-2\.6|gt-image-2\.6)/.test(id)) {
      score = id.includes("sunb") ? 97 : 94;
      tier = "flagship";
      highlights.push("ChatGPT Image 2.6 最新代图像");
    } else if (/(?:nano-banana-2\.1|nanobanana-2\.1|gm-nb-2\.1|nb-2\.1)/.test(id)) {
      score = 96;
      tier = "flagship";
      highlights.push("Google Nano Banana 2.1 最新代图像");
    } else if (/(?:banana-pro|gpt-image-2\.5|gt-image-2\.5|imagen-4|flux-pro|seedream)/.test(id)) {
      score = 90;
      tier = "flagship";
      highlights.push("高精图像模型");
    } else if (/(?:flux|banana|dall-e-3|midjourney|ideogram|tt-image-2\.5)/.test(id)) {
      score = 84;
    } else if (/(?:fast|flash|turbo|flare|mini|lite)/.test(id)) {
      score = 78;
      tier = "fast";
    }
    if (caps.vision) score += 2;
    return { qualityScore: clampScore(score), tier, highlights };
  }

  if (category === "video") {
    let score = 74;
    let tier: "flagship" | "standard" | "fast" = "standard";
    if (/seedance-2[-.]5/.test(id)) {
      score = id.includes("official") || id.includes("直连") ? 95 : 90;
      tier = "flagship";
      highlights.push("Seedance 2.5 高质量视频");
    } else if (/(?:seedance-2[-.]0|sora-2|veo-3|kling-2|grok-imagine-1[-.]5)/.test(id)) {
      score = id.includes("official") || id.includes("直连") ? 90 : 86;
      tier = "flagship";
      highlights.push("旗舰视频生成");
    } else if (/(?:minimax-h3|hailuo|muse-video|mu-video|vidu)/.test(id)) {
      score = 85;
      tier = "standard";
    }
    return { qualityScore: clampScore(score), tier, highlights };
  }

  if (category === "audio") {
    let score = 76;
    let tier: "flagship" | "standard" | "fast" = "standard";
    if (/speech-2\.8|eleven|cosyvoice-3/.test(id)) {
      score = 93;
      tier = "flagship";
      highlights.push("支持高保真合成/音色克隆");
    } else if (/doubao-tts-2\.0|qwen3-tts|gpt-audio/.test(id)) {
      score = 89;
      tier = "standard";
    }
    return { qualityScore: clampScore(score), tier, highlights };
  }

  if (category === "other") {
    return { qualityScore: 76, tier: "standard", highlights };
  }

  // Chat / reasoning models
  let score = 78;
  let tier: "flagship" | "standard" | "fast" = "standard";
  if (
    /(?:flash|mini|nano|haiku|lite|small|argon|turbo|8b|7b|9b)(?:[-/:.\s]|$)/.test(
      id,
    )
  ) {
    score = 74;
    tier = "fast";
    highlights.push("轻量高速低成本");
  } else if (
    /(?:gpt-6\.1|gpt-6|astra|claude-opus-5|claude-fable-5|opus-4|sonnet-4|gpt-5\.[1-9]|o3|o4|gemini-4-pro|gemini-3-pro|gemini-2\.5-pro|deepseek-r1|qwen[^/]*max)/.test(
      id,
    )
  ) {
    score = 93;
    tier = "flagship";
    highlights.push("强推理与复杂规划能力");
  } else if (/(?:gpt-5|claude|deepseek-v[4-9]|gemini|qwen)/.test(id)) {
    score = 83;
    tier = "standard";
  }

  if (caps.vision) score += 2;
  if (caps.tools) score += 2;
  if (caps.structured) score += 2;
  if (caps.verified) score += 1;

  return { qualityScore: clampScore(score), tier, highlights };
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function effectiveChannelPrice(channel: {
  category: SmartModelCategory;
  inputPerMillionRmb: number | null;
  outputPerMillionRmb: number | null;
  defaultTotalRmb: number | null;
}): number | null {
  if (channel.category === "chat") {
    if (
      channel.inputPerMillionRmb !== null ||
      channel.outputPerMillionRmb !== null
    ) {
      const inp = channel.inputPerMillionRmb ?? channel.outputPerMillionRmb ?? 0;
      const out = channel.outputPerMillionRmb ?? channel.inputPerMillionRmb ?? 0;
      return inp * 0.25 + out * 0.75;
    }
    return channel.defaultTotalRmb;
  }
  if (channel.defaultTotalRmb !== null) return channel.defaultTotalRmb;
  if (
    channel.inputPerMillionRmb !== null ||
    channel.outputPerMillionRmb !== null
  ) {
    const inp = channel.inputPerMillionRmb ?? 0;
    const out = channel.outputPerMillionRmb ?? inp;
    return inp * 0.25 + out * 0.75;
  }
  return null;
}

export function formatChannelPriceLabel(channel: {
  category: SmartModelCategory;
  inputPerMillionRmb: number | null;
  outputPerMillionRmb: number | null;
  defaultTotalRmb: number | null;
}): string {
  const fmt = (n: number) =>
    n.toLocaleString("zh-CN", { maximumSignificantDigits: 5 });
  if (
    channel.category === "chat" &&
    (channel.inputPerMillionRmb !== null || channel.outputPerMillionRmb !== null)
  ) {
    const parts: string[] = [];
    if (channel.inputPerMillionRmb !== null)
      parts.push(`入 ¥${fmt(channel.inputPerMillionRmb)}/M`);
    if (channel.outputPerMillionRmb !== null)
      parts.push(`出 ¥${fmt(channel.outputPerMillionRmb)}/M`);
    return parts.join(" · ");
  }
  if (channel.defaultTotalRmb !== null)
    return `参考 ¥${fmt(channel.defaultTotalRmb)}`;
  if (channel.inputPerMillionRmb !== null || channel.outputPerMillionRmb !== null) {
    return `入 ¥${fmt(channel.inputPerMillionRmb ?? 0)} / 出 ¥${fmt(channel.outputPerMillionRmb ?? 0)} /M`;
  }
  return "价格待同步";
}

function median(values: number[]): number | null {
  const valid = values
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 0
    ? (valid[mid - 1] + valid[mid]) / 2
    : valid[mid];
}

function latencyLimitForCategory(
  category: SmartModelCategory,
  policy: SmartFilterPolicy,
): number {
  switch (category) {
    case "image":
      return policy.maxImageLatencySeconds;
    case "video":
      return policy.maxVideoLatencySeconds;
    case "audio":
      return policy.maxAudioLatencySeconds;
    default:
      return policy.maxChatLatencySeconds;
  }
}

function scoreLatency(
  seconds: number | null,
  category: SmartModelCategory,
  maxAllowed: number,
  tier: "flagship" | "standard" | "fast",
): number {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return tier === "fast" ? 72 : 64;
  }
  const ideal =
    category === "video"
      ? 35
      : category === "image"
        ? 12
        : category === "audio"
          ? 8
          : 2.5;
  if (seconds <= ideal) return 98;
  if (seconds >= maxAllowed) return Math.max(15, Math.round(40 - (seconds - maxAllowed) / 2));
  const ratio = (seconds - ideal) / Math.max(1, maxAllowed - ideal);
  return clampScore(98 - ratio * 58);
}

function scorePriceRelative(
  price: number | null,
  peerPrices: number[],
): number {
  if (price === null || !Number.isFinite(price)) return 62;
  if (price === 0) return 100;
  const valid = peerPrices.filter((p) => Number.isFinite(p) && p > 0);
  if (!valid.length) return 68;
  const med = median(valid) || price;
  const ratio = price / Math.max(med, 0.0001);
  // Ratio <= 0.35 -> ~98, ratio = 1.0 (median) -> 76, ratio = 2.5 -> ~42, ratio >= 4 -> 18
  if (ratio <= 1) {
    return clampScore(76 + (1 - ratio) * 34);
  }
  return clampScore(76 - (ratio - 1) * 23);
}

export type RawChannelCandidate = {
  channelKey: string;
  stationId: string;
  stationName: string;
  stationKind: EvaluatedChannel["stationKind"];
  modelId: string;
  modelRef: string;
  modelName: string;
  category: SmartModelCategory;
  available: boolean;
  vision: boolean;
  tools: boolean;
  structured: boolean;
  verified: boolean;
  vendor: string;
  laneNo: number | null;
  billingUnit: string;
  billingMethod: string;
  defaultTotalRmb: number | null;
  inputPerMillionRmb: number | null;
  outputPerMillionRmb: number | null;
  successRate24h: number | null;
  avgResponseSeconds: number | null;
  statsSource: "live" | "estimate" | "unknown";
  localTelemetry: SmartLocalTelemetry | null;
};

export function evaluateChannelCandidates(
  rawChannels: RawChannelCandidate[],
  options: {
    weights?: SmartWeights;
    policy?: SmartFilterPolicy;
    overrides?: SmartChannelOverride[];
  } = {},
): EvaluatedChannel[] {
  const weights = options.weights || smartPresetWeights.balanced;
  const policy = options.policy || defaultSmartFilterPolicy;
  const overrides = new Map(
    (options.overrides || []).map((o) => [o.channelKey, o]),
  );

  // Precompute per-model peer median prices and per-category peer prices.
  const modelPrices = new Map<string, number[]>();
  const categoryPrices = new Map<SmartModelCategory, number[]>();
  for (const ch of rawChannels) {
    if (!ch.available) continue;
    const eff = effectiveChannelPrice(ch);
    if (eff === null) continue;
    const modelKey = `${ch.stationId}:${ch.modelId}`;
    const mArr = modelPrices.get(modelKey) || [];
    mArr.push(eff);
    modelPrices.set(modelKey, mArr);

    const cArr = categoryPrices.get(ch.category) || [];
    cArr.push(eff);
    categoryPrices.set(ch.category, cArr);
  }

  const evaluated = rawChannels.map((ch): EvaluatedChannel => {
    const eff = effectiveChannelPrice(ch);
    const modelKey = `${ch.stationId}:${ch.modelId}`;
    const peerMedian = median(modelPrices.get(modelKey) || []);
    const catPrices = categoryPrices.get(ch.category) || [];
    const maxLatency = latencyLimitForCategory(ch.category, policy);

    const qualityMeta = inferModelQualityMeta(
      ch.modelId,
      ch.modelName,
      ch.category,
      {
        vision: ch.vision,
        tools: ch.tools,
        structured: ch.structured,
        verified: ch.verified,
      },
    );

    const vendorLower = `${ch.vendor} ${ch.billingMethod}`.toLowerCase();
    let channelQualityBonus = 0;
    if (/(?:official|直连|官方|官转|enterprise)/.test(vendorLower)) {
      channelQualityBonus += 4;
    } else if (/(?:reverse|逆向|free|测试)/.test(vendorLower)) {
      channelQualityBonus -= 8;
    }

    // Stability combines upstream 24h live stats and local execution telemetry.
    const upstreamLiveStability =
      ch.statsSource === "live" && ch.successRate24h !== null
        ? ch.successRate24h
        : null;
    const localSuccess =
      ch.localTelemetry && ch.localTelemetry.requests > 0
        ? ch.localTelemetry.successRate
        : null;
    let stabilityScore =
      upstreamLiveStability !== null && localSuccess !== null
        ? upstreamLiveStability * 0.65 + localSuccess * 0.35
        : upstreamLiveStability !== null
          ? upstreamLiveStability
          : localSuccess !== null
            ? localSuccess
            : ch.statsSource === "estimate"
              ? 68
              : 65;
    if (
      ch.localTelemetry &&
      ch.localTelemetry.consecutiveFailures >=
        policy.autoShieldOnConsecutiveFailures
    ) {
      stabilityScore = Math.min(stabilityScore, 35);
    }

    const measuredSeconds =
      ch.statsSource === "live" &&
      ch.avgResponseSeconds !== null &&
      ch.avgResponseSeconds > 0
        ? ch.avgResponseSeconds
        : ch.localTelemetry?.avgLatencySeconds ?? null;

    const speedScore = scoreLatency(
      measuredSeconds,
      ch.category,
      maxLatency,
      qualityMeta.tier,
    );
    const priceScore = scorePriceRelative(eff, catPrices);
    const qualityScore = clampScore(
      qualityMeta.qualityScore + channelQualityBonus,
    );
    const stability = clampScore(stabilityScore);
    const overall = clampScore(
      (stability * weights.stability +
        priceScore * weights.price +
        speedScore * weights.speed +
        qualityScore * weights.quality) /
        100,
    );

    const shieldReasons: string[] = [];
    if (!ch.available) {
      shieldReasons.push("渠道或模型已下线停用");
    }
    if (
      ch.statsSource === "live" &&
      ch.successRate24h !== null &&
      ch.successRate24h < policy.minSuccessRate
    ) {
      shieldReasons.push(
        `近 24h 成功率 ${ch.successRate24h.toFixed(1)}% 低于 ${policy.minSuccessRate}%`,
      );
    }
    if (
      ch.statsSource === "live" &&
      ch.avgResponseSeconds !== null &&
      ch.avgResponseSeconds > maxLatency
    ) {
      shieldReasons.push(
        `平均耗时 ${ch.avgResponseSeconds.toFixed(1)}s 超过上限 ${maxLatency}s`,
      );
    }
    if (
      peerMedian !== null &&
      peerMedian > 0 &&
      eff !== null &&
      eff > peerMedian * policy.maxPriceMultiplier
    ) {
      shieldReasons.push(
        `相对同模型中位价溢价 ${(eff / peerMedian).toFixed(1)} 倍（上限 ${policy.maxPriceMultiplier} 倍）`,
      );
    }
    if (
      ch.localTelemetry &&
      (ch.localTelemetry.consecutiveFailures >=
        policy.autoShieldOnConsecutiveFailures ||
        (ch.localTelemetry.requests >= 3 &&
          ch.localTelemetry.successRate !== null &&
          ch.localTelemetry.successRate < policy.minSuccessRate))
    ) {
      shieldReasons.push("本系统近期实测连续失败或成功率不足");
    }
    if (
      policy.requireLiveStats &&
      ch.statsSource !== "live" &&
      (!ch.localTelemetry || ch.localTelemetry.requests === 0)
    ) {
      shieldReasons.push("无实测表现数据（已开启仅保留实测渠道）");
    }
    if (overall < policy.minScore) {
      shieldReasons.push(`综合评分 ${overall} 分低于门槛 ${policy.minScore} 分`);
    }

    const override = overrides.get(ch.channelKey)?.action || null;
    if (override === "block") {
      shieldReasons.unshift("管理员手动屏蔽");
    }

    const shielded =
      override === "block"
        ? true
        : override === "unshield" || override === "pin"
          ? false
          : shieldReasons.length > 0;

    const topStrengths = [
      stability >= 90 ? `稳定 ${stability}` : "",
      priceScore >= 80 ? `高性价比 ${priceScore}` : "",
      speedScore >= 82 ? `响应快 ${speedScore}` : "",
      qualityScore >= 88 ? `高质量 ${qualityScore}` : "",
    ]
      .filter(Boolean)
      .slice(0, 3);

    const recommendReason = override === "pin"
      ? "管理员置顶推荐渠道"
      : shielded
        ? shieldReasons[0] || "综合评估未达门槛"
        : topStrengths.length
          ? `${topStrengths.join(" · ")}（综合 ${overall} 分）`
          : `四维综合 ${overall} 分`;

    return {
      channelKey: ch.channelKey,
      stationId: ch.stationId,
      stationName: ch.stationName,
      stationKind: ch.stationKind,
      modelId: ch.modelId,
      modelRef: ch.modelRef,
      modelName: ch.modelName,
      category: ch.category,
      vendor: ch.vendor,
      laneNo: ch.laneNo,
      billingUnit: ch.billingUnit,
      billingMethod: ch.billingMethod,
      effectivePriceRmb: eff,
      inputPerMillionRmb: ch.inputPerMillionRmb,
      outputPerMillionRmb: ch.outputPerMillionRmb,
      defaultTotalRmb: ch.defaultTotalRmb,
      priceLabel: formatChannelPriceLabel({
        category: ch.category,
        inputPerMillionRmb: ch.inputPerMillionRmb,
        outputPerMillionRmb: ch.outputPerMillionRmb,
        defaultTotalRmb: ch.defaultTotalRmb,
      }),
      successRate24h: ch.successRate24h,
      avgResponseSeconds: ch.avgResponseSeconds,
      statsSource: ch.statsSource,
      localTelemetry: ch.localTelemetry,
      scores: {
        stability,
        price: priceScore,
        speed: speedScore,
        quality: qualityScore,
        overall,
      },
      tier: qualityMeta.tier,
      vision: ch.vision,
      tools: ch.tools,
      structured: ch.structured,
      verified: ch.verified,
      shielded,
      shieldReasons,
      overrideAction: override,
      recommended: false,
      recommendReason,
    };
  });

  evaluated.sort((a, b) => {
    const pinDiff =
      Number(b.overrideAction === "pin") - Number(a.overrideAction === "pin");
    if (pinDiff !== 0) return pinDiff;
    const shieldDiff = Number(a.shielded) - Number(b.shielded);
    if (shieldDiff !== 0) return shieldDiff;
    if (b.scores.overall !== a.scores.overall)
      return b.scores.overall - a.scores.overall;
    return (
      (a.effectivePriceRmb ?? Infinity) - (b.effectivePriceRmb ?? Infinity)
    );
  });

  if (evaluated[0] && !evaluated[0].shielded) {
    evaluated[0].recommended = true;
  }
  return evaluated;
}

export function evaluateAgentAiPricingChannels(
  modelId: string,
  modelName: string,
  category: SmartModelCategory,
  channels: AgentAiPriceChannel[],
  options: {
    vision?: boolean;
    tools?: boolean;
    structured?: boolean;
    verified?: boolean;
    weights?: SmartWeights;
    policy?: SmartFilterPolicy;
    overrides?: SmartChannelOverride[];
    localTelemetry?: SmartLocalTelemetry | null;
  } = {},
): EvaluatedChannel[] {
  const raw: RawChannelCandidate[] = channels.map((c, index) => ({
    channelKey: `agentai:${modelId}:${c.vendor || "default"}:${c.laneNo ?? index}`,
    stationId: "agentai",
    stationName: "AgentAI",
    stationKind: "agentai",
    modelId,
    modelRef: `agentai/${modelId}`,
    modelName,
    category,
    available: true,
    vision: !!options.vision,
    tools: !!options.tools,
    structured: !!options.structured,
    verified: !!options.verified,
    vendor: c.vendor || "默认供应商",
    laneNo: c.laneNo,
    billingUnit: c.billingUnit,
    billingMethod: c.billingMethod,
    defaultTotalRmb: c.defaultTotalRmb,
    inputPerMillionRmb: c.inputPerMillionRmb,
    outputPerMillionRmb: c.outputPerMillionRmb,
    successRate24h: c.successRate24h,
    avgResponseSeconds: c.avgResponseSeconds,
    statsSource: c.statsSource,
    localTelemetry: options.localTelemetry || null,
  }));
  return evaluateChannelCandidates(raw, options);
}

export function scoreModelsForRole(
  rawChannels: RawChannelCandidate[],
  settings: SmartModelsSettingsState,
  role: SmartAgentRole,
): EvaluatedSmartModel[] {
  const meta = smartRoleMeta[role];
  const preset = settings.rolePolicies[role] || meta.defaultPreset;
  const roleWeights = smartPresetWeights[preset];
  const roleRaw = rawChannels.filter((c) => c.category === meta.category);
  const roleEvaluated = evaluateChannelCandidates(roleRaw, {
    weights: roleWeights,
    policy: settings.filterPolicy,
    overrides: settings.channelOverrides,
  });

  const grouped = new Map<string, EvaluatedChannel[]>();
  for (const ch of roleEvaluated) {
    const key = `${ch.stationId}:${ch.modelId}`;
    const list = grouped.get(key) || [];
    list.push(ch);
    grouped.set(key, list);
  }

  const roleModels: EvaluatedSmartModel[] = [];
  for (const [key, channels] of grouped.entries()) {
    const active = channels.filter((c) => !c.shielded);
    const best = active[0] || channels[0];
    if (!best) continue;
    let roleBonus = 0;
    const lower = `${best.modelId} ${best.modelName}`.toLowerCase();
    if (role === "orchestrator") {
      if (best.tier === "flagship") roleBonus += 10;
      else if (best.tier === "fast") roleBonus -= 8;
      if (best.tools) roleBonus += 4;
      if (best.structured) roleBonus += 4;
    } else if (role === "executor") {
      if (best.tier === "fast") roleBonus += 10;
      else if (best.tier === "flagship") roleBonus -= 4;
    } else if (role === "image_design") {
      if (
        /(?:gpt-image-2\.6|chatgpt-image-2\.6|gt-image-2\.6|nano-banana-2\.1|nanobanana-2\.1|gm-nb-2\.1)/.test(
          lower,
        )
      ) {
        roleBonus += 12;
      }
    }
    const adjustedOverall = clampScore(best.scores.overall + roleBonus);
    roleModels.push({
      key,
      stationId: best.stationId,
      stationName: best.stationName,
      stationKind: best.stationKind,
      modelId: best.modelId,
      modelRef: best.modelRef,
      modelName: best.modelName,
      category: best.category,
      tier: best.tier,
      vision: best.vision,
      tools: best.tools,
      structured: best.structured,
      verified: best.verified,
      totalChannels: channels.length,
      activeChannels: active.length,
      shieldedChannels: channels.length - active.length,
      bestChannel: best,
      channels,
      scores: { ...best.scores, overall: adjustedOverall },
      shielded: active.length === 0,
      shieldReasons:
        active.length === 0
          ? [...new Set(channels.flatMap((c) => c.shieldReasons))].slice(0, 3)
          : [],
      recommendReason:
        active.length === 0
          ? "渠道综合评估未通过"
          : `${best.recommendReason} · 适配${meta.label}`,
    });
  }

  roleModels.sort((a, b) => {
    const shieldDiff = Number(a.shielded) - Number(b.shielded);
    if (shieldDiff !== 0) return shieldDiff;
    const verDiff = Number(b.verified) - Number(a.verified);
    if (verDiff !== 0) return verDiff;
    return b.scores.overall - a.scores.overall;
  });

  return roleModels;
}

export function evaluateAndAllocateSmartModels(
  rawChannels: RawChannelCandidate[],
  settings: SmartModelsSettingsState,
): {
  models: EvaluatedSmartModel[];
  roleAllocations: RoleAllocation[];
  summary: SmartModelsOverview["summary"];
} {
  const activeWeights = resolveSmartWeights(settings.preset, settings.weights);
  const allChannels = evaluateChannelCandidates(rawChannels, {
    weights: activeWeights,
    policy: settings.filterPolicy,
    overrides: settings.channelOverrides,
  });

  const byModel = new Map<string, EvaluatedChannel[]>();
  for (const ch of allChannels) {
    const key = `${ch.stationId}:${ch.modelId}`;
    const list = byModel.get(key) || [];
    list.push(ch);
    byModel.set(key, list);
  }

  const models: EvaluatedSmartModel[] = [];
  for (const [key, channels] of byModel.entries()) {
    const active = channels.filter((c) => !c.shielded);
    const best = active[0] || channels[0] || null;
    const shielded = active.length === 0;
    const shieldReasons = shielded
      ? [...new Set(channels.flatMap((c) => c.shieldReasons))].slice(0, 3)
      : [];
    if (best && !best.shielded) {
      best.recommended = true;
    }
    models.push({
      key,
      stationId: best?.stationId || "",
      stationName: best?.stationName || "",
      stationKind: best?.stationKind || "relay",
      modelId: best?.modelId || "",
      modelRef: best?.modelRef || "",
      modelName: best?.modelName || "",
      category: best?.category || "chat",
      tier: best?.tier || "standard",
      vision: best?.vision || false,
      tools: best?.tools || false,
      structured: best?.structured || false,
      verified: best?.verified || false,
      totalChannels: channels.length,
      activeChannels: active.length,
      shieldedChannels: channels.length - active.length,
      bestChannel: best,
      channels,
      scores: best?.scores || {
        stability: 0,
        price: 0,
        speed: 0,
        quality: 0,
        overall: 0,
      },
      shielded,
      shieldReasons,
      recommendReason: shielded
        ? shieldReasons[0] || "全部渠道均未通过筛选阈值"
        : best?.recommendReason || "可用",
    });
  }

  models.sort((a, b) => {
    const shieldDiff = Number(a.shielded) - Number(b.shielded);
    if (shieldDiff !== 0) return shieldDiff;
    const verDiff = Number(b.verified) - Number(a.verified);
    if (verDiff !== 0) return verDiff;
    return b.scores.overall - a.scores.overall;
  });

  const roleAllocations: RoleAllocation[] = smartAgentRoles.map((role) => {
    const meta = smartRoleMeta[role];
    const preset = settings.rolePolicies[role] || meta.defaultPreset;
    const roleModels = scoreModelsForRole(rawChannels, settings, role);
    const eligible = roleModels.filter((m) => !m.shielded);
    const primary = eligible[0] || null;
    const backup = eligible[1] || null;
    const shieldedCount = roleModels.filter((m) => m.shielded).length;

    return {
      role,
      label: meta.label,
      category: meta.category,
      preset,
      description: meta.description,
      primary,
      backup,
      candidateCount: eligible.length,
      shieldedCount,
      reason: primary
        ? `已匹配 ${primary.modelName}（${primary.stationName} · 综合 ${primary.scores.overall} 分），自动屏蔽 ${shieldedCount} 个低分模型`
        : roleModels.length
          ? `当前 ${roleModels.length} 个候选均未通过屏蔽门槛，请检查验证状态或调低阈值`
          : `暂无已接入的${smartCategoryLabels[meta.category]}模型`,
    };
  });

  const summary: SmartModelsOverview["summary"] = {
    stationCount: new Set(rawChannels.map((c) => c.stationId)).size,
    totalModels: models.length,
    recommendedModels: models.filter((m) => !m.shielded).length,
    shieldedModels: models.filter((m) => m.shielded).length,
    totalChannels: allChannels.length,
    activeChannels: allChannels.filter((c) => !c.shielded).length,
    shieldedChannels: allChannels.filter((c) => c.shielded).length,
  };

  return { models, roleAllocations, summary };
}

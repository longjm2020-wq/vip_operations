import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { jobRequestSignal } from "./job-request.mjs";
import { modelFetch, modelReceipt } from "./ai-accounting.mjs";

// Reviewed against AgentAI's public logical-models/param_schema on 2026-11-18.
// This is an executable subset, never an assertion that the whole catalogue fits
// the ERP's multi-reference workflow. The authenticated schema is checked again.
export const AGENTAI_ORIGIN = "https://agentai.token6688.com";
const imageRatios = [
  "1:1",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "5:4",
  "4:5",
  "16:9",
  "9:16",
  "21:9",
];
export const AGENTAI_IMAGES = [
  {
    id: "agentai-gt-image-2.6-flare",
    model: "gpt-image-2.6-flare",
    publicId: "gt-image-2.6-flare",
    label: "AgentAI · GT Image 2.6 Flare 快速版",
    maxImages: 16,
    maxBytes: 25 * 1024 * 1024,
    sizeField: "resolution",
    quality: "high",
    maxPromptChars: 32000,
  },
  {
    id: "agentai-gt-image-2.6-sunburst",
    model: "gpt-image-2.6-sunburst",
    publicId: "gt-image-2.6-sunburst",
    label: "AgentAI · GT Image 2.6 Sunb 高端版",
    maxImages: 16,
    maxBytes: 25 * 1024 * 1024,
    sizeField: "resolution",
    quality: "high",
    maxPromptChars: 32000,
  },
  {
    id: "agentai-gm-nb-2.1-image",
    model: "gemini-nano-banana-2.1-image",
    publicId: "gm-nb-2.1-image",
    label: "AgentAI · GM NB 2.1 Image",
    maxImages: 14,
    maxBytes: 10 * 1024 * 1024,
    sizeField: "size",
    maxPromptChars: 30000,
  },
].map((model) => ({
  ...model,
  providerModel: model.model,
  adapter: "agentai",
  aspects: imageRatios,
  preset: "2K",
  detail: "多图融合 · 每次1张2K；实际费用以AgentAI回执为准",
}));
export const AGENTAI_VIDEOS = [
  {
    id: "minimax-h3",
    model: "minimax-h3",
    label: "MiniMax H3",
    durations: Array.from({ length: 12 }, (_, i) => i + 4),
    maxImages: 9,
    maxBytes: 30 * 1024 * 1024,
    minImageSide: 256,
    maxImageSide: 5760,
    resolutions: ["768p", "2k"],
    aspects: ["16:9", "9:16", "21:9", "4:3", "1:1", "3:4"],
    maxPromptChars: 20000,
  },
  {
    id: "seedance-2-5",
    model: "seedance-2-5",
    label: "Seedance 2.5 · 官方直连",
    durations: Array.from({ length: 27 }, (_, i) => i + 4),
    maxImages: 30,
    maxBytes: 5 * 1024 * 1024,
    minImageSide: 300,
    maxImageSide: 6000,
    resolutions: ["720p", "480p", "1080p"],
    aspects: ["16:9", "9:16", "21:9", "3:4", "1:1", "4:3"],
    maxPromptChars: 30000,
  },
  {
    id: "seedance-2-5-special",
    model: "seedance-2-5-special",
    label: "Seedance 2.5 · 特价按次",
    durations: [30],
    maxImages: 10,
    maxBytes: 30 * 1024 * 1024,
    resolutions: ["720p", "480p"],
    aspects: ["16:9", "9:16", "21:9", "3:4", "1:1", "4:3"],
    maxPromptChars: 20000,
    params: { quality: "标准" },
  },
  {
    id: "seedance-2-5-promo",
    model: "seedance-2-5-promo",
    label: "Seedance 2.5 · 特价按秒",
    durations: Array.from({ length: 27 }, (_, i) => i + 4),
    maxImages: 30,
    maxBytes: 20 * 1024 * 1024,
    resolutions: ["480p", "720p", "1080p", "4k"],
    aspects: ["16:9", "9:16", "21:9", "3:4", "1:1", "4:3"],
    maxPromptChars: 15000,
    params: { quality: "标准" },
  },
  ...[
    { id: "seedance-2-0-official", label: "Seedance 2.0 · 官方直连" },
    { id: "seedance-2-0-special", label: "Seedance 2.0 · 特价按次" },
    { id: "seedance-2-0-promo", label: "Seedance 2.0 · 特价按秒" },
  ].map((model) => ({
    ...model,
    model: model.id,
    durations: model.id.endsWith("special")
      ? [15]
      : Array.from({ length: 12 }, (_, i) => i + 4),
    maxImages: 9,
    maxBytes: 5 * 1024 * 1024,
    minImageSide: 300,
    maxImageSide: 6000,
    resolutions: model.id.endsWith("special")
      ? ["720p", "480p"]
      : ["480p", "720p", "1080p", "4k"],
    aspects: ["16:9", "9:16", "21:9", "3:4", "1:1", "4:3"],
    maxPromptChars: 30000,
    params: { quality: "标准" },
  })),
  {
    id: "gk-imagine-1-5-7tu-special",
    model: "grok-imagine-1-5-7tu-special",
    publicId: "gk-imagine-1-5-7tu-special",
    label: "GK Imagine 1.5 Pro",
    durations: [3, 4, 5, 6, 8, 10, 12, 15],
    maxImages: 14,
    maxBytes: 5 * 1024 * 1024,
    resolutions: ["480p", "720p"],
    aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"],
    maxPromptChars: 4096,
  },
  {
    id: "mu-video",
    model: "muse-video",
    publicId: "mu-video",
    label: "MU Video",
    // This workflow may bind up to nine images. Ten seconds is the supported
    // intersection for >4 references and for 3:2/2:3; never silently drop images.
    durations: [10],
    maxImages: 9,
    maxBytes: 20 * 1024 * 1024,
    resolutions: ["720p"],
    aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"],
    maxPromptChars: 20000,
  },
].map((model) => ({
  ...model,
  imagesField: "images",
  params: { mode: "reference", count: 1, ...model.params },
  note: `图片参考生视频${model.id === "mu-video" ? " · 当前为10秒参考模式" : ""}；生成音轨以模型实际输出为准。智能调度综合价格、成功率和耗时，故障自动切换可用渠道。`,
}));

const key = (config) => config.videoSecrets?.AGENTAI_API_KEY || "";
const definitionFor = (model) =>
  typeof model === "string" &&
  model.length > 0 &&
  [...AGENTAI_IMAGES, ...AGENTAI_VIDEOS].find((item) =>
    [item.model, item.publicId].includes(model),
  );
const entry = (config, model) =>
  typeof model === "string" &&
  model.length > 0 &&
  (config.agentaiModels || []).find((item) =>
    [item.publicId, item.model, item.id].includes(model),
  );
export function agentaiConfigured(config, model) {
  const item = entry(config, model);
  return (
    !!definitionFor(model) &&
    !!key(config) &&
    !!item?.available &&
    !!item.paramSchema
  );
}
function safeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("AgentAI 素材或结果未返回有效HTTPS地址");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw Error("AgentAI 素材或结果必须是无凭据的HTTPS地址");
  return url.href;
}
export function validateAgentAiParams(config, body) {
  const item = entry(config, body.model_id),
    schema = item?.paramSchema;
  if (!agentaiConfigured(config, body.model_id) || item.type !== body.modality)
    throw Error("AgentAI 连接或该模型目录尚未就绪，请同步目录后重试");
  const definition = definitionFor(body.model_id);
  if (!definition) throw Error("AgentAI 此型号尚未接入当前媒体工作流");
  if (
    typeof body.params?.prompt !== "string" ||
    !body.params.prompt.trim() ||
    [...body.params.prompt].length > definition.maxPromptChars
  )
    throw Error("AgentAI 提示词为空或超过当前模型限制");
  const params = {
    ...Object.fromEntries(
      Object.entries(schema)
        .filter(([, rule]) => rule.default !== undefined)
        .map(([name, rule]) => [name, rule.default]),
    ),
    ...body.params,
  };
  if (
    body.params.count !== 1 ||
    body.params.mode !==
      (body.modality === "image" ? "multi-reference" : "reference")
  )
    throw Error("AgentAI 当前工作流仅支持单次生成与已适配的图片参考模式");
  if (
    !definition.aspects.includes(body.params.aspect_ratio) ||
    (body.modality === "video" &&
      (!definition.durations.includes(Number(body.params.duration)) ||
        !definition.resolutions.includes(body.params.resolution)))
  )
    throw Error("AgentAI 当前工作流不支持所选画幅、时长或清晰度");
  const fields =
    body.modality === "image"
      ? [
          "prompt",
          "images",
          "mode",
          "count",
          "aspect_ratio",
          definition.sizeField,
          "quality",
          "output_format",
          "moderation",
        ]
      : [
          "prompt",
          "images",
          "mode",
          "count",
          "aspect_ratio",
          "duration",
          "resolution",
          "quality",
        ];
  const conditionMatches = (condition) =>
    !condition ||
    Object.entries(condition).every(
      ([other, values]) =>
        Array.isArray(values) && values.includes(params[other]),
    );
  for (const [name, value] of Object.entries(body.params)) {
    if (name === "prompt") continue;
    if (!fields.includes(name)) throw Error(`AgentAI 当前工作流未接入 ${name}`);
    const rule = schema[name];
    if (!rule) throw Error(`AgentAI 最新模型参数不支持 ${name}，未提交生成`);
    if (rule.enum && !rule.enum.includes(value))
      throw Error(`AgentAI 当前模型不支持所选 ${name}，未自动替换参数`);
    if (
      rule.type === "int" &&
      (!Number.isInteger(value) ||
        value < (rule.min ?? -Infinity) ||
        value > (rule.max ?? Infinity))
    )
      throw Error(`AgentAI ${name} 超出限制`);
    if (!conditionMatches(rule.available_when))
      throw Error(`AgentAI 当前模式不支持 ${name}`);
    const option = rule.options?.find((item) => item.value === value);
    if (
      option?.available === false ||
      !conditionMatches(option?.available_when)
    )
      throw Error(`AgentAI 当前参数组合不支持 ${name}`);
    const qualityValues = rule.enum_values_by_quality?.[params.quality];
    if (qualityValues && !qualityValues.includes(value))
      throw Error(`AgentAI 当前质量档位不支持 ${name}`);
    if (name === "images") {
      const limit = Math.min(
        definition.maxImages,
        rule.max_items_by_mode?.[body.params.mode] ?? rule.max_items ?? 0,
        rule.max_items_by_quality?.[params.quality] ?? rule.max_items ?? 0,
      );
      if (!Array.isArray(value) || value.length < 2 || value.length > limit)
        throw Error(`AgentAI 当前工作流参考图须为2～${limit}张，不会静默丢弃`);
    }
  }
  for (const [name, rule] of Object.entries(schema))
    if (
      rule.required &&
      rule.default === undefined &&
      !Object.hasOwn(body.params, name)
    )
      throw Error(`AgentAI 模型新增必填参数 ${name}，当前工作流尚未适配`);
  return definition;
}
export async function agentaiJson(config, path, body, feature) {
  if (!key(config))
    throw Error("AgentAI 尚未连接；不会使用星火或其他服务的密钥");
  const response = await (
    feature ? (url, init) => modelFetch(config, feature, url, init) : fetch
  )(new URL(path, AGENTAI_ORIGIN), {
    method: body ? "POST" : "GET",
    redirect: "error",
    signal: jobRequestSignal(body ? 60000 : 30000),
    headers: {
      Authorization: `Bearer ${key(config)}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      "X-Schedule-Strategy": "balanced",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw Object.assign(
      Error(`AgentAI HTTP ${response.status}；请核对原任务，不要重复提交`),
      {
        terminal: [404, 410].includes(response.status),
        statusCode: response.status,
      },
    );
  const result = await response.json();
  // A terminal task may carry its failure in `error`; preserve that receipt so
  // callers stop polling and accounting can record any reported charge.
  if (
    (result.error && typeof result.is_final !== "boolean") ||
    (result.code !== undefined && result.code !== 200)
  )
    throw Error("AgentAI 返回业务错误，请核对原任务");
  return result;
}
export async function uploadAgentAiImages(config, model, sources) {
  const definition = definitionFor(model);
  if (!definition || !agentaiConfigured(config, model))
    throw Error("AgentAI 图片上传配置不可用");
  const rule = entry(config, model).paramSchema.images;
  const maxBytes = Math.min(
    definition.maxBytes,
    rule?.max_bytes || definition.maxBytes,
  );
  const uploaded = new Map(),
    urls = [];
  for (const source of sources) {
    if (uploaded.has(source)) {
      urls.push(uploaded.get(source));
      continue;
    }
    if (typeof source === "string" && source.startsWith("https://")) {
      const url = safeUrl(source);
      uploaded.set(source, url);
      urls.push(url);
      continue;
    }
    const match =
      /^data:(image\/(?:jpeg|png|webp));base64,([a-zA-Z0-9+/]+={0,2})$/.exec(
        source || "",
      );
    if (!match) throw Error("AgentAI 参考图须为HTTPS或JPG、PNG、WebP图片");
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > maxBytes)
      throw Error(
        `AgentAI 单张参考图超过模型 ${Math.floor(maxBytes / 1024 / 1024)}MB 限制`,
      );
    const metadata = await sharp(bytes).metadata();
    const ratio = metadata.width / metadata.height;
    if (
      !metadata.width ||
      !metadata.height ||
      Math.min(metadata.width, metadata.height) < (rule.min_edge_px || 1) ||
      Math.max(metadata.width, metadata.height) > (rule.max_edge_px || 16384) ||
      metadata.width * metadata.height > 50000000 ||
      ratio < (rule.aspect_min ?? 0) ||
      ratio > (rule.aspect_max ?? Infinity)
    )
      throw Error("AgentAI 参考图尺寸不满足模型限制");
    const form = new FormData();
    form.set(
      "file",
      new Blob([bytes], { type: match[1] }),
      `reference.${match[1].split("/")[1]}`,
    );
    const response = await fetch(`${AGENTAI_ORIGIN}/v1/files`, {
      method: "POST",
      redirect: "error",
      signal: jobRequestSignal(60000),
      headers: { Authorization: `Bearer ${key(config)}` },
      body: form,
    });
    if (!response.ok)
      throw Error(`AgentAI 参考图上传失败 HTTP ${response.status}`);
    const url = safeUrl((await response.json()).url);
    uploaded.set(source, url);
    urls.push(url);
  }
  return urls;
}
function assertAdjustments(params, adjustments) {
  if (adjustments === undefined) return;
  if (
    !Array.isArray(adjustments) ||
    adjustments.some(
      (item) =>
        !Object.hasOwn(params, item?.param) ||
        !["spelling", "option_label", "synonym", "field_alias"].includes(
          item.reason,
        ) ||
        String(item.requested) !== String(item.applied) ||
        String(params[item.param]) !== String(item.applied),
    )
  )
    throw Error(
      "AgentAI 将调整本次生成参数，已停止自动提交/归档，请核对原任务",
    );
}
function assertEstimate(result, params) {
  for (const field of [
    "effective_total_rmb",
    "max_effective_total_rmb",
    "required_freeze_rmb",
  ])
    if (!Number.isFinite(result[field]) || result[field] < 0)
      throw Error("AgentAI 估价缺少有效金额，未提交生成");
  if (
    result.max_effective_total_rmb < result.effective_total_rmb ||
    result.required_freeze_rmb + 0.001 < result.max_effective_total_rmb
  )
    throw Error("AgentAI 估价金额不一致");
  if (
    params.duration &&
    Number(result.price_basis?.output_duration_sec) !== Number(params.duration)
  )
    throw Error("AgentAI 估价时长发生变化，未提交生成");
  assertAdjustments(params, result.param_adjustments);
}
const preparedMarker = Symbol("AgentAI checked estimate");
const requestHash = (body) =>
  createHash("sha256").update(JSON.stringify(body)).digest("hex");
export async function prepareAgentAi(config, body) {
  if (
    ["lane_id", "lane_ids", "pinned_lane_id", "pinned_lane_ids"].some((field) =>
      Object.hasOwn(body, field),
    )
  )
    throw Error("AgentAI 使用智能容灾调度，请重新估价，不能锁定单条渠道");
  validateAgentAiParams(config, body);
  const params = {
    ...body.params,
    images: await uploadAgentAiImages(
      config,
      body.model_id,
      body.params.images,
    ),
  };
  const quote = {
    model: body.model_id,
    modality: body.modality,
    params,
    include_all_channels: true,
    strategy: "balanced",
  };
  const first = await agentaiJson(config, "/v1/pricing-estimate", quote);
  assertEstimate(first, params);
  const heads = first.channels?.filter(
    (item) => item.is_delivery_head === true,
  );
  if (
    heads?.length !== 1 ||
    typeof heads[0].lane !== "string" ||
    !heads[0].lane
  )
    throw Error("AgentAI 估价未明确交付渠道，未提交生成");
  const prepared = {
    ...body,
    params,
    client_request_id: randomUUID(),
  };
  prepared[preparedMarker] = {
    hash: requestHash(prepared),
    submitted: false,
    estimatedAt: Date.now(),
    // Keep the quote for preflight review; it is not an actual bill and the
    // symbol property never enters the provider's JSON request.
    estimate: {
      currency: "CNY",
      effectiveTotal: first.effective_total_rmb,
      maximumTotal: first.max_effective_total_rmb,
      freezeTotal: first.required_freeze_rmb,
      strategy: "balanced",
    },
  };
  return prepared;
}
export async function submitAgentAi(config, body) {
  const prepared = body[preparedMarker]
    ? body
    : await prepareAgentAi(config, body);
  const receipt = prepared[preparedMarker];
  if (receipt.submitted || receipt.hash !== requestHash(prepared))
    throw Error(
      "AgentAI 估价参数已变更或请求已提交，请核对原任务，不会重复生成",
    );
  if (Date.now() - receipt.estimatedAt > 5 * 60 * 1000)
    throw Error("AgentAI 本次估价已过期，请重新核对后提交");
  validateAgentAiParams(config, prepared);
  // Mark before issuing a paid call. Even a lost HTTP response must never cause
  // a client-side re-submission of the same checked request.
  receipt.submitted = true;
  const response = await agentaiJson(
    config,
    "/api/v1/model-runtime/invoke",
    prepared,
    body.modality === "image" ? "aigc_image" : "aigc_video",
  );
  if (typeof response.task_id !== "string" || !response.task_id)
    throw Error("AgentAI 未返回任务编号；提交结果待核对，不会自动重提");
  try {
    assertAdjustments(prepared.params, response.param_adjustments);
  } catch (error) {
    throw Object.assign(error, {
      taskId: response.task_id,
      parameterMismatch: true,
    });
  }
  return response.task_id;
}
export async function pollAgentAi(config, model, modality, id) {
  const result = await agentaiJson(
    config,
    `/v1/tasks/${encodeURIComponent(id)}`,
  );
  if (result.is_final === false) return { pending: true, state: result.status };
  if (result.is_final !== true)
    throw Error("AgentAI 未返回明确终态，请继续核对原任务，不会重新生成");
  await modelReceipt(
    config,
    modality === "image" ? "aigc_image" : "aigc_video",
    AGENTAI_ORIGIN,
    model,
    { ...result, task_id: id },
  );
  if (result.status !== "completed") {
    if (modality === "image")
      throw Object.assign(Error("AgentAI 图片任务已失败或结束，未自动重提"), {
        terminal: true,
      });
    return {
      pending: false,
      state: result.status === "failed" ? "failed" : "unknown",
    };
  }
  const url = safeUrl(result.output_url);
  const cost =
    Number.isFinite(result.actual_cost_micro_usd) &&
    result.actual_cost_micro_usd >= 0
      ? { actual_cost_micro_usd: result.actual_cost_micro_usd }
      : undefined;
  return { pending: false, state: "success", url, cost };
}

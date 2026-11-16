import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { jobRequestSignal } from "./job-request.mjs";
import { modelFetch, modelReceipt } from "./ai-accounting.mjs";

// Reviewed against AgentAI's public logical-models/param_schema on 2026-11-16.
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
    id: "agentai-gt-image-2.5-flare",
    model: "gt-image-2.5-flare",
    label: "AgentAI · GT Image 2.5 Flare",
    maxImages: 17,
    maxBytes: 25 * 1024 * 1024,
    sizeField: "resolution",
    quality: "high",
    maxPromptChars: 32000,
  },
  {
    id: "agentai-gt-image-2.5-sunburst",
    model: "gt-image-2.5-sunburst",
    label: "AgentAI · GT Image 2.5 Sunb",
    maxImages: 16,
    maxBytes: 25 * 1024 * 1024,
    sizeField: "resolution",
    quality: "high",
    maxPromptChars: 32000,
  },
  {
    id: "agentai-gm-3-pro-image",
    model: "gm-3-pro-image",
    label: "AgentAI · GM 3 Pro Image",
    maxImages: 14,
    maxBytes: 10 * 1024 * 1024,
    sizeField: "size",
    maxPromptChars: 30000,
  },
  {
    id: "agentai-gm-3.1-flash-image",
    model: "gm-3.1-flash-image",
    label: "AgentAI · GM 3.1 Flash Image",
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
    label: "Seedance 2.5",
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
    id: "vo-3.1",
    model: "vo-3.1",
    label: "VO 3.1",
    durations: [8],
    maxImages: 3,
    maxBytes: 10 * 1024 * 1024,
    resolutions: ["720p", "1080p"],
    aspects: ["16:9", "9:16"],
    maxPromptChars: 30000,
    params: { quality: "快速" },
  },
].map((model) => ({
  ...model,
  imagesField: "images",
  params: { mode: "reference", count: 1, ...model.params },
  note: "仅图片参考生视频；未接入参考视频、参考音频、首尾帧或编辑模式。生成音轨以模型实际输出为准。",
}));

const key = (config) => config.videoSecrets?.AGENTAI_API_KEY || "";
const entry = (config, model) =>
  (config.agentaiModels || []).find((item) =>
    [item.publicId, item.model, item.id].includes(model),
  );
export function agentaiConfigured(config, model) {
  const item = entry(config, model);
  return !!key(config) && !!item?.available && !!item.paramSchema;
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
  const definition = [...AGENTAI_IMAGES, ...AGENTAI_VIDEOS].find(
    (model) => model.model === body.model_id,
  );
  if (!definition) throw Error("AgentAI 此型号尚未接入当前媒体工作流");
  if (
    typeof body.params?.prompt !== "string" ||
    !body.params.prompt.trim() ||
    [...body.params.prompt].length > definition.maxPromptChars
  )
    throw Error("AgentAI 提示词为空或超过当前模型限制");
  for (const [name, value] of Object.entries(body.params)) {
    if (name === "prompt") continue;
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
    if (
      rule.available_when &&
      Object.entries(rule.available_when).some(
        ([other, values]) => !values.includes(body.params[other]),
      )
    )
      throw Error(`AgentAI 当前模式不支持 ${name}`);
    if (name === "images") {
      const limit = Math.min(
        definition.maxImages,
        rule.max_items_by_mode?.[body.params.mode] ?? rule.max_items ?? 0,
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
  const definition = [...AGENTAI_IMAGES, ...AGENTAI_VIDEOS].find(
    (item) => item.model === model,
  );
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
function assertEstimate(result, params, lane) {
  for (const field of [
    "effective_total_rmb",
    "max_effective_total_rmb",
    "required_freeze_rmb",
  ])
    if (!Number.isFinite(result[field]) || result[field] < 0)
      throw Error("AgentAI 估价缺少有效金额，未提交生成");
  if (
    result.max_effective_total_rmb < result.effective_total_rmb ||
    result.required_freeze_rmb + 0.001 < result.effective_total_rmb
  )
    throw Error("AgentAI 估价金额不一致");
  if (
    params.duration &&
    Number(result.price_basis?.output_duration_sec) !== Number(params.duration)
  )
    throw Error("AgentAI 估价时长发生变化，未提交生成");
  assertAdjustments(params, result.param_adjustments);
  if (
    lane &&
    (Math.abs(result.max_effective_total_rmb - result.effective_total_rmb) >
      0.001 ||
      result.channels?.filter((item) => item.is_delivery_head).length !== 1 ||
      result.channels.find((item) => item.is_delivery_head)?.lane !== lane)
  )
    throw Error("AgentAI 估价未锁定所选渠道");
}
export async function prepareAgentAi(config, body) {
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
  const pinned = await agentaiJson(config, "/v1/pricing-estimate", {
    ...quote,
    pinned_lane_id: heads[0].lane,
  });
  assertEstimate(pinned, params, heads[0].lane);
  if (Math.abs(first.effective_total_rmb - pinned.effective_total_rmb) > 0.001)
    throw Error("AgentAI 提交前估价变化，请重新核对");
  return {
    ...body,
    params,
    lane_id: heads[0].lane,
    client_request_id: randomUUID(),
  };
}
export async function submitAgentAi(config, body) {
  const prepared = body.lane_id ? body : await prepareAgentAi(config, body);
  validateAgentAiParams(config, prepared);
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

// Provider endpoints and credentials are separate from model capabilities. Only
// non-secret routing snapshots are persisted with jobs; keys stay on the server.
import { xhaiJson } from "./xhai-files.mjs";
import { jobRequestSignal } from "./job-request.mjs";
import { omniReferences } from "./media-references.mjs";
import { videoRoleProfile } from "../shared/video-role-profile.mjs";
import { validateRoleBindingPayload } from "./video-role-binding.mjs";

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const ratios = ["16:9", "9:16", "1:1", "4:3", "3:4"];
export const MEDIA_MODELS = [
  { id: "h3-omni", label: "海螺 H3 全能参考", group: "全能参考", channel: "DMC-default", keyEnv: "XYLP_VIDEO_H3_OMNI_KEY", model: "hailuo-h3-quannengcankao", imagesField: "image_url", params: {}, durations: range(4, 15), maxImages: 9, resolutions: ["768P"], aspects: [...ratios, "21:9"], note: "支持图片、视频、音频参考，输出有声视频。", successRate: 100, speedSeconds: 702, priceHint: "0.1242 算力/秒（DMC-default，768P）" },
  { id: "sd20-omni", label: "SD 2.0 全能参考按秒", group: "全能参考", channel: "官方特惠", keyEnv: "XYLP_VIDEO_SD20_OMNI_KEY", model: "seedance-2.0-anmiao-quannengcankao", imagesField: "image_url", params: { version: "标准" }, durations: range(4, 15), maxImages: 9, resolutions: ["720p", "480p", "1080p"], aspects: [...ratios, "21:9"], note: "支持图片、视频、音频参考，按输出秒数计费。", successRate: 96, speedSeconds: 220, priceHint: "480p 0.4968 / 720p 1.1178 算力/秒（官方特惠，标准版）" },
  { id: "sd25-omni", label: "SD 2.5 全能参考按秒", group: "全能参考", channel: "官方特惠", keyEnv: "XYLP_VIDEO_SD25_OMNI_KEY", model: "seedance-2.5-anmiao-quannengcankao", imagesField: "image_url", params: {}, durations: range(4, 30), maxImages: 30, resolutions: ["720p", "480p", "1080p"], aspects: [...ratios, "21:9"], note: "支持图片、视频、音频参考，适合长镜头。", successRate: 100, speedSeconds: 396, priceHint: "480p 0.7037 / 720p 1.6974 算力/秒（官方特惠）" },
  { id: "vidu-q3-turbo", label: "Vidu Q3 Turbo 参考生", group: "多图参考", channel: "Vidu-官方", keyEnv: "XYLP_VIDEO_VIDU_Q3_KEY", model: "viduq3-turbo-cankaosheng", imagesField: "images", params: { off_peak: false }, durations: range(3, 16), maxImages: 7, resolutions: ["540p", "720p", "1080p"], aspects: ratios, note: "用 2～7 张人物、商品与场景图保持主体一致；默认关闭错峰模式。", successRate: 100, speedSeconds: 89, priceHint: "540p 0.2484 / 720p 0.3933 算力/秒（Vidu-官方）" },
  { id: "gk-video-35", label: "GK-video-3.5", group: "单图参考", channel: "MC-GK1.5官转分组 / XT-GK", keyEnv: "XYLP_VIDEO_GK35_KEY", model: "gk-video-3.5", inputMode: "first-frame", imagesField: "images", params: {}, durations: range(1, 15), maxImages: 1, resolutions: ["720p", "480p"], aspects: ["16:9", "9:16", "1:1", "3:2", "2:3"], note: "只提交 1 张已验收首帧；成片自带音频。", successRate: 99.5, speedSeconds: 56.8, priceHint: "0.207 算力/秒（MC/XT）" },
  { id: "omni-11", label: "Omni 1.1", group: "单图参考", channel: "MC-omni-2", keyEnv: "XYLP_VIDEO_OMNI11_KEY", model: "omni-1.1", inputMode: "first-frame", imagesField: "images", params: {}, durations: range(3, 10), maxImages: 1, resolutions: ["720P", "1080P", "4K"], aspects: ["16:9", "9:16"], note: "提交 1 张已验收首帧，适合首帧还原；成片自带音效，先用 720P 试稿。", successRate: 95.3, speedSeconds: 105, priceHint: "720P 0.1242 算力/秒（MC-omni-2）" },
];

for (const model of MEDIA_MODELS) {
  const mediaReferences = omniReferences(model.id);
  if (mediaReferences) Object.assign(model, { mediaReferences, note: `支持图片、视频和音频参考；视频最多 ${mediaReferences.video.maxFiles} 个，音频最多 ${mediaReferences.audio.maxFiles} 段。参考视频按其时长 × 输出秒单价的 ${mediaReferences.video.priceMultiplier * 100}% 另计，每个生成分段均计入；音频不另收费。` });
}

// Saved projects and paid jobs may still reference these IDs. Keep them
// routable for recovery, but never offer them for new selections.
const LEGACY_MEDIA_MODELS = [
  { id: "grok", label: "GK-video-3.5（旧路由）", model: "gk-video-3.5", legacy: true, inputMode: "first-frame", imagesField: "images", imagesValue: "single", params: {}, durations: range(1, 15), maxImages: 1, resolutions: ["720p", "480p"], aspects: ["16:9", "9:16", "1:1", "3:2", "2:3"] },
  { id: "minimax", label: "MiniMax H3（旧路由）", model: "minimax-h3", legacy: true, imagesField: "image_url", params: { mode: "cankaosheng" }, durations: range(4, 15), maxImages: 9, resolutions: ["768P", "1080P", "2K", "4K"], aspects: [...ratios, "21:9"] },
  { id: "seedance", label: "Seedance 2.5（旧路由）", model: "seedance-2.5-guanfang", legacy: true, imagesField: "image_url", params: { mode: "cankaosheng" }, durations: range(4, 30), maxImages: 30, resolutions: ["720p", "480p", "1080p"], aspects: [...ratios, "21:9", "2:3", "3:2"] },
  { id: "kling", label: "可灵 V3 Omni（旧路由）", model: "kling-v3-omni-cankao", legacy: true, imagesField: "images", params: {}, durations: [5, 10, 15], maxImages: 7, resolutions: ["std", "pro"], qualityField: "mode", aspects: ratios.slice(0, 3) },
  { id: "vidu", label: "Vidu Q3 Turbo（旧路由）", model: "viduq3-turbo-cankaosheng", legacy: true, imagesField: "images", params: { off_peak: false }, durations: range(3, 16), maxImages: 7, resolutions: ["720p", "540p", "1080p"], aspects: ratios },
  { id: "omni", label: "Omni Flash（旧路由）", model: "omni_flash-10s", legacy: true, imagesField: "images", params: {}, durations: [10], durationField: null, maxImages: 7, resolutions: ["720p"], qualityField: null, aspects: ratios.slice(0, 2) },
  { id: "wan", label: "通义万相 3.0（旧路由）", model: "wan3.0-video-cankaosheng", legacy: true, imagesField: "reference_urls", params: { version: "standard", audio: false, prompt_extend: false }, durations: range(2, 30), maxImages: 10, minImageSide: 240, resolutions: ["720P", "480P", "1080P"], aspectField: "ratio", aspects: ratios },
];

// 星火 AIGC exposes the media request envelope but uses a separate task-status
// endpoint and response shape. Keep its model IDs and capabilities independent
// from the similarly named 玄宇令牌 routes.
export const XHAI_MODELS = [
  { id: "seedance25", label: "Seedance 2.5 · 官方直连", model: "seedance-2-5", imagesField: "images", params: { mode: "reference" }, durations: [4, 5, 6, 8, 10, 12, 15, 20, 25, 29, 30], maxImages: 30, minImageSide: 300, resolutions: ["720p", "480p", "1080p"], aspects: ["16:9", "9:16", "21:9", "3:4", "1:1", "4:3"], maxPromptChars: 30000 },
  { id: "seedance20", label: "Seedance 2.0 · 官方直连", model: "seedance-2-0-official", imagesField: "images", params: { mode: "reference", quality: "标准" }, durations: range(4, 15), maxImages: 9, minImageSide: 300, resolutions: ["720p", "480p", "1080p", "4k"], aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], maxPromptChars: 30000 },
  { id: "kling3turbo", label: "可灵 3.0 Turbo", model: "kling-3.0-turbo", inputMode: "first-frame", imagesField: "images", params: { mode: "first-frame" }, durations: [3, 5, 8, 10, 15], maxImages: 1, minImageSide: 300, resolutions: ["720p"], aspects: ["16:9", "9:16"], maxPromptChars: 4000, note: "只提交已验收的 1 张首帧；人物和商品原图用于制作首帧。" },
  { id: "klingomni", label: "可灵 V3 Omni 参考生", model: "kling-v3-omni-cankao", imagesField: "images", params: {}, durations: [5, 6, 10, 15], maxImages: 9, minImageSide: 300, resolutions: ["std", "pro"], qualityField: "mode", aspects: ["16:9", "9:16", "1:1"], maxPromptChars: 2500 },
  { id: "gk15pro", label: "GK Imagine 1.5 Pro", model: "grok-imagine-1-5-7tu-special", imagesField: "images", params: { mode: "reference" }, durations: [3, 5, 6, 8, 10, 12, 15], maxImages: 7, resolutions: ["720p", "480p"], aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"], maxPromptChars: 4096, maxPromptBytes: 4096 },
  { id: "gk15", label: "GK Imagine 1.5", model: "grok-imagine-1.5", imagesField: "images", params: {}, durations: [4, 6, 8, 10, 12, 15, 20, 30], durationsByResolution: { "1080p": [4, 6, 8, 10, 12, 15] }, maxImages: 7, resolutions: ["720p", "480p", "1080p"], aspects: ["16:9", "9:16", "1:1"], maxPromptChars: 4500, maxPromptBytes: 4096, note: "1080p 最长 15 秒；20 和 30 秒仅支持 480p / 720p。" },
  { id: "minimaxh3", label: "MiniMax H3", model: "minimax-h3", imagesField: "images", params: { mode: "reference" }, durations: range(4, 15), maxImages: 9, minImageSide: 256, resolutions: ["768p", "2k"], aspects: ["16:9", "9:16", "21:9", "4:3", "1:1", "3:4"], maxPromptChars: 7000 },
  { id: "viduq3", label: "Vidu Q3", model: "viduq3", imagesField: "images", params: { mode: "reference", off_peak: false }, durations: [4, 5, 8, 12, 16], maxImages: 7, resolutions: ["720p", "540p", "1080p"], aspects: ["16:9", "9:16", "4:3", "3:4", "1:1"], maxPromptChars: 5000 },
  { id: "wan30", label: "Wan 3.0", model: "wan-3-0", imagesField: "images", params: { mode: "reference" }, durations: range(4, 30), maxImages: 10, minImageSide: 240, resolutions: ["720p", "480p", "1080p"], aspects: ["16:9", "9:16", "3:4", "4:3", "1:1"], maxPromptChars: 20000, maxPromptBytes: 61440 },
];

function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("视频服务地址必须是无凭据、无查询参数的 HTTPS URL");
  return url.href.replace(/\/+$/, "");
}

export function videoProviders(config) {
  const builtins = [
    { id: "xai", label: "xAI 官方", protocol: "xai", baseUrl: config.xaiBaseUrl || "https://api.x.ai/v1", keyEnv: "XAI_API_KEY", models: [
      { id: "grok", label: "Grok Imagine Video", model: config.xaiVideoModel || "grok-imagine-video-1.5", durations: range(1, 15), maxImages: 7, resolutions: ["720p", "480p", "1080p"], aspects: [...ratios, "21:9", "2:3", "3:2"] },
    ] },
    { id: "xylp", label: "玄宇令牌", protocol: "media", baseUrl: config.videoRelayBaseUrl || "https://api.lk888.ai", keyEnv: "VIDEO_RELAY_API_KEY", models: [...MEDIA_MODELS, ...LEGACY_MEDIA_MODELS] },
    { id: "xhai", label: "星火 AIGC", protocol: "xhai", baseUrl: `${(config.xhaiBaseUrl || "https://xhai.token6688.com").replace(/\/+$/, "")}/v1`, keyEnv: "XHAI_API_KEY", models: XHAI_MODELS },
  ];
  const providers = [...builtins];
  for (const item of config.videoProviders || []) {
    const at = providers.findIndex(p => p.id === item.id);
    const provider = { ...item, models: item.models || (item.protocol === "media" ? MEDIA_MODELS : item.protocol === "xhai" ? XHAI_MODELS : []) };
    if (at >= 0) providers[at] = provider; else providers.push(provider);
  }
  for (const p of providers) {
    if (!/^[\w-]+$/.test(p.id) || !["xai", "media", "xhai"].includes(p.protocol) || !/^[A-Z][A-Z0-9_]*$/.test(p.keyEnv)) throw new Error("视频中转站配置无效");
    p.baseUrl = endpoint(p.baseUrl);
    if (!p.models.length || new Set(p.models.map(m => m.id)).size !== p.models.length) throw new Error("视频模型列表为空或 ID 重复");
    for (const m of p.models) {
      if (!m.id || !m.model || !m.durations?.length || !m.resolutions?.length || !m.aspects?.length || !(m.maxImages >= 1)) throw new Error("视频模型能力配置不完整");
      if (["media", "xhai"].includes(p.protocol) && !m.imagesField) throw new Error("媒体模型缺少参考图字段映射");
      if (m.inputMode && !["first-frame", "references"].includes(m.inputMode)) throw new Error("视频模型输入模式无效");
      if (m.imagesValue && !["single", "array"].includes(m.imagesValue)) throw new Error("视频模型图片字段类型无效");
      if (m.inputMode === "first-frame" && (!["media", "xhai"].includes(p.protocol) || m.maxImages !== 1)) throw new Error("首帧模型须使用媒体协议且只接收 1 张图");
      if (m.imagesValue === "single" && m.maxImages !== 1) throw new Error("单图字段不能配置多张参考图");
      if (m.mediaReferences && (p.protocol !== "media" || m.inputMode === "first-frame")) throw new Error("视频、音频参考仅支持已适配的多图媒体协议");
      for (const type of ["video", "audio"]) {
        const cap = m.mediaReferences?.[type];
        if (cap && (!/^[a-z][a-z0-9_]*$/.test(cap.field || "") || [m.imagesField, m.aspectField || "aspect_ratio", m.durationField || "duration", m.qualityField || "resolution", "prompt", "model", "__proto__", "constructor"].includes(cap.field) || !Number.isInteger(cap.maxFiles) || cap.maxFiles < 1 || cap.maxFiles > 10 || !Array.isArray(cap.extensions) || !cap.extensions.length || ![cap.maxBytes, cap.minSeconds, cap.maxSeconds, cap.maxTotalSeconds].every(v => Number.isFinite(v) && v > 0) || cap.minSeconds > cap.maxSeconds || !Number.isFinite(cap.priceMultiplier) || cap.priceMultiplier < 0)) throw new Error("视频、音频参考能力配置无效");
      }
    }
  }
  return providers;
}

export function videoKey(config, route) {
  return route.keyEnv === "XAI_API_KEY" ? config.xaiApiKey : config.videoSecrets?.[route.keyEnv];
}

export function videoCatalog(config) {
  return videoProviders(config).map(p => ({
    id: p.id, label: p.label, configured: p.models.some(model => !model.legacy && Boolean(videoKey(config, { ...p, keyEnv: p.id === "xylp" ? model.keyEnv || p.keyEnv : p.keyEnv }))),
    models: p.models.filter(model => !model.legacy).map(({ id, label, group, channel, keyEnv, successRate, speedSeconds, priceHint, durations, durationsByResolution, maxImages, resolutions, aspects, note, inputMode = "references", minImageSide, mediaReferences }) => ({ id, label, group, channel, successRate, speedSeconds, priceHint, configured: Boolean(videoKey(config, { ...p, keyEnv: p.id === "xylp" ? keyEnv || p.keyEnv : p.keyEnv })), durations, durationsByResolution, maxImages, resolutions, aspects, note, inputMode, minImageSide, mediaReferences, roleBinding: videoRoleProfile({id,inputMode}) })),
  }));
}

export function selectVideoRoute(config, selection = {}) {
  const provider = videoProviders(config).find(p => p.id === (selection?.providerId || "xai"));
  if (!provider) throw new Error("所选视频中转站不存在，请重新选择");
  const model = provider.models.find(m => m.id === (selection?.modelId || provider.models[0].id));
  if (!model) throw new Error("所选视频模型不存在，请重新选择");
  const resolution = selection?.resolution || model.resolutions[0];
  if (!model.resolutions.includes(resolution)) throw new Error("所选画质不受该模型支持");
  const selectedModel = structuredClone(model);
  selectedModel.durations = model.durationsByResolution?.[resolution] || model.durations;
  return { id: provider.id, label: provider.label, protocol: provider.protocol, baseUrl: provider.baseUrl, keyEnv: provider.id === "xylp" ? selectedModel.keyEnv || provider.keyEnv : provider.keyEnv, model: selectedModel, resolution };
}

export function validateVideoInput(route, { prompt, duration, aspectRatio, referenceImages, referenceVideos = [], referenceAudios = [], roleBinding }) {
  const m = route.model;
  validateRoleBindingPayload(roleBinding,referenceImages);
  for (const [type, urls] of [["video", referenceVideos], ["audio", referenceAudios]]) {
    if (!Array.isArray(urls) || (urls.length && (!m.mediaReferences?.[type] || route.protocol !== "media" || urls.length > m.mediaReferences[type].maxFiles))) throw new Error(`当前模型不支持所选数量的${type === "video" ? "视频" : "音频"}参考，不会静默丢弃`);
    for (const value of urls) {
      let url; try { url = new URL(value); } catch { throw new Error("生成参考素材必须使用 HTTPS 文件地址"); }
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("生成参考素材必须使用 HTTPS 文件地址");
    }
  }
  if (m.maxPromptChars && [...(prompt || "")].length > m.maxPromptChars) throw new Error(`${m.label} 提示词超过 ${m.maxPromptChars} 字符，请缩短分镜与商品描述后重试`);
  if (m.maxPromptBytes && Buffer.byteLength(prompt || "", "utf8") > m.maxPromptBytes) throw new Error(`${m.label} 提示词超过 ${m.maxPromptBytes} 字节，请缩短分镜与商品描述后重试`);
  if (!m.durations.includes(duration)) throw new Error(`${m.label} 不支持 ${duration} 秒；支持 ${m.durations.join("、")} 秒。未提交，不会自动延长计费。`);
  if (!m.aspects.includes(aspectRatio)) throw new Error(`${m.label} 不支持 ${aspectRatio} 比例`);
  if (m.inputMode === "first-frame") {
    if (referenceImages.length !== 1) throw new Error(`${m.label} 必须且只能提交 1 张已验收首帧；不会从多张素材中自动取第一张。`);
  } else if (referenceImages.length > m.maxImages || referenceImages.length < 2) throw new Error(`${m.label} 本次需要同时引用人物和商品，参考图须为 2～${m.maxImages} 张；不会静默丢弃素材。`);
}

export function videoReferenceCount(route, sourceCount, includeKeyframe = false) {
  return route.model.inputMode === "first-frame" ? 1 : sourceCount + Number(includeKeyframe);
}

export function videoRequestBody(route, input) {
  validateVideoInput(route, input);
  const { prompt, duration, aspectRatio, referenceImages } = input;
  const m = route.model;
  if (route.protocol === "xai") return { model: m.model, prompt, reference_images: referenceImages.map(url => ({ url })), duration, aspect_ratio: aspectRatio, resolution: route.resolution, generate_audio: false };
  const params = { ...m.params, [m.imagesField]: m.imagesValue === "single" ? referenceImages[0] : referenceImages, [m.aspectField || "aspect_ratio"]: aspectRatio };
  if (input.referenceVideos?.length) params[m.mediaReferences.video.field] = input.referenceVideos;
  if (input.referenceAudios?.length) params[m.mediaReferences.audio.field] = input.referenceAudios;
  if (m.durationField !== null) params[m.durationField || "duration"] = String(duration);
  if (m.qualityField !== null) params[m.qualityField || "resolution"] = route.resolution;
  return { model: m.model, prompt, params };
}

function xhaiInvokeBody(route, input) {
  const { model, prompt, params } = videoRequestBody(route, input);
  const images = params[route.model.imagesField];
  if (!Array.isArray(images) || images.some(url => typeof url !== "string" || !url.startsWith("https://"))) {
    throw new Error("星火 AIGC 估价和视频提交需要先上传全部参考图，获得 HTTPS 地址");
  }
  // The unified invoke endpoint takes prompt inside params, unlike /v1/media/generate.
  return { model_id: model, modality: "video", params: { ...params, prompt } };
}

function sameParamValue(param, left, right) {
  if (param === "duration") return Number.isFinite(Number(left)) && Number(left) === Number(right);
  if (param === "resolution") return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function assertXhaiAdjustments(params, adjustments) {
  if (adjustments === undefined) return;
  if (!Array.isArray(adjustments)) throw new Error("星火 AIGC 参数调整回执格式不完整，未提交视频");
  for (const item of adjustments) {
    const harmlessNotation = ["spelling", "option_label", "synonym", "field_alias"].includes(item?.reason);
    if (!harmlessNotation || !Object.hasOwn(params, item.param) || !sameParamValue(item.param, item.requested, item.applied) || !sameParamValue(item.param, params[item.param], item.applied)) {
      throw new Error(`星火 AIGC 会调整 ${item?.param || "未知参数"}（${item?.reason || "未知原因"}），无法保证所选时长、画质、模式和计费`);
    }
  }
}

function assertXhaiEstimate(estimate, params, duration, laneId) {
  for (const field of ["effective_total_rmb", "max_effective_total_rmb", "required_freeze_rmb"]) {
    if (typeof estimate?.[field] !== "number" || !Number.isFinite(estimate[field]) || estimate[field] < 0) throw new Error(`星火 AIGC 估价缺少有效的 ${field}`);
  }
  if (estimate.max_effective_total_rmb + 0.001 < estimate.effective_total_rmb || estimate.required_freeze_rmb + 0.001 < estimate.max_effective_total_rmb) throw new Error("星火 AIGC 估价上界不一致");
  if (!Number.isFinite(Number(estimate.price_basis?.output_duration_sec)) || Number(estimate.price_basis.output_duration_sec) !== duration) throw new Error("星火 AIGC 估价时长与所选时长不一致");
  assertXhaiAdjustments(params, estimate.param_adjustments);
  if (laneId) {
    if (Math.abs(estimate.max_effective_total_rmb - estimate.effective_total_rmb) > 0.001) throw new Error("星火 AIGC 未锁定单一计费渠道");
    const heads = estimate.channels?.filter(channel => channel?.is_delivery_head === true);
    if (heads?.length !== 1 || heads[0].lane !== laneId) throw new Error("星火 AIGC 钉渠道估价未确认所选渠道");
  }
}

export async function preflightXhaiVideo(config, route, input) {
  if (route.protocol !== "xhai") return undefined;
  const key = videoKey(config, route);
  if (!key) throw new Error(`${route.label} 尚未配置 ${route.keyEnv}`);
  const request = xhaiInvokeBody(route, input);
  const estimateBody = { model: request.model_id, modality: "video", params: request.params, include_all_channels: true };
  const first = await xhaiJson(route.baseUrl, key, "/v1/pricing-estimate", estimateBody);
  assertXhaiEstimate(first, request.params, input.duration);
  const heads = first.channels?.filter(channel => channel?.is_delivery_head === true);
  if (heads?.length !== 1 || typeof heads[0].lane !== "string" || !heads[0].lane) throw new Error("星火 AIGC 估价未明确可用的交付渠道，视频未提交");
  const laneId = heads[0].lane;
  const pinned = await xhaiJson(route.baseUrl, key, "/v1/pricing-estimate", { ...estimateBody, pinned_lane_id: laneId });
  assertXhaiEstimate(pinned, request.params, input.duration, laneId);
  if (Math.abs(first.effective_total_rmb - pinned.effective_total_rmb) > 0.001) throw new Error("星火 AIGC 交付渠道估价在提交前发生变化");
  return { request: { ...request, lane_id: laneId }, effectiveTotalRmb: pinned.effective_total_rmb, requiredFreezeRmb: pinned.required_freeze_rmb };
}

export class XhaiVideoAdjustmentError extends Error {
  constructor(taskId, message) {
    super(message);
    this.name = "XhaiVideoAdjustmentError";
    this.taskId = taskId;
  }
}

export async function mediaCall(config, route, pathname, body) {
  const key = videoKey(config, route);
  if (!key) throw new Error(`${route.label} 尚未配置 ${route.keyEnv}`);
  const response = await fetch(`${route.baseUrl}${pathname}`, {
    method: body ? "POST" : "GET", redirect: "error", signal: jobRequestSignal(body ? 310_000 : 60_000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${route.label} HTTP ${response.status}`);
  const result = await response.json();
  if (["media", "xhai"].includes(route.protocol) && result.code !== undefined && result.code !== 200) throw new Error(`${route.label} 返回业务错误 ${result.code}`);
  return result.code !== undefined && result.data && !Array.isArray(result.data) ? result.data : result;
}

export async function submitVideo(config, route, input, preflight) {
  const body = videoRequestBody(route, input);
  if (route.protocol === "xhai") {
    const key = videoKey(config, route);
    if (!key) throw new Error(`${route.label} 尚未配置 ${route.keyEnv}`);
    const { lane_id: laneId, ...prepared } = preflight?.request || {};
    if (typeof laneId !== "string" || !laneId || JSON.stringify(prepared) !== JSON.stringify(xhaiInvokeBody(route, input))) throw new Error("星火 AIGC 视频缺少与本次参数一致的单渠道估价，未提交");
    const response = await xhaiJson(route.baseUrl, key, "/api/v1/model-runtime/invoke", preflight.request);
    if (response.task_id === undefined || response.task_id === null || !String(response.task_id)) throw new Error("星火 AIGC 未返回任务编号，提交结果待核对");
    const id = String(response.task_id);
    try { assertXhaiAdjustments(preflight.request.params, response.param_adjustments); }
    catch (error) { throw new XhaiVideoAdjustmentError(id, `${error.message}；任务 ${id} 已创建，已暂停自动归档，请人工核对`); }
    return id;
  }
  const result = await mediaCall(config, route, route.protocol === "xai" ? "/videos/generations" : "/v1/media/generate", body);
  const id = route.protocol === "xai" ? result.request_id : result.task_id;
  if (id === undefined || id === null || !String(id)) throw new Error("供应商未返回任务编号，提交结果待核对");
  return String(id);
}

export async function pollVideo(config, route, id) {
  const result = await mediaCall(config, route, route.protocol === "xai" ? `/videos/${encodeURIComponent(id)}` : route.protocol === "xhai" ? `/tasks/${encodeURIComponent(id)}` : `/v1/media/status?task_id=${encodeURIComponent(id)}`);
  if (route.protocol === "xai") return { pending: ["pending", "queued", "in_progress"].includes(result.status), url: result.status === "done" ? result.video?.url : undefined, state: result.status };
  if (route.protocol === "xhai") {
    const state = result.status;
    if (result.is_final === false) return { pending: true, state };
    const url = [result.output_url, result.result_url, result.result?.videos?.[0]?.url, ...(Array.isArray(result.data) ? result.data.filter(item => item?.type === "video").map(item => item.url) : [])].find(value => typeof value === "string" && value.length);
    const cost = Number.isFinite(result.actual_cost_micro_usd) ? { actual_cost_micro_usd: result.actual_cost_micro_usd } : undefined;
    return { pending: false, url: result.is_final === true && state === "completed" ? url : undefined, state: state === "completed" ? "success" : state, cost };
  }
  if (result.is_final === false && ["pending", "running"].includes(result.state)) return { pending: true, state: result.state };
  return { pending: false, url: result.is_final === true && result.state === "success" && typeof result.result_url === "string" ? result.result_url : undefined, state: result.state, cost: result.cost };
}

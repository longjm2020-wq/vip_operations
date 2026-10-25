import { mediaCall, videoKey } from "./video-providers.mjs";
import { uploadXhaiImages, xhaiJson } from "./xhai-files.mjs";
import { fail } from "./access.mjs";

// Vendor API names verified against its media protocol on 2026-09-22.
// Do not alias TT Image to an unverified upstream model name.
const aspects = ["1:1", "9:16", "16:9", "2:3", "3:2", "3:4", "4:3"];
export const IMAGE_MODELS = [
  { id: "tt-image-2", label: "TT Image 2", adapter: "tt-size", maxImages: 14, aspects, preset: "high", detail: "高质量" },
  { id: "banana-pro", label: "纳米香蕉 Pro", adapter: "banana", keyEnv: "XYLP_IMAGE_BANANA_PRO_KEY", channel: "MC-限时特惠", successRate: 98.7, speedSeconds: 58.5, priceHint: "0.1863 算力/次（1K / 2K / 4K）", maxImages: 14, maxModelImages: 5, maxProductImages: 6, aspects: [...aspects, "4:5", "5:4", "21:9"], preset: "2K", detail: "适合人物、商品融合；先用 2K 试稿" },
  { id: "banana-2", label: "纳米香蕉 2", adapter: "banana", maxImages: 14, aspects: [...aspects, "4:5", "5:4", "21:9"], preset: "2K", detail: "2K · 快速" },
  { id: "tt-image-2.5", label: "TT Image 2.5", adapter: "tt-aspect", maxImages: 16, aspects: [...aspects, "4:5", "5:4", "21:9"], preset: "2K", detail: "标准版 · 2K · 高质量" },
  { id: "tt-image-2.5-token", label: "TT Image 2.5 官转", adapter: "tt-aspect", keyEnv: "XYLP_IMAGE_TT25_KEY", channel: "DE-image-pro", successRate: 95.5, speedSeconds: 32.5, priceHint: "输入 4.8024 / 输出 28.773 算力每百万 token", maxImages: 16, aspects: [...aspects, "4:5", "5:4", "21:9"], preset: "2K", detail: "官转按 token；用参考图锁定商品细节，按实际 token 结算" },
  { id: "gt-image-2.5-sunburst", label: "GT Image 2.5 Sunb 高端版", adapter: "xhai", maxImages: 16, aspects: [...aspects, "4:5", "5:4", "21:9"], preset: "2K", detail: "2K · 高质量 · 最多 16 张参考图" },
  { id: "gt-image-2.5-flare", label: "GT Image 2.5 Flare 快速版", adapter: "xhai", maxImages: 17, aspects: [...aspects, "4:5", "5:4", "21:9"], preset: "2K", detail: "2K · 高质量 · 最多 17 张参考图" },
];

export function imageModel(route = {}) {
  const model = IMAGE_MODELS.find(m => m.id === (route.model || "tt-image-2.5-token"));
  if (!model) throw Object.assign(new Error("所选关键帧图像模型不可用，请重新选择"), { statusCode: 400 });
  return model;
}

export function keyframeImageRoute(config, selection) {
  const legacyDefault = !config.videoSecrets?.XYLP_IMAGE_TT25_KEY && config.videoSecrets?.VIDEO_RELAY_API_KEY ? "tt-image-2" : "tt-image-2.5-token";
  const model = imageModel({ model: selection?.modelId || config.keyframeImageModel || legacyDefault });
  if (model.adapter === "xhai") {
    const url = new URL(config.xhaiBaseUrl || "https://xhai.token6688.com");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["/", "/v1", "/v1/"].includes(url.pathname)) throw new Error("星火 AIGC 接口须为无凭据的 HTTPS 地址");
    return { id: "keyframe-image", label: "星火 AIGC 图片", protocol: "xhai-image", baseUrl: url.origin, keyEnv: "XHAI_API_KEY", model: model.id, preset: model.preset };
  }
  const url = new URL(config.keyframeImageBaseUrl || config.videoRelayBaseUrl || "https://api.lk888.ai");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("关键帧服务必须使用不含凭据的 HTTPS 地址");
  const keyEnv = model.keyEnv || config.keyframeImageKeyEnv || "VIDEO_RELAY_API_KEY";
  if (!/^[A-Z][A-Z0-9_]*$/.test(keyEnv)) throw new Error("关键帧密钥变量名不正确");
  return { id: "keyframe-image", label: "关键帧图片服务", protocol: "media", baseUrl: url.href.replace(/\/+$/, ""), keyEnv, model: model.id, preset: model.preset };
}

export function assertImageSelection(user, route) {
  if (route?.protocol === "xhai-image" && user?.role !== "super_admin") fail("星火 AIGC 图片模型仅限超级管理员使用", 403);
}

export function assertImageAccess(data, userId, route) {
  if (!data.platform) return;
  const user = data.platform.users.find(item => item.id === userId && !item.disabled);
  if (!user) fail("账号已停用，不能提交新请求", 403);
  assertImageSelection(user, route);
}

export function imageCatalog(config, role) {
  const route = keyframeImageRoute(config);
  const models = IMAGE_MODELS.filter(model => ["tt-image-2.5-token", "banana-pro"].includes(model.id) || (model.adapter === "xhai" && (role === undefined || role === "super_admin")))
    .map(({ adapter, keyEnv, channel, successRate, speedSeconds, priceHint, ...model }) => ({ ...model, ...(role === "super_admin" ? { channel, successRate, speedSeconds, priceHint } : {}), configured: Boolean(videoKey(config, keyframeImageRoute(config, { modelId: model.id }))), priceKey: `keyframe/${model.id}/${model.preset}` }));
  const defaultModelId = models.some(model => model.id === route.model) ? route.model : models[0].id;
  return { defaultModelId, configured: models.some(model => model.configured), models };
}

export function validateImageReferences(route, project, aspectRatio) {
  const model = imageModel(route);
  const people = project.assets.modelImages.length, products = project.assets.productImages.length;
  const count = people + products + (project.sceneMode === "custom" ? project.assets.sceneImages.length : 0);
  if (!people || !products || count > model.maxImages) throw new Error(`${model.label} 需要人物和商品原图，合计 2～${model.maxImages} 张；请精简素材或改选图像模型，也可上传已制作的关键帧`);
  if (people > (model.maxModelImages || Infinity) || products > (model.maxProductImages || Infinity)) throw new Error(`${model.label} 最多使用 ${model.maxModelImages} 张人物图和 ${model.maxProductImages} 张商品图，请精简素材或切换模型`);
  if (!model.aspects.includes(aspectRatio)) throw new Error(`${model.label} 不支持 ${aspectRatio} 关键帧比例，请切换图像模型或上传对应比例的首帧`);
}

export function keyframeImageBody(route, { prompt, images, aspectRatio }) {
  const model = imageModel(route);
  if (images.length < 2 || images.length > model.maxImages) throw new Error(`关键帧自动生图需要 2～${model.maxImages} 张人物、商品与场景参考图；请调整素材或上传已制作的关键帧`);
  if (!model.aspects.includes(aspectRatio)) throw new Error("关键帧画幅不受当前图片服务支持");
  if (model.adapter === "xhai") return { model_id: model.id, modality: "image", params: { prompt, images, mode: "multi-reference", count: 1, aspect_ratio: aspectRatio, resolution: "2K", quality: "high", background: "opaque", output_format: "png" } };
  if (model.adapter === "banana") return { model: model.id, prompt, params: { images, n: 1, aspectRatio, imageSize: "2K", ...(model.id === "banana-2" ? { thinkingLevel: "minimal", web_search: false } : {}) } };
  if (model.adapter === "tt-aspect") return { model: model.id, prompt, params: { images, aspect_ratio: aspectRatio, resolution: "2K", version: "flare", quality: "high", background: "opaque" } };
  const size = { "1:1": "1024x1024", "9:16": "1088x1920", "16:9": "1920x1088", "2:3": "1024x1536", "3:2": "1536x1024", "3:4": "960x1280", "4:3": "1280x960" }[aspectRatio];
  if (!size) throw new Error("关键帧画幅不受当前图片服务支持");
  return { model: route.model, prompt, params: { images, n: 1, quality: "high", size } };
}

export async function dryRunKeyframe(config, route, body) {
  if (route.protocol !== "xhai-image") return;
  const result = await xhaiJson(route.baseUrl, videoKey(config, route), "/api/v1/model-runtime/dry-run", body);
  const changed = result.param_adjustments?.find(item => ["nearest_supported", "nearest_vendor_supported", "unrecognized", "auto_as_unspecified"].includes(item.reason));
  if (changed) throw new Error(`星火 AIGC 无法按所选图片参数生成：${changed.param} 将改为 ${changed.applied}`);
  return result;
}

export async function submitKeyframe(config, route, body) {
  if (route.protocol === "xhai-image") {
    const key = videoKey(config, route);
    if (!key) throw new Error("星火 AIGC 尚未配置 XHAI_API_KEY");
    const images = await uploadXhaiImages(route.baseUrl, key, body.params.images);
    const result = await xhaiJson(route.baseUrl, key, "/api/v1/model-runtime/invoke", { ...body, params: { ...body.params, images } });
    if (!result.task_id) throw new Error("星火 AIGC 图片提交未返回任务编号，请核对原请求");
    return String(result.task_id);
  }
  const result = await mediaCall(config, route, "/v1/media/generate", body);
  if (result.task_id === undefined || result.task_id === null || !String(result.task_id)) throw new Error("关键帧提交未返回任务编号，请核对中转站记录");
  return String(result.task_id);
}

export async function pollKeyframe(config, route, id) {
  if (route.protocol === "xhai-image") {
    const result = await xhaiJson(route.baseUrl, videoKey(config, route), `/v1/tasks/${encodeURIComponent(id)}`);
    if (result.is_final === false || ["pending", "processing", "needs_review"].includes(result.status)) return { pending: true };
    if (result.status === "failed") throw Object.assign(new Error(`星火 AIGC 图片生成失败：${result.error || "请核对原任务"}`), { terminal: true });
    if (result.status !== "completed" || typeof result.output_url !== "string" || !result.output_url.startsWith("https://")) throw new Error("星火 AIGC 图片任务已结束但未返回 HTTPS 图片地址，请核对原任务");
    return { url: result.output_url, cost: result.actual_cost_micro_usd === undefined ? undefined : { actual_cost_micro_usd: result.actual_cost_micro_usd } };
  }
  const result = await mediaCall(config, route, `/v1/media/status?task_id=${encodeURIComponent(id)}`);
  if (result.is_final === false && ["pending", "running"].includes(result.state)) return { pending: true };
  if (result.is_final === true && result.state === "failed") throw Object.assign(new Error("本次关键帧生成失败，未自动重做；可手动再次生成"), { terminal: true });
  const url = typeof result.result_url === "string" ? result.result_url : Array.isArray(result.result_url) && result.result_url.length === 1 ? result.result_url[0] : null;
  if (result.is_final !== true || result.state !== "success" || typeof url !== "string") throw new Error("关键帧生成未成功返回单张图片，未自动重提；请核对原任务");
  return { url, cost: result.cost };
}

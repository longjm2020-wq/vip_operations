import { createHash } from "node:crypto";
import sharp from "sharp";
import { modelFetch, modelReceipt } from "./ai-accounting.mjs";
import { jobRequestSignal } from "./job-request.mjs";
import { referenceDownloadUrl } from "./media-references.mjs";

export const BAILIAN_VIDEO_MODEL = "MiniMax/MiniMax-H3";
export function bailianVideoBaseUrl(workspaceId) {
  if (!workspaceId) return "https://unconfigured.invalid/api/v1";
  if (!/^ws-[a-z0-9]{8,64}$/.test(workspaceId)) throw new Error("百炼北京业务空间 ID 无效");
  return `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1`;
}
export function bailianVideoProvider(config) {
  const MB = 1024 * 1024;
  return { id: "bailian", label: "阿里云百炼 · 北京", protocol: "bailian", baseUrl: bailianVideoBaseUrl(config.bailianWorkspaceId), keyEnv: "BAILIAN_VIDEO_API_KEY", models: [{
    id: "minimax-h3", label: BAILIAN_VIDEO_MODEL, model: BAILIAN_VIDEO_MODEL,
    durations: Array.from({ length: 12 }, (_, i) => i + 4), maxImages: 9,
    minImageSide: 256, resolutions: ["768P", "2K"], aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], maxPromptChars: 7000,
    note: "多模态参考生视频；最多 9 张图片、3 段视频及 3 段音频，视频和音频分别合计不超过 15 秒。",
    mediaReferences: {
      video: { field: "feature", maxFiles: 3, extensions: ["mp4", "mov"], maxBytes: 50 * MB, minSeconds: 2, maxSeconds: 15, maxTotalSeconds: 15, minFps: 23.976, maxFps: 60, minAspect: .4, maxAspect: 2.5, minSide: 256, maxSide: 5760, priceMultiplier: 1 },
      audio: { field: "driving_audio", maxFiles: 3, extensions: ["mp3", "wav"], maxBytes: 15 * MB, minSeconds: 2, maxSeconds: 15, maxTotalSeconds: 15, priceMultiplier: 0 },
    },
  }] };
}
function publicUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error("百炼参考素材需要可访问的 HTTPS 链接"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("百炼参考素材需要可访问的 HTTPS 链接");
  return url.href;
}
export function bailianVideoBody(route, input) {
  const media = [
    ...(input.referenceImages || []).map(url => ({ type: "image_url", url: publicUrl(url) })),
    ...(input.referenceVideos || []).map(url => ({ type: "feature", url: publicUrl(url) })),
    ...(input.referenceAudios || []).map(url => ({ type: "driving_audio", url: publicUrl(url) })),
  ];
  return { model: BAILIAN_VIDEO_MODEL, input: { prompt: input.prompt, ...(media.length ? { media } : {}) }, parameters: { resolution: route.resolution, duration: input.duration, ratio: input.aspectRatio, watermark: true } };
}
export async function bailianVideoCall(config, route, taskId, body) {
  const key = config.videoSecrets?.BAILIAN_VIDEO_API_KEY;
  if (!key || route.baseUrl.includes("unconfigured.invalid")) throw new Error("请先配置百炼北京业务空间和视频 API Key");
  if (!/^https:\/\/ws-[a-z0-9]{8,64}\.cn-beijing\.maas\.aliyuncs\.com\/api\/v1$/.test(route.baseUrl)) throw new Error("百炼视频服务地址无效");
  const url = taskId ? `${route.baseUrl}/tasks/${encodeURIComponent(taskId)}` : `${route.baseUrl}/services/aigc/video-generation/video-synthesis`;
  const response = await (body ? (url, init) => modelFetch(config, "aigc_video", url, init) : fetch)(url, {
    method: body ? "POST" : "GET", redirect: "error", signal: jobRequestSignal(body ? 120000 : 60000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(body ? { "X-DashScope-Async": "enable" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw Object.assign(new Error(`百炼 H3 HTTP ${response.status}；请检查模型开通、密钥权限及余额`), { notSubmitted: [400,401,402,403,404,413,422,429].includes(response.status) });
  const result = await response.json();
  if (result.code) throw Object.assign(new Error(`百炼 H3 返回业务错误 ${String(result.code).replace(/[^a-zA-Z0-9_.-]/g, "").slice(0,100)}`), { notSubmitted: !result.output?.task_id });
  return result;
}
export async function submitBailianVideo(config, route, input) {
  const result = await bailianVideoCall(config, route, undefined, bailianVideoBody(route, input));
  const id = result.output?.task_id;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error("百炼未返回有效任务编号，提交结果待核对，请勿重复生成");
  return id;
}
export async function pollBailianVideo(config, route, id) {
  const result = await bailianVideoCall(config, route, id);
  if (result.output?.task_id !== id) throw new Error("百炼任务回执编号不匹配，保留原请求等待核实");
  const state = result.output?.task_status;
  if (["PENDING", "RUNNING"].includes(state)) return { pending: true, state: state.toLowerCase() };
  if (["SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"].includes(state)) await modelReceipt(config, "aigc_video", route.baseUrl, route.model.model, result);
  if (state === "SUCCEEDED") return { pending: false, state: "success", url: publicUrl(result.output.video_url) };
  const errorCode = typeof result.output?.code === "string" ? result.output.code.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 100) : undefined;
  // Provider prose may echo user prompts or URLs. Expose a classified hint, not raw errors.
  const providerMessage = String(result.output?.message || result.message || "").slice(0, 1000);
  const detail = `${errorCode || ""} ${providerMessage}`;
  let errorHint = "请在百炼核对该任务；未自动重新生成";
  if (/FreeTierOnly|free.?tier|free.?quota/i.test(detail)) errorHint = "免费额度用完即停限制了该模型，请核对该型号的费用保护设置";
  else if (/Arrear|Overdue|Balance|Insufficient|payment/i.test(detail)) errorHint = "账户余额或计费状态不满足要求";
  else if (/AccessDenied|Unauthorized|permission|authorize/i.test(detail)) errorHint = "请核对该型号的业务空间与 API Key 权限";
  else if (/DataInspection|content.?filter|safety/i.test(detail)) errorHint = "输入或输出未通过供应商内容检查";
  else if (/InvalidParameter|parameter|not.supported/i.test(detail)) {
    const fields = ["duration", "resolution", "ratio", "media", "model", "prompt", "image", "audio", "video"].filter(field => new RegExp(`\\b${field}\\b`, "i").test(detail));
    errorHint = "供应商拒绝请求参数" + (fields.length ? `（${fields.join(" / ")}）` : "");
  } else if (/InternalError|ServiceUnavailable|Capacity|timeout/i.test(detail)) errorHint = "供应商服务暂时失败，请核对任务记录后再试";
  // Only the administrator's fixed synthetic connection test can show bounded
  // parameter detail. Customer generation errors retain the classified hint.
  const errorDiagnostic = config.bailianTestDiagnostics ? providerMessage
    .replaceAll(config.videoSecrets?.BAILIAN_VIDEO_API_KEY || "__absent_key__", "[密钥已隐藏]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[链接已隐藏]")
    .replace(/sk-[a-z0-9._-]+/gi, "[密钥已隐藏]")
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]").slice(0, 240) : undefined;
  return { pending: false, state: { FAILED: "failed", CANCELED: "cancelled", UNKNOWN: "expired" }[state] || "unknown", errorCode, errorHint, ...(errorDiagnostic ? { errorDiagnostic } : {}) };
}

// Private JPEG derivatives get a job-bound, expiring download URL. Neither API
// keys nor unprotected customer images are sent through a third-party upload API.
export async function prepareBailianImages(store, config, job, unitId, references) {
  const fingerprint = createHash("sha256").update(references.join("\n")).digest("hex");
  const cached = job.payload?.bailianReferenceImages?.[unitId];
  let assets = cached?.fingerprint === fingerprint ? cached.assets : undefined;
  if (assets && !(await Promise.all(assets.map(asset => store.openAsset(asset.path)))).every(Boolean)) assets = undefined;
  if (!assets) {
    assets = [];
    for (const [index, uri] of references.entries()) {
      if (!/^data:image\/(?:jpeg|png|webp);base64,/.test(uri)) throw new Error("百炼参考图片格式无效");
      const buffer = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
      const info = await sharp(buffer).metadata();
      const ratio = info.width / info.height;
      if (!info.width || !info.height || Math.min(info.width, info.height) < 256 || Math.max(info.width, info.height) > 5760 || ratio < .4 || ratio > 2.5 || buffer.length > 30 * 1024 * 1024) throw new Error("百炼参考图须为 256～5760 像素、宽高比 0.4～2.5，单张不超过 30MB");
      const asset = await store.putAsset({ buffer, name: `h3-reference-${unitId}-${index + 1}.${info.format === "jpeg" ? "jpg" : info.format}`, kind: "referenceImage", mime: `image/${info.format}`, projectId: job.projectId, ownerId: job.ownerId, source: "bailian-video-reference" });
      assets.push(asset);
    }
    await store.mutate(data => {
      const current = data.jobs[job.id];
      if (current?.status !== "running") throw new Error("视频任务已停止，未提交");
      current.payload.bailianReferenceImages = { ...current.payload.bailianReferenceImages, [unitId]: { fingerprint, assets } };
    });
  }
  return { assets, fingerprint, urls: assets.map(asset => referenceDownloadUrl(config, asset.path, job.id)) };
}

import { randomUUID } from "node:crypto";
import { mediaCall, pollVideo, videoKey } from "./video-providers.mjs";

const route = baseUrl => ({ id: "xylp-enhance", label: "玄宇令牌视频超分", protocol: "media", baseUrl: (baseUrl || "https://api.lk888.ai").replace(/\/+$/, ""), keyEnv: "XYLP_VIDEO_ENHANCE_KEY", model: { id: "video-enhance", model: "video-enhance", label: "视频超分" } });
const choices = { resolution: ["720p", "1080p", "2k", "4k", "8k"], fps: ["keep", "60", "120"], toolVersion: ["standard", "professional"], scene: ["aigc", "short_series", "ugc", "old_film"], style: ["natural", "hd"] };
const rates = { "720p": .0286, "1080p": .0572, "2k": .1144, "4k": .2288, "8k": .9152 };

export { route as enhancementRoute, inputBody as enhancementBody };

export function enhancementCatalog(config) {
  return { configured: Boolean(videoKey(config, route(config.videoRelayBaseUrl))), channel: "XH", successRate: 100, speedSeconds: 141, rates, checkedAt: "2026-09-27", source: "https://xylp.ai/api/pricing?model=196", guide: "输入现有视频的 HTTPS 地址；标准版、原帧率、自然风格先试 1080p。价格按源视频实际秒数 × 清晰度 × 帧率 × 版本结算。", choices };
}

function inputBody(input) {
  const url = new URL(String(input?.videoUrl || ""));
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname.includes(".")) throw new Error("源视频须为无凭据的公网 HTTPS 地址");
  const selected = { resolution: input?.resolution || "1080p", fps: input?.fps || "keep", toolVersion: input?.toolVersion || "standard", scene: input?.scene || "aigc", style: input?.style || "natural" };
  for (const [field, values] of Object.entries(choices)) if (!values.includes(selected[field])) throw new Error(`视频超分 ${field} 参数无效`);
  return { model: "video-enhance", params: { video_url: url.href, resolution: selected.resolution, fps: selected.fps, tool_version: selected.toolVersion, scene: selected.scene, enhance_style: selected.style } };
}

export async function createEnhancement(store, config, user, input) {
  const selectedRoute = route(config.videoRelayBaseUrl);
  if (!videoKey(config, selectedRoute)) throw new Error("视频超分 XH 指定渠道密钥尚未配置");
  const body = inputBody(input);
  const record = { id: randomUUID(), ownerId: user.id, at: new Date().toISOString(), state: "inflight", params: body.params };
  await store.mutate(data => { data.videoEnhancements ||= {}; data.videoEnhancements[record.id] = record; });
  try {
    const result = await mediaCall(config, selectedRoute, "/v1/media/generate", body);
    if (result.task_id === undefined || result.task_id === null || !String(result.task_id)) throw new Error("视频超分未返回任务编号，需在玄宇站核对原请求");
    await store.mutate(data => { data.videoEnhancements[record.id].taskId = String(result.task_id); data.videoEnhancements[record.id].state = "submitted"; });
  } catch (error) {
    await store.mutate(data => { data.videoEnhancements[record.id].state = "uncertain"; data.videoEnhancements[record.id].error = error.message; });
  }
  return store.data.videoEnhancements[record.id];
}

export async function refreshEnhancement(store, config, id, userId) {
  const record = store.data.videoEnhancements?.[id];
  if (!record || record.ownerId !== userId) throw Object.assign(new Error("视频超分任务不存在"), { statusCode: 404 });
  if (!record.taskId || ["completed", "failed"].includes(record.state)) return record;
  try {
    const result = await pollVideo(config, route(config.videoRelayBaseUrl), record.taskId);
    await store.mutate(data => { const saved = data.videoEnhancements[id]; saved.state = result.pending ? "submitted" : "completed"; if (result.url) saved.outputUrl = result.url; if (result.cost) saved.cost = result.cost; });
  } catch (error) {
    await store.mutate(data => { data.videoEnhancements[id].error = error.message; if (error.terminal) data.videoEnhancements[id].state = "failed"; });
  }
  return store.data.videoEnhancements[id];
}

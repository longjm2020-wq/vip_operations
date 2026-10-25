import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import ffmpeg from "ffmpeg-static";

const run = promisify(execFile);
const MB = 1024 * 1024;
// Verified against xylp.ai/apidoc on 2026-09-28. SD duration/size caps below
// are workspace upload limits; H3 has the stricter documented 15-second cap.
export function omniReferences(id) {
  if (!["h3-omni", "sd20-omni", "sd25-omni"].includes(id)) return undefined;
  const h3 = id === "h3-omni", count = id === "sd25-omni" ? 10 : 3;
  return {
    video: { field: "video_url", maxFiles: count, extensions: ["mp4", "mov"], maxBytes: 50 * MB, minSeconds: h3 ? 2 : 1, maxSeconds: h3 ? 15 : 30, maxTotalSeconds: h3 ? 15 : 120, minFps: h3 ? 23.976 : 23.8, maxFps: 60, ...(h3 ? {} : { minAspect: .4, maxAspect: 2.5 }), priceMultiplier: h3 ? 1 : .5 },
    audio: { field: "audio_url", maxFiles: count, extensions: ["mp3", "wav"], maxBytes: 15 * MB, minSeconds: h3 ? 2 : 1, maxSeconds: h3 ? 15 : 30, maxTotalSeconds: h3 ? 15 : 120, priceMultiplier: 0 },
  };
}

export async function probeReference(filePath, kind, name) {
  const video = kind === "referenceVideo";
  const extension = path.extname(name).slice(1).toLowerCase();
  if (!(video ? ["mp4", "mov"] : ["mp3", "wav"]).includes(extension)) throw new Error(video ? "生成参考视频仅支持 MP4 / MOV" : "生成参考音频仅支持 MP3 / WAV");
  // Decode a sample as well as probing: a renamed image/text is not a video.
  const { stderr } = await run(ffmpeg, ["-hide_banner", "-nostdin", "-protocol_whitelist", "file,pipe", "-threads", "1", "-i", filePath, "-map", video ? "0:v:0" : "0:a:0", "-t", "0.02", "-threads", "1", "-f", "null", "-"], { timeout: 20000, windowsHide: true, maxBuffer: 256 * 1024 }).catch(() => { throw new Error("无法读取参考素材，请上传可正常播放的短视频或音频"); });
  const duration = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const stream = stderr.split(/\r?\n/).find(line => /Stream.*Video:/.test(line)) || "";
  const dimensions = stream.match(/\b(\d{2,5})x(\d{2,5})\b/);
  const fps = stream.match(/([\d.]+) fps/);
  const durationSeconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : NaN;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || (video && (!dimensions || !fps))) throw new Error("参考素材缺少有效时长、尺寸或帧率");
  return { durationSeconds, ...(video ? { width: Number(dimensions[1]), height: Number(dimensions[2]), fps: Number(fps[1]), hasAudio: /Stream.*Audio:/.test(stderr) } : {}), mime: video ? extension === "mov" ? "video/quicktime" : "video/mp4" : extension === "wav" ? "audio/wav" : "audio/mpeg" };
}

export function validateReferenceFiles(model, type, files) {
  const label = type === "video" ? "视频" : "音频", capability = model.mediaReferences?.[type];
  if (!Array.isArray(files)) throw new Error(`参考${label}列表无效`);
  if (!files.length) return;
  if (!capability) throw new Error(`当前模型不支持${label}参考，请移除素材或切换模型`);
  if (files.length > capability.maxFiles) throw new Error(`参考${label}最多 ${capability.maxFiles} 个`);
  let seconds = 0;
  for (const file of files) {
    const info = file.mediaInfo;
    if (!capability.extensions.includes(path.extname(file.name).slice(1).toLowerCase()) || !(file.size > 0) || file.size > capability.maxBytes) throw new Error(`参考${label}格式或大小超限（单个最多 ${capability.maxBytes / MB}MB）`);
    if (!info || !Number.isFinite(info.durationSeconds) || info.durationSeconds < capability.minSeconds || info.durationSeconds > capability.maxSeconds) throw new Error(`参考${label}单段须为 ${capability.minSeconds}～${capability.maxSeconds} 秒`);
    if (type === "video") {
      const aspect = info.width / info.height;
      if (!Number.isFinite(info.fps) || info.fps < capability.minFps - .001 || info.fps > capability.maxFps || !Number.isFinite(aspect) || aspect <= 0 || (capability.minAspect && (aspect < capability.minAspect || aspect > capability.maxAspect))) throw new Error(`参考视频帧率或宽高比不受当前模型支持`);
    }
    seconds += info.durationSeconds;
  }
  if (seconds > capability.maxTotalSeconds + .001) throw new Error(`参考${label}总时长不能超过 ${capability.maxTotalSeconds} 秒`);
}

// Resolve metadata from private storage, never trust client-provided durations
// for wallet pricing, or accept another user's/project's asset IDs.
export function projectMediaReferences(store, project, route) {
  const result = {};
  for (const [type, key, kind] of [["video", "referenceVideos", "referenceVideo"], ["audio", "referenceAudios", "referenceAudio"]]) {
    const values = project.assets?.[key] || [];
    if (!Array.isArray(values) || values.length > 10) throw new Error("生成参考素材列表无效");
    result[type] = values.map(file => {
      const meta = store.getAssetMetadata(file?.path);
      if (!meta || meta.kind !== kind || meta.projectId !== project.id || meta.ownerId !== project.ownerId || meta.source !== "upload") throw new Error("生成参考素材不存在或不属于当前项目");
      if (meta.mediaInfo?.referenceType === "depth" && meta.mediaInfo.sourceAssetId !== project.assets?.video?.path) throw new Error("深度参考对应的原片已变化，请移除旧深度参考后重新转换");
      return { ...meta, path: meta.id };
    });
    validateReferenceFiles(route.model, type, result[type]);
  }
  if (result.video.some(f => f.mediaInfo?.referenceType === "depth") && result.video.length !== 1) throw new Error("原片深度参考不能与其他视频混用，请只保留深度结果或自定义视频");
  return { ...result, referenceVideoSeconds: result.video.reduce((sum, f) => sum + f.mediaInfo.durationSeconds, 0), referenceAudioCount: result.audio.length };
}

export function mediaReferenceInstructions(project) {
  const videos = project.assets?.referenceVideos?.length || 0, audios = project.assets?.referenceAudios?.length || 0;
  if (!videos && !audios) return "";
  const depth = project.assets?.referenceVideos?.some(f => f.mediaInfo?.referenceType === "depth");
  return `\n生成参考素材：${videos} 个视频、${audios} 段音频，按上传顺序编号。视频仅参考动作、运镜与节奏；不得复制其人脸、服装或饰品，人物和商品仍只以对应原图为真值。${depth ? "视频为相对深度图，仅用于几何、运动与镜头节奏，禁止把灰度、轮廓或缺失纹理当作商品外观；颜色、面料、纹样与部件位置必须严格来自商品原图。" : ""}音频用于声音与节奏参考；具体用法服从用户备注，不能改变商品设计。`;
}

function signature(secret, assetId, jobId, expires) {
  return createHmac("sha256", secret).update(`media-reference/v1\n${assetId}\n${jobId}\n${expires}`).digest("hex");
}

export function referenceDownloadUrl(config, assetId, jobId, now = Date.now()) {
  const base = new URL(config.publicBaseUrl || "https://unconfigured.invalid");
  if (!config.publicBaseUrl || base.protocol !== "https:" || base.username || base.password || !config.sessionSecret) throw new Error("请配置 XUTI_PUBLIC_BASE_URL 为网站 HTTPS 地址后使用视频、音频参考");
  const expires = String(Math.floor(now / 1000) + 24 * 3600);
  const url = new URL(`/api/v1/aigc/generation-reference/${encodeURIComponent(assetId)}`, base);
  url.search = new URLSearchParams({ job: jobId, expires, signature: signature(config.sessionSecret, assetId, jobId, expires) }).toString();
  return url.href;
}

export function referenceDownloadOwner(store, config, assetId, params, now = Date.now()) {
  const jobId = params.get("job"), expires = params.get("expires"), sig = params.get("signature") || "";
  if (!config.sessionSecret || !/^\d+$/.test(expires || "") || Number(expires) <= Math.floor(now / 1000) || !/^[a-f0-9]{64}$/.test(sig)) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(signature(config.sessionSecret, assetId, jobId, expires)))) return null;
  const job = store.getJob(jobId), asset = store.getAssetMetadata(assetId);
  if (!job || !["running", "queued", "paused"].includes(job.status) || !asset || asset.projectId !== job.projectId || asset.ownerId !== job.ownerId || !["referenceVideo", "referenceAudio"].includes(asset.kind) || asset.source !== "upload") return null;
  const inputs = job.payload?.artifacts?.referenceSnapshot?.assets || job.payload?.inputProject?.assets;
  if (![...(inputs?.referenceVideos || []), ...(inputs?.referenceAudios || [])].some(f => f.path === assetId)) return null;
  return asset.ownerId;
}

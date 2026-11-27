import { createHash, createHmac, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { fail } from "./access.mjs";
import { modelFetch, modelReceipt } from "./ai-accounting.mjs";
import { validateDigitalMedia } from "./digital-human-media.mjs";
import { referenceDownloadUrl } from "./media-references.mjs";
import { limitedBytes, remoteId } from "./opentalking.mjs";

export const FAL_LIP_SYNC_MODEL = "minimax/h3-max/lip-sync/image-to-video";
const queue = "https://queue.fal.run";
const inferenceUrl = `${queue}/${FAL_LIP_SYNC_MODEL}`;
const feature = "aigc_lip_sync";
const mb = 1024 * 1024;
const limits = { minSeconds: 5, maxSeconds: 15, maxImageBytes: 20 * mb, maxAudioBytes: 10 * mb, resolution: "768P", priceUsdPerSecond: 0.08 };
export const FAL_LIP_SYNC_UPLOAD_BYTES = limits.maxImageBytes + limits.maxAudioBytes + 64 * 1024;
const sourceLifetime = 30 * 60;
const unresolved = new Set(["queued", "submitting", "generating", "saving", "uncertain"]);
const audioTypes = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg" };
const now = () => new Date().toISOString();

function connectionFingerprint(config) {
  if (!config.falLipSyncApiKey || !config.sessionSecret) return undefined;
  return createHmac("sha256", config.sessionSecret).update(config.falLipSyncApiKey).digest("hex");
}

export function falLipSyncConfigured(config) {
  if (!connectionFingerprint(config)) return false;
  try { return Boolean(referenceDownloadUrl(config, "connection-check", "connection-check")); }
  catch { return false; }
}

export function falLipSyncVerifiedAt(config, store) {
  const verification = store?.data.digitalHuman?.lipSyncVerification;
  return falLipSyncConfigured(config) && verification?.connection === connectionFingerprint(config) ? verification.at : undefined;
}

function view(op) {
  return { id: op.id, status: op.status, duration: op.duration ?? op.inputDuration, output: op.output, message: op.message, createdAt: op.createdAt, updatedAt: op.updatedAt };
}

function inputFile(file, max, label) {
  if (!file || typeof file.arrayBuffer !== "function" || !file.size) fail(`请选择${label}`);
  if (file.size > max) fail(`${label}最大 ${max / mb}MB`, 413);
}

async function portrait(buffer) {
  let normalized;
  try {
    const image = sharp(buffer, { limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format) || (metadata.pages ?? 1) > 1) fail("请上传一张 JPG、PNG 或 WebP 照片");
    normalized = await image.rotate().resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 88 }).toBuffer({ resolveWithObject: true });
  } catch { fail("无法读取照片，请使用一张有效的 JPG、PNG 或 WebP"); }
  const { width, height } = normalized.info;
  if (width / height < 0.4 || width / height > 2.5) fail("照片宽高比须为 0.4～2.5");
  return normalized.data;
}

function requestUrl(id) { return `${queue}/minimax/h3-max/requests/${remoteId(id)}`; }

function downloadUrl(value) {
  const url = new URL(value);
  if (url.origin !== "https://v3b.fal.media" || url.username || url.password || url.search || url.hash || !url.pathname.startsWith("/files/")) throw new Error("口播供应商返回了不支持的文件地址");
  return url.href;
}

async function falJson(config, url, { body, submit = false } = {}) {
  const headers = { Authorization: `Key ${config.falLipSyncApiKey}` };
  if (body) headers["Content-Type"] = "application/json";
  if (submit) Object.assign(headers, {
    "X-Fal-No-Retry": "1",
    "X-App-Fal-Disable-Fallback": "true",
    "X-Fal-Request-Start-Timeout": "900",
    "X-Fal-Store-IO": "0",
    "X-Fal-Object-Lifecycle-Preference": JSON.stringify({ expiration_duration_seconds: 3600, initial_acl: { default: "forbid", rules: [] } }),
  });
  const options = { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000), redirect: "error" };
  const response = await (submit ? modelFetch(config, feature, url, options) : fetch(url, options));
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(`fal 返回 HTTP ${response.status}`), { upstreamStatus: response.status, rejected: submit && [400, 401, 402, 403, 404, 413, 415, 422, 429].includes(response.status) });
  }
  return JSON.parse((await limitedBytes(response, 128 * 1024)).toString("utf8"));
}

async function downloadVideo(config, url) {
  const verifiedUrl = downloadUrl(url);
  const { token } = await falJson(config, "https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3", { body: { expiration_seconds: 600 } });
  if (typeof token !== "string" || !token || token.length > 8000) throw new Error("无法认证口播生成文件");
  const response = await fetch(verifiedUrl, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(45_000) });
  if (!response.ok || !/^video\/mp4(?:;|$)/i.test(response.headers.get("content-type") || "")) {
    await response.body?.cancel();
    throw new Error("无法读取口播视频");
  }
  return limitedBytes(response, Math.min(config.maxDownloadedVideoBytes ?? 20 * mb, 28 * mb));
}

export class FalLipSyncService {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.uploading = new Set();
    this.busy = false;
  }

  get operations() { return this.store.data.digitalHuman.operations; }

  catalog(user) {
    const jobs = Object.values(this.operations).filter(op => op.type === "lip-sync" && op.ownerId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { ...limits, configured: falLipSyncConfigured(this.config), verifiedAt: falLipSyncVerifiedAt(this.config, this.store), jobs: jobs.slice(0, 30).map(view) };
  }

  userActive(userId) {
    return !this.store.data.platform || this.store.data.platform.users.some(user => user.id === userId && !user.disabled);
  }

  async create(user, input) {
    if (!this.userActive(user.id)) fail("账号已停用", 403);
    if (this.uploading.has(user.id) || this.uploading.size >= 3) fail("正在检查口播素材，请稍后再提交", 429);
    this.uploading.add(user.id);
    const staged = [];
    try {
      const { requestId, authorized, image: photoFile, audio: audioFile } = await input();
      if (authorized !== "true") fail("请确认已取得肖像与录音使用授权，并同意提交给 fal 生成");
      if (typeof requestId !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(requestId)) fail("缺少有效请求编号");
      inputFile(photoFile, limits.maxImageBytes, "照片");
      inputFile(audioFile, limits.maxAudioBytes, "录音");
      const extension = path.extname(audioFile.name).slice(1).toLowerCase();
      const audioMime = Object.hasOwn(audioTypes, extension) && audioTypes[extension];
      if (!audioMime) fail("请上传 MP3、WAV、M4A 或 OGG 音频");
      const [photo, audio] = await Promise.all([photoFile.arrayBuffer(), audioFile.arrayBuffer()]);
      const digest = createHash("sha256").update(createHash("sha256").update(Buffer.from(photo)).digest()).update(extension).update(Buffer.from(audio)).digest("hex");
      const history = Object.values(this.operations).filter(op => op.type === "lip-sync" && op.ownerId === user.id);
      const previous = history.find(op => op.requestId === requestId);
      if (previous) {
        if (previous.digest !== digest) fail("此请求编号已用于其他素材", 409);
        return view(previous);
      }
      if (!falLipSyncConfigured(this.config)) fail("原声口播尚未配置，请联系站长", 409);
      if (history.some(op => unresolved.has(op.status))) fail("请先完成或核实当前原声口播任务", 409);
      const image = await portrait(Buffer.from(photo));
      const inputDuration = await validateDigitalMedia(new File([audio], `录音.${extension}`, { type: audioMime }), "audio", limits.maxSeconds);
      if (inputDuration < limits.minSeconds || inputDuration > limits.maxSeconds) fail(`录音时长须为 ${limits.minSeconds}～${limits.maxSeconds} 秒`);
      const op = { id: randomUUID(), ownerId: user.id, type: "lip-sync", requestId, digest, inputDuration, status: "queued", message: "等待生成", connection: connectionFingerprint(this.config), createdAt: now(), updatedAt: now() };
      const common = { ownerId: user.id, projectId: op.id, source: "fal-lip-sync-input" };
      const photoAsset = await this.store.putAsset({ ...common, buffer: image, name: "口播照片.jpg", kind: "lip-sync-image", mime: "image/jpeg" });
      staged.push(photoAsset.path);
      const audioAsset = await this.store.putAsset({ ...common, buffer: Buffer.from(audio), name: `口播原声.${extension}`, kind: "lip-sync-audio", mime: audioMime });
      staged.push(audioAsset.path);
      Object.assign(op, { imageAssetId: photoAsset.path, audioAssetId: audioAsset.path });
      await this.store.mutate(data => { data.digitalHuman.operations[op.id] = op; });
      return view(op);
    } catch (error) {
      await this.removeInputs(staged).catch(() => {});
      throw error;
    } finally { this.uploading.delete(user.id); }
  }

  async removeInputs(ids) {
    if (!ids.length) return;
    const files = await this.store.mutate(data => ids.flatMap(id => {
      const asset = data.assets[id];
      if (asset?.source !== "fal-lip-sync-input") return [];
      delete data.assets[id];
      return [asset.storageName];
    }));
    await Promise.all(files.map(file => unlink(path.join(this.store.assetsDir, file)).catch(() => {})));
  }

  async update(id, fields) {
    return this.store.mutate(data => Object.assign(data.digitalHuman.operations[id], fields, { updatedAt: now() }));
  }

  async failOperation(op, message) {
    await this.update(op.id, { status: "failed", message, result: undefined });
    await this.removeInputs([op.imageAssetId, op.audioAssetId]);
    if (op.remoteId) await modelReceipt(this.config, feature, inferenceUrl, FAL_LIP_SYNC_MODEL, { request_id: op.remoteId, status: "failed" });
  }

  async submit(op) {
    if (!falLipSyncConfigured(this.config) || op.connection !== connectionFingerprint(this.config) || !this.userActive(op.ownerId)) return this.failOperation(op, "服务连接或账号权限已变更，请检查后重新提交");
    const created = Date.parse(op.createdAt);
    if (Date.now() - created >= 10 * 60_000) return this.failOperation(op, "素材等待超时，请重新上传");
    if (!this.store.getAssetMetadata(op.imageAssetId) || !this.store.getAssetMetadata(op.audioAssetId)) return this.failOperation(op, "上传素材已失效，请重新上传");
    const imageUrl = referenceDownloadUrl(this.config, op.imageAssetId, op.id, created, sourceLifetime);
    const audioUrl = referenceDownloadUrl(this.config, op.audioAssetId, op.id, created, sourceLifetime);
    await this.update(op.id, { status: "submitting", message: "正在提交生成请求" });
    try {
      const result = await falJson(this.config, inferenceUrl, { body: { image_url: imageUrl, audio_url: audioUrl, resolution: limits.resolution, enable_safety_checker: true }, submit: true });
      remoteId(result.request_id);
      await this.update(op.id, { status: "generating", remoteId: result.request_id, message: "供应商已接单，正在生成" });
    } catch (error) {
      if (error.rejected) {
        const message = [401, 402, 403].includes(error.upstreamStatus) ? "fal 拒绝了请求，请联系站长检查密钥权限及余额" : error.upstreamStatus === 429 ? "fal 当前任务量已达上限，请稍后重新提交" : "fal 拒绝了请求，请核对素材格式与服务配置";
        await this.failOperation(op, message);
      } else await this.update(op.id, { status: "uncertain", message: "提交回执待核对，请联系站长查询原请求；系统不会自动重复提交" });
    }
  }

  async poll(op) {
    const url = requestUrl(op.remoteId);
    const status = await falJson(this.config, `${url}/status`);
    if (status.request_id !== op.remoteId) throw new Error("请求回执编号不符");
    if (["IN_QUEUE", "IN_PROGRESS"].includes(status.status)) {
      const message = status.status === "IN_QUEUE" ? "供应商正在排队" : "正在生成口型视频";
      return this.update(op.id, { message, nextPollAt: Date.now() + 5000 });
    }
    if (status.status !== "COMPLETED") throw new Error("未取得可用的任务状态");
    if (status.error || status.error_type) return this.failOperation(op, "fal 未完成视频，请核对录音、照片和服务状态");
    let result;
    try { result = await falJson(this.config, url); }
    catch (error) {
      if ([413, 415, 422, 499].includes(error.upstreamStatus)) return this.failOperation(op, "fal 未完成视频，请核对录音、照片和服务状态");
      throw error;
    }
    if (!Number.isFinite(result.duration) || Math.abs(result.duration - op.inputDuration) > 0.5) throw new Error("视频时长与输入原声不符");
    const saving = await this.update(op.id, { status: "saving", result: { url: downloadUrl(result.video?.url), duration: result.duration }, message: "正在保存视频" });
    await this.removeInputs([op.imageAssetId, op.audioAssetId]);
    return this.save(saving);
  }

  async save(op) {
    const source = `fal-lip-sync-output:${op.id}`;
    const previous = Object.values(this.store.data.assets).find(asset => asset.source === source && asset.ownerId === op.ownerId);
    let asset = previous ? { path: previous.id, name: previous.name, size: previous.size, kind: previous.kind, mime: previous.mime } : undefined;
    if (!asset) {
      const buffer = await downloadVideo(this.config, op.result.url);
      const duration = await validateDigitalMedia(new File([buffer], "原声口播.mp4", { type: "video/mp4" }), "video", 16, { requireSound: true });
      if (Math.abs(duration - op.inputDuration) > 0.5) throw new Error("成片与录音长度不符");
      asset = await this.store.putAsset({ buffer, name: "原声口播.mp4", kind: "output", mime: "video/mp4", projectId: op.id, ownerId: op.ownerId, source });
    }
    const duration = op.result.duration;
    await modelReceipt(this.config, feature, inferenceUrl, FAL_LIP_SYNC_MODEL, { request_id: op.remoteId, model: FAL_LIP_SYNC_MODEL, duration, status: "completed" });
    await this.store.mutate(data => {
      const at = now();
      Object.assign(data.digitalHuman.operations[op.id], { status: "completed", result: undefined, duration, output: asset.path, message: "视频已保存", updatedAt: at });
      data.digitalHuman.lipSyncVerification = { connection: op.connection, at };
      data.appState.works.push({ id: `lip-sync-${op.id}`, ownerId: op.ownerId, projectId: op.id, category: "digital_human", title: "原声口播", createdAt: at, updatedAt: at, cover: asset, videos: [asset] });
    });
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const current = Date.now();
      const expired = Object.values(this.store.data.assets).filter(asset => {
        if (asset.source !== "fal-lip-sync-input") return false;
        const op = this.operations[asset.projectId];
        return (op && (!unresolved.has(op.status) || op.status === "saving")) || current - Date.parse(op?.createdAt ?? asset.createdAt) > sourceLifetime * 1000;
      });
      await this.removeInputs(expired.map(asset => asset.id));
      const pending = Object.values(this.operations).filter(op => op.type === "lip-sync" && ["queued", "generating", "saving"].includes(op.status) && (op.nextPollAt ?? 0) <= current);
      pending.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      await Promise.allSettled(pending.slice(0, 3).map(async op => {
        if (op.status === "queued") return this.submit(op);
        if (current - Date.parse(op.createdAt) > 50 * 60_000 || op.connection !== connectionFingerprint(this.config)) return this.update(op.id, { status: "uncertain", result: undefined, message: "原请求需核实，请联系站长检查供应商记录" });
        try { await (op.status === "saving" ? this.save(op) : this.poll(op)); }
        catch { await this.update(op.id, { message: "正在重新获取原任务结果", nextPollAt: Date.now() + 12_000 }); }
      }));
    } finally { this.busy = false; }
  }
}

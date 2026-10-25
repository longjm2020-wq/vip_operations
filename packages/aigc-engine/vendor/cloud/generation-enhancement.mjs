import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { enhancementRoute, enhancementBody, enhancementCatalog } from "./video-enhance.mjs";
import { mediaCall, pollVideo } from "./video-providers.mjs";
import { probeReference } from "./media-references.mjs";
import { reserve, markSubmitted, settle, MICRO, fail } from "./access.mjs";

const active = job => job && !["completed", "failed", "cancelled"].includes(job.status);
const resolutions = ["1080p", "2k", "4k"];
const stamp = () => new Date().toISOString();
async function probeOutput(buffer) {
  const directory = await mkdtemp(path.join(tmpdir(), "xuti-enhance-"));
  try {
    const file = path.join(directory, "output.mp4");
    await writeFile(file, buffer);
    return await probeReference(file, "referenceVideo", "output.mp4");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export function cleanEnhancement(value) {
  const resolution = value?.resolution || "1080p";
  if (!resolutions.includes(resolution)) fail("视频超分仅支持 1080p、2K、4K");
  return { enabled: value?.enabled === true, resolution };
}
export function enhancementQuote(config, pricing, value, durations = []) {
  const selection = cleanEnhancement(value);
  if (!selection.enabled) return { enabled: false, credits: 0, items: [] };
  const catalog = enhancementCatalog(config);
  const perSecond = 0;
  const issue = !catalog.configured ? "视频超分服务暂未配置，请关闭超分或联系管理员" : "";
  const items = durations.map(seconds => {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) fail("超分源视频时长无效");
    const amount = Math.round(Math.ceil(perSecond * seconds * 100 - 1e-8) / 100 * MICRO);
    return { amount, credits: amount / MICRO, seconds, perSecond, kind: "enhance", pricingVersion: pricing?.version, basis: "标准版、保留原帧率、自然风格；实际源视频秒数 × 锁定单价，单段向上取至分", resolution: selection.resolution };
  });
  return { enabled: true, resolution: selection.resolution, perSecond: Number.isFinite(perSecond) ? perSecond : null, credits: issue || !items.length ? null : items.reduce((s, q) => s + q.amount, 0) / MICRO, issue, items };
}
const operationId = (jobId, unitId, budget = false) => `${jobId}:enhance:${unitId}${budget ? ":budget" : ""}`;
export function reserveEnhancement(data, config, project, jobId, units) {
  const selection = cleanEnhancement(project.videoEnhancement);
  if (!selection.enabled) return undefined;
  const quote = enhancementQuote(config, data.platform?.pricing, selection, units.map(u => u.duration_s));
  if (quote.issue) fail(quote.issue);
  // Validate public delivery configuration before reserving or generating anything.
  enhancementDownloadUrl(config, "preflight", jobId);
  const records = {};
  units.forEach((unit, index) => {
    const tariff = quote.items[index];
    reserve(data, { id: operationId(jobId, unit.id, true), userId: project.ownerId, jobId, quote: tariff, label: `${unit.id} 视频超分预算` });
    records[unit.id] = { state: "reserved", quote: tariff };
  });
  return { selection, records };
}
export function releaseEnhancements(data, jobId, reason = "超分未交付，解除预留；原视频保留") {
  for (const c of Object.values(data.platform?.requests || {})) if (c.jobId === jobId && c.quote?.kind === "enhance") settle(data, c.id, false, reason);
}

function signature(config, assetId, jobId, expires) {
  return createHmac("sha256", config.sessionSecret).update(`video-enhance/v1\n${assetId}\n${jobId}\n${expires}`).digest("hex");
}
export function enhancementDownloadUrl(config, assetId, jobId, now = Date.now()) {
  const base = new URL(config.publicBaseUrl || "https://unconfigured.invalid");
  if (!config.publicBaseUrl || base.protocol !== "https:" || base.username || base.password || !config.sessionSecret) fail("视频超分需要配置网站 HTTPS 公网地址");
  const expires = String(Math.floor(now / 1000) + 3600);
  const url = new URL(`/api/v1/aigc/enhancement-source/${encodeURIComponent(assetId)}`, base);
  url.search = new URLSearchParams({ job: jobId, expires, signature: signature(config, assetId, jobId, expires) }).toString();
  return url.href;
}
export function enhancementDownloadOwner(store, config, assetId, params, now = Date.now()) {
  const jobId = params.get("job"), expires = params.get("expires"), sig = params.get("signature") || "";
  if (!config.sessionSecret || !/^\d+$/.test(expires || "") || Number(expires) <= now / 1000 || !/^[a-f0-9]{64}$/.test(sig)) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(signature(config, assetId, jobId, expires)))) return null;
  const job = store.getJob(jobId), asset = store.getAssetMetadata(assetId);
  if (!active(job) || !asset || asset.kind !== "output" || !asset.mime?.startsWith("video/") || asset.ownerId !== job.ownerId || asset.projectId !== job.projectId) return null;
  if (!Object.values(job.payload?.enhancement?.records || {}).some(r => r.sourceAssetId === assetId && ["inflight", "submitted"].includes(r.state))) return null;
  return job.ownerId;
}

// One short scheduling step at a time. Polling releases the normal worker slot;
// durable submission markers prevent duplicate paid requests after a restart.
export class GenerationEnhancement {
  constructor({ store, config, download, probe = probeReference, validateOutput = probeOutput, submit = mediaCall, poll = pollVideo }) {
    Object.assign(this, { store, config, download, probe, validateOutput, submit, poll });
  }
  async advance(job) {
    const enhancement = job.payload?.enhancement;
    if (!enhancement) return true;
    const entry = Object.entries(enhancement.records).find(([, r]) => !["completed", "failed"].includes(r.state));
    if (!entry) return true;
    const [unitId, record] = entry, id = operationId(job.id, unitId), budgetId = operationId(job.id, unitId, true);
    const route = enhancementRoute(this.config.videoRelayBaseUrl);
    const update = fn => this.store.mutate(data => {
      const current = data.jobs[job.id];
      if (!active(current)) return false;
      const r = current.payload.enhancement.records[unitId];
      const task = data.appState.tasks.find(t => t.id === job.taskId);
      fn(data, current, r, task);
      if (current.status !== "paused") {
        current.status = "waiting_provider";
        current.nextRunAt = Date.now() + (this.config.xaiPollMs || 15000);
        current.leaseUntil = undefined;
      }
      return true;
    });
    const finishFailed = message => update((data, current, r, task) => {
      r.state = "failed"; r.error = message; r.finishedAt = stamp();
      settle(data, budgetId, false, "未执行超分，解除预算");
      settle(data, id, false, "视频超分未交付，解除预留");
      task.logs.push({ at: stamp(), level: "warning", message: `${unitId} 超分未交付，原视频已保留。${message}` });
      task.currentItem = `${unitId} 保留原视频，继续归档`;
    });
    try {
      if (record.state === "inflight" && !record.taskId) {
        await finishFailed("提交回执不明，已保留核查记录，不会自动重提。"); return false;
      }
      if (record.state === "reserved") {
        const source = job.payload.checkpoints?.[unitId]?.video;
        const asset = source && await this.store.openAsset(source.path);
        if (!asset || asset.metadata.ownerId !== job.ownerId || asset.metadata.projectId !== job.projectId || asset.metadata.kind !== "output") throw new Error("原视频不存在或不属于当前项目");
        const media = await this.probe(asset.filePath, "referenceVideo", source.name);
        // Never charge more than the locked segment budget. Frame rounding is
        // absorbed by the platform; unexpectedly longer results are not submitted.
        if (media.durationSeconds > record.quote.seconds + .1) throw new Error("实际时长超过已确认预算，已跳过超分");
        const seconds = Math.min(media.durationSeconds, record.quote.seconds);
        const amount = Math.min(record.quote.amount, Math.round(Math.ceil(seconds * record.quote.perSecond * 100 - 1e-8) / 100 * MICRO));
        const quote = { ...record.quote, seconds, amount, credits: amount / MICRO };
        const body = enhancementBody({ ...enhancement.selection, videoUrl: enhancementDownloadUrl(this.config, source.path, job.id) });
        const ready = await update((data, current, r, task) => {
          if (current.status === "paused" || r.state !== "reserved") throw new Error("任务状态已变化，未提交超分");
          settle(data, budgetId, false, "按实际源视频时长调整超分预留");
          reserve(data, { id, jobId: job.id, userId: job.ownerId, quote, label: `${unitId} 视频超分 · ${seconds} 秒` });
          markSubmitted(data, id);
          Object.assign(r, { state: "inflight", startedAt: stamp(), sourceAssetId: source.path, media, billedQuote: quote });
          task.currentItem = `${unitId} 视频超分中（原视频已保存）`;
          task.updatedAt = stamp();
          task.logs.push({ at: stamp(), level: "info", message: `${unitId} 已提交 ${seconds} 秒视频超分；请求编号会持久保存，失败时保留原视频。` });
        });
        if (!ready) return false;
        const response = await this.submit(this.config, route, "/v1/media/generate", body);
        if (response.task_id == null || !String(response.task_id)) throw new Error("提交未返回任务编号，不会重提");
        // Persist even a late receipt for administrator reconciliation; never
        // resurrect a cancelled job or recapture a released reservation.
        await this.store.mutate(data => {
          const r = data.jobs[job.id]?.payload?.enhancement?.records[unitId];
          if (r) { r.taskId = String(response.task_id); if (active(data.jobs[job.id])) r.state = "submitted"; }
        });
        return false;
      }
      if (Date.now() - Date.parse(record.startedAt) > 15 * 60_000) { await finishFailed("超分等待超过 15 分钟，原请求保留核查，不会重提。"); return false; }
      const response = await this.poll(this.config, route, record.taskId);
      if (response.pending) { await update(() => {}); return false; }
      if (!response.url) { await finishFailed("超分服务未返回可交付视频。"); return false; }
      const buffer = await this.download(response.url);
      if (!active(this.store.getJob(job.id))) return false;
      let checked;
      try { checked = await this.validateOutput(buffer); }
      catch { throw Object.assign(new Error("超分输出不是有效视频"), { terminal: true }); }
      if (Math.abs(checked.durationSeconds - record.media.durationSeconds) > .25 || (record.media.hasAudio && !checked.hasAudio) || Math.abs(checked.width / checked.height - record.media.width / record.media.height) > .03 || Math.abs(checked.fps - record.media.fps) > .1) throw Object.assign(new Error("超分结果时长、音轨、帧率或比例不符，已保留原视频"), { terminal: true });
      const output = await this.store.putAsset({ buffer, name: `${unitId}_超分_${enhancement.selection.resolution}.mp4`, kind: "output", mime: "video/mp4", projectId: job.projectId, source: "video-enhance" });
      await update((data, current, r, task) => {
        if (r.state === "completed") return;
        r.state = "completed"; r.output = output; r.finishedAt = stamp();
        if (!task.outputFiles.some(f => f.path === output.path)) task.outputFiles.push(output);
        settle(data, id, true, `${unitId} 超分视频已保存（${r.billedQuote.seconds} 秒）`);
        task.logs.push({ at: stamp(), level: "success", message: `${unitId} 超分完成，原视频和超分版均已保留。超分不是商品真值核对，不代表细节零变化。` });
      });
    } catch (error) {
      // Read failures can poll the SAME task again, but POST is never retried.
      if (record.taskId && !error.terminal && Date.now() - Date.parse(record.startedAt) <= 15 * 60_000) {
        await update((data, current, r) => { r.lastError = String(error.message).slice(0, 300); });
      } else await finishFailed(String(error.message).replace(/https?:\/\/\S+/g, "服务地址").slice(0, 240));
    }
    return false;
  }
}

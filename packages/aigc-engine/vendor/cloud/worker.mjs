import { createHash, randomUUID } from "node:crypto";
import { CONSISTENCY_VERSION, CONSISTENCY_NEGATIVES, identityLock, referenceEntries } from "./consistency.mjs";
import { referenceSampleTimes } from "./reference-sampling.mjs";
import { SceneRecommendations } from "./scene-recommendations.mjs";
import { selectCompiler, compilerForUser, compilerSnapshot, compilerRequest, assertCompilerAccess } from "./compile-providers.mjs";
import { responseOutputText, compileReceipt, isTerminalCompileReceipt, compileReceiptIssue, compileRequestOptions } from "./compile-response.mjs";
import { compileShotPrompt } from "./compile-shot.mjs";
import { normalizeProductLocks, productTruthRevision } from "./product-truth.mjs";
import { sceneInstructions, findScene } from "../shared/scene-catalog.mjs";
import { operationPlan, reserve, markSubmitted, settle, releaseUnsubmitted, assertNoPendingRequests } from "./access.mjs";
import { assertVideoAccess } from "./customer-view.mjs";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import sharp from "sharp";
import { withJobSignal, jobRequestSignal } from "./job-request.mjs";
import { buildCompileInstructions, COMPILE_KERNEL } from "./kernel.mjs";
import { compileRevision, KERNEL_CAPABILITIES } from "./kernel-source.mjs";
import { generationProject, referenceSnapshot } from "./project-references.mjs";
import { alignVideoDuration, planVideoDurations, supportedVideoDurations } from "./video-duration.mjs";
import { videoCatalog, selectVideoRoute, videoKey, videoReferenceCount, validateVideoInput, preflightXhaiVideo, XhaiVideoAdjustmentError, submitVideo, pollVideo } from "./video-providers.mjs";
import { keyframeImageRoute, assertImageAccess } from "./image-provider.mjs";
import { uploadXhaiImages } from "./xhai-files.mjs";
import { KeyframeService, checkedKeyframe } from "./keyframes.mjs";
import { createKeyframeGate, hasKeyframeApproval, lockedVideoPrompt, referenceFiles } from "./keyframe-contract.mjs";
import { prepareVideoPrompt } from "./video-prompt.mjs";
import { projectMediaReferences, referenceDownloadUrl } from "./media-references.mjs";
import { GenerationEnhancement, reserveEnhancement, releaseEnhancements } from "./generation-enhancement.mjs";
import { FidelityService, FIDELITY_VERSION } from "./fidelity.mjs";
import { VisualReviewService } from "./visual-review.mjs";
import { prepareDetailViews, detailReferenceBudgets } from "./visual-detail.mjs";
import { reviewSampleTimes, reviewReferences } from "./visual-review-contract.mjs";
import { createVisualImagePool } from "./visual-image-pool.mjs";
import { castFingerprint, castIssue, castScriptPlan, normalizeUnitCast, selectedCast } from "../shared/project-cast.mjs";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");
const execFileAsync = promisify(execFile);

const ACTIVE_TASK_STAGES = new Set(["queued", "preflight", "uploading", "analyzing", "compiling", "extracting", "generating", "downloading", "paused", "attention"]);
export const MAX_WORKER_CONCURRENCY = 10;

class AttentionError extends Error {}
class ProviderError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.details = details;
  }
}

function now() { return new Date().toISOString(); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function clip(value, maximum) { return String(value || "").slice(0, maximum); }
function clone(value) { return structuredClone(value); }

function taskFor(data, id) {
  const task = data.appState.tasks.find((item) => item.id === id);
  if (!task) throw new Error("任务不存在或已被删除");
  return task;
}

function projectFor(data, id) {
  const project = data.appState.projects.find((item) => item.id === id);
  if (!project) throw new Error("项目不存在或已被删除");
  return project;
}

function addLog(task, level, message) {
  task.logs ??= [];
  task.logs.push({ at: now(), level, message: clip(message, 1000) });
  if (task.logs.length > 160) task.logs.splice(0, task.logs.length - 160);
}

function taskPatch(task, patch, log) {
  Object.assign(task, patch, { updatedAt: now() });
  if (log) addLog(task, log.level, log.message);
  return task;
}

function activeProjectTask(data, projectId) {
  return data.appState.tasks.find((task) => task.projectId === projectId && ACTIVE_TASK_STAGES.has(task.stage) && !["completed", "failed"].includes(task.stage));
}

function noProviderConfig(provider) {
  const messages = {
    openrouter: "拆解服务尚未就绪；请在系统设置 → AI 模型设置启用并验证 OpenRouter。",
    openai: "尚未配置 OPENAI_API_KEY；请在 Railway 的 Variables 中添加后重试。",
    xhai: "尚未配置星火 AIGC Key；请在 AIGC 服务设置中保存后重试。",
    xai: "尚未配置 xAI Key；请在 AIGC 服务设置中保存后重试。",
  };
  return new AttentionError(messages[provider] ?? "尚未配置模型服务；请检查 AIGC 服务设置。");
}

function parseJsonOutput(value) {
  const source = String(value || "").trim();
  if (!source) throw new AttentionError("编译供应商未返回可解析的 B/C JSON；任务已保留，未重复计费提交。");
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? source;
  const begin = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (begin < 0 || end <= begin) throw new AttentionError("编译供应商返回内容不是完整 JSON；任务已保留，未重复计费提交。");
  try { return JSON.parse(fenced.slice(begin, end + 1)); }
  catch { throw new AttentionError("编译供应商返回的 B/C JSON 结构不完整；任务已保留，未重复计费提交。"); }
}

function normalizeCompileContract(parsed, config, sourceDuration, project, model = selectVideoRoute(config, project?.videoSelection).model) {
  const rawUnits = Array.isArray(parsed.units) ? parsed.units : Array.isArray(parsed.b) ? parsed.b : [];
  if (!rawUnits.length) throw new AttentionError("B/C 输出缺少 units；任务未自动重跑，以避免重复消耗。请在任务反馈中提交该案例。");
  if (rawUnits.length > 120) throw new AttentionError("原片分镜超过 120 个，无法完整核对；未自动重提。");
  const units = rawUnits.map((unit, index) => {
    const id = String(unit.id || `S${String(index + 1).padStart(2, "0")}`).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) || `S${String(index + 1).padStart(2, "0")}`;
    const duration = Number(unit.duration_s ?? config.defaultClipSeconds);
    if (!Number.isFinite(duration) || duration <= 0 || duration > config.maxVideoSecondsPerProject) throw new AttentionError(`分镜 ${id} 时长无效，未自动重提。`);
    const prompt = compileShotPrompt(unit);
    if (!prompt) throw new AttentionError(`分段 ${id} 缺少有效提示词或配套的镜位、动作、场景，无法建立完整分镜；任务未自动重跑。`);
    let casting;
    try { casting = normalizeUnitCast(project, unit); } catch (error) { throw new AttentionError(error.message); }
    return {
      ...casting,
      id,
      duration_s: duration,
      camera: clip(unit.camera, 1600),
      action: clip(unit.action, 1600),
      scene: project.sceneMode === "keywords" ? findScene(project.sceneSelection?.sceneId)?.description || clip(unit.scene, 1600) : clip(unit.scene, 1600),
      grok_prompt: [sceneInstructions(project), clip(prompt, 12000)].filter(Boolean).join("\n"),
      keyframe_prompt: [sceneInstructions(project), clip(unit.keyframe_prompt || unit.camera || "", 4000)].filter(Boolean).join("\n"),
      negative_constraints: [...CONSISTENCY_NEGATIVES, ...(typeof parsed.truth?.reference_leakage_guard === "string" && parsed.truth.reference_leakage_guard.trim() ? [`源服装排除观察（不得覆盖商品原图）：${clip(parsed.truth.reference_leakage_guard, 2000)}`] : []), ...(Array.isArray(unit.negative_constraints) ? unit.negative_constraints.map((item) => clip(item, 800)).slice(0, 15) : [])],
      required_product_views: Array.isArray(unit.required_product_views) ? [...new Set(unit.required_product_views.filter(v => ["front", "back", "side", "inside"].includes(v)))] : [],
    };
  });
  const cast = project?.cast ? selectedCast(project) : null;
  if (cast) {
    for (const role of cast.roles) if (!units.some(u => u.character_ids.includes(role.id))) throw new AttentionError(`脚本遗漏已选角色“${role.name}”，请核对后处理，未自动重新提交。`);
    for (const product of cast.products) if (!units.some(u => u.product_ids.includes(product.id))) throw new AttentionError(`脚本遗漏已选商品“${product.name}”，请核对后处理，未自动重新提交。`);
    for (const unit of units) for (const role of cast.roles) if (cast.products.filter(p => p.roleId === role.id && unit.product_ids.includes(p.id)).length > 1) throw new AttentionError("同一角色的多组商品须分镜展示；本段关联不清，等待核对，未自动重新提交。");
  }
  const totalSeconds = units.reduce((sum, unit) => sum + unit.duration_s, 0);
  if (sourceDuration == null && totalSeconds > config.maxVideoSecondsPerProject) {
    throw new AttentionError(`计划生成 ${totalSeconds} 秒，超过本项目 ${config.maxVideoSecondsPerProject} 秒预算上限；任务未提交到 Grok。`);
  }
  const contract = {
    schema: "XUTI_COMPILE_V1",
    timeline: Array.isArray(parsed.timeline) ? parsed.timeline.slice(0, units.length).map(t => project.sceneMode === "keywords" ? { ...t, scene: findScene(project.sceneSelection?.sceneId)?.description } : t) : units.map((unit) => ({ id: unit.id, camera: unit.camera, action: unit.action, scene: unit.scene, duration_s: unit.duration_s })),
    units,
    truth: parsed.truth && typeof parsed.truth === "object" ? parsed.truth : {},
    productLock: normalizeProductLocks(parsed.product_lock, project, { strict: true }),
    qa: parsed.qa && typeof parsed.qa === "object" ? parsed.qa : {},
  };
  try { return alignVideoDuration(contract, sourceDuration, config, { model, allowSingleClip: !cast || !cast.roles.some(r => cast.products.filter(p => p.roleId === r.id).length > 1) }); }
  catch (error) { throw new AttentionError(error.message); }
}

function stableFingerprint(project) {
  return createHash("sha256").update(JSON.stringify({
    durationPolicy: "shot-preserving-v3",
    videoSelection: project.videoSelection,
    productPolicy: CONSISTENCY_VERSION,
    mode: project.assets.reusableTemplate ? "recompile" : "first",
    video: project.assets.video?.path || null,
    ...(project.assets.referenceVideos?.length ? { referenceVideos: project.assets.referenceVideos.map(f => f.path) } : {}),
    ...(project.assets.referenceAudios?.length ? { referenceAudios: project.assets.referenceAudios.map(f => f.path) } : {}),
    template: project.assets.reusableTemplate?.path || null,
    customInput: project.assets.customInput?.path,
    models: project.assets.modelImages.map((item) => item.path),
    products: project.assets.productImages.map((item) => item.path),
    scenes: project.assets.sceneImages.map((item) => item.path),
    replicationMode: project.replicationMode,
    sceneMode: project.sceneMode,
    sceneSelection: project.sceneMode === "keywords" ? project.sceneSelection : undefined,
    ratio: project.videoAspectRatio,
    modelMeasurements: project.modelMeasurements,
    productMeasurements: project.productMeasurements,
    cast: castFingerprint(project),
    notes: project.notes,
  })).digest("hex");
}

function resolveAspect(width, height) {
  if (!width || !height) return undefined;
  const value = width / height;
  const candidates = [["9:16", 9 / 16], ["2:3", 2 / 3], ["1:1", 1], ["3:2", 3 / 2], ["16:9", 16 / 9]];
  return candidates.sort((a, b) => Math.abs(value - a[1]) - Math.abs(value - b[1]))[0][0];
}

async function runFfmpeg(args, timeout = 60_000) {
  try {
    return await execFileAsync(ffmpegPath, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const stderr = String(error.stderr || error.message || "");
    error.message = stderr.slice(-4000) || "ffmpeg 执行失败";
    throw error;
  }
}

async function inspectVideo(videoPath) {
  try {
    await runFfmpeg(["-hide_banner", "-i", videoPath], 30_000);
  } catch (error) {
    const info = String(error.message || "");
    const durationMatch = info.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
    const dimensions = info.match(/(?:Stream #[^\n]+?Video:[^\n]*?)(\d{2,5})x(\d{2,5})/i);
    const duration = durationMatch
      ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
      : undefined;
    return { duration: duration && Number.isFinite(duration) ? duration : undefined, width: dimensions ? Number(dimensions[1]) : undefined, height: dimensions ? Number(dimensions[2]) : undefined };
  }
  return {};
}

export async function imageDataUri(buffer, detail = false, maxBytes = 10 * 1024 * 1024, minImageSide = 0) {
  const info = await sharp(buffer, { animated: false, failOn: "none" }).metadata();
  const shorter = Math.min(info.width || 0, info.height || 0);
  const longer = Math.max(info.width || 0, info.height || 0);
  const minimumMaxSide = minImageSide && shorter ? Math.ceil(longer * minImageSide / shorter) : 0;
  for (const side of [...new Set([detail ? 2048 : 1600, 1600, 1280, 960])]) {
    if (side < minimumMaxSide && longer > side) continue;
    for (const quality of [...new Set([detail ? 92 : 82, 80, 68, 56])]) {
      const output = await sharp(buffer, { animated: false, failOn: "none" })
        .rotate()
        .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, chromaSubsampling: detail ? "4:4:4" : "4:2:0", mozjpeg: true })
        .toBuffer();
      if (output.byteLength <= maxBytes) return `data:image/jpeg;base64,${output.toString("base64")}`;
    }
  }
  throw new AttentionError(`图片在保留必要尺寸后仍超过 ${Math.round(maxBytes / 1024 / 1024)}MB，请更换或手动压缩该素材。`);
}

async function videoFrames(buffer, label, config, model, overview = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "xuti-video-"));
  const inputPath = path.join(directory, "reference-video.bin");
  try {
    await writeFile(inputPath, buffer);
    const info = await inspectVideo(inputPath);
    if (!info.duration || info.duration <= 0) throw new AttentionError("无法读取参考视频时长；请上传可播放的 MP4/MOV 文件后重新开始。");
    if (overview && Math.floor(info.duration) > config.maxVideoSecondsPerProject) throw new AttentionError("参考视频超过项目时长上限，请精简后推荐场景");
    if (!overview) planVideoDurations(info.duration, config, model);
    const points = referenceSampleTimes(info.duration, overview);
    const frames = [];
    for (const [index, seconds] of points.entries()) {
      const outputPath = path.join(directory, `frame-${index + 1}.jpg`);
      await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-ss", String(seconds), "-i", inputPath, "-frames:v", "1", "-vf", "scale='min(1600,iw)':-2", outputPath], 50_000);
      const frame = await readFile(outputPath);
      frames.push({ label: `${label}关键帧 ${index + 1}/${points.length}（原片 ${seconds.toFixed(2)} 秒）`, dataUrl: await imageDataUri(frame) });
    }
    return { frames, info };
  } catch (error) {
    if (error instanceof AttentionError) throw error;
    throw new AttentionError(`参考视频关键帧提取失败：${clip(error.message, 320)}。任务未提交给编译供应商。`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function jsonResponse(url, options) {
  let response;
  let content;
  try {
    response = await fetch(url, { ...options, signal: jobRequestSignal(options?.signal ? 1_800_000 : 60_000, options?.signal) });
    content = await response.text();
  } catch (error) {
    throw new ProviderError(`网络连接失败：${error instanceof Error ? error.message : "未知错误"}`, 0);
  }
  let body;
  try { body = content ? JSON.parse(content) : {}; } catch { body = { raw: content.slice(0, 1600) }; }
  if (!response.ok) {
    throw new ProviderError(body?.error?.message || body?.message || `服务请求失败（HTTP ${response.status}）`, response.status, body);
  }
  return body;
}

function isTransient(error) {
  return error instanceof ProviderError && (error.status === 0 || error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500);
}

export class CloudWorker {
  constructor({ store, config, processJob }) {
    this.store = store;
    this.config = config;
    this.prepareVisualImage = createVisualImagePool(2);
    this.processJob = processJob || ((job) => this.#process(job));
    this.visual = new VisualReviewService({ store, compiler: (id, snapshot, ownerId) => this.#requireCompileProvider(id, snapshot, ownerId), prepare: (job, project, target, unit) => this.#prepareVisualReview(job, project, target, unit), prepareImages: (job, provider, images) => this.#prepareXhaiCompileImages(job, provider, images), createResponse: (p, instructions, images) => this.#createCompileResponse(p, instructions, images, 7000), getResponse: (p, id) => this.#getCompileResponse(p, id), sampleBatches: unit => Math.ceil(reviewSampleTimes(unit).length / 12), wake: () => this.wake() });
    this.fidelity = new FidelityService(store, this.visual);
    this.enhancement = new GenerationEnhancement({ store, config, download: url => this.#downloadVideo(url) });
    this.keyframes = new KeyframeService({ store, config, visual: this.visual, referenceDataUrls: (project, route) => this.#referenceDataUrls(project, route) });
    this.scenes = new SceneRecommendations({ store, compiler: (id, snapshot, userId) => this.#requireCompileProvider(id, snapshot, userId), prepare: p => this.#prepareCompileInput(p, true), prepareImages: (job, provider, images) => this.#prepareXhaiCompileImages(job, provider, images), createResponse: (p, instructions, images) => this.#createCompileResponse(p, instructions, images), getResponse: (p, id) => this.#getCompileResponse(p, id), parseResponse: r => parseJsonOutput(responseOutputText(r)), wake: () => this.wake() });
    this.timer = null;
    this.busy = false;
    this.activeJobs = new Map();
    this.scheduling = false;
    this.scheduleRequested = false;
    this.stopped = false;
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.#schedule(); }, this.config.workerPollMs);
    void this.#schedule();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  wake() { if (this.timer) void this.#schedule(); else void this.tick(); }

  async #schedule() {
    if (this.stopped) return;
    if (this.scheduling) { this.scheduleRequested = true; return; }
    this.scheduling = true;
    try {
      const concurrency = Math.max(1, Math.min(MAX_WORKER_CONCURRENCY, this.config.workerConcurrency || 1));
      while (!this.stopped && this.activeJobs.size < concurrency) {
        const excludedOwnerIds = [...this.activeJobs.values()].map(active => active.ownerId);
        const job = await this.store.claimNextJob({ excludedOwnerIds });
        if (!job) break;
        const controller = new AbortController();
        const work = Promise.resolve().then(() => withJobSignal(controller.signal, () => this.processJob(job)))
          .catch(error => console.error(`Cloud worker job ${job.id} failed outside recovery:`, error))
          .finally(() => { this.activeJobs.delete(job.id); if (!this.stopped) void this.#schedule(); });
        this.activeJobs.set(job.id, { ownerId: job.ownerId, projectId: job.projectId, controller, work });
      }
    } catch (error) {
      console.error("Cloud worker scheduling failed:", error);
    } finally {
      this.scheduling = false;
      if (this.scheduleRequested && !this.stopped) {
        this.scheduleRequested = false;
        queueMicrotask(() => { void this.#schedule(); });
      }
    }
  }

  providerAccounts() {
    const checkedAt = now();
    const compiler = this.compileProviderStatus();
    return {
      // The existing desktop-facing account key stays "chatgpt" for backwards
      // compatibility. In Cloud mode it represents the B/C compiler provider,
      // not a consumer ChatGPT browser session.
      chatgpt: compiler.configured
        ? { service: "chatgpt", status: "signed_in", lastCheckedAt: checkedAt, detail: `${compiler.label} 编译 API 已配置 · ${compiler.model}` }
        : { service: "chatgpt", status: "attention", lastCheckedAt: checkedAt, detail: compiler.missingDetail },
      grok: videoCatalog(this.config).some(p => p.configured)
        ? { service: "grok", status: "signed_in", lastCheckedAt: checkedAt, detail: `视频服务已配置：${videoCatalog(this.config).filter(p => p.configured).map(p => p.label).join("、")}` }
        : { service: "grok", status: "attention", lastCheckedAt: checkedAt, detail: "请配置视频服务 API 密钥" },
    };
  }

  compileProviderStatus() {
    const provider = this.#selectedCompileProvider();
    return {
      requested: this.store.data.compileSettings?.providerId || this.config.compileProvider,
      active: provider.apiKey ? provider.id : "unconfigured",
      configured: Boolean(provider.apiKey),
      label: provider.label,
      model: provider.model,
      openrouter: Boolean(this.config.openrouterApiKey),
      openai: Boolean(this.config.openaiApiKey),
      missingDetail: provider.id === "xhai" ? "请配置 XHAI_API_KEY"
        : provider.id === "openrouter"
        ? "需要在 Railway Variables 配置 OPENROUTER_API_KEY"
        : provider.id === "xylp" ? "请配置 VIDEO_RELAY_API_KEY 或编译专用密钥环境变量" : "需要在 Railway Variables 配置 OPENAI_API_KEY",
    };
  }

  #selectedCompileProvider() {
    return selectCompiler(this.config, this.store.data.compileSettings);
  }

  #requireCompileProvider(id, snapshot, userId) {
    const provider = userId ? compilerForUser(this.config, this.store.data, userId, snapshot || (id ? { id } : undefined)) : selectCompiler(this.config, this.store.data.compileSettings, snapshot || (id ? { id } : undefined));
    if (!provider.apiKey) throw noProviderConfig(provider.id);
    if (!provider.model) throw new AttentionError(`${provider.label} 未配置编译模型；请检查 Railway Variables。`);
    return provider;
  }

  async startCompile(projectId, pricingVersion, options = {}) {
    const task = await this.store.mutate((data) => {
      const project = projectFor(data, projectId);
      const compiler = this.#requireCompileProvider(undefined, undefined, project.ownerId);
      assertCompilerAccess(data, project.ownerId, compiler);
      const resumeDetail = compiler.supportsResponsePolling
        ? `已加入持久队列；长任务将保存 ${compiler.label} 请求编号并在连接恢复后继续轮询。`
        : `已加入持久队列；${compiler.label} 完整回包将由云端 worker 等待并原子保存，页面关闭不会中断。`;
      let validationSource;
      if (options.validationOf) {
        const actor = data.platform?.users.find(u => u.id === options.actorId && !u.disabled && u.role === "super_admin");
        if (!actor || options.compileOnly !== true || options.confirmed !== true) throw new Error("仅超级管理员确认后可执行一次仅编译验证");
        validationSource = data.jobs[options.validationOf];
        if (!validationSource || validationSource.projectId !== projectId || validationSource.type !== "compile" || validationSource.payload?.sceneRecommendation || !["failed", "cancelled"].includes(validationSource.status)) throw new Error("仅能验证已结束的编译任务");
        const previousId = validationSource.payload?.validationTaskId;
        const existing = previousId ? data.jobs[previousId] : Object.values(data.jobs).find(j => j.payload?.validationOf === options.validationOf);
        if (existing) return taskFor(data, existing.taskId);
        if (previousId) throw new Error("此来源任务已经执行过一次编译验证，不会重复提交");
        assertNoPendingRequests(data, validationSource.id);
        const quote = operationPlan(data, project.ownerId, "compile");
        if (!Number.isFinite(options.maxCredits) || options.maxCredits < 0 || quote.credits > options.maxCredits) throw new Error("编译费用超过本次授权上限，未提交请求");
      }
      if (project.status === "ended") throw new Error("项目已结束；如需重做，请新建项目");
      if (activeProjectTask(data, projectId)) throw new Error("该项目已有正在执行的云端任务");
      this.#assertCompileAssets(project);
      const timestamp = now();
      const runId = randomUUID();
      const task = {
        id: randomUUID(), ownerId: project.ownerId, projectId, runId, type: "compile", title: `${project.name} · ${project.assets.reusableTemplate ? "C 同款重编译" : "拆解编译"}`,
        stage: "queued", progress: 0, createdAt: timestamp, startedAt: timestamp, updatedAt: timestamp,
        currentItem: "等待云端任务队列", logs: [{ at: timestamp, level: "info", message: resumeDetail }], outputFiles: [],
        kernelVersion: COMPILE_KERNEL.version, kernelSha256: COMPILE_KERNEL.sha256,
      };
      data.appState.tasks.unshift(task);
      reserve(data, { id: `${task.id}:compile`, userId: project.ownerId, jobId: task.id, quote: operationPlan(data, project.ownerId, "compile"), label: `${project.name} · 拆解编译` });
      project.status = "compiling";
      delete project.sourceAssetsPurgedAt;
      project.compileTaskId = task.id;
      project.updatedAt = timestamp;
      data.jobs[task.id] = { id: task.id, taskId: task.id, ownerId: project.ownerId, projectId, runId, type: "compile", status: "queued", attempts: 0, nextRunAt: Date.now(), createdAt: timestamp, updatedAt: timestamp, payload: { runId, compiler: compilerSnapshot(compiler), kernelContract: clone(COMPILE_KERNEL), sourceFingerprint: stableFingerprint(project), inputProject: clone(project), ...(options.compileOnly === true ? { compileOnly: true } : {}), ...(validationSource ? { validationOf: validationSource.id } : {}) } };
      if (validationSource) {
        validationSource.payload = { ...validationSource.payload, validationTaskId: task.id };
        data.platform.audit.unshift({ id: randomUUID(), at: timestamp, actorId: options.actorId, action: "compile_validation", target: task.id, detail: `来源 ${validationSource.id}；禁止自动生图/视频` });
        addLog(task, "info", "本次仅验证拆解编译；不会自动创建关键帧或视频任务。");
      }
      return task;
    });
    this.wake();
    return task;
  }

  previewGenerationDurations(project, sourceDuration) {
    const fingerprint = stableFingerprint(project);
    const job = Object.values(this.store.data.jobs).filter(j => j.projectId === project.id && j.type === "compile" && j.status === "completed" && j.payload?.artifacts?.sourceFingerprint === fingerprint).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (job) return { durations: job.payload.artifacts.units.map(u => u.duration_s), basis: "已编译的完整生成计划" };
    const target = Number.isFinite(sourceDuration) ? Math.floor(sourceDuration + 1e-6) : 0;
    if (!target) return { durations: [], basis: "等待读取原片或编译结果" };
    try {
      const route = selectVideoRoute(this.config, project.videoSelection);
      const durations = planVideoDurations(sourceDuration, this.config, route.model);
      return { durations, basis: `按所选模型分段预估：${durations.join(" + ")} 秒；编译后以实际分镜计划为准` };
    } catch (error) { return { durations: [], basis: error.message, issue: error.message }; }
  }

  async startGeneration(projectId) {
    const task = await this.store.mutate((data) => {
      const project = projectFor(data, projectId);
      if (project.status === "ended") throw new Error("项目已结束；如需重做，请新建项目");
      const route = selectVideoRoute(this.config, project.videoSelection);
      assertVideoAccess(data, project.ownerId, route);
      if (!videoKey(this.config, route)) throw new Error(`${route.label} 尚未配置 API 密钥`);
      if (activeProjectTask(data, projectId)) throw new Error("该项目已有正在执行的云端任务");
      const compileJob = Object.values(data.jobs).filter((job) => job.type === "compile" && job.projectId === projectId && job.status === "completed" && job.payload?.artifacts).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!compileJob) throw new Error("尚未找到有效的 B/C 编译结果，请先完成拆解编译");
      if (compileJob.payload.artifacts.sourceFingerprint !== stableFingerprint(project)) throw new Error("素材或内核规则已变化，请重新编译商品锁定清单后再生成视频");
      // Records created before runId existed get upgraded here too. This keeps
      // an older completed compile and its newly started generation in one
      // project card instead of splitting the same workflow into two rows.
      return this.#enqueueGeneration(data, project, compileJob.payload.artifacts, this.#ensureRunId(data, compileJob));
    });
    this.wake();
    return task;
  }

  async reprocessCompile(taskId) {
    const task = await this.store.mutate(data => {
      const job = data.jobs[taskId];
      if (!job || job.type !== "compile" || job.payload?.sceneRecommendation || job.payload?.compileReceipt?.status !== "completed") throw new Error("没有可在本地重新校验的完整编译回包");
      const task = taskFor(data, job.taskId);
      if (job.payload?.localCompileRecovery && ["queued", "running", "completed"].includes(job.status)) return task;
      if (job.status !== "failed") throw new Error("仅能重新校验失败任务中已保存的回包");
      assertNoPendingRequests(data, job.id);
      const project = projectFor(data, job.projectId);
      if (project.status === "ended" || project.deletedAt || activeProjectTask(data, job.projectId)) throw new Error("项目已结束、删除或另有运行任务，不能重新校验");
      if (job.payload.sourceFingerprint !== stableFingerprint(project)) throw new Error("项目素材已经变化，不能把旧回包用于当前项目");
      job.payload = { ...job.payload, localCompileRecovery: true, compileOnly: true };
      job.status = "queued";
      job.error = undefined;
      job.nextRunAt = Date.now();
      job.updatedAt = now();
      taskPatch(task, { stage: "extracting", error: undefined, finishedAt: undefined, currentItem: "正在本地重新校验已保存回包" }, { level: "info", message: "仅重新校验已保存的完整回包，不调用供应商，也不启动新的图片或视频生成。" });
      project.status = "compiling";
      project.updatedAt = now();
      return task;
    });
    this.wake();
    return task;
  }

  #assertCompileAssets(project) {
    const media = projectMediaReferences(this.store, project, selectVideoRoute(this.config, project.videoSelection));
    if (media.video.length || media.audio.length) referenceDownloadUrl(this.config, "preflight", "preflight");
    sceneInstructions(project);
    if (project.cast) { const issue = castIssue(project, Boolean(project.assets.reusableTemplate)); if (issue) throw new Error(issue); }
    if (!project.assets.modelImages?.length || !project.assets.productImages?.length) throw new Error("请先上传人物资产和商品产品图");
    if (project.assets.reusableTemplate) {
      const hasLength = project.productMeasurements?.some((field) => /衣长|garment[ _-]*length/i.test(field.label) && String(field.value || "").trim()) || Boolean(project.assets.customInput);
      if (!hasLength) throw new Error("C 同款重编译需要商品衣长实测信息或用户输入文件");
      return;
    }
    if (!project.assets.video) throw new Error("首次拆解必须上传参考短视频");
    if (project.sceneMode === "custom" && !project.assets.sceneImages?.length) throw new Error("使用自定义场景时至少上传一张场景图");
  }

  #ensureRunId(data, job) {
    const runId = job.runId ?? job.payload?.runId ?? randomUUID();
    job.runId = runId;
    job.payload = { ...(job.payload ?? {}), runId };
    taskFor(data, job.taskId).runId = runId;
    return runId;
  }

  #enqueueGeneration(data, project, artifacts, runId = randomUUID()) {
    if (project.status === "ended") throw new Error("项目已结束；不会继续提交视频生成");
    const timestamp = now();
    const videoRoute = selectVideoRoute(this.config, project.videoSelection);
    assertVideoAccess(data, project.ownerId, videoRoute);
    const firstFrame = videoRoute.model.inputMode === "first-frame";
    const imageRoute = firstFrame ? keyframeImageRoute(this.config, project.imageSelection) : undefined;
    if (imageRoute) assertImageAccess(data, project.ownerId, imageRoute);
    const aspectRatio = project.resolvedVideoAspectRatio || (project.videoAspectRatio === "auto" ? "9:16" : project.videoAspectRatio);
    const imageCount = videoReferenceCount(videoRoute, referenceFiles(project).length);
    const media = projectMediaReferences(this.store, project, videoRoute);
    for (const unit of artifacts.units) validateVideoInput(videoRoute, { duration: unit.duration_s, aspectRatio, referenceImages: Array(imageCount).fill("planned-image") });
    const taskId = randomUUID();
    const visualReview = this.visual.settings(project.ownerId);
    const reserved = data.platform ? { platform: clone(data.platform) } : { platform: undefined };
    const enhancement = reserveEnhancement(reserved, this.config, project, taskId, artifacts.units);
    if (!firstFrame) for (const unit of artifacts.units) reserve(reserved, { id: `${taskId}:video:${unit.id}`, userId: project.ownerId, jobId: taskId, quote: operationPlan(data, project.ownerId, "video", videoRoute, { durations: [unit.duration_s], imageCount, aspectRatio, referenceVideoSeconds: media.referenceVideoSeconds, referenceAudioCount: media.referenceAudioCount }), label: `${videoRoute.model.label} · ${unit.id}` });
    const task = {
      id: taskId, ownerId: project.ownerId, projectId: project.id, runId, type: "generate", title: `${project.name} · ${videoRoute.model.label} 生成`,
      stage: firstFrame ? "attention" : "queued", progress: 0, createdAt: timestamp, startedAt: timestamp, updatedAt: timestamp,
      currentItem: firstFrame ? "先生成或上传关键帧，图片备齐后自动扫描" : "多图参考已入队，准备扫描原图与脚本",
      logs: [{ at: timestamp, level: "info", message: firstFrame ? `已建立 ${videoRoute.model.label} 队列；关键帧就绪后自动视觉扫描，通过后可开始视频。` : `已建立 ${videoRoute.model.label} 队列；直接使用当前人物、商品和场景参考图，不生成关键帧。` }], outputFiles: [],
      keyframeReviewRequired: firstFrame,
    };
    data.appState.tasks.unshift(task);
    project.status = "generating";
    delete project.sourceAssetsPurgedAt;
    project.updatedAt = timestamp;
    data.jobs[task.id] = {
      id: task.id, taskId: task.id, ownerId: project.ownerId, projectId: project.id, runId, type: "generate", status: firstFrame ? "paused" : "queued", attempts: 0, nextRunAt: Date.now(), createdAt: timestamp, updatedAt: timestamp,
      payload: { runId, artifacts: clone(artifacts), videoRoute, ...(enhancement ? { enhancement } : {}), fidelityVersion: FIDELITY_VERSION, ...(visualReview ? { visualReview } : {}), ...(firstFrame ? { keyframeGate: { ...createKeyframeGate(artifacts), imageRoute } } : { referenceOnly: true }), index: 0, checkpoints: {} },
    };
    if (data.platform) data.platform = reserved.platform;
    return task;
  }

  async controlTask(taskId, action, options = {}) {
    const result = await this.store.mutate((data) => {
      const task = taskFor(data, taskId);
      const job = data.jobs[taskId];
      if (!job) throw new Error("任务队列记录不存在");
      if (["completed", "cancelled", "failed"].includes(job.status)) throw new Error("任务已结束，请重新建立任务");
      if (projectFor(data, task.projectId).status === "ended") throw new Error("项目已结束，不能继续此任务；需要重做时请重新启动项目");
      if (action === "abandon") {
        const unknownResult = !job.providerRequestId && (job.payload?.compileSubmission?.state === "inflight" || job.payload?.videoSubmission?.state === "inflight" || job.payload?.keyframeGate?.frames?.some(frame => frame.submission?.state === "inflight" && !frame.requestId));
        if (options.acknowledged !== true || job.status !== "paused" || !unknownResult) throw new Error("仅能在确认风险后结束已暂停且结果不明的任务");
        const timestamp = now();
        releaseUnsubmitted(data, job.id);
        job.status = "cancelled";
        job.leaseUntil = undefined;
        job.updatedAt = timestamp;
        taskPatch(task, { stage: "failed", finishedAt: timestamp, error: "用户结束了结果不明的任务；旧请求待核实", currentItem: "本次任务已结束，可建立新任务" }, { level: "warning", message: "用户已结束本次结果不明的任务。原供应商请求保留待核实，不会自动重提；请先核实原结果，再决定是否新建任务。" });
        const project = projectFor(data, task.projectId);
        project.status = job.type === "generate" && Object.values(data.jobs).some(item => item.projectId === project.id && item.type === "compile" && item.status === "completed" && item.payload?.artifacts) ? "compiled" : "ready";
        project.updatedAt = timestamp;
      } else if (action === "pause") {
        job.status = "paused";
        job.updatedAt = now();
        taskPatch(task, { stage: "paused", currentItem: "已暂停；供应商请求编号已保存", progress: task.progress }, { level: "warning", message: "任务已暂停；不会重复提交已创建的供应商请求。" });
      } else if (action === "resume") {
        if (!job.providerRequestId && (job.payload?.compileSubmission?.state === "inflight" || job.payload?.videoSubmission?.state === "inflight" || job.payload?.keyframeGate?.frames?.some(f => f.submission?.state === "inflight" && !f.requestId))) throw new Error("上次提交结果不明；请联系服务管理者核实原供应商请求记录，当前任务不能继续，也不能重复提交");
        if (job.type === "generate" && !job.providerRequestId && job.payload?.keyframeGate && !["generating", "released"].includes(job.payload.keyframeGate.phase)) throw new Error("请先完成关键帧视觉扫描，再点击“开始视频”；继续按钮不能跳过扫描");
        job.status = job.providerRequestId ? "waiting_provider" : "queued";
        job.nextRunAt = Date.now();
        job.updatedAt = now();
        taskPatch(task, { stage: job.type === "compile" ? "analyzing" : "generating", currentItem: "正在恢复云端任务" }, { level: "info", message: "已恢复；将继续轮询原供应商请求或从未提交步骤继续。" });
      } else if (action === "cancel") {
        releaseEnhancements(data, job.id);
        assertNoPendingRequests(data, job.id);
        releaseUnsubmitted(data, job.id);
        job.status = "cancelled";
        job.updatedAt = now();
        taskPatch(task, { stage: "failed", finishedAt: now(), error: "用户已取消任务", currentItem: "已取消" }, { level: "warning", message: "任务已取消。已提交的外部视频请求可能仍按供应商规则继续执行。" });
        const project = projectFor(data, task.projectId);
        if (!["completed", "compiled"].includes(project.status)) project.status = "attention";
      } else throw new Error("未知任务操作");
      return task;
    });
    if (action === "resume") this.wake();
    return result;
  }

  async endProject(projectId, ownerId) {
    const result = await this.store.mutate((data) => {
      const project = projectFor(data, projectId);
      if (ownerId && project.ownerId !== ownerId) {
        const error = new Error("项目不存在或不属于当前账号");
        error.status = 404;
        throw error;
      }
      if (project.status === "completed") throw new Error("项目已经完成，无需结束");
      // A previous failed/attention task may already be terminal while still
      // carrying a reserved (never submitted) quote. Ending the project must
      // release those holds too, without touching submitted charges.
      for (const job of Object.values(data.jobs).filter(item => item.projectId === projectId)) { releaseUnsubmitted(data, job.id); releaseEnhancements(data, job.id); }
      if (project.status === "ended") return project;
      const timestamp = now();
      for (const task of data.appState.tasks) {
        if (task.projectId !== projectId || !ACTIVE_TASK_STAGES.has(task.stage)) continue;
        const job = data.jobs[task.id];
        if (job) {
          job.status = "cancelled";
          job.leaseUntil = undefined;
          job.updatedAt = timestamp;
        }
        taskPatch(task, {
          stage: "failed", finishedAt: timestamp, error: "用户主动结束项目", currentItem: "项目已结束",
        }, { level: "warning", message: "用户结束了本项目；已停止后续排队和轮询。已提交的供应商请求可能仍按供应商规则结算。" });
      }
      project.status = "ended";
      project.updatedAt = timestamp;
      return project;
    });
    // Persist cancellation first, so late network responses cannot advance the
    // project. Abort its network waits to release the scheduler's slot promptly.
    for (const active of this.activeJobs.values()) {
      if (active.projectId === projectId) active.controller.abort(new Error("用户主动结束项目"));
    }
    return result;
  }

  async deleteFailedTask(taskId) {
    await this.store.mutate((data) => {
      const task = taskFor(data, taskId);
      if (task.stage !== "failed") throw new Error("只能删除失败任务记录");
      assertNoPendingRequests(data, taskId);
      releaseUnsubmitted(data, taskId);
      data.appState.tasks = data.appState.tasks.filter((item) => item.id !== taskId);
      delete data.jobs[taskId];
    });
  }

  async removeEndedRunFromQueue(taskId, ownerId) {
    return this.store.mutate(data => {
      const selected = taskFor(data, taskId);
      if (ownerId && selected.ownerId !== ownerId) {
        const error = new Error("任务不存在或不属于当前账号");
        error.status = 404;
        throw error;
      }
      const run = data.appState.tasks.filter(task => task.projectId === selected.projectId && (task.runId ?? "legacy") === (selected.runId ?? "legacy"));
      const projectEnded = projectFor(data, selected.projectId).status === "ended";
      if ((!projectEnded && !run.some(task => task.error === "用户主动结束项目")) || run.some(task => ACTIVE_TASK_STAGES.has(task.stage))) throw new Error("仅能从队列移除已结束的项目记录");
      const timestamp = now();
      for (const task of run) task.hiddenFromQueueAt = timestamp;
      // Keep jobs, outputs and charge records for billing reconciliation and
      // administrator audit. This is a queue deletion, not a project deletion.
      return { hidden: run.length };
    });
  }

  async submitFeedback(input) {
    return this.store.mutate((data) => {
      const task = taskFor(data, input.taskId);
      const project = projectFor(data, task.projectId);
      const timestamp = now();
      const item = {
        id: randomUUID(), taskId: task.id, projectId: project.id, projectName: project.name, source: "user",
        category: input.category, severity: input.severity, status: "new", title: "用户反馈", description: clip(input.description, 2000),
        taskStage: task.stage, taskType: task.type, kernelVersion: task.kernelVersion, kernelSha256: task.kernelSha256,
        recentLogs: task.logs.slice(-8).map((log) => log.message), outputFileNames: task.outputFiles.map((file) => file.name), createdAt: timestamp, updatedAt: timestamp,
      };
      data.appState.learningCases.unshift(item);
      return item;
    });
  }

  async updateLearningCase(id, patch) {
    return this.store.mutate((data) => {
      const item = data.appState.learningCases.find((candidate) => candidate.id === id);
      if (!item) throw new Error("未找到学习案例");
      Object.assign(item, { status: patch.status, adminNote: patch.adminNote, updatedAt: now() });
      return item;
    });
  }

  async tick() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      const job = await this.store.claimNextJob();
      if (!job) return;
      const controller = new AbortController();
      this.activeJobs.set(job.id, { ownerId: job.ownerId, projectId: job.projectId, controller });
      try { await withJobSignal(controller.signal, () => this.#process(job)); }
      finally { this.activeJobs.delete(job.id); }
    } finally {
      this.busy = false;
    }
  }

  async #process(claimedJob) {
    const current = this.store.getJob(claimedJob.id);
    if (!current || current.status !== "running") return;
    try {
      if (current.type === "compile") await this.#runCompile(current);
      else if (current.type === "generate") await this.#runGeneration(current);
      else throw new Error("未知任务类型");
    } catch (error) {
      if (this.store.getJob(claimedJob.id)?.status === "cancelled") return;
      if (current.type === "compile" && [400, 401, 403, 404, 422].includes(error.status) && !current.providerRequestId) await this.store.mutate(data => settle(data, `${current.id}:compile`, false, "供应商明确拒绝编译请求"));
      if (error instanceof AttentionError) {
        await this.#attention(current, error.message);
      } else if (isTransient(error)) {
        await this.#retry(current, error);
      } else {
        await this.#fail(current, error instanceof Error ? error.message : "未知云端错误");
      }
    }
  }

  async #setJob(id, patch) {
    return this.store.mutate((data) => {
      const job = data.jobs[id];
      if (!job) throw new Error("任务队列记录不存在");
      if (job.status === "cancelled") throw new Error("项目已结束，忽略迟到的供应商结果");
      Object.assign(job, patch, { updatedAt: now() });
      return job;
    });
  }

  async #updateTask(id, patch, log) {
    return this.store.mutate((data) => {
      if (data.jobs[id]?.status === "cancelled") throw new Error("项目已结束，忽略迟到的供应商结果");
      return taskPatch(taskFor(data, id), patch, log);
    });
  }

  async #waitForProvider(job, milliseconds = this.config.compilePollMs) {
    await this.#setJob(job.id, { status: "waiting_provider", nextRunAt: Date.now() + milliseconds, leaseUntil: undefined });
  }

  async #retry(job, error) {
    const attempt = (job.attempts || 0) + 1;
    const backoff = Math.min(90_000, 2_000 * 2 ** Math.min(attempt, 5));
    await this.store.mutate((data) => {
      const current = data.jobs[job.id];
      if (!current || current.status === "cancelled") return;
      current.status = current.providerRequestId ? "waiting_provider" : "queued";
      current.attempts = attempt;
      current.nextRunAt = Date.now() + backoff;
      current.updatedAt = now();
      const task = taskFor(data, job.taskId);
      taskPatch(task, { stage: job.type === "compile" ? "analyzing" : "generating", currentItem: `网络波动，${Math.ceil(backoff / 1000)} 秒后自动恢复` }, { level: "warning", message: `可恢复服务异常：${clip(error.message, 360)}；将继续使用原请求编号，不会重复提交。` });
    });
  }

  async #attention(job, message) {
    await this.store.mutate((data) => {
      const current = data.jobs[job.id];
      if (!current || current.status === "cancelled") return;
      current.status = "paused";
      current.updatedAt = now();
      const task = taskFor(data, job.taskId);
      taskPatch(task, { stage: "attention", error: message, currentItem: "等待处理", progress: Math.max(task.progress, 50) }, { level: "warning", message });
      const project = projectFor(data, job.projectId);
      project.status = "attention";
      project.updatedAt = now();
    });
  }

  async #fail(job, message) {
    await this.store.mutate((data) => {
      const current = data.jobs[job.id];
      if (!current || current.status === "cancelled") return;
      current.status = "failed";
      releaseUnsubmitted(data, job.id);
      current.error = clip(message, 1600);
      current.updatedAt = now();
      const task = taskFor(data, job.taskId);
      taskPatch(task, { stage: "failed", error: clip(message, 1600), currentItem: "执行失败", finishedAt: now() }, { level: "error", message: `云端任务失败：${clip(message, 900)}` });
      const project = projectFor(data, job.projectId);
      project.status = "attention";
      project.updatedAt = now();
    });
  }

  async #readProjectAsset(file) {
    const asset = await this.store.readAsset(file.path);
    if (!asset) throw new AttentionError(`素材“${file.name}”不在云端存储中；请重新上传后再试。`);
    return asset;
  }

  async #prepareCompileInput(project, sceneOverview = false) {
    const imageItems = [];
    const appendImages = async (files, label) => {
      for (const [index, file] of files.entries()) {
        const { buffer } = await this.#readProjectAsset(file);
        const kind = label === "人物身份图" ? "identity" : label === "商品真值图" ? "product" : "scene";
        const entry = referenceEntries(project).filter(entry => entry.kind === kind)[index];
        try { imageItems.push({ label: entry?.label || `${label} ${index + 1}`, dataUrl: await imageDataUri(buffer, kind === "product" || kind === "identity") }); }
        catch (error) {
          if (error instanceof AttentionError) throw new AttentionError(`“${file.name}”：${error.message}`);
          throw new AttentionError(`“${file.name}”无法作为图片读取；请上传 JPG、PNG 或 WebP。`);
        }
      }
    };
    if (project.assets.modelImages.length + project.assets.productImages.length + (project.sceneMode === "custom" ? project.assets.sceneImages.length : 0) > 30) throw new AttentionError("分析参考图超过 30 张，请精简后编译；不会静默丢弃商品细节图。");
    await appendImages(project.assets.modelImages, "人物身份图");
    await appendImages(project.assets.productImages, "商品真值图");
    if (project.sceneMode === "custom" && !sceneOverview) await appendImages(project.assets.sceneImages, "场景真值图");

    let reusableTemplate;
    if (project.assets.reusableTemplate) {
      const { buffer } = await this.#readProjectAsset(project.assets.reusableTemplate);
      const source = buffer.toString("utf8").slice(0, 100_000);
      try { reusableTemplate = JSON.parse(source); }
      catch { reusableTemplate = { raw_template: source }; }
    }

    let videoInfo;
    if (project.assets.video && (!reusableTemplate || sceneOverview)) {
      const { buffer } = await this.#readProjectAsset(project.assets.video);
      const extracted = await videoFrames(buffer, "参考视频", this.config, selectVideoRoute(this.config, project.videoSelection).model, sceneOverview);
      imageItems.push(...extracted.frames);
      videoInfo = extracted.info;
    }
    const customInputText = project.assets.customInput ? (await this.#readProjectAsset(project.assets.customInput)).buffer.toString("utf8").slice(0, 12000) : "";
    return { imageItems, reusableTemplate, videoInfo, customInputText };
  }

  async #prepareVisualReview(job, project, target, unit) {
    const entries = reviewReferences(project, target, unit);
    if (entries.length > 30) throw new Error("人物和商品原图超过单次核对上限");
    const detailBudgets = target.kind === "frame" ? detailReferenceBudgets(entries) : new Map();
    const prepared = await Promise.all(entries.map(entry => this.prepareVisualImage(async () => {
      const { buffer } = await this.#readProjectAsset(entry.file);
      const overview = { label: entry.label.replace("同组多图属于同一人", "需检查同组多图是否为同一人"), dataUrl: await imageDataUri(buffer, true, 5 * 1024 * 1024) };
      const details = target.kind === "frame" ? await prepareDetailViews(buffer, { id: `IMAGE_${entry.index}`, kind: "reference", imageIndex: entry.index }, detailBudgets.get(entry.index) || 0) : { images: [], views: [] };
      return { images: [overview, ...details.images], views: details.views };
    })));
    const images = prepared.flatMap(p => p.images), views = prepared.flatMap(p => p.views);
    if (target.kind === "source") return { images, samples: [] };
    const asset = await this.store.readAsset(target.path);
    if (!asset || asset.metadata.projectId !== job.projectId) throw new Error("待核对画面不属于当前项目");
    if (target.kind === "frame") {
      const aspect = job.payload.resolvedVideoAspectRatio || project.resolvedVideoAspectRatio || (project.videoAspectRatio === "auto" ? "9:16" : project.videoAspectRatio);
      await checkedKeyframe(asset.buffer, job.payload.videoRoute?.model.inputMode === "first-frame" ? aspect : undefined, job.payload.videoRoute?.model.minImageSide || 240);
      const sample = { id: `${unit.id}:frame`, label: `SAMPLE ${unit.id}:frame · 待核对首帧（只用于 sample_ids，不是 IMAGE_N 原图）`, seconds: 0 };
      const frame = await this.prepareVisualImage(async () => ({ overview: { label: sample.label, dataUrl: await imageDataUri(asset.buffer, true) }, details: await prepareDetailViews(asset.buffer, { id: `SAMPLE_${sample.id}`, kind: "sample", sampleId: sample.id }, detailBudgets.size > 0) }));
      const allImages = [...images, frame.overview, ...frame.details.images];
      if (allImages.reduce((sum, image) => sum + image.dataUrl.length, 0) > 48 * 1024 * 1024) throw new Error("本帧视觉证据超过安全请求大小，未压低商品细节来跳过审核");
      return { images: allImages, samples: [sample], views: [...views, ...frame.details.views], originalImages: entries.length };
    }
    const directory = await mkdtemp(path.join(tmpdir(), "xuti-review-"));
    try {
      const input = path.join(directory, "video.mp4"); await writeFile(input, asset.buffer);
      const info = await inspectVideo(input);
      if (!info.duration || Math.abs(info.duration - unit.duration_s) > Math.max(1, unit.duration_s * .1)) throw new Error("成片时长与计划不符，无法完成核对");
      const coarse = reviewSampleTimes(unit).slice(target.batch * 12, (target.batch + 1) * 12);
      const times = target.dense ? [...coarse, ...coarse.slice(1).map((t, i) => (t + coarse[i]) / 2)].sort((a, b) => a - b) : coarse;
      const samples = [];
      for (const [i, at] of times.entries()) {
        const seconds = Number(Math.min(at, info.duration - .04).toFixed(3));
        const output = path.join(directory, `${i}.jpg`);
        await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-ss", String(seconds), "-i", input, "-frames:v", "1", "-vf", "scale='min(1600,iw)':-2", output], 50_000);
        const sample = { id: `${unit.id}:${seconds.toFixed(3)}`, seconds, label: `${unit.id} 视频画面 ${seconds.toFixed(3)} 秒（待核对结果）` };
        samples.push(sample); images.push({ label: `${sample.id} · ${sample.label}`, dataUrl: await imageDataUri(await readFile(output), true) });
      }
      return { images, samples };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async #createCompileResponse(provider, instructions, imageItems, maxOutputTokens = this.config.compileMaxOutputTokens) {
    const headers = { "Authorization": `Bearer ${provider.apiKey}`, "Content-Type": "application/json" };
    if (provider.id === "openrouter") {
      if (this.config.openrouterSiteUrl) headers["HTTP-Referer"] = this.config.openrouterSiteUrl;
      if (this.config.openrouterAppTitle) headers["X-OpenRouter-Title"] = this.config.openrouterAppTitle;
    }
    const { pathname, body } = compilerRequest(provider, { instructions, imageItems, maxOutputTokens });
    if (provider.apiFormat !== "chat") Object.assign(body, compileRequestOptions(provider));
    return jsonResponse(`${provider.baseUrl}${pathname}`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(this.config.compileRequestTimeoutMs),
      body: JSON.stringify(body),
    });
  }

  async #prepareXhaiCompileImages(job, provider, imageItems) {
    if (provider.id !== "xhai") return imageItems;
    const fingerprint = createHash("sha256").update(imageItems.map(item => item.dataUrl).join("\n")).digest("hex");
    const cached = job.payload?.xhaiCompileUploads;
    const urls = cached?.fingerprint === fingerprint
      ? cached.urls
      : await uploadXhaiImages(provider.baseUrl, provider.apiKey, imageItems.map(item => item.dataUrl));
    if (!cached || cached.fingerprint !== fingerprint) await this.store.mutate(data => {
      const current = data.jobs[job.id];
      if (current?.status === "running") current.payload.xhaiCompileUploads = { fingerprint, urls };
    });
    return imageItems.map((item, index) => ({ ...item, dataUrl: urls[index] }));
  }

  async #getCompileResponse(provider, id) {
    if (!provider.supportsResponsePolling) {
      throw new AttentionError(`${provider.label} 不支持按响应编号轮询；该任务不会自动重新提交，以避免重复计费。`);
    }
    const headers = { "Authorization": `Bearer ${provider.apiKey}` };
    if (provider.id === "openrouter") {
      if (this.config.openrouterSiteUrl) headers["HTTP-Referer"] = this.config.openrouterSiteUrl;
      if (this.config.openrouterAppTitle) headers["X-OpenRouter-Title"] = this.config.openrouterAppTitle;
    }
    return jsonResponse(`${provider.baseUrl}/responses/${encodeURIComponent(id)}`, { headers });
  }

  async #runCompile(job) {
    if (job.payload?.sceneRecommendation) {
      assertCompilerAccess(this.store.data, job.ownerId, this.#requireCompileProvider(job.provider, job.payload?.compiler, job.ownerId));
      return this.scenes.run(job);
    }
    const state = this.store.getAppState();
    const currentProject = state.projects.find((item) => item.id === job.projectId);
    if (!currentProject) throw new AttentionError("项目已删除，任务不能继续执行。");
    const project = job.payload?.inputProject || currentProject;
    if (job.payload?.compileContract) {
      await this.#updateTask(job.taskId, { stage: "extracting", progress: 78, currentItem: "正在保存已收到的 B/C JSON" }, { level: "info", message: "已收到完整 B/C 回包，正在从持久检查点保存文件；不会再次调用编译供应商。" });
      await this.#finishCompile(job, project, job.payload.compileContract, job.payload?.sourceFingerprint || stableFingerprint(project));
      return;
    }
    if (isTerminalCompileReceipt(job.payload?.compileReceipt)) {
      await this.#finishReceivedCompile(job, project);
      return;
    }
    const compiler = this.#requireCompileProvider(job.provider, job.payload?.compiler, job.ownerId);
    assertCompilerAccess(this.store.data, job.ownerId, compiler);
    if (job.providerRequestId) {
      await this.#updateTask(job.taskId, { stage: "analyzing", progress: 52, currentItem: `正在获取 ${compiler.label} 后台分析结果` });
      const response = await this.#getCompileResponse(compiler, job.providerRequestId);
      if (["queued", "in_progress"].includes(response.status)) {
        await this.#waitForProvider(job);
        return;
      }
      await this.#receiveCompile(job, project, compiler, response);
      return;
    }

    await this.#updateTask(job.taskId, { stage: "preflight", progress: 8, currentItem: "检查项目隔离、素材与预算" }, { level: "info", message: `云端预检通过后才会提交 ${compiler.label}；旧项目素材不会被读取。` });
    this.#assertCompileAssets(project);
    const fingerprint = job.payload?.sourceFingerprint || stableFingerprint(project);

    // Exact same inputs are served from a prior C artifact instead of creating
    // another model request. This is intentionally limited to identical asset
    // ids and measurements so a changed person or product never reuses stale C.
    const cached = await this.store.mutate((data) => Object.values(data.jobs).find((item) => item.id !== job.id && item.projectId === job.projectId && item.type === "compile" && item.status === "completed" && item.payload?.sourceFingerprint === fingerprint && item.payload?.artifacts?.kernelContract?.sha256 === COMPILE_KERNEL.sha256 && JSON.stringify(item.payload.compiler) === JSON.stringify(compilerSnapshot(compiler))));
    if (cached?.payload?.artifacts) {
      await this.#reuseCompile(job, project, cached.payload.artifacts, fingerprint, compiler.label);
      return;
    }

    await this.#updateTask(job.taskId, { stage: "uploading", progress: 22, currentItem: "正在压缩并整理项目专属分析素材" }, { level: "info", message: `仅向 ${compiler.label} 发送压缩后的必要人物、商品、场景和视频关键帧；原文件保留在私有云端存储。` });
    const prepared = await this.#prepareCompileInput(project);
    if (!prepared.imageItems.length) throw new AttentionError("没有可提交的分析图片；请重新上传人物和商品图。 ");
    const compileImages = await this.#prepareXhaiCompileImages(job, compiler, prepared.imageItems);
    const ratio = project.videoAspectRatio === "auto" ? resolveAspect(prepared.videoInfo?.width, prepared.videoInfo?.height) : project.videoAspectRatio;
    const sourceDurationSeconds = prepared.videoInfo?.duration ?? prepared.reusableTemplate?.source_duration_s ?? prepared.reusableTemplate?.target_duration_s;
    if (sourceDurationSeconds != null && (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds < 1 || Math.floor(sourceDurationSeconds) > this.config.maxVideoSecondsPerProject)) throw new AttentionError("参考视频时长无效或超过项目预算上限，未提交编译。");
    const selected = selectedCast(project);
    const separateOutfits = project.cast && selected.roles.some(r => selected.products.filter(p => p.roleId === r.id).length > 1);
    const videoRoute = selectVideoRoute(this.config, project.videoSelection);
    const videoModel = videoRoute.model;
    const supported = supportedVideoDurations(this.config, videoModel);
    const planned = sourceDurationSeconds == null ? [] : planVideoDurations(sourceDurationSeconds, this.config, videoModel);
    const durationInstruction = sourceDurationSeconds == null ? "" : `参考视频实测时长 ${sourceDurationSeconds} 秒。输出总时长必须为 ${Math.floor(sourceDurationSeconds)} 秒，不得延长。先按原片实际切镜输出 units 分镜（允许小数秒），保留每次景别、机位、姿态与道具交互变化，不要按请求数概括镜头。${separateOutfits ? "同一角色换商品必须分开分镜，不可混穿。" : `服务端随后按模型自动打包为 ${planned.length} 次请求，时长依次为 ${planned.join("、")} 秒；一次请求仍可包含多个明确分镜。`}分段之间延续人物、商品、场景与动作，不要重播前段内容。`;
    const instructions = `${buildCompileInstructions({ project: { ...project, resolvedVideoAspectRatio: ratio }, reusableTemplate: prepared.reusableTemplate, videoFrameCount: prepared.imageItems.filter((item) => item.label.includes("关键帧")).length })}\n\n视频模型：${videoModel.label}，每次生成请求支持 ${[...supported].reverse().join("、")} 秒（不是原片分镜时长限制）。最多 ${this.config.maxGenerationSegments} 次生成请求，总时长不超过 ${this.config.maxVideoSecondsPerProject} 秒。\n${durationInstruction}\n${prepared.customInputText ? `用户补充文件（角色与商品归属仍以上述当前项目绑定为准）：\n${prepared.customInputText}` : ""}\n最终执行边界：人脸只取绑定角色原图，商品设计只取绑定商品原图；严禁融合脸和商品改款，逐镜保留参考片的姿态、景别、机位、动作与切镜，不得因一次生成就改成一镜到底。`;
    const requestMessage = compiler.supportsResponsePolling
      ? `已创建可恢复的 ${compiler.label} 后台请求；页面关闭或网络中断不会取消云端任务。`
      : `正在等待 ${compiler.label} 的完整 B/C 回包；浏览器关闭不会中断云端 worker。若服务在回包前重启，任务将停在安全检查点而不会自动重复扣费。`;
    await this.#updateTask(job.taskId, { stage: "analyzing", progress: 38, currentItem: `${compiler.label} 正在拆解并生成 B/C JSON` }, { level: "info", message: requestMessage });

    const requestPayload = { ...job.payload, ...(compiler.id === "xhai" ? { xhaiCompileUploads: { fingerprint: createHash("sha256").update(prepared.imageItems.map(item => item.dataUrl).join("\n")).digest("hex"), urls: compileImages.map(item => item.dataUrl) } } : {}), kernelContract: clone(COMPILE_KERNEL), sourceFingerprint: fingerprint, resolvedVideoAspectRatio: ratio, sourceDurationSeconds, videoModel, videoProfile: { provider: videoRoute.id, model: videoModel.model, resolution: videoRoute.resolution, input_mode: videoModel.inputMode || "references", execution_surface: "api" } };
    if (job.payload?.compileSubmission?.state === "inflight") throw new AttentionError("上次编译提交结果不明，请先核实供应商账务，任务不会自动重提");
    const canSubmit = await this.store.mutate(data => {
      const current = data.jobs[job.id];
      if (current.status !== "running") return false;
      assertCompilerAccess(data, job.ownerId, compiler);
      markSubmitted(data, `${job.id}:compile`);
      Object.assign(taskFor(data, job.taskId), { kernelVersion: COMPILE_KERNEL.version, kernelSha256: COMPILE_KERNEL.sha256 });
      Object.assign(current, { provider: compiler.id, payload: { ...requestPayload, compileSubmission: { state: "inflight", startedAt: now() } } });
      return true;
    });
    if (!canSubmit) return;
    if (compiler.supportsResponsePolling) {
      if (this.store.getJob(job.id)?.status === "cancelled") return;
      const response = await this.#createCompileResponse(compiler, instructions, compileImages);
      if (isTerminalCompileReceipt(compileReceipt(response))) {
        await this.#receiveCompile({ ...job, payload: requestPayload }, project, compiler, response);
        return;
      }
      if (!response.id) throw new ProviderError(`${compiler.label} 未返回响应编号`, 502, response);
      await this.#setJob(job.id, { status: "waiting_provider", provider: compiler.id, providerRequestId: response.id, nextRunAt: Date.now() + this.config.compilePollMs, payload: requestPayload });
      return;
    }

    // Persist an in-flight marker before the network call. If Railway restarts
    // while OpenRouter is working, CloudStore pauses this task rather than
    // submitting the same paid request a second time.
    const inFlight = await this.#setJob(job.id, {
      provider: compiler.id,
      payload: { ...requestPayload, compileSubmission: { provider: compiler.id, mode: "synchronous_response", state: "inflight", startedAt: now() } },
    });
    if (this.store.getJob(job.id)?.status === "cancelled") return;
    let response;
    try {
      response = await this.#createCompileResponse(compiler, instructions, compileImages);
    } catch (error) {
      if (isTransient(error)) {
        throw new AttentionError(`${compiler.label} 的请求结果未能确认。为避免重复计费，任务已暂停且不能直接继续；须由超级管理员先核实供应商账务，再重新建立编译任务。`);
      }
      throw error;
    }
    await this.#receiveCompile(inFlight, project, compiler, response);
  }

  async #receiveCompile(job, project, compiler, response) {
    const receipt = compileReceipt(response, this.config.compileMaxOutputTokens);
    const checkpoint = await this.#setJob(job.id, {
      provider: compiler.id,
      payload: { ...job.payload, compileReceipt: receipt, compileSubmission: { ...job.payload?.compileSubmission, state: isTerminalCompileReceipt(receipt) ? "received" : "inflight" } },
    });
    if (!isTerminalCompileReceipt(receipt)) throw new AttentionError(`${compiler.label} 返回 ${receipt.status || "未知状态"}，尚不能确认最终结果；请求编号和状态已保存，未自动重提。`);
    await this.#finishReceivedCompile(checkpoint, project);
  }

  async #finishReceivedCompile(job, project) {
    const receipt = job.payload.compileReceipt;
    let issue = compileReceiptIssue(receipt), contract;
    if (!issue) {
      try { contract = normalizeCompileContract(parseJsonOutput(receipt.outputText), this.config, job.payload?.sourceDurationSeconds, project, job.payload?.videoModel); }
      catch (error) { issue = error.message; }
    }
    if (issue) {
      // Terminal response != unknown submission. Refund the user's platform
      // hold without asserting that the upstream vendor waived its own fees.
      await this.store.mutate(data => {
        const current = data.jobs[job.id];
        if (!current || current.status === "cancelled") return;
        const message = `${issue.replace(/[。；;\s]+$/, "")}。本次拆解已停止，未自动重提或启动视频。`;
        settle(data, `${job.id}:compile`, false, "未交付有效 B/C；原请求与供应商用量保留供核实");
        current.status = "failed";
        current.error = message;
        current.updatedAt = now();
        current.leaseUntil = undefined;
        current.payload.compileSubmission = { ...current.payload.compileSubmission, state: "failed", completedAt: now() };
        taskPatch(taskFor(data, job.taskId), { stage: "failed", error: message, currentItem: "拆解未完成，请查看错误原因", finishedAt: now() }, { level: "error", message });
        const currentProject = projectFor(data, job.projectId);
        currentProject.status = "ready";
        currentProject.updatedAt = now();
      });
      return;
    }
    const checkpoint = await this.store.mutate(data => {
      const current = data.jobs[job.id];
      if (!current || current.status === "cancelled") return null;
      // Charge and durable output checkpoint commit together. A crash after
      // this write resumes local file creation, never another paid POST.
      current.payload = { ...current.payload, compileContract: contract, compileSubmission: { ...current.payload.compileSubmission, state: "completed", completedAt: now() } };
      settle(data, `${job.id}:compile`, true, "完整 B/C JSON 已校验并保存检查点");
      return current;
    });
    if (checkpoint && checkpoint.status !== "paused") await this.#finishCompile(checkpoint, project, contract, job.payload?.sourceFingerprint || stableFingerprint(project));
  }

  async #reuseCompile(job, project, artifacts, fingerprint, compilerLabel) {
    await this.store.mutate((data) => {
      if (data.jobs[job.id]?.status === "cancelled") return;
      releaseUnsubmitted(data, job.id);
      const task = taskFor(data, job.taskId);
      taskPatch(task, { stage: "completed", progress: 100, currentItem: "已命中 C 模板缓存", outputFiles: clone(artifacts.outputFiles), finishedAt: now() }, { level: "success", message: `相同素材和输入已命中项目级 C 缓存，未再次调用 ${compilerLabel}。` });
      const current = data.jobs[job.id];
      current.status = "completed";
      current.payload = { ...current.payload, sourceFingerprint: fingerprint, artifacts: clone(artifacts) };
      const currentProject = projectFor(data, project.id);
      const selectedProject = { ...currentProject, videoSelection: project.videoSelection, imageSelection: project.imageSelection };
      const ready = !current.payload?.compileOnly && this.#videoReady(selectedProject);
      currentProject.status = ready ? "generating" : "compiled";
      currentProject.updatedAt = now();
      if (ready) {
        try { this.#enqueueGeneration(data, selectedProject, artifacts, this.#ensureRunId(data, current)); }
        catch (error) {
          currentProject.status = "compiled";
          task.logs.push({ at: now(), level: "warning", message: `拆解已保存；视频未自动开始：${error.message}。处理后可点击“开始视频生成”。` });
        }
      }
    });
  }

  async #finishCompile(job, project, contract, fingerprint) {
    const truthRevision = productTruthRevision(project, contract.productLock);
    // Keep the revision actually submitted, even when a response is recovered
    // after deployment. Old receipts must not be relabelled with the new kernel.
    const taskKernel = this.store.getTasks().find(t => t.id === job.taskId);
    const kernelContract = job.payload?.kernelContract || { version: taskKernel?.kernelVersion || "legacy", sha256: taskKernel?.kernelSha256 || "legacy" };
    const revision = compileRevision(fingerprint, kernelContract.sha256);
    const fallbackRoute = job.payload?.videoProfile ? undefined : selectVideoRoute(this.config, project.videoSelection);
    const videoProfile = job.payload?.videoProfile || { provider: fallbackRoute.id, model: fallbackRoute.model.model, resolution: fallbackRoute.resolution, input_mode: fallbackRoute.model.inputMode || "references", execution_surface: "api" };
    if (contract.target_duration_s) await this.#updateTask(job.taskId, {}, { level: "info", message: `原片 ${contract.source_duration_s} 秒；生成计划 ${contract.units.length} 段，共 ${contract.target_duration_s} 秒，不额外延长。` });
    await this.#updateTask(job.taskId, { stage: "extracting", progress: 78, currentItem: "正在保存 B/C JSON 文件" }, { level: "info", message: "已取得完整 JSON；正在独立保存 B01…BN 与 C.json，避免浏览器逐字输出造成识别失败。" });
    const bFiles = [];
    for (const [index, unit] of contract.units.entries()) {
      if (this.store.getJob(job.id)?.status === "cancelled") return;
      const fileName = `B${String(index + 1).padStart(2, "0")}_${unit.id}.json`;
      const body = {
        schema: "XUTI_B_V1", file_type: "B", file_name: fileName, packed_unit_id: unit.id,
        compile_revision: revision, kernel: kernelContract,
        submission: { index: index + 1, total: contract.units.length, unit_id: unit.id, prompt_count: 1 },
        ...(project.cast ? { cast_plan: castScriptPlan(project), character_ids: unit.character_ids, product_ids: unit.product_ids } : {}),
        native_request: { ...videoProfile, requested_duration_s: unit.duration_s, packed_unit: unit.id, execution_stage: videoProfile.input_mode === "first-frame" ? "keyframe_review_required" : "reference_only_plan" },
        reference_asset_plan: { identity: "当前项目人物图；仅身份/发型/体态", product: "当前项目商品图；唯一商品设计真值", scene: sceneInstructions(project) || "当前项目场景图或参考视频场景", forbidden: ["旧项目素材", "参考视频人物身份", "人物图原服装", "参考视频原服装与首饰"] },
        consistency_version: CONSISTENCY_VERSION, product_truth_revision: truthRevision, identity_lock: identityLock(project, unit), shot_plan: unit.shot_plan,
        camera: unit.camera, action: unit.action, scene: unit.scene, grok_copy_ready_prompt: lockedVideoPrompt(project, unit, undefined, contract.productLock, "references", false), keyframe_prompt: unit.keyframe_prompt, product_lock: contract.productLock, negative_constraints: unit.negative_constraints,
        truth: contract.truth, execution_capabilities: KERNEL_CAPABILITIES,
      };
      bFiles.push(await this.store.putTextAsset({ name: fileName, text: JSON.stringify(body, null, 2), projectId: project.id }));
    }
    const cBody = {
      source_duration_s: contract.source_duration_s, target_duration_s: contract.target_duration_s,
      ...(project.sceneMode === "keywords" ? { scene_selection: findScene(project.sceneSelection?.sceneId) } : {}),
      schema: "XUTI_C_V1", file_type: "C", compile_revision: revision, source_fingerprint: fingerprint,
      kernel: kernelContract, execution_capabilities: KERNEL_CAPABILITIES,
      platform_profile: videoProfile,
      input_revision_snapshot: { fingerprint, kernel_sha256: kernelContract.sha256, compile_revision: revision },
      output_contract: { b_count: bFiles.length, prompt_count: contract.units.length, c_count: 1, unit_to_b: Object.fromEntries(contract.units.map((unit, i) => [unit.id, bFiles[i].name])) },
      ...(project.cast ? { cast_plan: castScriptPlan(project) } : {}),
      source_asset_policy: "项目素材副本在生成期间临时使用，视频完成后清理；独立保存的个人资产库不受影响。C 模板继续保存派生脚本、真值和时间线。",
      consistency_version: CONSISTENCY_VERSION, product_truth_revision: truthRevision, identity_lock: identityLock(project),
      truth: contract.truth, qa: contract.qa, timeline: contract.timeline, product_lock: contract.productLock,
      packed_units: contract.units.map((unit, index) => ({ id: unit.id, b_file: bFiles[index].path, duration_s: unit.duration_s, shot_plan: unit.shot_plan, camera: unit.camera, action: unit.action, scene: unit.scene, ...(project.cast ? { character_ids: unit.character_ids, product_ids: unit.product_ids } : {}) })),
      reuse_contract: "仅复用时间线与动作骨架；人物、商品图、实测或自定义参数变化需生成新的编译修订，旧 Prompt 不可用于新输入。仅在用户明确发起后编译；不得从历史项目或参考视频迁移人物服装、首饰、背景文字或商品设计。",
    };
    const cFile = await this.store.putTextAsset({ name: "C_可复用当前实例.json", text: JSON.stringify(cBody, null, 2), projectId: project.id });
    const outputFiles = [...bFiles, cFile];
    const artifacts = { kernelContract, compileRevision: revision, consistencyVersion: CONSISTENCY_VERSION, productTruthRevision: truthRevision, identityLock: identityLock(project), outputFiles, bFiles, cFile, units: contract.units, productLock: contract.productLock, truth: contract.truth, sourceFingerprint: fingerprint, referenceSnapshot: referenceSnapshot({ ...project, resolvedVideoAspectRatio: job.payload?.resolvedVideoAspectRatio || project.resolvedVideoAspectRatio }) };
    await this.store.mutate((data) => {
      if (data.jobs[job.id]?.status === "cancelled") return;
      const task = taskFor(data, job.taskId);
      taskPatch(task, { stage: "completed", progress: 100, currentItem: "B/C JSON 已保存", outputFiles, finishedAt: now() }, { level: "success", message: `已保存 ${bFiles.length} 个 B 文件与 1 个 C 文件；文件名和 schema 可被稳定识别。` });
      const current = data.jobs[job.id];
      current.status = "completed";
      current.providerRequestId = undefined;
      const { compileContract, compileSubmission, ...payload } = current.payload || {};
      current.payload = { ...payload, sourceFingerprint: fingerprint, artifacts };
      const currentProject = projectFor(data, project.id);
      if (job.payload?.resolvedVideoAspectRatio && currentProject.videoAspectRatio === "auto") currentProject.resolvedVideoAspectRatio = job.payload.resolvedVideoAspectRatio;
      const selectedProject = { ...currentProject, videoSelection: project.videoSelection, imageSelection: project.imageSelection };
      const ready = !current.payload?.compileOnly && this.#videoReady(selectedProject);
      currentProject.status = ready ? "generating" : "compiled";
      currentProject.updatedAt = now();
      if (ready) {
        try { this.#enqueueGeneration(data, selectedProject, artifacts, this.#ensureRunId(data, current)); }
        catch (error) {
          currentProject.status = "compiled";
          task.logs.push({ at: now(), level: "warning", message: `拆解已保存；视频未自动开始：${error.message}。处理后可点击“开始视频生成”。` });
        }
      }
    });
  }

  #videoReady(project) {
    try { const route = selectVideoRoute(this.config, project.videoSelection); assertVideoAccess(this.store.data, project.ownerId, route); return Boolean(videoKey(this.config, route)); }
    catch { return false; }
  }

  async #referenceDataUrls(project, route) {
    const source = [
      ...project.assets.modelImages,
      ...project.assets.productImages,
      ...(project.sceneMode === "custom" ? project.assets.sceneImages : []),
    ];
    if (source.length > route.model.maxImages) throw new AttentionError(`${route.model.label} 最多接受 ${route.model.maxImages} 张参考图，当前有 ${source.length} 张；请调整素材或更换模型。`);
    const urls = [];
    for (const item of source) {
      const { buffer } = await this.#readProjectAsset(item);
      try {
        if (route?.model.minImageSide) {
          const info = await sharp(buffer).metadata();
          if (Math.min(info.width, info.height) < route.model.minImageSide) throw new Error("参考图尺寸不足");
        }
        const uri = await imageDataUri(buffer, [...project.assets.modelImages, ...project.assets.productImages].some(f => f.path === item.path), 5 * 1024 * 1024, route?.model.minImageSide || 0);
        urls.push(uri);
      }
      catch (error) {
        if (error instanceof AttentionError) throw new AttentionError(`“${item.name}”：${error.message}`);
        throw new AttentionError(`“${item.name}”不符合参考图要求；请检查格式、尺寸及压缩后 5MB 上限。`);
      }
    }
    if (urls.length < 2) throw new AttentionError("视频生成至少需要当前项目的人物和商品参考图。 ");
    if (urls.reduce((sum, uri) => sum + Buffer.byteLength(uri.split(",")[1], "base64"), 0) > 30 * 1024 * 1024) throw new AttentionError("本次参考图压缩后总大小超过 30MB，请减少素材后重试。");
    return urls;
  }

  async #downloadVideo(url) {
    const response = await fetch(url, { signal: jobRequestSignal(120_000) });
    if (!response.ok) throw new ProviderError(`下载视频失败（HTTP ${response.status}）`, response.status);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > this.config.maxDownloadedVideoBytes) throw new AttentionError("供应商返回的视频超出云端单文件安全上限；请降低视频时长后重试。 ");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > this.config.maxDownloadedVideoBytes) throw new AttentionError("供应商返回的视频超出云端单文件安全上限；请降低视频时长后重试。 ");
    return buffer;
  }

  async #runGeneration(job) {
    const state = this.store.getAppState();
    const project = state.projects.find((item) => item.id === job.projectId);
    if (!project) throw new AttentionError("项目已删除，任务不能继续执行。");
    const artifacts = job.payload?.artifacts;
    const units = artifacts?.units || [];
    const index = Number(job.payload?.index || 0);
    if (!units.length) throw new AttentionError("找不到 B/C 编译产物；请先重新完成编译。 ");
    if (index >= units.length) {
      if (!await this.enhancement.advance(job)) return;
      if (this.visual.enabled(job)) {
        // The default delivery path ends here: pre-generation and keyframe
        // checks are sufficient to proceed, but are NOT a video quality claim.
        if (job.payload.visualReview.reviewVideo === true) {
          const refs = await generationProject(this.store, project, artifacts);
          if (!await this.visual.output(job, refs)) return;
        }
      }
      await this.#finishGeneration(job, project);
      return;
    }
    const unit = units[index];
    // Legacy jobs with an existing request always belong to xAI, regardless of
    // later project edits. New jobs retain the complete non-secret route.
    const route = job.payload?.videoRoute || selectVideoRoute({ ...this.config, videoProviders: [], xaiBaseUrl: "https://api.x.ai/v1" });
    const label = route.model.label;
    if (job.payload?.videoSubmission?.state === "mismatch") throw new AttentionError(`星火 AIGC 任务 ${job.providerRequestId || "未知"} 的提交回执显示参数变化；已保留任务编号，须人工核对，不能自动归档或重复提交。`);
    if (job.providerRequestId) {
      await this.#updateTask(job.taskId, { stage: "generating", progress: Math.max(45, Math.round((index / units.length) * 88)), currentItem: `${unit.id} 正在由 ${label} 生成` });
      let response;
      try { response = await pollVideo(this.config, route, job.providerRequestId); }
      catch (error) {
        if ((job.attempts || 0) >= 10) throw new AttentionError(`查询 ${label} 连续失败；原请求编号已保留，可稍后继续查询。`);
        await this.#retry(job, error);
        return;
      }
      if (response.pending) {
        await this.#waitForProvider(job, this.config.xaiPollMs);
        return;
      }
      if (!response.url) {
        if (["failed", "cancelled", "expired"].includes(response.state)) await this.store.mutate(data => settle(data, `${job.id}:video:${unit.id}`, false, "供应商确认视频失败"));
        throw new AttentionError(`${label} 视频请求结束于 ${response.state || "未知状态"}；未自动重复提交。`);
      }
      await this.store.mutate(data => settle(data, `${job.id}:video:${unit.id}`, true, `${unit.id} 视频生成完成`));
      await this.#updateTask(job.taskId, { stage: "downloading", progress: Math.max(70, Math.round(((index + 0.5) / units.length) * 94)), currentItem: `${unit.id} 已完成，正在保存视频` });
      let video;
      try { video = await this.#downloadVideo(response.url); }
      catch (error) {
        if (this.store.getJob(job.id)?.status === "cancelled") return;
        if (error instanceof AttentionError) throw error;
        if ((job.attempts || 0) >= 10) throw new AttentionError("视频保存多次失败；已保留原生成请求，可稍后继续下载。");
        await this.#retry(job, error);
        return;
      }
      if (this.store.getJob(job.id)?.status === "cancelled") return;
      const asset = await this.store.putAsset({ buffer: video, name: `${route.model.id}_${unit.id}.mp4`, kind: "output", mime: "video/mp4", projectId: project.id, source: `${route.id}-video` });
      await this.store.mutate((data) => {
        const current = data.jobs[job.id];
        if (!current || current.status === "cancelled") return;
        const task = taskFor(data, job.taskId);
        task.outputFiles.push(asset);
        taskPatch(task, { stage: "generating", progress: Math.round(((index + 1) / units.length) * 96), currentItem: `${unit.id} 已保存，准备下一段` }, { level: "success", message: `${unit.id} 已下载到云端项目存储；不会与其他项目的素材混合。` });
        current.providerRequestId = undefined;
        current.attempts = 0;
        current.status = "queued";
        current.nextRunAt = Date.now();
        current.payload = { ...current.payload, videoSubmission: undefined, index: index + 1, checkpoints: { ...(current.payload?.checkpoints || {}), [unit.id]: { state: "downloaded", video: asset, cost: response.cost, providerId: route.id, model: route.model.model, completedAt: now() } } };
      });
      return;
    }

    if (!videoKey(this.config, route)) throw new AttentionError(`${route.label} 尚未配置 ${route.keyEnv}`);
    if (job.payload?.videoSubmission?.state === "inflight") throw new AttentionError("上次视频提交结果不确定；请先在原中转站核对请求记录，避免重复扣费。任务未自动重提。");
    if (!job.payload.keyframeGate?.frames.some(f => f.requestId || f.submission?.state === "inflight")) {
      if (!this.visual.enabled(job)) {
        // Upgrade old paused jobs only when they are explicitly continued.
        // Existing paid requests above always poll/download first.
        const settings = this.visual.settings(job.ownerId);
        await this.store.mutate(data => { const current = data.jobs[job.id]; if (current.status === "running") current.payload.visualReview = settings; });
        job = this.store.getJob(job.id);
        if (job.status !== "running") return;
      }
      const refs = await generationProject(this.store, project, artifacts);
      if (!await this.visual.source(job, refs)) return;
    }
    // Old jobs without a gate must still enter the historical review path.
    // Only newly created reference-only jobs carry an explicit bypass marker.
    const usesKeyframe = job.payload?.referenceOnly !== true;
    if (usesKeyframe) {
      try { if (!await this.keyframes.advance(job, project, route)) return; }
      catch (error) { throw new AttentionError(error.message); }
    }
    assertVideoAccess(this.store.data, project.ownerId, route);
    await this.#updateTask(job.taskId, { stage: "generating", progress: Math.max(10, Math.round((index / units.length) * 86)), currentItem: `正在准备 ${unit.id} · ${label}` }, { level: "info", message: `${unit.id} 使用 ${route.label} / ${label} / ${route.resolution}；仅引用当前项目人物、商品和场景。` });
    let referenceProject;
    try { referenceProject = await generationProject(this.store, project, artifacts); }
    catch (error) { throw new AttentionError(error.message); }
    // Fresh submissions are gated; already-paid image/video requests must still
    // be polled and downloaded under their original request IDs.
    if (!this.visual.sourcePassed(job, referenceProject)) throw new AttentionError("人物与商品原图尚未通过视觉扫描，未提交视频");
    const firstFrame = route.model.inputMode === "first-frame";
    const references = firstFrame ? [] : await this.#referenceDataUrls(referenceProject, route);
    const media = projectMediaReferences(this.store, referenceProject, route);
    for (const file of [...media.video, ...media.audio]) if (!await this.store.openAsset(file.path)) throw new AttentionError("生成参考文件已清理，请重新上传");
    const referenceVideos = media.video.map(f => referenceDownloadUrl(this.config, f.path, job.id));
    const referenceAudios = media.audio.map(f => referenceDownloadUrl(this.config, f.path, job.id));
    const approved = usesKeyframe ? job.payload.keyframeGate?.frames.find(f => f.unitId === unit.id) : undefined;
    const aspect = job.payload?.resolvedVideoAspectRatio || referenceProject.resolvedVideoAspectRatio || (referenceProject.videoAspectRatio === "auto" ? "9:16" : referenceProject.videoAspectRatio);
    if (usesKeyframe) {
      if (!approved?.asset) throw new AttentionError("请先确认本段首帧");
      const { buffer: keyframeBuffer, metadata: keyframeMetadata } = await this.#readProjectAsset(approved.asset);
      if (keyframeMetadata.projectId !== project.id || !["keyframe", "keyframe-upload"].includes(keyframeMetadata.source)) throw new AttentionError("已验收关键帧归属不匹配，视频已拦截");
      if (firstFrame) { try { await checkedKeyframe(keyframeBuffer, aspect, route.model.minImageSide || 240); } catch (error) { throw new AttentionError(error.message); } }
      references.push(await imageDataUri(keyframeBuffer, true, 5 * 1024 * 1024, route.model.minImageSide || 0));
    }
    if (references.reduce((sum, uri) => sum + Buffer.byteLength(uri.split(",")[1], "base64"), 0) > 30 * 1024 * 1024) throw new AttentionError("参考图压缩后合计超过 30MB，请精简素材");
    let prompts;
    try {
      // Check each segment's own complete prompt before any paid video request.
      // Resumed jobs derive the compact prompt from their saved compile inputs.
      const pending = units.slice(index);
      prompts = pending.map(planned => prepareVideoPrompt(referenceProject, planned, references.length, artifacts.productLock, route.model, usesKeyframe));
      for (const [i, planned] of pending.entries()) validateVideoInput(route, { prompt: prompts[i].prompt, roleBinding: prompts[i].roleBinding, referenceImages: references, referenceVideos, referenceAudios, duration: planned.duration_s, aspectRatio: aspect });
    } catch (error) { throw new AttentionError(error.message); }
    const prepared = prompts[0];
    const input = { prompt: prepared.prompt, roleBinding: prepared.roleBinding, referenceImages: references, referenceVideos, referenceAudios, duration: unit.duration_s, aspectRatio: aspect };
    if (prepared.format === "compact") {
      const record = { version: prepared.version, chars: prepared.chars, bytes: prepared.bytes, sourceChars: prepared.original.chars, imageBasedObservations: prepared.imageBasedObservations };
      if (JSON.stringify(job.payload.videoPromptPreparation?.[unit.id]) !== JSON.stringify(record)) {
        job.payload.videoPromptPreparation = { ...job.payload.videoPromptPreparation, [unit.id]: record };
        await this.store.mutate(data => {
          const current = data.jobs[job.id];
          if (current?.status !== "running") return;
          current.payload.videoPromptPreparation = job.payload.videoPromptPreparation;
          addLog(taskFor(data, job.taskId), "info", `${unit.id} 提示词已适配 ${label}：${prepared.original.chars} → ${prepared.chars} 字符 / ${prepared.bytes} 字节；保留全部分镜、时序与角色绑定${prepared.imageBasedObservations ? "，商品外观直接以原图为准" : ""}。`);
        });
      }
    }
    let xhaiReferenceUploads = job.payload?.xhaiReferenceUploads;
    let xhaiPreflight;
    if (route.protocol === "xhai") {
      const fingerprint = createHash("sha256").update(references.join("\n")).digest("hex");
      const cached = xhaiReferenceUploads?.[unit.id];
      input.referenceImages = cached?.fingerprint === fingerprint
        ? cached.urls
        : await uploadXhaiImages(route.baseUrl, videoKey(this.config, route), references);
      if (!cached || cached.fingerprint !== fingerprint) {
        xhaiReferenceUploads = { ...xhaiReferenceUploads, [unit.id]: { fingerprint, urls: input.referenceImages } };
        await this.store.mutate(data => { if (data.jobs[job.id]?.status === "running") data.jobs[job.id].payload.xhaiReferenceUploads = xhaiReferenceUploads; });
      }
      try { xhaiPreflight = await preflightXhaiVideo(this.config, route, input); }
      catch (error) { throw new AttentionError(`星火 AIGC 免费估价未能确认本次视频参数，视频未提交：${error.message}`); }
    }
    const submitted = { ...job.payload, ...(xhaiReferenceUploads ? { xhaiReferenceUploads } : {}), videoRoute: route, lastSubmittedUnit: unit.id, videoSubmission: { state: "inflight", startedAt: now() } };
    const canSubmit = await this.store.mutate(data => {
      const current = data.jobs[job.id];
      if (current.status !== "running") return false;
      assertVideoAccess(data, project.ownerId, route);
      if (usesKeyframe && (!hasKeyframeApproval(current.payload.keyframeGate, unit.id) || current.payload.keyframeGate.frames.find(f => f.unitId === unit.id).revision !== approved.revision || !this.visual.framePassed(current, referenceProject, current.payload.keyframeGate.frames.find(f => f.unitId === unit.id)))) throw new AttentionError("关键帧版本或细节核对发生变化，未提交视频");
      if (data.platform && !data.platform.requests[`${job.id}:video:${unit.id}`]) reserve(data, { id: `${job.id}:video:${unit.id}`, userId: project.ownerId, jobId: job.id, quote: operationPlan(data, project.ownerId, "video", route, { durations: [unit.duration_s], imageCount: references.length, aspectRatio: aspect, referenceVideoSeconds: media.referenceVideoSeconds, referenceAudioCount: media.referenceAudioCount }), label: `${label} · ${unit.id}` });
      markSubmitted(data, `${job.id}:video:${unit.id}`);
      Object.assign(current, { provider: route.id, payload: submitted, updatedAt: now() });
      return true;
    });
    if (!canSubmit) return;
    if (this.store.getJob(job.id)?.status === "cancelled") return;
    let requestId;
    try { requestId = await submitVideo(this.config, route, input, xhaiPreflight); }
    catch (error) {
      if (error instanceof XhaiVideoAdjustmentError) {
        await this.store.mutate(data => {
          const current = data.jobs[job.id];
          if (!current) return;
          current.providerRequestId = error.taskId;
          current.payload = { ...submitted, videoSubmission: { ...submitted.videoSubmission, state: "mismatch", issue: error.message } };
        });
        throw new AttentionError(error.message);
      }
      throw new AttentionError(`${route.label} 提交未能确认；已暂停，未自动重复扣费提交。请核对该站请求记录。`);
    }
    await this.store.mutate(data => {
      const current = data.jobs[job.id];
      current.provider = route.id;
      current.providerRequestId = requestId;
      current.payload = { ...submitted, videoSubmission: { ...submitted.videoSubmission, state: "submitted" } };
      if (current.status === "running") { current.status = "waiting_provider"; current.nextRunAt = Date.now() + this.config.xaiPollMs; }
    });
  }

  async #finishGeneration(job, project) {
    await this.store.mutate((data) => {
      releaseUnsubmitted(data, job.id);
      const task = taskFor(data, job.taskId);
      const current = data.jobs[job.id];
      if (!current || current.status === "cancelled") return;
      const projectNow = projectFor(data, project.id);
      if (this.visual.enabled(current)) current.payload.visualReview.completedKeys = this.visual.summary(current, { ...projectNow, ...current.payload.artifacts.referenceSnapshot }).records.map(r => r.key);
      taskPatch(task, { stage: "completed", progress: 100, currentItem: "所有视频均已保存到云端", finishedAt: now(), visualReviewRequired: false, outputReviewRequired: false }, { level: "success", message: "云端生成完成：视频和 C 模板已归档到本项目作品库。" });
      current.status = "completed";
      current.providerRequestId = undefined;
      projectNow.status = "completed";
      projectNow.updatedAt = now();
      const cFile = current.payload?.artifacts?.cFile;
      const videos = clone(task.outputFiles.filter((item) => item.mime?.startsWith("video/") || /\.mp4$/i.test(item.name)));
      const existing = data.appState.works.find((item) => item.projectId === project.id && !item.deletedAt);
      const work = {
        id: existing?.id || randomUUID(), projectId: project.id, title: project.name, createdAt: existing?.createdAt || now(), updatedAt: now(),
        cover: videos[0], videos, reusableTemplate: projectNow.saveReusableTemplate ? cFile : undefined, sourceProjectName: project.name,
        videoAspectRatio: projectNow.videoAspectRatio, resolvedVideoAspectRatio: projectNow.resolvedVideoAspectRatio,
      };
      if (existing) data.appState.works[data.appState.works.indexOf(existing)] = work;
      else data.appState.works.unshift(work);
    });

    const cleanup = await this.store.purgeCompletedProjectSources(project.id);
    if (!cleanup.completed) return;
    const deferredDetail = cleanup.deferred
      ? `另有 ${cleanup.deferred} 份素材正在被未完成项目使用，待其完成后再自动清理。`
      : "本项目原始上传素材已从 Railway 清理。";
    await this.store.mutate((data) => {
      if (data.jobs[job.id]?.status === "cancelled") return;
      const task = taskFor(data, job.taskId);
      taskPatch(task, {
        currentItem: cleanup.deferred ? "视频已归档 · 已移除本项目素材引用" : "视频已归档 · 原始上传素材已清理",
      }, {
        level: "success",
        message: `隐私清理完成：已删除 ${cleanup.deleted} 份云端原始上传素材，保留 B/C 与生成视频。${deferredDetail}`,
      });
    });
  }
}

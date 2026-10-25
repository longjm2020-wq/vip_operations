import { selectedCast } from "../shared/project-cast.mjs";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { jobRequestSignal } from "./job-request.mjs";
import { generationProject } from "./project-references.mjs";
import { KEYFRAME_REVIEW_VERSION, reviewChecks, frameApproved, createKeyframeGate, hasKeyframeApproval, keyframePrompt, referenceFiles } from "./keyframe-contract.mjs";
import { normalizeProductLocks, productTruthRevision } from "./product-truth.mjs";
import { keyframeImageRoute, keyframeImageBody, dryRunKeyframe, submitKeyframe, pollKeyframe, imageCatalog, imageModel, validateImageReferences, assertImageAccess } from "./image-provider.mjs";
import { videoKey, validateVideoInput, videoReferenceCount } from "./video-providers.mjs";
import { operationPlan, reserve, markSubmitted, settle } from "./access.mjs";
import { assertVideoAccess } from "./customer-view.mjs";
import { uploadXhaiImages } from "./xhai-files.mjs";

const now = () => new Date().toISOString();
const truthRevisionFor = (job, project) => productTruthRevision({ ...project, ...job.payload.artifacts.referenceSnapshot, id: project.id }, job.payload.artifacts.productLock);
function state(data, id) {
  const job = data.jobs[id];
  const task = data.appState.tasks.find(t => t.id === id);
  if (!job || !task || job.type !== "generate") throw new Error("未找到视频任务");
  return { job, task };
}
function message(task, stage, text) {
  Object.assign(task, { stage, currentItem: text, updatedAt: now(), error: undefined });
  task.logs.push({ at: now(), level: stage === "attention" ? "warning" : "info", message: text });
  task.logs = task.logs.slice(-160);
}
export async function checkedKeyframe(buffer, aspectRatio, minImageSide = 240) {
  if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error("关键帧须小于 20MB");
  const metadata = await sharp(buffer, { limitInputPixels: 40_000_000 }).metadata();
  if (!["jpeg", "png", "webp"].includes(metadata.format) || (metadata.pages || 1) > 1 || Math.min(metadata.width, metadata.height) < minImageSide) throw new Error(`请使用单张 JPG、PNG 或 WebP，短边至少 ${minImageSide} 像素`);
  const rotated = [5, 6, 7, 8].includes(metadata.orientation);
  const width = rotated ? metadata.height : metadata.width, height = rotated ? metadata.width : metadata.height;
  if (aspectRatio) {
    const [w, h] = aspectRatio.split(":").map(Number);
    if (Math.abs(width / height / (w / h) - 1) > .03) throw new Error(`首帧为 ${width}×${height}，与视频 ${aspectRatio} 比例不符。请上传对应比例的完整画面；系统不会裁掉商品来适配。`);
  }
  return { width, height, format: metadata.format, mime: `image/${metadata.format}` };
}

export class KeyframeService {
  constructor({ store, config, referenceDataUrls, visual }) { Object.assign(this, { store, config, referenceDataUrls, visual }); }

  async view(id) {
    const job = this.store.getJob(id);
    if (!job || job.type !== "generate") throw new Error("未找到视频任务");
    const project = this.store.getAppState().projects.find(p => p.id === job.projectId);
    if (!project) throw new Error("项目不存在");
    const refs = await generationProject(this.store, project, job.payload.artifacts);
    const gate = job.payload.keyframeGate;
    if (!gate) return null;
    const truthRevision = truthRevisionFor(job, project);
    const reviewGate = gate.phase === "released" ? gate : { ...gate, version: KEYFRAME_REVIEW_VERSION, truthRevision };
    const route = gate.imageRoute || keyframeImageRoute(this.config);
    const videoModel = job.payload.videoRoute?.model;
    const pendingUnits = job.payload.artifacts.units.slice(job.payload.index || 0).map(u => u.id);
    let billing;
    try {
      const image = operationPlan(this.store.data, project.ownerId, "keyframe", route);
      const videoParts = job.payload.artifacts.units.slice(Math.max(job.payload.index || 0, gate.startIndex || 0)).map(u => operationPlan(this.store.data, project.ownerId, "video", job.payload.videoRoute, { durations: [u.duration_s], imageCount: videoReferenceCount(job.payload.videoRoute, referenceFiles(refs).length, true), aspectRatio: refs.resolvedVideoAspectRatio || (refs.videoAspectRatio === "auto" ? "9:16" : refs.videoAspectRatio) }));
      const video = { credits: videoParts.reduce((sum, part) => sum + part.amount, 0) / 1_000_000, pricingVersion: videoParts[0]?.pricingVersion };
      billing = { imageCredits: image.credits, videoCredits: video.credits, missingImages: gate.frames.filter(f => !f.asset).length, internal: image.pricingVersion === "internal", pricingVersion: video.pricingVersion };
    } catch (error) { billing = { issue: error.message }; }
    return { phase: gate.phase, truthRevision, frames: gate.frames.map(({ requestId, submission, history, ...frame }) => ({ ...frame, status: !["completed", "cancelled"].includes(job.status) && pendingUnits.includes(frame.unitId) && gate.phase !== "released" && frame.status === "approved" && (!frameApproved(reviewGate, frame) || !this.visual.framePassed(job, refs, frame)) ? "review" : frame.status, pending: Boolean(requestId || submission), historyCount: history?.length || 0, ...(refs.cast ? { castLabel: selectedCast(refs).products.filter(p => job.payload.artifacts.units.find(u => u.id === frame.unitId)?.product_ids?.includes(p.id)).map(p => `${selectedCast(refs).roles.find(r => r.id === p.roleId)?.name || "角色"} · ${p.name}`).join("；") } : {}) })), checks: reviewChecks(gate),
      billing, automaticReview: true,
      productImages: refs.assets.productImages, modelImages: refs.assets.modelImages,
      modelLabels: Object.fromEntries(selectedCast(refs).roles.flatMap(r => r.images.map(f => [f.path, `${r.name} · 独立人脸依据`]))),
      shotPlans: Object.fromEntries(job.payload.artifacts.units.map(u => [u.id, u.shot_plan || []])),
      productLock: normalizeProductLocks(job.payload.artifacts.productLock, refs).map(item => ({ ...item, productName: refs.cast ? selectedCast(refs).products.find(p => p.id === item.product_id)?.name : undefined })),
      ...(refs.cast ? { productLabels: Object.fromEntries(selectedCast(refs).products.flatMap(p => p.images.map(f => [f.path, `${p.name} → ${selectedCast(refs).roles.find(r => r.id === p.roleId)?.name || "角色"}`]))) } : {}),
      videoInputMode: videoModel?.inputMode || "references", videoModelLabel: videoModel?.label,
      aspectRatio: job.payload.resolvedVideoAspectRatio || refs.resolvedVideoAspectRatio || (refs.videoAspectRatio === "auto" ? "9:16" : refs.videoAspectRatio),
      imageModels: imageCatalog(this.config, this.store.data.platform?.users.find(user => user.id === job.ownerId)?.role).models,
      imageService: { model: route.model, label: imageModel(route).label, detail: imageModel(route).detail, configured: Boolean(videoKey(this.config, route)), source: `https://xylp.ai/apidoc#model/${encodeURIComponent(route.model)}` },
      locked: ["completed", "cancelled"].includes(job.status) || gate.phase === "released",
    };
  }

  async action(id, input) {
    if (["approve", "reject"].includes(input.action)) throw new Error("关键帧需由视觉扫描通过，不支持手动确认放行");
    return this.store.mutate(data => {
      const { job, task } = state(data, id);
      if (["generate", "regenerate", "release"].includes(input.action)) assertVideoAccess(data, job.ownerId, job.payload.videoRoute);
      const gate = job.payload.keyframeGate;
      if (["running", "completed", "cancelled"].includes(job.status) || job.providerRequestId || job.payload.videoSubmission || (job.payload.index || 0) > (gate?.startIndex || 0) && input.action !== "release") throw new Error("任务正在执行或已经提交视频，不能修改关键帧");
      if (!gate || gate.phase === "released") throw new Error("关键帧验收已结束或不适用");
      const project = data.appState.projects.find(p => p.id === job.projectId);
      const truthRevision = truthRevisionFor(job, project);
      const selectedRoute = gate.imageRoute || keyframeImageRoute(this.config);
      if (["generate", "regenerate"].includes(input.action)) {
        assertImageAccess(data, job.ownerId, selectedRoute);
        if (input.imageModelId && input.imageModelId !== selectedRoute.model) throw new Error("图像模型已变化，请刷新关键帧面板核对后再生成");
        const refs = job.payload.artifacts.referenceSnapshot || project;
        validateImageReferences(selectedRoute, refs, job.payload.resolvedVideoAspectRatio || refs.resolvedVideoAspectRatio || (refs.videoAspectRatio === "auto" ? "9:16" : refs.videoAspectRatio));
      }
      const frame = gate.frames.find(f => f.unitId === input.unitId);
      if (["generate", "regenerate"].includes(input.action) && !videoKey(this.config, gate.imageRoute || keyframeImageRoute(this.config))) throw new Error("关键帧图片服务尚未配置密钥，可上传已制作的关键帧");
      if (["approve", "reject", "regenerate", "upload"].includes(input.action) && (!frame || input.revision !== frame.revision)) throw new Error("关键帧版本已变化，请刷新后重新验收");
      if (frame && (frame.requestId || frame.submission?.state === "inflight")) throw new Error("本帧仍有供应商请求；请先查询原任务，不能重复提交或替换");
      if (["generate", "regenerate", "upload"].includes(input.action) && !this.visual.enabled(job)) job.payload.visualReview = this.visual.settings(job.ownerId);
      if (input.action === "select-model") {
        if (gate.phase === "generating" || gate.frames.some(f => f.requestId || f.submission)) throw new Error("关键帧正在生成或结果待核实，请完成原请求后再切换模型");
        if (typeof input.modelId !== "string" || !input.modelId) throw new Error("请选择关键帧图像模型");
        const route = keyframeImageRoute(this.config, { modelId: input.modelId });
        assertImageAccess(data, job.ownerId, route);
        for (const target of gate.frames.filter(f => !f.asset)) {
          if (data.platform?.requests[`${job.id}:image:${target.revision}`]?.state === "reserved") {
            settle(data, `${job.id}:image:${target.revision}`, false, "切换图像模型，释放尚未提交的预留");
            target.revision = randomUUID();
          }
        }
        gate.imageRoute = route;
      } else if (input.action === "regenerate" || input.action === "upload") {
        if (data.platform?.requests[`${job.id}:image:${frame.revision}`]?.state === "reserved") settle(data, `${job.id}:image:${frame.revision}`, false, "关键帧被替换，未提交的生图预留已释放");
        if (frame.asset) frame.history.push({ asset: frame.asset, revision: frame.revision, status: frame.status, cost: frame.cost, imageModel: frame.imageModel });
        Object.assign(frame, { asset: input.action === "upload" ? input.asset : undefined, dimensions: input.dimensions, revision: randomUUID(), status: input.action === "upload" ? "review" : "empty", approvalMethod: undefined, visualRecord: undefined, correction: String(input.correction || frame.correction || "").slice(0, 2000), checks: [], approvedRevision: undefined, approvedAt: undefined, cost: undefined, imageModel: undefined, submission: undefined });
        if (input.action === "regenerate") {
          const route = gate.imageRoute || keyframeImageRoute(this.config);
          if (!videoKey(this.config, route)) throw new Error("关键帧图片服务尚未配置密钥，可上传已制作的关键帧");
          gate.imageRoute = route;
          gate.phase = "generating";
          job.status = "queued";
        } else if (gate.frames.every(f => f.asset)) {
          gate.phase = "review";
          job.status = "queued";
        }
      } else if (input.action === "generate") {
        const route = gate.imageRoute || keyframeImageRoute(this.config);
        if (!videoKey(this.config, route)) throw new Error("关键帧图片服务尚未配置密钥，可上传已制作的关键帧");
        if (!gate.frames.some(f => !f.asset)) throw new Error("关键帧已生成；如有问题请指定本帧重做");
        gate.imageRoute = route;
        gate.phase = "generating";
        job.status = "queued";
      } else if (input.action === "release") {
        const pendingUnits = job.payload.artifacts.units.slice(job.payload.index || 0).map(u => u.id);
        const pendingFrames = gate.frames.filter(f => pendingUnits.includes(f.unitId));
        gate.version = KEYFRAME_REVIEW_VERSION;
        if (gate.truthRevision !== truthRevision) throw new Error("商品证据修订已变化或尚未确认，请重新验收关键帧；未提交视频");
        if (!pendingUnits.length || pendingFrames.length !== pendingUnits.length || pendingFrames.some(f => !hasKeyframeApproval({ ...gate, phase: "released" }, f.unitId))) throw new Error("每一帧都必须确认当前版本的人脸、角色绑定、商品和开场分镜检查项，才能开始视频");
        const refs = { ...project, ...job.payload.artifacts.referenceSnapshot };
        if (!this.visual.sourcePassed(job, refs) || pendingFrames.some(f => !this.visual.framePassed(job, refs, f))) throw new Error("人物、商品和每一张关键帧均须通过当前版本的视觉扫描，不能手动放行");
        gate.phase = "released";
        gate.releasedAt = now();
        job.status = "queued";
      } else throw new Error("未知关键帧操作");
      if (["generate", "regenerate"].includes(input.action)) {
        for (const target of gate.frames.filter(f => !f.asset)) reserve(data, { id: `${job.id}:image:${target.revision}`, userId: project.ownerId, jobId: job.id, quote: operationPlan(data, project.ownerId, "keyframe", gate.imageRoute), label: `${imageModel(gate.imageRoute).label} · 商品关键帧 ${target.unitId}` });
      }
      if (input.action === "release") {
        const route = job.payload.videoRoute;
        const refs = job.payload.artifacts.referenceSnapshot || project;
        const aspectRatio = refs.resolvedVideoAspectRatio || (refs.videoAspectRatio === "auto" ? "9:16" : refs.videoAspectRatio);
        const imageCount = videoReferenceCount(route, referenceFiles(refs).length, true);
        for (const unit of job.payload.artifacts.units.slice(Math.max(job.payload.index || 0, gate.startIndex || 0))) reserve(data, { id: `${job.id}:video:${unit.id}`, userId: project.ownerId, jobId: job.id, quote: operationPlan(data, project.ownerId, "video", route, { durations: [unit.duration_s], imageCount, aspectRatio }), label: `${route.model.label} · ${unit.id}` });
      }
      job.nextRunAt = Date.now();
      job.updatedAt = now();
      message(task, job.status === "queued" ? "generating" : "attention", input.action === "release" ? "视觉扫描通过，正在准备视频" : gate.phase === "generating" ? "正在准备商品关键帧，未提交视频" : job.status === "queued" ? "关键帧已备齐，正在准备视觉扫描" : "关键帧已更新，备齐后自动扫描");
      return { ok: true };
    });
  }

  async advance(job, project, route) {
    let gate = job.payload.keyframeGate;
    if (!gate) {
      gate = createKeyframeGate(job.payload.artifacts, job.payload.index || 0);
      await this.store.mutate(data => { const current = state(data, job.id); current.job.payload.keyframeGate = gate; current.task.keyframeReviewRequired = true; });
    }
    if (gate.phase === "released") {
      if (gate.sourceFingerprint !== job.payload.artifacts.sourceFingerprint) throw new Error("编译版本已变化，请重新验收关键帧");
      if (gate.version >= 3 && gate.truthRevision !== truthRevisionFor(job, project)) throw new Error("商品证据修订已变化，视频生成已拦截，请重新验收关键帧");
      if (!job.payload.artifacts.units.slice(Math.max(job.payload.index || 0, gate.startIndex || 0)).every(u => hasKeyframeApproval(gate, u.id))) throw new Error("关键帧确认记录不完整，视频生成已拦截");
      const refs = await generationProject(this.store, project, job.payload.artifacts);
      if (!gate.frames.filter(f => job.payload.artifacts.units.slice(job.payload.index).some(u => u.id === f.unitId)).every(f => this.visual.framePassed(job, refs, f))) {
        await this.store.mutate(data => { const current = state(data, job.id); current.job.payload.keyframeGate.phase = "review"; });
        await this.pause(job.id, "已有关键帧需先完成视觉扫描；已生成片段保持不变", "review");
        return false;
      }
      return true;
    }
    if (this.visual?.enabled(job) && gate.phase === "review" && gate.frames.every(f => f.asset)) {
      return this.visual.frames(job, await generationProject(this.store, project, job.payload.artifacts));
    }
    if (gate.phase !== "generating") {
      await this.pause(job.id, "先生成或上传关键帧，图片备齐后自动扫描");
      return false;
    }
    const refs = await generationProject(this.store, project, job.payload.artifacts);
    const aspectRatio = job.payload.resolvedVideoAspectRatio || refs.resolvedVideoAspectRatio || (refs.videoAspectRatio === "auto" ? "9:16" : refs.videoAspectRatio);
    // Multi-reference models reserve a slot; first-frame models only receive
    // the reviewed composition, never an arbitrary original image.
    const referenceImages = Array(videoReferenceCount(route, referenceFiles(refs).length, true)).fill("planned-image");
    for (const unit of job.payload.artifacts.units.slice(gate.startIndex || 0)) validateVideoInput(route, { duration: unit.duration_s, aspectRatio, referenceImages });
    const frame = gate.frames.find(f => !f.asset);
    if (!frame) {
      return this.visual.frames(job, refs);
    }
    const imageRoute = gate.imageRoute;
    if (frame.requestId) {
      let result;
      try { result = await pollKeyframe(this.config, imageRoute, frame.requestId); }
      catch (error) {
        if (error.terminal) await this.store.mutate(data => {
          const currentGate = state(data, job.id).job.payload.keyframeGate;
          const target = currentGate.frames.find(f => f.unitId === frame.unitId);
          target.history.push({ requestId: target.requestId, status: "failed", revision: target.revision });
          settle(data, `${job.id}:image:${target.revision}`, false, "供应商确认生图失败");
          Object.assign(target, { revision: randomUUID(), requestId: undefined, submission: undefined, status: "rejected" });
          currentGate.phase = "review";
        });
        throw error;
      }
      if (result.pending) {
        await this.store.mutate(data => { const { job: current } = state(data, job.id); if (current.status === "running") { current.status = "queued"; current.nextRunAt = Date.now() + 5000; } });
        return false;
      }
      await this.store.mutate(data => settle(data, `${job.id}:image:${frame.revision}`, true, `${frame.unitId} 关键帧生成完成`));
      const url = new URL(result.url);
      if (url.protocol !== "https:") throw new Error("关键帧下载地址必须为 HTTPS");
      const response = await fetch(url, { redirect: "error", signal: jobRequestSignal(60000) });
      if (!response.ok) throw new Error("关键帧下载失败，可继续查询原请求，不会重新生图");
      const chunks = []; let length = 0;
      for await (const chunk of response.body) { length += chunk.length; if (length > 20 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error("关键帧下载超过 20MB"); } chunks.push(chunk); }
      const buffer = Buffer.concat(chunks);
      const info = await checkedKeyframe(buffer);
      const asset = await this.store.putAsset({ buffer, name: `关键帧_${frame.unitId}_${frame.revision.slice(0, 8)}.${info.format}`, kind: "output", mime: info.mime, projectId: project.id, source: "keyframe" });
      await this.store.mutate(data => {
        const { job: current, task } = state(data, job.id);
        if (current.status === "cancelled") return;
        const target = current.payload.keyframeGate.frames.find(f => f.unitId === frame.unitId);
        if (target.revision !== frame.revision) return;
        Object.assign(target, { asset, status: "review", requestId: undefined, submission: undefined, cost: result.cost, dimensions: `${info.width}×${info.height}` });
        task.outputFiles.push(asset);
        const complete = current.payload.keyframeGate.frames.every(f => f.asset);
        if (complete) current.payload.keyframeGate.phase = "review";
        // A pause requested during GET/download must remain paused.
        if (current.status === "running") current.status = "queued";
        current.nextRunAt = Date.now();
        message(task, current.status === "queued" ? "generating" : "attention", complete ? "关键帧已备齐，准备自动比对原图；视频尚未提交" : `${frame.unitId} 关键帧已保存，准备下一张`);
      });
      return false;
    }
    if (frame.submission?.state === "inflight") throw new Error("上次关键帧提交结果不确定，已停止自动重提；请先核对中转站记录");
    if (!this.visual.sourcePassed(job, refs)) throw new Error("人物与商品原图尚未通过视觉扫描，未提交生图");
    assertImageAccess(this.store.data, job.ownerId, imageRoute);
    validateImageReferences(imageRoute, refs, aspectRatio);
    const images = await this.referenceDataUrls(refs, { model: imageModel(imageRoute) });
    const unit = job.payload.artifacts.units.find(u => u.id === frame.unitId);
    const body = keyframeImageBody(imageRoute, { prompt: keyframePrompt(refs, job.payload.artifacts, unit, frame.correction), images, aspectRatio });
    if (imageRoute.protocol === "xhai-image") {
      const fingerprint = createHash("sha256").update(images.join("\n")).digest("hex");
      const cached = gate.xhaiReferenceUploads;
      body.params.images = cached?.fingerprint === fingerprint
        ? cached.urls
        : await uploadXhaiImages(imageRoute.baseUrl, videoKey(this.config, imageRoute), images);
      if (!cached || cached.fingerprint !== fingerprint) await this.store.mutate(data => {
        const current = data.jobs[job.id];
        if (current?.status === "running") current.payload.keyframeGate.xhaiReferenceUploads = { fingerprint, urls: body.params.images };
      });
      await dryRunKeyframe(this.config, imageRoute, body);
    }
    const canSubmit = await this.store.mutate(data => {
      const { job: current, task } = state(data, job.id);
      if (current.status !== "running") return false;
      assertVideoAccess(data, project.ownerId, current.payload.videoRoute);
      assertImageAccess(data, project.ownerId, imageRoute);
      const target = current.payload.keyframeGate.frames.find(f => f.unitId === frame.unitId);
      if (target.revision !== frame.revision || target.submission || target.asset) return false;
      if (data.platform && !data.platform.requests[`${job.id}:image:${frame.revision}`]) reserve(data, { id: `${job.id}:image:${frame.revision}`, userId: project.ownerId, jobId: job.id, quote: operationPlan(data, project.ownerId, "keyframe", imageRoute), label: `${imageModel(imageRoute).label} · 商品关键帧 ${frame.unitId}` });
      markSubmitted(data, `${job.id}:image:${frame.revision}`);
      target.imageModel = imageRoute.model;
      target.submission = { state: "inflight", startedAt: now() };
      message(task, "generating", `正在生成 ${frame.unitId} 商品关键帧，视频尚未提交`);
      return true;
    });
    if (!canSubmit) return false;
    let requestId;
    try { requestId = await submitKeyframe(this.config, imageRoute, body); }
    catch { throw new Error("关键帧提交未能确认；已停止自动重提，请先在原中转站核对请求记录，避免重复扣费"); }
    await this.store.mutate(data => {
      const { job: current } = state(data, job.id);
      const target = current.payload.keyframeGate.frames.find(f => f.unitId === frame.unitId);
      Object.assign(target, { requestId, submission: { state: "submitted", startedAt: target.submission.startedAt } });
      if (current.status === "running") { current.status = "queued"; current.nextRunAt = Date.now() + 5000; }
    });
    return false;
  }

  async pause(id, text, phase) {
    await this.store.mutate(data => {
      const { job, task } = state(data, id);
      if (job.status === "cancelled") return;
      job.status = "paused";
      if (phase) job.payload.keyframeGate.phase = phase;
      message(task, "attention", text);
    });
  }
}

import { compilerSnapshot, assertCompilerAccess } from "./compile-providers.mjs";
import { compileReceipt } from "./compile-response.mjs";
import { generationProject, referenceSnapshot } from "./project-references.mjs";
import { productTruthRevision } from "./product-truth.mjs";
import { KEYFRAME_REVIEW_VERSION, reviewChecks } from "./keyframe-contract.mjs";
import { VISUAL_REVIEW_VERSION, VISUAL_PARSER_VERSION, visualRevision, visualReviewPrompt, validateVisualReport, parseVisualReport } from "./visual-review-contract.mjs";
import { applySideViewChoice } from "./product-view-policy.mjs";
import { referenceEntries } from "./consistency.mjs";
import { selectedCast, projectWithCast } from "../shared/project-cast.mjs";
import { FRAME_DETAIL_POLICY } from "./visual-detail.mjs";

const now = () => new Date().toISOString();
const terminal = j => !j || ["cancelled", "completed", "failed"].includes(j.status);
const visualPass = record => record?.status === "passed" && record.approvalMethod === "visual" && record.report?.status === "passed" && record.report.checks?.length > 0;
const retryableReceipt = receipt => ["completed", "incomplete"].includes(receipt?.status) && !["content_filter", "safety", "refusal"].includes(receipt.reason);
const MAX_SCAN_ATTEMPTS = 2;
const hasMediaRequest = job => job.providerRequestId || job.payload.videoSubmission || job.payload.keyframeGate?.phase === "released" || job.payload.index > 0 || job.payload.keyframeGate?.frames.some(f => f.requestId || f.submission);
const validationIssue = error => error?.issues ? error.issues.map(i => `${i.path.join(".")}:${i.code}`).slice(0, 12).join("; ") : String(error.message || "invalid_report").slice(0, 300);
export class VisualReviewService {
  constructor(deps) { Object.assign(this, deps); }
  settings(ownerId) {
    const provider = this.compiler(undefined, undefined, ownerId);
    assertCompilerAccess(this.store.data, ownerId, provider);
    return { version: VISUAL_REVIEW_VERSION, compiler: compilerSnapshot(provider), reviewVideo: false, records: {} };
  }
  enabled(job) { return job.payload?.visualReview?.version === VISUAL_REVIEW_VERSION; }
  summary(job, project) {
    const config = job.payload?.visualReview;
    const finishedUnits = job.payload.artifacts.units.slice(0, job.payload.index || 0).map(u => u.id);
    const current = Object.values(config?.records || {}).filter(r => job.status === "completed" && config.completedKeys ? config.completedKeys.includes(r.key) :
      (!project || r.key === visualRevision(job, project, r.target) || r.target.kind === "frame" && finishedUnits.includes(r.target.unitId) && job.payload.keyframeGate?.frames.some(f => f.visualRecord === r.key)) && (r.target.kind !== "frame" || job.payload.keyframeGate?.frames.some(f => f.revision === r.target.revision && f.asset?.path === r.target.path)));
    const records = current.filter(r => !(r.target.kind === "video" && !r.target.dense && current.some(d => d.target.dense && d.target.path === r.target.path && d.target.batch === r.target.batch && d.status === "passed")));
    const outdatedFrames = !terminal(job) && project ? (job.payload.keyframeGate?.frames || []).filter(f => f.asset && f.approvalMethod === "visual" && !current.some(r => r.target.kind === "frame" && r.target.path === f.asset.path && r.target.revision === f.revision) && Object.values(config?.records || {}).some(r => r.target.kind === "frame" && r.target.path === f.asset.path && r.target.revision === f.revision)).map(f => f.unitId) : [];
    return { enabled: this.enabled(job), detailPolicy: FRAME_DETAIL_POLICY, outdatedFrames, reviewVideo: config?.reviewVideo === true, canSetVideoReview: this.enabled(job) && !terminal(job) && job.payload.index < job.payload.artifacts.units.length, sourceRevision: project ? visualRevision(job, project, { kind: "source" }) : undefined,
      viewChoice: project ? this.viewChoice(job, project) : undefined,
      canRecoverSaved: records.some(r => r.status === "error" && r.receipt && r.parserVersion !== VISUAL_PARSER_VERSION),
      records: records.map(record => {
        const { key, target, status, report, samples, error, approvalMethod, attempt } = record;
        let diagnostic = record.validationIssue;
        if ((!diagnostic || record.parserVersion !== VISUAL_PARSER_VERSION) && status === "error" && record.receipt && project) {
          try {
            if (record.receipt.status !== "completed" || record.receipt.outputOversized) throw new Error(`回包状态 ${record.receipt.status}；未取得完整报告`);
            validateVisualReport(parseVisualReport(record.receipt.outputText), { project, target, unit: job.payload.artifacts.units.find(u => u.id === target.unitId), samples: samples || [], artifacts: job.payload.artifacts, views: record.views || [] });
            diagnostic = "已保存报告可按新格式本地恢复，无需再次调用模型";
          } catch (e) { diagnostic = validationIssue(e); }
        }
        return { key, target, status, attempt: attempt || 1, issues: report?.issues || [], checks: report?.checks || [], samples: samples || [], views: record.views || [], detailPolicy: record.detailPolicy, error, approvalMethod, validationIssue: diagnostic,
          metrics: record.metrics ? { ...record.metrics, ...(record.finishedAt && record.startedAt ? { durationMs: Math.max(0, Date.parse(record.finishedAt) - Date.parse(record.startedAt)) } : {}) } : undefined };
      }) };
  }
  viewChoice(job, project) {
    const record = job.payload.visualReview?.records?.[visualRevision(job, project, { kind: "source" })];
    if (terminal(job) || !record?.report?.viewGaps?.length || record.status !== "review" || record.approvalMethod !== "visual") return undefined;
    return { key: record.key, projectId: job.projectId, gaps: record.report.viewGaps };
  }
  async chooseView(id, input, actorId) {
    if (!["slight-side", "supplement"].includes(input.choice)) throw new Error("请选择补充背面图或仅轻微侧角度展示");
    const job = this.store.getJob(id);
    const project = this.store.getAppState().projects.find(p => p.id === job?.projectId);
    if (!job || !project || job.type !== "generate") throw new Error("未找到生成任务");
    const refs = await generationProject(this.store, project, job.payload.artifacts);
    const choice = this.viewChoice(job, refs);
    if (!choice || choice.key !== input.key || !choice.gaps.some(g => g.product_id === input.productId)) throw new Error("补图选项已变化，请刷新后操作");
    let updatedRefs = refs;
    if (input.choice === "supplement") {
      const asset = await this.store.readAsset(input.assetPath);
      if (!asset || asset.metadata.projectId !== job.projectId || asset.metadata.ownerId !== job.ownerId || asset.metadata.kind !== "product" || asset.metadata.source !== "upload") throw new Error("补图必须是本用户上传到本项目的商品原图");
      const { checkedKeyframe } = await import("./keyframes.mjs");
      await checkedKeyframe(asset.buffer); // decode and enforce image limits; never trust extension
      const cast = structuredClone(selectedCast(refs)), product = cast.products.find(p => p.id === input.productId);
      if (refs.assets.productImages.some(f => f.path === input.assetPath)) throw new Error("该图片已在原图中，请补充新的背面细节图");
      product.images.push({ path: input.assetPath, name: asset.metadata.name, size: asset.metadata.size, kind: "product" });
      updatedRefs = projectWithCast(refs, cast);
      // Preserve the implicit legacy binding shape for pre-cast projects.
      if (!refs.cast) delete updatedRefs.cast;
      if (referenceEntries(updatedRefs).filter(r => r.kind !== "scene").length > 30) throw new Error("人物和商品原图合计不能超过30张");
    }
    await this.store.mutate(data => {
      const current = data.jobs[id], task = data.appState.tasks.find(t => t.id === id);
      if (current?.status !== "paused" || hasMediaRequest(current)) throw new Error("当前请求仍在执行，不能修改已提交的分镜或素材");
      if (visualRevision(current, { ...refs, ...current.payload.artifacts.referenceSnapshot }, { kind: "source" }) !== choice.key) throw new Error("素材或脚本已变化，请刷新后操作");
      const artifacts = current.payload.artifacts;
      if (input.choice === "slight-side") {
        artifacts.viewAdaptation = { originalUnits: artifacts.viewAdaptation?.originalUnits || structuredClone(artifacts.units), decisions: [...(artifacts.viewAdaptation?.decisions || []), { productId: input.productId, units: choice.gaps.filter(g => g.product_id === input.productId).map(g => ({ unitId: g.unit_id, shotIndices: g.shots.map(s => s.index) })), maxAngleDegrees: 30 }] };
        artifacts.units = applySideViewChoice(artifacts.units, choice.gaps, input.productId);
      } else {
        const before = referenceEntries(refs), after = referenceEntries(updatedRefs);
        artifacts.productLock = (artifacts.productLock || []).map(lock => ({ ...lock, source_images: (lock.source_images || []).map(i => after.find(r => r.file.path === before.find(b => b.index === i)?.file.path)?.index).filter(Number.isInteger) }));
        artifacts.referenceSnapshot = referenceSnapshot(updatedRefs);
      }
      current.payload.viewChoices = [...(current.payload.viewChoices || []), { key: choice.key, productId: input.productId, choice: input.choice, actorId, at: now(), ...(input.choice === "supplement" ? { assetPath: input.assetPath } : {}), previousUnits: job.payload.artifacts.units }];
      current.status = "queued"; current.nextRunAt = Date.now(); current.updatedAt = now();
      Object.assign(task, { stage: "analyzing", viewChoiceRequired: false, currentItem: input.choice === "supplement" ? "背面图已补充，模型正在重新核对" : "已选择轻微侧角度，模型正在核对调整后的分镜", updatedAt: now() });
    });
    this.wake();
    return { ok: true };
  }
  async setVideoReview(id, enabled, actorId) {
    if (typeof enabled !== "boolean") throw new Error("请选择是否额外复检成片");
    return this.store.mutate(data => {
      const job = data.jobs[id];
      if (!job || !this.enabled(job) || terminal(job) || job.payload.index >= job.payload.artifacts.units.length) throw new Error("请在视频完成前设置成片复检");
      job.payload.visualReview.reviewVideo = enabled;
      job.payload.visualReview.videoReviewPreference = { actorId, at: now(), enabled };
      job.updatedAt = now();
      return { ok: true };
    });
  }
  async start(id, actorId) {
    const current = this.store.getJob(id);
    if (!current || current.type !== "generate" || current.status !== "paused") throw new Error("请等待当前任务暂停后再启动核对");
    const settings = this.enabled(current) ? current.payload.visualReview : this.settings(current.ownerId);
    const project = this.store.getAppState().projects.find(p => p.id === current.projectId);
    await generationProject(this.store, project, current.payload.artifacts);
    await this.store.mutate(data => {
      const job = data.jobs[id], task = data.appState.tasks.find(t => t.id === id);
      if (job?.status !== "paused" || job.providerRequestId || job.payload.videoSubmission || job.payload.keyframeGate?.frames.some(f => f.requestId || f.submission)) throw new Error("生成请求仍未结束，请先查询原请求");
      job.payload.visualReview = structuredClone(settings);
      job.payload.visualReview.requestedBy = actorId;
      if (job.payload.keyframeGate?.frames.every(f => f.asset) && job.payload.keyframeGate.phase !== "released") job.payload.keyframeGate.phase = "review";
      // An explicit start does not discard completed, failed, or unknown calls.
      // Same images and plan reuse the receipt, including after reload/restart.
      job.status = "queued"; job.nextRunAt = Date.now(); job.updatedAt = now();
      task.visualReviewRequired = true; task.stage = "analyzing"; task.error = undefined; task.updatedAt = now(); task.currentItem = "正在对照原图智能核对";
    });
    this.wake();
    return { ok: true };
  }
  async state(id, status, message) {
    await this.store.mutate(data => {
      const j = data.jobs[id], t = data.appState.tasks.find(t => t.id === id);
      if (terminal(j) || !t) return;
      // Do not undo a user pause made while a provider request was in flight.
      if (status === "queued" && j.status !== "running") return;
      j.status = status; j.nextRunAt = Date.now() + (status === "queued" ? 1000 : 0); j.updatedAt = now();
      Object.assign(t, { stage: status === "paused" ? "attention" : "analyzing", currentItem: message, error: undefined, visualReviewRequired: true, updatedAt: now() });
    });
  }
  async save(id, key, record) {
    return this.store.mutate(data => {
      const j = data.jobs[id];
      if (terminal(j)) return false;
      j.payload.visualReview.records[key] = record; j.updatedAt = now(); return true;
    });
  }
  async check(job, project, target, unit) {
    const key = visualRevision(job, project, target);
    let record = job.payload.visualReview.records[key];
    // Policy changes must not abandon an unknown/in-flight billed scan and
    // blindly POST the same frame again. Preserve or poll the original request.
    const legacy = target.kind === "frame" && Object.values(job.payload.visualReview.records).find(r => r.key !== key && r.target?.kind === "frame" && r.target.path === target.path && r.target.revision === target.revision && ["inflight", "pending", "received", "retry", "error"].includes(r.status) && !r.superseded);
    if (!record && legacy) {
      if (!legacy.receipt && legacy.requestId) {
        try {
          const provider = this.compiler(undefined, job.payload.visualReview.compiler, job.ownerId);
          assertCompilerAccess(this.store.data, job.ownerId, provider);
          const receipt = compileReceipt(await this.getResponse(provider, legacy.requestId), 7000);
          if (["queued", "in_progress"].includes(receipt.status)) { await this.state(job.id, "queued", "正在查询旧版扫描原请求，未重复提交"); return null; }
          legacy.receipt = receipt;
        } catch { await this.state(job.id, "paused", "旧版扫描原请求暂无法查询，未重复提交；请稍后继续查询"); return null; }
      }
      if (legacy.receipt && !["queued", "in_progress"].includes(legacy.receipt.status)) {
        await this.save(job.id, legacy.key, { ...legacy, superseded: true });
        await this.state(job.id, "paused", "旧版扫描回包已保留，需按新细节规则重新核对；不会自动重做图片或启动视频");
      } else await this.state(job.id, "paused", "旧版扫描请求结果待核实，未重复提交；已保留原请求记录");
      return null;
    }
    if (visualPass(record) || record?.status === "review" && record.approvalMethod === "visual") return record;
    if (record?.approvalMethod === "manual" || record?.status === "passed" && !visualPass(record)) {
      await this.state(job.id, "paused", "旧确认记录不属于视觉扫描结果，请更新素材并重新编译"); return null;
    }
    if (record?.status === "error" && record.receipt && record.parserVersion !== VISUAL_PARSER_VERSION) record = { ...record, status: "received" };
    if (record?.status === "error" || record?.status === "inflight" && !record.requestId && !record.receipt) {
      if (record.status === "inflight") {
        record = { ...record, status: "error", error: "视觉扫描请求结果待核实；已保留请求记录，请联系管理员检查服务" };
        await this.save(job.id, key, record);
      }
      await this.state(job.id, "paused", record.error || "视觉扫描请求结果待核实，请联系管理员检查服务"); return null;
    }
    let processingReceipt = Boolean(record?.receipt);
    try {
      const provider = record?.receipt && record.status !== "retry" && !["queued", "in_progress"].includes(record.receipt.status) ? undefined : this.compiler(undefined, job.payload.visualReview.compiler, job.ownerId);
      if (provider) assertCompilerAccess(this.store.data, job.ownerId, provider);
      if (!record || record.status === "retry") {
        const previous = record;
        processingReceipt = false;
        const startedAt = now(), preparationStarted = Date.now();
        const prepared = await this.prepare(job, project, target, unit);
        if (!prepared.images.length) throw new Error("缺少可读取的原图，无法核对");
        const images = await this.prepareImages(job, provider, prepared.images);
        const prompt = visualReviewPrompt({ project, artifacts: job.payload.artifacts, target, unit, samples: prepared.samples, views: prepared.views || [] }) + (previous ? "\n上次报告未满足机器校验合同。这是唯一一次自动复查：重新看原图，只输出完整JSON，所有必需编号、原图数字编号和sample_ids严格使用上方清单，不以默认通过补齐缺项。" : "");
        record = { key, target, samples: prepared.samples.map(({ dataUrl, ...s }) => s), views: prepared.views || [], ...(target.kind === "frame" ? { detailPolicy: FRAME_DETAIL_POLICY } : {}), status: "inflight", startedAt, attempt: previous ? (previous.attempt || 1) + 1 : 1,
          metrics: { originalImages: prepared.originalImages ?? prepared.images.length - prepared.samples.length, sampleImages: prepared.samples.length, detailImages: (prepared.views || []).filter(v => v.crop).length, preparationMs: Date.now() - preparationStarted, promptCharacters: prompt.length },
          ...(previous ? { previousReceipts: [...(previous.previousReceipts || []), previous.receipt], repairReason: previous.validationIssue } : {}) };
        const ready = await this.store.mutate(data => {
          const j = data.jobs[job.id];
          const existing = j?.payload.visualReview.records[key];
          if (j?.status !== "running" || (previous ? existing?.status !== "retry" || (existing.attempt || 1) !== (previous.attempt || 1) : existing)) return false;
          j.payload.visualReview.records[key] = record;
          const t = data.appState.tasks.find(t => t.id === j.id);
          Object.assign(t, { stage: "analyzing", currentItem: target.kind === "source" ? "正在智能核对人物和商品原图" : `正在比对 ${unit.id} ${target.kind === "frame" ? "关键帧" : "视频画面"}`, visualReviewRequired: true, updatedAt: now() });
          return true;
        });
        if (!ready) return null;
        const response = await this.createResponse(provider, prompt, images);
        record.receipt = compileReceipt(response, 7000);
        processingReceipt = true;
      } else if (record.requestId && !record.receipt) {
        record.receipt = compileReceipt(await this.getResponse(provider, record.requestId), 7000);
        processingReceipt = true;
      }
      if (["queued", "in_progress"].includes(record.receipt?.status)) {
        if (!provider.supportsResponsePolling || !record.receipt.id) throw new Error("核对回包尚未完成且没有可恢复编号");
        record.requestId = record.receipt.id; delete record.receipt; record.status = "pending";
        await this.save(job.id, key, record); await this.state(job.id, "queued", "正在等待智能核对结果"); return null;
      }
      // Persist every billed receipt before parsing. Only a confirmed terminal
      // response may receive ONE platform-funded rescan; an unknown POST never does.
      record.status = "received";
      if (!await this.save(job.id, key, record)) return null;
      if (record.receipt?.status !== "completed" || record.receipt.outputOversized) throw new Error("核对结果不完整，未自动重新调用");
      record.report = validateVisualReport(parseVisualReport(record.receipt.outputText), { project, target, unit, samples: record.samples, artifacts: job.payload.artifacts, views: record.views || [] });
      if (target.kind === "frame") record.detailPolicy = FRAME_DETAIL_POLICY;
      record.parserVersion = VISUAL_PARSER_VERSION;
      delete record.error; delete record.validationIssue;
      record.status = record.report.status; record.approvalMethod = "visual"; record.finishedAt = now();
      await this.save(job.id, key, record);
      // Continue on the next worker tick, allowing user pause/cancel to win.
      await this.state(job.id, "queued", record.status === "passed" ? "本项智能核对通过，准备下一步" : "已记录需要处理的画面差异");
      return null;
    } catch (error) {
      if (record) {
        const retry = processingReceipt && retryableReceipt(record.receipt) && (record.attempt || 1) < MAX_SCAN_ATTEMPTS;
        record.validationIssue = processingReceipt ? validationIssue(error) : "原图准备或服务请求失败；未取得可确认的新报告";
        record.parserVersion = VISUAL_PARSER_VERSION;
        record.error = retry ? "扫描报告格式不完整，正在自动复查一次" : record.receipt ? "自动扫描未能完成，已保留回包和具体校验原因；本任务停止后续生成，其他项目不受影响" : "视觉扫描请求未取得可确认结果，请联系管理员核实服务请求";
        record.status = retry ? "retry" : "error";
        record.finishedAt = now();
        await this.save(job.id, key, record);
      }
      await this.state(job.id, record?.status === "retry" ? "queued" : "paused", record?.error || "原图或视频画面暂时无法读取，请检查素材后再核对");
      return null;
    }
  }
  async source(job, project) {
    if (!this.enabled(job)) throw new Error("请先配置视觉扫描服务");
    const record = await this.check(job, project, { kind: "source" });
    if (!record) return false;
    if (!visualPass(record)) {
      if (record.report?.viewGaps?.length) {
        await this.store.mutate(data => { const task = data.appState.tasks.find(t => t.id === job.id); if (task && !terminal(data.jobs[job.id])) task.viewChoiceRequired = true; });
        await this.state(job.id, "paused", "镜头需要背面但原图缺失：请选择补图或仅轻微侧角度展示");
      } else await this.state(job.id, "paused", "模型发现具体差异，已保留成果；无需人工勾选核对，请查看扫描结果");
      return false;
    }
    return true;
  }
  sourcePassed(job, project) {
    return this.enabled(job) && visualPass(job.payload.visualReview.records[visualRevision(job, project, { kind: "source" })]);
  }
  framePassed(job, project, frame) {
    if (!this.enabled(job) || !frame.asset || frame.status !== "approved" || frame.approvalMethod !== "visual" || frame.approvedRevision !== frame.revision || frame.approvedTruthRevision !== productTruthRevision(project, job.payload.artifacts.productLock)) return false;
    const key = visualRevision(job, project, { kind: "frame", unitId: frame.unitId, path: frame.asset.path, revision: frame.revision });
    const record = job.payload.visualReview.records[key];
    return frame.visualRecord === key && record?.detailPolicy === FRAME_DETAIL_POLICY && visualPass(record);
  }
  async frames(job, project) {
    const gate = job.payload.keyframeGate;
    const pendingUnits = job.payload.artifacts.units.slice(job.payload.index || 0).map(u => u.id);
    for (const frame of gate.frames.filter(f => pendingUnits.includes(f.unitId))) {
      if (!frame.asset) return false;
      if (this.framePassed(job, project, frame)) continue;
      const unit = job.payload.artifacts.units.find(u => u.id === frame.unitId);
      const record = await this.check(job, project, { kind: "frame", unitId: unit.id, path: frame.asset.path, revision: frame.revision }, unit);
      if (!record) return false;
      if (!visualPass(record)) { await this.state(job.id, "paused", `${unit.id} 关键帧扫描发现差异，请修正后重新扫描`); return false; }
      await this.store.mutate(data => {
        const j = data.jobs[job.id]; if (j?.status !== "running") return;
        const g = j.payload.keyframeGate, f = g.frames.find(f => f.unitId === frame.unitId);
        if (f.revision !== frame.revision) return;
        g.version = KEYFRAME_REVIEW_VERSION; g.truthRevision = productTruthRevision(project, j.payload.artifacts.productLock);
        Object.assign(f, { status: "approved", approvedRevision: f.revision, approvedTruthRevision: g.truthRevision, approvedAt: now(), checks: reviewChecks(g).map(c => c.id), approvalMethod: "visual", visualRecord: record.key });
      });
    }
    await this.state(job.id, "paused", "关键帧智能核对通过，可确认费用并开始视频");
    return false;
  }
  async output(job, project) {
    if (job.payload.visualReview.reviewVideo !== true) return true;
    for (const unit of job.payload.artifacts.units) {
      const video = job.payload.checkpoints?.[unit.id]?.video;
      if (!video) { await this.state(job.id, "paused", "视频文件未保存完整，无法自动核对"); return false; }
      // All shot-boundary samples are checked in bounded batches. Unclear
      // batches receive one denser pass, without regenerating paid media.
      const batches = this.sampleBatches(unit);
      for (let batch = 0; batch < batches; batch++) {
        let record = await this.check(job, project, { kind: "video", unitId: unit.id, path: video.path, batch, dense: false }, unit);
        if (!record) return false;
        if (record.status === "review" && record.report.issues.every(i => i.status === "unclear")) {
          record = await this.check(job, project, { kind: "video", unitId: unit.id, path: video.path, batch, dense: true }, unit);
          if (!record) return false;
        }
        if (record.status !== "passed") { await this.state(job.id, "paused", `${unit.id} 视频核对发现差异，请查看具体画面`); return false; }
      }
    }
    await this.store.mutate(data => {
      const j = data.jobs[job.id], t = data.appState.tasks.find(t => t.id === job.id);
      if (j?.status !== "running") return;
      j.payload.visualReview.outputApprovedAt = now();
      t.visualReviewRequired = false; t.outputReviewRequired = false;
      t.currentItem = "视频抽帧核对通过，正在归档";
    });
    return this.store.getJob(job.id)?.status === "running";
  }
}

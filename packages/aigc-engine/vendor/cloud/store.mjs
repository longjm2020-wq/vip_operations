import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { registerTemplate } from "./template-library.mjs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fail, assertNoPendingRequests, releaseUnsubmitted } from "./access.mjs";
import { cleanProjectCast } from "./asset-library.mjs";
import { cleanSceneSelection } from "../shared/scene-catalog.mjs";
import { projectWithCast } from "../shared/project-cast.mjs";
import { archiveDetailWorks } from "./detail-works.mjs";
import { cleanEnhancement } from "./generation-enhancement.mjs";
import { assertDetailProjectIdle, detailProjectAssetPaths } from "./detail-projects.mjs";

function now() {
  return new Date().toISOString();
}

function clone(value) {
  return structuredClone(value);
}

function defaultAppState() {
  return {
    projects: [],
    works: [],
    modelLibrary: [],
    tasks: [],
    accounts: {
      chatgpt: { service: "chatgpt", status: "unknown" },
      grok: { service: "grok", status: "unknown" },
    },
    settings: {
      theme: "dark",
      autoTriggerWhenReady: false,
      revealBrowserDuringAutomation: false,
      chatgptFastUpload: true,
      chatgptExtremeFastUpload: false,
      downloadRoot: "云端项目存储",
    },
    learningCases: [],
  };
}

function defaultData(kernel) {
  return {
    schema: "xuti-cloud-state/v1",
    createdAt: now(),
    updatedAt: now(),
    appState: defaultAppState(),
    assets: {},
    pendingAssetDeletions: [],
    assetLibrary: [],
    jobs: {},
    kernel: clone(kernel),
  };
}

function safeName(name) {
  const cleaned = String(name || "asset").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return (cleaned || "asset").slice(0, 180);
}

/**
 * Project assets are stored as a small flat shape in the persisted state. Keep
 * the traversal in one place so source cleanup cannot accidentally overlook an
 * optional input such as a C template or user information file.
 */
function projectAssetPaths(project) {
  const assets = project?.assets ?? {};
  return new Set([
    assets.video?.path,
    ...(assets.referenceVideos ?? []).map(item => item?.path),
    ...(assets.referenceAudios ?? []).map(item => item?.path),
    ...(assets.modelImages ?? []).map((item) => item?.path),
    ...(assets.productImages ?? []).map((item) => item?.path),
    ...(assets.sceneImages ?? []).map((item) => item?.path),
    assets.customInput?.path,
    assets.reusableTemplate?.path,
    ...(project?.cast?.roles || []).flatMap(r => r.images || []).map(f => f.path),
    ...(project?.cast?.products || []).flatMap(p => p.images || []).map(f => f.path),
  ].filter((value) => typeof value === "string" && value));
}

function withoutProjectAssets(project, paths) {
  const assets = project?.assets ?? {};
  const keep = (item) => !item || !paths.has(item.path);
  return {
    ...project,
    ...(project.cast ? { cast: { roles: project.cast.roles.map(r => ({ ...r, images: r.images.filter(keep) })), products: project.cast.products.map(p => ({ ...p, images: p.images.filter(keep) })) } } : {}),
    assets: {
      ...assets,
      video: keep(assets.video) ? assets.video : undefined,
      referenceVideos: (assets.referenceVideos ?? []).filter(keep),
      referenceAudios: (assets.referenceAudios ?? []).filter(keep),
      modelImages: (assets.modelImages ?? []).filter(keep),
      productImages: (assets.productImages ?? []).filter(keep),
      sceneImages: (assets.sceneImages ?? []).filter(keep),
      customInput: keep(assets.customInput) ? assets.customInput : undefined,
      reusableTemplate: keep(assets.reusableTemplate) ? assets.reusableTemplate : undefined,
    },
  };
}

function scrubJobAssetReferences(payload, paths) {
  if (!payload || typeof payload !== "object") return payload;
  const next = clone(payload);
  if (next.inputProject?.assets) next.inputProject = withoutProjectAssets(next.inputProject, paths);
  if (next.artifacts?.referenceSnapshot?.assets) {
    next.artifacts.referenceSnapshot = withoutProjectAssets(next.artifacts.referenceSnapshot, paths);
  }
  if (next.keyframeGate?.frames) {
    next.keyframeGate.frames = next.keyframeGate.frames.map(frame => ({ ...frame,
      ...(paths.has(frame.asset?.path) ? { asset: undefined, purged: true } : {}),
      history: (frame.history || []).filter(item => !paths.has(item.asset?.path)),
    }));
  }
  return next;
}

/**
 * A single-process durable store. Railway runs one web/worker process for
 * this application, so serialising every state change provides atomic project
 * and task updates without exposing provider credentials to the browser.
 */
export class CloudStore {
  constructor({ dataDir, kernel, persistence }) {
    this.dataDir = path.resolve(dataDir);
    this.assetsDir = path.join(this.dataDir, "assets");
    this.uploadsDir = path.join(this.dataDir, "uploads");
    this.previewsDir = path.join(this.dataDir, "previews");
    this.statePath = path.join(this.dataDir, "state.json");
    this.kernel = kernel;
    this.persistence = persistence;
    this.data = null;
    this.serial = Promise.resolve();
    this.lastClaimedOwnerId = null;
  }

  async init() {
    await Promise.all([
      mkdir(this.assetsDir, { recursive: true }),
      mkdir(this.uploadsDir, { recursive: true }),
      mkdir(this.previewsDir, { recursive: true }),
    ]);
    try {
      const parsed = this.persistence ? await this.persistence.readState() : JSON.parse(await readFile(this.statePath, "utf8"));
      if (!parsed || parsed.schema !== "xuti-cloud-state/v1") throw new Error("unsupported state schema");
      this.data = parsed;
      this.data.appState ??= defaultAppState();
      this.data.appState.learningCases ??= [];
      this.data.assets ??= {};
      this.data.pendingAssetDeletions ??= [];
      this.data.jobs ??= {};
      // Older compile/generation jobs omitted ownerId even though their
      // project has an owner. Restore ownership before serving account-scoped
      // queues and the administrator's pending-charge reconciliation list.
      const projectOwners = new Map((this.data.appState.projects || []).map(project => [project.id, project.ownerId]));
      for (const task of this.data.appState.tasks || []) task.ownerId ??= projectOwners.get(task.projectId);
      for (const job of Object.values(this.data.jobs)) job.ownerId ??= projectOwners.get(job.projectId);
      this.data.kernel ??= clone(this.kernel);
      if (this.data.kernel.sha256 !== this.kernel.sha256 && ["cloud-baseline", "cloud-product-keyframe-v1", "cloud-identity-product-v2", "cloud-product-spatial-v1", "cloud-a-v3.2.18-adapter-v1", "cloud-fidelity-v2", "cloud-visual-preflight-v1", "cloud-visual-view-choice-v2"].includes(this.data.kernel.revisions?.find(r => r.active)?.id)) {
        this.data.kernel = { ...clone(this.kernel), revisions: [...clone(this.kernel.revisions), ...this.data.kernel.revisions.map(r => ({ ...r, active: false }))] };
      }

      // A process crash must not strand an in-memory lease forever. The next
      // worker tick resumes provider polling with the saved request id. An
      // OpenRouter Responses call is deliberately different: that API is
      // stateless, so an in-flight call has no durable ID to retrieve. Pause it
      // for explicit confirmation instead of risking a duplicate paid request.
      for (const job of Object.values(this.data.jobs)) {
        if (job.status === "running") {
          const openRouterInFlight = (!job.providerRequestId && job.payload?.compileSubmission?.state === "inflight") || (job.type === "generate" && !job.providerRequestId && job.payload?.videoSubmission?.state === "inflight") || job.payload?.keyframeGate?.frames?.some(f => f.submission?.state === "inflight" && !f.requestId) || Object.values(job.payload?.visualReview?.records || {}).some(r => r.status === "inflight" && !r.requestId && !r.receipt);
          job.status = openRouterInFlight ? "paused" : (job.providerRequestId ? "waiting_provider" : "queued");
          job.nextRunAt = Date.now();
          job.updatedAt = now();
          if (openRouterInFlight) {
            const task = this.data.appState.tasks.find((item) => item.id === job.taskId);
            if (task) {
              task.stage = "attention";
              task.error = "服务重启发生在供应商回包前；为避免重复计费，任务没有自动重提。";
              task.currentItem = "待核实供应商结果";
              task.updatedAt = now();
              task.logs ??= [];
              task.logs.push({ at: now(), level: "warning", message: "服务重启发生在供应商回包前；为避免重复计费，任务不会自动重提，也不能直接继续。须由超级管理员核实供应商请求与账务，再重新建立任务。" });
              if (task.logs.length > 160) task.logs.splice(0, task.logs.length - 160);
            }
          }
        }
      }
      for (const detail of Object.values(this.data.detailJobs || {})) if (detail.status === "inflight") {
        detail.status = "uncertain";
        detail.error = "服务重启发生在供应商回包前；请核对原请求，任务不会自动重提。";
        if (this.data.jobs[detail.id]) this.data.jobs[detail.id].status = "paused";
      }
      // Recover holds left by older versions when an ended or failed job was
      // removed from the queue before its never-submitted quote was released.
      if (this.data.platform?.version === 2) for (const job of Object.values(this.data.jobs)) {
        const project = this.data.appState.projects.find(item => item.id === job.projectId);
        if (["failed", "cancelled"].includes(job.status) || project?.status === "ended") releaseUnsubmitted(this.data, job.id);
      }
      archiveDetailWorks(this.data);
      await this.#write();
    } catch (error) {
      // Never overwrite unreadable account balances or ownership records.
      if (error?.code !== "ENOENT") throw error;
      this.data = defaultData(this.kernel);
      await this.#write();
    }
    await this.#flushAssetDeletions();
  }

  async #flushAssetDeletions() {
    const completed = [];
    for (const item of this.data.pendingAssetDeletions || []) {
      // Names are generated by us, never taken from an upload filename.
      if (!/^[0-9a-f-]{36}\.bin$/i.test(item.storageName) || !/^[0-9a-f-]{36}$/i.test(item.id)) continue;
      try {
        await unlink(path.join(this.assetsDir, item.storageName)).catch(error => { if (error.code !== "ENOENT") throw error; });
        await unlink(path.join(this.previewsDir, `${item.id}.webp`)).catch(error => { if (error.code !== "ENOENT") throw error; });
        completed.push(item.id);
      } catch { /* Retry on the next delete or process start. */ }
    }
    if (completed.length) await this.mutate(data => {
      data.pendingAssetDeletions = (data.pendingAssetDeletions || []).filter(item => !completed.includes(item.id));
    });
    return !(this.data.pendingAssetDeletions || []).length;
  }

  async #withLock(action) {
    let release;
    const previous = this.serial;
    this.serial = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  async #write(data = this.data) {
    data.updatedAt = now();
    if (this.persistence) { await this.persistence.writeState(data, this.assetsDir); return; }
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { encoding: "utf8", mode: 0o600, flush: true });
    await rename(temporary, this.statePath);
  }

  async mutate(action) {
    return this.#withLock(async () => {
      const draft = clone(this.data);
      const value = await action(draft);
      // Worker-created records inherit their project's owner, never a caller's
      // role or the currently signed-in browser session.
      if (draft.platform) {
        for (const list of [draft.appState.tasks, draft.appState.works, draft.appState.learningCases, Object.values(draft.jobs)]) {
          for (const item of list || []) item.ownerId ??= draft.appState.projects.find(p => p.id === item.projectId)?.ownerId;
        }
      }
      await this.#write(draft);
      this.data = draft;
      return value === undefined ? undefined : clone(value);
    });
  }

  async claimNextJob({ excludedOwnerIds = [] } = {}) {
    return this.#withLock(async () => {
      const timestamp = Date.now();
      const excluded = new Set(excludedOwnerIds);
      const candidates = Object.values(this.data.jobs)
        .filter((job) => ["queued", "waiting_provider"].includes(job.status) && (job.nextRunAt ?? 0) <= timestamp && !excluded.has(job.ownerId))
        .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
      // Rotate account ownership between claims so one user's backlog does
      // not indefinitely delay other users when all execution slots are full.
      const job = candidates.find(candidate => candidate.ownerId !== this.lastClaimedOwnerId) || candidates[0];
      if (!job) return null;
      const draft = clone(this.data), claimed = draft.jobs[job.id];
      claimed.status = "running";
      claimed.updatedAt = now();
      claimed.leaseUntil = timestamp + 60_000;
      await this.#write(draft);
      this.data = draft;
      this.lastClaimedOwnerId = claimed.ownerId;
      return clone(claimed);
    });
  }

  getAppState(ownerId) {
    if (!ownerId) return clone(this.data.appState);
    // Scope before deep-copying: one user's page load must not copy every
    // other user's projects, task logs and compiled content into memory.
    const state = { ...this.data.appState };
    for (const key of ["projects", "works", "modelLibrary", "tasks", "learningCases"]) state[key] = (state[key] || []).filter(item => item.ownerId === ownerId);
    state.tasks = state.tasks.filter(task => !task.hiddenFromQueueAt);
    state.settings = this.data.platform?.settings[ownerId] || defaultAppState().settings;
    delete state.pendingProjectDeletions;
    return clone(state);
  }

  getTasks(ownerId) {
    const recycled = new Set(this.data.appState.projects.filter(p => p.deletedAt).map(p => p.id));
    return clone(this.data.appState.tasks.filter(t => !ownerId || t.ownerId === ownerId && !recycled.has(t.projectId) && !t.hiddenFromQueueAt));
  }

  getJob(id) {
    const job = this.data.jobs[id];
    return job ? clone(job) : null;
  }

  getKernel() {
    return clone(this.data.kernel);
  }

  getAssetMetadata(id) {
    const item = this.data.assets[id];
    return item ? clone(item) : null;
  }

  /** A one-use staging name used by the streaming HTTP upload route. */
  createUploadTempPath() {
    return path.join(this.uploadsDir, `${randomUUID()}.part`);
  }

  getPreviewPath(id) {
    const metadata = this.getAssetMetadata(id);
    return metadata ? path.join(this.previewsDir, `${metadata.id}.webp`) : null;
  }

  async openAsset(id) {
    const metadata = this.getAssetMetadata(id);
    if (!metadata) return null;
    const filePath = path.join(this.assetsDir, metadata.storageName);
    if (this.persistence) await this.persistence.hydrate(metadata, filePath);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return null;
      return { metadata, filePath, size: info.size };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async readAsset(id) {
    const asset = await this.openAsset(id);
    if (!asset) return null;
    try {
      const buffer = await readFile(asset.filePath);
      return { metadata: asset.metadata, buffer };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async putAsset({ buffer, name, kind, mime = "application/octet-stream", projectId, source = "upload", ownerId }) {
    const id = randomUUID();
    const storageName = `${id}.bin`;
    const metadata = {
      id,
      storageName,
      name: safeName(name),
      kind,
      mime,
      size: buffer.byteLength,
      projectId: projectId ?? null,
      ownerId: ownerId || this.data.appState.projects.find(p => p.id === projectId)?.ownerId,
      source,
      createdAt: now(),
    };
    await writeFile(path.join(this.assetsDir, storageName), buffer, { mode: 0o600 });
    await this.mutate((data) => { data.assets[id] = metadata; registerTemplate(data, metadata); });
    return { path: id, name: metadata.name, size: metadata.size, kind: metadata.kind, mime: metadata.mime };
  }

  async copyAsset(id, { projectId, source, ownerId }) {
    const original = await this.openAsset(id);
    if (!original || original.metadata.ownerId !== ownerId) fail("图片不存在或不属于当前账号", 404);
    const assetId = randomUUID(), storageName = `${assetId}.bin`, target = path.join(this.assetsDir, storageName);
    await copyFile(original.filePath, target);
    try {
      return await this.mutate(data => {
        if (!data.assets[id] || data.assets[id].ownerId !== ownerId) fail("图片已删除，请重新选择", 409);
        const metadata = { ...original.metadata, id: assetId, storageName, ownerId, source, projectId: projectId || null, createdAt: now() };
        delete metadata.libraryId;
        data.assets[assetId] = metadata;
        return { path: assetId, name: metadata.name, size: metadata.size, kind: metadata.kind, mime: metadata.mime };
      });
    } catch (error) { await unlink(target).catch(() => undefined); throw error; }
  }

  async discardLibraryAssets(ids, ownerId) {
    if (!ids.length) return;
    const removed = await this.mutate(data => {
      const referenced = new Set((data.assetLibrary || []).flatMap(e => e.images.map(f => f.path)));
      for (const entry of data.detailAssetLibrary || []) for (const image of entry.images) referenced.add(image.path);
      for (const project of Object.values(data.detailProjects || {})) {
        const snapshots = [project, ...(project.versions || []).map(version => version.snapshot)];
        for (const snapshot of snapshots) {
          for (const ids of Object.values(snapshot?.assets || {})) for (const id of ids) referenced.add(id);
          for (const module of snapshot?.modules || []) for (const ids of Object.values(module.asset_bindings || {})) for (const id of ids) referenced.add(id);
        }
      }
      for (const project of data.appState.projects) for (const id of projectAssetPaths(project)) referenced.add(id);
      const files = [];
      for (const id of ids) {
        const meta = data.assets[id];
        if (meta?.ownerId === ownerId && ["library", "library-draft"].includes(meta.source) && !referenced.has(id)) { files.push(meta); delete data.assets[id]; }
      }
      return files;
    });
    for (const meta of removed) { await unlink(path.join(this.assetsDir, meta.storageName)).catch(() => undefined); await unlink(path.join(this.previewsDir, `${meta.id}.webp`)).catch(() => undefined); }
  }

  /**
   * Commit a file already streamed into the private uploads directory. This
   * keeps large browser uploads out of Node's heap and uses an atomic move on
   * Railway's mounted volume.
   */
  async putAssetFromUpload({ tempPath, name, kind, mime = "application/octet-stream", projectId, source = "upload", ownerId, mediaInfo }) {
    const sourcePath = path.resolve(tempPath);
    const uploadsRoot = `${this.uploadsDir}${path.sep}`;
    if (!sourcePath.startsWith(uploadsRoot)) throw new Error("无效的上传暂存文件");
    const sourceInfo = await stat(sourcePath);
    if (!sourceInfo.isFile()) throw new Error("上传暂存文件不存在");

    const id = randomUUID();
    const storageName = `${id}.bin`;
    const targetPath = path.join(this.assetsDir, storageName);
    const metadata = {
      id,
      storageName,
      name: safeName(name),
      kind,
      mime,
      size: sourceInfo.size,
      ...(mediaInfo ? { mediaInfo: clone(mediaInfo) } : {}),
      projectId: projectId ?? null,
      ownerId: ownerId || this.data.appState.projects.find(p => p.id === projectId)?.ownerId,
      source,
      createdAt: now(),
    };

    await rename(sourcePath, targetPath);
    try {
      await this.mutate((data) => { data.assets[id] = metadata; registerTemplate(data, metadata); });
    } catch (error) {
      await unlink(targetPath).catch(() => undefined);
      throw error;
    }
    return { path: id, name: metadata.name, size: metadata.size, kind: metadata.kind, mime: metadata.mime, ...(metadata.mediaInfo ? { mediaInfo: metadata.mediaInfo } : {}) };
  }

  async putTextAsset({ name, text, kind = "output", projectId, mime = "application/json" }) {
    return this.putAsset({
      buffer: Buffer.from(text, "utf8"),
      name,
      kind,
      projectId,
      mime,
      source: "generated",
    });
  }

  async saveProject(project, ownerId) {
    return this.mutate((data) => {
      const state = data.appState;
      const timestamp = now();
      const existing = state.projects.find(p => p.id === project.id);
      if (ownerId && existing && existing.ownerId !== ownerId) fail("项目不存在", 404);
      if (ownerId && existing?.deletedAt) fail("请先从回收站恢复项目", 409);
      let saved = { ...clone(project), updatedAt: timestamp };
      if (ownerId) {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(project.id || "")) fail("项目编号无效");
        if (!existing && state.projects.filter(p => p.ownerId === ownerId && !p.deletedAt).length >= 100) fail("当前账号项目数已达 100，请先整理已有项目");
        if (Object.values(data.jobs).some(j => j.projectId === project.id && !["completed", "failed", "cancelled"].includes(j.status))) fail("项目有未完成任务，请先完成或取消任务再修改素材", 409);
        const file = (value, kinds) => {
          if (!value) return undefined;
          const a = data.assets[value.path];
          if (!a || a.ownerId !== ownerId || !kinds.includes(a.kind) || ["payment-qr", "payment-proof", "library"].includes(a.source)) fail("素材不存在或不属于当前项目，请从资产库重新加入", 404);
          if (["referenceVideo", "referenceAudio"].includes(a.kind) && (a.projectId !== project.id || a.source !== "upload")) fail("生成参考素材不属于当前项目", 404);
          // Claim temporary editor uploads in the same transaction as the project.
          // A failed validation leaves them as disposable drafts, never library entries.
          if (a.source === "library-draft") {
            if (!["model", "product"].includes(a.kind) || a.libraryId || a.projectId) fail("素材暂存状态已变化，请重新上传", 409);
          }
          return { path: a.id, name: a.name, kind: a.kind, size: a.size, mime: a.mime, ...(a.mediaInfo ? { mediaInfo: clone(a.mediaInfo) } : {}) };
        };
        const files = (values, kind) => { if (!Array.isArray(values) || values.length > 50) fail("素材列表无效"); return values.map(v => { if (!v) fail("素材无效"); return file(v, [kind]); }); };
        const measurements = values => { if (!Array.isArray(values) || values.length > 50) fail("测量信息无效"); return values.map(v => ({ id: String(v.id || randomUUID()).slice(0, 128), label: String(v.label || "").slice(0, 100), value: String(v.value || "").slice(0, 500), unit: String(v.unit || "").slice(0, 30) })); };
        if (!["reference", "smart", "custom", "keywords"].includes(project.sceneMode) || !["complete", "relative"].includes(project.replicationMode) || !["auto", "2:3", "3:2", "1:1", "9:16", "16:9"].includes(project.videoAspectRatio)) fail("项目设置无效");
        saved = { id: project.id, ownerId, name: String(project.name || "新项目").slice(0, 120), createdAt: existing?.createdAt || timestamp, updatedAt: timestamp, status: existing?.status || "draft", replicationMode: project.replicationMode, sceneMode: project.sceneMode, sceneSelection: cleanSceneSelection(project.sceneSelection), videoAspectRatio: project.videoAspectRatio, resolvedVideoAspectRatio: existing?.resolvedVideoAspectRatio, platform: "grok", modelMeasurements: measurements(project.modelMeasurements), productMeasurements: measurements(project.productMeasurements), assets: { video: file(project.assets?.video, ["video"]), modelImages: files(project.assets?.modelImages, "model"), productImages: files(project.assets?.productImages, "product"), sceneImages: files(project.assets?.sceneImages, "scene"), customInput: file(project.assets?.customInput, ["text"]), reusableTemplate: file(project.assets?.reusableTemplate, ["template", "output"]) }, saveReusableTemplate: project.saveReusableTemplate === true, notes: String(project.notes || "").slice(0, 10000), outputDir: `云端项目/${project.id}/输出`, imageSelection: project.imageSelection ? { modelId: String(project.imageSelection.modelId) } : undefined, videoSelection: project.videoSelection ? { providerId: String(project.videoSelection.providerId), modelId: String(project.videoSelection.modelId), resolution: String(project.videoSelection.resolution) } : undefined, compileTaskId: existing?.compileTaskId, sourceAssetsPurgedAt: existing?.sourceAssetsPurgedAt };
        saved.assets.referenceVideos = files(project.assets?.referenceVideos || [], "referenceVideo");
        saved.videoEnhancement = cleanEnhancement(project.videoEnhancement);
        saved.assets.referenceAudios = files(project.assets?.referenceAudios || [], "referenceAudio");
        const depthReferences = saved.assets.referenceVideos.filter(f => f.mediaInfo?.referenceType === "depth");
        if (depthReferences.some(f => f.mediaInfo.sourceAssetId !== saved.assets.video?.path)) fail("深度参考对应的原片已变化，请先移除旧深度参考", 409);
        if (depthReferences.length && saved.assets.referenceVideos.length !== 1) fail("原片深度参考不能与自定义视频同时使用，请先移除其中一种", 400);
        if (project.cast !== undefined) saved = projectWithCast(saved, cleanProjectCast(project.cast, file));
        for (const id of projectAssetPaths(saved)) {
          const asset = data.assets[id];
          if (asset?.source === "library-draft") {
            asset.source = "upload";
            asset.projectId = saved.id;
          }
        }
      }
      // Adding fresh inputs starts a new run. A previous completion marker must
      // not make the UI claim that these new uploads have already been purged.
      const hasRawUpload = [...projectAssetPaths(saved)].some((id) => data.assets[id]?.source === "upload");
      if (saved.status !== "completed" || hasRawUpload) delete saved.sourceAssetsPurgedAt;
      const index = state.projects.findIndex((item) => item.id === saved.id);
      if (index >= 0 && state.projects[index].status === "ended") saved.status = "ended";
      if (index >= 0) state.projects[index] = saved;
      else state.projects.unshift(saved);
      return saved;
    });
  }

  /**
   * Project copies are task-scoped; explicitly saved personal library images
   * use separate ids and are retained until deleted by their owner. Once a project's video
   * task has fully completed, preserve only generated B/C/video outputs and
   * wipe every original upload from the mounted volume (and its cached preview).
   *
   * An older project may have shared a source asset with another unfinished
   * project through the former cloud asset library. In that rare case the
   * completed project is still detached immediately, while the binary remains
   * only until the unfinished project releases it. New cloud projects do not
   * expose that persistent asset-library path.
   */
  async purgeCompletedProjectSources(projectId) {
    return this.#withLock(async () => {
      const state = this.data.appState;
      const currentIndex = state.projects.findIndex((item) => item.id === projectId);
      const current = state.projects[currentIndex];
      if (!current || current.status !== "completed") {
        return { completed: false, deleted: 0, deferred: 0, referencesCleared: 0, redactedTemplates: 0 };
      }

      const sourcePaths = new Set();
      for (const id of projectAssetPaths(current)) {
        if (["upload", "keyframe-upload"].includes(this.data.assets[id]?.source) && this.data.assets[id]?.kind !== "template") sourcePaths.add(id);
      }
      // New browser uploads are tagged with a project id. Include files that a
      // user replaced or removed during the run so they cannot become orphans.
      for (const metadata of Object.values(this.data.assets)) {
        if (["upload", "keyframe-upload"].includes(metadata?.source) && metadata.kind !== "template" && metadata.projectId === projectId) sourcePaths.add(metadata.id);
      }

      const activeReferences = new Set();
      for (const project of state.projects) {
        if (project.id === projectId || project.status === "completed") continue;
        for (const id of projectAssetPaths(project)) activeReferences.add(id);
      }
      const deferredPaths = new Set([...sourcePaths].filter((id) => activeReferences.has(id)));
      const deletePaths = [...sourcePaths].filter((id) => !deferredPaths.has(id));
      const timestamp = now();

      // Completed projects and finished job snapshots no longer need source
      // references. Removing them keeps the state file from preserving asset
      // names/ids after the binaries have been deleted.
      let referencesCleared = 0;
      state.projects = state.projects.map((project) => {
        if (project.status !== "completed") return project;
        const before = projectAssetPaths(project);
        const next = withoutProjectAssets(project, sourcePaths);
        for (const id of sourcePaths) if (before.has(id)) referencesCleared += 1;
        if (project.id === projectId) next.sourceAssetsPurgedAt = timestamp;
        return next;
      });

      for (const job of Object.values(this.data.jobs)) {
        if (job.status !== "completed") continue;
        job.payload = scrubJobAssetReferences(job.payload, sourcePaths);
      }

      // A cloud model profile would otherwise keep an original face image alive
      // after its source project completes. Drop only the affected images; empty
      // profiles are removed entirely. Active projects retain their own direct
      // references until they finish.
      state.modelLibrary = (state.modelLibrary ?? [])
        .map((profile) => ({ ...profile, images: (profile.images ?? []).filter((item) => !sourcePaths.has(item.path)), updatedAt: timestamp }))
        .filter((profile) => profile.images.length > 0);

      // Older generated C templates embedded only asset ids in input_snapshot.
      // Redact those ids too, leaving the reusable derived timeline/truth data.
      let redactedTemplates = 0;
      for (const metadata of Object.values(this.data.assets)) {
        if (metadata?.projectId !== projectId || metadata.source !== "generated" || metadata.mime !== "application/json") continue;
        const filePath = path.join(this.assetsDir, metadata.storageName);
        try {
          const parsed = JSON.parse(await readFile(filePath, "utf8"));
          if (parsed?.schema !== "XUTI_C_V1" || !parsed.input_snapshot) continue;
          delete parsed.input_snapshot;
          parsed.source_asset_policy = "原始上传素材仅在生成期间临时使用；项目完成后已从云端清理。";
          const text = JSON.stringify(parsed, null, 2);
          await writeFile(filePath, text, { encoding: "utf8", mode: 0o600 });
          metadata.size = Buffer.byteLength(text, "utf8");
          redactedTemplates += 1;
        } catch {
          // Raw inputs are still deleted below. A malformed historical C file
          // contains no raw bytes, so it must not block the privacy cleanup.
        }
      }

      for (const id of deletePaths) {
        const metadata = this.data.assets[id];
        if (!metadata) continue;
        await unlink(path.join(this.assetsDir, metadata.storageName)).catch(() => undefined);
        await unlink(path.join(this.previewsDir, `${metadata.id}.webp`)).catch(() => undefined);
        delete this.data.assets[id];
      }

      await this.#write();
      return {
        completed: true,
        deleted: deletePaths.length,
        deferred: deferredPaths.size,
        referencesCleared,
        redactedTemplates,
      };
    });
  }

  /** Reconcile projects that were already complete before this privacy rule shipped. */
  async purgeAllCompletedProjectSources() {
    const ids = this.data.appState.projects
      .filter((project) => project.status === "completed" && !project.sourceAssetsPurgedAt)
      .map((project) => project.id);
    const results = [];
    for (const id of ids) results.push(await this.purgeCompletedProjectSources(id));
    return results;
  }

  #assertProjectCanBeRemoved(data, id, ownerId) {
    const project = data.appState.projects.find(item => item.id === id && (!ownerId || item.ownerId === ownerId));
    if (!project) fail("项目不存在或不属于当前账号", 404);
    for (const job of Object.values(data.jobs).filter(item => item.projectId === id)) {
      assertNoPendingRequests(data, job.id);
      const submission = [job.payload?.compileSubmission, job.payload?.videoSubmission, ...((job.payload?.keyframeGate?.frames || []).map(frame => frame.submission))].some(item => ["inflight", "submitted"].includes(item?.state));
      if ((job.providerRequestId || submission) && !["completed", "failed", "cancelled"].includes(job.status)) fail("此项目有已提交但尚未确认结果的生成请求，请先等待或核实原请求", 409);
    }
    return project;
  }

  async trashProject(id, ownerId) {
    return this.mutate(data => {
      const project = this.#assertProjectCanBeRemoved(data, id, ownerId);
      if (Object.values(data.jobs).some(item => item.projectId === id && !["completed", "failed", "cancelled"].includes(item.status))) fail("请先结束项目的未完成任务", 409);
      if (project.deletedAt) fail("项目已在回收站", 409);
      const timestamp = now();
      project.deletedAt = timestamp;
      project.updatedAt = timestamp;
      for (const work of data.appState.works.filter(item => item.projectId === id && !item.deletedAt)) {
        work.deletedAt = timestamp;
        work.projectTrashedAt = timestamp;
      }
      for (const entry of data.templateLibrary?.entries || []) {
        if (entry.projectId !== id || !entry.recommendedAt) continue;
        entry.projectTrashedRecommendedAt = entry.recommendedAt;
        entry.recommendedAt = null;
      }
      return project;
    });
  }

  async restoreProject(id, ownerId) {
    return this.mutate(data => {
      const project = data.appState.projects.find(item => item.id === id && (!ownerId || item.ownerId === ownerId));
      if (!project) fail("项目不存在或不属于当前账号", 404);
      if (!project.deletedAt) fail("项目不在回收站", 409);
      delete project.deletedAt;
      project.updatedAt = now();
      for (const work of data.appState.works.filter(item => item.projectId === id && item.projectTrashedAt)) {
        delete work.deletedAt;
        delete work.projectTrashedAt;
      }
      for (const entry of data.templateLibrary?.entries || []) {
        if (entry.projectId !== id || !entry.projectTrashedRecommendedAt) continue;
        if (!entry.deletedAt) entry.recommendedAt = entry.projectTrashedRecommendedAt;
        delete entry.projectTrashedRecommendedAt;
      }
      return project;
    });
  }

  async deleteProject(id, ownerId) {
    const removed = await this.mutate(data => {
      const project = this.#assertProjectCanBeRemoved(data, id, ownerId);
      if (project.status === "completed" && !project.deletedAt) fail("已完成项目请先移入回收站", 409);
      if (project.deletedAt && Object.values(data.jobs).some(item => item.projectId === id && !["completed", "failed", "cancelled"].includes(item.status))) fail("请先结束项目的未完成任务", 409);
      const works = data.appState.works.filter(item => item.projectId === id);
      const candidates = new Set([
        ...projectAssetPaths(project),
        ...Object.values(data.assets).filter(item => item.projectId === id).map(item => item.id),
        ...works.flatMap(item => [item.cover?.path, item.reusableTemplate?.path, ...(item.videos || []).map(file => file.path)]),
      ].filter(Boolean));
      const retained = new Set([
        ...(data.templateLibrary?.entries || []).map(item => item.assetId),
        ...(data.assetLibrary || []).flatMap(item => (item.images || []).map(file => file.path)),
        ...data.appState.projects.filter(item => item.id !== id).flatMap(item => [...projectAssetPaths(item)]),
        ...data.appState.works.filter(item => item.projectId !== id).flatMap(item => [item.cover?.path, item.reusableTemplate?.path, ...(item.videos || []).map(file => file.path)]),
      ].filter(Boolean));
      const files = [...candidates].filter(assetId => !retained.has(assetId) && data.assets[assetId] && !["library", "payment-qr", "payment-proof"].includes(data.assets[assetId].source))
        .map(assetId => ({ id: assetId, storageName: data.assets[assetId].storageName }));
      for (const file of files) delete data.assets[file.id];
      data.pendingAssetDeletions ??= [];
      data.pendingAssetDeletions.push(...files);
      for (const job of Object.values(data.jobs).filter(item => item.projectId === id)) releaseUnsubmitted(data, job.id);
      data.appState.projects = data.appState.projects.filter(item => item.id !== id);
      data.appState.tasks = data.appState.tasks.filter(item => item.projectId !== id);
      data.appState.works = data.appState.works.filter(item => item.projectId !== id);
      data.appState.learningCases = data.appState.learningCases.filter(item => item.projectId !== id);
      for (const [jobId, job] of Object.entries(data.jobs)) if (job.projectId === id) delete data.jobs[jobId];
      return files.length;
    });
    const filesDeleted = await this.#flushAssetDeletions();
    return { filesDeleted, removedAssets: removed };
  }

  async deleteDetailProject(id, ownerId) {
    await this.mutate(data => {
      const project = data.detailProjects?.[id];
      if (!project || project.ownerId !== ownerId) fail("电商项目不存在", 404);
      if (!project.deletedAt) fail("请先将项目移入回收站", 409);
      assertDetailProjectIdle(data, project);
      const candidates = detailProjectAssetPaths({ ...project, jobs: project.jobs.map(job => data.detailJobs?.[job.id] || job) });
      const workPaths = work => [work.cover?.path, work.reusableTemplate?.path, ...(work.videos || []).map(file => file.path), ...(work.images || []).map(file => file.path)].filter(Boolean);
      for (const work of data.appState.works.filter(work => work.projectId === id)) for (const assetId of workPaths(work)) candidates.add(assetId);
      const retained = new Set([
        ...Object.values(data.detailProjects).filter(item => item.id !== id).flatMap(item => [...detailProjectAssetPaths(item)]),
        ...data.appState.projects.flatMap(item => [...projectAssetPaths(item)]),
        ...data.appState.works.filter(item => item.projectId !== id).flatMap(workPaths),
        ...(data.detailAssetLibrary || []).flatMap(item => item.images.map(file => file.path)),
        ...(data.assetLibrary || []).flatMap(item => item.images.map(file => file.path)),
        ...(data.templateLibrary?.entries || []).map(item => item.assetId),
      ]);
      const files = [...candidates].filter(assetId => !retained.has(assetId) && data.assets[assetId]?.ownerId === ownerId && !["library", "payment-qr", "payment-proof"].includes(data.assets[assetId].source)).map(assetId => ({ id: assetId, storageName: data.assets[assetId].storageName }));
      for (const file of files) delete data.assets[file.id];
      data.pendingAssetDeletions ||= []; data.pendingAssetDeletions.push(...files);
      data.appState.works = data.appState.works.filter(work => work.projectId !== id);
      for (const job of project.jobs) { releaseUnsubmitted(data, job.id); if (data.detailJobs) delete data.detailJobs[job.id]; delete data.jobs[job.id]; }
      delete data.detailProjects[id];
    });
    return { filesDeleted: await this.#flushAssetDeletions() };
  }

  async saveSettings(settings, ownerId) {
    return this.mutate((data) => {
      if (ownerId) {
        if (!["dark", "light", "system"].includes(settings.theme)) fail("主题设置无效");
        const next = { ...defaultAppState().settings, theme: settings.theme, autoTriggerWhenReady: settings.autoTriggerWhenReady === true };
        data.platform.settings[ownerId] = next;
        return next;
      }
      data.appState.settings = clone(settings);
      return data.appState.settings;
    });
  }

  async saveModelProfile(input) {
    return this.mutate((data) => {
      const timestamp = now();
      const profile = {
        id: randomUUID(),
        name: String(input.name || "人物资产"),
        images: clone(input.images || []),
        modelMeasurements: clone(input.modelMeasurements || []),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.appState.modelLibrary.unshift(profile);
      return profile;
    });
  }

  async deleteModelProfile(id) {
    return this.mutate((data) => {
      data.appState.modelLibrary = data.appState.modelLibrary.filter((item) => item.id !== id);
    });
  }

  async createSameStyleProject(workId) {
    return this.mutate((data) => {
      const work = data.appState.works.find((item) => item.id === workId && !item.deletedAt && !item.projectTrashedAt);
      if (!work?.reusableTemplate) throw new Error("该作品没有可复用 C 模板");
      const source = data.appState.projects.find((item) => item.id === work.projectId);
      if (!source) throw new Error("找不到该作品的来源项目");
      const timestamp = now();
      const id = randomUUID();
      const { sourceAssetsPurgedAt, ...sourceWithoutPurgedInputs } = clone(source);
      void sourceAssetsPurgedAt;
      const next = {
        ...sourceWithoutPurgedInputs,
        id,
        name: `${work.title} · 制作同款`,
        createdAt: timestamp,
        updatedAt: timestamp,
        status: "draft",
        compileTaskId: undefined,
        cast: undefined,
        assets: {
          modelImages: [],
          productImages: [],
          sceneImages: [],
          reusableTemplate: clone(work.reusableTemplate),
        },
        outputDir: `云端项目/${id}/输出`,
      };
      data.appState.projects.unshift(next);
      return next;
    });
  }

  async updateWork(id, action) {
    return this.mutate((data) => {
      const index = data.appState.works.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("未找到作品");
      const current = data.appState.works[index];
      if (data.appState.projects.some(project => project.id === current.projectId && project.deletedAt) || data.detailProjects?.[current.projectId]?.deletedAt || data.digitalHuman?.projects?.[current.projectId]?.deletedAt) fail("请先从项目回收站恢复项目", 409);
      const timestamp = now();
      let next;
      if (action === "favorite") next = { ...current, favorite: !current.favorite, updatedAt: timestamp };
      else if (action === "trash") next = { ...current, favorite: false, deletedAt: timestamp, updatedAt: timestamp };
      else if (action === "restore") {
        const { deletedAt, ...rest } = current;
        void deletedAt;
        next = { ...rest, updatedAt: timestamp };
      } else throw new Error("未知作品操作");
      data.appState.works[index] = next;
      return next;
    });
  }

  async removeWork(id) {
    return this.mutate((data) => {
      data.appState.works = data.appState.works.filter((item) => item.id !== id);
    });
  }

  async updateKernel(text, summary) {
    return this.mutate((data) => {
      const timestamp = now();
      const sha256 = Buffer.from(text).toString("base64url").slice(0, 32);
      const revision = {
        id: randomUUID(),
        version: data.kernel.version,
        createdAt: timestamp,
        summary: String(summary || "云端内核修订"),
        sha256,
        active: true,
      };
      data.kernel = {
        ...data.kernel,
        text,
        sha256,
        revisions: [revision, ...(data.kernel.revisions || []).map((item) => ({ ...item, active: false }))],
      };
      return data.kernel;
    });
  }

  async updateKernelRevisionSummary(id, summary) {
    return this.mutate((data) => {
      const revision = data.kernel.revisions?.find((item) => item.id === id);
      if (!revision) throw new Error("未找到内核修订");
      revision.summary = String(summary || "");
      return data.kernel;
    });
  }
}

import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { fail, requireRole, reserve, markSubmitted, settle, MICRO } from "./access.mjs";
import { MEDIA_LIMIT, OpenTalkingClient, remoteId, serviceUrl } from "./opentalking.mjs";
import { normalizeDigitalAudio, validateDigitalMedia } from "./digital-human-media.mjs";
import { DigitalGpuPower } from "./compshare-gpu.mjs";

const now = () => new Date().toISOString();
const active = op => ["submitting", "queued", "generating", "starting", "ready", "closing", "uncertain", "saving"].includes(op.status);
const settingsDefaults = { enabled: false, publicEnabled: false, realtimeEnabled: false, textEnabled: false, templates: [], ttsProvider: "", ttsModel: "", sttProvider: "", voices: [], videoCredits: 0, sessionCredits: 0, sessionMinutes: 5, maxTextLength: 1500 };
const cleanText = (value, max) => String(value || "").trim().slice(0, max);
const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const owned = (records, user, id) => { const record = records[id]; if (!record || record.ownerId !== user.id) fail("记录不存在或不属于当前账号", 404); return record; };
const fingerprint = async input => hash({ ...input, file: input.file ? { name: input.file.name, digest: createHash("sha256").update(Buffer.from(await input.file.arrayBuffer())).digest("hex") } : null });
function validateFile(file, types) {
  if (!file || typeof file.arrayBuffer !== "function" || !file.size) fail("请选择素材文件");
  if (!types.includes(file.type)) fail("不支持此素材格式");
  if (file.size > MEDIA_LIMIT) fail("单个素材须压缩至 10MB 以内再上传", 413);
}
const imageTypes = ["image/jpeg", "image/png", "image/webp"];
const videoTypes = ["video/mp4", "video/webm"];
const audioTypes = ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/webm", "video/webm"];

export class DigitalHumanService {
  constructor(store, config = {}, options = {}) {
    this.store = store; this.config = config; this.clientFactory = options.clientFactory || (settings => new OpenTalkingClient(settings)); this.busy = false; this.locks = new Set(); this.videoRefresh = new Set(); this.validating = new Set();
    this.gpu = new DigitalGpuPower(store, config.compshareGpu, { ...options.gpu, ready: async () => {
      if (!this.connection().baseUrl) return false;
      const result = await this.client().request("/models", { timeoutMs: 5000 });
      return (result.statuses || []).some(model => model.connected === true && model.backend !== "mock" && model.id !== "light2d");
    } });
  }
  get data() { return this.store.data.digitalHuman; }
  settings() { return { ...settingsDefaults, ...this.data?.settings }; }
  connection() { return { baseUrl: this.config.opentalkingBaseUrl || "", apiKey: this.config.opentalkingApiKey || "" }; }
  client() { return this.clientFactory(this.connection()); }
  async init() {
    await this.store.mutate(data => {
      data.digitalHuman ||= { settings: {}, projects: {}, avatars: {}, operations: {} };
      for (const op of Object.values(data.digitalHuman.operations)) if (op.status === "submitting") { op.status = "uncertain"; op.message = "提交时服务重启，正在等待核实原请求。"; }
    });
  }
  enabled(user) {
    const s = this.settings();
    return Boolean(this.connection().baseUrl && s.enabled);
  }
  assertEnabled(user) {
    if (!this.enabled(user)) fail("数字人服务暂未开放，请联系站长", 409);
    const current = this.store.data.platform?.users.find(item => item.id === user.id);
    if (this.store.data.platform && (!current || current.disabled)) fail("账号已停用", 403);
  }
  quote(user, type) {
    const s = this.settings(); const credits = 0;
    return { amount: 0, credits, kind: `digital_human_${type}`, pricingVersion: "internal", basis: type === "video" ? `口播视频（最多 ${s.maxTextLength} 字）` : `数字人对话（最多 ${s.sessionMinutes} 分钟）` };
  }
  template(id) { return this.settings().templates.find(item => item.id === id); }
  avatar(user, id) {
    const template = this.template(id);
    if (template) return { id: template.id, remoteId: template.id, model: template.model, name: template.label, shared: true };
    const value = owned(this.data.avatars, user, id);
    if (value.deletedAt) fail("此数字人形象已移除", 404);
    return value;
  }
  avatarDto(a) { return { id: a.id, name: a.name, shared: Boolean(a.shared), preview: a.preview, model: undefined }; }
  operationDto(op) {
    return { id: op.id, projectId: op.projectId, type: op.type, status: op.status, createdAt: op.createdAt, updatedAt: op.updatedAt, duration: op.duration || 0, output: op.output, message: op.message || "", expiresAt: op.expiresAt, credits: op.quote?.credits || 0 };
  }
  projectDto(p) {
    const operations = Object.values(this.data.operations).filter(op => op.projectId === p.id && op.ownerId === p.ownerId && op.type !== "avatar").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { id: p.id, name: p.name, mode: p.mode, avatarId: p.avatarId, text: p.text || "", voice: p.voice || "", createdAt: p.createdAt, updatedAt: p.updatedAt, deletedAt: p.deletedAt, operations: operations.map(op => this.operationDto(op)) };
  }
  projects(user) { return Object.values(this.data.projects).filter(p => p.ownerId === user.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(p => this.projectDto(p)); }
  summaries(user) {
    return this.projects(user).map(p => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, deletedAt: p.deletedAt, mode: p.mode, status: p.operations.some(op => op.status === "uncertain") ? "attention" : p.operations.some(active) ? "generating" : p.operations.some(op => op.output) ? "completed" : "draft", activeJobs: p.operations.filter(active).length, completedCount: p.operations.filter(op => op.output).length, cover: this.data.avatars[p.avatarId]?.preview }));
  }
  catalog(user) {
    const s = this.settings();
    const capabilities = { realtimeEnabled: Boolean(s.realtimeEnabled), textEnabled: Boolean(s.textEnabled) };
    const shared = s.templates.map(t => this.avatarDto({ id: t.id, name: t.label, shared: true }));
    return { ...capabilities, enabled: this.enabled(user), configured: Boolean(this.connection().baseUrl), avatars: [...shared, ...Object.values(this.data.avatars).filter(a => a.ownerId === user.id && !a.deletedAt).map(a => this.avatarDto(a))], voices: s.voices, maxTextLength: s.maxTextLength, maxFileBytes: MEDIA_LIMIT, sessionMinutes: s.sessionMinutes, videoCredits: this.quote(user, "video").credits, sessionCredits: this.quote(user, "session").credits, templates: shared, internal: user.role === "super_admin", operations: Object.values(this.data.operations).filter(op => op.ownerId === user.id && op.type === "avatar" && active(op)).map(op => this.operationDto(op)) };
  }
  admin(user) {
    requireRole(user, ["super_admin"]);
    const { apiKey, ...settings } = this.settings();
    return { ...settings, baseUrl: this.connection().baseUrl, keyConfigured: Boolean(this.connection().apiKey), checkedAt: this.data.checkedAt, availableTemplates: this.data.availableTemplates || [], operations: Object.values(this.data.operations).filter(op => op.status === "uncertain").map(op => ({ ...this.operationDto(op), ownerId: op.ownerId, remoteId: op.remoteId })) };
  }
  async preflight(user) {
    requireRole(user, ["super_admin"]);
    const connection = this.connection();
    const c = await this.clientFactory(connection).catalog();
    const realModels = new Set((c.models.statuses || []).filter(s => s.connected === true && s.backend !== "mock").map(s => s.id));
    const templates = c.avatars.filter(a => !a.is_custom && a.person_mode !== "double" && realModels.has(a.model_type) && a.model_type !== "light2d").map(a => ({ id: decodeURIComponent(remoteId(a.id)), label: cleanText(a.name || a.id, 80), model: cleanText(a.model_type, 64) }));
    await this.store.mutate(data => { data.digitalHuman.availableTemplates = templates; data.digitalHuman.checkedAt = now(); data.digitalHuman.checkedConnection = hash(connection); });
    return { ok: true, templates, models: c.models.models, checkedAt: this.data.checkedAt };
  }
  async saveSettings(user, input) {
    requireRole(user, ["super_admin"]);
    if (input.apiKey || input.baseUrl) fail("请通过 AIGC 服务设置保存连接信息", 400);
    const previous = this.settings(); const baseUrl = this.connection().baseUrl;
    if (typeof input.enabled !== "boolean" || typeof input.publicEnabled !== "boolean") fail("请设置服务开放开关");
    const numeric = (key, min, max) => { const n = input[key]; if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) fail(`${key} 超出允许范围`); return n; };
    const templates = Array.isArray(input.templates) ? input.templates.slice(0, 30).map(t => { remoteId(t.id); if (!/^[a-z0-9_-]{1,64}$/.test(t.model) || ["mock", "light2d"].includes(t.model)) fail("请选择支持服务端视频渲染的真实模型"); return { id: t.id, model: t.model, label: cleanText(t.label || t.id, 80) }; }) : [];
    const voices = Array.isArray(input.voices) ? input.voices.slice(0, 30).map(v => ({ id: cleanText(v.id, 150), label: cleanText(v.label, 80) })).filter(v => v.id && v.label) : [];
    if (input.enabled && (!baseUrl && !this.config.opentalkingBaseUrl || !templates.length)) fail("启用前请配置服务地址，并选择可用形象模板");
    const connection = { baseUrl: baseUrl || this.config.opentalkingBaseUrl || "", apiKey: input.apiKey ? cleanText(input.apiKey, 2048) : this.connection().apiKey };
    if (input.enabled && (this.data.checkedConnection !== hash(connection) || templates.some(t => !this.data.availableTemplates?.some(a => a.id === t.id && a.model === t.model)))) fail("启用前请先关闭服务开关、保存地址并检测真实模型，再选择形象模板", 409);
    const settings = { ...previous, baseUrl, enabled: input.enabled, publicEnabled: input.publicEnabled, templates, voices, ttsProvider: cleanText(input.ttsProvider, 64), ttsModel: cleanText(input.ttsModel, 128), sttProvider: cleanText(input.sttProvider, 64), videoCredits: numeric("videoCredits", 0, 10000), sessionCredits: numeric("sessionCredits", 0, 10000), sessionMinutes: Math.round(numeric("sessionMinutes", 1, 30)), maxTextLength: Math.round(numeric("maxTextLength", 10, 3000)), version: randomUUID() };
    if (input.apiKey || input.baseUrl) fail("请通过 AIGC 服务设置保存连接信息", 400);
    settings.realtimeEnabled = input.realtimeEnabled === true;
    settings.textEnabled = input.textEnabled === true;
    await this.store.mutate(data => { data.digitalHuman.settings = settings; });
    return this.admin(user);
  }
  project(user, id, { writable = false } = {}) { const p = owned(this.data.projects, user, id); if (writable && p.deletedAt) fail("请先恢复回收站中的项目", 409); return p; }
  async saveProject(user, input, id) {
    const current = id ? this.project(user, id, { writable: true }) : { id: randomUUID(), ownerId: user.id, createdAt: now(), mode: "video" };
    if (input.avatarId) this.avatar(user, input.avatarId);
    const p = { ...current, name: cleanText(input.name ?? current.name, 80) || "未命名数字人", mode: ["video", "realtime"].includes(input.mode) ? input.mode : current.mode, text: cleanText(input.text ?? current.text, 3000), voice: cleanText(input.voice ?? current.voice, 150), avatarId: input.avatarId ?? current.avatarId ?? "", updatedAt: now() };
    await this.store.mutate(data => { if (id && data.digitalHuman.projects[id]?.deletedAt) fail("请先恢复回收站中的项目", 409); data.digitalHuman.projects[p.id] = p; });
    return this.projectDto(p);
  }
  async projectAction(user, id, action) {
    const p = this.project(user, id);
    const operations = Object.values(this.data.operations).filter(op => op.projectId === id);
    if (action !== "restore" && operations.some(active)) fail("请先结束实时会话或等待任务完成", 409);
    if (action === "delete" && !p.deletedAt) fail("请先将项目移入回收站", 409);
    if (action === "delete") {
      for (const op of operations.filter(op => op.type === "video" && op.remoteId)) {
        if (op.exportId) await this.client().request(`/exports/videos/${remoteId(op.exportId)}`, { method: "DELETE" }).catch(error => { if (error.upstreamStatus !== 404) throw error; });
        await this.client().request(`/video-creation/jobs/${remoteId(op.remoteId)}`, { method: "DELETE" }).catch(error => { if (error.upstreamStatus !== 404) throw error; });
      }
    }
    const files = [];
    await this.store.mutate(data => {
      if (action !== "restore" && Object.values(data.digitalHuman.operations).some(op => op.projectId === id && active(op))) fail("请先等待任务完成", 409);
      if (action === "delete") {
        for (const op of operations) {
          if (op.output && data.assets[op.output]?.ownerId === user.id) { files.push(data.assets[op.output].storageName); delete data.assets[op.output]; }
          delete data.digitalHuman.operations[op.id];
        }
        delete data.digitalHuman.projects[id];
        data.appState.works = data.appState.works.filter(work => work.projectId !== id || work.ownerId !== user.id);
      } else { const saved = data.digitalHuman.projects[id]; saved.deletedAt = action === "trash" ? now() : undefined; saved.updatedAt = now(); }
    });
    for (const file of files) await unlink(path.join(this.store.assetsDir, file)).catch(() => {});
    return { ok: true };
  }
  async begin(user, type, input, projectId) {
    this.assertEnabled(user);
    const key = input.requestId;
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) fail("缺少有效请求编号");
    const digest = await fingerprint({ ...input, projectId });
    const quote = type === "avatar" ? undefined : this.quote(user, type);
    return this.store.mutate(data => {
      const state = data.digitalHuman;
      const previous = Object.values(state.operations).find(op => op.ownerId === user.id && op.requestId === key);
      if (previous) { if (previous.digest !== digest || previous.type !== type) fail("此请求编号已用于其他内容", 409); return { operation: previous, fresh: false }; }
      this.gpu.assertNotStopping(data);
      if (projectId && (!state.projects[projectId] || state.projects[projectId].ownerId !== user.id || state.projects[projectId].deletedAt)) fail("项目已删除或在回收站中", 409);
      if (input.avatarId && !state.settings.templates?.some(t => t.id === input.avatarId) && (!state.avatars[input.avatarId] || state.avatars[input.avatarId].deletedAt)) fail("人物形象已删除", 409);
      if (Object.values(state.operations).some(op => op.ownerId === user.id && op.type === type && active(op))) fail("请先完成或结束当前数字人任务", 409);
      const op = { id: randomUUID(), ownerId: user.id, projectId, avatarId: input.avatarId, type, requestId: key, digest, status: "submitting", createdAt: now(), updatedAt: now(), quote };
      if (quote) { reserve(data, { id: op.id, userId: user.id, jobId: op.id, quote, label: type === "video" ? "数字人口播视频" : "数字人实时对话" }); markSubmitted(data, op.id); }
      state.operations[op.id] = op;
      if (projectId) state.projects[projectId].updatedAt = op.updatedAt;
      return { operation: op, fresh: true };
    });
  }
  async update(id, changes) { return this.store.mutate(data => { Object.assign(data.digitalHuman.operations[id], changes, { updatedAt: now() }); return data.digitalHuman.operations[id]; }); }
  async submissionError(op, error) {
    await this.store.mutate(data => {
      Object.assign(data.digitalHuman.operations[op.id], { status: error.rejected ? "failed" : "uncertain", message: error.rejected ? "请求未被服务接受，请检查形象、声音和素材格式。" : "服务尚未确认提交结果。已保留原请求，请勿重复提交；站长可核实后处理。", updatedAt: now() });
      if (error.rejected) settle(data, op.id, false, "数字人服务拒绝请求，记录请求结束");
    });
  }
  async validateMedia(user, file, kind, maxSeconds) {
    if (this.validating.has(user.id) || this.validating.size >= 3) fail("素材预检正在进行，请稍候再提交", 429);
    this.validating.add(user.id);
    try { return await validateDigitalMedia(file, kind, maxSeconds); }
    finally { this.validating.delete(user.id); }
  }
  async createAvatar(user, input) {
    this.assertEnabled(user);
    await this.gpu.assertRunning();
    const template = this.template(input.templateId); if (!template) fail("请选择站长提供的形象模板");
    validateFile(input.file, [...imageTypes, ...videoTypes]);
    if (videoTypes.includes(input.file.type)) await this.validateMedia(user, input.file, "video", 60);
    let preview;
    if (imageTypes.includes(input.file.type)) {
      try { preview = await sharp(Buffer.from(await input.file.arrayBuffer()), { limitInputPixels: 40_000_000 }).rotate().resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(); } catch { fail("图片无法读取，请使用有效的 JPG、PNG 或 WebP"); }
    }
    const claim = await this.begin(user, "avatar", input); const op = claim.operation;
    if (!claim.fresh) return { operation: this.operationDto(op), avatar: op.avatarId ? this.avatarDto(this.data.avatars[op.avatarId]) : undefined };
    try {
      const result = await this.client().createAvatar({ baseId: template.id, model: template.model, name: `xuti_${op.id.replaceAll("-", "")}`, file: input.file });
      remoteId(result.id);
      await this.update(op.id, { remoteId: result.id });
      const asset = preview ? await this.store.putAsset({ buffer: preview, name: "数字人形象.webp", kind: "model", mime: "image/webp", source: "digital-human-avatar", ownerId: user.id }) : null;
      const avatar = { id: randomUUID(), remoteId: result.id, ownerId: user.id, name: cleanText(input.name, 80) || "我的数字人", model: template.model, preview: asset?.path, createdAt: now() };
      await this.store.mutate(data => { data.digitalHuman.avatars[avatar.id] = avatar; Object.assign(data.digitalHuman.operations[op.id], { avatarId: avatar.id, status: "completed", updatedAt: now() }); });
      return { avatar: this.avatarDto(avatar), operation: this.operationDto(this.data.operations[op.id]) };
    } catch (error) { await this.submissionError(op, error); return { operation: this.operationDto(this.data.operations[op.id]) }; }
  }
  async deleteAvatar(user, id) {
    const a = owned(this.data.avatars, user, id);
    if (Object.values(this.data.operations).some(op => op.avatarId === id && active(op))) fail("形象仍有进行中的任务", 409);
    await this.client().request(`/avatars/${remoteId(a.remoteId)}`, { method: "DELETE" }).catch(error => { if (error.upstreamStatus !== 404) throw error; });
    const previewFile = a.preview && this.store.data.assets[a.preview]?.storageName;
    await this.store.mutate(data => { data.digitalHuman.avatars[id].deletedAt = now(); if (a.preview) delete data.assets[a.preview]; });
    if (previewFile) await unlink(path.join(this.store.assetsDir, previewFile)).catch(() => {});
    return { ok: true };
  }
  selection(user, p, input) {
    const avatar = this.avatar(user, input.avatarId || p.avatarId); const s = this.settings();
    const voice = input.voice || p.voice || "";
    if (voice && !s.voices.some(v => v.id === voice)) fail("请选择站长提供的声音");
    return { avatar, voice, s };
  }
  async createVideo(user, projectId, input) {
    this.assertEnabled(user);
    if (!input.file && !this.settings().textEnabled) fail("文字合成服务尚未启用，请上传口播音频", 409);
    await this.gpu.assertRunning();
    const p = this.project(user, projectId, { writable: true }); const { avatar, voice, s } = this.selection(user, p, input);
    const text = cleanText(input.text ?? p.text, 10_000);
    if (input.file) { input = { ...input, file: normalizeDigitalAudio(input.file) }; validateFile(input.file, audioTypes); await this.validateMedia(user, input.file, "audio", 180); }
    else if (!text || text.length > s.maxTextLength) fail(`口播文案须为 1～${s.maxTextLength} 字`);
    const claim = await this.begin(user, "video", { ...input, text, avatarId: avatar.id, voice }, projectId); const op = claim.operation;
    if (!claim.fresh) return this.operationDto(op);
    try {
      await this.update(op.id, { avatarId: avatar.id });
      const result = await this.client().createVideo({ avatarId: avatar.remoteId, model: avatar.model, text, file: input.file, title: p.name, voice, ttsProvider: s.ttsProvider, ttsModel: s.ttsModel });
      remoteId(result.job_id);
      await this.update(op.id, { remoteId: result.job_id, status: "queued" });
    } catch (error) { await this.submissionError(op, error); }
    return this.operationDto(this.data.operations[op.id]);
  }
  async createSession(user, projectId, input) {
    this.assertEnabled(user);
    if (!this.settings().realtimeEnabled) fail("实时对话尚未启用，口播视频可独立使用", 409);
    await this.gpu.assertRunning();
    const p = this.project(user, projectId, { writable: true }); const { avatar, voice, s } = this.selection(user, p, input);
    const claim = await this.begin(user, "session", { ...input, avatarId: avatar.id, voice }, projectId); const op = claim.operation;
    if (!claim.fresh) return this.operationDto(op);
    try {
      await this.update(op.id, { avatarId: avatar.id, lastHeartbeat: now(), expiresAt: new Date(Date.now() + s.sessionMinutes * 60_000).toISOString() });
      const result = await this.client().createSession({ avatar_id: avatar.remoteId, model: avatar.model, user_id: user.id, memory_enabled: false, knowledge_enabled: false, agent_enabled: false, ...(voice ? { tts_voice: voice } : {}), ...(s.ttsProvider ? { tts_provider: s.ttsProvider } : {}), ...(s.ttsModel ? { tts_model: s.ttsModel } : {}), ...(s.sttProvider ? { stt_provider: s.sttProvider } : {}) });
      remoteId(result.session_id);
      await this.update(op.id, { remoteId: result.session_id, status: "starting", lastHeartbeat: now(), expiresAt: new Date(Date.now() + s.sessionMinutes * 60_000).toISOString() });
    } catch (error) { await this.submissionError(op, error); }
    return this.operationDto(this.data.operations[op.id]);
  }
  session(user, id) { const op = owned(this.data.operations, user, id); if (op.type !== "session") fail("实时会话不存在", 404); return op; }
  async liveAction(user, id, action, body = {}) {
    const op = this.session(user, id);
    if (action === "close") return this.closeSession(op);
    if (!op.remoteId || !["starting", "ready"].includes(op.status)) fail("会话尚未就绪或已结束", 409);
    if (Date.now() >= Date.parse(op.expiresAt)) { await this.closeSession(op); fail("本次对话时长已用完", 409); }
    if (action === "heartbeat") { await this.update(id, { lastHeartbeat: now() }); return this.operationDto(this.data.operations[id]); }
    if (action === "offer") {
      if (body.type !== "offer" || typeof body.sdp !== "string" || body.sdp.length > 100_000 || !body.sdp.startsWith("v=0")) fail("无效的音视频连接请求");
      if (op.status !== "ready") fail("数字人仍在准备中", 409);
      const answer = await this.client().session(op.remoteId, "/webrtc/offer", { method: "POST", body: { type: "offer", sdp: body.sdp } });
      if (answer.type !== "answer" || typeof answer.sdp !== "string") fail("音视频应答不完整", 502);
      return { type: "answer", sdp: answer.sdp };
    }
    if (action === "ice") {
      const payload = await this.client().ice();
      return { iceServers: Array.isArray(payload.iceServers) ? payload.iceServers : [], iceTransportPolicy: payload.iceTransportPolicy === "relay" ? "relay" : "all" };
    }
    if (action === "connected") {
      await this.store.mutate(data => { settle(data, id, true, "数字人音视频会话已连接"); data.digitalHuman.operations[id].connectedAt ||= now(); });
      return { ok: true };
    }
    if (action === "interrupt") { await this.client().session(op.remoteId, "/interrupt", { method: "POST" }); return { ok: true }; }
    if (action === "speak") {
      if (op.status !== "ready") fail("数字人仍在准备中", 409);
      const text = cleanText(body.text, 2001); if (!text || text.length > 2000) fail("每条消息须为 1～2000 字");
      if (!/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId)) fail("缺少消息编号");
      if (!op.connectedAt) fail("请先连接音视频，再发送消息", 409);
      await this.client().session(op.remoteId, "/speak", { method: "POST", body: { text, mode: "replace", command_id: body.requestId } });
      return { ok: true };
    }
    if (action === "transcribe") {
      validateFile(body.file, audioTypes);
      if (!op.connectedAt) fail("请先连接音视频，再使用录音", 409);
      await this.validateMedia(user, body.file, "audio", 60);
      const form = new FormData(); form.set("file", body.file, body.file.name);
      if (this.settings().sttProvider) form.set("stt_provider", this.settings().sttProvider);
      const result = await this.client().session(op.remoteId, "/transcribe", { method: "POST", body: form, timeoutMs: 60_000 });
      return { text: cleanText(result.text, 2000) };
    }
    fail("不支持的会话操作", 404);
  }
  async closeSession(op) {
    if (["closed", "failed"].includes(op.status)) return this.operationDto(op);
    if (!op.remoteId) { await this.update(op.id, { status: "uncertain", message: "会话编号未返回，请站长核实服务端记录后关闭。" }); return this.operationDto(this.data.operations[op.id]); }
    await this.update(op.id, { status: "closing" });
    try { await this.client().session(op.remoteId, "", { method: "DELETE" }); }
    catch (error) { if (error.upstreamStatus !== 404) return this.operationDto(this.data.operations[op.id]); }
    await this.store.mutate(data => { Object.assign(data.digitalHuman.operations[op.id], { status: "closed", updatedAt: now(), message: "会话已结束" }); if (!data.digitalHuman.operations[op.id].connectedAt) settle(data, op.id, false, "音视频未连接，记录请求结束"); });
    return this.operationDto(this.data.operations[op.id]);
  }
  async stopVideo(user, id) {
    const op = owned(this.data.operations, user, id);
    if (op.type !== "video" || !active(op)) fail("任务不可停止", 409);
    if (!op.remoteId) fail("请求结果尚未确认，请联系站长核实", 409);
    await this.client().stopJob(op.remoteId);
    await this.refreshVideo(op);
    return this.operationDto(this.data.operations[id]);
  }
  async refreshVideo(op) {
    if (this.videoRefresh.has(op.id) || !active(this.data.operations[op.id])) return;
    this.videoRefresh.add(op.id);
    try {
    const result = await this.client().job(op.remoteId);
    if (result.status === "completed") {
      const exportId = result.final_export_id || result.export_video?.id;
      remoteId(exportId);
      await this.update(op.id, { status: "saving", exportId, message: "正在保存视频" });
      const output = await this.client().video(exportId);
      if (!output.buffer.length || !output.mime.includes("video/")) throw new Error("导出结果不是视频");
      const asset = await this.store.putAsset({ buffer: output.buffer, mime: "video/mp4", name: "数字人口播.mp4", kind: "output", projectId: op.projectId, ownerId: op.ownerId, source: "digital-human-output" });
      await this.store.mutate(data => {
        Object.assign(data.digitalHuman.operations[op.id], { status: "completed", output: asset.path, duration: Number(result.generated_duration_ms || 0) / 1000, message: "视频已保存", updatedAt: now() });
        data.digitalHuman.projects[op.projectId].updatedAt = now();
        const project = data.digitalHuman.projects[op.projectId];
        data.appState.works.push({ id: `digital-${op.id}`, ownerId: op.ownerId, projectId: op.projectId, category: "digital_human", title: `${project.name} · 口播`, sourceProjectName: project.name, createdAt: now(), updatedAt: now(), cover: asset, videos: [asset] });
        settle(data, op.id, true, "数字人口播视频生成完成");
      });
    } else if (["failed", "stopped"].includes(result.status)) {
      await this.store.mutate(data => { Object.assign(data.digitalHuman.operations[op.id], { status: result.status, updatedAt: now(), message: result.status === "stopped" ? "已停止" : "生成失败，请检查素材与服务配置" }); settle(data, op.id, false, "数字人视频未完成，记录请求结束"); });
    } else await this.update(op.id, { status: result.status === "queued" ? "queued" : "generating", duration: Number(result.generated_duration_ms || 0) / 1000, message: "" });
    } finally { this.videoRefresh.delete(op.id); }
  }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      const operations = Object.values(this.data.operations).filter(op => active(op) && op.remoteId && op.type !== "avatar").sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      // Bound concurrency; there is no automatic POST resubmission on restart/timeouts.
      await Promise.allSettled(operations.slice(0, 24).map(async op => {
        if (this.locks.has(op.id) || !op.remoteId) return;
        this.locks.add(op.id);
        try {
          if (op.type === "video") await this.refreshVideo(op);
          else if (op.type === "session") {
            if (op.status === "closing" || !this.settings().enabled || !this.store.data.platform?.users.some(u => u.id === op.ownerId && !u.disabled) || Date.now() >= Date.parse(op.expiresAt) || Date.now() - Date.parse(op.lastHeartbeat) > 90_000) { await this.closeSession(op); return; }
            if (op.status === "starting") {
              await this.client().session(op.remoteId, "/start", { method: "POST", timeoutMs: 130_000 });
              if (this.data.operations[op.id]?.status === "starting") await this.update(op.id, { status: "ready", message: "" });
            }
          }
        } catch (error) {
          if (op.type === "video") await this.update(op.id, { ...(error.upstreamStatus === 404 ? { status: "uncertain" } : {}), message: "暂未取得原任务结果，将继续查询；不会重复生成。" });
          else if (op.type === "session" && error.upstreamStatus !== 409) await this.update(op.id, { message: "数字人服务仍在准备，连接失败可结束会话。" });
        } finally { this.locks.delete(op.id); }
      }));
    } finally { this.busy = false; }
  }
  async resolve(user, id, input) {
    requireRole(user, ["super_admin"]);
    const op = this.data.operations[id];
    if (!op || op.status !== "uncertain" || input.confirmed !== true || !["failed", "completed"].includes(input.result) || cleanText(input.note, 500).length < 5) fail("请核实服务端记录并填写处理依据");
    if (op.type === "session" && input.result === "completed") fail("请先在服务端关闭该会话，再按未完成处理");
    await this.store.mutate(data => {
      Object.assign(data.digitalHuman.operations[id], { status: input.result, message: "站长已核实原请求", updatedAt: now(), resolution: { actorId: user.id, note: cleanText(input.note, 500), at: now() } });
      settle(data, id, input.result === "completed", `数字人请求人工核实：${cleanText(input.note, 200)}`, user.id);
    });
    return { ok: true };
  }
}

export async function handleDigitalHuman({ request, response, url, user, service, readJson, readBody, json, platform }) {
  const pathname = url.pathname; const admin = pathname.startsWith("/api/admin/digital-human");
  if (!admin && !pathname.startsWith("/api/digital-human")) return false;
  if (admin) requireRole(user, ["super_admin"]);
  const send = value => { json(response, 200, value); return true; };
  const form = async () => {
    const type = request.headers["content-type"] || "";
    if (!type.startsWith("multipart/form-data")) fail("请通过表单上传", 415);
    const data = await new Request("http://localhost/upload", { method: "POST", headers: { "content-type": type }, body: await readBody(request, MEDIA_LIMIT + 64 * 1024) }).formData();
    return Object.fromEntries(data);
  };
  if (request.method !== "GET") platform.throttle(`digital-human:${user.id}`, 180, 60_000);
  if (pathname === "/api/admin/digital-human") {
    if (request.method === "GET") return send(service.admin(user));
    if (request.method === "PUT") return send(await service.saveSettings(user, await readJson(request)));
  }
  if (pathname === "/api/admin/digital-human/preflight" && request.method === "POST") return send(await service.preflight(user));
  if (pathname === "/api/admin/digital-human/gpu") {
    if (request.method === "GET") return send(await service.gpu.status(user));
    if (request.method === "POST") return send(await service.gpu.change(user, await readJson(request)));
  }
  const resolve = pathname.match(/^\/api\/admin\/digital-human\/operations\/([\w-]+)$/);
  if (resolve && request.method === "POST") return send(await service.resolve(user, resolve[1], await readJson(request)));
  if (pathname === "/api/digital-human/catalog" && request.method === "GET") return send(service.catalog(user));
  if (pathname === "/api/digital-human/projects") {
    if (request.method === "GET") return send(service.projects(user));
    if (request.method === "POST") return send(await service.saveProject(user, await readJson(request)));
  }
  const project = pathname.match(/^\/api\/digital-human\/projects\/([\w-]+)(?:\/(trash|untrash|videos|sessions))?$/);
  if (project) {
    const [, id, action] = project;
    if (!action && request.method === "GET") return send(service.projectDto(service.project(user, id)));
    if (!action && request.method === "PUT") return send(await service.saveProject(user, await readJson(request), id));
    if (!action && request.method === "DELETE") return send(await service.projectAction(user, id, "delete"));
    if (request.method === "POST") {
      if (["trash", "untrash"].includes(action)) return send(await service.projectAction(user, id, action === "trash" ? "trash" : "restore"));
      if (action === "videos") return send(await service.createVideo(user, id, String(request.headers["content-type"]).startsWith("multipart/") ? await form() : await readJson(request)));
      if (action === "sessions") return send(await service.createSession(user, id, await readJson(request)));
    }
  }
  if (pathname === "/api/digital-human/avatars" && request.method === "POST") return send(await service.createAvatar(user, await form()));
  const avatar = pathname.match(/^\/api\/digital-human\/avatars\/([\w-]+)$/);
  if (avatar && request.method === "DELETE") return send(await service.deleteAvatar(user, avatar[1]));
  const stop = pathname.match(/^\/api\/digital-human\/videos\/([\w-]+)\/stop$/);
  if (stop && request.method === "POST") return send(await service.stopVideo(user, stop[1]));
  const session = pathname.match(/^\/api\/digital-human\/sessions\/([\w-]+)\/(heartbeat|close|offer|ice|connected|speak|interrupt|transcribe)$/);
  if (session && request.method === "POST") return send(await service.liveAction(user, session[1], session[2], session[2] === "transcribe" ? await form() : await readJson(request)));
  fail("未找到数字人接口", 404);
}

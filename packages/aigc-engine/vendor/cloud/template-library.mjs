import { randomUUID } from "node:crypto";
import { fail, requireRole } from "./access.mjs";

const now = () => new Date().toISOString();
const isTemplate = asset => asset.kind === "template" && ["upload", "generated"].includes(asset.source)
  || asset.source === "generated" && /^C[_ .-].*\.json$/i.test(asset.name);

export function registerTemplate(data, asset, migrated = false) {
  if (!asset.ownerId || !isTemplate(asset)) return;
  const library = data.templateLibrary ??= { startedAt: now(), entries: [] };
  if (library.entries.some(entry => entry.assetId === asset.id)) return;
  const project = data.appState.projects.find(p => p.id === asset.projectId);
  library.entries.unshift({ id: randomUUID(), assetId: asset.id, ownerId: asset.ownerId, projectId: asset.projectId,
    title: project?.name || asset.name, description: "", source: asset.source === "generated" ? "generated" : "upload",
    createdAt: asset.createdAt, updatedAt: now(), recommendedAt: null, deletedAt: null, autoSave: !migrated && asset.source === "generated" });
}

// Shared templates contain reusable instructions, never private storage links.
export function portableTemplate(text) {
  let body;
  try { body = JSON.parse(text); } catch { return text; }
  const privateKeys = new Set(["input_snapshot", "input_revision_snapshot", "source_fingerprint", "b_file", "assetId", "ownerId", "projectId", "filePath", "storageName"]);
  const clean = value => {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKeys.has(key)).map(([key, item]) => [key, clean(item)]));
    return value;
  };
  return JSON.stringify(clean(body), null, 2);
}

export class TemplateLibrary {
  constructor(store) { this.store = store; }
  async init() {
    await this.store.mutate(data => {
      data.templateLibrary ??= { startedAt: now(), entries: [] };
      for (const asset of Object.values(data.assets)) registerTemplate(data, asset, true);
    });
  }
  actor(user, superOnly = false, data = this.store.data) {
    const current = data.platform?.users.find(u => u.id === user.id && !u.disabled);
    requireRole(current, superOnly ? ["super_admin"] : ["super_admin", "admin", "operator"]);
    return current;
  }
  entry(user, id, data = this.store.data, includeDeleted = false) {
    const actor = this.actor(user, false, data);
    const entry = data.templateLibrary?.entries.find(e => e.id === id);
    if (!entry || (!includeDeleted && entry.deletedAt) || (actor.role !== "super_admin" && entry.ownerId !== actor.id && !entry.recommendedAt)) fail("模板不存在或暂未公开", 404);
    return entry;
  }
  videos(entry, data = this.store.data) {
    const work = data.appState.works.find(w => w.ownerId === entry.ownerId && !w.deletedAt && w.reusableTemplate?.path === entry.assetId);
    const files = work?.videos?.length ? work.videos : work?.cover ? [work.cover] : [];
    return files.map(file => data.assets[file.path]).filter(asset => asset?.ownerId === entry.ownerId && asset.mime?.startsWith("video/"));
  }
  list(user, { scope = "featured", page = 1, search = "" } = {}) {
    this.actor(user, scope === "all" || scope === "trash");
    if (!["featured", "mine", "all", "trash"].includes(scope)) fail("模板列表类型无效");
    const data = this.store.data;
    const term = String(search).trim().toLowerCase().slice(0, 100);
    const users = new Map(data.platform.users.map(u => [u.id, u]));
    const entries = (data.templateLibrary?.entries || []).filter(e => Boolean(e.deletedAt) === (scope === "trash") && data.assets[e.assetId]
      && (scope !== "featured" || e.recommendedAt) && (scope !== "mine" || e.ownerId === user.id)
      && (!term || `${e.title} ${e.description} ${["all", "trash"].includes(scope) ? users.get(e.ownerId)?.username || "" : ""}`.toLowerCase().includes(term)))
      .sort((a, b) => String(b.recommendedAt || b.createdAt).localeCompare(String(a.recommendedAt || a.createdAt)));
    const pageSize = 24;
    const currentPage = Math.max(1, Math.min(Math.ceil(entries.length / pageSize) || 1, Math.floor(Number(page)) || 1));
    return { total: entries.length, page: currentPage, pageSize, items: entries.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(e => {
      const asset = data.assets[e.assetId];
      return { id: e.id, title: e.title, description: e.description, source: e.source, createdAt: e.createdAt, recommended: Boolean(e.recommendedAt), recommendedAt: e.recommendedAt, deletedAt: e.deletedAt,
        video: this.videos(e).length > 0, videoCount: this.videos(e).length,
        ...(e.ownerId === user.id || user.role === "super_admin" ? { size: asset.size, filename: asset.name } : {}),
        ...(user.role === "super_admin" ? { ownerId: e.ownerId, username: users.get(e.ownerId)?.username || "已停用账号", displayName: users.get(e.ownerId)?.displayName } : {}) };
    }) };
  }
  localCopies(user) {
    return (this.store.data.templateLibrary?.entries || []).filter(e => e.ownerId === user.id && !e.deletedAt && this.store.data.assets[e.assetId]).map(e => ({ id: e.id, name: this.store.data.assets[e.assetId].name, title: e.title }));
  }
  async file(user, id) {
    const entry = this.entry(user, id);
    if (user.role !== "super_admin" && entry.ownerId !== user.id) fail("精选作品仅支持观看和制作同款，不提供模板文件", 403);
    return this.readTemplate(user, id);
  }
  async readTemplate(user, id) {
    const entry = this.entry(user, id);
    const asset = this.store.getAssetMetadata(entry.assetId);
    if (!asset || asset.size > 5 * 1024 * 1024) fail("模板不存在或超过 5MB 预览限制", 413);
    const file = await this.store.readAsset(entry.assetId);
    if (!file) fail("模板文件已被清理", 404);
    this.entry(user, id);
    const original = file.buffer.toString("utf8");
    const text = user.role === "super_admin" || entry.ownerId === user.id ? original : portableTemplate(original);
    return { text, name: asset.name, mime: asset.mime, entry };
  }
  media(user, id, clip = 0) {
    const entry = this.entry(user, id);
    if (!Number.isInteger(clip) || clip < 0) fail("视频片段不存在", 404);
    const asset = this.videos(entry)[clip];
    if (!asset) fail("模板暂未关联展示视频", 404);
    return asset.id;
  }
  async update(user, id, input) {
    return this.store.mutate(data => {
      const actor = this.actor(user, true, data);
      const entry = this.entry(actor, id, data, true);
      if (!["recommend", "unrecommend", "delete", "restore", "edit"].includes(input.action)) fail("模板操作无效");
      if (entry.deletedAt && input.action !== "restore") fail("请先从回收站恢复模板", 409);
      const timestamp = now();
      if (input.action === "recommend") entry.recommendedAt ??= timestamp;
      if (input.action === "unrecommend") entry.recommendedAt = null;
      if (input.action === "delete") { entry.deletedAt = timestamp; entry.recommendedAt = null; }
      if (input.action === "restore") entry.deletedAt = null;
      if (input.action === "edit") {
        if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 120) fail("模板标题须为 1～120 字");
        entry.title = input.title.trim();
        entry.description = String(input.description || "").trim().slice(0, 500);
      }
      entry.updatedAt = timestamp;
      data.platform.audit.unshift({ id: randomUUID(), at: timestamp, actorId: actor.id, actorName: actor.username, action: `template_${input.action}`, target: id, detail: entry.title });
      return { ok: true };
    });
  }
  async use(user, id) {
    const { text, name, entry } = await this.readTemplate(user, id);
    this.actor(user);
    if (this.store.data.appState.projects.filter(p => p.ownerId === user.id && !p.deletedAt).length >= 100) fail("账号项目已达到 100 个，请先整理项目");
    const projectId = randomUUID(), timestamp = now();
    const copy = await this.store.putAsset({ buffer: Buffer.from(portableTemplate(text)), name, kind: "template", mime: "application/json", ownerId: user.id, projectId, source: "template-copy" });
    return this.store.saveProject({ id: projectId, name: `${entry.title} · 制作同款`, createdAt: timestamp, updatedAt: timestamp, status: "draft", replicationMode: "complete", sceneMode: "reference", videoAspectRatio: "auto", platform: "grok", modelMeasurements: [], productMeasurements: [], assets: { modelImages: [], productImages: [], sceneImages: [], reusableTemplate: copy }, saveReusableTemplate: true, notes: "" }, user.id);
  }
}

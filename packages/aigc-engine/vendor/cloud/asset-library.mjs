import { randomUUID } from "node:crypto";
import { fail } from "./access.mjs";

export function cleanMeasurements(values) {
  if (!Array.isArray(values) || values.length > 50) fail("测量信息无效");
  return values.map(v => ({ id: String(v?.id || randomUUID()).slice(0, 128), label: String(v?.label || "").slice(0, 100), value: String(v?.value ?? "").slice(0, 500), unit: String(v?.unit || "").slice(0, 30) }));
}
export function cleanProjectCast(input, file) {
  if (!input || !Array.isArray(input.roles) || !Array.isArray(input.products) || input.roles.length > 8 || input.products.length > 16) fail("最多支持 8 个角色与 16 组商品");
  const group = (item, kind) => {
    if (!item || !/^[\w-]{1,128}$/.test(item.id || "") || !Array.isArray(item.images) || item.images.length > 14) fail("角色或商品分组信息无效");
    const name = String(item.name || "").trim().slice(0, 80);
    if (!name) fail("请填写角色或商品名称");
    return { id: item.id, name, selected: item.selected !== false, images: item.images.map(image => { if (!image) fail("分组图片无效"); return file(image, [kind]); }), measurements: cleanMeasurements(item.measurements), ...(item.libraryId ? { libraryId: String(item.libraryId).slice(0, 128), libraryRevision: String(item.libraryRevision || "").slice(0, 128) } : {}) };
  };
  const roles = input.roles.map(r => group(r, "model"));
  const products = input.products.map(p => ({ ...group(p, "product"), roleId: String(p.roleId || "").slice(0, 128) }));
  if (new Set(roles.map(r => r.id)).size !== roles.length || new Set(products.map(p => p.id)).size !== products.length) fail("角色或商品编号重复");
  for (const product of products) if (product.roleId && !roles.some(r => r.id === product.roleId)) fail("关联角色不存在，请重新选择");
  return { roles, products };
}

const kindOf = kind => { if (!["character", "product"].includes(kind)) fail("资产类型无效"); return kind === "character" ? "model" : "product"; };
const publicEntry = ({ ownerId, ...entry }) => structuredClone(entry);
const ownedEntry = (data, user, id) => {
  const entry = (data.assetLibrary || []).find(e => e.id === id && e.ownerId === user.id);
  if (!entry) fail("资产不存在或已删除", 404);
  return entry;
};

export class AssetLibrary {
  constructor(store) { this.store = store; }
  async pruneDrafts(user) {
    const expired = Object.values(this.store.data.assets).filter(a => a.ownerId === user.id && a.source === "library-draft" && Date.parse(a.createdAt) < Date.now() - 86400000);
    await this.store.discardLibraryAssets(expired.map(a => a.id), user.id);
  }
  list(user, { kind, search = "", page = 1 } = {}) {
    kindOf(kind);
    const query = String(search).trim().toLowerCase().slice(0, 100);
    const entries = (this.store.data.assetLibrary || []).filter(e => e.ownerId === user.id && e.kind === kind && (!query || e.name.toLowerCase().includes(query))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const current = Math.max(1, Math.min(1000, Math.floor(Number(page) || 1))), pageSize = 20;
    return { items: entries.slice((current - 1) * pageSize, current * pageSize).map(publicEntry), total: entries.length, page: current, pageSize };
  }
  get(user, id) { return publicEntry(ownedEntry(this.store.data, user, id)); }
  async save(user, kind, id, input) {
    const imageKind = kindOf(kind), name = String(input.name || "").trim().slice(0, 80);
    if (!name) fail("请填写资产名称");
    if (!Array.isArray(input.images) || !input.images.length || input.images.length > 14) fail("每组资产需保存 1～14 张图片");
    const measurements = cleanMeasurements(input.measurements);
    const existing = id ? ownedEntry(this.store.data, user, id) : null;
    if (existing && (existing.kind !== kind || input.revision !== existing.revision)) fail("资产已更新，请重新打开后编辑", 409);
    const entryId = id || randomUUID(), prepared = [], copies = [];
    try {
      for (const file of input.images) {
        const meta = this.store.getAssetMetadata(file?.path);
        if (!meta || meta.ownerId !== user.id || meta.kind !== imageKind || !["upload", "library", "library-draft"].includes(meta.source)) fail("图片不存在或不属于当前账号", 404);
        let asset;
        if (meta.source === "library-draft" || (meta.source === "library" && meta.libraryId === entryId)) asset = { path: meta.id, name: meta.name, kind: meta.kind, size: meta.size, mime: meta.mime };
        else { asset = await this.store.copyAsset(meta.id, { source: "library-draft", ownerId: user.id }); copies.push(asset.path); }
        if (!prepared.some(f => f.path === asset.path)) prepared.push(asset);
      }
      let obsolete = [];
      const saved = await this.store.mutate(data => {
        data.assetLibrary ??= [];
        const current = id ? ownedEntry(data, user, id) : null;
        if (current && input.revision !== current.revision) fail("资产已更新，请重新打开后编辑", 409);
        if (!current && data.assetLibrary.filter(e => e.ownerId === user.id && e.kind === kind).length >= 100) fail("当前类型的资产已达 100 组，请先整理资产库");
        for (const image of prepared) {
          const meta = data.assets[image.path];
          if (!meta || meta.ownerId !== user.id || !(meta.source === "library-draft" || (meta.source === "library" && meta.libraryId === entryId))) fail("图片已被修改，请重新上传", 409);
        }
        const oldPaths = new Set(current?.images.map(i => i.path) || []);
        const retainedSize = Object.values(data.assets).filter(a => a.ownerId === user.id && a.source === "library" && !oldPaths.has(a.id)).reduce((sum, a) => sum + a.size, 0);
        if (retainedSize + prepared.reduce((sum, f) => sum + f.size, 0) > 1024 ** 3) fail("个人资产库已超过 1GB，请先整理不用的图片", 413);
        const timestamp = new Date().toISOString();
        const entry = { id: entryId, ownerId: user.id, kind, name, images: prepared, measurements, revision: randomUUID(), createdAt: current?.createdAt || timestamp, updatedAt: timestamp };
        for (const image of prepared) { data.assets[image.path].source = "library"; data.assets[image.path].libraryId = entryId; data.assets[image.path].projectId = null; }
        obsolete = [...oldPaths].filter(path => !prepared.some(i => i.path === path));
        data.assetLibrary = [entry, ...data.assetLibrary.filter(e => e.id !== entryId)];
        return publicEntry(entry);
      });
      await this.store.discardLibraryAssets(obsolete, user.id);
      return saved;
    } catch (error) {
      await this.store.discardLibraryAssets(copies, user.id);
      throw error;
    }
  }
  async remove(user, id, revision) {
    const images = await this.store.mutate(data => {
      const entry = ownedEntry(data, user, id);
      if (entry.revision !== revision) fail("资产已更新，请刷新后再删除", 409);
      data.assetLibrary = data.assetLibrary.filter(e => e.id !== id);
      return entry.images.map(i => i.path);
    });
    await this.store.discardLibraryAssets(images, user.id);
    return { ok: true };
  }
  async use(user, id, projectId) {
    const project = this.store.data.appState.projects.find(p => p.id === projectId && p.ownerId === user.id);
    if (!project) fail("项目不存在", 404);
    if (Object.values(this.store.data.jobs).some(j => j.projectId === projectId && !["completed", "failed", "cancelled"].includes(j.status))) fail("请先完成或取消当前任务再更换角色与商品", 409);
    const entry = this.get(user, id), images = [];
    const temporaryBytes = Object.values(this.store.data.assets).filter(a => a.ownerId === user.id && ["upload", "library-draft"].includes(a.source)).reduce((sum, a) => sum + a.size, 0);
    if (temporaryBytes + entry.images.reduce((sum, f) => sum + f.size, 0) > 1024 ** 3) fail("项目临时素材已达 1GB，请先完成已有项目释放素材", 413);
    for (const image of entry.images) images.push(await this.store.copyAsset(image.path, { projectId, ownerId: user.id, source: "upload" }));
    return { id: randomUUID(), libraryId: entry.id, libraryRevision: entry.revision, name: entry.name, selected: true, images, measurements: entry.measurements };
  }
}

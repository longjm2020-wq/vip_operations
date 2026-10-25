import { randomUUID } from "node:crypto";
import { fail } from "./access.mjs";
import { DETAIL_ASSET_KINDS } from "../shared/detail-inputs.mjs";

const timestamp = () => new Date().toISOString();
const publicEntry = ({ ownerId, ...entry }) => structuredClone(entry);
const ownedProject = (store, user, id) => {
  const project = store.data.detailProjects?.[id];
  if (!project || project.ownerId !== user.id) fail("详情页项目不存在", 404);
  return project;
};
function personalEntries(store, user) {
  return (store.data.assetLibrary || []).filter(entry => entry.ownerId === user.id).map(entry => {
    const person = entry.kind === "character";
    const fields = (entry.measurements || []).filter(field => field.value).map(field => ({ name: field.label, value: `${field.value}${field.unit || ""}` }));
    return { ...entry, id: `personal:${entry.id}`, kind: person ? "person" : "product", information: person ? { name: entry.name, identityNotes: "", measurements: fields } : { name: entry.name, category: "", primaryColor: "", material: "", sellingPoints: [], truthFields: fields }, documents: [], origin: "personal" };
  });
}
export function listDetailAssetGroups(store, user) {
  return [...(store.data.detailAssetLibrary || []).filter(entry => entry.ownerId === user.id), ...personalEntries(store, user)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicEntry);
}
export async function saveDetailAssetGroup(store, user, projectId, kind) {
  if (!DETAIL_ASSET_KINDS.includes(kind)) fail("资产类型无效");
  const project = structuredClone(ownedProject(store, user, projectId));
  const information = project[kind] || {}, documents = project.assetDocuments?.[kind] || [];
  const ids = project.assets[kind];
  if (!ids.length && !documents.length && !information.name && !information.intro && !information.notes && !information.preset) fail("请先上传素材或补充资料");
  const link = project.assetStorage?.[kind];
  const existing = link?.mode === "library" && (store.data.detailAssetLibrary || []).find(entry => entry.id === link.libraryId && entry.ownerId === user.id && entry.kind === kind);
  if (existing && existing.revision !== link.revision) fail("库内资产已更新，请重新选择后再保存", 409);
  const id = existing?.id || randomUUID(), copies = [];
  try {
    for (const imageId of ids) {
      const meta = store.getAssetMetadata(imageId);
      if (!meta || meta.ownerId !== user.id || !meta.mime?.startsWith("image/")) fail("图片不存在或不属于当前账号", 404);
      copies.push(await store.copyAsset(imageId, { ownerId: user.id, source: "library-draft" }));
    }
    const result = await store.mutate(data => {
      const saved = ownedProject({ data }, user, projectId);
      if (saved.version !== project.version) fail("项目已修改，请稍后重新保存资产", 409);
      data.detailAssetLibrary ||= [];
      const current = data.detailAssetLibrary.find(entry => entry.id === id);
      if (existing && current?.revision !== existing.revision) fail("库内资产已更新，请重新选择", 409);
      if (!existing && data.detailAssetLibrary.filter(entry => entry.ownerId === user.id && entry.kind === kind).length >= 100) fail("该类型的长期资产最多 100 组，请先整理资产库");
      const retainedBytes = Object.values(data.assets).filter(asset => asset.ownerId === user.id && asset.source === "library").reduce((sum, asset) => sum + asset.size, 0);
      if (retainedBytes + copies.reduce((sum, asset) => sum + asset.size, 0) > 1024 ** 3) fail("个人资产库已达 1GB，请先整理不用的图片", 413);
      const entry = { id, kind, ownerId: user.id, name: information.name || copies[0]?.name || ({ brand: "品牌资料", person: "人物资料", product: "产品资料", scene: information.preset || "场景资料" })[kind], information, documents, images: copies, revision: randomUUID(), createdAt: existing?.createdAt || timestamp(), updatedAt: timestamp() };
      for (const image of copies) Object.assign(data.assets[image.path], { source: "library", libraryId: id, projectId: null });
      data.detailAssetLibrary = [entry, ...data.detailAssetLibrary.filter(item => item.id !== id)];
      saved.assetStorage = { ...saved.assetStorage, [kind]: { mode: "library", libraryId: id, revision: entry.revision } };
      saved.version++; saved.updatedAt = timestamp();
      return structuredClone(saved);
    });
    await store.discardLibraryAssets(existing?.images?.map(image => image.path) || [], user.id);
    return result;
  } catch (error) { await store.discardLibraryAssets(copies.map(image => image.path), user.id); throw error; }
}
export async function useDetailAssetGroup(store, user, id, projectId) {
  const project = structuredClone(ownedProject(store, user, projectId));
  const entry = listDetailAssetGroups(store, user).find(item => item.id === id);
  if (!entry) fail("资产不存在或已删除", 404);
  const temporaryBytes = Object.values(store.data.assets).filter(asset => asset.ownerId === user.id && ["upload", "library-draft"].includes(asset.source)).reduce((sum, asset) => sum + asset.size, 0);
  if (temporaryBytes + entry.images.reduce((sum, image) => sum + (image.size || 0), 0) > 1024 ** 3) fail("项目临时素材已达 1GB，请先整理已有项目", 413);
  const copies = [];
  try {
    for (const image of entry.images) copies.push(await store.copyAsset(image.path, { ownerId: user.id, source: "library-draft" }));
    return await store.mutate(data => {
      const saved = ownedProject({ data }, user, projectId);
      if (saved.version !== project.version) fail("项目已修改，请重新选择资产", 409);
      const oldIds = new Set(saved.assets[entry.kind]);
      // A replacement must also detach old per-module bindings.
      for (const module of saved.modules) for (const [key, ids] of Object.entries(module.asset_bindings || {})) module.asset_bindings[key] = ids.filter(value => !oldIds.has(value));
      saved.assets[entry.kind] = copies.map(image => image.path);
      saved[entry.kind] = structuredClone(entry.information);
      if (saved.assetAutoNames) delete saved.assetAutoNames[entry.kind];
      saved.assetDocuments = { ...saved.assetDocuments, [entry.kind]: structuredClone(entry.documents) };
      saved.assetStorage = { ...saved.assetStorage, [entry.kind]: { mode: "library", libraryId: entry.id, revision: entry.revision } };
      if (entry.kind === "product" && /^(未命名详情页|新建详情页)$/.test(saved.name)) saved.name = `${entry.information.name}详情页`.slice(0, 100);
      for (const image of copies) Object.assign(data.assets[image.path], { source: "upload", projectId });
      saved.version++; saved.updatedAt = timestamp();
      return structuredClone(saved);
    });
  } catch (error) { await store.discardLibraryAssets(copies.map(image => image.path), user.id); throw error; }
}
export async function removeDetailAssetGroup(store, user, id, revision) {
  const images = await store.mutate(data => {
    const entry = (data.detailAssetLibrary || []).find(item => item.id === id && item.ownerId === user.id);
    if (!entry) fail("资产不存在或已删除", 404);
    if (entry.revision !== revision) fail("资产已更新，请刷新后再删除", 409);
    data.detailAssetLibrary = data.detailAssetLibrary.filter(item => item.id !== id);
    for (const project of Object.values(data.detailProjects || {})) if (project.ownerId === user.id && project.assetStorage?.[entry.kind]?.libraryId === id) project.assetStorage[entry.kind] = { mode: "temporary" };
    return entry.images.map(image => image.path);
  });
  await store.discardLibraryAssets(images, user.id);
  return { ok: true };
}

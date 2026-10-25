import { normalizeUnitCast, selectedCast } from "../shared/project-cast.mjs";
import { normalizeProductLocks } from "./product-truth.mjs";
import { WEARABLE_GENERATION_RULES } from "./kernel-source.mjs";

export const CONSISTENCY_VERSION = "identity-product-v2";

// These rules are applied by the server at every generation boundary. A model's
// script, an imported C template or a correction cannot redefine asset truth.
export const CONSISTENCY_RULES = WEARABLE_GENERATION_RULES;

export const CONSISTENCY_NEGATIVES = [
  "禁止融合脸、换脸、串脸、平均脸、复制人脸及自动美颜改脸",
  "禁止借用商品模特、场景人物或参考视频的人脸与服装",
  "禁止角色商品错配、同人混穿多款或多组商品拼接改款",
  "禁止商品细节增删、漂移、闪烁、文字变形与运动中重绘设计",
  "禁止臆造无原图证据的背面、内里或遮挡细节",
  "禁止滚边脱离原路径、领缘线变胸前装饰弧、腰线与抽绳出口移位",
  "禁止纹样尺度密度变化、衣片落点漂移及把编译摘要当作高于原图的真值",
];

export function referenceEntries(project) {
  const cast = selectedCast(project);
  const groups = [
    ["identity", project.assets.modelImages, cast.roles],
    ["product", project.assets.productImages, cast.products],
    ["scene", project.sceneMode === "custom" ? project.assets.sceneImages : [], []],
  ];
  const entries = [];
  for (const [kind, files, owners] of groups) for (const file of files) {
    const owner = owners.find(group => group.images.some(image => image.path === file.path));
    const index = entries.length + 1;
    const binding = owner && project.cast ? kind === "identity" ? `角色 ${owner.id}「${owner.name}」；` : `商品组 ${owner.id}「${owner.name}」，仅关联角色 ${owner.roleId}；` : "";
    const purpose = kind === "identity" ? "仅此角色的人脸、身份、发型与体态；不继承其衣服，同组多图属于同一人" : kind === "product" ? "商品设计唯一真值，服装细节逐项保留；忽略商品图内模特的脸" : "仅场景与光线；忽略其中的人脸、服装和商品";
    entries.push({ file, kind, index, ownerId: owner?.id, label: `<IMAGE_${index}>：${binding}${purpose}` });
  }
  return entries;
}

// A first-frame request carries one reviewed composition, not all source files.
// Preserve provenance in prose: an exclusion about source clothing must never
// turn into an instruction to remove clothing from the reviewed composition.
export function sourceReferenceText(project, value) {
  const entries = referenceEntries(project);
  const cast = selectedCast(project);
  return String(value || "").replace(/<?\bIMAGE_(\d+)\b>?/gi, (_, index) => {
    const entry = entries.find(e => e.index === Number(index));
    if (!entry) throw new Error(`脚本引用了无法核对的原始图片编号 ${index}；请核对素材来源，未提交生成。`);
    const owner = [...cast.roles, ...cast.products].find(g => g.id === entry.ownerId);
    const kind = entry.kind === "identity" ? "人物原图" : entry.kind === "product" ? "商品原图" : "场景原图";
    return `${kind}来源「${owner?.name || kind}·${index}」`;
  });
}

// Derive identity bindings from the frozen project, never from model output.
export function identityLock(project, unit) {
  const cast = selectedCast(project);
  const binding = unit ? normalizeUnitCast(project, unit) : {};
  const roleIds = binding.character_ids || cast.roles.map(role => role.id);
  const productIds = binding.product_ids || cast.products.map(product => product.id);
  const entries = referenceEntries(project);
  return cast.roles.filter(role => roleIds.includes(role.id)).map(role => ({
    character_id: role.id, name: role.name,
    identity_images: entries.filter(entry => entry.kind === "identity" && entry.ownerId === role.id).map(entry => `<IMAGE_${entry.index}>`),
    products: cast.products.filter(product => productIds.includes(product.id) && product.roleId === role.id).map(product => ({ product_id: product.id, name: product.name })),
  }));
}

export function consistencyInstructions(project, unit, { firstFrame = false, includeRules = true } = {}) {
  const roles = identityLock(project, unit);
  const mapping = roles.map(role => `角色 ${role.character_id}「${role.name}」：${firstFrame ? "锁定已验收首帧中该角色的独立人脸" : `人脸仅取 ${role.identity_images.join("、") || "该角色人物原图"}`}；本段关联商品：${role.products.map(p => `${p.product_id}「${p.name}」`).join("、") || "无，不借用其他人的商品"}`).join("\n");
  return `${includeRules ? CONSISTENCY_RULES + "\n" : ""}本${unit ? "段" : "项目"}逐人绑定（角色编号不能互换）：\n${mapping || "本段无人物，不得从其他参考图引入人物"}\n${firstFrame ? "本请求只有已验收首帧，人物资产和商品原图已在制帧、验收阶段使用；不得引用未随请求提供的原图。" : "未列入本段的角色或商品，即使出现在其他参考图中也不得进入画面。"}`;
}

export function unitProductLock(project, unit, productLock, { firstFrame = false } = {}) {
  const cast = selectedCast(project);
  const ids = normalizeUnitCast(project, unit).product_ids || cast.products.map(p => p.id);
  return normalizeProductLocks(productLock, project).filter(item => ids.includes(item.product_id)).map(item => ({
    product_id: item.product_id || cast.products[0]?.id,
    feature: item.feature,
    value: item.certainty === "confirmed" ? item.value : "unknown，不得臆造",
    certainty: item.certainty === "confirmed" ? "confirmed" : "unknown",
    view: item.view, region: item.region, anchor: item.certainty === "confirmed" ? item.anchor : "unknown", relation: item.certainty === "confirmed" ? item.relation : "unknown",
    evidence_status: item.evidence_status,
    ...(item.classification ? { classification: item.classification, treatment: item.certainty !== "confirmed" || item.classification === "unresolved" ? "待核对，不得擅自增删" : item.classification === "excluded_artifact" ? "明确排除，不得穿戴或设计化转移" : "保留原图设计及连接位置" } : {}),
    ...(!firstFrame ? { evidence: item.certainty === "confirmed" ? item.evidence : "来源未核实，仅对照当前商品原图", source_images: item.source_images } : {}),
  }));
}

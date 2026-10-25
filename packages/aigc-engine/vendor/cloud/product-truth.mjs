import { createHash } from "node:crypto";
import { selectedCast } from "../shared/project-cast.mjs";

export const PRODUCT_TRUTH_VERSION = "product-spatial-v1";
export { WEARABLE_GENERATION_RULES as PRODUCT_TRUTH_RULES } from "./kernel-source.mjs";

const text = (value, limit = 300) => typeof value === "string" ? value.trim().slice(0, limit) : "";
function productSources(project) {
  const cast = selectedCast(project);
  const offset = project.assets?.modelImages?.length || 0;
  return (project.assets?.productImages || []).map((file, i) => ({
    image: offset + i + 1, path: file.path,
    productId: cast.products.find(p => p.images.some(f => f.path === file.path))?.id,
  }));
}

// Model claims are candidates, never a declaration that visual QA has passed.
// Missing evidence is retained for review, but cannot become a confirmed lock.
export function normalizeProductLocks(value, project, { strict = false } = {}) {
  const products = selectedCast(project).products, sources = productSources(project);
  return (Array.isArray(value) ? value : []).filter(item => item && typeof item === "object").slice(0, 160).flatMap(item => {
    const productId = item.product_id || (products.length === 1 ? products[0].id : undefined);
    if (!products.some(p => p.id === productId)) {
      if (strict) throw new Error("商品锁定清单缺少正确的商品组编号，请核对编译回包；未自动重提。");
      return [];
    }
    const evidence = text(item.evidence);
    const evidenceIndices = [...evidence.matchAll(/<?IMAGE_(\d+)>?/gi)].map(m => Number(m[1]));
    const indices = Array.isArray(item.source_images) ? item.source_images : evidenceIndices;
    const matched = indices.length > 0 && indices.length <= 16 && [...indices, ...evidenceIndices].every(i => Number.isInteger(i) && sources.some(s => s.image === i && s.productId === productId));
    const sourceImages = matched ? [...new Set(indices)].sort((a, b) => a - b) : [];
    const unresolved = Boolean(item.classification && !["product_core", "bundled_accessory", "excluded_artifact"].includes(item.classification));
    return [{
      product_id: productId, feature: text(item.feature, 100), value: text(item.value, 500), evidence: matched ? sourceImages.map(i => `<IMAGE_${i}>`).join("、") : evidence,
      certainty: item.certainty === "confirmed" && matched && !unresolved ? "confirmed" : "unknown",
      source_images: sourceImages,
      evidence_status: matched ? "source_matched_needs_review" : "unverified",
      view: text(item.view, 100), region: text(item.region, 100),
      anchor: text(item.anchor), relation: text(item.relation),
      // Optional for old artifacts: absent fields must not invalidate released
      // jobs' original evidence hash. Unmatched evidence cannot confirm removal.
      ...(item.classification ? { classification: matched && item.certainty === "confirmed" && ["product_core", "bundled_accessory", "excluded_artifact"].includes(item.classification) ? item.classification : "unresolved" } : {}),
    }];
  });
}

export function productTruthRevision(project, productLock) {
  return createHash("sha256").update(JSON.stringify({
    policy: PRODUCT_TRUTH_VERSION,
    project: project.id || project.projectId,
    sources: productSources(project),
    products: selectedCast(project).products.map(p => ({ id: p.id, roleId: p.roleId, measurements: p.measurements || [] })),
    locks: normalizeProductLocks(productLock, project),
  })).digest("hex");
}

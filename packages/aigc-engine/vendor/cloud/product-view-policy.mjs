import { z } from "zod";
import { referenceEntries } from "./consistency.mjs";
import { normalizeUnitCast, selectedCast } from "../shared/project-cast.mjs";

export const SIDE_VIEW_RULE = "仅将缺失背面依据的镜头改为正面至轻微侧角度（相对正面不超过30度）；不转到背面、不完整展示后片、不环绕到背后、不生成背部纹样或结构。保留时长、切镜、人物绑定、道具和可兼容的动作，商品设计不变。";
export const unitShots = unit => unit.shot_plan?.length ? unit.shot_plan : [unit];
export function needsBack(shot) {
  if (shot.required_product_views?.includes("back")) return true;
  return String([shot.camera, shot.action].filter(Boolean).join("；")).split(/[。；;\n]/).some(s =>
    !/禁止|不得|避免|不要|不展示|不露|勿|\b(no|not|avoid|never)\b/i.test(s) &&
    /(?:展示|露出|拍摄).*(?:背面|背部|后片)|背面(?:特写|展示|镜头)|背对镜头|背部朝向镜头|转身.*(?:背|180)|环绕.*(?:背|360)|\b(?:back view|rear view|back to (?:the )?camera|show.*back|full turn)\b/i.test(s));
}

export const viewGapSchema = z.object({
  product_id: z.string().min(1).max(180), unit_id: z.string().min(1).max(180),
  evidence_images: z.array(z.number().int().positive()).min(1).max(30),
  visible_views: z.array(z.enum(["front", "side", "inside"])).min(1).max(3),
  detail: z.string().trim().min(1).max(600),
  shots: z.array(z.object({ index: z.number().int().nonnegative(), camera: z.string().trim().min(1).max(1600), action: z.string().trim().min(1).max(1600) })).min(1).max(160),
});

// A model must have actually inspected this product's originals. Neither an
// unknown lock nor a file name alone is sufficient to ask for more uploads.
export function validateViewGaps(gaps, project, artifacts, checks) {
  const refs = referenceEntries(project), products = selectedCast(project).products;
  const seen = new Set();
  return gaps.map(gap => {
    const product = products.find(p => p.id === gap.product_id), unit = artifacts?.units?.find(u => u.id === gap.unit_id);
    const key = `${gap.product_id}:${gap.unit_id}`;
    if (!product || !unit || seen.has(key)) throw new Error("背面补图项的商品、片段缺失或重复");
    seen.add(key);
    if (!gap.visible_views.includes("front") || gap.evidence_images.some(i => !refs.some(r => r.index === i && r.kind === "product" && r.ownerId === product.id))) throw new Error("背面补图项缺少本商品正面原图依据");
    if (!checks.some(c => c.subject === product.id && c.check === "script_evidence" && c.status !== "pass")) throw new Error("背面补图项与脚本核对结论不一致");
    const shots = unitShots(unit), bound = shot => normalizeUnitCast(project, shot.product_ids ? shot : unit).product_ids;
    const required = shots.flatMap((shot, i) => needsBack(shot) && (!bound(shot) || bound(shot).includes(product.id)) ? [i] : []);
    if (!required.length || gap.shots.length !== required.length || new Set(gap.shots.map(s => s.index)).size !== required.length || gap.shots.some(s => !required.includes(s.index) || needsBack(s))) throw new Error("背面补图项必须覆盖实际背面镜头，替代动作不得继续展示背面");
    return { ...gap, id: key, productName: product.name };
  });
}

export function applySideViewChoice(units, gaps, productId) {
  const result = structuredClone(units), selected = gaps.filter(g => g.product_id === productId);
  if (!selected.length) throw new Error("没有当前商品的背面补图选项");
  for (const gap of selected) {
    const unit = result.find(u => u.id === gap.unit_id);
    const shots = unitShots(unit).map(s => structuredClone(s));
    for (const replacement of gap.shots) {
      const shot = shots[replacement.index];
      Object.assign(shot, { camera: replacement.camera, action: replacement.action,
        required_product_views: [...new Set([...(shot.required_product_views || []).filter(v => v !== "back"), "front", "side"])] });
      for (const field of ["grok_prompt", "prompt", "keyframe_prompt"]) if (field in shot) shot[field] = `${replacement.camera}；${replacement.action}`;
    }
    // Do not leave the original rear-view instruction in a parallel prompt.
    // Timing, cast, props and all unrelated shot objects remain source-owned.
    unit.shot_plan = shots;
    unit.camera = shots.map(s => s.camera).join("；");
    unit.action = shots.map(s => s.action).join("；");
    unit.required_product_views = [...new Set(shots.flatMap(s => s.required_product_views || []))];
    unit.grok_prompt = shots.map(s => `[${s.start_s ?? 0}–${s.end_s ?? unit.duration_s}s] ${s.camera}；${s.action}；${s.scene || unit.scene || ""}`).join("\n");
    unit.keyframe_prompt = `${shots[0].camera}；${shots[0].action}；${shots[0].scene || unit.scene || ""}`;
    unit.view_policy = { mode: "front_slight_side", product_ids: [...new Set([...(unit.view_policy?.product_ids || []), productId])], max_angle_degrees: 30 };
  }
  return result;
}

export function viewPolicyText(unit) {
  return unit.view_policy?.mode === "front_slight_side" ? `本段已选择不补背面图，适用商品 ${unit.view_policy.product_ids.join("、")}：${SIDE_VIEW_RULE}` : "";
}

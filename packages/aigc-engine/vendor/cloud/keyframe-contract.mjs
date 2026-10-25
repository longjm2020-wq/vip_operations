import { sceneInstructions } from "../shared/scene-catalog.mjs";
import { randomUUID } from "node:crypto";
import { unitCastInstructions } from "../shared/project-cast.mjs";
import { consistencyInstructions, referenceEntries, sourceReferenceText, unitProductLock } from "./consistency.mjs";
import { productTruthRevision } from "./product-truth.mjs";
import { viewPolicyText } from "./product-view-policy.mjs";

export const KEYFRAME_REVIEW_VERSION = 4;

export const PRODUCT_CHECKS = [
  { id: "silhouette", label: "版型、衣长、腰线与穿着位置一致" },
  { id: "neck_sleeve", label: "领口、袖型、袖口与下摆一致" },
  { id: "hardware", label: "纽扣、拉链、口袋的数量与位置一致" },
  { id: "pattern", label: "花纹、印字、Logo 与拼接一致" },
  { id: "material", label: "颜色、面料纹理与透明度一致" },
  { id: "coverage", label: "关键细节清晰可见，未用遮挡或虚构细节代替" },
];

export const IDENTITY_CHECKS = [
  { id: "identity", label: "每个人的人脸、五官比例与人物资产一致，没有美颜改脸" },
  { id: "face_separation", label: "人数与角色一致，多张脸独立，未融合、复制或互换" },
  { id: "role_product", label: "逐人核对商品归属，无串穿、混款；与其他片段身份和款式一致" },
  { id: "opening_shot", label: "首帧的姿态、景别、机位与本段开场分镜一致，关键细节可辨" },
];
export const SPATIAL_PRODUCT_CHECKS = [
  { id: "structure_anchors", label: "逐项对照原图：领缘/滚边路径、腰线、抽绳出口及结点未移位，未新增装饰线" },
  { id: "pattern_anchors", label: "纹样本体、尺度、密度、方向与衣片落点一致，未用近似图案替代" },
  { id: "source_evidence", label: "以本商品组原图为准；编译文字有冲突不采信，未知区域未脑补，未靠遮挡掩盖错误" },
];
export const WEARABLE_CHECKS = [
  { id: "bundled_accessories", label: "原配腰带、系绳及配饰的材质、结构、数量、固定点和穿戴关系未被增删替换" },
  { id: "source_artifacts", label: "无源服装、首饰、吊牌绳或展示物残留，也未将其改成滚边、蝴蝶结或流苏" },
  { id: "fit_datum", label: "尺寸基准和穿戴落点有依据；未擅自换算围度、编造离地高度或抹除设计褶皱" },
];
export const KEYFRAME_CHECKS = [...IDENTITY_CHECKS, ...PRODUCT_CHECKS, ...SPATIAL_PRODUCT_CHECKS, ...WEARABLE_CHECKS];
export function reviewChecks(gate) {
  // Already released jobs retain the review contract used for their paid plan.
  if (gate?.phase === "released" && gate.version === 1) return PRODUCT_CHECKS;
  if (gate?.phase === "released" && gate.version === 2) return [...IDENTITY_CHECKS, ...PRODUCT_CHECKS];
  if (gate?.phase === "released" && gate.version === 3) return [...IDENTITY_CHECKS, ...PRODUCT_CHECKS, ...SPATIAL_PRODUCT_CHECKS];
  return KEYFRAME_CHECKS;
}
export function frameApproved(gate, frame) {
  return Boolean(frame?.asset && frame.status === "approved" && frame.approvedRevision === frame.revision && (gate.version < 3 || (gate.truthRevision && frame.approvedTruthRevision === gate.truthRevision)) && reviewChecks(gate).every(check => frame.checks?.includes(check.id)));
}

export function referenceFiles(project) {
  return [...project.assets.modelImages, ...project.assets.productImages, ...(project.sceneMode === "custom" ? project.assets.sceneImages : [])];
}

export function referenceLegend(project) {
  return referenceEntries(project).map(entry => entry.label).join("\n");
}

export function createKeyframeGate(artifacts, startIndex = 0) {
  return { version: KEYFRAME_REVIEW_VERSION, phase: "draft", startIndex, sourceFingerprint: artifacts.sourceFingerprint, frames: artifacts.units.slice(startIndex).map(unit => ({ unitId: unit.id, revision: randomUUID(), status: "empty", correction: "", history: [] })) };
}

export function hasKeyframeApproval(gate, unitId) {
  const frame = gate?.frames?.find(f => f.unitId === unitId);
  return gate?.phase === "released" && frameApproved(gate, frame);
}

export function keyframePrompt(project, artifacts, unit, correction = "") {
  return [
    "制作一张本段视频的开场验收关键帧：人物与商品都必须准确，不要拼图、分镜格、文字标注或设计变体。",
    unitCastInstructions(project, unit),
    "以首个分镜的姿态、景别、机位、构图和道具关系为准，不能改成通用正面站姿，也不能把后续镜头提前拼进首帧；多角色各自独立绑定，人脸与商品由独立视觉模型自动核对，不融合为一人。",
    referenceLegend(project),
    "本次商品证据修订（不是视觉验收通过声明）：" + productTruthRevision(project, artifacts.productLock),
    "商品观察清单（原图优先；文字冲突或来源未核实项不得用于改写商品）：" + JSON.stringify(unitProductLock(project, unit, artifacts.productLock)),
    "开场分镜：" + JSON.stringify(unit.shot_plan?.[0] || { camera: unit.camera, action: unit.action, scene: unit.scene }),
    "关键帧要求：" + (unit.keyframe_prompt || unit.camera || "选择能清楚核对人物与商品的首个画面"),
    sceneInstructions(project),
    correction ? "本次仅修正以下验收问题，其余身份、商品结构与开场分镜保持：" + correction : "",
    "本段源服装及额外禁项（商品原图优先）：" + (unit.negative_constraints || []).join("；"),
    consistencyInstructions(project, unit),
    viewPolicyText(unit),
  ].filter(Boolean).join("\n");
}

export function lockedVideoPrompt(project, unit, keyframeIndex, productLock, inputMode = "references", hasReviewedFrame = true) {
  const firstFrame = inputMode === "first-frame";
  const prompt = [
    firstFrame
      ? "唯一输入图片是本段已核对通过的首帧，承载已经对照人物与商品原图确认的身份、穿戴和构图。直接开始动画，按分镜切换镜头，不重新设计衣服。下文原图来源名称仅解释证据出处，不是额外输入；针对人物原图旧穿搭的排除，不得指向首帧中已确认的商品。"
      : "逐人锁定身份，逐组锁定商品，按本段分镜时间表生成。以下图片角色映射覆盖旧脚本中的任何编号假设：\n" + referenceLegend(project) + (hasReviewedFrame ? "\n<IMAGE_" + keyframeIndex + ">：本段已核对通过的穿戴关键帧；沿用身份、商品形态、开场构图与颜色，商品原图始终是设计真值。" : "\n仅使用以上当前项目原图，不存在额外关键帧。人物原图确定身份，商品原图确定设计细节；不得将不同角色融合。"),
    unitCastInstructions(project, unit),
    "商品观察清单（不得覆盖原图和已完成的逐项验收）：" + JSON.stringify(unitProductLock(project, unit, productLock, { firstFrame })),
    sceneInstructions(project),
    "原时间线（保持总时长）：\n" + (unit.grok_prompt || ""),
    "分镜时间表（秒数是本段内时间，必须逐镜头执行）：" + JSON.stringify(unit.shot_plan || []),
    "禁止项：" + (unit.negative_constraints || []).join("；"),
    consistencyInstructions(project, unit, { firstFrame }),
    viewPolicyText(unit),
  ].filter(Boolean).join("\n");
  // Single-image routes must never refer to absent numbered original assets,
  // including numbers carried by old scripts, locks or shot descriptions.
  return firstFrame ? sourceReferenceText(project, prompt) : prompt;
}

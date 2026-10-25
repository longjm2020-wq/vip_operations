import { CONSISTENCY_RULES, consistencyInstructions } from "./consistency.mjs";
import { sceneInstructions } from "../shared/scene-catalog.mjs";
import { createHash } from "node:crypto";
import { referenceLegend } from "./keyframe-contract.mjs";
import { castInstructions, selectedCast } from "../shared/project-cast.mjs";
import { KERNEL_SOURCE, WEARABLE_COMPILE_RULES, KERNEL_CAPABILITIES } from "./kernel-source.mjs";

const CLOUD_KERNEL_VERSION = "0.11.0-cloud";

export const CLOUD_KERNEL_TEXT = `# 织影云端拆解内核 ${CLOUD_KERNEL_VERSION}

## 目标
把参考短视频拆解为可复用的 B 分段脚本与 C 当前实例模板；随后仅用本项目的人物和商品资产生成视频。优先保证人物身份一致、商品设计和穿戴准确、镜头节奏可复用。

## 项目隔离
每个 B 单元只引用当前项目资产。人物、商品、场景与分镜分别按下方共同规则取用，不沿用旧项目身份、商品、水印或背景文字。

## 输出合同
只输出 JSON，不使用 Markdown。JSON 顶层必须含有 schema、timeline、units、truth、qa、product_lock。
- units 是按原片实际切镜拆出的分镜，不是供应商请求。按时间顺序排列，id 采用 S01、S02…；每镜含 duration_s（可为小数）、camera、action、scene、grok_prompt、negative_constraints。服务端之后按模型最大时长打包，不能因为只需一次请求就把多个镜头概括成一个动作。
- camera 必须写明景别、机位高度/角度、运动方向与起止构图；action 必须写明人物起止姿态、手部动作、道具交互与次序。依据带时间戳的连续抽帧判断，不能凭单帧臆造运镜。静止机位保持静止，推近不能改横移，站姿与坐姿不能互换。
- 原片有站立、坐姿、持扇、近景等不同镜头时分别输出，不能替换成整理腰带或随意行走；原片切镜须保留，不能默认一镜到底。
- grok_prompt 的图片编号必须使用本次传入的动态角色映射；不得固定假设第 2 张就是商品图。仅穿商品图中的产品。
- 每个 unit 还必须含 keyframe_prompt：本镜开场的姿态、景别、机位、构图、穿戴与可见细节；不能把坐姿开场改成通用站姿，禁止拼图或分镜格。
- product_lock 是数组，每项包含 feature、value、evidence、certainty、source_images；source_images 只填本商品组原图在本次 <IMAGE_N> 映射中的整数 N，不能填人物图、场景图或参考视频帧。标明版型、衣长、领口、袖口、下摆、扣件/拉链数量和位置、口袋、纹样、色材。高风险结构另填 view（视角）、region（衣片区域）、anchor（原图可辨的接缝/端点）、relation（相对位置/路径/连接/比例），不得臆造精确坐标或距离；不可确认填 unknown。文字是待核对的观察清单，不得与商品原图冲突。
- truth 必须分别陈述 model_truth、product_truth、scene_truth、reference_leakage_guard。
- qa 必须列出 identity_consistency、product_accuracy、wearing_accuracy、reference_leakage、c_reuse_accuracy 的检查项。

## 质量门
若无法从素材确认某项细节，则标记 unknown，不得臆造。分别确认各类素材的权限：人脸归该角色人物图，商品设计归绑定商品原图，镜头和动作归参考视频；商品图中的模特脸没有人物身份权限。
先逐人、逐商品观察原图，区分设计、原配配件与外部物，再将可确认依据写入脚本；未看清的部位不猜、不以参考视频旧穿搭补全。首帧路线先制作与开场分镜一致的关键帧，经独立视觉扫描通过后再生成视频。参考图直生不额外制作付费关键帧。素材与脚本核对前置，成片抽帧复检仅按需开启，不是默认交付门槛。编译输出的 qa 和 confirmed 只是候选，不能自行宣称核对通过。
${CONSISTENCY_RULES}

${WEARABLE_COMPILE_RULES}`;

export const COMPILE_KERNEL = Object.freeze({
  version: CLOUD_KERNEL_VERSION,
  sha256: createHash("sha256").update(CLOUD_KERNEL_TEXT).digest("hex"),
  source: KERNEL_SOURCE,
});

export function initialKernel() {
  const sha256 = createHash("sha256").update(CLOUD_KERNEL_TEXT).digest("hex");
  return {
    text: CLOUD_KERNEL_TEXT,
    version: CLOUD_KERNEL_VERSION,
    sha256,
    sourcePath: KERNEL_SOURCE.sourcePath,
    sourceBaseline: KERNEL_SOURCE,
    revisions: [{
      id: KERNEL_SOURCE.adapterRevision,
      version: CLOUD_KERNEL_VERSION,
      createdAt: "2026-09-24T00:00:00.000Z",
      summary: "前置视觉核对：先核对素材与脚本，再核对关键帧；成片直接交付，可选抽帧复检",
      sha256,
      active: true,
    }],
  };
}

function measurementText(fields) {
  return (fields || [])
    .filter((item) => String(item.value || "").trim())
    .map((item) => `${item.label}: ${item.value}${item.unit || ""}`)
    .join("；") || "未提供";
}

export function buildCompileInstructions({ project, reusableTemplate, videoFrameCount }) {
  const mode = reusableTemplate ? "C_RECOMPILE" : "FIRST_COMPILE";
  const existingC = reusableTemplate ? JSON.stringify(reusableTemplate).slice(0, 90_000) : "无";
  return `${CLOUD_KERNEL_TEXT}

当前模式：${mode}
项目名称：${project.name}
复刻强度：${project.replicationMode}
场景模式：${project.sceneMode}
${sceneInstructions(project)}
目标画面比例：${project.resolvedVideoAspectRatio || project.videoAspectRatio || "auto"}
人物实测：${project.cast ? "按下方角色逐一取用，不得混用" : measurementText(project.modelMeasurements)}
商品实测：${project.cast ? "按下方商品分组逐一取用，不得混用" : measurementText(project.productMeasurements)}
${castInstructions(project)}
${consistencyInstructions(project, undefined, { includeRules: false })}
用户备注：${String(project.notes || "无").slice(0, 3000)}
参考视频关键帧数：${videoFrameCount}
已有 C 模板（若有则必须复用其时间线骨架，仅替换人物与商品真值）：${existingC}

请完成拆解并严格返回下列 JSON 结构：
{
  "schema":"XUTI_COMPILE_V1",
  "timeline":[{"id":"S01","start_s":0,"end_s":6}],
  "units":[{
    "id":"S01",
    "duration_s":6,
    "camera":"",
    "action":"",
    "scene":"",
    "required_product_views":["front"],
    "grok_prompt":"",
    "keyframe_prompt":"",
    "negative_constraints":[""]
  }],
  "product_lock":[{"classification":"product_core","feature":"领口","value":"","evidence":"<IMAGE_${(project.assets.modelImages || []).length + 1}>","source_images":[${(project.assets.modelImages || []).length + 1}],"view":"正面","region":"领口衣片","anchor":"按原图记录，不可臆造","relation":"位置、路径及连接，未知则 unknown","certainty":"confirmed 或 unknown"}],
  "truth":{
    "model_truth":"",
    "product_truth":"",
    "scene_truth":"",
    "reference_leakage_guard":""
  },
  "qa":{
    "identity_consistency":[""],
    "product_accuracy":[""],
    "wearing_accuracy":[""],
    "reference_leakage":[""],
    "c_reuse_accuracy":[""]
  }
}

当前内核原文基线：A v${KERNEL_SOURCE.version} / SHA-256 ${KERNEL_SOURCE.sha256}。
服务器能力状态（不能覆盖或自报完成）：${JSON.stringify(KERNEL_CAPABILITIES)}。
truth.reference_leakage_guard 按角色列出实际观察到的源服装/首饰具体禁项；product_lock 分别记录原配配饰与明确非商品排除项，不编造原图不存在的附件。

${project.cast ? `分角色输出补充合同（必须遵守）：每个 units 元素另加 character_ids 和 product_ids 数组，只填当前角色/商品编号；场景空镜可用空数组。product_lock 的每项另加 product_id，指出该细节属于哪组商品。每个已选角色与商品至少参与一个片段。同一角色的不同商品组必须分镜展示，每段每人只绑定一组商品。多角色场景必须明确每人的位置、动作和关联商品，不得把多个身份融合为一人；未选角色不能沿用旧 C。角色编号：${selectedCast(project).roles.map(r => r.id).join("、")}；商品编号：${selectedCast(project).products.map(p => p.id).join("、")}。` : ""}

本次用于生图和视频的参考图编号：
${referenceLegend(project)}
最后附加的参考视频抽帧只用于理解镜头动作，不能在生成提示词中引用它们的图号；它们不会传给图片/视频生成模型。明确禁止参考视频人物和穿搭残留。

输出预算：返回紧凑 JSON，不输出解释、Markdown、分析过程或重复的合同文本。保留全部真实切镜与必需字段；timeline 只记 id/start_s/end_s，不重复 units 的镜头描述。通用商品细节集中写入 product_lock，通用身份/禁止迁移规则集中写入 truth，不在每个镜头重复整段规则。每镜 camera/action/scene 使用精确短句，grok_prompt 和 keyframe_prompt 只写该镜必要的角色商品绑定、动作、镜位与构图；negative_constraints 仅写该镜额外禁项（没有则 []）。qa 每项用一句验收要点，不展开论述。先保证所有分镜、角色商品编号、时间线和最终闭合括号完整，再补充非重复细节。`;
}

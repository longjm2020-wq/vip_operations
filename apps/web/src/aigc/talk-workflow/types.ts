import type {
  DigitalHumanCharacter,
  WorkflowAssetsConfig,
  WorkflowCharacterAngle,
  WorkflowCozyClayState,
  WorkflowDeconstructData,
  WorkflowEffect,
  WorkflowFilter,
  WorkflowModelConfig,
  WorkflowMotion,
  WorkflowRunMode,
  WorkflowShot,
  WorkflowShotPostEdit,
  WorkflowStage,
  WorkflowSubtitleStyle,
  WorkflowTransition,
} from "../../../../../packages/contracts/src/commerce-talk-workflow";

export type WorkflowShotView = WorkflowShot & {
  storyboardUrl?: string;
  greyboxUrl?: string;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  audioUrl?: string;
  clipUrl?: string;
};

export type WorkflowView = {
  id: string;
  title: string;
  runMode: WorkflowRunMode;
  stage: WorkflowStage;
  sourcePlatform: string;
  sourceUrl?: string;
  sourceMeta: Record<string, unknown>;
  referenceAssetId?: string;
  referenceVideoUrl?: string;
  deconstructData?: WorkflowDeconstructData;
  assetsConfig: WorkflowAssetsConfig;
  modelConfig: WorkflowModelConfig;
  shots: WorkflowShotView[];
  cozyclayState: WorkflowCozyClayState & { importedProjectUrl?: string };
  maxSpeechCny?: number;
  outputAssetId?: string;
  videoUrl?: string;
  downloadUrl?: string;
  message?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowCatalog = {
  scriptModels: Array<{
    id: string;
    label: string;
    provider: string;
    configured: boolean;
    description: string;
  }>;
  imageModels: Array<{
    id: string;
    label: string;
    configured: boolean;
    maxImages: number;
    detail: string;
  }>;
  voiceModels: Array<{
    id: string;
    label: string;
    provider: string;
    cnyPer10k: number;
    configured: boolean;
  }>;
  lipSyncModels: Array<{
    id: string;
    label: string;
    provider: string;
    configured: boolean;
    note: string;
  }>;
  videoModels: Array<{
    id: string;
    providerId: string;
    modelId: string;
    label: string;
    configured: boolean;
    supportsPrevis: boolean;
    resolutions: string[];
    durations: number[];
    note: string;
  }>;
  cozyclayBaseUrl: string;
  presenters: Array<{
    id: string;
    name: string;
    voiceKind: "default" | "cloned";
    voiceProvider?: "agentai" | "bailian";
    voiceModel?: string;
    engine?: "fal";
  }>;
  characters?: DigitalHumanCharacter[];
  defaults: {
    deconstructModel: string;
    scriptModel: string;
    storyboardImageModel: string;
    voiceModel: string;
    lipSyncModel: string;
    videoModel: string;
  };
};

export const stageLabels: Record<WorkflowStage, string> = {
  draft: "草稿准备",
  importing: "正在导入参考视频",
  deconstructing: "正在逆向拆解爆款",
  review_deconstruct: "待审核：爆款拆解结果",
  scripting: "正在重构分镜脚本",
  review_script: "待审核：分镜脚本",
  storyboarding: "正在生成分镜图",
  review_storyboard: "待审核：分镜图",
  previs: "三维预演（CozyClay）",
  producing: "正在生成配音与分镜视频",
  review_clips: "待审核：分镜成片",
  rendering: "正在合成最终视频",
  completed: "已完成",
  failed: "执行失败",
  uncertain: "结果待核实",
};

export const shotTypeLabels: Record<WorkflowShot["type"], string> = {
  talking_head: "数字人口播（对口型）",
  previs_video: "CozyClay 三维预演视频",
  broll_video: "AI 穿搭展示（B-roll）",
  product_insert: "商品实拍特写",
};

export const characterAngleLabels: Record<WorkflowCharacterAngle, string> = {
  auto: "智能匹配脚本角度",
  front_closeup: "正面近景特写",
  front_medium: "正面中景展示",
  side_profile: "45°~90° 侧面轮廓",
  back_turn: "背面展示 / 回眸转身",
  walking_full: "全身动态走位",
  over_shoulder: "过肩 / 对镜自拍",
};

export const transitionLabels: Record<WorkflowTransition, string> = {
  none: "无转场（硬切）",
  fade: "叠化淡入",
  wipeleft: "向左擦除",
  wiperight: "向右擦除",
  slideleft: "左滑推镜",
  slideright: "右滑推镜",
  circleopen: "圆形展开",
  zoomin: "缩放闪切",
  dissolve: "柔和溶解",
  fadeblack: "黑场过渡",
};

export const filterLabels: Record<WorkflowFilter, string> = {
  none: "原色",
  warm_fashion: "暖调穿搭质感",
  cool_editorial: "冷调杂志高级",
  vintage_film: "复古胶片",
  high_contrast: "高对比吸睛",
  soft_beauty: "柔光美颜提亮",
  bw_cinema: "黑白电影",
};

export const effectLabels: Record<WorkflowEffect, string> = {
  none: "无特效",
  vignette: "暗角聚焦",
  flash_in: "开场白闪冲击",
  rgb_shake: "节奏微震动",
  sharpen_pop: "细节锐化增强",
  film_grain: "胶片颗粒",
  glow_soft: "梦幻柔光",
};

export const motionLabels: Record<WorkflowMotion, string> = {
  none: "静止 / 原画",
  zoom_in: "缓慢推进",
  zoom_out: "缓慢拉远",
  pan_left: "平滑左摇",
  pan_right: "平滑右摇",
  pop_in: "弹性缩放进场",
};

export const subtitleStyleLabels: Record<WorkflowSubtitleStyle, string> = {
  classic: "经典白字黑描边",
  hormozi_pop: "爆款大字弹跳黄",
  karaoke_glow: "卡拉OK逐字扫光",
  minimal_bar: "极简半透明底条",
  neon_pink: "时尚霓虹花字",
};

export const defaultShotPostEdit: WorkflowShotPostEdit = {
  transition: "none",
  transitionDurationSec: 0.4,
  filter: "none",
  effect: "none",
  motion: "none",
  subtitleStyle: "classic",
  titleOverlay: "",
};

/** 播放器实时 CSS 滤镜预览映射 */
export const previewCssFilterMap: Record<WorkflowFilter, string> = {
  none: "none",
  warm_fashion: "contrast(1.06) brightness(1.03) saturate(1.18) sepia(0.12)",
  cool_editorial: "contrast(1.1) saturate(0.92) hue-rotate(-6deg)",
  vintage_film: "contrast(1.08) saturate(0.82) sepia(0.24)",
  high_contrast: "contrast(1.22) saturate(1.24)",
  soft_beauty: "contrast(0.96) brightness(1.06) saturate(1.08)",
  bw_cinema: "grayscale(1) contrast(1.18)",
};

export function isWorkflowActive(stage?: WorkflowStage): boolean {
  return Boolean(
    stage &&
      [
        "importing",
        "deconstructing",
        "scripting",
        "storyboarding",
        "producing",
        "rendering",
      ].includes(stage),
  );
}

export function stageStepIndex(stage: WorkflowStage): number {
  if (["draft", "importing", "deconstructing", "review_deconstruct"].includes(stage))
    return 0;
  if (["scripting", "review_script"].includes(stage)) return 2;
  if (["storyboarding", "review_storyboard"].includes(stage)) return 3;
  if (stage === "previs") return 4;
  return 5;
}

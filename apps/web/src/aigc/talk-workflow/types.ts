import type {
  WorkflowAssetsConfig,
  WorkflowCozyClayState,
  WorkflowDeconstructData,
  WorkflowModelConfig,
  WorkflowRunMode,
  WorkflowShot,
  WorkflowStage,
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

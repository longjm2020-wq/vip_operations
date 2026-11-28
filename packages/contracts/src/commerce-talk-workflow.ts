import { z } from "zod";

/** 服装口播工作流运行模式：全自动 / 人工介入修改 */
export const workflowRunModes = ["auto", "assisted"] as const;
export type WorkflowRunMode = (typeof workflowRunModes)[number];

/** 服装口播工作流阶段状态机 */
export const workflowStages = [
  "draft",
  "importing",
  "deconstructing",
  "review_deconstruct",
  "scripting",
  "review_script",
  "storyboarding",
  "review_storyboard",
  "previs",
  "producing",
  "review_clips",
  "rendering",
  "completed",
  "failed",
  "uncertain",
] as const;
export type WorkflowStage = (typeof workflowStages)[number];

/** 后台轮询需要自动推进的活动阶段 */
export const workflowActiveStages: readonly WorkflowStage[] = [
  "importing",
  "deconstructing",
  "scripting",
  "storyboarding",
  "producing",
  "rendering",
];

/** 人工介入等待审核的阶段 */
export const workflowReviewStages: readonly WorkflowStage[] = [
  "review_deconstruct",
  "review_script",
  "review_storyboard",
  "previs",
  "review_clips",
];

/** 分镜类型 */
export const workflowShotTypes = [
  "talking_head", // 数字人口播对口型
  "previs_video", // CozyClay 三维预演 + 多模态参考生视频
  "broll_video", // AI 视频生成（穿搭展示/空镜/动作）
  "product_insert", // 商品实拍特写（图文动效）
] as const;
export type WorkflowShotType = (typeof workflowShotTypes)[number];

/** 数字人出镜视角与站位（打破固定正面口播局限，支持三视图多角度出镜） */
export const workflowCharacterAngles = [
  "auto",
  "front_closeup",
  "front_medium",
  "side_profile",
  "back_turn",
  "walking_full",
  "over_shoulder",
] as const;
export type WorkflowCharacterAngle = (typeof workflowCharacterAngles)[number];

/** 数字人角色库单条定义（面部 + 正面/背面/侧面三视图 + 克隆音色） */
export const digitalHumanCharacterSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(60),
    persona: z.string().trim().max(400).default(""),
    faceAssetId: z.string().uuid().optional(),
    frontAssetId: z.string().uuid().optional(),
    backAssetId: z.string().uuid().optional(),
    sideAssetId: z.string().uuid().optional(),
    faceUrl: z.string().max(500).optional(),
    frontUrl: z.string().max(500).optional(),
    backUrl: z.string().max(500).optional(),
    sideUrl: z.string().max(500).optional(),
    voiceId: z.string().trim().max(180).default(""),
    voiceName: z.string().trim().max(120).default(""),
    voiceProvider: z.string().trim().max(40).default(""),
    voiceModel: z.string().trim().max(80).default(""),
    authorized: z.boolean().default(false),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type DigitalHumanCharacter = z.infer<typeof digitalHumanCharacterSchema>;

/** 创建/更新数字人角色请求体 */
export const upsertDigitalHumanCharacterSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    persona: z.string().trim().max(400).default(""),
    voiceId: z.string().trim().max(180).default(""),
    voiceName: z.string().trim().max(120).default(""),
    voiceProvider: z.string().trim().max(40).default(""),
    voiceModel: z.string().trim().max(80).default(""),
    authorized: z.boolean().default(true),
  })
  .strict();
export type UpsertDigitalHumanCharacterInput = z.infer<
  typeof upsertDigitalHumanCharacterSchema
>;

/** 镜头转场预设（对应 FFmpeg xfade 与 AE 转场关键帧） */
export const workflowTransitions = [
  "none",
  "fade",
  "wipeleft",
  "wiperight",
  "slideleft",
  "slideright",
  "circleopen",
  "zoomin",
  "dissolve",
  "fadeblack",
] as const;
export type WorkflowTransition = (typeof workflowTransitions)[number];

/** 画面色彩滤镜预设 */
export const workflowFilters = [
  "none",
  "warm_fashion",
  "cool_editorial",
  "vintage_film",
  "high_contrast",
  "soft_beauty",
  "bw_cinema",
] as const;
export type WorkflowFilter = (typeof workflowFilters)[number];

/** 画面特效预设 */
export const workflowEffects = [
  "none",
  "vignette",
  "flash_in",
  "rgb_shake",
  "sharpen_pop",
  "film_grain",
  "glow_soft",
] as const;
export type WorkflowEffect = (typeof workflowEffects)[number];

/** 运镜与关键帧动画预设 */
export const workflowMotions = [
  "none",
  "zoom_in",
  "zoom_out",
  "pan_left",
  "pan_right",
  "pop_in",
] as const;
export type WorkflowMotion = (typeof workflowMotions)[number];

/** 动态字幕样式预设（ASS 关键帧动效） */
export const workflowSubtitleStyles = [
  "classic",
  "hormozi_pop",
  "karaoke_glow",
  "minimal_bar",
  "neon_pink",
] as const;
export type WorkflowSubtitleStyle = (typeof workflowSubtitleStyles)[number];

/** 单个分镜的后期剪辑与 AE 动效配置 */
export const workflowShotPostEditSchema = z
  .object({
    transition: z.enum(workflowTransitions).default("none"),
    transitionDurationSec: z.number().min(0.2).max(1.5).default(0.4),
    filter: z.enum(workflowFilters).default("none"),
    effect: z.enum(workflowEffects).default("none"),
    motion: z.enum(workflowMotions).default("none"),
    subtitleStyle: z.enum(workflowSubtitleStyles).default("classic"),
    titleOverlay: z.string().trim().max(24).default(""),
  })
  .strict();
export type WorkflowShotPostEdit = z.infer<typeof workflowShotPostEditSchema>;

/** AI 代码自动化智能剪辑请求体 */
export const aiEditWorkflowInputSchema = z
  .object({
    instruction: z.string().trim().max(1000).default(""),
    preset: z
      .enum(["douyin_viral", "editorial_cool", "vintage_fashion", "clean_talk", "custom"])
      .default("douyin_viral"),
  })
  .strict();
export type AiEditWorkflowInput = z.infer<typeof aiEditWorkflowInputSchema>;

/** 参考视频来源平台 */
export const workflowSourcePlatforms = [
  "douyin",
  "xhs",
  "url",
  "upload",
  "manual",
] as const;
export type WorkflowSourcePlatform = (typeof workflowSourcePlatforms)[number];

/** 预设强脚本/拆解模型推荐项（实际可用性由已配置的 OpenRouter / AgentAI / 中转站决定） */
export const recommendedScriptModels = [
  {
    id: "openrouter|google/gemini-4-neon",
    provider: "openrouter" as const,
    model: "google/gemini-4-neon",
    label: "Gemini 4 Neon（OpenRouter）",
    description: "强多模态视觉理解与爆款结构逆向拆解、分镜脚本生成",
  },
  {
    id: "openrouter|openai/gpt-6.2-astra",
    provider: "openrouter" as const,
    model: "openai/gpt-6.2-astra",
    label: "ChatGPT 6.2 Astra（OpenRouter）",
    description: "高一致性中文带货口播文案、强结构化 JSON 输出",
  },
  {
    id: "openrouter|openai/gpt-6.1-sol",
    provider: "openrouter" as const,
    model: "openai/gpt-6.1-sol",
    label: "GPT 6.1 Sol（OpenRouter 默认）",
    description: "稳定快速的通用口播脚本模型",
  },
] as const;

/** Magi-2 视频模型动态接入定义（支持 AgentAI / fal / 中转站动态发现） */
export const magi2VideoModelSpec = {
  id: "magi-2",
  label: "Magi-2",
  providerCandidates: ["agentai", "fal", "relay"] as const,
  modelSlugs: ["magi-2", "sand-ai/magi-2", "fal-ai/magi-2"] as const,
  durations: [4, 5, 6, 8, 10, 12, 15] as const,
  resolutions: ["720p", "1080p"] as const,
  aspects: ["9:16", "16:9", "1:1", "3:4", "4:3"] as const,
  maxImages: 4,
  note: "通过已接入的 AgentAI / fal / 中转站目录动态调用；支持高连贯服装动态与口播切镜。",
} as const;

/** 单个资产引用（角色/道具/场景图片或预演文件） */
export const workflowAssetItemSchema = z
  .object({
    id: z.string().min(1).max(120),
    name: z.string().trim().min(1).max(80),
    assetId: z.string().min(1).max(120),
    url: z.string().max(500).optional(),
    role: z.string().trim().max(40).optional(),
    note: z.string().trim().max(240).optional(),
  })
  .strict();
export type WorkflowAssetItem = z.infer<typeof workflowAssetItemSchema>;

/** 逆向拆解结构化结果 */
export const workflowDeconstructSchema = z
  .object({
    summary: z.string().trim().max(1200).default(""),
    hook: z.string().trim().max(400).default(""),
    pacing: z.string().trim().max(400).default(""),
    sellingPoints: z.array(z.string().trim().max(200)).max(12).default([]),
    targetAudience: z.string().trim().max(240).default(""),
    estimatedDurationSec: z.number().positive().max(300).optional(),
    referenceShots: z
      .array(
        z
          .object({
            index: z.number().int().positive(),
            timeRange: z.string().trim().max(40).default(""),
            shotType: z.string().trim().max(40).default(""),
            camera: z.string().trim().max(300).default(""),
            action: z.string().trim().max(400).default(""),
            transcript: z.string().trim().max(400).default(""),
            visualHook: z.string().trim().max(300).default(""),
          })
          .strict(),
      )
      .max(24)
      .default([]),
  })
  .strict();
export type WorkflowDeconstructData = z.infer<typeof workflowDeconstructSchema>;

/** 创作资产配置（数字人形象、角色、产品、道具、场景、拍摄需求） */
export const workflowAssetsConfigSchema = z
  .object({
    presenterId: z.string().uuid().optional(),
    characterLibraryIds: z.array(z.string().uuid()).max(6).default([]),
    productId: z.string().regex(/^\d+$/).optional(),
    productStyleNo: z.string().trim().max(80).optional(),
    productImageIds: z.array(z.string().min(1).max(100)).max(8).default([]),
    characters: z.array(workflowAssetItemSchema).max(8).default([]),
    props: z.array(workflowAssetItemSchema).max(12).default([]),
    scenes: z.array(workflowAssetItemSchema).max(8).default([]),
    garments: z.array(workflowAssetItemSchema).max(12).default([]),
    sceneKeywords: z.array(z.string().trim().max(80)).max(12).default([]),
    propKeywords: z.array(z.string().trim().max(80)).max(16).default([]),
    garmentKeywords: z.array(z.string().trim().max(80)).max(16).default([]),
    sceneMode: z.enum(["reference", "smart", "custom"]).default("smart"),
    creativeBrief: z.string().trim().max(2000).default(""),
    aspectRatio: z.enum(["9:16", "16:9", "1:1", "3:4"]).default("9:16"),
    targetDurationSec: z.number().int().min(5).max(120).default(20),
    pauseBeforePrevis: z.boolean().default(true),
    postEditDefaults: workflowShotPostEditSchema.partial().optional(),
  })
  .strict();
export type WorkflowAssetsConfig = z.infer<typeof workflowAssetsConfigSchema>;

/** 各环节独立执行模型配置 */
export const workflowModelConfigSchema = z
  .object({
    /** 爆款逆向拆解模型，格式 provider|modelId */
    deconstructModel: z.string().trim().max(200).optional(),
    /** 分镜脚本重构模型，格式 provider|modelId */
    scriptModel: z.string().trim().max(200).optional(),
    /** 分镜图生成模型 ID */
    storyboardImageModel: z.string().trim().max(120).optional(),
    /** 克隆音频模型（百炼或 AgentAI，覆盖或指示音色偏好） */
    voiceModel: z.string().trim().max(120).optional(),
    /** 对口型模型 ID（默认 fal-minimax-h3-max-lip-sync） */
    lipSyncModel: z.string().trim().max(120).optional(),
    /** 默认视频生成模型，格式 provider|modelId（如 bailian|minimax-h3、agentai|seedance-2-5、agentai|magi-2） */
    videoModel: z.string().trim().max(160).optional(),
    /** 视频画质 */
    videoResolution: z.string().trim().max(32).optional(),
  })
  .strict();
export type WorkflowModelConfig = z.infer<typeof workflowModelConfigSchema>;

/** 单个分镜定义（含脚本、分镜图、CozyClay 预演绑定、配音与成片片段） */
export const workflowShotSchema = z
  .object({
    id: z.string().regex(/^[\w-]{1,64}$/),
    order: z.number().int().min(1).max(60),
    title: z.string().trim().max(80).default(""),
    type: z.enum(workflowShotTypes).default("talking_head"),
    caption: z.string().trim().max(180).default(""),
    camera: z.string().trim().max(600).default(""),
    action: z.string().trim().max(800).default(""),
    props: z.string().trim().max(300).default(""),
    scene: z.string().trim().max(400).default(""),
    characterNames: z.array(z.string().trim().max(60)).max(6).default([]),
    characterId: z.string().uuid().optional(),
    characterAngle: z.enum(workflowCharacterAngles).optional(),
    productImageId: z.string().max(100).optional(),
    durationSec: z.number().min(2).max(30).default(5),
    storyboardPrompt: z.string().trim().max(2000).default(""),
    storyboardAssetId: z.string().max(120).optional(),
    cozyclayShotId: z.string().max(120).optional(),
    greyboxAssetId: z.string().max(120).optional(),
    firstFrameAssetId: z.string().max(120).optional(),
    lastFrameAssetId: z.string().max(120).optional(),
    audioAssetId: z.string().max(120).optional(),
    clipAssetId: z.string().max(120).optional(),
    operationId: z.string().max(200).optional(),
    videoModelOverride: z.string().trim().max(160).optional(),
    postEdit: workflowShotPostEditSchema.optional(),
    status: z
      .enum([
        "pending",
        "storyboarding",
        "ready",
        "producing",
        "completed",
        "failed",
      ])
      .default("pending"),
    error: z.string().max(300).optional(),
  })
  .strict();
export type WorkflowShot = z.infer<typeof workflowShotSchema>;

/** CozyClay 预演状态 */
export const workflowCozyClayStateSchema = z
  .object({
    exportedAt: z.string().optional(),
    importedProjectAssetId: z.string().max(120).optional(),
    importedProjectName: z.string().max(120).optional(),
    importedShots: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          sceneName: z.string(),
          startFrame: z.number().int(),
          endFrame: z.number().int(),
          characters: z.array(z.object({ id: z.string(), name: z.string() })),
        }),
      )
      .max(100)
      .default([]),
    skipped: z.boolean().default(false),
    authorized: z.boolean().default(false),
  })
  .strict();
export type WorkflowCozyClayState = z.infer<typeof workflowCozyClayStateSchema>;

/** 创建工作流请求体 */
export const createWorkflowInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    runMode: z.enum(workflowRunModes).default("assisted"),
    sourcePlatform: z.enum(workflowSourcePlatforms).default("manual"),
    sourceUrl: z.string().trim().max(4096).optional(),
    sourceMeta: z
      .object({
        title: z.string().trim().max(200).optional(),
        author: z.string().trim().max(100).optional(),
        coverUrl: z.string().trim().max(2048).optional(),
        fallbackVideoUrl: z.string().trim().max(4096).optional(),
        description: z.string().trim().max(2000).optional(),
        fromExtension: z.boolean().optional(),
      })
      .optional(),
    assetsConfig: workflowAssetsConfigSchema.partial().optional(),
    modelConfig: workflowModelConfigSchema.partial().optional(),
    maxSpeechCny: z.number().positive().multipleOf(0.01).max(50).optional(),
    autoStart: z.boolean().default(false),
  })
  .strict();

/** 更新工作流（人工介入修改）请求体 */
export const updateWorkflowInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    runMode: z.enum(workflowRunModes).optional(),
    deconstructData: workflowDeconstructSchema.optional(),
    assetsConfig: workflowAssetsConfigSchema.partial().optional(),
    modelConfig: workflowModelConfigSchema.partial().optional(),
    shots: z.array(workflowShotSchema).max(24).optional(),
    cozyclayState: workflowCozyClayStateSchema.partial().optional(),
    maxSpeechCny: z
      .number()
      .positive()
      .multipleOf(0.01)
      .max(50)
      .nullable()
      .optional(),
  })
  .strict();

/** 推进工作流请求体 */
export const advanceWorkflowInputSchema = z
  .object({
    action: z.enum([
      "deconstruct",
      "script",
      "storyboard",
      "skip_previs",
      "produce",
      "render",
      "auto_finish",
    ]),
  })
  .strict();

/** 智能导入 / AI 对话 / 爆款链接 / 剧本建项模式 */
export const smartCreateModes = [
  "auto",
  "chat",
  "viral_link",
  "script",
] as const;
export type SmartCreateMode = (typeof smartCreateModes)[number];

/** AI 智能意图识别建项请求体 */
export const smartCreateWorkflowInputSchema = z
  .object({
    mode: z.enum(smartCreateModes).default("auto"),
    prompt: z.string().trim().max(12000).default(""),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().trim().min(1).max(4000),
          })
          .strict(),
      )
      .max(16)
      .default([]),
    scriptFileName: z.string().trim().max(160).optional(),
    scriptContent: z.string().trim().max(20000).optional(),
    attachmentNames: z.array(z.string().trim().max(160)).max(10).default([]),
    orchestratorModel: z.string().trim().max(200).optional(),
    modelConfig: workflowModelConfigSchema.partial().optional(),
    previewOnly: z.boolean().default(false),
  })
  .strict();
export type SmartCreateWorkflowInput = z.infer<
  typeof smartCreateWorkflowInputSchema
>;

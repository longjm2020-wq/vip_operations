import { z } from "zod";

export const directorRoles = [
  "product",
  "portrait",
  "voiceSample",
  "narration",
  "reference",
  "document",
] as const;
export const directorEffects = [
  "none",
  "fade",
  "push-in",
  "callout",
  "size-card",
  "ae-template",
] as const;
export const directorModes = ["manual", "smart"] as const;
export const directorOutputs = ["script", "video"] as const;
export const directorDeliverables = [
  "video",
  "storyboard",
  "srt",
  "plan",
] as const;
export const directorAspects = ["9:16", "16:9", "1:1"] as const;
export const directorAssetLimit = 500;
export const emptyDirectorLocks = {
  all: false,
  script: false,
  asset: false,
  effect: false,
} as const;
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const text = (max: number) => z.string().trim().max(max);
const ms = z.number().int().min(0).max(86_400_000);
const revision = z.number().int().min(1).max(2147483647);
const label = text(160).min(1);
const fileName = text(255)
  .min(1)
  .refine(
    (s) => !/[\\/\u0000-\u001f]/u.test(s) && ![".", ".."].includes(s),
    "请选择单个文件",
  );
const uniqueIds = (items: { id: string }[]) =>
  new Set(items.map((item) => item.id)).size === items.length;

export const directorAssetSchema = z
  .object({
    id: uuid,
    source: z.enum(["local", "library"]),
    role: z.enum(directorRoles),
    fileId: uuid.optional(),
    localId: uuid.optional(),
    deviceId: uuid.optional(),
    name: fileName,
    mime: text(128).min(1),
    durationMs: ms.optional(),
    note: text(2000).optional(),
    authorized: z.boolean().optional(),
  })
  .strict()
  .refine(
    (a) =>
      a.source === "local"
        ? !!a.localId && !!a.deviceId && !a.fileId
        : !!a.fileId && !a.localId && !a.deviceId,
    "请绑定工作台文件或指定设备上的本机文件",
  );
export const directorShotSchema = z
  .object({
    id: uuid,
    title: text(180),
    script: text(3600),
    caption: text(3600),
    visualId: uuid.optional(),
    audioId: uuid.optional(),
    voiceSampleId: uuid.optional(),
    portraitId: uuid.optional(),
    startMs: ms.default(0),
    audioStartMs: ms.default(0),
    durationMs: z.number().int().min(100).max(600_000),
    effect: z.enum(directorEffects).default("none"),
    effectText: text(300).optional(),
    templateId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .optional(),
    locks: z
      .object({
        all: z.boolean(),
        script: z.boolean(),
        asset: z.boolean(),
        effect: z.boolean(),
      })
      .strict()
      .default(emptyDirectorLocks),
    evidence: text(2000).optional(),
    purpose: text(400).optional(),
    framing: text(400).optional(),
    direction: text(700).optional(),
  })
  .strict();
const documentFields = {
  title: label,
  brief: text(8000),
  mode: z.enum(directorModes),
  output: z.enum(directorOutputs),
  aspect: z.enum(directorAspects),
  durationMs: z.number().int().min(1000).max(600_000),
  assets: z
    .array(directorAssetSchema)
    .max(directorAssetLimit, `每个项目最多使用 ${directorAssetLimit} 份素材`)
    .refine(uniqueIds, "素材编号重复"),
  shots: z.array(directorShotSchema).max(100).refine(uniqueIds, "分镜编号重复"),
};
export const directorCreateSchema = z
  .object(documentFields)
  .partial()
  .extend({ requestId: uuid, title: label })
  .strict();
export const directorPatchSchema = z
  .object(documentFields)
  .partial()
  .extend({ revision })
  .strict();
export const directorStoryboardSchema = z
  .object({
    revision,
    instruction: text(4000).optional(),
    shotId: uuid.optional(),
    count: z.number().int().min(1).max(40).optional(),
  })
  .strict();
export const directorSuggestionSchema = z
  .object({
    revision,
    shotId: uuid,
    instruction: text(4000).optional(),
    count: z.union([z.literal(2), z.literal(3)]).default(2),
  })
  .strict();
export const directorReferenceSchema = z
  .object({
    revision,
    assetId: uuid,
    frames: z
      .array(z.object({ fileId: uuid, timeMs: ms }).strict())
      .min(1)
      .max(8)
      .optional(),
  })
  .strict();
export const directorAnalysisSchema = z
  .object({
    frameSource: z.enum(["sampled", "provided"]).optional(),
    assetId: uuid,
    summary: text(4000).min(1),
    beats: z
      .array(z.object({ timeMs: ms, description: text(1200).min(1) }).strict())
      .min(1)
      .max(24),
    model: text(200).min(1),
  })
  .strict();
export const directorRenderCreateSchema = z
  .object({
    revision,
    deviceId: uuid,
    shotId: uuid.optional(),
    confirm: z.boolean().optional(),
  })
  .strict();
export const directorRenderUpdateSchema = z
  .object({
    jobId: uuid,
    status: z.enum(["running", "paused", "failed", "done"]),
    progress: z.number().int().min(0).max(100),
    stage: text(500).min(1),
    outputs: z.array(z.enum(directorDeliverables)).max(4).optional(),
  })
  .strict();
export type DirectorAsset = z.infer<typeof directorAssetSchema>;
export type DirectorShot = z.infer<typeof directorShotSchema>;
export type DirectorReferenceAnalysis = z.infer<typeof directorAnalysisSchema>;
export type DirectorRender = {
  id: string;
  projectId: string;
  version: number;
  revision: number;
  deviceId: string;
  shotId?: string;
  jobId?: string;
  status: "queued" | "running" | "paused" | "failed" | "done";
  progress: number;
  stage: string;
  outputs: (typeof directorDeliverables)[number][];
  createdAt: string;
  updatedAt: string;
};
export type DirectorProjectSummary = {
  id: string;
  title: string;
  revision: number;
  mode: (typeof directorModes)[number];
  output: (typeof directorOutputs)[number];
  createdAt: string;
  updatedAt: string;
};
export type DirectorProject = DirectorProjectSummary & {
  brief: string;
  aspect: (typeof directorAspects)[number];
  durationMs: number;
  assets: DirectorAsset[];
  shots: DirectorShot[];
  referenceAnalysis: DirectorReferenceAnalysis | null;
  referenceAnalyses?: DirectorReferenceAnalysis[];
  renders: DirectorRender[];
};
export type DirectorSnapshot = Omit<DirectorProject, "renders">;

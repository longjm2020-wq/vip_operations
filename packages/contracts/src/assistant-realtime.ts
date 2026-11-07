import { z } from "zod";

export const realtimeModel = "gpt-realtime-2.1";
export const realtimeVoices = ["marin", "cedar", "coral", "shimmer"] as const;
export const doubaoRealtimeVoices = [
  "zh_female_vv_uranus_bigtts",
  "zh_female_xiaohe_uranus_bigtts",
  "zh_male_m191_uranus_bigtts",
  "zh_male_taocheng_uranus_bigtts",
] as const;
export const qwenRealtimeModel = "qwen3.8-omni-flash-realtime";
export const qwenRealtimeVoices = ["Tina", "Serena", "Mia", "Ryan"] as const;
export const qwenWorkspaceIdSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "请填写北京地域的业务空间 ID，不要填写网址",
  );
export type RealtimeProvider = "openai" | "doubao" | "qwen";
export const realtimeSettingsSchema = z
  .object({
    version: z.number().int().min(0),
    enabled: z.boolean(),
    provider: z.enum(["openai", "doubao", "qwen"]).default("openai"),
    voice: z.string().min(1).max(100),
    workspaceId: qwenWorkspaceIdSchema.optional(),
    freeQuotaOnlyConfirmed: z.boolean().optional(),
    apiKey: z
      .string()
      .trim()
      .min(20)
      .max(512)
      .regex(/^[!-~]+$/)
      .optional(),
    clearKey: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) =>
      v.provider === "doubao"
        ? (doubaoRealtimeVoices as readonly string[]).includes(v.voice)
        : v.provider === "qwen"
          ? (qwenRealtimeVoices as readonly string[]).includes(v.voice)
          : (realtimeVoices as readonly string[]).includes(v.voice),
    "请选择当前通道的声音",
  )
  .refine(
    (v) =>
      !v.apiKey ||
      v.provider === "doubao" ||
      /^sk-(?!or-)[!-~]+$/.test(v.apiKey),
    "请填写当前通道的专用密钥",
  )
  .refine((v) => !(v.apiKey && v.clearKey), "不能同时清除和填写密钥")
  .refine(
    (v) => v.provider !== "qwen" || !!v.workspaceId,
    "请填写北京地域的业务空间 ID",
  )
  .refine(
    (v) =>
      v.provider === "qwen" ||
      (v.workspaceId === undefined && v.freeQuotaOnlyConfirmed === undefined),
    "费用保护与业务空间只适用于所选通道",
  )
  .refine(
    (v) =>
      v.provider !== "qwen" ||
      !v.enabled ||
      v.clearKey ||
      v.freeQuotaOnlyConfirmed === true,
    "请先在服务控制台开启免费额度用完即停并确认已生效",
  );
export const realtimeStartSchema = z
  .object({
    id: z.string().uuid(),
    sdp: z
      .string()
      .min(40)
      .max(65536)
      .refine(
        (v) => v.startsWith("v=0") && /m=audio\s/.test(v),
        "无效的音频连接请求",
      )
      .optional(),
    includePersonalContext: z.boolean().default(false),
    includeMemory: z.boolean().default(false),
    desktopDeviceId: z.string().uuid().optional(),
    model: z
      .string()
      .regex(/^engine\/[a-f0-9]{24}$/)
      .optional(),
  })
  .strict()
  .refine((v) => !v.model || !!v.desktopDeviceId, "电脑操作能力需选择执行电脑");
export const realtimeToolNames = [
  "workspace_request",
  "desktop_request",
] as const;
export type RealtimeToolName = (typeof realtimeToolNames)[number];
export function isRealtimeToolName(value: unknown): value is RealtimeToolName {
  return realtimeToolNames.some((name) => name === value);
}
export const realtimeToolSchema = z
  .object({
    tool: z.enum(realtimeToolNames).default("workspace_request"),
    callId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w-]+$/),
    request: z.string().trim().min(1).max(4000),
  })
  .strict();
export const realtimeCaptionsSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            role: z.enum(["user", "assistant"]),
            text: z.string().trim().min(1).max(12000),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();
export type RealtimeStatus = {
  provider?: RealtimeProvider;
  transport?: "webrtc" | "websocket";
  profiles?: Record<
    RealtimeProvider,
    {
      voice: string;
      apiKeyConfigured: boolean;
      verifiedAt: string | null;
      error: string;
      workspaceId?: string;
      freeQuotaOnlyConfirmed?: boolean;
    }
  >;
  enabled: boolean;
  ready: boolean;
  voice: string;
  apiKeyConfigured: boolean;
  encryptionReady: boolean;
  verifiedAt: string | null;
  error: string;
  canManage: boolean;
  version: number;
};
export type RealtimeToolResult = {
  text: string;
  navigation?: string;
  messageId?: string;
  desktopTaskId?: string;
};

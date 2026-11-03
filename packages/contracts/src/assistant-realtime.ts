import { z } from "zod";

export const realtimeModel = "gpt-realtime-2.1";
export const realtimeVoices = ["marin", "cedar", "coral", "shimmer"] as const;
export const realtimeSettingsSchema = z
  .object({
    version: z.number().int().min(0),
    enabled: z.boolean(),
    voice: z.enum(realtimeVoices),
    apiKey: z
      .string()
      .trim()
      .min(20)
      .max(512)
      .regex(/^sk-(?!or-)[!-~]+$/)
      .optional(),
    clearKey: z.boolean().default(false),
  })
  .strict()
  .refine((v) => !(v.apiKey && v.clearKey), "不能同时清除和填写密钥");
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
      ),
    includePersonalContext: z.boolean().default(false),
    includeMemory: z.boolean().default(false),
  })
  .strict();
export const realtimeToolSchema = z
  .object({
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
};

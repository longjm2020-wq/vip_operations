import { z } from "zod";
import { qwenWorkspaceIdSchema } from "./assistant-realtime.js";
export const qwenDictationModel = "qwen3.8-omni-flash";
export const qwenSpeechModel = "qwen3-tts-flash";
export const qwenSpeechVoices = [
  "Serena",
  "Cherry",
  "Ethan",
  "Chelsie",
] as const;
export type VoiceProvider = "openrouter" | "qwen";
export const voiceModels = [
  "openai/gpt-audio",
  "openai/gpt-audio-mini",
] as const;
export const voiceNames = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
] as const;
export const voiceSettingsSchema = z
  .object({
    version: z.number().int().min(0),
    enabled: z.boolean(),
    provider: z.enum(["openrouter", "qwen"]).default("openrouter"),
    model: z.enum([...voiceModels, qwenDictationModel]),
    voice: z.string().min(1).max(100),
    workspaceId: qwenWorkspaceIdSchema.optional(),
    useRealtimeCredentials: z.boolean().default(false),
    apiKey: z
      .string()
      .trim()
      .min(20)
      .max(512)
      .regex(/^sk-[!-~]+$/)
      .optional(),
    clearKey: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) =>
      v.provider === "qwen"
        ? v.model === qwenDictationModel &&
          (qwenSpeechVoices as readonly string[]).includes(v.voice)
        : (voiceModels as readonly string[]).includes(v.model) &&
          (voiceNames as readonly string[]).includes(v.voice),
    "请选择当前服务支持的模型和声音",
  )
  .refine(
    (v) =>
      !v.apiKey ||
      (v.provider === "qwen"
        ? /^sk-(?!or-)/.test(v.apiKey)
        : /^sk-or-/.test(v.apiKey)),
    "请填写当前服务的专用密钥",
  )
  .refine(
    (v) =>
      v.provider === "qwen"
        ? !!v.workspaceId || v.useRealtimeCredentials
        : !v.workspaceId && !v.useRealtimeCredentials,
    "请填写千问北京地域的业务空间 ID",
  )
  .refine(
    (v) => !v.useRealtimeCredentials || (!v.apiKey && !v.clearKey),
    "复用连接时不能同时填写或清除密钥",
  )
  .refine((v) => !(v.apiKey && v.clearKey), "不能同时清空和填写密钥");
export const voiceTurnSchema = z
  .object({
    id: z.string().uuid(),
    audio: z
      .string()
      .min(100)
      .max(1600100)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    includePersonalContext: z.boolean().default(false),
    includeMemory: z.boolean().default(false),
  })
  .strict();
export const voiceSpeechSchema = z
  .object({ id: z.string().uuid(), messageId: z.string().uuid() })
  .strict();
export const voiceDictationSchema = voiceTurnSchema.pick({
  id: true,
  audio: true,
});
export type AssistantDictationStatus = {
  ready: boolean;
  message: string;
  maxSeconds: number;
};
export type AssistantVoiceStatus = {
  provider?: VoiceProvider;
  speechModel?: string;
  workspaceId?: string;
  profiles?: Record<
    VoiceProvider,
    {
      model: string;
      voice: string;
      apiKeyConfigured: boolean;
      verifiedAt: string | null;
      workspaceId?: string;
    }
  >;
  ready: boolean;
  enabled: boolean;
  model: string;
  voice: string;
  apiKeyConfigured: boolean;
  encryptionReady: boolean;
  verifiedAt: string | null;
  error: string;
  canManage: boolean;
  version: number;
  maxSeconds: number;
  assistantReady: boolean;
};
export type VoiceEvent =
  | { type: "stage"; stage: "transcribing" | "thinking" | "speaking" }
  | { type: "transcript"; text: string }
  | { type: "reply"; text: string; messageId: string }
  | { type: "audio"; data: string }
  | { type: "model"; model: string }
  | { type: "spoken"; text: string }
  | { type: "retry-listening" }
  | { type: "navigate"; toolId: string }
  | { type: "done" }
  | { type: "error"; message: string };

import { z } from "zod";
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
    model: z.enum(voiceModels),
    voice: z.enum(voiceNames),
    apiKey: z
      .string()
      .trim()
      .min(20)
      .max(512)
      .regex(/^sk-or-[!-~]+$/)
      .optional(),
    clearKey: z.boolean().default(false),
  })
  .strict()
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
export type AssistantVoiceStatus = {
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

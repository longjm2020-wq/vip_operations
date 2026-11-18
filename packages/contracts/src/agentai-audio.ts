import { z } from "zod";

export const agentAiAudioModel = z.enum(["speech-2.8", "doubao-tts-2.0"]);
export const agentAiAudioInputSchema = z
  .object({
    model: agentAiAudioModel,
    input: z.string().trim().min(1).max(5000),
    voice: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9_-]+$/),
    speed: z.enum(["0.5", "0.75", "1", "1.25", "1.5", "2"]).default("1"),
    emotion: z
      .enum(["auto", "happy", "sad", "angry", "fearful", "surprised", "calm"])
      .default("auto"),
    tier: z.enum(["hd", "turbo"]).default("hd"),
    responseFormat: z.enum(["mp3", "wav"]).default("mp3"),
  })
  .strict();
export const agentAiSpeechSchema = z
  .object({
    quoteId: z.string().uuid(),
    requestId: z.string().uuid(),
  })
  .strict();
export const agentAiCloneSchema = z
  .object({
    requestId: z.string().uuid(),
    name: z.string().trim().min(1).max(50),
    previewText: z.string().trim().max(300).default(""),
    consentAgreed: z.literal("true"),
    consentStatementVersion: z.literal("voice-v1"),
  })
  .strict();
export type AgentAiAudioInput = z.infer<typeof agentAiAudioInputSchema>;
export type AgentAiAudioVoice = {
  id: string;
  name: string;
  model: "speech-2.8" | "doubao-tts-2.0";
  status: "ready" | "processing" | "expired";
  custom: boolean;
};
export type AgentAiAudioQuote = {
  quoteId: string;
  model: string;
  characters: number;
  estimatedCny: number;
  maxCny: number;
  freezeCny: number;
  expiresAt: string;
};
export type AgentAiAudioTask = {
  id: string;
  kind: "speech" | "clone";
  model: string;
  name: string;
  status: "submitting" | "processing" | "completed" | "failed" | "uncertain";
  providerTaskId: string | null;
  voiceId: string | null;
  characters: number;
  estimatedCny: number | null;
  maxCny: number | null;
  errorNote: string;
  resultHref: string | null;
  createdAt: string;
  updatedAt: string;
};
export type AgentAiAudioState = {
  ready: boolean;
  voices: AgentAiAudioVoice[];
  tasks: AgentAiAudioTask[];
  maxCharacters: number;
  consentStatementVersion: "voice-v1";
};

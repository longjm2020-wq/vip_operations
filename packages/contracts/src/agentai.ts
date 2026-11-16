import { z } from "zod";

export const agentaiBaseUrl = "https://agentai.token6688.com/v1";
export const agentaiModelName = z
  .string()
  .trim()
  .min(1)
  .max(140)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
  .refine((value) => !value.includes("://"), "请输入模型标识");
export const agentaiSaveSchema = z
  .object({
    version: z.number().int().nonnegative(),
    enabled: z.boolean(),
    apiKey: z
      .union([
        z.literal(""),
        z
          .string()
          .trim()
          .min(16)
          .max(512)
          .regex(/^[A-Za-z0-9._-]+$/),
      ])
      .optional(),
    clearKey: z.boolean().default(false),
  })
  .strict();
export const agentaiTestSchema = z
  .object({
    model: agentaiModelName,
    capability: z.enum(["chat", "tools", "structured"]).default("chat"),
  })
  .strict();
export type AgentAiCatalogModel = {
  model: string;
  publicId?: string;
  name: string;
  type: string;
  vision: boolean;
  available: boolean;
  paramSchema?: Record<string, unknown>;
};
export type AgentAiModel = AgentAiCatalogModel & {
  id: string;
  pdf: false;
  parameters: string[];
  chatVerifiedAt: string | null;
  toolsVerifiedAt: string | null;
  structuredVerifiedAt: string | null;
};
export type AgentAiStatus = {
  enabled: boolean;
  endpoint: string;
  apiKeyConfigured: boolean;
  encryptionReady: boolean;
  verifiedAt: string | null;
  errorNote: string;
  version: number;
  catalogAt: string | null;
  models: AgentAiModel[];
};

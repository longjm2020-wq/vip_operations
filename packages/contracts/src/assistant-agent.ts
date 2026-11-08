import { z } from "zod";

export const agentModelId = z
  .string()
  .trim()
  .min(3)
  .max(160)
  .regex(/^[\w.:-]+\/[\w./:-]+$/);
export type AgentFile = {
  id: string;
  name: string;
  mime: string;
  size: number;
  source: "upload" | "generated";
  createdAt: string;
  note?: string;
  duration?: number;
};
export type AgentModel = {
  id: string;
  name: string;
  displayName?: string;
  vision: boolean;
  pdf: boolean;
  structured: boolean;
  parameters: string[];
};
export type AgentCatalog = {
  models: AgentModel[];
  imageModels: { id: string; name: string; reference: boolean }[];
  defaultModel: string;
  notice: string;
};
export type AgentJob = {
  id: string;
  requestId: string;
  kind: "document" | "image" | "video";
  title: string;
  status: "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELED";
  stage: string;
  progress: number;
  error: string;
  model?: string;
  files: AgentFile[];
  createdAt: string;
  updatedAt: string;
};
const cell = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const documentJobSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    format: z.enum(["docx", "xlsx", "pptx", "md", "txt", "csv"]),
    // Each section is a Word heading, a worksheet or a slide. No executable code/formulas.
    sections: z
      .array(
        z
          .object({
            heading: z.string().max(100),
            text: z.string().max(12000),
            rows: z.array(z.array(cell).max(30)).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(24),
  })
  .strict()
  .refine(
    (v) => JSON.stringify(v).length <= 100000,
    "文档内容过大，请分成多个文件",
  );
export const imageJobSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    prompt: z.string().trim().min(1).max(6000),
    referenceIds: z.array(z.string().uuid()).max(4).default([]),
    aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).default("1:1"),
  })
  .strict();
export const videoJobSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    clips: z
      .array(
        z
          .object({
            fileId: z.string().uuid(),
            start: z.number().min(0).max(1800),
            end: z.number().positive().max(1800),
            speed: z.number().min(0.5).max(2).default(1),
          })
          .strict()
          .refine((v) => v.end > v.start, "结束时间必须晚于开始时间"),
      )
      .min(1)
      .max(12),
    aspectRatio: z
      .enum(["original", "16:9", "9:16", "1:1"])
      .default("original"),
    mute: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) => v.clips.reduce((s, c) => s + (c.end - c.start) / c.speed, 0) <= 600,
    "成片最长10分钟",
  );

export const videoGenerationSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    prompt: z.string().trim().min(1).max(6000),
    referenceIds: z.array(z.string().uuid()).min(1).max(4),
    duration: z.number().int().min(1).max(15),
    aspectRatio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]),
  })
  .strict();

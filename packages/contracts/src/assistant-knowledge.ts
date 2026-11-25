import { z } from "zod";
import { maxEmployees } from "./assistant-employees.js";

export const knowledgeTitleLimit = 160;
export const knowledgeContentLimit = 1_000_000;
const textValue = z
  .string()
  .refine((value) => !value.includes("\0"), "文本包含无效字符");
export const knowledgeSaveSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().nonnegative().max(2147483646),
    title: z.string().trim().min(1).max(knowledgeTitleLimit).pipe(textValue),
    content: z
      .string()
      .min(1)
      .max(knowledgeContentLimit)
      .pipe(textValue)
      .refine((value) => value.trim().length > 0, "正文不能为空"),
    employeeIds: z.array(z.string().uuid()).max(maxEmployees),
  })
  .strict();

export type KnowledgeNoteSummary = {
  id: string;
  title: string;
  version: number;
  updatedAt: string;
  employeeIds: string[];
};
export type KnowledgeNote = KnowledgeNoteSummary & { content: string };
export const knowledgeOverviewSchema = z.object({
  total: z.number().int().nonnegative(),
  recent: z
    .array(z.object({ id: z.string().uuid(), title: z.string() }))
    .max(3),
});
export type KnowledgeOverview = z.infer<typeof knowledgeOverviewSchema>;
export type KnowledgeRevision = Omit<KnowledgeNote, "employeeIds">;
export type KnowledgeDirectory = {
  notes: KnowledgeNoteSummary[];
  links: { sourceId: string; targetId: string }[];
};
export type KnowledgeHit = {
  noteId: string;
  title: string;
  version: number;
  heading: string;
  excerpt: string;
};

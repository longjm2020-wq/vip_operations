import { z } from "zod";

export const selectionStandardsAIModeSchema = z.enum(["blank", "replace"]);
export type SelectionStandardsAIMode = z.infer<typeof selectionStandardsAIModeSchema>;
export const standardsFieldKind = (label: string) => label === "安全类别" ? "safety" as const : label === "执行标准" ? "standard" as const : null;
export const standardsTargetEligible = (mode: SelectionStandardsAIMode, value: unknown) => mode === "replace" || !String(value ?? "").trim();
const id = z.string().regex(/^[1-9]\d{0,18}$/);
const key = z.string().regex(/^custom:[a-zA-Z0-9:-]+$/).max(100);
const unique = (values: string[]) => new Set(values).size === values.length;
export const selectionStandardsAIGenerateSchema = z.object({
  rowIds: z.array(id).min(1).max(5).refine(unique, "行不能重复"),
  targetKeys: z.array(key).min(1).max(2).refine(unique, "字段不能重复"),
  mode: selectionStandardsAIModeSchema.default("blank"),
}).strict();
export const selectionStandardsAIApplySchema = z.object({
  planToken: z.string().min(20).max(40000),
  rows: z.array(z.object({
    id,
    values: z.array(z.object({ key, value: z.string().trim().min(1).max(100) }).strict()).min(1).max(2)
      .refine(values => unique(values.map(value => value.key)), "字段不能重复"),
  }).strict()).min(1).max(5).refine(values => unique(values.map(value => value.id)), "行不能重复"),
}).strict();
export const selectionStandardsAIPreviewSchema = z.object({
  planToken: z.string().min(20), expiresAt: z.string().datetime(), model: z.string(), catalogCheckedAt: z.string(),
  warnings: z.array(z.string()),
  rows: z.array(z.object({
    id, xutiStyleNo: z.string(), evidence: z.array(z.string()), warnings: z.array(z.string()),
    values: z.array(z.object({
      key, label: z.string(), previousValue: z.string(), value: z.string(), reason: z.string(),
      source: z.object({ name: z.string(), url: z.string().url() }).nullable(),
    })),
  })),
});
export type SelectionStandardsAIPreview = z.infer<typeof selectionStandardsAIPreviewSchema>;

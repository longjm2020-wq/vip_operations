import { z } from "zod";

/** The AI long-title minimum always counts original Unicode code points. */
export const SELECTION_AI_LONG_TITLE_MIN_CHARACTERS = 29;

const rowId = z.string().regex(/^[1-9]\d{0,18}$/);
const fieldKey = z.string().regex(/^custom:[a-zA-Z0-9:-]+$/).max(100);
export const selectionTitleAIGenerateSchema = z.object({
  rowIds: z.array(rowId).min(1).max(10).refine(values => new Set(values).size === values.length, "行不能重复"),
  targetKeys: z.array(fieldKey).min(1).max(2).refine(values => new Set(values).size === values.length, "字段不能重复"),
  preferences: z.object({ usePoeticName: z.boolean().default(true), instruction: z.string().trim().max(400).default("") }).strict().optional(),
}).strict();
export const selectionTitleAIApplySchema = z.object({
  planToken: z.string().min(20).max(40000),
  rows: z.array(z.object({
    id: rowId,
    titles: z.array(z.object({ key: fieldKey, value: z.string().trim().min(1).max(2000) }).strict()).min(1).max(2)
      .refine(values => new Set(values.map(value => value.key)).size === values.length, "字段不能重复"),
  }).strict()).min(1).max(10).refine(values => new Set(values.map(value => value.id)).size === values.length, "行不能重复"),
}).strict();
export type SelectionTitleAIStatus = { ready: boolean; message: string };
export type SelectionTitleAICandidate = {
  key: string; label: string; kind: "long" | "short"; value: string;
  minCharacters: number; maxLength: number; countMode: "characters" | "han";
};
export type SelectionTitleAIRow = {
  id: string; xutiStyleNo: string; expectedUpdatedAt: string;
  titles: SelectionTitleAICandidate[]; evidence: string[]; warnings: string[];
};
export type SelectionTitleAIPreview = {
  planToken: string; expiresAt: string; model: string;
  rows: SelectionTitleAIRow[]; warnings: string[];
};
export type SelectionTitleAIApplyResult = { updatedCount: number; ids: string[] };

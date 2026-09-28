import { z } from "zod";
export const filterModes = ["contains", "notContains", "equals", "notEquals", "starts", "ends", "gt", "gte", "lt", "lte", "between", "empty", "filled"] as const;
export const selectionFilterSchema = z.object({
  mode: z.enum(filterModes).default("contains"), value: z.string().max(5000).default(""), end: z.string().max(5000).optional(),
  values: z.array(z.string().max(20000)).max(20000).optional(),
  colorType: z.enum(["fill", "text"]).optional(), colors: z.array(z.string().max(20)).max(20).optional(),
}).strict();
export const selectionViewSchema = z.object({
  filters: z.record(z.string().max(100), selectionFilterSchema).refine(value => Object.keys(value).length <= 100, "最多 100 列筛选"),
  sort: z.object({ key: z.string().min(1).max(100), direction: z.enum(["asc", "desc"]) }).strict().nullable(),
}).strict();
export type SelectionFilter = z.infer<typeof selectionFilterSchema>;
export type SelectionView = z.infer<typeof selectionViewSchema>;

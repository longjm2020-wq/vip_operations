import { z } from "zod";

export const libraryKindSchema = z.enum(["sop", "project", "table"]);
export type LibraryKind = z.infer<typeof libraryKindSchema>;
export const libraryAccessSchema = z.enum(["EDIT", "READ", "DENY"]);
export type LibraryAccess = z.infer<typeof libraryAccessSchema>;
export const libraryAccessOptions = [
  { value: "EDIT", label: "可编辑" },
  { value: "READ", label: "仅查看" },
  { value: "DENY", label: "禁止访问" },
];
export const libraryCollaboratorsSchema = z.object({
  version: z.number().int().positive(),
  members: z.array(z.object({
    userId: z.string().regex(/^[1-9]\d{0,18}$/).refine(value=>BigInt(value)<=9223372036854775807n),
    access: libraryAccessSchema,
  }).strict()).max(500).refine(values=>new Set(values.map(value=>value.userId)).size===values.length,"协作用户不能重复"),
}).strict();
export const visibilitySchema = z.enum(["PUBLIC", "PRIVATE"]);
export const visibilityOptions = [
  { value: "PRIVATE", label: "不公开" },
  { value: "PUBLIC", label: "公开" },
];
export const recycleDays = 30;
export const libraryLabels: Record<LibraryKind, string> = {
  sop: "SOP",
  project: "项目",
  table: "表格",
};

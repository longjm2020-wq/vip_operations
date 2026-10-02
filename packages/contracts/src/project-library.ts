import { z } from "zod";

export const libraryKindSchema = z.enum(["sop", "project", "table"]);
export type LibraryKind = z.infer<typeof libraryKindSchema>;
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

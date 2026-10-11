import { formatSelectionCreatedTime, parseSelectionCreatedTime } from "../../../packages/contracts/src/selection-created-time.js";

type Row = Record<string, any>;

/** This draft belongs only to the editable built-in creation-time column. */
export const hasSelectionCreationTimeDraft = (row: Row): boolean => typeof row.creationTimeDraft === "string";

export function selectionCreationTimeValue(row: Row, timeDisplay: "date" | "datetime" = "datetime"): string {
  return hasSelectionCreationTimeDraft(row) ? row.creationTimeDraft : formatSelectionCreatedTime(row.createdAt, timeDisplay);
}

/** Keep partial typing intact; only valid instants update the derived timestamp. */
export function withSelectionCreationTime(row: Row, input: unknown): Row {
  const creationTimeDraft = String(input ?? "");
  const createdAt = parseSelectionCreatedTime(creationTimeDraft);
  return { ...row, creationTimeDraft, ...(createdAt ? { createdAt } : {}) };
}

export function selectionCreationTimeError(row: Row): string | undefined {
  if (!hasSelectionCreationTimeDraft(row)) return;
  if (!row.creationTimeDraft.trim()) return "创建时间不能为空，请输入日期或日期时间";
  if (!parseSelectionCreatedTime(row.creationTimeDraft)) return "请输入有效的北京时间 YYYY-MM-DD 或 YYYY-MM-DD HH:mm[:ss]";
}

export function selectionCreationTimeForSave(row: Row): string | undefined {
  return parseSelectionCreatedTime(hasSelectionCreationTimeDraft(row) ? row.creationTimeDraft : row.createdAt) ?? undefined;
}

/** Equivalent timestamp spellings are equal; incomplete drafts remain dirty. */
export function selectionCreationTimeComparable(row: Row): string {
  if (hasSelectionCreationTimeDraft(row)) return parseSelectionCreatedTime(row.creationTimeDraft) ?? `draft:${row.creationTimeDraft}`;
  return parseSelectionCreatedTime(row.createdAt) ?? String(row.createdAt ?? "");
}

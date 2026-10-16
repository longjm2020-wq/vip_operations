import { formatSelectionCreatedTime, parseSelectionCreatedTime } from "../../../packages/contracts/src/selection-created-time.js";

type Row = Record<string, any>;

/** This draft belongs only to the editable built-in creation-time column. */
export const hasSelectionCreationTimeDraft = (row: Row): boolean => typeof row.creationTimeDraft === "string";
export const selectionHasCreationContent = (row: Row): boolean =>
  (Array.isArray(row.images) && row.images.length > 0) || !!String(row.xutiStyleNo ?? "").trim() || !!String(row.supplierStyleNo ?? "").trim();
/** A draft can contain a parsed date before the server has recorded the first entry. */
export const selectionCreationTimePending = (row: Row): boolean => typeof row.creationTimePending === "boolean" ? row.creationTimePending : !parseSelectionCreatedTime(row.createdAt);

export function selectionCreationTimeValue(row: Row, timeDisplay: "date" | "datetime" = "datetime"): string {
  return hasSelectionCreationTimeDraft(row) ? row.creationTimeDraft : selectionCreationTimePending(row) ? "" : formatSelectionCreatedTime(row.createdAt, timeDisplay);
}

/** Keep partial typing intact; only valid instants update the derived timestamp. */
export function withSelectionCreationTime(row: Row, input: unknown): Row {
  const creationTimeDraft = String(input ?? "");
  const createdAt = parseSelectionCreatedTime(creationTimeDraft);
  const creationTimePending = selectionCreationTimePending(row);
  return { ...row, creationTimeDraft, creationTimePending, ...(createdAt ? { createdAt } : creationTimePending && !creationTimeDraft.trim() ? { createdAt: null } : {}) };
}

export function selectionCreationTimeError(row: Row): string | undefined {
  if (!hasSelectionCreationTimeDraft(row)) return;
  if (!row.creationTimeDraft.trim()) return selectionCreationTimePending(row) ? undefined : "创建时间不能为空，请输入日期或日期时间";
  if (selectionCreationTimePending(row) && !selectionHasCreationContent(row)) return "请先录入商品图片、序缇款号或供应商款号，再设置创建时间";
  if (!parseSelectionCreatedTime(row.creationTimeDraft)) return "请输入有效的北京时间 YYYY-MM-DD、YYYY-MM-DD HH:mm[:ss]，也支持 Excel 的 YYYY/M/D H:mm[:ss]";
}

export function selectionCreationTimeForSave(row: Row): string | undefined {
  if (selectionCreationTimePending(row) && (!hasSelectionCreationTimeDraft(row) || !selectionHasCreationContent(row))) return;
  return parseSelectionCreatedTime(hasSelectionCreationTimeDraft(row) ? row.creationTimeDraft : row.createdAt) ?? undefined;
}

/** Equivalent timestamp spellings are equal; incomplete drafts remain dirty. */
export function selectionCreationTimeComparable(row: Row): string {
  if (hasSelectionCreationTimeDraft(row)) return !row.creationTimeDraft.trim() && selectionCreationTimePending(row) ? "" : parseSelectionCreatedTime(row.creationTimeDraft) ?? `draft:${row.creationTimeDraft}`;
  if (selectionCreationTimePending(row)) return "";
  return parseSelectionCreatedTime(row.createdAt) ?? String(row.createdAt ?? "");
}

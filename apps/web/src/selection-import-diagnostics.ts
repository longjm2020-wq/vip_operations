import type { SelectionImportImageColorDiagnostic } from "../../../packages/contracts/src/selection-import-diagnostics.js";

type ImageCellSource = { sheet: "选款资料" | "图片明细"; row: number; cell: string; line?: number };
export type SelectionImportWorkbookSource = {
  xutiStyleNo: string;
  row: number;
  colorCell?: { cell: string; label: string };
  images: ImageCellSource[];
};

// Keep worksheet coordinates local to this upload. They are never sent to or
// persisted by the API, and disappear when the parsed records are released.
const sources = new WeakMap<object, SelectionImportWorkbookSource>();
export function registerSelectionImportSource(record: object, source: SelectionImportWorkbookSource) {
  sources.set(record, source);
}

function imageColorDiagnostic(value: unknown): value is SelectionImportImageColorDiagnostic {
  if (!value || typeof value !== "object") return false;
  const detail = value as Partial<SelectionImportImageColorDiagnostic>;
  return detail.kind === "SELECTION_IMPORT_IMAGE_COLOR" &&
    typeof detail.rowIndex === "number" && Number.isInteger(detail.rowIndex) && detail.rowIndex >= 0 &&
    typeof detail.xutiStyleNo === "string" && !!detail.xutiStyleNo &&
    (detail.imageIndex === undefined ? detail.imageSource === "existing" :
      typeof detail.imageIndex === "number" && Number.isInteger(detail.imageIndex) && detail.imageIndex >= 0) &&
    ["import", "existing"].includes(detail.imageSource || "") &&
    ["import", "existing"].includes(detail.colorSource || "") &&
    (detail.imageColor === undefined || typeof detail.imageColor === "string") &&
    (detail.allowedColors === undefined || (Array.isArray(detail.allowedColors) && detail.allowedColors.every(color => typeof color === "string")));
}

/** Add real XLSX coordinates to a server error without inferring hidden values. */
export function formatSelectionImportError(error: unknown, records?: readonly Record<string, any>[] | null): string {
  const failure = error && typeof error === "object" ? error as { message?: unknown; details?: unknown } : {};
  const fallback = typeof failure.message === "string" ? failure.message : "导入失败，请重试";
  if (!imageColorDiagnostic(failure.details)) return fallback;
  const detail = failure.details, record = records?.[detail.rowIndex];
  if (!record || record.xutiStyleNo !== detail.xutiStyleNo) return fallback;
  const source = sources.get(record);
  if (!source || source.xutiStyleNo !== detail.xutiStyleNo) return fallback;
  const image = detail.imageSource === "import" && detail.imageIndex !== undefined ? source.images[detail.imageIndex] : undefined;
  // A stale or unknown index must retain the accurate server fallback rather
  // than attributing the error to another worksheet cell.
  if (detail.imageSource === "import" && !image) return fallback;
  const imageLocation = detail.imageSource === "existing"
    ? detail.imageIndex === undefined ? "系统已有图片" : `系统已有第 ${detail.imageIndex + 1} 张图片`
    : image!.sheet === "图片明细"
      ? `图片明细第 ${image!.row} 行（颜色单元格 ${image!.cell}）`
      : `选款资料第 ${image!.row} 行（图片单元格 ${image!.cell}，第 ${image!.line} 行内容）`;
  const imageColor = detail.imageColor === undefined ? "图片颜色" : `图片颜色「${detail.imageColor}」`;
  const colorLocation = detail.colorSource === "import"
    ? source.colorCell
      ? `对应选款资料第 ${source.row} 行（${source.colorCell.label}单元格 ${source.colorCell.cell}）`
      : `对应选款资料第 ${source.row} 行，本次文件未提供供应商颜色列`
    : `对应选款资料第 ${source.row} 行，本次沿用系统已有供应商颜色`;
  const allowed = detail.allowedColors === undefined ? "" : detail.allowedColors.length
    ? `；可用颜色：${detail.allowedColors.join("、")}`
    : "；当前供应商颜色为空";
  const remedy = detail.imageSource === "existing"
    ? "请保留已有图片对应的颜色，或同时导入颜色匹配的新图片后重新上传。"
    : "请核对图片颜色和该款供应商颜色后重新上传。";
  return `${imageLocation}，序缇款号「${detail.xutiStyleNo}」的${imageColor}不符合供应商颜色；${colorLocation}${allowed}。${remedy}`;
}

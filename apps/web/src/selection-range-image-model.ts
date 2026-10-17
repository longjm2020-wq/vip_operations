import type { RangeImageCell, RangeImageTable } from "./selection-range-image.js";
import {
  defaultTagConfig,
  fieldImages,
  orderedFieldTags,
  selectionOptionColor,
  splitChoiceValues,
  splitFieldTags,
  systemField,
  type SelectionField,
} from "./selection-field-types.js";
import { selectionSystemValue } from "./selection-system-fields.js";
import { selectionCreationTimeValue } from "./selection-creation-time.js";
import { formatSelectionValue } from "../../../packages/contracts/src/selection-format.js";

type Row = Record<string, any>;
type Image = { url: string; color?: string; colorFieldKey?: string };
type References = Record<string, { id: string; name: string }[]>;
export type SelectionRangeImageModelOptions = {
  rows: Row[];
  columns: SelectionField[];
  selectedCells: ReadonlySet<string>;
  headerKeys?: string[];
  fallbackCell?: { rowKey: string; columnKey: string };
  rowHeight: number;
  archiveReferences?: References;
  shownImages?: ReadonlyMap<string, { url: string; index?: number }>;
};

const cellId = (rowKey: string, columnKey: string) => `${rowKey}::${columnKey}`;
const backgrounds: Record<string, string> = {
  NONE: "#ffffff", ORANGE: "#fff1e7", GREEN: "#eef9e8", BLUE: "#edf5ff",
  YELLOW: "#fff8cf", PINK: "#fff0f3",
};
const tagColors: Record<string, { color: string; background: string }> = {
  orange: { color: "#d46b08", background: "#fff7e6" },
  blue: { color: "#0958d9", background: "#e6f4ff" },
  green: { color: "#389e0d", background: "#f6ffed" },
  purple: { color: "#531dab", background: "#f9f0ff" },
  red: { color: "#cf1322", background: "#fff1f0" },
  default: { color: "#595959", background: "#fafafa" },
};
const moneyKeys = new Set(["supplyPriceExclTax", "vipPrice", "livePrice", "tagPrice"]);

/** Mask before reading content: local drafts may still contain a revoked value. */
export function selectionRangeCellHidden(row: Row, column: SelectionField): boolean {
  return !!row.hiddenCells?.includes(column.key) ||
    (row.cellAccess?.[column.key] ?? row.defaultCellAccess) === "deny" ||
    !!((column.custom || column.key.startsWith("custom:")) && row.cellAccess && !Object.hasOwn(row.cellAccess, column.key));
}

function modelCell(row: Row, column: SelectionField, shown?: { url: string; index?: number }, references?: References): RangeImageCell {
  if (selectionRangeCellHidden(row, column)) return { text: "••••", color: "#8c8c8c" };
  const align = ["left", "center", "right"].includes(row.cellAlignments?.[column.key])
    ? row.cellAlignments[column.key] : "center";
  const verticalAlign = ["top", "middle", "bottom"].includes(row.cellVerticalAlignments?.[column.key])
    ? row.cellVerticalAlignments[column.key] : "middle";
  const cell: RangeImageCell = {
    text: "", align, verticalAlign,
    background: backgrounds[row.cellColors?.[column.key] || row.rowColor] || "#ffffff",
    color: row.cellTextColors?.[column.key] || "#46352a",
  };
  const type = column.type || column.fallbackType;
  if (column.key === "registrationBatch" && !column.custom) {
    cell.text = selectionCreationTimeValue(row, column.timeDisplay);
    return cell;
  }
  if (systemField(column)) {
    cell.text = selectionSystemValue(row, column, references);
    return cell;
  }
  const value = column.custom ? row.extraFields?.[column.key] : row[column.key];
  if (column.key === "images" || column.key === "labelImages" || type === "image") {
    const images: Image[] = column.custom ? fieldImages(value)
      : Array.isArray(value) ? value.filter((image: Image) => image && typeof image.url === "string") : [];
    // A rendered carousel choice is usable only while it remains in this row's authorized images.
    const index = shown ? images.findIndex(image => image.url === shown.url) : -1;
    const actualIndex = index >= 0 ? index : 0;
    const image = images[actualIndex];
    const labelKey = image?.colorFieldKey || "color";
    const hiddenLabel = labelKey === "protected" || !!row.hiddenCells?.includes(labelKey) ||
      (row.cellAccess?.[labelKey] ?? row.defaultCellAccess) === "deny" ||
      !!(image?.colorFieldKey && row.cellAccess && !Object.hasOwn(row.cellAccess, labelKey));
    if (image) cell.image = {
      url: image.url,
      label: column.key === "labelImages" || column.imageConfig?.colors === false || hiddenLabel ? undefined : image.color,
      badge: `${actualIndex + 1}/${images.length}`,
    };
    return cell;
  }
  if (column.key.startsWith("custom:product:")) {
    const reference = column.key.slice("custom:product:".length);
    const label = reference === "status"
      ? ({ ACTIVE: "在用", STOPPED: "停用", ARCHIVED: "归档" } as Record<string, string>)[String(value)]
      : references?.[reference]?.find(item => String(item.id) === String(value))?.name;
    if (label !== undefined) { cell.text = label; return cell; }
  }
  if (type === "single" || type === "multiple") {
    const text = String(value ?? "");
    const values = type === "multiple" ? splitChoiceValues(column, value) : text ? [text] : [];
    cell.tags = values.map(label => ({ label, color: "#ffffff", background: selectionOptionColor(column, label).background }));
    return cell;
  }
  if (type === "tags" || column.key === "color" || column.key === "sizeRange") {
    const values = type === "tags" ? orderedFieldTags(column, value) : splitFieldTags(value);
    const palette = type === "tags" ? tagColors[column.tagConfig?.color || defaultTagConfig.color] || tagColors.default
      : { color: "#76543f", background: "#fff1e5" };
    cell.tags = values.map(label => ({ ...palette, label, color: row.cellTextColors?.[column.key] || palette.color }));
    return cell;
  }
  if (type === "checkbox") { cell.text = String(value) === "true" ? "☑" : "☐"; return cell; }
  if (column.key === "collectionInventory") {
    const inventory = Array.isArray(value) ? value : [];
    cell.text = `${inventory.reduce((total: number, item: Row) => total + Number(item.available || 0) + Number(item.production || 0), 0)} 件 · 库存明细`;
    return cell;
  }
  const raw = String(value ?? "");
  if (["sellingPoints", "reorderDays"].includes(column.key) && value == null) {
    cell.text = "—";
    return cell;
  }
  const numberFormat = row.cellNumberFormats?.[column.key];
  cell.text = formatSelectionValue(raw, numberFormat);
  if (raw.trim() && (!numberFormat || numberFormat.type === "general")) {
    if (type === "currency" || !column.type && moneyKeys.has(column.key)) cell.text = `¥ ${cell.text}`;
    if (type === "percent") cell.text += "%";
  }
  return cell;
}

/** Selection bounds follow the table's display order, including virtual rows. */
export function buildSelectionRangeImageTable(options: SelectionRangeImageModelOptions): RangeImageTable {
  const { rows, columns, rowHeight, archiveReferences, shownImages } = options;
  const positions = new Map(rows.map((row, index) => [String(row._key), index]));
  const columnPositions = new Map(columns.map((column, index) => [column.key, index]));
  let selected = new Set(options.selectedCells);
  if (options.fallbackCell && !selected.has(cellId(options.fallbackCell.rowKey, options.fallbackCell.columnKey))) {
    selected = new Set([cellId(options.fallbackCell.rowKey, options.fallbackCell.columnKey)]);
  }
  let minRow = rows.length, maxRow = -1, minColumn = columns.length, maxColumn = -1;
  const usedColumns = new Set<number>(), usedRows = new Set<number>();
  let usedCells = 0;
  for (const id of selected) {
    const divider = id.indexOf("::");
    const r = positions.get(id.slice(0, divider)), c = columnPositions.get(id.slice(divider + 2));
    if (r === undefined || c === undefined) continue;
    minRow = Math.min(minRow, r); maxRow = Math.max(maxRow, r);
    minColumn = Math.min(minColumn, c); maxColumn = Math.max(maxColumn, c);
    usedColumns.add(c); usedRows.add(r); usedCells++;
  }
  if (maxRow < 0) {
    const keys = new Set(options.headerKeys || []);
    return { columns: columns.filter(column => keys.has(column.key)).map(({ key, label, width }) => ({ key, label, width })), rows: [], rowHeight };
  }
  // Whole non-contiguous Ctrl/⌘ column selections skip the unselected columns in between;
  // irregular cell selections keep their holes blank.
  const wholeColumns = usedColumns.size * usedRows.size === usedCells;
  const chosenColumns = columns.slice(minColumn, maxColumn + 1).filter((_, index) => !wholeColumns || usedColumns.has(minColumn + index));
  return {
    columns: chosenColumns.map(({ key, label, width }) => ({ key, label, width })),
    rows: rows.slice(minRow, maxRow + 1).map(row => ({
      key: String(row._key),
      cells: chosenColumns.map(column => {
        const id = cellId(String(row._key), column.key);
        return selected.has(id) ? modelCell(row, column, shownImages?.get(id), archiveReferences) : { text: "" };
      }),
    })),
    rowHeight,
  };
}

/** Headers are plain labels in display order; no filter, pin or sorting decoration. */
export function selectionRangeHeaderText(columns: SelectionField[], keys: readonly string[]): string {
  const selected = new Set(keys);
  return columns.filter(column => selected.has(column.key)).map(column => column.label).join("\t");
}

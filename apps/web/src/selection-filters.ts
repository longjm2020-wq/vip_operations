import type { SelectionFilter, SelectionView } from "../../../packages/contracts/src/selection-view.js";
type Row = Record<string, any>;
export type SelectionFilters = Record<string, SelectionFilter>;
const optionSets = new WeakMap<SelectionFilter, Set<string>>();
const moneyKeys = new Set(["supplyPriceExclTax", "vipPrice", "livePrice", "tagPrice"]);
export function selectionFilterValue(row: Row, key: string): string {
  if (key === "collectionInventory") return String((row.collectionInventory || []).reduce((sum: number, item: Row) => sum + item.available + item.production, 0));
  const value = key === "images" ? (row.images || []).map((image: Row) => `${image.color || ""} ${image.url || ""}`.trim()).join("\n") : key === "labelImages" ? (row.labelImages || []).map((image: Row) => image.url || "").join("\n") : key.startsWith("custom:") ? row.extraFields?.[key] : row[key];
  const text = String(value ?? "").trim();
  return moneyKeys.has(key) && text && Number.isFinite(Number(text)) ? String(Number(text)) : text;
}
export const selectionFilterText = (row: Row, key: string): string => row.selectionChoiceTexts?.[key] ?? selectionFilterValue(row, key);
export const selectionCellColor = (row: Row, key: string, type: "fill" | "text") => type === "text" ? row.cellTextColors?.[key] || "default" : row.cellColors?.[key] || row.rowColor || "NONE";
export function matchesSelectionFilters(row: Row, filters: SelectionFilters) {
  return Object.entries(filters).every(([key, filter]) => {
    const raw = selectionFilterValue(row, key), text = selectionFilterText(row, key).toLocaleLowerCase(), query = filter.value.trim().toLocaleLowerCase();
    if (filter.values) { let selected = optionSets.get(filter); if (!selected) { selected = new Set(filter.values); optionSets.set(filter, selected); } if (!selected.has(raw)) return false; }
    if (filter.colors && !filter.colors.includes(selectionCellColor(row, key, filter.colorType || "fill"))) return false;
    if (filter.mode === "empty") return !text;
    if (filter.mode === "filled") return !!text;
    if (!query) return true;
    const compare = (a: string, b: string) => a && b && Number.isFinite(Number(a)) && Number.isFinite(Number(b)) ? Number(a) - Number(b) : a.localeCompare(b, "zh-CN", { numeric: true });
    if (filter.mode === "equals" || filter.mode === "notEquals") {
      const equal = moneyKeys.has(key) && text && Number.isFinite(Number(text)) && Number.isFinite(Number(query)) ? Number(text) === Number(query) : text === query;
      return filter.mode === "equals" ? !!equal : !equal;
    }
    if (filter.mode === "notContains") return !text.includes(query);
    if (filter.mode === "starts") return text.startsWith(query);
    if (filter.mode === "ends") return text.endsWith(query);
    if (["gt", "gte", "lt", "lte", "between"].includes(filter.mode)) {
      if (!text) return false;
      const result = compare(text, query);
      if (filter.mode === "gt") return result > 0;
      if (filter.mode === "gte") return result >= 0;
      if (filter.mode === "lt") return result < 0;
      if (filter.mode === "lte") return result <= 0;
      return result >= 0 && !!filter.end?.trim() && compare(text, filter.end.trim().toLocaleLowerCase()) <= 0;
    }
    return text.includes(query);
  });
}
export function sortSelectionRows(rows: Row[], sort: SelectionView["sort"], columns?: readonly { key: string; type?: string }[]): Row[] {
  if (!sort) return rows;
  const numericColumn = moneyKeys.has(sort.key) || columns?.find(column => column.key === sort.key)?.type === "number";
  return [...rows].sort((a, b) => {
    const left = selectionFilterText(a, sort.key), right = selectionFilterText(b, sort.key);
    if (!left || !right) return left === right ? 0 : left ? -1 : 1;
    const numeric = numericColumn && Number.isFinite(Number(left)) && Number.isFinite(Number(right));
    const result = numeric ? Number(left) - Number(right) : left.localeCompare(right, "zh-CN", { numeric: true });
    return sort.direction === "asc" ? result : -result;
  });
}
export function selectionFilterOptions(rows: Row[], key: string) {
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  rows.forEach(row => { const value = selectionFilterValue(row, key); counts.set(value, (counts.get(value) || 0) + 1); labels.set(value, selectionFilterText(row, key)); });
  return [...counts].map(([value, count]) => ({ value, count, ...(labels.get(value) !== value ? { label: labels.get(value)! } : {}) }));
}
export function searchSelectionFilterOptions<T extends { value: string; label?: string }>(options: T[], query: string): T[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return options.filter(option => !words.length || words.some(word => ((option.label ?? option.value) || "(空白)").toLocaleLowerCase().includes(word)));
}
/** Commit the searched option scope without changing the panel's checkbox draft. */
export function applySelectionOptionSearch(draft: SelectionFilter, options: { value: string }[], query: string): SelectionFilter {
  if (!query.trim()) return draft;
  const selected = draft.values === undefined ? null : new Set(draft.values);
  const values = searchSelectionFilterOptions(options, query).filter(option => !selected || selected.has(option.value)).map(option => option.value);
  return { ...draft, values };
}
export function selectionAllCells(rows: Row[], columns: { key: string }[]) {
  return new Set(rows.flatMap(row => columns.map(column => `${row._key}::${column.key}`)));
}

/** Clear values only; formatting and row identity are retained. */
export function clearSelectionCells(rows: Row[], selected: Set<string>): Row[] {
  return rows.map(row => {
    const keys = [...selected].filter(id => id.startsWith(`${row._key}::`)).map(id => id.slice(`${row._key}::`.length)).filter(key=>!row.cellAccess || (row.cellAccess[key] || row.defaultCellAccess)==="edit");
    if (!keys.length) return row;
    const next = { ...row };
    for (const key of keys) {
      if(key==="color" && row.cellAccess?.images && row.cellAccess.images!=="edit")continue;
      if (["sellingPoints","reorderDays","collectionInventory"].includes(key)) continue;
      if (key.startsWith("custom:")) next.extraFields = { ...(next.extraFields || {}), [key]: "" };
      else next[key] = key === "images" || key === "labelImages" ? [] : null;
    }
    // Removing color labels must not leave orphan image-color references.
    if (keys.includes("color") && !keys.includes("images") && (!row.cellAccess || row.cellAccess.images==="edit")) next.images = (row.images || []).map((image: Row) => ({ ...image, color: "" }));
    return next;
  });
}

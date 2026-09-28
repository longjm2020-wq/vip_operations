type Row = Record<string, any>;
export type SelectionFilters = Record<string, { mode: "contains" | "equals" | "empty" | "filled"; value: string }>;
const moneyKeys = new Set(["supplyPriceExclTax", "vipPrice", "livePrice", "tagPrice"]);
export function matchesSelectionFilters(row: Row, filters: SelectionFilters) {
  return Object.entries(filters).every(([key, filter]) => {
    const value = key === "images" ? (row.images || []).map((image: Row) => `${image.color || ""} ${image.url || ""}`).join("\n") : key.startsWith("custom:") ? row.extraFields?.[key] : row[key];
    const text = String(value ?? "").trim().toLocaleLowerCase();
    const query = filter.value.trim().toLocaleLowerCase();
    if (filter.mode === "empty") return !text;
    if (filter.mode === "filled") return !!text;
    if (!query) return true;
    if (filter.mode === "equals") {
      if (moneyKeys.has(key) && text && Number.isFinite(Number(text)) && Number.isFinite(Number(query))) return Number(text) === Number(query);
      return text === query;
    }
    return text.includes(query);
  });
}
export function selectionAllCells(rows: Row[], columns: { key: string }[]) {
  return new Set(rows.flatMap(row => columns.map(column => `${row._key}::${column.key}`)));
}

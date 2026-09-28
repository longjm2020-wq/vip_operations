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

/** Clear values only; formatting and row identity are retained. */
export function clearSelectionCells(rows: Row[], selected: Set<string>): Row[] {
  return rows.map(row => {
    const keys = [...selected].filter(id => id.startsWith(`${row._key}::`)).map(id => id.slice(`${row._key}::`.length));
    if (!keys.length) return row;
    const next = { ...row };
    for (const key of keys) {
      if (key.startsWith("custom:")) next.extraFields = { ...(next.extraFields || {}), [key]: "" };
      else next[key] = key === "images" ? [] : null;
    }
    // Removing color labels must not leave orphan image-color references.
    if (keys.includes("color") && !keys.includes("images")) next.images = (row.images || []).map((image: Row) => ({ ...image, color: "" }));
    return next;
  });
}

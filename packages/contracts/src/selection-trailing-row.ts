import { selectionFields } from "./selection-protection.js";

type SelectionRow = Record<string, unknown>;

function filled(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return String(value).trim().length > 0;
}

/** Saved values count as content; row metadata and presentation never do. */
export function selectionRowHasContent(row: SelectionRow): boolean {
  if (selectionFields.some((key) => filled(row[key]))) return true;
  const extra = row.extraFields;
  return !!extra && typeof extra === "object" && Object.values(extra).some((value) => {
    // Clearing a custom image field stores an empty JSON array.
    return filled(value) && !(typeof value === "string" && /^\[\s*\]$/.test(value.trim()));
  });
}

/** Manual order is sortOrder ASC, id DESC, regardless of the current view. */
export function selectionLastRow<T extends SelectionRow>(rows: readonly T[]): T | undefined {
  let last: T | undefined;
  for (const row of rows) {
    const order = Number(row.sortOrder ?? 0), lastOrder = Number(last?.sortOrder ?? 0);
    if (!last || order > lastOrder || (order === lastOrder && (
      !row.id || (last.id && BigInt(String(row.id)) < BigInt(String(last.id)))
    ))) last = row;
  }
  return last;
}

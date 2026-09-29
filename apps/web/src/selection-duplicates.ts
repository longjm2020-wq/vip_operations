type StyleRow = { _key?: string; id?: unknown; xutiStyleNo?: unknown };
type StyleCount = { xutiStyleNo: string; count: number };

export const selectionStyleKey = (value: unknown) => typeof value === "string" ? value.trim() : "";

/** Combine saved counts with edits that have not reached the server yet. */
export function duplicateStyleCounts(rows: StyleRow[], savedCounts?: StyleCount[], original?: ReadonlyMap<string, StyleRow>) {
  const counts = new Map<string, number>();
  const change = (key: string, amount: number) => { if (key) counts.set(key, (counts.get(key) || 0) + amount); };
  if (savedCounts) {
    for (const item of savedCounts) change(selectionStyleKey(item.xutiStyleNo), item.count);
    for (const row of rows) {
      const before = row.id ? original?.get(row._key || "") : undefined;
      const oldKey = selectionStyleKey(before?.xutiStyleNo);
      const newKey = selectionStyleKey(row.xutiStyleNo);
      if (!row.id) change(newKey, 1);
      else if (before && oldKey !== newKey) { change(oldKey, -1); change(newKey, 1); }
    }
  } else for (const row of rows) change(selectionStyleKey(row.xutiStyleNo), 1);
  return new Map([...counts].filter(([, count]) => count > 1));
}

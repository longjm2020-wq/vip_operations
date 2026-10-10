type ResultRow = {
  _key?: string;
  cellAccess?: unknown;
  hiddenCells?: unknown;
  defaultCellAccess?: unknown;
  migrationLocked?: unknown;
  policyRevision?: unknown;
};

export type RetainedSelectionResults = {
  scope: string;
  entries: { key: string; access: string; groupLabel: string }[];
};

const accessSignature = (row: ResultRow) => JSON.stringify([
  row.cellAccess, row.hiddenCells, row.defaultCellAccess, row.migrationLocked, row.policyRevision,
]);

/** Keep result identities, never stale values or permissions, until a filter is reapplied. */
export function retainSelectionResults<T extends ResultRow>(
  previous: RetainedSelectionResults | null,
  scope: string | null,
  rows: readonly T[],
  matching: readonly T[],
  groupLabel: (row: T) => string,
  canRetain: (row: T) => boolean,
): RetainedSelectionResults | null {
  if (scope === null) return null;
  const current = new Map(rows.flatMap(row => typeof row._key === "string" ? [[row._key, row] as const] : []));
  const entries = previous?.scope === scope ? previous.entries.flatMap(entry => {
    const row = current.get(entry.key);
    // Never keep a deleted or no-longer-readable result, or an old private group label.
    if (!row || !canRetain(row)) return [];
    const access = accessSignature(row);
    return [entry.access === access ? entry : { key: entry.key, access, groupLabel: groupLabel(row) }];
  }) : [];
  const retained = new Set(entries.map(entry => entry.key));
  for (const row of matching) if (typeof row._key === "string" && canRetain(row) && !retained.has(row._key)) {
    entries.push({ key: row._key, access: accessSignature(row), groupLabel: groupLabel(row) });
    retained.add(row._key);
  }
  if (previous?.scope === scope && entries.length === previous.entries.length &&
    entries.every((entry, index) => entry === previous.entries[index])) return previous;
  return { scope, entries };
}

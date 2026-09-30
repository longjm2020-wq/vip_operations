import { sortSelectionSizes } from "../../../packages/contracts/src/selection-sizes.js";
type Row = Record<string, any>;

/** Each logical write gets its own key; uncertain retries reuse the exact request. */
export class SelectionSaveAttempts {
  private pending = new Map<string, { key: string; body: Row; sent: Row }>();
  private blocked = new Map<string, { sent: Row; uncertain: boolean }>();

  eligible(row: Row) {
    const failure = this.blocked.get(row._key);
    return !failure || (!failure.uncertain && JSON.stringify(row) !== JSON.stringify(failure.sent));
  }

  start(row: Row, body: Row) {
    let attempt = this.pending.get(row._key);
    if (!attempt) {
      attempt = { key: crypto.randomUUID(), body, sent: row };
      this.pending.set(row._key, attempt);
    }
    return attempt;
  }

  fail(rowKey: string, current: Row, status?: number) {
    const uncertain = !status || status >= 500;
    if (!uncertain) this.pending.delete(rowKey);
    this.blocked.set(rowKey, { sent: current, uncertain: uncertain || status === 409 });
  }

  succeed(rowKey: string) {
    this.pending.delete(rowKey);
    this.blocked.delete(rowKey);
  }

  retry() { this.blocked.clear(); }
}

export function normalizeSelection(row: Row): Row {
  return { ...row, sizeRange: sortSelectionSizes(row.sizeRange) || null, registrationBatch: row.registrationBatch ? String(row.registrationBatch).slice(0, 10) : null,
    images: row.images || [], labelImages: row.labelImages || [], cellColors: row.cellColors || {}, cellAlignments: row.cellAlignments || {}, cellVerticalAlignments: row.cellVerticalAlignments || {}, cellTextColors: row.cellTextColors || {}, cellNumberFormats: row.cellNumberFormats || {}, extraFields: row.extraFields || {} };
}

/** Accept server metadata while retaining fields edited during the request. */
export function mergeSelectionSave(current: Row, sent: Row, saved: Row): Row {
  const next: Row = { ...saved, _key: current._key };
  for (const key of Object.keys(current)) {
    if (["id", "updatedAt", "createdAt", "version", "_key", "cellAccess", "hiddenCells", "defaultCellAccess", "policyRevision", "claimedBy"].includes(key)) continue;
    if(saved.cellAccess?.[key] && saved.cellAccess[key]!=="edit")continue;
    if(["extraFields","cellColors","cellAlignments","cellVerticalAlignments","cellTextColors","cellNumberFormats"].includes(key)) {
      const values={...(saved[key] || {})};
      for(const field of Object.keys(current[key] || {}))if((!saved.cellAccess || (saved.cellAccess[field] || saved.defaultCellAccess)==="edit") && JSON.stringify(current[key]?.[field])!==JSON.stringify(sent[key]?.[field]))values[field]=current[key][field];
      next[key]=values;continue;
    }
    if (JSON.stringify(current[key]) !== JSON.stringify(sent[key])) next[key] = current[key];
  }
  return next;
}

/** JSON maps are patches: missing fields are preserved; null removes formatting. */
export function selectionDelta(body: Row, before: Row): Row {
  const delta: Row = {};
  for(const [key,value] of Object.entries(body)) {
    if(key==="expectedUpdatedAt"){delta[key]=value;continue;}
    if(["extraFields","cellColors","cellAlignments","cellVerticalAlignments","cellTextColors","cellNumberFormats"].includes(key)) {
      const changes:Row={};
      for(const field of new Set([...Object.keys(value || {}),...Object.keys(before[key] || {})]))if(JSON.stringify(value?.[field])!==JSON.stringify(before[key]?.[field]))changes[field]=value?.[field] ?? null;
      if(Object.keys(changes).length)delta[key]=changes;
    } else if(JSON.stringify(value)!==JSON.stringify(before[key] ?? (["images","labelImages"].includes(key)?[]:key==="rowColor"?"NONE":null)))delta[key]=value;
  }
  return delta;
}

import { sortSelectionSizes } from "../../../packages/contracts/src/selection-sizes.js";
import { hasSelectionCreationTimeDraft, selectionCreationTimeComparable, selectionCreationTimePending } from "./selection-creation-time.js";
import { parseSelectionCreatedTime } from "../../../packages/contracts/src/selection-created-time.js";
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
  return { ...row, creationTimePending: selectionCreationTimePending(row), sizeRange: sortSelectionSizes(row.sizeRange) || null, registrationBatch: row.registrationBatch ? String(row.registrationBatch).slice(0, 10) : null,
    images: row.images || [], labelImages: row.labelImages || [], cellColors: row.cellColors || {}, cellAlignments: row.cellAlignments || {}, cellVerticalAlignments: row.cellVerticalAlignments || {}, cellTextColors: row.cellTextColors || {}, cellNumberFormats: row.cellNumberFormats || {}, extraFields: row.extraFields || {} };
}

/** Accept server metadata while retaining fields edited during the request. */
export function mergeSelectionSave(current: Row, sent: Row, saved: Row): Row {
  const next: Row = { ...saved, _key: current._key };
  if (saved.rowNumber === undefined && current.rowNumber !== undefined) next.rowNumber = current.rowNumber;
  delete next.creationTimeDraft;
  // The timestamp and its raw input share the legacy column's permission key.
  // A response must not replace text typed after this request was sent.
  if (retainCreationTimeDraft(current, saved) && !saved.migrationLocked && (!saved.cellAccess || (saved.cellAccess.registrationBatch || saved.defaultCellAccess) === "edit") &&
      (current.creationTimeDraft !== sent.creationTimeDraft || selectionCreationTimeComparable(current) !== selectionCreationTimeComparable(sent))) {
    next.createdAt = retainedCreationTimestamp(current, saved);
    if (hasSelectionCreationTimeDraft(current)) next.creationTimeDraft = current.creationTimeDraft;
  }
  for (const key of Object.keys(current)) {
    if (["id", "rowNumber", "updatedAt", "createdAt", "creationTimeDraft", "creationTimePending", "version", "_key", "cellAccess", "hiddenCells", "defaultCellAccess", "policyRevision", "claimedBy", "migrationLocked", "migrationTargetWorkspace", "migrationTargetRowId", "migratedAt", "productId"].includes(key)) continue;
    if(saved.cellAccess?.[key] && saved.cellAccess[key]!=="edit")continue;
    if(["extraFields","cellColors","cellAlignments","cellVerticalAlignments","cellTextColors","cellNumberFormats"].includes(key)) {
      const values={...(saved[key] || {})};
      // Removing a format while the preceding save is pending is another edit.
      // Keep that deletion so the next delta can publish an explicit null patch.
      for(const field of new Set([...Object.keys(current[key] || {}),...Object.keys(sent[key] || {})]))if((!saved.cellAccess || (saved.cellAccess[field] || saved.defaultCellAccess)==="edit") && JSON.stringify(current[key]?.[field])!==JSON.stringify(sent[key]?.[field])) {
        if(current[key]?.[field]===undefined)delete values[field];
        else values[field]=current[key][field];
      }
      next[key]=values;continue;
    }
    if (JSON.stringify(current[key]) !== JSON.stringify(sent[key])) next[key] = current[key];
  }
  return next;
}

/** Merge disjoint remote edits and retain colliding drafts for manual resolution. */
const retainCreationTimeDraft = (current: Row, incoming: Row) => selectionCreationTimePending(incoming) || !selectionCreationTimePending(current) || (hasSelectionCreationTimeDraft(current) && !!current.creationTimeDraft.trim());
const retainedCreationTimestamp = (current: Row, incoming: Row) => !selectionCreationTimePending(incoming) && selectionCreationTimePending(current)
  ? parseSelectionCreatedTime(current.creationTimeDraft) || incoming.createdAt : current.createdAt;

export function mergeSelectionRemote(current: Row, before: Row, incoming: Row) {
  const next: Row = { ...incoming, _key: current._key };
  if (incoming.rowNumber === undefined && current.rowNumber !== undefined) next.rowNumber = current.rowNumber;
  const conflicts: string[] = [];
  const metadata = new Set(["id","rowNumber","updatedAt","createdAt","creationTimeDraft","creationTimePending","version","_key","createdBy","updatedBy","createdByName","createdByUsername","updatedByName","updatedByUsername","cellAccess","hiddenCells","defaultCellAccess","policyRevision","claimedBy","claimedAt","cellOwners","migrationLocked","migrationTargetWorkspace","migrationTargetRowId","migratedAt","productId","collectionInventory","reorderDays","sellingPoints"]);
  const maps = new Set(["extraFields","cellColors","cellAlignments","cellVerticalAlignments","cellTextColors","cellNumberFormats"]);
  const equal = (a: unknown, b: unknown) => JSON.stringify(a === "" ? null : a ?? null) === JSON.stringify(b === "" ? null : b ?? null);
  const editable = (key: string) => !incoming.migrationLocked && (!incoming.cellAccess || (incoming.cellAccess[key] || incoming.defaultCellAccess) === "edit");
  const merge = (key: string, local: unknown, base: unknown, remote: unknown) => {
    if (!editable(key) || equal(local, base)) return remote;
    if (!equal(remote, base) && !equal(remote, local)) conflicts.push(key);
    return local;
  };
  delete next.creationTimeDraft;
  const localTime = selectionCreationTimeComparable(current), baseTime = selectionCreationTimeComparable(before), remoteTime = selectionCreationTimeComparable(incoming);
  if (retainCreationTimeDraft(current, incoming) && editable("registrationBatch") && localTime !== baseTime) {
    if (remoteTime !== baseTime && remoteTime !== localTime) conflicts.push("registrationBatch");
    next.createdAt = retainedCreationTimestamp(current, incoming);
    if (hasSelectionCreationTimeDraft(current)) next.creationTimeDraft = current.creationTimeDraft;
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(current)])) {
    if (metadata.has(key)) continue;
    if (maps.has(key)) {
      const value = { ...(incoming[key] || {}) };
      for (const field of new Set([...Object.keys(before[key] || {}), ...Object.keys(current[key] || {})])) {
        const merged = merge(field, current[key]?.[field], before[key]?.[field], incoming[key]?.[field]);
        if (merged === undefined) delete value[field]; else value[field] = merged;
      }
      next[key] = value;
    } else next[key] = merge(key, current[key], before[key], incoming[key]);
  }
  // A retry of a colliding draft must still fail the version check until the
  // user reloads and resolves it; never silently overwrite the remote edit.
  if (conflicts.length) { next.updatedAt = before.updatedAt; next.version = before.version; }
  return { row: next, conflicts: [...new Set(conflicts)] };
}

/** JSON maps are patches: missing fields are preserved; null removes formatting. */
export function selectionDelta(body: Row, before: Row): Row {
  const delta: Row = {};
  for(const [key,value] of Object.entries(body)) {
    if (key === "rowNumber" || key === "creationTimePending" || (key === "createdAt" && value == null)) continue;
    if(key==="expectedUpdatedAt"){delta[key]=value;continue;}
    if(["extraFields","cellColors","cellAlignments","cellVerticalAlignments","cellTextColors","cellNumberFormats"].includes(key)) {
      const changes:Row={};
      for(const field of new Set([...Object.keys(value || {}),...Object.keys(before[key] || {})]))if(JSON.stringify(value?.[field])!==JSON.stringify(before[key]?.[field]))changes[field]=value?.[field] ?? null;
      if(Object.keys(changes).length)delta[key]=changes;
    } else if(JSON.stringify(value)!==JSON.stringify(before[key] ?? (["images","labelImages"].includes(key)?[]:key==="rowColor"?"NONE":null)))delta[key]=value;
  }
  return delta;
}

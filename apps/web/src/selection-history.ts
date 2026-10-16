import { selectionCreationTimeComparable, selectionCreationTimeValue } from "./selection-creation-time.js";

type Row = Record<string, any>;
type Slot = { present: boolean; value?: unknown };
const formatContainers = ["cellColors", "cellAlignments", "cellVerticalAlignments", "cellTextColors", "cellNumberFormats"] as const;
type FormatContainer = typeof formatContainers[number];
type Container = "extraFields" | FormatContainer;
export type SelectionHistoryKind = "value" | "format" | "creationTime";
export type SelectionHistoryCellChange = {
  rowKey: string;
  field: string;
  kind: SelectionHistoryKind;
  container?: Container;
  before: Slot;
  after: Slot;
};
export type SelectionHistoryChange = { cells: SelectionHistoryCellChange[] };
export type SelectionHistoryApplyResult<T extends Row> =
  | { ok: true; rows: T[]; change: SelectionHistoryChange }
  | { ok: false; reason: "empty" | "conflict" | "permission"; rowKey?: string; field?: string };
export type SelectionHistoryPermission = (row: Row, field: string, kind: SelectionHistoryKind) => boolean;
export type SelectionHistoryValueEqual = (field: string, left: unknown, right: unknown) => boolean;

const metadata = new Set([
  "_key", "id", "updatedAt", "version", "createdBy", "updatedBy", "createdByName", "createdByUsername", "updatedByName", "updatedByUsername",
  "cellAccess", "hiddenCells", "defaultCellAccess", "policyRevision", "claimedBy", "claimedAt", "cellOwners", "migrationLocked",
  "migrationTargetWorkspace", "migrationTargetRowId", "migratedAt", "productId", "collectionInventory", "reorderDays", "sellingPoints",
  "extraFields", ...formatContainers,
]);
const clone = <T>(value: T): T => structuredClone(value);
const slot = (row: Row | undefined, key: string): Slot => row && Object.prototype.hasOwnProperty.call(row, key)
  ? { present: true, value: row[key] } : { present: false };
const blank = (value: unknown) => value === "" || value === undefined || value === null;
const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equal(value, right[index]));
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every(key => Object.prototype.hasOwnProperty.call(right, key) && equal((left as Row)[key], (right as Row)[key]));
};
const creationSlot = (row: Row): Slot => ({ present: true, value: { createdAt: slot(row, "createdAt"), creationTimeDraft: slot(row, "creationTimeDraft") } });
const creationRow = (value: Slot): Row => Object.fromEntries(Object.entries(value.value as Record<string, Slot>).filter(([, entry]) => entry.present).map(([key, entry]) => [key, entry.value]));
const sameSlot = (a: Slot, b: Slot, kind: SelectionHistoryKind) => kind === "creationTime"
  ? selectionCreationTimeComparable(creationRow(a)) === selectionCreationTimeComparable(creationRow(b))
  : (kind === "value" && blank(a.value) && blank(b.value)) || (a.present === b.present && equal(a.value, b.value));
const read = (row: Row, change: SelectionHistoryCellChange): Slot => change.kind === "creationTime" ? creationSlot(row) : slot(change.container ? row[change.container] : row, change.field);
const identity = (change: SelectionHistoryCellChange) => JSON.stringify([change.rowKey, change.kind, change.container, change.field]);

/** Store only editable cell differences; never retain row snapshots or server metadata. */
export function createSelectionHistoryChange(beforeRows: readonly Row[], afterRows: readonly Row[], fields: readonly string[]): SelectionHistoryChange | null {
  const previous = new Map(beforeRows.map(row => [String(row._key), row]));
  const allowed = [...new Set(fields)].filter(field => !metadata.has(field));
  const cells: SelectionHistoryCellChange[] = [];
  const add = (change: SelectionHistoryCellChange) => { if (!sameSlot(change.before, change.after, change.kind)) cells.push(clone(change)); };
  for (const after of afterRows) {
    if (after._key === undefined) continue;
    const rowKey = String(after._key), before = previous.get(rowKey);
    if (!before || before === after) continue;
    if (allowed.some(field => ["registrationBatch", "createdAt", "creationTimeDraft"].includes(field))) {
      add({ rowKey, field: "registrationBatch", kind: "creationTime", before: creationSlot(before), after: creationSlot(after) });
    }
    for (const field of allowed) {
      if (!["registrationBatch", "createdAt", "creationTimeDraft"].includes(field)) {
        const container = field.startsWith("custom:") ? "extraFields" : undefined;
        add({ rowKey, field, kind: "value", container, before: slot(container ? before[container] : before, field), after: slot(container ? after[container] : after, field) });
      }
      for (const container of formatContainers) {
        add({ rowKey, field, kind: "format", container, before: slot(before[container], field), after: slot(after[container], field) });
      }
    }
  }
  return cells.length ? { cells } : null;
}

/** Preflight all touched cells before applying a change, preserving unrelated current values. */
export function applySelectionHistoryChange<T extends Row>(rows: readonly T[], change: SelectionHistoryChange, direction: "undo" | "redo", canApply?: SelectionHistoryPermission, valueEqual?: SelectionHistoryValueEqual): SelectionHistoryApplyResult<T> {
  if (!change.cells.length) return { ok: false, reason: "empty" };
  const current = new Map(rows.map(row => [String(row._key), row]));
  for (const cell of change.cells) {
    const row = current.get(cell.rowKey);
    if (!row) return { ok: false, reason: "conflict", rowKey: cell.rowKey, field: cell.field };
    if (canApply && !canApply(row, cell.field, cell.kind)) return { ok: false, reason: "permission", rowKey: cell.rowKey, field: cell.field };
    const actual = read(row, cell), expected = direction === "undo" ? cell.after : cell.before;
    const matches = sameSlot(actual, expected, cell.kind) || (cell.kind === "value" && valueEqual?.(cell.field, actual.value, expected.value));
    if (!matches) return { ok: false, reason: "conflict", rowKey: cell.rowKey, field: cell.field };
  }
  const edited = new Map<string, Row>();
  const write = (row: Row, key: string, value: Slot) => { if (value.present) row[key] = clone(value.value); else delete row[key]; };
  for (const cell of change.cells) {
    let row = edited.get(cell.rowKey);
    if (!row) { row = { ...current.get(cell.rowKey)! }; edited.set(cell.rowKey, row); }
    const value = direction === "undo" ? cell.before : cell.after;
    if (cell.kind === "creationTime") {
      for (const [key, entry] of Object.entries(value.value as Record<string, Slot>)) write(row, key, entry);
      // The save layer submits a changed timestamp only when this editable draft exists.
      if (typeof row.creationTimeDraft !== "string") row.creationTimeDraft = selectionCreationTimeValue(row);
    } else if (cell.container) {
      row[cell.container] = { ...(row[cell.container] || {}) };
      write(row[cell.container], cell.field, value);
    } else write(row, cell.field, value);
  }
  return { ok: true, rows: rows.map(row => (edited.get(String(row._key)) || row) as T), change: clone(change) };
}

/** An undefined merge means the second operation did not continue from the first. */
export function mergeSelectionHistoryChanges(earlier: SelectionHistoryChange, later: SelectionHistoryChange): SelectionHistoryChange | undefined {
  const cells = new Map(earlier.cells.map(cell => [identity(cell), cell]));
  if (!later.cells.every(cell => !cells.has(identity(cell)) || sameSlot(cells.get(identity(cell))!.after, cell.before, cell.kind))) return;
  for (const cell of later.cells) {
    const previous = cells.get(identity(cell));
    cells.set(identity(cell), previous ? { ...cell, before: previous.before } : cell);
  }
  return clone({ cells: [...cells.values()].filter(cell => !sameSlot(cell.before, cell.after, cell.kind)) });
}

type Entry = { change: SelectionHistoryChange; groupKey?: string; timestamp: number };

/** A session-local, at-most-ten-step history. Failed preflight never consumes a step. */
export class SelectionHistory {
  private past: Entry[] = [];
  private future: Entry[] = [];
  private readonly limit: number;

  constructor(limit = 10, private readonly groupWindowMs = 750) {
    this.limit = Math.max(1, Math.min(10, Math.floor(limit) || 10));
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  get undoCount() { return this.past.length; }
  get redoCount() { return this.future.length; }
  clear() { this.past = []; this.future = []; }

  record(change: SelectionHistoryChange | null, groupKey?: string, timestamp = Date.now()) {
    if (!change?.cells.length) return;
    const entry = { change: clone(change), groupKey, timestamp };
    const last = this.past.at(-1);
    const merge = !!groupKey && last?.groupKey === groupKey && !this.future.length && timestamp >= last.timestamp && timestamp - last.timestamp <= this.groupWindowMs;
    this.future = [];
    if (merge && last) {
      // A changed expected value means this is a new edit, even if a caller reused its group key.
      const combined = mergeSelectionHistoryChanges(last.change, entry.change);
      if (combined) {
        if (combined.cells.length) this.past[this.past.length - 1] = { ...entry, change: combined };
        else this.past.pop();
        return;
      }
    }
    this.past.push(entry);
    if (this.past.length > this.limit) this.past.shift();
  }

  undo<T extends Row>(rows: readonly T[], canApply?: SelectionHistoryPermission): SelectionHistoryApplyResult<T> {
    return this.apply(rows, "undo", canApply);
  }

  redo<T extends Row>(rows: readonly T[], canApply?: SelectionHistoryPermission): SelectionHistoryApplyResult<T> {
    return this.apply(rows, "redo", canApply);
  }

  private apply<T extends Row>(rows: readonly T[], direction: "undo" | "redo", canApply?: SelectionHistoryPermission): SelectionHistoryApplyResult<T> {
    const source = direction === "undo" ? this.past : this.future, target = direction === "undo" ? this.future : this.past;
    const entry = source.at(-1);
    if (!entry) return { ok: false, reason: "empty" };
    const result = applySelectionHistoryChange(rows, entry.change, direction, canApply);
    if (!result.ok) return result;
    source.pop();
    // Undo/redo is a group boundary: new typing must not merge into an older operation.
    target.push({ ...entry, groupKey: undefined });
    return result;
  }
}

export type SelectionHistoryDirection = "undo" | "redo";
type OperationEntry<T> = { value: T; groupKey?: string; timestamp: number };

/** One shared sequence for cell, row and layout operations; callers commit only after success. */
export class SelectionOperationHistory<T> {
  private past: OperationEntry<T>[] = [];
  private future: OperationEntry<T>[] = [];
  private readonly limit: number;

  constructor(limit = 10, private readonly groupWindowMs = 750) {
    this.limit = Math.max(1, Math.min(10, Math.floor(limit) || 10));
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  get undoCount() { return this.past.length; }
  get redoCount() { return this.future.length; }
  clear() { this.past = []; this.future = []; }

  peek(direction: SelectionHistoryDirection): T | undefined {
    return (direction === "undo" ? this.past : this.future).at(-1)?.value;
  }

  record(value: T, groupKey?: string, merge?: (earlier: T, later: T) => T | undefined, timestamp = Date.now()) {
    const last = this.past.at(-1);
    const canMerge = merge && !!groupKey && last?.groupKey === groupKey && !this.future.length && timestamp >= last.timestamp && timestamp - last.timestamp <= this.groupWindowMs;
    const combined = canMerge && last ? merge(last.value, value) : undefined;
    this.future = [];
    if (combined !== undefined) this.past[this.past.length - 1] = { value: combined, groupKey, timestamp };
    else {
      this.past.push({ value, groupKey, timestamp });
      if (this.past.length > this.limit) this.past.shift();
    }
  }

  commit(direction: SelectionHistoryDirection, replacement?: T): T | undefined {
    const source = direction === "undo" ? this.past : this.future, target = direction === "undo" ? this.future : this.past;
    const entry = source.pop();
    if (!entry) return;
    const value = replacement === undefined ? entry.value : replacement;
    // A successful transition closes typing groups even when it is immediately reversed.
    target.push({ value, timestamp: entry.timestamp });
    if (target.length > this.limit) target.shift();
    return value;
  }
}

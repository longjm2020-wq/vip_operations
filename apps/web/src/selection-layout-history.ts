import { selectionLayoutSchema, type SelectionField, type SelectionLayout } from "../../../packages/contracts/src/selection-layout.js";
import { restrictSelectionReadonlyLayout } from "./selection-layout-storage.js";

type ObjectValue = Record<string, any>;
type Slot = { present: boolean; value?: unknown };
type Entity = "field" | "group" | "preset";
type SequencePath = "columns" | "hiddenColumns" | "fixedColumns" | "columnGroups" | "organization.groups" | "organization.sorts" | "typeCatalog.disabled" | "typeCatalog.custom" | `group:${string}`;
type Patch = { entity: Entity | "rowHeight"; key: string; property?: string; before: Slot; after: Slot };
type SequenceChange = { path: SequencePath; before: string[]; after: string[] };
export type SelectionLayoutHistoryChange = { patches: Patch[]; sequences: SequenceChange[] };
export type SelectionLayoutHistoryContext = { userId: string; isSuperAdmin?: boolean; canEditShared: boolean; hasSharedLayout?: boolean };
export type SelectionLayoutHistoryResult = { ok: true; preferences: SelectionLayout } | { ok: false; reason: "conflict" | "permission" | "validation"; message: string };
export type SelectionLayoutHistoryEvent = { type: "change"; change: SelectionLayoutHistoryChange; key: keyof SelectionLayout; groupKey?: string } | { type: "reset"; reason: string };
export type SelectionLayoutHistoryApplyResult = { ok: true; saved: boolean } | { ok: false; reason: "conflict" | "permission" | "validation" | "unavailable"; message: string };

const security = new Set(["key", "ownerId", "visibility", "fieldRevision"]);
const clone = <T>(value: T): T => structuredClone(value);
const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equal(value, right[index]));
  const a = Object.keys(left).filter(key => (left as ObjectValue)[key] !== undefined), b = Object.keys(right).filter(key => (right as ObjectValue)[key] !== undefined);
  return a.length === b.length && a.every(key => Object.prototype.hasOwnProperty.call(right, key) && equal((left as ObjectValue)[key], (right as ObjectValue)[key]));
};
const slot = (value: ObjectValue | undefined, key: string): Slot => value?.[key] !== undefined ? { present: true, value: value[key] } : { present: false };
const same = (a: Slot, b: Slot) => a.present === b.present && equal(a.value, b.value);
const definition = (field: SelectionField): ObjectValue => ({ ...Object.fromEntries(Object.entries(field).filter(([key]) => !security.has(key))), deleted: !!field.deleted });
const entityList = (layout: SelectionLayout, entity: Entity): ObjectValue[] => entity === "field" ? layout.columns : entity === "group" ? layout.columnGroups : layout.typeCatalog.custom;
const entityKey = (entity: Entity, value: ObjectValue) => String(value[entity === "group" ? "id" : "key"]);
const findEntity = (layout: SelectionLayout, entity: Entity, key: string) => entityList(layout, entity).find(value => entityKey(entity, value) === key);
const entitySlot = (value: ObjectValue | undefined, entity: Entity): Slot => value ? { present: true, value: entity === "field" ? definition(value as SelectionField) : value } : { present: false };
const patchIdentity = (patch: Patch) => JSON.stringify([patch.entity, patch.key, patch.property]);
const sequenceValue = (layout: SelectionLayout, path: SequencePath): string[] => {
  if (path === "columns") return layout.columns.filter(field => !field.deleted).map(field => field.key);
  if (path === "columnGroups") return layout.columnGroups.map(group => group.id);
  if (path === "typeCatalog.custom") return layout.typeCatalog.custom.map(preset => preset.key);
  if (path.startsWith("group:")) return layout.columnGroups.find(group => group.id === path.slice(6))?.columnKeys || [];
  if (path === "organization.groups") return layout.organization.groups;
  if (path === "organization.sorts") return layout.organization.sorts;
  if (path === "typeCatalog.disabled") return layout.typeCatalog.disabled;
  return layout[path as "hiddenColumns" | "fixedColumns"];
};

/** Capture only editable definitions and layout settings, excluding browsing and access scope. */
export function createSelectionLayoutHistoryChange(before: SelectionLayout, after: SelectionLayout): SelectionLayoutHistoryChange | null {
  const patches: Patch[] = [], sequences: SequenceChange[] = [];
  const sequence = (path: SequencePath, first = sequenceValue(before, path), last = sequenceValue(after, path)) => {
    if (path === "hiddenColumns" || path === "typeCatalog.disabled") { first = [...first].sort(); last = [...last].sort(); }
    if (!equal(first, last)) sequences.push({ path, before: first, after: last });
  };
  for (const entity of ["field", "group", "preset"] as const) {
    const previous = new Map(entityList(before, entity).map(value => [entityKey(entity, value), value]));
    const next = new Map(entityList(after, entity).map(value => [entityKey(entity, value), value]));
    for (const key of new Set([...previous.keys(), ...next.keys()])) {
      const a = previous.get(key), b = next.get(key);
      if (!a || !b) {
        patches.push({ entity, key, before: entitySlot(a, entity), after: entitySlot(b, entity) });
        continue;
      }
      const first = entity === "field" ? definition(a as SelectionField) : a, last = entity === "field" ? definition(b as SelectionField) : b;
      for (const property of new Set([...Object.keys(first), ...Object.keys(last)])) {
        if (property === "key" || property === "id") continue;
        if (entity === "group" && property === "columnKeys") { sequence(`group:${key}`, a.columnKeys, b.columnKeys); continue; }
        const oldValue = slot(first, property), newValue = slot(last, property);
        if (!same(oldValue, newValue)) patches.push({ entity, key, property, before: oldValue, after: newValue });
      }
    }
  }
  if (before.rowHeight !== after.rowHeight) patches.push({ entity: "rowHeight", key: "rowHeight", before: { present: true, value: before.rowHeight }, after: { present: true, value: after.rowHeight } });
  for (const path of ["columns", "hiddenColumns", "fixedColumns", "columnGroups", "organization.groups", "organization.sorts", "typeCatalog.disabled", "typeCatalog.custom"] as const) sequence(path);
  return patches.length || sequences.length ? clone({ patches, sequences }) : null;
}

/** Ignore revision acknowledgements, but invalidate history after ownership/access changes. */
export function selectionLayoutHistorySecurityChanged(before: SelectionLayout, after: SelectionLayout): boolean {
  if (before.columns === after.columns) return false;
  const next = new Map(after.columns.map(field => [field.key, field]));
  const visibility = (field: SelectionField) => field.visibility || (field.ownerId ? "PRIVATE" : "PUBLIC");
  return before.columns.some(field => {
    const current = next.get(field.key);
    return !current ? !!field.ownerId : field.ownerId !== current.ownerId || visibility(field) !== visibility(current);
  });
}

// The longest common subsequence identifies the keys actually moved by a gesture.
function stableSequence(before: string[], after: string[]): Set<string> {
  const width = after.length + 1, lengths = new Uint16Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) lengths[i * width + j] = before[i] === after[j] ? lengths[(i + 1) * width + j + 1] + 1 : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
  const stable = new Set<string>();
  for (let i = 0, j = 0; i < before.length && j < after.length;) {
    if (before[i] === after[j]) { stable.add(before[i]); i++; j++; }
    else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) i++;
    else j++;
  }
  return stable;
}
function sequenceMatches(current: string[], expected: string[], other: string[], unordered = false): boolean {
  const stable = stableSequence(expected, other), moved = new Set([...expected, ...other].filter(key => !stable.has(key)));
  for (const key of moved) if (current.includes(key) !== expected.includes(key)) return false;
  if (unordered) return true;
  if (!equal(current.filter(key => moved.has(key)), expected.filter(key => moved.has(key)))) return false;
  for (const key of expected.filter(key => moved.has(key))) {
    const index = expected.indexOf(key), actual = current.indexOf(key);
    const left = expected.slice(0, index).reverse().find(value => stable.has(value) && current.includes(value));
    const right = expected.slice(index + 1).find(value => stable.has(value) && current.includes(value));
    if ((left && current.indexOf(left) > actual) || (right && current.indexOf(right) < actual)) return false;
  }
  return true;
}
function applySequence(current: string[], expected: string[], target: string[]): string[] {
  const stable = stableSequence(expected, target), moved = new Set([...expected, ...target].filter(key => !stable.has(key)));
  const next = current.filter(key => !moved.has(key));
  for (const key of target.filter(value => moved.has(value))) {
    const index = target.indexOf(key), right = target.slice(index + 1).find(value => next.includes(value));
    const left = target.slice(0, index).reverse().find(value => next.includes(value));
    const position = left ? next.indexOf(left) + 1 : right ? next.indexOf(right) : next.length;
    next.splice(position, 0, key);
  }
  return next;
}
function setSequence(layout: SelectionLayout, path: SequencePath, value: string[]) {
  if (path === "columns") {
    const fields = new Map(layout.columns.map(field => [field.key, field]));
    const order = value.filter(key => fields.has(key)).map(key => fields.get(key)!);
    // Tombstones stay in the definition registry without becoming visible columns.
    layout.columns = [...order, ...layout.columns.filter(field => !value.includes(field.key))];
  } else if (path === "columnGroups") {
    const groups = new Map(layout.columnGroups.map(group => [group.id, group]));
    layout.columnGroups = value.filter(key => groups.has(key)).map(key => groups.get(key)!);
  } else if (path === "typeCatalog.custom") {
    const presets = new Map(layout.typeCatalog.custom.map(preset => [preset.key, preset]));
    layout.typeCatalog.custom = value.filter(key => presets.has(key)).map(key => presets.get(key)!);
  } else if (path.startsWith("group:")) {
    const group = layout.columnGroups.find(group => group.id === path.slice(6));
    if (group) group.columnKeys = value;
  } else if (path === "organization.groups") layout.organization.groups = value;
  else if (path === "organization.sorts") layout.organization.sorts = value;
  else if (path === "typeCatalog.disabled") layout.typeCatalog.disabled = value as SelectionLayout["typeCatalog"]["disabled"];
  else layout[path as "hiddenColumns" | "fixedColumns"] = value;
}
const fail = (reason: "conflict" | "permission" | "validation", message: string): SelectionLayoutHistoryResult => ({ ok: false, reason, message });

/** Apply a layout delta against current revisions, without replaying visibility or ownership. */
export function applySelectionLayoutHistoryChange(current: SelectionLayout, change: SelectionLayoutHistoryChange, direction: "undo" | "redo", context: SelectionLayoutHistoryContext): SelectionLayoutHistoryResult {
  if (!context.canEditShared && (change.patches.some(patch => patch.entity === "preset") || change.sequences.some(sequence => sequence.path.startsWith("typeCatalog.")))) return fail("permission", "当前没有管理字段类型的权限");
  const expected = (value: { before: any; after: any }) => direction === "undo" ? value.after : value.before;
  const target = (value: { before: any; after: any }) => direction === "undo" ? value.before : value.after;
  for (const patch of change.patches) {
    if (patch.entity === "rowHeight") {
      if (!same({ present: true, value: current.rowHeight }, expected(patch))) return fail("conflict", "行高已被其他操作修改，请刷新后重试");
      continue;
    }
    const value = findEntity(current, patch.entity, patch.key);
    if (patch.entity === "field") {
      if (patch.property && security.has(patch.property)) return fail("permission", "不能通过历史记录修改字段公开范围或管理权限");
      if (!value) return fail("conflict", "字段已不存在或不可见，不能恢复历史设置");
      if (value.visibility === "PRIVATE" && value.ownerId && value.ownerId !== context.userId && !context.isSuperAdmin) return fail("permission", "当前不能访问此私有字段");
      if (value.ownerId && value.ownerId !== context.userId && !context.isSuperAdmin && patch.property !== "width") return fail("permission", "当前没有管理此字段的权限");
      if (!value.ownerId && !context.canEditShared && patch.property !== "width") return fail("permission", "当前没有修改字段设置的权限");
      if (!patch.property) {
        const required = expected(patch) as Slot;
        const matching = required.present ? equal(definition(value as SelectionField), required.value) : value.deleted && equal(definition(value as SelectionField), { ...((patch.before.present ? patch.before : patch.after).value as ObjectValue), deleted: true });
        if (!matching) return fail("conflict", "字段定义已被其他操作修改，请刷新后重试");
      } else if (!same(slot(definition(value as SelectionField), patch.property), expected(patch))) return fail("conflict", "字段设置已被其他操作修改，请刷新后重试");
    } else if (!same(patch.property ? slot(value, patch.property) : entitySlot(value, patch.entity), expected(patch))) return fail("conflict", "分组或字段类型设置已被其他操作修改，请刷新后重试");
  }
  for (const sequence of change.sequences) if (!sequenceMatches(sequenceValue(current, sequence.path), expected(sequence), target(sequence), ["hiddenColumns", "typeCatalog.disabled"].includes(sequence.path))) return fail("conflict", "字段顺序或组织设置已被其他操作修改，请刷新后重试");
  const next = clone(current);
  for (const patch of change.patches) {
    const value = target(patch) as Slot;
    if (patch.entity === "rowHeight") { next.rowHeight = value.value as SelectionLayout["rowHeight"]; continue; }
    const list = entityList(next, patch.entity), index = list.findIndex(entry => entityKey(patch.entity as Entity, entry) === patch.key);
    if (!patch.property) {
      if (patch.entity === "field") {
        const field = list[index];
        if (!value.present) field.deleted = true;
        else list[index] = { ...(value.value as ObjectValue), key: field.key, ownerId: field.ownerId, visibility: field.visibility, fieldRevision: field.fieldRevision };
      } else if (!value.present) { if (index >= 0) list.splice(index, 1); }
      else if (index >= 0) list[index] = clone(value.value as ObjectValue);
      else list.push(clone(value.value as ObjectValue));
    } else if (value.present) list[index][patch.property] = clone(value.value);
    else delete list[index][patch.property];
  }
  for (const sequence of change.sequences) setSequence(next, sequence.path, applySequence(sequenceValue(next, sequence.path), expected(sequence), target(sequence)));
  if (context.hasSharedLayout && !context.canEditShared) {
    const restricted = restrictSelectionReadonlyLayout(current, next, context.userId, context.isSuperAdmin);
    if (restricted.blocked || !equal(restricted.preferences, next)) return fail("permission", "当前没有修改公开列或公共布局的权限");
  }
  const parsed = selectionLayoutSchema.safeParse(next);
  return parsed.success ? { ok: true, preferences: parsed.data } : fail("validation", "历史设置与当前字段不兼容，未恢复本次操作");
}

/** Merge repeated updates to the same gesture without keeping complete layouts. */
export function mergeSelectionLayoutHistoryChanges(earlier: SelectionLayoutHistoryChange, later: SelectionLayoutHistoryChange): SelectionLayoutHistoryChange | undefined {
  const patches = new Map(earlier.patches.map(patch => [patchIdentity(patch), patch])), sequences = new Map(earlier.sequences.map(sequence => [sequence.path, sequence]));
  for (const patch of later.patches) {
    const before = patches.get(patchIdentity(patch));
    if (before && !same(before.after, patch.before)) return;
    patches.set(patchIdentity(patch), before ? { ...patch, before: before.before } : patch);
  }
  for (const sequence of later.sequences) {
    const before = sequences.get(sequence.path);
    if (before && !equal(before.after, sequence.before)) return;
    sequences.set(sequence.path, before ? { ...sequence, before: before.before } : sequence);
  }
  return clone({ patches: [...patches.values()].filter(patch => !same(patch.before, patch.after)), sequences: [...sequences.values()].filter(sequence => !equal(sequence.before, sequence.after)) });
}

export function selectionLayoutHistoryGroupKey(change: SelectionLayoutHistoryChange): string | undefined {
  return !change.sequences.length && change.patches.length > 0 && change.patches.every(patch => patch.entity === "field" && patch.property === "width")
    ? `layout:width:${change.patches.map(patch => patch.key).sort().join(",")}` : undefined;
}

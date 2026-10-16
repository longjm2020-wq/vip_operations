import { describe, expect, it } from "vitest";
import { selectionLayoutSchema, type SelectionField, type SelectionLayout } from "../../packages/contracts/src/selection-layout.js";
import { applySelectionLayoutHistoryChange, createSelectionLayoutHistoryChange, mergeSelectionLayoutHistoryChanges, selectionLayoutHistoryGroupKey, selectionLayoutHistorySecurityChanged, type SelectionLayoutHistoryResult } from "../../apps/web/src/selection-layout-history.js";

const field = (key: string, extra: Partial<SelectionField> = {}): SelectionField => ({ key, label: key, width: 120, type: "text", ...extra });
const layout = (patch: Partial<SelectionLayout> = {}) => selectionLayoutSchema.parse({ columns: [field("a"), field("b"), field("c"), field("d")], ...patch });
const change = (before: SelectionLayout, after: SelectionLayout) => createSelectionLayoutHistoryChange(before, after)!;
const context = { userId: "1", canEditShared: true, hasSharedLayout: true };
const applied = (result: SelectionLayoutHistoryResult) => { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.message); return result.preferences; };
const keys = (value: SelectionLayout) => value.columns.filter(field => !field.deleted).map(field => field.key);

describe("table layout history", () => {
  it("records supported layout edits but excludes navigation, filters, statistics and visibility metadata", () => {
    const before = layout({ columns: [field("custom:one", { custom: true, ownerId: "1", visibility: "PRIVATE", fieldRevision: 1 })] });
    const browsing = layout({ ...before, page: 3, pageSize: 5000, searchText: "搜索", groupBy: "supplier", columnFilters: { "custom:one": { mode: "contains", value: "x" } }, rowHeight: before.rowHeight, columns: [{ ...before.columns[0], visibility: "PUBLIC", fieldRevision: 2 }] });
    expect(createSelectionLayoutHistoryChange(before, browsing)).toBeNull();
    expect(selectionLayoutHistorySecurityChanged(before, browsing)).toBe(true);
    expect(selectionLayoutHistorySecurityChanged(before, { ...before, columns: [{ ...before.columns[0], fieldRevision: 2 }] })).toBe(false);
    const resized = { ...browsing, columns: [{ ...browsing.columns[0], width: 222 }] };
    expect(change(browsing, resized).patches).toHaveLength(1);
    expect(selectionLayoutHistoryGroupKey(change(browsing, resized))).toBe("layout:width:custom:one");
  });

  it("retains history when the server supplies default visibility while detecting real access changes", () => {
    const before = layout({ columns: [field("a"), field("custom:owned", { custom: true, ownerId: "1" })] });
    const saved = { ...before, columns: [{ ...before.columns[0], visibility: "PUBLIC" as const }, { ...before.columns[1], visibility: "PRIVATE" as const, fieldRevision: 1 }] };
    expect(selectionLayoutHistorySecurityChanged(before, saved)).toBe(false);
    expect(selectionLayoutHistorySecurityChanged(saved, before)).toBe(false);
    expect(selectionLayoutHistorySecurityChanged(saved, { ...saved, columns: [saved.columns[0], { ...saved.columns[1], visibility: "PUBLIC" }] })).toBe(true);
    expect(selectionLayoutHistorySecurityChanged(saved, { ...saved, columns: [saved.columns[0], { ...saved.columns[1], ownerId: "2" }] })).toBe(true);
  });

  it("reverses only changed field properties, retaining fresh revisions, unrelated properties and remote fields", () => {
    const before = layout({ columns: [field("custom:one", { custom: true, ownerId: "1", visibility: "PUBLIC", fieldRevision: 1 })] });
    const after = { ...before, columns: [{ ...before.columns[0], label: "新名称" }] };
    const live = { ...after, columns: [{ ...after.columns[0], width: 350, fieldRevision: 8 }, field("remote")] };
    const undo = applied(applySelectionLayoutHistoryChange(live, change(before, after), "undo", context));
    expect(undo.columns[0]).toMatchObject({ label: "custom:one", width: 350, fieldRevision: 8, ownerId: "1", visibility: "PUBLIC" });
    expect(undo.columns[1]).toEqual(live.columns[1]);
    expect(applied(applySelectionLayoutHistoryChange(undo, change(before, after), "redo", context)).columns[0].label).toBe("新名称");
    expect(live.columns[0].label).toBe("新名称");
  });

  it("undoes a field addition to a tombstone and redoes it with current ownership and revision", () => {
    const before = layout();
    const added = field("custom:new", { custom: true, ownerId: "1", visibility: "PRIVATE" });
    const after = { ...before, columns: [...before.columns, added] }, stored = change(before, after);
    expect(JSON.stringify(stored)).not.toContain("ownerId");
    const saved = { ...after, columns: after.columns.map(item => item.key === added.key ? { ...item, fieldRevision: 3 } : item) };
    const undo = applied(applySelectionLayoutHistoryChange(saved, stored, "undo", context));
    expect(keys(undo)).toEqual(keys(before));
    expect(undo.columns.find(item => item.key === added.key)).toMatchObject({ deleted: true, ownerId: "1", visibility: "PRIVATE", fieldRevision: 3 });
    const redo = applied(applySelectionLayoutHistoryChange(undo, stored, "redo", context));
    expect(keys(redo)).toEqual(keys(after));
    expect(redo.columns.find(item => item.key === added.key)).toMatchObject({ deleted: false, ownerId: "1", fieldRevision: 3 });
  });

  it("restores an existing deleted field without recreating a revoked or transferred field", () => {
    const before = layout({ columns: [field("custom:one", { custom: true, ownerId: "1", visibility: "PRIVATE", fieldRevision: 2 }), field("b")] });
    const after = { ...before, columns: [{ ...before.columns[0], deleted: true }, before.columns[1]] }, stored = change(before, after);
    const saved = { ...after, columns: [{ ...after.columns[0], fieldRevision: 9 }, after.columns[1]] };
    expect(applied(applySelectionLayoutHistoryChange(saved, stored, "undo", context)).columns[0]).toMatchObject({ deleted: false, fieldRevision: 9 });
    expect(applySelectionLayoutHistoryChange({ ...after, columns: [after.columns[1]] }, stored, "undo", context)).toMatchObject({ ok: false, reason: "conflict" });
    expect(applySelectionLayoutHistoryChange({ ...after, columns: [{ ...after.columns[0], ownerId: "2" }, after.columns[1]] }, stored, "undo", context)).toMatchObject({ ok: false, reason: "permission" });
    expect(selectionLayoutHistorySecurityChanged(before, { ...before, columns: [before.columns[1]] })).toBe(true);
  });

  it("preflights all layout changes atomically when a touched property changed remotely", () => {
    const before = layout(), after = { ...before, rowHeight: "compact" as const, columns: [{ ...before.columns[0], label: "改名" }, ...before.columns.slice(1)] };
    const live = { ...after, columns: [{ ...after.columns[0], label: "远端名称" }, ...after.columns.slice(1)] }, original = structuredClone(live);
    expect(applySelectionLayoutHistoryChange(live, change(before, after), "undo", context)).toMatchObject({ ok: false, reason: "conflict" });
    expect(live).toEqual(original);
    expect(live.rowHeight).toBe("compact");
  });

  it("reverses a moved column while retaining unrelated remote ordering and newly added columns", () => {
    const before = layout(), after = { ...before, columns: [before.columns[1], before.columns[0], before.columns[2], before.columns[3]] };
    const live = { ...after, columns: [after.columns[0], after.columns[1], after.columns[3], after.columns[2], field("remote")] };
    const undo = applied(applySelectionLayoutHistoryChange(live, change(before, after), "undo", context));
    expect(keys(undo)).toEqual(["a", "b", "d", "c", "remote"]);
    expect(keys(applied(applySelectionLayoutHistoryChange(undo, change(before, after), "redo", context)))).toEqual(keys(live));
    const conflicting = { ...after, columns: [after.columns[1], after.columns[2], after.columns[0], after.columns[3]] };
    expect(applySelectionLayoutHistoryChange(conflicting, change(before, after), "undo", context)).toMatchObject({ ok: false, reason: "conflict" });
  });

  it("preserves unrelated hidden, pinned and organization keys when restoring their memberships", () => {
    const before = layout({ hiddenColumns: ["a"], fixedColumns: ["a"], organization: { groups: ["a"], sorts: [] } });
    const after = { ...before, hiddenColumns: ["a", "b"], fixedColumns: ["a", "b"], organization: { groups: ["a", "b"], sorts: ["c"] } };
    const live = { ...after, hiddenColumns: ["a", "b", "remote"], fixedColumns: ["a", "b", "remote"], organization: { groups: ["a", "b", "remote"], sorts: ["c", "remote"] } };
    const undo = applied(applySelectionLayoutHistoryChange(live, change(before, after), "undo", context));
    expect(undo.hiddenColumns).toEqual(["a", "remote"]);
    expect(undo.fixedColumns).toEqual(["a", "remote"]);
    expect(undo.organization).toEqual({ groups: ["a", "remote"], sorts: ["remote"] });
  });

  it("restores group names and members without losing a remotely added member or another group", () => {
    const before = layout({ columnGroups: [{ id: "g1", name: "价格", columnKeys: ["a"] }] });
    const after = { ...before, columnGroups: [{ id: "g1", name: "核价", columnKeys: ["a", "b"] }] };
    const live = { ...after, columnGroups: [{ ...after.columnGroups[0], columnKeys: ["a", "b", "c"] }, { id: "remote", name: "远端组", columnKeys: ["d"] }] };
    const undo = applied(applySelectionLayoutHistoryChange(live, change(before, after), "undo", context));
    expect(undo.columnGroups).toEqual([{ id: "g1", name: "价格", columnKeys: ["a", "c"] }, live.columnGroups[1]]);
    const addedGroup = { ...before, columnGroups: [...before.columnGroups, { id: "new", name: "新组", columnKeys: ["b"] }] }, stored = change(before, addedGroup);
    const without = applied(applySelectionLayoutHistoryChange(addedGroup, stored, "undo", context));
    expect(without.columnGroups).toEqual(before.columnGroups);
    expect(applied(applySelectionLayoutHistoryChange(without, stored, "redo", context)).columnGroups).toEqual(addedGroup.columnGroups);
  });

  it("restores type presets and enabled types while retaining unrelated catalog additions", () => {
    const preset = { key: "custom:preset", name: "标签类型", baseType: "text" as const, enabled: true, options: [] };
    const before = layout({ typeCatalog: { disabled: ["number"], custom: [preset] } });
    const after = { ...before, typeCatalog: { disabled: ["number", "checkbox"] as SelectionLayout["typeCatalog"]["disabled"], custom: [{ ...preset, name: "备注类型" }] } };
    const remote = { ...preset, key: "custom:remote", name: "远端类型" };
    const live = { ...after, typeCatalog: { disabled: [...after.typeCatalog.disabled, "date"] as SelectionLayout["typeCatalog"]["disabled"], custom: [...after.typeCatalog.custom, remote] } };
    const undo = applied(applySelectionLayoutHistoryChange(live, change(before, after), "undo", context));
    expect(undo.typeCatalog.disabled).toEqual(["number", "date"]);
    expect(undo.typeCatalog.custom).toEqual([preset, remote]);
  });

  it("checks current shared permissions and permits only an owner's private definitions for viewers", () => {
    const before = layout(), after = { ...before, rowHeight: "compact" as const };
    expect(applySelectionLayoutHistoryChange(after, change(before, after), "undo", { ...context, canEditShared: false })).toMatchObject({ ok: false, reason: "permission" });
    const privateBefore = layout({ columns: [field("a"), field("custom:private", { custom: true, ownerId: "1", visibility: "PRIVATE" })] });
    const privateAfter = { ...privateBefore, columns: [privateBefore.columns[0], { ...privateBefore.columns[1], label: "新私有名称" }] };
    expect(applied(applySelectionLayoutHistoryChange(privateAfter, change(privateBefore, privateAfter), "undo", { ...context, canEditShared: false })).columns[1].label).toBe("custom:private");
  });

  it("merges repeated column-width updates but rejects a discontinuous gesture", () => {
    const before = layout(), middle = { ...before, columns: [{ ...before.columns[0], width: 150 }, ...before.columns.slice(1)] }, after = { ...middle, columns: [{ ...middle.columns[0], width: 200 }, ...middle.columns.slice(1)] };
    const combined = mergeSelectionLayoutHistoryChanges(change(before, middle), change(middle, after))!;
    expect(combined.patches).toHaveLength(1);
    expect(applied(applySelectionLayoutHistoryChange(after, combined, "undo", context)).columns[0].width).toBe(120);
    expect(mergeSelectionLayoutHistoryChanges(change(before, middle), change(before, after))).toBeUndefined();
  });
});

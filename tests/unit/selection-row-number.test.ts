import { describe, expect, it } from "vitest";
import { selectionRowNumbers } from "../../apps/web/src/selection-row-number.js";
import { mergeSelectionRemote, mergeSelectionSave, selectionDelta } from "../../apps/web/src/selection-autosave.js";
import { createSelectionHistoryChange } from "../../apps/web/src/selection-history.js";

describe("shared table row numbers", () => {
  it("preserves authoritative gaps and server numbers regardless of display order or omitted rows", () => {
    const a = { _key: "a", id: "500", rowNumber: 69, sortOrder: 500 };
    const b = { _key: "b", id: "501", rowNumber: 75, sortOrder: 100 };
    expect([...selectionRowNumbers([b, a])]).toEqual([["b", 75], ["a", 69]]);
    expect(selectionRowNumbers([a]).get("a")).toBe(69);
  });

  it("falls back to all loaded saved rows in sortOrder ascending and bigint id descending order", () => {
    const values = [
      { _key: "late", id: "4", sortOrder: 2 },
      { _key: "smaller", id: "9007199254740992", sortOrder: 1 },
      { _key: "larger", id: "9007199254740993", sortOrder: 1 },
    ];
    const result = selectionRowNumbers(values);
    expect([result.get("larger"), result.get("smaller"), result.get("late")]).toEqual([1, 2, 3]);
    expect(selectionRowNumbers([...values].reverse())).toEqual(result);
  });

  it("appends unsaved drafts after the largest shared number without changing saved numbers", () => {
    const result = selectionRowNumbers([
      { _key: "draft-a" }, { _key: "saved", id: "1", rowNumber: 69 }, { _key: "draft-b" },
    ]);
    expect(result.get("saved")).toBe(69);
    expect([result.get("draft-a"), result.get("draft-b")]).toEqual([70, 71]);
  });

  it("rejects invalid metadata as authoritative and avoids collisions during a mixed-version response", () => {
    const result = selectionRowNumbers([
      { _key: "a", id: "1", rowNumber: 1, sortOrder: 1 },
      { _key: "b", id: "2", rowNumber: "99", sortOrder: 0 },
      { _key: "c", id: "3", rowNumber: -4, sortOrder: 2 },
    ]);
    expect(result.get("a")).toBe(1);
    expect(new Set(result.values()).size).toBe(3);
    expect([...result.values()].every(value => Number.isSafeInteger(value) && value > 0)).toBe(true);
  });

  it("always accepts the server's new number during save and disjoint remote edits", () => {
    const before = { _key: "a", id: "1", rowNumber: 69, material: "原值" };
    const current = { ...before, rowNumber: 70, material: "本地草稿" };
    const incoming = { ...before, rowNumber: 68, updatedAt: "new" };
    expect(mergeSelectionSave(current, before, incoming)).toMatchObject({ rowNumber: 68, material: "本地草稿" });
    expect(mergeSelectionRemote(current, before, incoming)).toMatchObject({ row: { rowNumber: 68, material: "本地草稿" }, conflicts: [] });
    const { rowNumber: _rowNumber, ...legacy } = incoming;
    expect(mergeSelectionSave(current, before, legacy).rowNumber).toBe(70);
    expect(mergeSelectionRemote(current, before, legacy).row.rowNumber).toBe(70);
  });

  it("never submits row numbers or records their changes as editable history", () => {
    expect(selectionDelta({ rowNumber: 69, material: "新值" }, { rowNumber: 68, material: "旧值" })).toEqual({ material: "新值" });
    const before = { _key: "a", id: "1", rowNumber: 69 };
    expect(createSelectionHistoryChange([before], [{ ...before, rowNumber: 68 }], ["rowNumber"])).toBeNull();
  });
});

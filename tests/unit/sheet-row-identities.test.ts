import { describe, expect, it } from "vitest";
import { SheetRowIdentities } from "../../apps/web/src/sheet-row-identities.js";

describe("Sheet find row identities", () => {
  it("keeps an opened selection attached to its original draft after preceding rows are removed or reordered", () => {
    const tracker = new SheetRowIdentities(), rows = [{ text: "A" }, { text: "A" }, { text: "A" }];
    const before = tracker.keys(rows), selected = new Set([`${before[1]}::text`]);
    const removedFirst = tracker.keys(rows.slice(1));
    expect(removedFirst[0]).toBe(before[1]);
    expect(selected.has(`${removedFirst[1]}::text`)).toBe(false);
    const reordered = tracker.keys([rows[2], rows[0], rows[1]]);
    expect(reordered.indexOf(before[1])).toBe(2);
    expect(tracker.keys([rows[0], rows[2]])).not.toContain(before[1]);
    expect(tracker.keys(rows)[1]).toBe(before[1]); // Undo restores the same original row.
    expect(rows).toEqual([{ text: "A" }, { text: "A" }, { text: "A" }]);
  });
  it("preserves identities through editing clones without placing tracking metadata in API or workbook data", () => {
    const tracker = new SheetRowIdentities(), rows = [{ text: "A" }, { text: "B" }];
    const before = tracker.keys(rows);
    const edited = rows.map(row => tracker.inherit(row, { ...row, text: row.text + "1" }));
    expect(tracker.keys(edited)).toEqual(before);
    expect(Object.keys(edited[0])).toEqual(["text"]);
    expect(JSON.parse(JSON.stringify(edited))).toEqual([{ text: "A1" }, { text: "B1" }]);
    expect(tracker.keys([{ text: "A1" }, { text: "B1" }])).not.toEqual(before); // Unknown external drafts expire the old scope safely.
  });
  it("uses unique saved identities across refreshes but never treats copied drafts or duplicate business keys as the same row", () => {
    const tracker = new SheetRowIdentities(), rows = [{ id: "1", text: "A" }, { id: "2", text: "B" }];
    const before = tracker.keys(rows);
    expect(tracker.keys([{ id: "2", text: "B2" }, { id: "1", text: "A2" }])).toEqual([before[1], before[0]]);
    const copied = { text: "A" };
    expect(tracker.keys([...rows, copied])[2]).not.toBe(before[0]);
    const duplicates = tracker.keys([{ id: "same", text: "A" }, { id: "same", text: "A" }]);
    expect(duplicates[0]).not.toBe(duplicates[1]);
  });
});

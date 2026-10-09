import { describe, expect, it } from "vitest";
import { selectionLastRow, selectionRowHasContent } from "../../packages/contracts/src/selection-trailing-row.js";

describe("trailing selection row", () => {
  it("counts zero, images, and custom values without counting metadata or formatting", () => {
    expect(selectionRowHasContent({ vipPrice: "0" })).toBe(true);
    expect(selectionRowHasContent({ images: [{ id: "photo", url: "/photo" }] })).toBe(true);
    expect(selectionRowHasContent({ extraFields: { "custom:notes": "备注" } })).toBe(true);
    expect(selectionRowHasContent({ id: "12", sortOrder: 99, createdAt: "today", productId: "42", rowColor: "BLUE", cellColors: { material: "BLUE" } })).toBe(false);
    expect(selectionRowHasContent({ material: " \n ", images: [], extraFields: { "custom:photo": "[ ]", "custom:text": " " } })).toBe(false);
  });

  it("uses the whole table's manual order, including unsaved pasted rows", () => {
    const old = { id: "1", sortOrder: 1 }, saved = { id: "2", sortOrder: 2 };
    const pasted = { _key: "pasted", sortOrder: 3 };
    expect(selectionLastRow([saved, old])).toBe(saved);
    expect(selectionLastRow([pasted, saved, old])).toBe(pasted);
    expect(selectionLastRow([])).toBeUndefined();
  });

  it("matches the database tie break without losing bigint precision", () => {
    const first = { id: "9007199254740993", sortOrder: 10 }, last = { id: "9007199254740992", sortOrder: 10 };
    expect(selectionLastRow([first, last])).toBe(last);
    expect(selectionLastRow([last, first])).toBe(last);
  });
});

import { describe, expect, it } from "vitest";
import { reorderSelectionItems } from "../../apps/web/src/selection-reorder.js";

describe("moving selected rows or columns together", () => {
  const items = ["a", "b", "c", "d", "e", "f"];
  const key = (item: string) => item;
  it("moves forward and backward around the target while preserving group order", () => {
    expect(reorderSelectionItems(items, ["c", "b"], "c", "e", key)).toEqual(["a", "d", "e", "b", "c", "f"]);
    expect(reorderSelectionItems(items, ["d", "e"], "e", "b", key)).toEqual(["a", "d", "e", "b", "c", "f"]);
  });
  it("retains unselected and hidden items when moving a noncontiguous selection", () => {
    expect(reorderSelectionItems(items, ["b", "d"], "b", "f", key)).toEqual(["a", "c", "e", "f", "b", "d"]);
  });
  it("ignores internal, missing and unchanged targets without dirtying order", () => {
    expect(reorderSelectionItems(items, ["b", "c"], "b", "c", key)).toBe(items);
    expect(reorderSelectionItems(items, ["b", "missing"], "b", "f", key)).toBe(items);
    expect(reorderSelectionItems(items, ["b", "c"], "b", "missing", key)).toBe(items);
    expect(reorderSelectionItems(items, ["b"], "c", "f", key)).toBe(items);
  });
  it("keeps original objects so field contents and identity travel with their row", () => {
    const rows = items.map(id => ({ id, value: `value-${id}` }));
    const next = reorderSelectionItems(rows, ["b", "c"], "c", "f", row => row.id);
    expect(next.map(row => row.id)).toEqual(["a", "d", "e", "f", "b", "c"]);
    expect(next[4]).toBe(rows[1]); expect(next[5]).toBe(rows[2]);
  });
});

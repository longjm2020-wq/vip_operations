import { describe, expect, it } from "vitest";
import {
  columnMenuTargets,
  nextColumnSelection,
  nextPinnedColumns,
} from "../../apps/web/src/inventory-column-selection.js";

const order = ["image", "style", "article", "sku", "color", "size", "stock"];
const none = { selected: [], anchor: null };
const plain = { shift: false, toggle: false },
  shift = { shift: true, toggle: false },
  toggle = { shift: false, toggle: true };

describe("inventory column header selection", () => {
  it("selects a single column with a plain click and clears it on a second click", () => {
    const first = nextColumnSelection(order, none, "style", plain);
    expect(first).toEqual({ selected: ["style"], anchor: "style" });
    expect(nextColumnSelection(order, first, "sku", plain)).toEqual({
      selected: ["sku"],
      anchor: "sku",
    });
    expect(nextColumnSelection(order, first, "style", plain)).toEqual(none);
  });

  it("selects a contiguous range from the anchor with Shift in either direction", () => {
    const anchored = nextColumnSelection(order, none, "article", plain);
    const right = nextColumnSelection(order, anchored, "size", shift);
    expect(right).toEqual({
      selected: ["article", "sku", "color", "size"],
      anchor: "article",
    });
    // The anchor stays, so a second Shift+click re-ranges instead of growing.
    expect(nextColumnSelection(order, right, "image", shift).selected).toEqual([
      "image",
      "style",
      "article",
    ]);
    expect(nextColumnSelection(order, none, "color", shift)).toEqual({
      selected: ["color"],
      anchor: "color",
    });
  });

  it("toggles non-contiguous columns with Ctrl/Cmd and keeps display order", () => {
    let state = nextColumnSelection(order, none, "stock", toggle);
    state = nextColumnSelection(order, state, "style", toggle);
    state = nextColumnSelection(order, state, "color", toggle);
    expect(state.selected).toEqual(["style", "color", "stock"]);
    state = nextColumnSelection(order, state, "color", toggle);
    expect(state).toEqual({ selected: ["style", "stock"], anchor: "color" });
  });

  it("adds a Shift range to an existing Ctrl selection", () => {
    let state = nextColumnSelection(order, none, "image", toggle);
    state = nextColumnSelection(order, state, "sku", toggle);
    state = nextColumnSelection(order, state, "size", {
      shift: true,
      toggle: true,
    });
    expect(state.selected).toEqual(["image", "sku", "color", "size"]);
  });

  it("ignores columns that are no longer displayed", () => {
    const stale = { selected: ["gone", "style"], anchor: "gone" };
    expect(nextColumnSelection(order, stale, "gone", plain)).toBe(stale);
    expect(nextColumnSelection(order, stale, "article", shift)).toEqual({
      selected: ["article"],
      anchor: "article",
    });
  });
});

describe("inventory column context menu targets and pinning", () => {
  it("acts on the whole selection only when right-clicking a selected column", () => {
    expect(columnMenuTargets(order, ["stock", "style"], "stock")).toEqual([
      "style",
      "stock",
    ]);
    expect(columnMenuTargets(order, ["stock", "style"], "color")).toEqual([
      "color",
    ]);
  });

  it("keeps pinned columns in table order and supports unpinning", () => {
    const pinned = nextPinnedColumns(order, ["stock"], "pin", ["color", "style"]);
    expect(pinned).toEqual(["style", "color", "stock"]);
    expect(nextPinnedColumns(order, pinned, "pin", ["style"])).toEqual(pinned);
    expect(nextPinnedColumns(order, pinned, "unpin", ["color", "sku"])).toEqual([
      "style",
      "stock",
    ]);
    expect(nextPinnedColumns(order, pinned, "unpin-all", [])).toEqual([]);
  });
});

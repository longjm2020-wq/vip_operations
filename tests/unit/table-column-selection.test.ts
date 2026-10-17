import { describe, expect, it } from "vitest";
import {
  columnClickModifiers,
  columnMenuTargets,
  columnPinMenuEntries,
  columnRange,
  dragColumnSelection,
  nextColumnSelection,
  nextPinnedColumns,
} from "../../apps/web/src/table-column-selection.js";

const order = ["image", "style", "article", "sku", "color", "size", "stock"];
const none = { selected: [], anchor: null };
const plain = { shift: false, toggle: false },
  shift = { shift: true, toggle: false },
  toggle = { shift: false, toggle: true };

describe("table column header selection", () => {
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

describe("table column drag selection", () => {
  it("selects the contiguous range between the pressed and hovered headers", () => {
    expect(dragColumnSelection(order, ["image"], "sku", "style", false)).toEqual([
      "style",
      "article",
      "sku",
    ]);
    expect(dragColumnSelection(order, [], "sku", "size", false)).toEqual([
      "sku",
      "color",
      "size",
    ]);
  });

  it("adds the dragged range to the earlier selection with Ctrl/Cmd", () => {
    expect(dragColumnSelection(order, ["stock", "image"], "article", "sku", true)).toEqual([
      "image",
      "article",
      "sku",
      "stock",
    ]);
    expect(dragColumnSelection(order, ["stock"], "gone", "sku", true)).toEqual(["stock"]);
  });

  it("computes ranges and modifiers", () => {
    expect(columnRange(order, "size", "sku")).toEqual(["sku", "color", "size"]);
    expect(columnRange(order, "size", "gone")).toEqual([]);
    expect(columnClickModifiers({ shiftKey: false, ctrlKey: false, metaKey: true })).toEqual({
      shift: false,
      toggle: true,
    });
  });
});

describe("table column context menu targets and pinning", () => {
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
    const pinned = nextPinnedColumns(order, ["stock"], "fix-selected", [
      "color",
      "style",
    ]);
    expect(pinned).toEqual(["style", "color", "stock"]);
    expect(nextPinnedColumns(order, pinned, "fix-selected", ["style"])).toEqual(
      pinned,
    );
    expect(
      nextPinnedColumns(order, pinned, "unfix-selected", ["color", "sku"]),
    ).toEqual(["style", "stock"]);
    expect(nextPinnedColumns(order, pinned, "unfix-all", [])).toEqual([]);
  });

  it("toggles a single column with the fix-column entry", () => {
    expect(nextPinnedColumns(order, ["stock"], "fix-column", ["image"])).toEqual([
      "image",
      "stock",
    ]);
    expect(nextPinnedColumns(order, ["image", "stock"], "fix-column", ["stock"])).toEqual([
      "image",
    ]);
  });

  it("builds the shared pin menu entries", () => {
    expect(columnPinMenuEntries(["style"], [])).toEqual([
      { key: "fix-column", label: "固定此列" },
    ]);
    expect(columnPinMenuEntries(["style"], ["style"])).toEqual([
      { key: "fix-column", label: "取消固定此列" },
      { key: "unfix-all", label: "取消所有固定列" },
    ]);
    expect(columnPinMenuEntries(["style", "stock"], ["stock"]).map((entry) => entry.label)).toEqual([
      "固定所选 2 列",
      "取消固定所选 2 列",
      "取消所有固定列",
    ]);
    expect(columnPinMenuEntries(["style", "stock"], ["style", "stock"]).map((entry) => entry.key)).toEqual([
      "unfix-selected",
      "unfix-all",
    ]);
  });
});

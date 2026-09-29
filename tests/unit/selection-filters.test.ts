import { describe, expect, it } from "vitest";
import { matchesSelectionFilters, selectionAllCells, clearSelectionCells, selectionFilterOptions, sortSelectionRows } from "../../apps/web/src/selection-filters.js";

describe("selection column filters and selection", () => {
  const row = { _key: "1", material: "Cotton", vipPrice: "12.00", extraFields: { "custom:a": "夏季" }, images: [{ color: "红", url: "https://example.com/image" }] };
  it("combines built-in and custom filters without case sensitivity", () => {
    expect(matchesSelectionFilters(row, { material: { mode: "contains", value: "cot" }, "custom:a": { mode: "equals", value: "夏季" } })).toBe(true);
    expect(matchesSelectionFilters(row, { material: { mode: "contains", value: "silk" } })).toBe(false);
  });
  it("compares money numerically and distinguishes empty from zero", () => {
    expect(matchesSelectionFilters(row, { vipPrice: { mode: "equals", value: "12" } })).toBe(true);
    expect(matchesSelectionFilters({ vipPrice: 0 }, { vipPrice: { mode: "empty", value: "" } })).toBe(false);
    expect(matchesSelectionFilters({}, { material: { mode: "empty", value: "" } })).toBe(true);
  });
  it("filters images by color and missing images", () => {
    expect(matchesSelectionFilters(row, { images: { mode: "contains", value: "红" } })).toBe(true);
    expect(matchesSelectionFilters({ images: [] }, { images: { mode: "filled", value: "" } })).toBe(false);
    expect(matchesSelectionFilters({ labelImages: [{ url: "https://example.com/wash-label.jpg" }] }, { labelImages: { mode: "contains", value: "wash-label" } })).toBe(true);
    expect(matchesSelectionFilters({ labelImages: [] }, { labelImages: { mode: "filled", value: "" } })).toBe(false);
  });
  it("selects only supplied visible rows and columns", () => {
    expect([...selectionAllCells([row], [{ key: "material" }, { key: "custom:a" }])]).toEqual(["1::material", "1::custom:a"]);
    expect(selectionAllCells([], [{ key: "material" }]).size).toBe(0);
  });
});

it("clears selected values without losing formatting or leaving invalid image colors", () => {
  const row = { _key: "1", material: "cotton", color: "red", images: [{ id: "img", color: "red" }], extraFields: { "custom:a": "value" }, cellAlignments: { material: "right" } };
  const [cleared] = clearSelectionCells([row], new Set(["1::color", "1::custom:a"]));
  expect(cleared.color).toBeNull();
  expect(cleared.images).toEqual([{ id: "img", color: "" }]);
  expect(cleared.extraFields["custom:a"]).toBe("");
  expect(cleared.material).toBe("cotton");
  expect(cleared.cellAlignments).toEqual(row.cellAlignments);
  expect(clearSelectionCells([row], new Set(["1::images"]))[0].images).toEqual([]);
  expect(clearSelectionCells([{ ...row, labelImages: [{ id: "label" }] }], new Set(["1::labelImages"]))[0].labelImages).toEqual([]);
  expect(row.color).toBe("red");
});

it("combines checked options, colors and conditions including empty selections", () => {
  const row = { vipPrice: "12.00", cellColors: { vipPrice: "YELLOW" } };
  expect(matchesSelectionFilters(row, { vipPrice: { mode: "gte", value: "10", values: ["12"], colorType: "fill", colors: ["YELLOW"] } })).toBe(true);
  expect(matchesSelectionFilters(row, { vipPrice: { mode: "contains", value: "", values: [] } })).toBe(false);
  expect(matchesSelectionFilters(row, { vipPrice: { mode: "between", value: "10", end: "12" } })).toBe(true);
  expect(matchesSelectionFilters(row, { vipPrice: { mode: "between", value: "13", end: "15" } })).toBe(false);
  expect(matchesSelectionFilters({}, { material: { mode: "gt", value: "1" } })).toBe(false);
});
it("counts complete values including blanks and normalizes equivalent money", () => {
  expect(selectionFilterOptions([{ vipPrice: "12.00" }, { vipPrice: "12" }, { vipPrice: null }], "vipPrice")).toEqual([{ value: "12", count: 2 }, { value: "", count: 1 }]);
  expect(selectionFilterOptions([{ color: "红/蓝" }, { color: "红" }], "color")).toHaveLength(2);
});
it("sorts built-in/custom columns and keeps empty values last without mutating rows", () => {
  const rows = [{ vipPrice: "12", extraFields: { "custom:a": "B" } }, { vipPrice: "2", extraFields: { "custom:a": "A" } }, { vipPrice: null }];
  expect(sortSelectionRows(rows, { key: "vipPrice", direction: "asc" }).map(row => row.vipPrice)).toEqual(["2", "12", null]);
  expect(sortSelectionRows(rows, { key: "custom:a", direction: "desc" }).map(row => row.vipPrice)).toEqual(["12", "2", null]);
  expect(rows[0].vipPrice).toBe("12");
});

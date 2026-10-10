import { describe, expect, it } from "vitest";
import { applySelectionOptionSearch, matchesSelectionFilters, searchSelectionFilterOptions, selectionAllCells, clearSelectionCells, selectionFilterOptions, sortSelectionRows } from "../../apps/web/src/selection-filters.js";
import type { SelectionFilter } from "../../packages/contracts/src/selection-view.js";

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

describe("typed numeric column sorting", () => {
  const key = "custom:measurement";
  const numericColumns = [{ key: "custom:other", type: "text" }, { key, type: "number" }];
  const values = (rows: Record<string, unknown>[]) => rows.map(row => (row.extraFields as Record<string, unknown>)[key]);

  it("sorts negative numbers and decimals numerically in both directions and leaves blanks last", () => {
    const rows = ["2.5", "-2", "2.12", "-10", "0", " ", null].map(value => ({ extraFields: { [key]: value } }));
    const original = structuredClone(rows);
    expect(values(sortSelectionRows(rows, { key, direction: "asc" }, numericColumns))).toEqual(["-10", "-2", "0", "2.12", "2.5", " ", null]);
    expect(values(sortSelectionRows(rows, { key, direction: "desc" }, numericColumns))).toEqual(["2.5", "2.12", "0", "-2", "-10", " ", null]);
    expect(rows).toEqual(original);
  });

  it("preserves natural text sorting when a numeric-looking column is text or has no supplied type", () => {
    const rows = ["2.12", "2.5", "-10", "-2"].map(value => ({ extraFields: { [key]: value } }));
    const sort = { key, direction: "asc" as const };
    expect(values(sortSelectionRows(rows, sort, numericColumns))).toEqual(["-10", "-2", "2.12", "2.5"]);
    expect(values(sortSelectionRows(rows, sort, [{ key, type: "text" }]))).toEqual(["-2", "-10", "2.5", "2.12"]);
    expect(values(sortSelectionRows(rows, sort))).toEqual(["-2", "-10", "2.5", "2.12"]);
  });

  it("keeps long style identifiers distinct without converting them to imprecise numbers", () => {
    const rows = ["9007199254740993", "9007199254740992", "09007199254740995"].map(xutiStyleNo => ({ xutiStyleNo }));
    const columns = [{ key, type: "number" }, { key: "xutiStyleNo", type: "text" }];
    expect(sortSelectionRows(rows, { key: "xutiStyleNo", direction: "asc" }, columns).map(row => row.xutiStyleNo)).toEqual(["9007199254740992", "9007199254740993", "09007199254740995"]);
    expect(sortSelectionRows(rows, { key: "xutiStyleNo", direction: "desc" }, columns).map(row => row.xutiStyleNo)).toEqual(["09007199254740995", "9007199254740993", "9007199254740992"]);
    expect(rows.map(row => row.xutiStyleNo)).toEqual(["9007199254740993", "9007199254740992", "09007199254740995"]);
  });
});

describe("searched checkbox filter submission", () => {
  const rows = [
    { material: "面料底布：桑蚕丝100%\n面料绒毛：粘纤100%" },
    { material: "面料：100%山羊绒" },
    { material: "面料：70%桑蚕丝30%棉" },
    { material: "  Cotton  " },
    { material: "" },
  ];
  const options = selectionFilterOptions(rows, "material");
  const draft: SelectionFilter = { mode: "contains", value: "" };
  it("limits default checked options to the full search results when confirming", () => {
    const filter = applySelectionOptionSearch(draft, options, "桑蚕丝");
    expect(filter.values).toEqual([rows[0].material, rows[2].material]);
    expect(rows.filter(row => matchesSelectionFilters(row, { material: filter }))).toEqual([rows[0], rows[2]]);
    expect(draft.values).toBeUndefined();
  });
  it("intersects explicit checks without retaining checked nonmatching options", () => {
    const explicit = { ...draft, values: [rows[0].material, rows[1].material] };
    expect(applySelectionOptionSearch(explicit, options, "桑蚕丝").values).toEqual([rows[0].material]);
    expect(explicit.values).toEqual([rows[0].material, rows[1].material]);
  });
  it("keeps the draft unchanged when search is cleared or whitespace only", () => {
    const explicit = { ...draft, values: [rows[0].material, "temporarily excluded by another filter"] };
    applySelectionOptionSearch(explicit, options, "山羊绒");
    expect(applySelectionOptionSearch(explicit, options, "")).toBe(explicit);
    expect(applySelectionOptionSearch(explicit, options, " \t\n ")).toBe(explicit);
    expect(applySelectionOptionSearch(draft, options, "")).toBe(draft);
  });
  it("applies empty matches and unchecked matches as an empty selection", () => {
    for (const filter of [applySelectionOptionSearch(draft, options, "不存在"), applySelectionOptionSearch({ ...draft, values: [] }, options, "桑蚕丝")]) {
      expect(filter.values).toEqual([]);
      expect(rows.filter(row => matchesSelectionFilters(row, { material: filter }))).toEqual([]);
    }
  });
  it("matches any whitespace-separated keyword without case sensitivity and supports blanks", () => {
    expect(searchSelectionFilterOptions(options, "  COT 山羊绒\n").map(option => option.value)).toEqual([rows[1].material, "Cotton"]);
    expect(applySelectionOptionSearch(draft, options, "空白").values).toEqual([""]);
  });
  it("keeps complete tag and normalized money tokens compatible with row matching", () => {
    const tags = [{ color: "红/蓝" }, { color: "红" }, { color: "绿" }];
    const tagFilter = applySelectionOptionSearch(draft, selectionFilterOptions(tags, "color"), "红");
    expect(tagFilter.values).toEqual(["红/蓝", "红"]);
    expect(tags.filter(row => matchesSelectionFilters(row, { color: tagFilter }))).toHaveLength(2);
    const money = [{ vipPrice: "12.00" }, { vipPrice: "12" }, { vipPrice: "2" }];
    const moneyFilter = applySelectionOptionSearch(draft, selectionFilterOptions(money, "vipPrice"), "12");
    expect(moneyFilter.values).toEqual(["12"]);
    expect(money.filter(row => matchesSelectionFilters(row, { vipPrice: moneyFilter }))).toHaveLength(2);
  });
  it("preserves conditions and format restrictions and only commits supplied candidates", () => {
    const colored: SelectionFilter = { ...draft, value: "100%", colorType: "fill", colors: ["YELLOW"] };
    const filter = applySelectionOptionSearch(colored, options.slice(0, 1), "桑蚕丝");
    expect(filter).toEqual({ ...colored, values: [rows[0].material] });
    expect(matchesSelectionFilters({ ...rows[0], cellColors: { material: "YELLOW" } }, { material: filter })).toBe(true);
    expect(matchesSelectionFilters({ ...rows[0], cellColors: { material: "BLUE" } }, { material: filter })).toBe(false);
    expect(matchesSelectionFilters(rows[2], { material: filter })).toBe(false);
  });
});

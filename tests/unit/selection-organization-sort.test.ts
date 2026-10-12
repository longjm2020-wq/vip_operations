import { describe, expect, it } from "vitest";
import { selectionOrganizationSortConfiguration, selectionOrganizationSortOptions } from "../../apps/web/src/selection-organization-sort.js";

const creation = { key: "custom:creation", label: "创建时间", type: "createdTime" };
const columns = [
  { key: "registrationBatch", label: "创建时间", type: "createdTime" },
  creation,
  { key: "custom:alias", label: "建档时刻", fallbackType: "createdTime" },
  { key: "custom:date", label: "采购日期", type: "date" },
  { key: "custom:text", label: "备注", type: "text" },
];

describe("creation-time organization menu", () => {
  it("preserves merged creation-time configuration while changing other checkboxes", () => {
    const previous = [creation.key, "custom:alias", "custom:date"];
    expect(selectionOrganizationSortConfiguration(columns, ["custom:text"], previous))
      .toEqual(["custom:text", creation.key, "custom:alias"]);
    expect(previous).toEqual([creation.key, "custom:alias", "custom:date"]);
  });
  it("provides one ascending and one descending choice for all system creation-time columns", () => {
    const configured = ["registrationBatch", creation.key, "custom:alias", "custom:date"];
    const options = selectionOrganizationSortOptions(columns, configured, "sortOrder:asc");
    expect(options.filter(option => option.label === "创建时间 ↑")).toEqual([{ value: "registrationBatch:asc", label: "创建时间 ↑" }]);
    expect(options.filter(option => option.label === "创建时间 ↓")).toEqual([{ value: "registrationBatch:desc", label: "创建时间 ↓" }]);
    expect(options.some(option => option.value.startsWith("field:custom:creation:"))).toBe(false);
    expect(options.some(option => option.value.startsWith("field:custom:alias:"))).toBe(false);
    expect(configured).toEqual(["registrationBatch", creation.key, "custom:alias", "custom:date"]);
  });

  it.each(["asc", "desc"])("retains a saved custom creation-time %s sort and its direction-switch target", direction => {
    const current = `field:${creation.key}:${direction}`;
    const options = selectionOrganizationSortOptions(columns, [creation.key], current);
    expect(options.filter(option => option.label.startsWith("创建时间 "))).toEqual([
      { value: `field:${creation.key}:asc`, label: "创建时间 ↑" },
      { value: `field:${creation.key}:desc`, label: "创建时间 ↓" },
    ]);
    expect(options.filter(option => option.value === current)).toHaveLength(1);
    expect(options.some(option => option.value.startsWith("registrationBatch:"))).toBe(false);
  });

  it("retains header-selected creation-time sorts even when the field was never configured", () => {
    expect(selectionOrganizationSortOptions(columns, [], "field:custom:alias:desc")).toContainEqual({ value: "field:custom:alias:desc", label: "创建时间 ↓" });
    expect(selectionOrganizationSortOptions(columns, [], "field:registrationBatch:asc")).toContainEqual({ value: "field:registrationBatch:asc", label: "创建时间 ↑" });
  });

  it("keeps real date and text fields, including a date named creation time, as independent sorts", () => {
    const date = { key: "custom:independent", label: "创建时间", type: "date", fallbackType: "createdTime" };
    const options = selectionOrganizationSortOptions([...columns, date], ["custom:date", "custom:text", date.key], `field:${date.key}:desc`);
    for (const [key, label] of [["custom:date", "采购日期"], ["custom:text", "备注"], [date.key, "创建时间"]])
      for (const [direction, symbol] of [["asc", "↑"], ["desc", "↓"]])
        expect(options).toContainEqual({ value: `field:${key}:${direction}`, label: `${label} ${symbol}` });
    expect(options).toContainEqual({ value: "registrationBatch:asc", label: "创建时间 ↑" });
  });

  it("keeps unrelated active sorts and filters duplicate configuration keys and images", () => {
    const options = selectionOrganizationSortOptions([
      ...columns,
      { key: "custom:image", label: "参考图", type: "image" },
    ], ["custom:date", "custom:date", "custom:image", "images", "missing"], "field:custom:text:desc");
    expect(options.filter(option => option.value === "field:custom:date:asc")).toHaveLength(1);
    expect(options.some(option => option.value.includes("image"))).toBe(false);
    expect(options).toContainEqual({ value: "field:custom:text:desc", label: "备注 ↓" });
  });
});

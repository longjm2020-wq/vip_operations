import { expect, it } from "vitest";
import { choiceClipboardText, choiceDisplayText } from "../../apps/web/src/selection-choice-display.js";
import { joinChoiceValues, splitChoiceValues } from "../../apps/web/src/selection-field-types.js";
import { selectionFilterOptions, matchesSelectionFilters, searchSelectionFilterOptions } from "../../apps/web/src/selection-filters.js";
import { createVisibleSelectionWorkbook } from "../../apps/web/src/selection-visible-workbook.js";
import type { SelectionField } from "../../apps/web/src/selection-field-types.js";

const options = ["女士皮衣/皮草", "女士睡衣/家居服", "A", "B", "A/B"];
const field: SelectionField = { key: "custom:category", custom: true, label: "三级类目", width: 120, type: "multiple", options };

it("renders and exports the complete labels without the transport marker and copies a readable list", async () => {
  const values = options.slice(0, 2), value = joinChoiceValues(values);
  expect(choiceDisplayText(field, value)).toBe(values.join("；"));
  expect(choiceClipboardText(field, value)).toBe(JSON.stringify(values));
  expect(splitChoiceValues(field, choiceClipboardText(field, value))).toEqual(values);
  const book = await createVisibleSelectionWorkbook([{ id: "1", extraFields: { [field.key]: value } }], [field]);
  expect(book.getWorksheet("表格资料")!.getCell("A2").text).toBe(values.join("；"));
  expect(choiceDisplayText({ ...field, type: "single" }, options[0])).toBe(options[0]);
});

it("keeps distinct stored selections distinct in filter counts, and searches readable names", () => {
  const literal = joinChoiceValues(["A/B"]), legacy = "A/B";
  const records = [literal, legacy].map((value, index) => ({ id: index, extraFields: { [field.key]: value }, selectionChoiceTexts: { [field.key]: choiceDisplayText(field, value) } }));
  const items = selectionFilterOptions(records, field.key);
  expect(items).toHaveLength(2);
  expect(items.every(item => item.count === 1)).toBe(true);
  expect(items.find(item => item.value === literal)?.label).toBe("A/B");
  expect(searchSelectionFilterOptions(items, "choices")).toEqual([]);
  expect(searchSelectionFilterOptions(items, "A/B")).toHaveLength(2);
  const filters = { [field.key]: { mode: "contains" as const, value: "", values: [literal] } };
  expect(records.filter(row => matchesSelectionFilters(row, filters)).map(row => row.id)).toEqual([0]);
  expect(matchesSelectionFilters(records[0], { [field.key]: { mode: "contains", value: "choices" } })).toBe(false);
});

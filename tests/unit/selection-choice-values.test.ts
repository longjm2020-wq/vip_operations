import { describe, expect, it } from "vitest";
import type { SelectionField } from "../../packages/contracts/src/selection-layout.js";
import { fieldValueError, joinChoiceValues, splitChoiceValues, splitFieldTags, supportsSlashChoices, isEncodedChoiceValue } from "../../packages/contracts/src/selection-field-validation.js";

const categories = ["女士皮衣/皮草", "女士睡衣/家居服", "女士外套"];
const field = (options = categories): SelectionField => ({ key: "custom:category", label: "三级类目", width: 120, custom: true, type: "multiple", options });

describe("choice values containing a literal slash", () => {
  it("keeps ordinary saved values compatible and deduplicates selected labels", () => {
    expect(joinChoiceValues([" A ", "B", "A", ""])).toBe("A/B");
    expect(splitChoiceValues(field(["A", "B"]), "A/B")).toEqual(["A", "B"]);
    expect(joinChoiceValues([])).toBe("");
    expect(splitChoiceValues(field(), "")).toEqual([]);
  });

  it("round trips both slash categories together without splitting their names", () => {
    const saved = joinChoiceValues(categories);
    expect(saved).not.toBe(categories.join("/"));
    expect(isEncodedChoiceValue(saved)).toBe(true);
    expect(splitChoiceValues(field(), saved)).toEqual(categories);
    expect(fieldValueError(field(), saved)).toBeNull();
    expect(fieldValueError({ ...field(), type: "single" }, categories[0])).toBeNull();
  });

  it("preserves an old A/B selection when the literal A/B option is added later", () => {
    const choices = field(["A", "B", "A/B"]);
    expect(splitChoiceValues(choices, "A/B")).toEqual(["A", "B"]);
    expect(splitChoiceValues(choices, joinChoiceValues(["A/B"]))).toEqual(["A/B"]);
    expect(splitChoiceValues(field(["A/B"]), "A/B")).toEqual(["A/B"]);
  });

  it("accepts readable JSON clipboard lists only for configured labels and preserves a literal JSON option", () => {
    expect(splitChoiceValues(field(), JSON.stringify(categories))).toEqual(categories);
    expect(fieldValueError(field(), JSON.stringify(categories))).toBeNull();
    expect(fieldValueError(field(), JSON.stringify([categories[0], "未知类别"]))).not.toBeNull();
    const literal = field(['["A"]', "A"]);
    expect(splitChoiceValues(literal, '["A"]')).toEqual(['["A"]']);
    expect(splitChoiceValues(literal, '["[\\\"A\\\"]","A"]')).toEqual(['["A"]', "A"]);
  });

  it("distinguishes encoded values from valid legacy labels that resemble the version marker", () => {
    const legacy = field(["@choices", 'v1:["A"]']);
    const saved = joinChoiceValues(legacy.options!);
    expect(saved).toBe('@choices/v1:["A"]');
    expect(isEncodedChoiceValue(saved)).toBe(false);
    expect(splitChoiceValues(legacy, saved)).toEqual(legacy.options);
    const nested = field(['@choices//v1:["A"]', "__proto__"]);
    expect(splitChoiceValues(nested, joinChoiceValues(nested.options!))).toEqual(nested.options);
  });

  it("rejects malformed or unconfigured encoded contents instead of accepting transport text as choices", () => {
    const saved = joinChoiceValues([categories[0]]);
    const marker = saved.slice(0, saved.indexOf("["));
    for (const payload of ["not-json", "null", '[42]', '[""]', "[]", '["不存在/类别"]'])
      expect(fieldValueError(field(), marker + payload)).not.toBeNull();
    expect(fieldValueError(field(), "/")).not.toBeNull();
    expect(fieldValueError(field(), "不存在/类别")).not.toBeNull();
  });

  it("supports fallback multiple fields and leaves ordinary custom tags slash separated", () => {
    expect(fieldValueError({ ...field(), type: undefined, fallbackType: "multiple" }, joinChoiceValues(categories))).toBeNull();
    expect(splitFieldTags("红色/蓝色")).toEqual(["红色", "蓝色"]);
    expect(fieldValueError({ ...field(), type: "tags", options: ["红色", "蓝色"], tagConfig: { allowCustom: false, multiple: true, max: 30, order: "selection", color: "orange" } }, "红色/蓝色")).toBeNull();
  });

  it("restricts literal slash choices to standalone custom fields to protect business normalization", () => {
    expect(supportsSlashChoices(field())).toBe(true);
    for (const constrained of [
      { ...field(), key: "color", custom: false },
      { ...field(), key: "sizeRange", custom: false },
      { ...field(), key: "custom:product:3" },
      { ...field(), custom: undefined },
    ]) {
      expect(supportsSlashChoices(constrained)).toBe(false);
      expect(fieldValueError(constrained, joinChoiceValues([categories[0]]))).not.toBeNull();
      expect(fieldValueError({ ...constrained, type: "single" }, categories[0])).not.toBeNull();
    }
    expect(fieldValueError({ ...field(["红色", "蓝色"]), key: "color", custom: false }, "红色/蓝色")).toBeNull();
    const color = { ...field(["红色", "蓝色"]), key: "color", custom: false };
    const marker = joinChoiceValues([categories[0]]).split("[")[0];
    expect(fieldValueError(color, marker + '["红色","蓝色"]')).not.toBeNull();
    expect(fieldValueError(color, '["红色","蓝色"]')).not.toBeNull();
  });
});

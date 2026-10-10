import { describe, expect, it } from "vitest";
import type { SelectionField } from "../../packages/contracts/src/selection-layout.js";
import { joinChoiceValues, splitChoiceValues, fieldValueError } from "../../packages/contracts/src/selection-field-validation.js";
import { migrateChoiceValue } from "../../apps/api/src/modules/style-selections/migration-choice-values.js";

const categories = ["女士皮衣/皮草", "女士睡衣/家居服", "女士外套"];
const source: SelectionField = { key: "custom:source", label: "原三级类目", width: 120, custom: true, type: "multiple", options: categories };
const target = (type: SelectionField["type"] = "multiple"): SelectionField => ({ ...source, key: "custom:target", label: "目标三级类目", type });

describe("choice values during cross-table transfer", () => {
  it("transfers encoded multiple choices as intact labels and produces a valid target value", () => {
    const converted = migrateChoiceValue(source, target(), joinChoiceValues(categories));
    expect(converted.issue).toBeNull();
    expect(splitChoiceValues(target(), converted.value)).toEqual(categories);
    expect(fieldValueError(target(), converted.value)).toBeNull();
  });

  it("wraps single slash labels as multiple choices and unwraps a single selected label", () => {
    const singleSource = { ...source, type: "single" as const };
    const converted = migrateChoiceValue(singleSource, target(), categories[0]);
    expect(converted.issue).toBeNull();
    expect(splitChoiceValues(target(), converted.value)).toEqual([categories[0]]);
    expect(migrateChoiceValue(source, target("single"), converted.value)).toEqual({ value: categories[0], issue: null });
  });

  it("does not expose the transport prefix when transferred into text or other scalar fields", () => {
    expect(migrateChoiceValue(source, target("text"), joinChoiceValues(categories))).toEqual({ value: categories.join(" / "), issue: null });
    const url = "https://example.com/catalog";
    const linkSource = { ...source, options: [url] };
    const link = migrateChoiceValue(linkSource, target("link"), joinChoiceValues([url]));
    expect(link).toEqual({ value: url, issue: null });
    expect(fieldValueError(target("link"), link.value)).toBeNull();
  });

  it("rejects multiple selected labels sent to single even when joined text is another literal option", () => {
    const from = { ...source, options: ["A", "B", "A/B"] };
    expect(migrateChoiceValue(from, { ...target("single"), options: ["A/B"] }, "A/B").issue).not.toBeNull();
    expect(migrateChoiceValue(from, { ...target("single"), options: ["A/B"] }, joinChoiceValues(["A/B"]))).toEqual({ value: "A/B", issue: null });
  });

  it("rejects slash labels for tags and business fields instead of corrupting color, size or product bindings", () => {
    const saved = joinChoiceValues([categories[0]]);
    for (const to of [
      target("tags"),
      { ...target(), key: "color", custom: false },
      { ...target("text"), key: "sizeRange", custom: false },
      { ...target("single"), key: "custom:product:8" },
    ]) expect(migrateChoiceValue(source, to, saved).issue).not.toBeNull();
  });

  it("retains ordinary slash-delimited tags and blank values in compatible transfers", () => {
    const tags = { ...source, type: "tags" as const, options: ["红色", "蓝色"] };
    const choices = { ...target(), options: tags.options };
    expect(migrateChoiceValue(tags, choices, "红色/蓝色")).toEqual({ value: "红色/蓝色", issue: null });
    expect(migrateChoiceValue(choices, { ...target("tags"), options: tags.options }, "红色/蓝色")).toEqual({ value: "红色/蓝色", issue: null });
    expect(migrateChoiceValue(source, target(), "")).toEqual({ value: "", issue: null });
  });
});

import { describe, expect, it } from "vitest";
import { standardImageColors, standardColorImageCleanup, keepStandardColorImages } from "../../apps/web/src/selection-image-color-cleanup-plan.js";
import type { SelectionField } from "../../packages/contracts/src/selection-layout.js";

const field: SelectionField = { key: "custom:standard", label: "标准颜色", type: "multiple", custom: true, width: 120, options: ["咖色", "白色", "米白/金色"] };
const basis = { fieldKey: field.key, colors: ["白色", "咖色"] };
const image = (id: string, color: string, colorFieldKey?: string) => ({ id, color, colorFieldKey, url: `https://photos.test/${id}.jpg` });

describe("explicit standard colour photo cleanup", () => {
  it("uses selected values with intact slash choices, never all configured options", () => {
    expect(standardImageColors([field], () => true, () => '["咖色","米白/金色"]')).toEqual({ fieldKey: field.key, colors: ["咖色", "米白/金色"] });
    expect(standardImageColors([field], () => true, () => "")).toBeUndefined();
  });

  it("does not resolve ambiguous, hidden, deleted or unsupported standard fields", () => {
    expect(standardImageColors([field, { ...field, key: "custom:other" }], () => true, () => "白色")).toBeUndefined();
    expect(standardImageColors([field], () => false, () => { throw Error("private field must not be read"); })).toBeUndefined();
    expect(standardImageColors([{ ...field, deleted: true }], () => true, () => "白色")).toBeUndefined();
    expect(standardImageColors([{ ...field, type: "image" }], () => true, () => "白色")).toBeUndefined();
  });

  it("reduces four photos to one chosen photograph per standard colour without altering annotations or original order", () => {
    const images = [image("a", "咖色"), image("b", "咖色", field.key), image("c", "白色", field.key), image("d", "白色", field.key)];
    const plan = standardColorImageCleanup(images, basis);
    expect(plan).toMatchObject({ keepCount: 2, removeCount: 2, unmatchedCount: 0 });
    expect(keepStandardColorImages(images, basis, { 咖色: "b", 白色: "c" })).toEqual([images[1], images[2]]);
    expect(images).toHaveLength(4);
  });

  it("keeps unmatched, unnamed, hidden and differently linked photographs and does not truncate to colour count", () => {
    const preserved = [image("other", "红色"), image("unnamed", ""), image("hidden", "白色", "protected"), image("linked", "白色", "custom:other")];
    const images = [image("a", "白色"), ...preserved, image("b", "白色")];
    expect(standardColorImageCleanup(images, basis)).toMatchObject({ keepCount: 5, removeCount: 1, unmatchedCount: 4 });
    expect(keepStandardColorImages(images, basis, { 白色: "b" })).toEqual([...preserved, images[5]]);
    expect(standardColorImageCleanup(images)).toMatchObject({ keepCount: 6, removeCount: 0, unmatchedCount: 6 });
  });

  it("retains different colour labels for the same photograph and never invents missing colour images", () => {
    const images = [{ ...image("a", "白色"), url: "same.jpg" }, { ...image("b", "咖色"), url: "same.jpg" }];
    expect(standardColorImageCleanup(images, { ...basis, colors: [...basis.colors, "绿色"] })).toMatchObject({ keepCount: 2, removeCount: 0 });
    expect(keepStandardColorImages(images, basis, {})).toEqual(images);
  });

  it("requires a valid choice for every duplicate colour", () => {
    const images = [image("a", "白色"), image("b", "白色"), image("c", "咖色"), image("d", "咖色")];
    expect(() => keepStandardColorImages(images, basis, { 白色: "c", 咖色: "d" })).toThrow("白色");
    expect(() => keepStandardColorImages(images, basis, { 白色: "a" })).toThrow("咖色");
  });
});

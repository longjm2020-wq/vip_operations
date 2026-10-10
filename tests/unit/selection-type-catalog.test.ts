import { expect, it } from "vitest";
import { applyFieldType, availableFieldTypes, fieldTypeKey, fieldTypeLabel, namedTypeError, parseFieldTypeCatalog, type FieldTypeCatalog } from "../../apps/web/src/selection-type-catalog.js";
import { fieldValueError, type SelectionField } from "../../apps/web/src/selection-field-types.js";

const catalog: FieldTypeCatalog = { disabled: ["text"], custom: [{ key: "preset:quality", name: "质检结果", baseType: "single", enabled: true, options: ["规范", "不规范"] }] };
const field: SelectionField = { key: "custom:quality", label: "面料核对", width: 120, custom: true };

it("disabling a type hides new choices while retaining the existing field and its validation", () => {
  expect(availableFieldTypes(field, catalog).map(choice => choice.value)).not.toContain("text");
  const existing = { ...field, type: "text" as const };
  expect(availableFieldTypes(existing, catalog)).toContainEqual({ value: "text", label: "文本（已停用）", disabled: true });
  expect(applyFieldType(field, "text", catalog)).toBe(field);
  const configured = applyFieldType(field, "preset:quality", catalog);
  const disabled = { ...catalog, custom: catalog.custom.map(type => ({ ...type, enabled: false })) };
  expect(availableFieldTypes(configured, disabled)).toContainEqual({ value: "preset:quality", label: "质检结果（已停用）", disabled: true });
  expect(fieldValueError(configured, "规范")).toBeNull();
  expect(fieldValueError(configured, "不存在")).not.toBeNull();
});

it("named types copy defaults into individual fields and respect business storage compatibility", () => {
  const configured = applyFieldType(field, "preset:quality", catalog);
  expect(configured.type).toBe("single");
  expect(fieldTypeKey(configured, catalog)).toBe("preset:quality");
  expect(fieldTypeLabel(configured, catalog)).toBe("质检结果");
  configured.options!.push("待核对");
  expect(catalog.custom[0].options).toEqual(["规范", "不规范"]);
  const image = { key: "images", label: "图片", width: 120 };
  expect(availableFieldTypes(image, catalog).map(choice => choice.value)).toEqual(["image"]);
  expect(applyFieldType(image, "preset:quality", catalog)).toBe(image);
  expect(applyFieldType(configured, "number", catalog).typePreset).toBeUndefined();
  expect(fieldTypeLabel(configured, { disabled: [], custom: [] })).toBe("单选");
});

it("invalid local catalog data and duplicate names cannot break opening or create ambiguous types", () => {
  expect(parseFieldTypeCatalog("not-json")).toEqual({ disabled: [], custom: [] });
  expect(namedTypeError(" 文本 ", "single", ["是"], catalog)).toBe("类型名称已存在");
  expect(namedTypeError("质检结果", "single", ["是"], catalog)).toBe("类型名称已存在");
  expect(namedTypeError("新类型", "single", [], catalog)).not.toBeNull();
  expect(namedTypeError("新类型", "multiple", ["是/否"], catalog)).toBeNull();
  expect(namedTypeError("新类型", "single", ["女士皮衣/皮草"], catalog)).toBeNull();
  expect(namedTypeError("新类型", "tags", ["是/否"], catalog)).not.toBeNull();
  const parsed = parseFieldTypeCatalog(JSON.stringify({ disabled: ["text", "unknown", "text"], custom: [catalog.custom[0], catalog.custom[0], { key: "preset:bad", name: "错误", baseType: "arbitrary" }] }));
  expect(parsed.disabled).toEqual(["text"]);
  expect(parsed.custom).toEqual(catalog.custom);
});

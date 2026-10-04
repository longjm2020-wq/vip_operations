import { allowedFieldTypes, fieldTypes, type FieldType, type SelectionField } from "./selection-field-types.js";

export type NamedFieldType = { key: string; name: string; baseType: FieldType; enabled: boolean; options: string[] };
export type FieldTypeCatalog = { disabled: FieldType[]; custom: NamedFieldType[] };
const isType = (value: unknown): value is FieldType => typeof value === "string" && Object.hasOwn(fieldTypes, value);
export const typeOptions = (text: string) => [...new Set(text.split("\n").map(value => value.trim()).filter(Boolean))];

export function namedTypeError(name: string, baseType: FieldType, options: string[], catalog: FieldTypeCatalog): string | null {
  if (!name.trim() || name.trim().length > 40) return "类型名称须为1至40字";
  if ((Object.values(fieldTypes) as string[]).includes(name.trim()) || catalog.custom.some(type => type.name === name.trim())) return "类型名称已存在";
  if (!isType(baseType)) return "请选择基础类型";
  if (["single", "multiple"].includes(baseType) && !options.length) return "请填写候选选项，每行一个";
  if (options.length > 100 || options.some(value => value.includes("/") || value.length > 80)) return "候选选项最多100项，每项最多80字且不能含 /";
  return null;
}

export function parseFieldTypeCatalog(raw: string | null): FieldTypeCatalog {
  const catalog: FieldTypeCatalog = { disabled: [], custom: [] };
  try {
    const parsed = JSON.parse(raw || "{}");
    if (Array.isArray(parsed?.disabled)) catalog.disabled = [...new Set(parsed.disabled.filter(isType))] as FieldType[];
    if (Array.isArray(parsed?.custom)) for (const item of parsed.custom) {
      if (!item || typeof item.key !== "string" || !item.key.startsWith("preset:") || typeof item.name !== "string" || !isType(item.baseType) || catalog.custom.some(type => type.key === item.key)) continue;
      const options = Array.isArray(item.options) ? typeOptions(item.options.filter((value: unknown) => typeof value === "string").join("\n")) : [];
      if (namedTypeError(item.name, item.baseType, options, catalog)) continue;
      catalog.custom.push({ key: item.key, name: item.name.trim(), baseType: item.baseType, enabled: item.enabled !== false, options });
    }
  } catch { /* An invalid local preference must not prevent opening the table. */ }
  return catalog;
}

export function fieldTypeKey(field: SelectionField, catalog: FieldTypeCatalog): string | undefined {
  return catalog.custom.some(type => type.key === field.typePreset && type.baseType === field.type) ? field.typePreset : field.type;
}

export function fieldTypeLabel(field: SelectionField, catalog: FieldTypeCatalog): string {
  return catalog.custom.find(type => type.key === field.typePreset && type.baseType === field.type)?.name || (field.type ? fieldTypes[field.type] : "未设置");
}

export function availableFieldTypes(field: SelectionField, catalog: FieldTypeCatalog) {
  const allowed = allowedFieldTypes(field);
  const choices: { value: string; label: string; disabled?: boolean }[] = [
    ...allowed.filter(type => !catalog.disabled.includes(type)).map(type => ({ value: type, label: fieldTypes[type] })),
    ...catalog.custom.filter(type => type.enabled && allowed.includes(type.baseType)).map(type => ({ value: type.key, label: type.name })),
  ];
  const current = fieldTypeKey(field, catalog);
  // A disabled type remains identifiable in existing fields, without becoming
  // selectable for another field or changing the stored cell values.
  if (current && !choices.some(choice => choice.value === current)) choices.push({ value: current, label: `${fieldTypeLabel(field, catalog)}（已停用）`, disabled: true });
  return choices;
}

export function applyFieldType(field: SelectionField, key: string, catalog: FieldTypeCatalog): SelectionField {
  const preset = catalog.custom.find(type => type.key === key && type.enabled);
  const baseType = preset?.baseType || key;
  if (!isType(baseType) || !allowedFieldTypes(field).includes(baseType) || (!preset && catalog.disabled.includes(baseType))) return field;
  const { typePreset: _oldPreset, ...rest } = field;
  return { ...rest, type: baseType, ...(preset ? { typePreset: preset.key, ...(["single", "multiple", "tags"].includes(baseType) ? { options: [...preset.options] } : {}) } : {}) };
}

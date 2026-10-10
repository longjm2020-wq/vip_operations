import type { SelectionField } from "./selection-layout.js";

export const defaultTagConfig = {
  allowCustom: true,
  multiple: true,
  max: 30,
  order: "selection" as const,
  color: "orange",
};
export function splitFieldTags(value: unknown): string[] {
  return [
    ...new Set(
      String(value ?? "")
        .split("/")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

// A valid legacy value joins nonempty, slash-free labels with one slash, so
// it can never contain the double slash in this version marker.
const choiceValuePrefix = "@choices//v1:";
export const isEncodedChoiceValue = (raw: unknown) =>
  String(raw ?? "").trim().startsWith(choiceValuePrefix);
const uniqueChoiceValues = (values: readonly string[]) =>
  [...new Set(values.map(value => value.trim()).filter(Boolean))];

export const supportsSlashChoices = (field: Pick<SelectionField, "key" | "custom">) =>
  !!field.custom && field.key.startsWith("custom:") && !field.key.startsWith("custom:product:");

export function joinChoiceValues(values: readonly string[]): string {
  const choices = uniqueChoiceValues(values);
  return choices.some(value => value.includes("/"))
    ? choiceValuePrefix + JSON.stringify(choices)
    : choices.join("/");
}

export function splitChoiceValues(field: Pick<SelectionField, "options"> & Partial<Pick<SelectionField, "key" | "custom">>, raw: unknown): string[] {
  const value = String(raw ?? "").trim();
  if (!value) return [];
  if (isEncodedChoiceValue(value)) {
    try {
      const parsed: unknown = JSON.parse(value.slice(choiceValuePrefix.length));
      if (Array.isArray(parsed) && parsed.every(item => typeof item === "string" && item.trim()))
        return uniqueChoiceValues(parsed);
    } catch { /* Invalid encoded input is validated as ordinary pasted text. */ }
  }
  const legacy = splitFieldTags(value);
  // Preserve existing A/B selections even if a new literal A/B label is later
  // configured. A newly selected literal label is encoded by joinChoiceValues.
  if (legacy.every(item => field.options?.includes(item))) return legacy;
  if (field.options?.includes(value)) return [value];
  // Clipboard text can use a readable JSON label list without the transport
  // marker. Exact configured names and valid old selections retain priority.
  try {
    const parsed: unknown = JSON.parse(value);
    if (supportsSlashChoices({ key: field.key || "", custom: field.custom }) &&
      Array.isArray(parsed) && parsed.length &&
      parsed.every(item => typeof item === "string" && item.trim() && field.options?.includes(item.trim())))
      return uniqueChoiceValues(parsed);
  } catch { /* Ordinary labels need not be JSON. */ }
  return legacy;
}
export function fieldValueError(
  field: SelectionField,
  raw: unknown,
): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const type = field.type || field.fallbackType || "text";
  if (type === "image") {
    try {
      const images = JSON.parse(value);
      if (
        !Array.isArray(images) ||
        images.length > (field.imageConfig?.max || 30) ||
        images.some(
          (item) =>
            !item ||
            typeof item.url !== "string" ||
            !/^(https?:\/\/|\/api\/)/.test(item.url),
        )
      )
        return "图片数据无效或超过数量上限";
      return null;
    } catch {
      return "图片数据无效";
    }
  }
  if (value.length > 2000) return "内容最多2000字";
  if (
    ["number", "currency", "percent"].includes(type) &&
    (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ||
      !Number.isFinite(Number(value)))
  )
    return "请输入有效数字";
  if (type === "currency" && !/^[+-]?\d+(?:\.\d{1,2})?$/.test(value))
    return "货币最多两位小数";
  if (
    type === "date" &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value)
  )
    return "请输入有效日期 YYYY-MM-DD";
  if (type === "checkbox" && !["true", "false"].includes(value))
    return "复选框值应为 true 或 false";
  if (type === "link") {
    try {
      if (!["https:", "http:"].includes(new URL(value).protocol))
        return "仅支持 http(s) 链接";
    } catch {
      return "请输入完整 http(s) 链接";
    }
  }
  if (type === "tags") {
    const tags = splitFieldTags(value),
      config = { ...defaultTagConfig, ...field.tagConfig };
    if (tags.some((tag) => tag.length > 80)) return "单个标签最多80字";
    if (tags.length > (config.multiple ? config.max : 1))
      return "标签数量超过字段设置上限";
    if (
      !config.allowCustom &&
      tags.some((tag) => !field.options?.includes(tag))
    )
      return "只能选择候选标签";
  }
  if (type === "single" && value.includes("/") && !supportsSlashChoices(field))
    return "此业务字段的选项不能含 /，请使用自建单选或多选字段";
  if (type === "single" && !field.options?.includes(value))
    return "请选择已配置的选项";
  if (type === "multiple") {
    const values = splitChoiceValues(field, value);
    if (!supportsSlashChoices(field) && isEncodedChoiceValue(value))
      return "此业务字段的多选值须使用 / 分隔，请使用自建单选或多选字段";
    if (!values.length || values.some(item => !field.options?.includes(item)))
      return "多选值须来自已配置选项";
    if (!supportsSlashChoices(field) && values.some(item => item.includes("/")))
      return "此业务字段的选项不能含 /，请使用自建单选或多选字段";
  }
  return null;
}

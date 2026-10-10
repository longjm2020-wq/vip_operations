import type { SelectionField } from "../../../../../packages/contracts/src/selection-layout.js";
import { joinChoiceValues, splitChoiceValues, splitFieldTags, supportsSlashChoices } from "../../../../../packages/contracts/src/selection-field-validation.js";

/** Convert selected labels, never their transport representation, to a target field. */
export function migrateChoiceValue(from: SelectionField, to: SelectionField, raw: unknown): { value: string; issue: string | null } {
  const type = from.type || from.fallbackType || "text";
  const targetType = to.type || to.fallbackType || "text";
  const value = String(raw ?? "").trim();
  const values = type === "multiple" ? splitChoiceValues(from, value)
    : type === "tags" ? splitFieldTags(value) : value ? [value] : [];
  if (values.some(item => item.includes("/")) &&
    (targetType === "tags" ||
      (["single", "multiple"].includes(targetType) && !supportsSlashChoices(to)) ||
      (!to.custom && ["color", "sizeRange"].includes(to.key))))
    return { value, issue: "目标字段使用 / 分隔标签，不能接收名称含 / 的选项" };
  if (targetType === "single" && values.length > 1)
    return { value, issue: "多个已选选项不能传入单选字段" };
  return {
    value: targetType === "multiple" ? joinChoiceValues(values)
      : targetType === "tags" ? values.join("/")
      : values.join(" / "),
    issue: null,
  };
}

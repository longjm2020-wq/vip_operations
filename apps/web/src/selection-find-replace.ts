import { fieldValueError, joinChoiceValues, splitChoiceValues, type SelectionField } from "./selection-field-types.js";
import { tableReplaceText, type TableFindOptions } from "./table-find-replace-data.js";

/** Replace readable labels, preserving the encoded transport for slash-bearing choices. */
export function selectionReplacementValue(field: SelectionField, raw: unknown, options: TableFindOptions): string {
  if ((field.type || field.fallbackType) === "multiple" && options.wholeCell) {
    // A complete configured label (including / or ；) takes priority over delimiters.
    if (field.options?.includes(options.replacement.trim())) return joinChoiceValues([options.replacement]);
    const choices = splitChoiceValues(field, options.replacement);
    if (choices.every(choice => field.options?.includes(choice))) return joinChoiceValues(choices);
    const readable = options.replacement.split(/[;；]/).map(choice => choice.trim()).filter(Boolean);
    return readable.length && readable.every(choice => field.options?.includes(choice)) ? joinChoiceValues(readable) : options.replacement;
  }
  if ((field.type || field.fallbackType) === "multiple") {
    const choices = splitChoiceValues(field, raw);
    const next = choices.map(choice => tableReplaceText(choice, options));
    if (choices.every((choice, index) => choice === next[index])) throw Error("多选字段不能跨标签边界替换，请查找完整标签或标签内文字");
    return joinChoiceValues(next);
  }
  return tableReplaceText(String(raw ?? ""), options);
}

/** Same native row limits as persistence, plus archive bridge constraints. */
export function selectionReplacementError(field: SelectionField, value: string, archive: boolean): string | null {
  const issue = fieldValueError(field, value);
  if (issue) return issue;
  const trimmed = value.trim(), key = field.key;
  const limits: Record<string, number> = { xutiStyleNo: 64, supplierStyleNo: 64, supplierCode: 50, color: 100, sizeRange: 100, material: 2000 };
  if (key === "xutiStyleNo" && !trimmed) return "序缇款号不能为空";
  if (limits[key] && trimmed.length > limits[key]) return `最多${limits[key]}个字符`;
  if (["supplyPriceExclTax", "vipPrice", "livePrice", "tagPrice"].includes(key) && trimmed && !/^\d{1,10}(\.\d{1,2})?$/.test(trimmed)) return "金额须为非负数，整数最多10位、小数最多两位";
  if (archive && key.startsWith("custom:product:")) {
    const name = key.slice("custom:product:".length);
    if (name === "name" && (!trimmed || trimmed.length > 255)) return "商品名称必填，最多255个字符";
    if ((name === "season" || name === "remark") && value.length > (name === "season" ? 32 : 1000)) return `最多${name === "season" ? 32 : 1000}个字符`;
    if (name === "year" && trimmed && (!/^\d+$/.test(trimmed) || Number(trimmed) < 1900 || Number(trimmed) > 2200)) return "年份应为1900至2200的整数";
    if (name === "status" && !["ACTIVE", "STOPPED", "ARCHIVED"].includes(trimmed)) return "请选择在用、停用或归档";
    if ((field.type || field.fallbackType) === "number" && trimmed && Math.abs(Number(trimmed)) > 1e12) return "数值超出商品字段允许范围";
  }
  return null;
}

import type { SelectionField } from "../../../packages/contracts/src/selection-layout";
import { fieldTextCount, fieldTextLengthError } from "../../../packages/contracts/src/selection-field-validation";

/** The same normalized count as the API, without clipping a text draft or IME. */
export function SelectionTextLengthStatus({ field, value }: { field: SelectionField; value: unknown }) {
  if (!field.textConfig || (field.type || field.fallbackType || "text") !== "text") return null;
  const issue = fieldTextLengthError(field, value);
  return <span className={`selection-text-length${issue ? " is-error" : ""}`} role="status" title={issue || undefined}>
    {field.textConfig.countMode === "han" ? "汉字" : "字符"} {fieldTextCount(field, value)} / {field.textConfig.maxLength}{issue ? " · 超出上限" : ""}
  </span>;
}

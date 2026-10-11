import type { SelectionField } from "./selection-layout.js";
import { splitChoiceValues, splitFieldTags } from "./selection-field-validation.js";

/** Missing linkage is the legacy supplier-color association. Import resolves
 * the `standard` marker to the real registered field key before saving.
 * Reads use `protected` when the linked field cannot be disclosed. */
export type SelectionImageColorLink = { colorFieldKey?: string };
export const selectionImageColorFieldTypes = new Set(["text", "tags", "single", "multiple"]);

export function selectionImageColorValues(field: Pick<SelectionField, "key" | "custom" | "type" | "fallbackType" | "options"> | undefined, raw: unknown): string[] {
  const type = field?.type || field?.fallbackType || "text";
  if (type === "single") return String(raw ?? "").trim() ? [String(raw).trim()] : [];
  if (type === "multiple" && field) return splitChoiceValues(field, raw);
  return splitFieldTags(raw);
}

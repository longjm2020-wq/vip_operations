import { splitChoiceValues } from "./selection-field-types.js";
import type { SelectionField } from "./selection-field-types.js";

export function choiceDisplayText(field: SelectionField, value: unknown): string {
  if ((field.type || field.fallbackType) !== "multiple") return String(value ?? "");
  const choices = splitChoiceValues(field, value);
  return choices.join(choices.some(choice => choice.includes("/")) ? "；" : "/");
}

/** Readable, unambiguous clipboard text for slash-bearing labels. */
export function choiceClipboardText(field: SelectionField, value: unknown): string {
  if ((field.type || field.fallbackType) !== "multiple") return String(value ?? "");
  const choices = splitChoiceValues(field, value);
  return choices.some(choice => choice.includes("/")) ? JSON.stringify(choices) : choices.join("/");
}

import { projectSelectionSharedLayout, type SelectionLayout } from "../../../packages/contracts/src/selection-layout.js";

/** A first business text rule needs one shared authority even before a layout exists. */
export function initialTextLimitColumns(preferences: SelectionLayout, baseline: SelectionLayout | null) {
  const previous = new Map((baseline?.columns || []).map(field => [field.key, field]));
  const changed = preferences.columns.some(field =>
    (!field.custom || field.key.startsWith("custom:product:")) &&
    JSON.stringify(field.textConfig) !== JSON.stringify(previous.get(field.key)?.textConfig),
  );
  // Publish only already public column definitions. Private fields retain their
  // registry scope; this must not turn a routine personal autosave into sharing.
  return changed ? projectSelectionSharedLayout(preferences).columns : undefined;
}

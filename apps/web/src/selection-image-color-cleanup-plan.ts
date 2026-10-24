import type { SelectionField } from "../../../packages/contracts/src/selection-layout.js";
import type { SelectionImageIdentity } from "../../../packages/contracts/src/selection-image-dedup.js";
import { archiveFieldIds } from "../../../packages/contracts/src/product-archive.js";
import { selectionImageColorFieldTypes, selectionImageColorValues } from "../../../packages/contracts/src/selection-image-colors.js";

export type StandardImageColors = { fieldKey: string; colors: string[] };

/** Resolve one readable field; never substitute supplier colours or a field's
 * configured options for the colours actually selected on this row. */
export function standardImageColors(
  fields: SelectionField[], readable: (key: string) => boolean, value: (field: SelectionField) => unknown,
): StandardImageColors | undefined {
  const candidates = fields.filter(field => !field.deleted &&
    (field.label.trim() === "标准颜色" || field.key === `custom:product:${archiveFieldIds.standardColor}`));
  if (candidates.length !== 1) return undefined;
  const field = candidates[0];
  if (!readable(field.key) || !selectionImageColorFieldTypes.has(field.type || field.fallbackType || "text")) return undefined;
  const colors = [...new Set(selectionImageColorValues(field, value(field)).filter(Boolean))];
  return colors.length ? { fieldKey: field.key, colors } : undefined;
}

/** This is an explicit, previewed one-photo-per-colour operation, NOT automatic
 * content deduplication. Unmatched or opaque associations must be preserved. */
export function standardColorImageCleanup<T extends SelectionImageIdentity>(images: readonly T[], basis?: StandardImageColors) {
  const groups = (basis?.colors || []).map(color => ({ color, images: [] as T[] }));
  const byColor = new Map(groups.map(group => [group.color, group]));
  const matched = new Set<T>();
  for (const image of images) {
    if (image.colorFieldKey && image.colorFieldKey !== basis?.fieldKey) continue;
    const group = byColor.get(image.color || "");
    if (group) { group.images.push(image); matched.add(image); }
  }
  const duplicates = groups.filter(group => group.images.length > 1);
  const removeCount = duplicates.reduce((total, group) => total + group.images.length - 1, 0);
  return { groups, duplicates, removeCount, keepCount: images.length - removeCount, unmatchedCount: images.length - matched.size };
}

export function keepStandardColorImages<T extends SelectionImageIdentity & { id: string }>(
  images: readonly T[], basis: StandardImageColors, choices: Record<string, string>,
): T[] {
  const { duplicates } = standardColorImageCleanup(images, basis);
  const removed = new Set<T>();
  for (const group of duplicates) {
    const selected = Object.hasOwn(choices, group.color) && group.images.find(image => image.id === choices[group.color]);
    if (!selected) throw Error(`请选择「${group.color}」需要保留的图片`);
    for (const image of group.images) if (image !== selected) removed.add(image);
  }
  return images.filter(image => !removed.has(image));
}

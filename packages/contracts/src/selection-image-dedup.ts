export type SelectionImageIdentity = { id?: string; url: string; color?: string; colorFieldKey?: string };

/** Content identity never includes an upload ID. Colour links are independent
 * annotations: the same photograph may intentionally represent several colours. */
export function selectionImageIdentity(image: SelectionImageIdentity, content = image.url): string {
  // A projected private link conceals its source field. Do not infer that two
  // such opaque links refer to the same field merely because both are hidden.
  const basis = image.colorFieldKey === "protected" ? `protected:${image.id}` : image.colorFieldKey || "color";
  return JSON.stringify([content, image.color || "", basis]);
}

export function uniqueSelectionImages<T extends SelectionImageIdentity>(images: readonly T[], content?: (image: T) => string): T[] {
  const seen = new Set<string>();
  return images.filter(image => {
    const key = selectionImageIdentity(image, content?.(image));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const selectionSizes = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "6XL", "F"];

export function sortSelectionSizes(value: unknown): string {
  const tags = [...new Set(String(value ?? "").split("/").map(tag => tag.trim()).filter(Boolean))];
  const rank = (tag: string) => { const index = selectionSizes.indexOf(tag); return index < 0 ? selectionSizes.length : index; };
  return tags.sort((a, b) => rank(a) - rank(b)).join("/");
}

export function reorderSelectionItems<T>(items: T[], movingKeys: readonly string[], sourceKey: string, targetKey: string, keyOf: (item: T) => string): T[] {
  const selected = new Set(movingKeys);
  const source = items.findIndex(item => keyOf(item) === sourceKey);
  const target = items.findIndex(item => keyOf(item) === targetKey);
  if (source < 0 || target < 0 || !selected.has(sourceKey) || selected.has(targetKey)) return items;
  const moving = items.filter(item => selected.has(keyOf(item)));
  if (moving.length !== selected.size) return items;
  const remaining = items.filter(item => !selected.has(keyOf(item)));
  const at = remaining.findIndex(item => keyOf(item) === targetKey) + (target > source ? 1 : 0);
  const next = [...remaining.slice(0, at), ...moving, ...remaining.slice(at)];
  return next.every((item, index) => item === items[index]) ? items : next;
}

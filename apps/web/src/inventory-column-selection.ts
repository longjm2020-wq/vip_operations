/** Modifier state of a header click; Cmd on macOS behaves like Ctrl elsewhere. */
export type ColumnClickModifiers = { shift: boolean; toggle: boolean };

export type ColumnSelection = { selected: string[]; anchor: string | null };

/**
 * Header click selection in the displayed column order.
 * - Plain click selects only that column (clicking the sole selected column clears it).
 * - Shift+click selects the contiguous range from the anchor; with Ctrl/Cmd the range is added.
 * - Ctrl/Cmd+click toggles a single column for non-contiguous selection.
 */
export function nextColumnSelection(
  order: readonly string[],
  current: ColumnSelection,
  key: string,
  { shift, toggle }: ColumnClickModifiers,
): ColumnSelection {
  if (!order.includes(key)) return current;
  const visible = current.selected.filter((item) => order.includes(item));
  const anchor =
    current.anchor && order.includes(current.anchor) ? current.anchor : null;
  if (shift) {
    const from = order.indexOf(anchor ?? key),
      to = order.indexOf(key);
    const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    const selected = toggle ? [...visible, ...range] : range;
    return { selected: inOrder(order, selected), anchor: anchor ?? key };
  }
  if (toggle) {
    const selected = visible.includes(key)
      ? visible.filter((item) => item !== key)
      : [...visible, key];
    return { selected: inOrder(order, selected), anchor: key };
  }
  if (visible.length === 1 && visible[0] === key)
    return { selected: [], anchor: null };
  return { selected: [key], anchor: key };
}

/** Right-clicking a selected column acts on the whole selection; otherwise only on that column. */
export function columnMenuTargets(
  order: readonly string[],
  selected: readonly string[],
  key: string,
): string[] {
  return selected.includes(key) ? inOrder(order, selected) : [key];
}

/** Pinned columns always follow the original table order, whatever order they were chosen in. */
export function nextPinnedColumns(
  tableOrder: readonly string[],
  pinned: readonly string[],
  action: "pin" | "unpin" | "unpin-all",
  targets: readonly string[],
): string[] {
  if (action === "unpin-all") return [];
  const next =
    action === "pin"
      ? [...pinned, ...targets]
      : pinned.filter((key) => !targets.includes(key));
  return inOrder(tableOrder, next);
}

function inOrder(order: readonly string[], keys: readonly string[]) {
  return order.filter((key) => keys.includes(key));
}

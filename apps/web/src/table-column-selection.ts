/**
 * Column header selection and pin-menu rules shared by the inventory table, the
 * 选款登记 smart table and the project tables, so all of them behave the same.
 */

/** Modifier state of a header click; Cmd on macOS behaves like Ctrl elsewhere. */
export type ColumnClickModifiers = { shift: boolean; toggle: boolean };

export type ColumnSelection = { selected: string[]; anchor: string | null };

export function columnClickModifiers(event: {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): ColumnClickModifiers {
  return { shift: event.shiftKey, toggle: event.ctrlKey || event.metaKey };
}

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
    const selected = columnRange(order, anchor ?? key, key);
    return {
      selected: inOrder(order, toggle ? [...visible, ...selected] : selected),
      anchor: anchor ?? key,
    };
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

/**
 * Pressing on a header and dragging across neighbours selects the contiguous range
 * between the pressed header and the one under the pointer. With Ctrl/Cmd held the
 * dragged range is added to the selection that existed before the drag (`base`).
 */
export function dragColumnSelection(
  order: readonly string[],
  base: readonly string[],
  anchor: string,
  key: string,
  additive: boolean,
): string[] {
  const range = columnRange(order, anchor, key);
  if (!range.length) return inOrder(order, base);
  return inOrder(order, additive ? [...base, ...range] : range);
}

/** Inclusive range between two displayed columns; empty when either is not displayed. */
export function columnRange(
  order: readonly string[],
  from: string,
  to: string,
): string[] {
  const first = order.indexOf(from),
    last = order.indexOf(to);
  if (first < 0 || last < 0) return [];
  return order.slice(Math.min(first, last), Math.max(first, last) + 1);
}

/** Right-clicking a selected column acts on the whole selection; otherwise only on that column. */
export function columnMenuTargets(
  order: readonly string[],
  selected: readonly string[],
  key: string,
): string[] {
  return selected.includes(key) ? inOrder(order, selected) : [key];
}

export type ColumnPinAction =
  | "fix-selected"
  | "unfix-selected"
  | "fix-column"
  | "unfix-all";

/**
 * Pin entries of the column context menu. A single target uses one toggle
 * entry (「固定此列」/「取消固定此列」); several targets get 「固定所选 N 列」 and/or
 * 「取消固定所选 N 列」 depending on what is already pinned.
 */
export function columnPinMenuEntries(
  targets: readonly string[],
  pinned: readonly string[],
): { key: ColumnPinAction; label: string }[] {
  const many = targets.length > 1;
  const entries: { key: ColumnPinAction; label: string }[] = [];
  if (many) {
    if (targets.some((key) => !pinned.includes(key)))
      entries.push({ key: "fix-selected", label: `固定所选 ${targets.length} 列` });
    if (targets.some((key) => pinned.includes(key)))
      entries.push({
        key: "unfix-selected",
        label: `取消固定所选 ${targets.length} 列`,
      });
  } else if (targets.length) {
    entries.push({
      key: "fix-column",
      label: pinned.includes(targets[0]) ? "取消固定此列" : "固定此列",
    });
  }
  if (pinned.length) entries.push({ key: "unfix-all", label: "取消所有固定列" });
  return entries;
}

/** Pinned columns always follow the original table order, whatever order they were chosen in. */
export function nextPinnedColumns(
  tableOrder: readonly string[],
  pinned: readonly string[],
  action: ColumnPinAction,
  targets: readonly string[],
): string[] {
  if (action === "unfix-all") return [];
  const unpin =
    action === "unfix-selected" ||
    (action === "fix-column" && targets.every((key) => pinned.includes(key)));
  const next = unpin
    ? pinned.filter((key) => !targets.includes(key))
    : [...pinned, ...targets];
  return inOrder(tableOrder, next);
}

function inOrder(order: readonly string[], keys: readonly string[]) {
  return order.filter((key) => keys.includes(key));
}

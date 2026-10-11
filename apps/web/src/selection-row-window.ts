import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

type RowKey = Record<string, any>;
type Group<T> = { label: string; rows: T[] };
export type SelectionWindowEntry<T> =
  | { kind: "row"; key: string; row: T; top: number; height: number }
  | { kind: "group"; key: string; label: string; count: number; top: number; height: number }
  | { kind: "spacer"; key: string; top: number; height: number };

export function selectionWindowEntries<T extends RowKey>(groups: Group<T>[], rowHeight: number, groupHeight = 34): SelectionWindowEntry<T>[] {
  let top = 0;
  return groups.flatMap((group, index) => {
    const entries: SelectionWindowEntry<T>[] = [];
    if (group.label) {
      entries.push({ kind: "group", key: `group:${index}`, label: group.label, count: group.rows.length, top, height: groupHeight });
      top += groupHeight;
    }
    for (const row of group.rows) {
      entries.push({ kind: "row", key: row._key, row, top, height: rowHeight });
      top += rowHeight;
    }
    return entries;
  });
}

/** Render a bounded viewport, retaining editors and open row controls in place. */
export function sliceSelectionWindow<T>(entries: SelectionWindowEntry<T>[], start: number, end: number, pinned: ReadonlySet<string>): SelectionWindowEntry<T>[] {
  const output: SelectionWindowEntry<T>[] = [];
  let skippedTop = 0, skippedHeight = 0;
  const flush = () => {
    if (skippedHeight) output.push({ kind: "spacer", key: `spacer:${skippedTop}`, top: skippedTop, height: skippedHeight });
    skippedHeight = 0;
  };
  for (const entry of entries) {
    if ((entry.top + entry.height > start && entry.top < end) || (entry.kind === "row" && pinned.has(entry.key))) {
      flush(); output.push(entry);
    } else {
      if (!skippedHeight) skippedTop = entry.top;
      skippedHeight += entry.height;
    }
  }
  flush();
  return output;
}

const heights: Record<string, number> = { compact: 40, normal: 50, loose: 100, extra: 120 };
export function useSelectionRowWindow<T extends RowKey>(sheet: RefObject<HTMLDivElement | null>, groups: Group<T>[], rowHeight: string, pinnedKeys: (string | null | undefined)[]) {
  const enabled = groups.reduce((count, group) => count + group.rows.length, 0) > 200;
  const [viewport, setViewport] = useState({ top: 0, height: 720 });
  const [measured, setMeasured] = useState({ mode: rowHeight, row: heights[rowHeight] || 50, group: 34, header: 45 });
  const sizes = measured.mode === rowHeight ? measured : { ...measured, mode: rowHeight, row: heights[rowHeight] || 50 };
  const entries = useMemo(() => selectionWindowEntries(groups, sizes.row, sizes.group), [groups, sizes.row, sizes.group]);
  const byKey = useMemo(() => new Map(entries.filter(entry => entry.kind === "row").map(entry => [entry.key, entry])), [entries]);
  const latest = useRef({ sizes, byKey }); latest.current = { sizes, byKey };
  const pinnedSignature = pinnedKeys.filter(Boolean).join("\0");
  const pinned = useMemo(() => new Set(pinnedSignature.split("\0")), [pinnedSignature]);
  // A few rows on both sides keep edge dragging and fast wheel movement populated.
  const overscan = Math.max(400, sizes.row * 6);
  const visibleEntries = useMemo(() => enabled
    ? sliceSelectionWindow(entries, Math.max(0, viewport.top - sizes.header - overscan), viewport.top + viewport.height + overscan, pinned)
    : entries, [enabled, entries, viewport, sizes.header, overscan, pinned]);

  useLayoutEffect(() => {
    const element = sheet.current;
    if (!element || !enabled) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const top = element.scrollTop, height = element.clientHeight;
      setViewport(previous => previous.top === top && previous.height === height ? previous : { top, height });
    };
    const scroll = () => { if (!frame) frame = requestAnimationFrame(read); };
    const observer = new ResizeObserver(read);
    observer.observe(element);
    element.addEventListener("scroll", scroll, { passive: true });
    read();
    return () => { if (frame) cancelAnimationFrame(frame); observer.disconnect(); element.removeEventListener("scroll", scroll); };
  }, [sheet, enabled]);

  useLayoutEffect(() => {
    const element = sheet.current;
    if (!element || !enabled) return;
    const row = element.querySelector<HTMLElement>("tbody tr[data-selection-row]");
    const group = element.querySelector<HTMLElement>("tr.selection-group-row");
    const header = element.querySelector<HTMLElement>("thead");
    const read = () => {
      setMeasured(previous => {
        const next = { mode: rowHeight, row: row?.getBoundingClientRect().height || heights[rowHeight] || 50,
          group: group?.getBoundingClientRect().height || previous.group, header: header?.getBoundingClientRect().height || previous.header };
        return Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next;
      });
    };
    const observer = new ResizeObserver(read);
    for (const target of [row, group, header]) if (target) observer.observe(target);
    read();
    return () => observer.disconnect();
  }, [sheet, enabled, rowHeight, visibleEntries]);

  const revealRow = (key: string) => {
    const element = sheet.current, entry = latest.current.byKey.get(key);
    if (!element || !entry || !enabled) return;
    const header = latest.current.sizes.header;
    let top = element.scrollTop;
    if (entry.top < top) top = entry.top;
    else if (entry.top + entry.height + header > top + element.clientHeight) top = entry.top + entry.height + header - element.clientHeight;
    element.scrollTop = top;
    setViewport({ top: element.scrollTop, height: element.clientHeight });
  };
  return { entries: visibleEntries, enabled, revealRow };
}

import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { applySelectionHistoryChange, createSelectionHistoryChange, mergeSelectionHistoryChanges, SelectionOperationHistory, type SelectionHistoryChange, type SelectionHistoryDirection, type SelectionHistoryPermission, type SelectionHistoryValueEqual } from "./selection-history";
import type { SelectionLayoutController } from "./selection-layout-preferences";
import { mergeSelectionLayoutHistoryChanges, type SelectionLayoutHistoryChange } from "./selection-layout-history";

type Row = Record<string, any>;
type PositionedRow = { key: string; index: number; row: Row };
type Receipt = { rowId: string; token: string };
type RowOperation = { kind: "rows"; added: PositionedRow[]; removed: PositionedRow[]; change?: SelectionHistoryChange; receipts: Receipt[] };
type Operation = RowOperation | { kind: "cells"; change: SelectionHistoryChange } | { kind: "layout"; change: SelectionLayoutHistoryChange };
type Options = {
  scope: string;
  layout: SelectionLayoutController;
  fields: string[];
  permission: SelectionHistoryPermission;
  valueEqual: SelectionHistoryValueEqual;
  blocked: () => boolean;
  canDelete: (row: Row) => boolean;
  canAdd: () => boolean;
  api: (path: string, method?: string, body?: any, key?: string) => Promise<any>;
  normalize: (row: Row) => Row;
  flush: () => Promise<boolean>;
  baseline: (row: Row | undefined, key: string) => void;
  changed: () => void;
  onApplied: () => void;
  notify: (message: string, error?: boolean) => void;
};

/** One in-memory sequence for this table. Server refreshes never become user operations. */
export function useSelectionTableHistory(options: Options) {
  const latest = useRef(options); latest.current = options;
  const history = useRef(new SelectionOperationHistory<Operation>(10));
  const currentRows = useRef<Row[]>([]);
  const [rows, publishRows] = useState<Row[]>([]);
  const [, publishHistory] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const requests = useRef(new Map<string, string>());
  const pendingLayout = useRef<{ change: SelectionLayoutHistoryChange; groupKey?: string; generation: number } | null>(null);
  const changed = useCallback(() => publishHistory(value => value + 1), []);
  const clear = useCallback(() => { generation.current++; pendingLayout.current = null; history.current.clear(); requests.current.clear(); changed(); }, [changed]);
  const setServerRows = useCallback((action: SetStateAction<Row[]>) => {
    const next = typeof action === "function" ? action(currentRows.current) : action;
    currentRows.current = next; publishRows(next);
  }, []);
  const setRows = useCallback((action: SetStateAction<Row[]>) => {
    if (busyRef.current) return;
    const before = currentRows.current;
    const after = typeof action === "function" ? action(before) : action;
    if (after === before) return;
    const change = createSelectionHistoryChange(before, after, latest.current.fields);
    const beforeKeys = new Set(before.map(row => row._key)), afterKeys = new Set(after.map(row => row._key));
    const added = after.flatMap((row, index) => beforeKeys.has(row._key) ? [] : [{ key: row._key, index, row: structuredClone(row) }]);
    const removed = before.flatMap((row, index) => afterKeys.has(row._key) ? [] : [{ key: row._key, index, row: structuredClone(row) }]);
    if (added.length || removed.length) history.current.record({ kind: "rows", added, removed, change: change || undefined, receipts: [] });
    else if (change) {
      const first = change.cells[0];
      const group = change.cells.length === 1 && first.kind !== "format" ? JSON.stringify(["typing", first.rowKey, first.field]) : undefined;
      history.current.record({ kind: "cells", change }, group, (a, b) => {
        if (a.kind !== "cells" || b.kind !== "cells") return;
        const merged = mergeSelectionHistoryChanges(a.change, b.change);
        return merged ? { kind: "cells", change: merged } : undefined;
      });
    }
    setServerRows(after); changed();
  }, [changed, setServerRows]);
  useEffect(() => { clear(); return clear; }, [options.scope, clear]);
  useEffect(() => options.layout.subscribeHistory(event => {
    if (event.type === "reset") { clear(); return; }
    if (busyRef.current) return;
    const pending = pendingLayout.current;
    if (pending) {
      const merged = mergeSelectionLayoutHistoryChanges(pending.change, event.change);
      if (merged) { pending.change = merged; if (pending.groupKey !== event.groupKey) pending.groupKey = undefined; return; }
    }
    const batch = { change: event.change, groupKey: event.groupKey, generation: generation.current };
    pendingLayout.current = batch;
    queueMicrotask(() => {
      if (batch.generation !== generation.current) return;
      if (pendingLayout.current === batch) pendingLayout.current = null;
      history.current.record({ kind: "layout", change: batch.change }, batch.groupKey, (a, b) => {
        if (a.kind !== "layout" || b.kind !== "layout") return;
        const merged = mergeSelectionLayoutHistoryChanges(a.change, b.change);
        return merged ? { kind: "layout", change: merged } : undefined;
      }); changed();
    });
  }), [options.layout.subscribeHistory, clear, changed]);

  const request = async (opts: Options, path: string, body: unknown) => {
    const signature = JSON.stringify([path, body]);
    const key = requests.current.get(signature) || crypto.randomUUID();
    requests.current.set(signature, key);
    try {
      const result = await opts.api(path, "POST", body, key);
      requests.current.delete(signature);
      return result;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status && status >= 400 && status < 500) requests.current.delete(signature);
      throw error;
    }
  };
  const assertGeneration = (started: number) => { if (started !== generation.current) throw Error("权限或表格范围已变化，历史记录已清空，请刷新核对"); };
  const remove = async (opts: Options, targets: Row[]) => {
    if (targets.some(row => !opts.canDelete(row))) throw Error("选中行包含没有编辑权限的区域，不能删除");
    const saved = targets.filter(row => row.id);
    const receipts: Receipt[] = saved.length ? (await request(opts, "/style-selections/history/delete-rows", {
      rows: saved.map(row => ({ id: String(row.id), expectedUpdatedAt: row.updatedAt })),
    })).data.deletions : [];
    return receipts;
  };
  const restore = async (opts: Options, targets: PositionedRow[], receipts: Receipt[]): Promise<PositionedRow[]> => {
    if (!opts.canAdd()) throw Error("当前账号没有新增或恢复行的权限");
    const saved = targets.filter(item => item.row.id);
    if (saved.some(item => !receipts.some(receipt => String(receipt.rowId) === String(item.row.id)))) throw Error("缺少删除恢复凭据，请刷新核对记录");
    const restored: Row[] = saved.length ? (await request(opts, "/style-selections/history/restore-rows", { deletions: receipts })).data.rows : [];
    return targets.map(item => {
      const raw = item.row.id ? restored.find(row => String(row.id) === String(item.row.id)) : item.row;
      if (!raw) throw Error("恢复响应缺少记录，请刷新核对");
      return { ...item, row: { ...opts.normalize(raw), _key: item.key } };
    });
  };
  const deleteRows = async (keys: Set<string>) => {
    if (busyRef.current || latest.current.blocked()) throw Error("请等待当前操作完成");
    busyRef.current = true; setBusy(true);
    const started = generation.current;
    try {
      const opts = latest.current;
      if (!(await opts.flush())) throw Error("请先处理未保存的修改，再删除行");
      assertGeneration(started);
      const before = currentRows.current;
      const removed = before.flatMap((row, index) => keys.has(row._key) ? [{ key: row._key, index, row: structuredClone(row) }] : []);
      if (!removed.length) return;
      const receipts = await remove(opts, removed.map(item => item.row));
      assertGeneration(started);
      // A permission reset invalidates retained snapshots even if a write just succeeded.
      setServerRows(currentRows.current.filter(row => !keys.has(row._key)));
      removed.forEach(item => opts.baseline(undefined, item.key));
      if (started === generation.current) history.current.record({ kind: "rows", added: [], removed, receipts });
      changed(); opts.onApplied(); opts.changed();
    } finally { busyRef.current = false; setBusy(false); }
  };
  const replay = async (direction: SelectionHistoryDirection) => {
    if (busyRef.current || latest.current.blocked()) return;
    const entry = history.current.peek(direction);
    if (!entry) return;
    busyRef.current = true; setBusy(true);
    const started = generation.current;
    try {
      let replacement = entry;
      if (entry.kind === "layout") {
        const result = await latest.current.layout.applyHistory(entry.change, direction);
        if (!result.ok) throw Error(result.message);
        if (!result.saved) latest.current.notify("布局已在本地恢复，尚未保存，请处理表格设置提示", true);
      } else {
        const opts = latest.current;
        if (entry.kind === "rows" && !(await opts.flush())) throw Error("请先处理未保存的修改，再撤销或重做行操作");
        assertGeneration(started);
        const change = entry.change;
        const applied = change?.cells.length ? applySelectionHistoryChange(currentRows.current, change, direction, latest.current.permission, latest.current.valueEqual) : { ok: true as const, rows: currentRows.current };
        if (!applied.ok) throw Error(applied.reason === "permission" ? "当前已没有相关单元格的编辑权限，无法撤销或重做" : "相关单元格已被其他用户修改，无法覆盖；请核对最新内容");
        let next = [...applied.rows];
        if (entry.kind === "rows") {
          const deleting = direction === "undo" ? entry.added : entry.removed;
          const restoring = direction === "undo" ? entry.removed : entry.added;
          const targets = deleting.map(item => currentRows.current.find(row => row._key === item.key));
          if (targets.some(row => !row) || restoring.some(item => currentRows.current.some(row => row._key === item.key || item.row.id && String(row.id) === String(item.row.id)))) throw Error("相关行已被其他操作改变，请刷新核对");
          for (let index = 0; index < deleting.length; index++) {
            const expected = deleting[index].row;
            const fields = expected.createdAt ? opts.fields : opts.fields.filter(field => field !== "registrationBatch");
            const differences = createSelectionHistoryChange([expected], [targets[index]!], fields);
            if (differences?.cells.some(cell => cell.kind !== "value" || !opts.valueEqual(cell.field, cell.before.value, cell.after.value))) throw Error("相关行内容已被后续操作修改，不能删除；请核对最新内容");
          }
          // Current UI creates or removes rows in a single direction, never both.
          if (deleting.length && restoring.length) throw Error("无法同时恢复和删除行");
          const receipts = deleting.length ? await remove(opts, targets as Row[]) : entry.receipts;
          assertGeneration(started);
          const restored = restoring.length ? await restore(opts, restoring, entry.receipts) : [];
          assertGeneration(started);
          const removedKeys = new Set(deleting.map(item => item.key));
          // Merge the structural result into the latest rows, retaining unrelated updates.
          next = currentRows.current.filter(row => !removedKeys.has(row._key));
          if (change?.cells.length) {
            const latestApplied = applySelectionHistoryChange(next, change, direction, opts.permission, opts.valueEqual);
            if (latestApplied.ok) next = latestApplied.rows;
            else { clear(); opts.notify("行操作已完成，但单元格出现并发修改，请刷新核对", true); }
          }
          for (const item of restored.sort((a, b) => a.index - b.index)) next.splice(Math.min(item.index, next.length), 0, item.row);
          for (const item of deleting) latest.current.baseline(undefined, item.key);
          for (const item of restored) latest.current.baseline(item.row.id ? item.row : undefined, item.key);
          const snapshots = (items: PositionedRow[]) => items.map(item => ({ ...item, row: structuredClone(targets.find(row => row?._key === item.key) || restored.find(row => row.key === item.key)?.row || item.row) }));
          replacement = { ...entry, added: snapshots(entry.added), removed: snapshots(entry.removed), receipts };
        }
        setServerRows(next); latest.current.onApplied();
        if (entry.kind === "rows") latest.current.changed();
      }
      if (started === generation.current) history.current.commit(direction, replacement);
      changed();
    } catch (error) { latest.current.notify((error as Error).message, true); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return { rows, setRows, setServerRows, getRows: () => currentRows.current, deleteRows, replay, clear, busy, undoCount: history.current.undoCount, redoCount: history.current.redoCount };
}

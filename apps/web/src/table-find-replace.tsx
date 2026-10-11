import { useEffect, useId, useMemo, useRef, useState, type PointerEvent, type RefObject } from "react";
import { App, Button, Checkbox, Input, Modal, Pagination, Select, Space, Tabs } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { tableFindMatches, tableReplaceText, type TableFindCell, type TableFindChange, type TableFindOptions } from "./table-find-replace-data.js";
export type { TableFindCell, TableFindChange, TableFindOptions } from "./table-find-replace-data.js";

export function TableFindReplace({ rootRef, cells, selectedIds, activeId, blocked = false, saveHint, onNavigate, onReplace }: {
  rootRef: RefObject<HTMLElement | null>;
  cells: TableFindCell[] | (() => TableFindCell[]);
  selectedIds: ReadonlySet<string>;
  activeId?: string | null;
  blocked?: boolean;
  saveHint: string;
  onNavigate: (cell: TableFindCell) => void;
  onReplace: (changes: TableFindChange[], options: TableFindOptions) => number | Promise<number>;
}) {
  const { message, modal } = App.useApp();
  const dialogClass = `table-find-replace-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [replacement, setReplacement] = useState("");
  const [tab, setTab] = useState<"find" | "replace">("replace");
  const [matchCase, setMatchCase] = useState(false), [wholeCell, setWholeCell] = useState(false);
  const [scope, setScope] = useState<"visible" | "selection">("visible");
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [currentId, setCurrentId] = useState<string | null>(null), [searched, setSearched] = useState(false), [busy, setBusy] = useState(false);
  const [resultPage, setResultPage] = useState(1);
  const confirmation = useRef<ReturnType<typeof modal.confirm> | null>(null);
  const replacing = useRef(false);
  const input = useRef<import("antd").InputRef>(null);
  const title = useRef<HTMLDivElement>(null);
  // Leave Ant Design's initial position intact until the user moves the dialog.
  // Keep the chosen viewport coordinates while this table remains mounted.
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const sizeObserver = useRef<ResizeObserver | null>(null);
  const constrain = (left: number, top: number) => {
    const bounds = title.current?.closest(".ant-modal")?.getBoundingClientRect();
    return {
      left: Math.max(8, Math.min(left, window.innerWidth - (bounds?.width || 480) - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - (bounds?.height || 0) - 8)),
    };
  };
  const keepInView = () => setPosition(current => {
    if (!current) return current;
    const next = constrain(current.left, current.top);
    return next.left === current.left && next.top === current.top ? current : next;
  });
  const stopDrag = () => { drag.current = null; setDragging(false); };
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || (event.target as Element).closest("button, input, textarea, select, a")) return;
    const bounds = event.currentTarget.closest(".ant-modal")?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top };
    setDragging(true);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current?.id !== event.pointerId) return;
    setPosition(constrain(current.left + event.clientX - current.x, current.top + event.clientY - current.y));
  };
  useEffect(() => {
    window.addEventListener("resize", keepInView);
    window.addEventListener("blur", stopDrag);
    return () => { window.removeEventListener("resize", keepInView); window.removeEventListener("blur", stopDrag); sizeObserver.current?.disconnect(); confirmation.current?.destroy(); };
  }, []);
  const options: TableFindOptions = { query, replacement, matchCase, wholeCell };
  const searchCells = useMemo(() => open ? typeof cells === "function" ? cells() : cells : [], [open, cells]);
  const matches = useMemo(() => searchCells.filter(cell => (scope === "visible" || selection.has(cell.id)) && tableFindMatches(cell.text, { query, matchCase, wholeCell })), [searchCells, scope, selection, query, matchCase, wholeCell]);
  const current = matches.find(cell => cell.id === currentId);
  const reset = () => { setCurrentId(null); setSearched(false); setResultPage(1); };
  const show = (nextTab: "find" | "replace" = "replace", keyboardTarget?: Element | null) => {
    if (busy || replacing.current) return;
    setTab(nextTab);
    if (!open) {
      setSelection(new Set(selectedIds)); setScope(selectedIds.size > 1 ? "selection" : "visible"); reset();
    }
    if (!open && keyboardTarget) {
      const root = rootRef.current;
      const readable = typeof cells === "function" ? cells() : cells;
      const activeCell = readable.find(cell => cell.id === activeId);
      let selectedText: string | undefined;
      const textContainer = keyboardTarget.closest<HTMLElement>("[data-table-find-cell], [data-table-find-editor]");
      const readableContainer = !!activeCell && !!textContainer && root?.contains(textContainer) && (textContainer.dataset.tableFindCell === activeCell.id || textContainer.dataset.tableFindEditor === activeCell.id);
      if (readableContainer && root) {
        if ((keyboardTarget instanceof HTMLInputElement || keyboardTarget instanceof HTMLTextAreaElement) && !(keyboardTarget instanceof HTMLInputElement && ["password", "hidden", "checkbox", "radio"].includes(keyboardTarget.type))) {
          const start = keyboardTarget.selectionStart, end = keyboardTarget.selectionEnd;
          if (start !== null && end !== null && end > start) selectedText = keyboardTarget.value.slice(start, end);
        }
        if (selectedText === undefined) {
          const nativeSelection = document.getSelection();
          if (nativeSelection && !nativeSelection.isCollapsed && nativeSelection.anchorNode && nativeSelection.focusNode && textContainer.contains(nativeSelection.anchorNode) && textContainer.contains(nativeSelection.focusNode)) selectedText = nativeSelection.toString();
        }
      }
      if (selectedText === undefined) selectedText = activeCell?.text;
      if (selectedText !== undefined) setQuery(selectedText);
    }
    setOpen(true); input.current?.focus();
  };
  const showRef = useRef(show); showRef.current = show;
  useEffect(() => { if (open) input.current?.focus(); }, [open, tab]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!(event.ctrlKey || event.metaKey) || event.altKey || !["f", "h"].includes(key) || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      if (!target) return;
      const root = rootRef.current;
      if (!root?.getBoundingClientRect().height) return;
      const modal = target.closest(".ant-modal");
      const inRoot = root.contains(target), inFind = !!modal?.classList.contains(dialogClass);
      // The ERP editor uses a Drawer. Its header, save button and focusable
      // shell belong to its one Sheet even though they sit outside the root.
      const overlaySelector = ".ant-modal, .ant-drawer";
      const rootOverlay = root.closest(overlaySelector), targetOverlay = target.closest(overlaySelector);
      if (rootOverlay?.classList.contains("ant-drawer") && !rootOverlay.classList.contains("ant-drawer-open")) return;
      const visibleContexts = [...document.querySelectorAll<HTMLElement>("[data-table-find-context]")].filter(element => element.getBoundingClientRect().height > 0);
      const ownOverlayContext = !!rootOverlay && targetOverlay === rootOverlay && visibleContexts.filter(element => rootOverlay.contains(element)).length === 1;
      if (targetOverlay && !inFind && !inRoot && !ownOverlayContext) return;
      const visibleOverlays = [...document.querySelectorAll<HTMLElement>(".ant-modal, .ant-drawer-open")].filter(element => element.getBoundingClientRect().height > 0);
      const bodyContext = target === document.body && (visibleOverlays.length === 0 && visibleContexts.length === 1 || visibleOverlays.length === 1 && visibleOverlays[0] === rootOverlay && visibleContexts.filter(element => rootOverlay?.contains(element)).length === 1);
      if (!inFind && !inRoot && !ownOverlayContext && !bodyContext) return;
      event.preventDefault(); event.stopPropagation();
      showRef.current(key === "f" ? "find" : "replace", inFind ? undefined : target);
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [rootRef, dialogClass]);
  const navigate = (direction: -1 | 1, first = false) => {
    setSearched(true);
    if (!matches.length) { setCurrentId(null); return; }
    const previous = matches.findIndex(cell => cell.id === currentId);
    const index = first ? 0 : previous < 0 ? (direction > 0 ? 0 : matches.length - 1) : (previous + direction + matches.length) % matches.length;
    setCurrentId(matches[index].id); setResultPage(Math.floor(index / 50) + 1); onNavigate(matches[index]);
  };
  const replace = async (all: boolean) => {
    if (blocked || busy || replacing.current) return;
    const targets = (all ? matches : current ? [current] : []).filter(cell => cell.replaceable);
    const changes = targets.map(cell => ({ ...cell, after: tableReplaceText(cell.text, options) })).filter(cell => cell.after !== cell.text);
    if (!changes.length) { message.info("没有可替换的匹配内容"); return; }
    replacing.current = true; setBusy(true);
    const snapshot = { ...options };
    const apply = async () => {
      try {
        const latest = live.current;
        const readable = typeof latest.cells === "function" ? latest.cells() : latest.cells;
        const byId = new Map(readable.map(cell => [cell.id, cell]));
        if (latest.blocked || latest.scope !== scope || Object.keys(snapshot).some(key => latest.options[key as keyof TableFindOptions] !== snapshot[key as keyof TableFindOptions]) || changes.some(change => { const cell = byId.get(change.id); return !cell?.replaceable || cell.text !== change.text; })) throw new Error("待替换内容、范围或编辑权限已变化，请重新查找后再替换");
        const count = await latest.onReplace(changes, snapshot);
        message.success(`已替换 ${count} 个单元格。${saveHint}`);
        setSearched(true);
      } catch (error) { message.error((error as Error).message); }
      finally { replacing.current = false; setBusy(false); }
    };
    const wholeTable = scope === "visible" || searchCells.length > 0 && searchCells.every(cell => selection.has(cell.id));
    if (all && wholeTable) {
      confirmation.current = modal.confirm({
        title: "确认替换整表范围的内容？",
        content: <div style={{ display: "grid", gap: 8 }}><div>将替换当前筛选结果的全部可见字段中 {changes.length} 个匹配单元格。只读单元格会跳过。</div><div>查找：<span style={{ overflowWrap: "anywhere" }}>{snapshot.query}</span></div><div>替换为：<span style={{ overflowWrap: "anywhere" }}>{snapshot.replacement || "（空内容）"}</span></div><div>确认后{saveHint}</div></div>,
        okText: "确认全部替换", cancelText: "取消", onOk: apply, onCancel: () => { replacing.current = false; setBusy(false); }, afterClose: () => { confirmation.current = null; },
      });
    } else await apply();
  };
  const live = useRef({ cells, blocked, onReplace, options, scope }); live.current = { cells, blocked, onReplace, options, scope };
  const editableCount = matches.filter(cell => cell.replaceable).length;
  return <>
    <Button icon={<SearchOutlined />} title="Ctrl+F 查找，Ctrl+H 替换" disabled={busy} onClick={() => show()}>查找/替换</Button>
    <Modal className={`table-find-replace-modal ${dialogClass}`} title={<div ref={title} className="table-find-replace-title" style={{ cursor: dragging ? "grabbing" : "grab", touchAction: "none", userSelect: "none" }} title="拖动标题栏移动查找/替换窗口" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}>查找/替换</div>} open={open} mask={false} scrollLock={false} style={position ? { position: "fixed", ...position, margin: 0, paddingBottom: 0 } : undefined} styles={{ wrapper: { pointerEvents: "none" }, container: { pointerEvents: "auto", padding: 16 }, body: { maxHeight: "calc(100dvh - 96px)", overflowY: "auto" } }} footer={null} width={480} onCancel={() => { stopDrag(); setOpen(false); }} afterOpenChange={visible => {
      sizeObserver.current?.disconnect();
      if (visible) {
        const modal = title.current?.closest(".ant-modal");
        if (modal) { sizeObserver.current = new ResizeObserver(keepInView); sizeObserver.current.observe(modal); }
        keepInView(); input.current?.focus();
      }
    }} focusTriggerAfterClose={false}>
      <div style={{ display: "grid", gap: 10 }}>
        <Tabs activeKey={tab} size="small" tabBarStyle={{ marginBottom: 0 }} items={[{ key: "find", label: "查找", disabled: busy }, { key: "replace", label: "替换", disabled: busy }]} onChange={value => { setTab(value as "find" | "replace"); input.current?.focus(); }} />
        <label>查找内容<Input ref={input} aria-label="查找内容" disabled={busy} maxLength={2000} value={query} onChange={event => { setQuery(event.target.value); reset(); }} onPressEnter={event => navigate(event.shiftKey ? -1 : 1)} /></label>
        {tab === "replace" && <label>替换为<Input aria-label="替换为" disabled={busy} maxLength={2000} value={replacement} onChange={event => setReplacement(event.target.value)} onPressEnter={() => { void replace(false); }} /></label>}
        <Space wrap>
          <Checkbox checked={matchCase} disabled={busy} onChange={event => { setMatchCase(event.target.checked); reset(); }}>区分大小写</Checkbox>
          <Checkbox checked={wholeCell} disabled={busy} onChange={event => { setWholeCell(event.target.checked); reset(); }}>整格匹配</Checkbox>
          <Select aria-label="查找范围" value={scope} disabled={busy} onChange={value => { setScope(value); reset(); }} style={{ width: 180 }} options={[{ value: "visible", label: "当前筛选的可见字段" }, { value: "selection", label: "打开时的选区", disabled: !selection.size }]} />
        </Space>
        <Space wrap>
          <Button disabled={busy || !query} onClick={() => navigate(1, true)}>查找全部</Button>
          <Button disabled={busy || !query} onClick={() => navigate(-1)}>上一个</Button>
          <Button disabled={busy || !query} onClick={() => navigate(1)}>下一个</Button>
          {tab === "replace" && <><Button disabled={blocked || busy || !current?.replaceable} loading={busy} onClick={() => { void replace(false); }}>替换当前</Button>
          <Button type="primary" disabled={blocked || busy || !editableCount} loading={busy} onClick={() => { void replace(true); }}>全部替换</Button></>}
        </Space>
        <div role="status">{searched ? matches.length ? `找到 ${matches.length} 个匹配单元格，可替换 ${editableCount} 个${current ? `；当前 ${matches.indexOf(current) + 1}/${matches.length}：${current.rowLabel} · ${current.columnLabel}` : ""}` : "未找到匹配内容" : "普通文字查找，可跨当前筛选结果的分页定位。"}</div>
        {searched && !!matches.length && <div role="group" aria-label="查找结果" style={{ maxHeight: 220, overflow: "auto" }}>
          {matches.slice((Math.min(resultPage, Math.ceil(matches.length / 50)) - 1) * 50, Math.min(resultPage, Math.ceil(matches.length / 50)) * 50).map(cell => <Button key={cell.id} type={cell.id === currentId ? "primary" : "text"} disabled={busy} block style={{ height: "auto", textAlign: "left", whiteSpace: "normal" }} onClick={() => { setCurrentId(cell.id); onNavigate(cell); }} aria-label={`定位${cell.rowLabel} ${cell.columnLabel}`}>
            <span>{cell.rowLabel} · {cell.columnLabel}{!cell.replaceable ? "（只读）" : ""}</span><br/><span>{cell.text.slice(0, 80)}{cell.text.length > 80 ? "…" : ""}</span>
          </Button>)}
          {matches.length > 50 && <Pagination simple current={Math.min(resultPage, Math.ceil(matches.length / 50))} pageSize={50} total={matches.length} onChange={setResultPage} showSizeChanger={false}/>}
        </div>}
        <div className="secondary">只查找可见且有查看权限的内容；只读匹配可查找，替换时跳过。{saveHint}</div>
      </div>
    </Modal>
  </>;
}

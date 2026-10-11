import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { App, Button, Checkbox, Input, Modal, Pagination, Select, Space } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { tableFindMatches, tableReplaceText, type TableFindCell, type TableFindChange, type TableFindOptions } from "./table-find-replace-data.js";
export type { TableFindCell, TableFindChange, TableFindOptions } from "./table-find-replace-data.js";

export function TableFindReplace({ rootRef, cells, selectedIds, blocked = false, saveHint, onNavigate, onReplace }: {
  rootRef: RefObject<HTMLElement | null>;
  cells: TableFindCell[] | (() => TableFindCell[]);
  selectedIds: ReadonlySet<string>;
  blocked?: boolean;
  saveHint: string;
  onNavigate: (cell: TableFindCell) => void;
  onReplace: (changes: TableFindChange[], options: TableFindOptions) => number | Promise<number>;
}) {
  const { message } = App.useApp();
  const dialogClass = `table-find-replace-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false), [wholeCell, setWholeCell] = useState(false);
  const [scope, setScope] = useState<"visible" | "selection">("visible");
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [currentId, setCurrentId] = useState<string | null>(null), [searched, setSearched] = useState(false), [busy, setBusy] = useState(false);
  const [resultPage, setResultPage] = useState(1);
  const input = useRef<import("antd").InputRef>(null);
  const options: TableFindOptions = { query, replacement, matchCase, wholeCell };
  const searchCells = useMemo(() => open ? typeof cells === "function" ? cells() : cells : [], [open, cells]);
  const matches = useMemo(() => searchCells.filter(cell => (scope === "visible" || selection.has(cell.id)) && tableFindMatches(cell.text, { query, matchCase, wholeCell })), [searchCells, scope, selection, query, matchCase, wholeCell]);
  const current = matches.find(cell => cell.id === currentId);
  const show = () => { if (open) { input.current?.focus(); return; } setSelection(new Set(selectedIds)); setScope("visible"); setOpen(true); };
  const showRef = useRef(show); showRef.current = show;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "h" || event.isComposing) return;
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
      if (inFind) input.current?.focus(); else showRef.current();
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [rootRef, dialogClass]);
  const reset = () => { setCurrentId(null); setSearched(false); setResultPage(1); };
  const navigate = (direction: -1 | 1, first = false) => {
    setSearched(true);
    if (!matches.length) { setCurrentId(null); return; }
    const previous = matches.findIndex(cell => cell.id === currentId);
    const index = first ? 0 : previous < 0 ? (direction > 0 ? 0 : matches.length - 1) : (previous + direction + matches.length) % matches.length;
    setCurrentId(matches[index].id); setResultPage(Math.floor(index / 50) + 1); onNavigate(matches[index]);
  };
  const replace = async (all: boolean) => {
    if (blocked || busy) return;
    const targets = (all ? matches : current ? [current] : []).filter(cell => cell.replaceable);
    const changes = targets.map(cell => ({ ...cell, after: tableReplaceText(cell.text, options) })).filter(cell => cell.after !== cell.text);
    if (!changes.length) { message.info("没有可替换的匹配内容"); return; }
    setBusy(true);
    try {
      const count = await onReplace(changes, options);
      message.success(`已替换 ${count} 个单元格。${saveHint}`);
      setSearched(true);
    } catch (error) { message.error((error as Error).message); }
    finally { setBusy(false); }
  };
  const editableCount = matches.filter(cell => cell.replaceable).length;
  return <>
    <Button icon={<SearchOutlined />} title="Ctrl+H 查找/替换" onClick={show}>查找/替换</Button>
    <Modal className={`table-find-replace-modal ${dialogClass}`} title="查找/替换" open={open} mask={false} scrollLock={false} styles={{ wrapper: { pointerEvents: "none" }, container: { pointerEvents: "auto" } }} footer={null} width={560} onCancel={() => setOpen(false)} afterOpenChange={visible => { if (visible) input.current?.focus(); }} focusTriggerAfterClose={false}>
      <div style={{ display: "grid", gap: 14 }}>
        <label>查找内容<Input ref={input} aria-label="查找内容" maxLength={2000} value={query} onChange={event => { setQuery(event.target.value); reset(); }} onPressEnter={event => navigate(event.shiftKey ? -1 : 1)} /></label>
        <label>替换为<Input aria-label="替换为" maxLength={2000} value={replacement} onChange={event => setReplacement(event.target.value)} onPressEnter={() => { void replace(false); }} /></label>
        <Space wrap>
          <Checkbox checked={matchCase} onChange={event => { setMatchCase(event.target.checked); reset(); }}>区分大小写</Checkbox>
          <Checkbox checked={wholeCell} onChange={event => { setWholeCell(event.target.checked); reset(); }}>整格匹配</Checkbox>
          <Select aria-label="查找范围" value={scope} onChange={value => { setScope(value); reset(); }} style={{ width: 180 }} options={[{ value: "visible", label: "当前筛选的可见字段" }, { value: "selection", label: "打开时的选区", disabled: !selection.size }]} />
        </Space>
        <Space wrap>
          <Button disabled={!query} onClick={() => navigate(1, true)}>查找全部</Button>
          <Button disabled={!query} onClick={() => navigate(-1)}>上一个</Button>
          <Button disabled={!query} onClick={() => navigate(1)}>下一个</Button>
          <Button disabled={blocked || busy || !current?.replaceable} loading={busy} onClick={() => { void replace(false); }}>替换当前</Button>
          <Button type="primary" disabled={blocked || busy || !editableCount} loading={busy} onClick={() => { void replace(true); }}>全部替换</Button>
        </Space>
        <div role="status">{searched ? matches.length ? `找到 ${matches.length} 个匹配单元格，可替换 ${editableCount} 个${current ? `；当前 ${matches.indexOf(current) + 1}/${matches.length}：${current.rowLabel} · ${current.columnLabel}` : ""}` : "未找到匹配内容" : "普通文字查找，可跨当前筛选结果的分页定位。"}</div>
        {searched && !!matches.length && <div role="group" aria-label="查找结果" style={{ maxHeight: 220, overflow: "auto" }}>
          {matches.slice((Math.min(resultPage, Math.ceil(matches.length / 50)) - 1) * 50, Math.min(resultPage, Math.ceil(matches.length / 50)) * 50).map(cell => <Button key={cell.id} type={cell.id === currentId ? "primary" : "text"} block style={{ height: "auto", textAlign: "left", whiteSpace: "normal" }} onClick={() => { setCurrentId(cell.id); onNavigate(cell); }} aria-label={`定位${cell.rowLabel} ${cell.columnLabel}`}>
            <span>{cell.rowLabel} · {cell.columnLabel}{!cell.replaceable ? "（只读）" : ""}</span><br/><span>{cell.text.slice(0, 80)}{cell.text.length > 80 ? "…" : ""}</span>
          </Button>)}
          {matches.length > 50 && <Pagination simple current={Math.min(resultPage, Math.ceil(matches.length / 50))} pageSize={50} total={matches.length} onChange={setResultPage} showSizeChanger={false}/>}
        </div>}
        <div className="secondary">只查找可见且有查看权限的内容；只读匹配可查找，替换时跳过。{saveHint}</div>
      </div>
    </Modal>
  </>;
}

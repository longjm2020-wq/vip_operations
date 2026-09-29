import { useMemo, useState } from "react";
import { App, Button, Checkbox, Dropdown, Input, Select, Space, Switch, Tabs } from "antd";
import { ArrowUpOutlined, ArrowDownOutlined, DownloadOutlined } from "@ant-design/icons";
import type { SelectionFilter, SelectionView } from "../../../packages/contracts/src/selection-view";
import { matchesSelectionFilters, selectionCellColor, selectionFilterOptions, selectionFilterValue, sortSelectionRows } from "./selection-filters";
import { downloadSheet } from "./download-sheet";
type Row = Record<string, any>;
const modes = [["contains", "包含"], ["notContains", "不包含"], ["equals", "等于"], ["notEquals", "不等于"], ["starts", "开头是"], ["ends", "结尾是"], ["gt", "大于 / 晚于"], ["gte", "大于等于"], ["lt", "小于 / 早于"], ["lte", "小于等于"], ["between", "介于"], ["empty", "为空"], ["filled", "不为空"]];
const colorNames: Record<string, string> = { NONE: "无填色", ORANGE: "橙色", YELLOW: "黄色", GREEN: "绿色", BLUE: "蓝色", PINK: "粉色", default: "默认字体", "#262626": "黑色", "#cf1322": "红色", "#d46b08": "橙色", "#ad8b00": "金色", "#389e0d": "绿色", "#0958d9": "蓝色", "#531dab": "紫色", "#c41d7f": "粉色", "#595959": "灰色" };
const fillHex: Record<string, string> = { NONE: "#fff", ORANGE: "#fff1e7", YELLOW: "#fff8cf", GREEN: "#eef9e8", BLUE: "#edf5ff", PINK: "#fff0f3", default: "#46352a" };
export function SelectionFilterPanel({ column, rows, view, shared, canShare, onCancel, onApply }: { column: { key: string; label: string }; rows: Row[]; view: SelectionView; shared: boolean; canShare: boolean; onCancel: () => void; onApply: (view: SelectionView, shared: boolean) => Promise<void> }) {
  const { message } = App.useApp();
  const [draft, setDraft] = useState<SelectionFilter>(view.filters[column.key] || { mode: "contains", value: "" });
  const [sort, setSort] = useState(view.sort);
  const [share, setShare] = useState(shared && canShare);
  const [query, setQuery] = useState("");
  const [listOrder, setListOrder] = useState("name:asc");
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(200);
  const otherFilters = Object.fromEntries(Object.entries(view.filters).filter(([key]) => key !== column.key));
  const candidates = useMemo(() => rows.filter(row => matchesSelectionFilters(row, otherFilters)), [rows, JSON.stringify(otherFilters)]);
  const allOptions = useMemo(() => selectionFilterOptions(candidates, column.key), [candidates, column.key]);
  const options = useMemo(() => {
    const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean), [field, direction] = listOrder.split(":");
    return allOptions.filter(option => !words.length || words.some(word => (option.value || "(空白)").toLocaleLowerCase().includes(word))).sort((a, b) => (field === "count" ? a.count - b.count || a.value.localeCompare(b.value, "zh-CN", { numeric: true }) : a.value.localeCompare(b.value, "zh-CN", { numeric: true })) * (direction === "asc" ? 1 : -1));
  }, [allOptions, query, listOrder]);
  const selected = new Set(draft.values ?? allOptions.map(option => option.value));
  const setValues = (values: Set<string>) => setDraft(current => ({ ...current, values: [...values] }));
  const checkedCount = options.filter(option => selected.has(option.value)).length;
  const colorType = draft.colorType || "fill";
  const colorOptions = [...new Set(candidates.map(row => selectionCellColor(row, column.key, colorType)))];
  const nextView = (): SelectionView => {
    const filters = { ...view.filters };
    const active = draft.values !== undefined || draft.colors !== undefined || ["empty", "filled"].includes(draft.mode) || !!draft.value.trim();
    if (active) filters[column.key] = draft; else delete filters[column.key];
    return { filters, sort };
  };
  const apply = async () => { if (draft.mode === "between" && (!draft.value.trim() || !draft.end?.trim())) { message.warning("请填写区间的开始值和结束值"); return; } setBusy(true); try { await onApply(nextView(), share); } catch (error) { message.error((error as Error).message); } finally { setBusy(false); } };
  const exportData = async (type: string) => {
    try {
      const records = type === "options" ? options.map(option => ({ [column.label]: option.value || "(空白)", 数量: option.count, 已勾选: selected.has(option.value) ? "是" : "否" })) : sortSelectionRows(rows.filter(row => matchesSelectionFilters(row, nextView().filters)), sort).map(row => ({ 序缇款号: row.xutiStyleNo || "", 供应商款号: row.supplierStyleNo || "", [column.label]: selectionFilterValue(row, column.key) }));
      if (!records.length) { message.info("没有可导出的数据"); return; }
      await downloadSheet(`${column.label}-${type === "options" ? "筛选选项" : "筛选结果"}`, records);
    } catch (error) { message.error((error as Error).message); }
  };
  return <div className="selection-filter-panel" onMouseDown={event => event.stopPropagation()}>
    <Space.Compact block><Button block icon={<ArrowUpOutlined />} type={sort?.key === column.key && sort.direction === "asc" ? "primary" : "default"} onClick={() => setSort({ key: column.key, direction: "asc" })}>升序</Button><Button block icon={<ArrowDownOutlined />} type={sort?.key === column.key && sort.direction === "desc" ? "primary" : "default"} onClick={() => setSort({ key: column.key, direction: "desc" })}>降序</Button><Button block onClick={() => setSort(null)}>取消排序</Button></Space.Compact>
    <Tabs items={[
      { key: "options", label: "按选项", children: <>
        <Input allowClear aria-label="搜索筛选选项" placeholder="搜包含任一关键字，空格分隔" value={query} onChange={event => { setQuery(event.target.value); setLimit(200); }} />
        <div className="selection-filter-option-tools"><Select size="small" aria-label="选项排序" value={listOrder} onChange={setListOrder} options={[["name:asc", "名称 ↑"], ["name:desc", "名称 ↓"], ["count:asc", "计数 ↑"], ["count:desc", "计数 ↓"]].map(([value, label]) => ({ value, label }))} /><span>{options.length} 项</span></div>
        <div className="selection-filter-option-tools"><Checkbox checked={!!options.length && checkedCount === options.length} indeterminate={checkedCount > 0 && checkedCount < options.length} onChange={event => { const next = new Set(selected); options.forEach(option => { if (event.target.checked) next.add(option.value); else next.delete(option.value); }); setValues(next); }}>全选({options.length})</Checkbox><Button type="link" size="small" onClick={() => { const next = new Set(selected); options.forEach(option => { if (next.has(option.value)) next.delete(option.value); else next.add(option.value); }); setValues(next); }}>反选</Button><Button type="link" size="small" onClick={() => setValues(new Set(options.filter(option => option.count > 1).map(option => option.value)))}>重复项</Button><Button type="link" size="small" onClick={() => setValues(new Set(options.filter(option => option.count === 1).map(option => option.value)))}>唯一项</Button></div>
        <div className="selection-filter-values">{options.slice(0, limit).map(option => <Checkbox key={option.value} checked={selected.has(option.value)} onChange={event => { const next = new Set(selected); if (event.target.checked) next.add(option.value); else next.delete(option.value); setValues(next); }}><span title={option.value}>{option.value || "(空白)"}</span> <small>({option.count})</small></Checkbox>)}{!options.length && <p>没有匹配的选项</p>}{options.length > limit && <Button type="link" onClick={() => setLimit(limit + 200)}>加载更多（剩余 {options.length - limit} 项）</Button>}</div>
      </> },
      { key: "colors", label: "按颜色", children: <Space orientation="vertical" style={{width:"100%"}}><Select aria-label="颜色类型" value={colorType} options={[{ value: "fill", label: "背景填色" }, { value: "text", label: "字体颜色" }]} onChange={colorType => setDraft(current => ({ ...current, colorType, colors: undefined }))} /><Button size="small" onClick={() => setDraft(current => ({ ...current, colors: undefined }))}>不限颜色</Button>{colorOptions.map(color => <Checkbox key={color} checked={!draft.colors || draft.colors.includes(color)} onChange={event => { const colors = new Set(draft.colors ?? colorOptions); if (event.target.checked) colors.add(color); else colors.delete(color); setDraft(current => ({ ...current, colorType, colors: [...colors] })); }}><i className="selection-color-dot" style={{background:fillHex[color] || color}} />{colorNames[color] || color} ({candidates.filter(row => selectionCellColor(row, column.key, colorType) === color).length})</Checkbox>)}</Space> },
      { key: "conditions", label: "按条件", children: <Space orientation="vertical" style={{width:"100%"}}><Select style={{width:"100%"}} aria-label="筛选条件" value={draft.mode} options={modes.map(([value, label]) => ({ value, label }))} onChange={mode => setDraft(current => ({ ...current, mode }))} />{!["empty", "filled"].includes(draft.mode) && <Input aria-label="条件值" placeholder="输入文本、数字或 YYYY-MM-DD" value={draft.value} onChange={event => setDraft(current => ({ ...current, value: event.target.value }))} />}{draft.mode === "between" && <Input aria-label="结束值" placeholder="结束值（含边界）" value={draft.end} onChange={event => setDraft(current => ({ ...current, end: event.target.value }))} />}<span className="selection-format-note">选项、颜色、条件同时生效。重复项/唯一项按本列完整内容统计；区间筛选包含范围端点。</span></Space> },
    ]} />
    <div className="selection-filter-sharing"><span title="开启并确认后，同步给有本表查看权限的协作者；关闭仅对自己生效，不移除已有共享筛选。">筛选对所有人可见</span><Switch aria-label="筛选对所有人可见" disabled={!canShare} checked={share} onChange={setShare} /></div>
    <div className="selection-filter-footer"><Button type="text" size="small" onClick={() => { setDraft({ mode: "contains", value: "" }); setQuery(""); }}>清除筛选</Button><Dropdown trigger={["click"]} menu={{ items:[{key:"options",label:"导出选项与计数"},{key:"results",label:"导出本列筛选结果"}], onClick:({key})=>void exportData(key) }}><Button type="text" size="small" icon={<DownloadOutlined />}>导出</Button></Dropdown><Button onClick={onCancel} disabled={busy}>取消</Button><Button type="primary" loading={busy} onClick={() => void apply()}>确认</Button></div>
  </div>;
}

import { Fragment, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Card, Checkbox, Empty, Input, Popover, Select, Space } from "antd";
import { BgColorsOutlined, DeleteOutlined, FilterOutlined, LinkOutlined, PlusOutlined, SettingOutlined, SortAscendingOutlined, TeamOutlined, UnorderedListOutlined, UploadOutlined } from "@ant-design/icons";
import { api, queryClient } from "./api";
import { prepareUpload, readUpload } from "./upload-file";
import { Header, QueryState, Row, useCan, useUser } from "./shared";
import "./style-selections.css";

const colorOptions = [
  { value: "NONE", label: "无填色", color: "#ffffff" }, { value: "ORANGE", label: "橙色", color: "#fff1e7" },
  { value: "YELLOW", label: "黄色", color: "#fff8cf" }, { value: "GREEN", label: "绿色", color: "#eef9e8" },
  { value: "BLUE", label: "蓝色", color: "#edf5ff" }, { value: "PINK", label: "粉色", color: "#fff0f3" },
];
const sizes = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "6XL"];
type SelectionImage = { id: string; url: string; color: string };
type Column = { key: string; label: string; width: number; custom?: boolean };
const baseColumns: Column[] = [
  { key: "registrationBatch", label: "登记批次", width: 120 }, { key: "images", label: "图片", width: 120 },
  { key: "xutiStyleNo", label: "序缇款号", width: 120 }, { key: "supplierStyleNo", label: "供应商款号", width: 120 },
  { key: "supplierCode", label: "供应商编码", width: 120 }, { key: "color", label: "颜色", width: 120 },
  { key: "sizeRange", label: "尺码范围", width: 120 }, { key: "material", label: "材质", width: 120 },
  { key: "supplyPriceExclTax", label: "供货价（不含税）", width: 120 }, { key: "vipPrice", label: "唯品价", width: 120 },
  { key: "livePrice", label: "直播价", width: 120 }, { key: "tagPrice", label: "吊牌价", width: 120 },
];
const baseKeys = baseColumns.map((column) => column.key);
const moneyKeys = new Set(["supplyPriceExclTax", "vipPrice", "livePrice", "tagPrice"]);
const clean = (value: unknown) => (value === "" || value === undefined ? null : value);
const splitTags = (value: unknown) => [...new Set(String(value || "").split("/").map((item) => item.trim()).filter(Boolean))];
const joinTags = (value: string[]) => [...new Set(value.map((item) => item.trim()).filter(Boolean))].join("/");
const comparable = (value: unknown) => value && typeof value === "object" ? JSON.stringify(value) : String(clean(value) ?? "");
const cellId = (rowKey: string, columnKey: string) => `${rowKey}::${columnKey}`;
const customColumnsKey = "style-selection-custom-columns-v1";
const storedColumns = () => {
  try {
    const value = JSON.parse(localStorage.getItem(customColumnsKey) || "[]");
    return Array.isArray(value) ? value.filter((column): column is Column => column?.custom && typeof column.key === "string" && typeof column.label === "string") : [];
  } catch { return []; }
};
const rowImages = (row: Row): SelectionImage[] => Array.isArray(row.images) ? row.images : [];
const valueAt = (row: Row, column: Column) => column.custom ? row.extraFields?.[column.key] || "" : row[column.key];
const withValue = (row: Row, column: Column, value: unknown) => column.custom
  ? { ...row, extraFields: { ...(row.extraFields || {}), [column.key]: String(value || "") } }
  : { ...row, [column.key]: value };
const sameRow = (a: Row, b: Row) =>
  baseKeys.every((key) => comparable(a[key]) === comparable(b[key])) &&
  comparable(a.extraFields) === comparable(b.extraFields) && comparable(a.cellColors) === comparable(b.cellColors) &&
  Number(a.sortOrder || 0) === Number(b.sortOrder || 0);

function TagCell({ value, onChange, options = [], disabled, placeholder }: { value: unknown; onChange: (value: string) => void; options?: string[]; disabled: boolean; placeholder: string }) {
  return <Select mode="tags" value={splitTags(value)} disabled={disabled} tokenSeparators={["/"]} placeholder={placeholder} options={options.map((item) => ({ value: item, label: item }))} onChange={(values) => onChange(joinTags(values))} />;
}

function ImageCell({ images, colors, disabled, onChange }: { images: SelectionImage[]; colors: string[]; disabled: boolean; onChange: (images: SelectionImage[]) => void }) {
  const { message } = App.useApp();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const add = (next: SelectionImage[]) => {
    if (images.length + next.length > 5) return message.warning("每行最多添加 5 张图片");
    onChange([...images, ...next]);
  };
  const addUrl = () => {
    const value = url.trim();
    if (!value) return;
    if (!/^https?:\/\//i.test(value)) return message.error("请输入以 http:// 或 https:// 开头的图片网址");
    add([{ id: crypto.randomUUID(), url: value, color: colors[0] || "" }]); setUrl("");
  };
  const addFiles = async (files: File[]) => {
    if (disabled || !files.length || busy) return;
    if (images.length + files.length > 5) return message.warning("每行最多添加 5 张图片");
    setBusy(true);
    try {
      const next: SelectionImage[] = [];
      for (let file of files) { file = await prepareUpload(file); next.push({ id: crypto.randomUUID(), url: await readUpload(file), color: colors[0] || "" }); }
      add(next);
    } catch (error) { message.error((error as Error).message); } finally { setBusy(false); }
  };
  const paste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.items).filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => !!file);
    if (!files.length) return;
    event.preventDefault(); event.stopPropagation(); void addFiles(files);
  };
  return <div className="selection-images" onPaste={paste}>
    <div className="selection-image-list">{images.map((image) => <div className="selection-image-item" key={image.id}>
      <img src={image.url} alt={image.color || "款式图片"} />
      {image.color && <span className="selection-image-color">{image.color}</span>}
      {!disabled && <Button className="selection-image-remove" type="text" size="small" aria-label="移除图片" icon={<DeleteOutlined />} onClick={() => onChange(images.filter((item) => item.id !== image.id))} />}
      <Select className="selection-image-color-select" size="small" disabled={disabled} allowClear value={image.color || undefined} placeholder="命名颜色" options={colors.map((color) => ({ value: color, label: color }))} onChange={(color) => onChange(images.map((item) => item.id === image.id ? { ...item, color: color || "" } : item))} />
    </div>)}</div>
    {!disabled && images.length < 5 && <div className="selection-image-adders">
      <Input size="small" value={url} placeholder="图片网址后按 Enter" prefix={<LinkOutlined />} onChange={(event) => setUrl(event.target.value)} onPressEnter={addUrl} />
      <Button size="small" icon={<LinkOutlined />} onClick={addUrl}>添加链接</Button>
      <label className="selection-upload-button"><UploadOutlined /> 本地上传<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const files = Array.from(event.target.files || []); event.currentTarget.value = ""; void addFiles(files); }} /></label>
    </div>}
    {!disabled && <span className="selection-image-tip">可直接粘贴图片；每张自动压缩至 1 MB 以下，最多 5 张。</span>}
  </div>;
}

export function StyleSelectionsPage() {
  const canEdit = useCan("selection.manage");
  const user = useUser();
  const { message } = App.useApp();
  const [filterOpen, setFilterOpen] = useState(false);
  const [columns, setColumns] = useState<Column[]>(() => [...baseColumns, ...storedColumns()]);
  const [visible, setVisible] = useState<string[]>(() => [...baseKeys, ...storedColumns().map((column) => column.key)]);
  const [search, setSearch] = useState("");
  const [groupBy, setGroupBy] = useState<"none" | "batch" | "supplier" | "color">("none");
  const [sort, setSort] = useState("sortOrder");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [rowHeight, setRowHeight] = useState<"compact" | "normal" | "loose">("normal");
  const [rows, setRows] = useState<Row[]>([]);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const [cellAnchor, setCellAnchor] = useState<{ rowKey: string; columnKey: string } | null>(null);
  const [selectingCells, setSelectingCells] = useState(false);
  const [draggedRow, setDraggedRow] = useState<string | null>(null);
  const [draggedColumn, setDraggedColumn] = useState<string | null>(null);
  const [resizingColumn, setResizingColumn] = useState<{ key: string; startX: number; startWidth: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const original = useRef(new Map<string, Row>());
  const appliedSnapshot = useRef("");
  const queryString = new URLSearchParams({ page: "1", pageSize: "100", ...(search ? { q: search } : {}), sort, direction }).toString();
  const data = useQuery({ queryKey: ["style-selections", queryString], queryFn: () => api("/style-selections?" + queryString), refetchInterval: 10000 });
  const presence = useQuery({ queryKey: ["style-selection-presence"], queryFn: () => api("/style-selections/presence"), refetchInterval: 10000 });
  const snapshot = JSON.stringify(data.data?.data || []);
  useEffect(() => { localStorage.setItem(customColumnsKey, JSON.stringify(columns.filter((column) => column.custom))); }, [columns]);
  useEffect(() => {
    const stop = () => setSelectingCells(false);
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!resizingColumn) return;
      setColumns((current) => current.map((column) => column.key === resizingColumn.key ? { ...column, width: Math.max(80, resizingColumn.startWidth + event.clientX - resizingColumn.startX) } : column));
    };
    const stop = () => setResizingColumn(null);
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", stop);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", stop); };
  }, [resizingColumn]);
  useEffect(() => {
    const heartbeat = () => { void api("/style-selections/presence", "POST", { editingId }).catch(() => undefined); };
    heartbeat(); const timer = window.setInterval(heartbeat, 12000);
    return () => window.clearInterval(timer);
  }, [editingId]);
  useEffect(() => {
    if (!data.data || appliedSnapshot.current === snapshot || saving || rows.some((row) => !row.id || !sameRow(row, original.current.get(row._key) || {}))) return;
    const next = (data.data.data || []).map((row: Row) => ({ ...row, images: row.images || [], cellColors: row.cellColors || {}, extraFields: row.extraFields || {}, _key: String(row.id) }));
    setRows(next); setSelectedRows([]); setSelectedCells(new Set()); setErrors({});
    original.current = new Map(next.map((row: Row) => [row._key, { ...row }])); appliedSnapshot.current = snapshot;
  }, [data.data, saving, snapshot, rows]);

  const activeColumns = columns.filter((column) => visible.includes(column.key));
  const colorSuggestions = useMemo(() => [...new Set(rows.flatMap((row) => splitTags(row.color)))], [rows]);
  const grouped = useMemo(() => {
    const label = (row: Row) => groupBy === "batch" ? row.registrationBatch || "未填写登记批次" : groupBy === "supplier" ? row.supplierCode || "未填写供应商编码" : row.color || "未填写颜色";
    if (groupBy === "none") return [{ label: "", rows }];
    return rows.reduce<{ label: string; rows: Row[] }[]>((result, row) => { const key = label(row); const target = result.find((item) => item.label === key); if (target) target.rows.push(row); else result.push({ label: key, rows: [row] }); return result; }, []);
  }, [groupBy, rows]);
  const dirtyCount = rows.filter((row) => !row.id || !sameRow(row, original.current.get(row._key) || {})).length;
  const hasContent = (row: Row) => baseKeys.some((key) => key === "images" ? rowImages(row).length : Boolean(clean(row[key])));

  const update = (key: string, column: Column, value: unknown) => {
    setRows((current) => current.map((row) => row._key === key ? withValue(row, column, value) : row));
    setErrors((current) => { const next = { ...current }; delete next[`${key}:${column.key}`]; return next; });
  };
  const add = () => {
    if (!canEdit) return;
    const nextOrder = Math.max(0, ...rows.map((row) => Number(row.sortOrder || 0))) + 1;
    const key = crypto.randomUUID(); setRows((current) => [...current, { _key: key, images: [], cellColors: {}, extraFields: {}, sortOrder: nextOrder, rowColor: "NONE" }]); setSelectedRows([key]);
  };
  const deleteRows = async () => {
    if (!canEdit || !selectedRows.length || deleting) return message.warning("请先勾选需要删除的行");
    setDeleting(true);
    try {
      const current = rows.filter((row) => selectedRows.includes(row._key));
      for (const row of current.filter((row) => row.id)) await api(`/style-selections/${row.id}`, "DELETE", undefined, row._key);
      setRows((items) => items.filter((row) => !selectedRows.includes(row._key))); setSelectedRows([]); setSelectedCells(new Set()); appliedSnapshot.current = "";
      await queryClient.invalidateQueries({ queryKey: ["style-selections"] }); message.success(`已删除 ${current.length} 行`);
    } catch (error) { message.error((error as Error).message); } finally { setDeleting(false); }
  };
  const applyColor = (color: string) => {
    if (!canEdit || !selectedCells.size) return message.warning("请单击或拖动选择需要填色的单元格");
    setRows((current) => current.map((row) => {
      const matches = activeColumns.filter((column) => selectedCells.has(cellId(row._key, column.key)));
      if (!matches.length) return row;
      const cellColors = { ...(row.cellColors || {}) };
      for (const column of matches) { if (color === "NONE") delete cellColors[column.key]; else cellColors[column.key] = color; }
      return { ...row, cellColors };
    }));
  };
  const moveRow = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    setRows((current) => { const copy = [...current]; const from = copy.findIndex((row) => row._key === fromKey), to = copy.findIndex((row) => row._key === toKey); if (from < 0 || to < 0) return current; const [row] = copy.splice(from, 1); copy.splice(to, 0, row); return copy.map((item, index) => ({ ...item, sortOrder: index + 1 })); });
  };
  const moveColumn = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    setColumns((current) => { const copy = [...current]; const from = copy.findIndex((column) => column.key === fromKey), to = copy.findIndex((column) => column.key === toKey); if (from < 0 || to < 0) return current; const [column] = copy.splice(from, 1); copy.splice(to, 0, column); return copy; });
  };
  const addColumn = () => {
    const label = window.prompt("请输入新文本列名称");
    if (!label?.trim()) return;
    const column = { key: `custom:${crypto.randomUUID()}`, label: label.trim().slice(0, 40), width: 180, custom: true };
    setColumns((current) => [...current, column]); setVisible((current) => [...current, column.key]);
  };
  const removeColumn = (column: Column) => {
    if (!column.custom) return setVisible((current) => current.filter((key) => key !== column.key));
    setColumns((current) => current.filter((item) => item.key !== column.key)); setVisible((current) => current.filter((key) => key !== column.key));
    setRows((current) => current.map((row) => { const fields = { ...(row.extraFields || {}) }; delete fields[column.key]; return { ...row, extraFields: fields }; }));
  };
  const selectRectangle = (from: { rowKey: string; columnKey: string }, to: { rowKey: string; columnKey: string }) => {
    const r1 = rows.findIndex((row) => row._key === from.rowKey), r2 = rows.findIndex((row) => row._key === to.rowKey);
    const c1 = activeColumns.findIndex((column) => column.key === from.columnKey), c2 = activeColumns.findIndex((column) => column.key === to.columnKey);
    if (r1 < 0 || r2 < 0 || c1 < 0 || c2 < 0) return;
    const next = new Set<string>();
    for (let row = Math.min(r1, r2); row <= Math.max(r1, r2); row++) for (let column = Math.min(c1, c2); column <= Math.max(c1, c2); column++) next.add(cellId(rows[row]._key, activeColumns[column].key));
    setSelectedCells(next);
  };
  const cellMouseDown = (rowKey: string, columnKey: string) => { const point = { rowKey, columnKey }; setCellAnchor(point); setSelectingCells(true); setEditingId(rows.find((row) => row._key === rowKey)?.id || null); setSelectedCells(new Set([cellId(rowKey, columnKey)])); };
  const cellMouseEnter = (rowKey: string, columnKey: string) => { if (selectingCells && cellAnchor) selectRectangle(cellAnchor, { rowKey, columnKey }); };
  const copyCells = (event: ClipboardEvent<HTMLTableCellElement>, rowKey: string, columnKey: string) => {
    const selected = selectedCells.size ? selectedCells : new Set([cellId(rowKey, columnKey)]);
    const positions = [...selected].map((value) => { const [r, c] = value.split("::"); return { r: rows.findIndex((row) => row._key === r), c: activeColumns.findIndex((column) => column.key === c) }; }).filter((item) => item.r >= 0 && item.c >= 0);
    if (!positions.length) return;
    const minRow = Math.min(...positions.map((item) => item.r)), maxRow = Math.max(...positions.map((item) => item.r)), minCol = Math.min(...positions.map((item) => item.c)), maxCol = Math.max(...positions.map((item) => item.c));
    const text = Array.from({ length: maxRow - minRow + 1 }, (_, r) => Array.from({ length: maxCol - minCol + 1 }, (_, c) => String(valueAt(rows[minRow + r], activeColumns[minCol + c]) || "")).join("\t")).join("\n");
    event.preventDefault(); event.clipboardData.setData("text/plain", text);
  };
  const pasteCells = (event: ClipboardEvent<HTMLTableCellElement>, rowKey: string, columnKey: string) => {
    if (event.defaultPrevented) return;
    const text = event.clipboardData.getData("text/plain"); if (!text) return;
    const rowStart = rows.findIndex((row) => row._key === rowKey), columnStart = activeColumns.findIndex((column) => column.key === columnKey); if (rowStart < 0 || columnStart < 0) return;
    event.preventDefault(); const matrix = text.replace(/\r/g, "").split("\n").map((line) => line.split("\t"));
    setRows((current) => current.map((row, rowIndex) => { const source = matrix[rowIndex - rowStart]; if (!source) return row; let next = row; source.forEach((value, offset) => { const column = activeColumns[columnStart + offset]; if (!column || column.key === "images") return; next = withValue(next, column, value); }); return next; }));
  };
  const save = async () => {
    if (!canEdit || saving) return;
    const nextErrors: Record<string, string> = {};
    const changed = rows.filter((row) => (!row.id || !sameRow(row, original.current.get(row._key) || {})) && (row.id || hasContent(row)));
    changed.forEach((row) => { const colors = new Set(splitTags(row.color)); const images = rowImages(row); if (images.length > 5) nextErrors[`${row._key}:images`] = "每行最多添加 5 张图片"; if (images.some((image) => image.color && !colors.has(image.color))) nextErrors[`${row._key}:images`] = "图片颜色必须来自颜色字段"; for (const key of moneyKeys) if (row[key] && !/^\d+(\.\d{1,2})?$/.test(String(row[key]))) nextErrors[`${row._key}:${key}`] = "金额最多两位小数"; });
    if (Object.keys(nextErrors).length) { setErrors(nextErrors); return message.error("请修正表格中的红色单元格"); }
    if (!changed.length) return message.info("没有待保存的修改");
    setSaving(true); let succeeded = 0; const failed: Record<string, string> = {}; const savedRows: Record<string, Row> = {};
    try {
      for (const row of changed) {
        const body: Row = Object.fromEntries(baseKeys.map((key) => [key, clean(row[key])]));
        body.images = rowImages(row); body.cellColors = row.cellColors || {}; body.extraFields = row.extraFields || {}; body.sortOrder = Number(row.sortOrder || 0); body.rowColor = row.rowColor || "NONE"; if (row.id) body.expectedUpdatedAt = row.updatedAt;
        try { const result = await api(row.id ? `/style-selections/${row.id}` : "/style-selections", row.id ? "PATCH" : "POST", body, row._key); savedRows[row._key] = { ...row, ...result.data, images: result.data.images || [], cellColors: result.data.cellColors || {}, extraFields: result.data.extraFields || {}, _key: row._key }; succeeded++; } catch (error) { failed[row._key] = (error as Error).message; }
      }
      setErrors(Object.fromEntries(Object.entries(failed).map(([key, value]) => [`${key}:xutiStyleNo`, value])));
      if (succeeded) { setRows((current) => current.map((row) => savedRows[row._key] || row)); Object.values(savedRows).forEach((row) => original.current.set(row._key, { ...row })); }
      if (Object.keys(failed).length) message.warning(`已保存 ${succeeded} 行，${Object.keys(failed).length} 行需要修正后重试`); else message.success(`已保存 ${succeeded} 条选款登记`);
      if (!Object.keys(failed).length) { appliedSnapshot.current = ""; await queryClient.invalidateQueries({ queryKey: ["style-selections"] }); }
    } finally { setSaving(false); }
  };
  useEffect(() => {
    if (!canEdit || !dirtyCount || saving || deleting) return;
    const timer = window.setTimeout(() => { void save(); }, 900);
    return () => window.clearTimeout(timer);
  }, [canEdit, dirtyCount, saving, deleting, rows]);
  const renderCell = (row: Row, column: Column) => {
    const disabled = !canEdit, error = errors[`${row._key}:${column.key}`], selected = selectedCells.has(cellId(row._key, column.key));
    const common = { className: `${error ? "selection-cell-error " : ""}${selected ? "selection-cell-active" : ""}`, title: error, onMouseDown: () => cellMouseDown(row._key, column.key), onMouseEnter: () => cellMouseEnter(row._key, column.key), onCopy: (event: ClipboardEvent<HTMLTableCellElement>) => copyCells(event, row._key, column.key), onPaste: (event: ClipboardEvent<HTMLTableCellElement>) => pasteCells(event, row._key, column.key) };
    if (column.key === "images") return <td {...common}><ImageCell images={rowImages(row)} colors={splitTags(row.color)} disabled={disabled} onChange={(value) => update(row._key, column, value)} /></td>;
    if (column.key === "color") return <td {...common}><TagCell value={row.color} disabled={disabled} placeholder="输入颜色后按 Enter" options={colorSuggestions} onChange={(value) => update(row._key, column, value)} /></td>;
    if (column.key === "sizeRange") return <td {...common}><TagCell value={row.sizeRange} disabled={disabled} placeholder="选择或输入尺码" options={sizes} onChange={(value) => update(row._key, column, value)} /></td>;
    if (column.key === "registrationBatch") return <td {...common}><input disabled={disabled} type="date" value={row.registrationBatch || ""} onChange={(event) => update(row._key, column, event.target.value)} /></td>;
    if (moneyKeys.has(column.key)) return <td {...common}><div className="selection-money-input"><span>￥</span><input disabled={disabled} inputMode="decimal" placeholder="0.00" value={valueAt(row, column) || ""} onChange={(event) => update(row._key, column, event.target.value)} /></div></td>;
    return <td {...common}><input disabled={disabled} value={valueAt(row, column) || ""} onChange={(event) => update(row._key, column, event.target.value)} /></td>;
  };
  const filterContent = <div className="selection-popover"><Input.Search autoFocus allowClear placeholder="搜索批次、款号、供应商、颜色或材质" value={search} onChange={(event) => setSearch(event.target.value)} /><Button onClick={() => { setSearch(""); setFilterOpen(false); }}>清除筛选</Button></div>;
  const settings = <div className="selection-column-settings"><Button type="dashed" icon={<PlusOutlined />} onClick={addColumn}>新增文本列</Button>{columns.map((column) => <div key={column.key} className="selection-column-setting" draggable onDragStart={() => setDraggedColumn(column.key)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggedColumn) moveColumn(draggedColumn, column.key); setDraggedColumn(null); }}><Checkbox checked={visible.includes(column.key)} onChange={(event) => setVisible((current) => event.target.checked ? [...current, column.key] : current.filter((key) => key !== column.key))}>{column.label}</Checkbox><Button type="text" size="small" icon={<DeleteOutlined />} aria-label={`移除 ${column.label}`} onClick={() => removeColumn(column)} /></div>)}</div>;
  const collaborators = (presence.data?.data || []).filter((person: Row) => String(person.userId) !== String(user.id || ""));
  return <><Header title="选款登记" subtitle="集中登记候选款的图片、款号、供应商、颜色、材质与定价信息。" />
    <Card className="selection-card"><div className="selection-toolbar" aria-label="选款登记表格工具栏"><Space wrap size={4}>
      <Button type="link" icon={<PlusOutlined />} disabled={!canEdit} onClick={add}>添加一行</Button><Button type="link" danger icon={<DeleteOutlined />} disabled={!canEdit || !selectedRows.length} loading={deleting} onClick={deleteRows}>删除行</Button>
      <Popover trigger="click" content={settings}><Button type="text" icon={<SettingOutlined />}>表格设置</Button></Popover><Popover trigger="click" open={filterOpen} onOpenChange={setFilterOpen} content={filterContent}><Button type="text" icon={<FilterOutlined />}>筛选</Button></Popover>
      <Select className="selection-tool-select" value={groupBy} suffixIcon={<TeamOutlined />} options={[{ value: "none", label: "不分组" }, { value: "batch", label: "按登记批次分组" }, { value: "supplier", label: "按供应商编码分组" }, { value: "color", label: "按颜色分组" }]} onChange={setGroupBy} />
      <Select className="selection-tool-select" value={`${sort}:${direction}`} suffixIcon={<SortAscendingOutlined />} options={[{ value: "sortOrder:asc", label: "手动排序" }, { value: "updatedAt:desc", label: "最近修改" }, { value: "createdAt:desc", label: "最新登记" }, { value: "registrationBatch:desc", label: "登记批次" }, { value: "xutiStyleNo:asc", label: "序缇款号" }, { value: "supplierCode:asc", label: "供应商编码" }, { value: "supplyPriceExclTax:asc", label: "供货价" }, { value: "vipPrice:asc", label: "唯品价" }]} onChange={(value) => { const [nextSort, nextDirection] = value.split(":"); setSort(nextSort); setDirection(nextDirection as "asc" | "desc"); }} />
      <Select className="selection-tool-select" value={rowHeight} suffixIcon={<UnorderedListOutlined />} options={[{ value: "compact", label: "紧凑行高" }, { value: "normal", label: "标准行高" }, { value: "loose", label: "宽松行高" }]} onChange={setRowHeight} />
      <Popover trigger="click" content={<div className="selection-color-menu">{colorOptions.map((option) => <Button key={option.value} type="text" onClick={() => applyColor(option.value)}><span className="selection-color-dot" style={{ background: option.color }} />{option.label}</Button>)}</div>}><Button type="text" icon={<BgColorsOutlined />}>填色</Button></Popover>
    </Space><span className="selection-record-count">{saving ? "正在自动保存" : dirtyCount ? "等待自动保存" : "已保存"} <b>·</b> 记录数 {rows.length} <b>·</b> 行 {selectedRows.length} <b>·</b> 单元格 {selectedCells.size}</span></div>
    {!!collaborators.length && <div className="selection-collaborators" aria-label="在线协作者">{collaborators.map((person: Row) => <span key={person.userId} title={person.editingId ? `正在编辑第 ${person.editingId} 行` : "在线"}><i>{String(person.displayName || "协").slice(0, 1)}</i>{person.displayName}{person.editingId ? " · 编辑中" : " · 在线"}</span>)}</div>}
      <QueryState error={data.error || presence.error} reload={() => { data.refetch(); presence.refetch(); }} /><div className={`selection-sheet row-${rowHeight}`}><table aria-label="选款登记在线智能表格"><thead><tr><th className="selection-check"><Checkbox aria-label="选择全部可见行" checked={!!rows.length && selectedRows.length === rows.length} indeterminate={selectedRows.length > 0 && selectedRows.length < rows.length} onChange={(event) => setSelectedRows(event.target.checked ? rows.map((row) => row._key) : [])} /></th><th className="selection-index">#</th>{activeColumns.map((column) => <th key={column.key} draggable onDragStart={() => setDraggedColumn(column.key)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggedColumn) moveColumn(draggedColumn, column.key); setDraggedColumn(null); }} style={{ width: column.width, minWidth: column.width }}><span>{column.label}</span><i className="selection-column-resize" aria-label={`调整 ${column.label} 列宽`} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); setResizingColumn({ key: column.key, startX: event.clientX, startWidth: column.width }); }} /></th>)}</tr></thead><tbody>
        {data.isLoading && <tr><td colSpan={activeColumns.length + 2} className="selection-placeholder">正在读取选款登记…</td></tr>}{!data.isLoading && !rows.length && <tr><td colSpan={activeColumns.length + 2} className="selection-placeholder"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无选款登记，点击添加一行开始录入" /></td></tr>}
        {grouped.map((group) => <Fragment key={group.label || "all"}>{group.label && <tr className="selection-group-row"><td colSpan={activeColumns.length + 2}>{group.label}<span>{group.rows.length} 条</span></td></tr>}{group.rows.map((row, index) => <tr key={row._key}><td className="selection-check"><Checkbox aria-label={`选择 ${row.xutiStyleNo || "未填写序缇款号"}`} checked={selectedRows.includes(row._key)} onChange={(event) => setSelectedRows((current) => event.target.checked ? [...current, row._key] : current.filter((key) => key !== row._key))} /></td><td className="selection-index selection-row-drag" draggable onDragStart={() => setDraggedRow(row._key)} onDragOver={(event: DragEvent) => event.preventDefault()} onDrop={() => { if (draggedRow) moveRow(draggedRow, row._key); setDraggedRow(null); }}>{index + 1}</td>{activeColumns.map((column) => renderCell(row, column))}</tr>)}</Fragment>)}
      </tbody></table></div><div className="selection-bottom-bar"><span>拖动可选择多个单元格后填色；Ctrl/Cmd+C 复制、Ctrl/Cmd+V 粘贴；拖动序号调整行，拖动列标题调整列。</span><span>{canEdit ? "图片支持网址、本地上传和粘贴。" : "当前账号仅可查看。"}</span></div></Card></>;
}

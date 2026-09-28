import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  App,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  Popover,
  Select,
  Space,
} from "antd";
import {
  BgColorsOutlined,
  FilterOutlined,
  PlusOutlined,
  SettingOutlined,
  SortAscendingOutlined,
  TeamOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { api, queryClient } from "./api";
import { Header, QueryState, Row, useCan } from "./shared";
import "./style-selections.css";

const colorOptions = [
  { value: "NONE", label: "无填色", color: "#ffffff" },
  { value: "ORANGE", label: "橙色", color: "#fff1e7" },
  { value: "YELLOW", label: "黄色", color: "#fff8cf" },
  { value: "GREEN", label: "绿色", color: "#eef9e8" },
  { value: "BLUE", label: "蓝色", color: "#edf5ff" },
  { value: "PINK", label: "粉色", color: "#fff0f3" },
];
const fills = Object.fromEntries(colorOptions.map((option) => [option.value, option.color]));

type ColumnKey =
  | "registrationBatch"
  | "imageUrl"
  | "xutiStyleNo"
  | "supplierStyleNo"
  | "supplierCode"
  | "color"
  | "sizeRange"
  | "material"
  | "supplyPriceExclTax"
  | "vipPrice"
  | "livePrice"
  | "tagPrice";

const columns: { key: ColumnKey; label: string; width: number }[] = [
  { key: "registrationBatch", label: "登记批次", width: 150 },
  { key: "imageUrl", label: "图片", width: 250 },
  { key: "xutiStyleNo", label: "序缇款号", width: 155 },
  { key: "supplierStyleNo", label: "供应商款号", width: 165 },
  { key: "supplierCode", label: "供应商编码", width: 150 },
  { key: "color", label: "颜色", width: 120 },
  { key: "sizeRange", label: "尺码范围", width: 140 },
  { key: "material", label: "材质", width: 180 },
  { key: "supplyPriceExclTax", label: "供货价（不含税）", width: 165 },
  { key: "vipPrice", label: "唯品价", width: 130 },
  { key: "livePrice", label: "直播价", width: 130 },
  { key: "tagPrice", label: "吊牌价", width: 130 },
];

const editableKeys = columns.map((column) => column.key);
const moneyKeys = new Set<ColumnKey>(["supplyPriceExclTax", "vipPrice", "livePrice", "tagPrice"]);
const clean = (value: unknown) => (value === "" || value === undefined ? null : value);
const sameRow = (a: Row, b: Row) =>
  editableKeys.every((key) => String(clean(a[key]) ?? "") === String(clean(b[key]) ?? "")) &&
  String(a.rowColor || "NONE") === String(b.rowColor || "NONE");

export function StyleSelectionsPage() {
  const canEdit = useCan("selection.manage");
  const { message } = App.useApp();
  const [filterOpen, setFilterOpen] = useState(false);
  const [visible, setVisible] = useState<ColumnKey[]>(columns.map((column) => column.key));
  const [search, setSearch] = useState("");
  const [groupBy, setGroupBy] = useState<"none" | "batch" | "supplier" | "color">("none");
  const [sort, setSort] = useState("updatedAt");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [rowHeight, setRowHeight] = useState<"compact" | "normal" | "loose">("normal");
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const original = useRef(new Map<string, Row>());
  const appliedSnapshot = useRef("");
  const queryString = new URLSearchParams({
    page: "1",
    pageSize: "100",
    ...(search ? { q: search } : {}),
    sort,
    direction,
  }).toString();
  const data = useQuery({
    queryKey: ["style-selections", queryString],
    queryFn: () => api("/style-selections?" + queryString),
  });
  const snapshot = JSON.stringify(data.data?.data || []);
  useEffect(() => {
    if (!data.data || appliedSnapshot.current === snapshot || saving) return;
    const next = (data.data.data || []).map((row: Row) => ({ ...row, _key: String(row.id) }));
    setRows(next);
    setSelected([]);
    setErrors({});
    original.current = new Map(next.map((row: Row) => [row._key, { ...row }]));
    appliedSnapshot.current = snapshot;
  }, [data.data, saving, snapshot]);

  const activeColumns = columns.filter((column) => visible.includes(column.key));
  const grouped = useMemo(() => {
    const label = (row: Row) =>
      groupBy === "batch"
        ? row.registrationBatch || "未填写登记批次"
        : groupBy === "supplier"
          ? row.supplierCode || "未填写供应商编码"
          : row.color || "未填写颜色";
    if (groupBy === "none") return [{ label: "", rows }];
    return rows.reduce<{ label: string; rows: Row[] }[]>((result, row) => {
      const key = label(row);
      const target = result.find((item) => item.label === key);
      if (target) target.rows.push(row);
      else result.push({ label: key, rows: [row] });
      return result;
    }, []);
  }, [groupBy, rows]);
  const dirtyCount = rows.filter((row) => !row.id || !sameRow(row, original.current.get(row._key) || {})).length;

  const update = (key: string, field: ColumnKey | "rowColor", value: unknown) => {
    setRows((current) => current.map((row) => (row._key === key ? { ...row, [field]: value } : row)));
    setErrors((current) => {
      const next = { ...current };
      delete next[`${key}:${field}`];
      return next;
    });
  };
  const add = () => {
    if (!canEdit) return;
    const key = crypto.randomUUID();
    setRows((current) => [{ _key: key, rowColor: "NONE" }, ...current]);
    setSelected((current) => [...current, key]);
  };
  const applyColor = (color: string) => {
    if (!canEdit || !selected.length) return message.warning("请先勾选需要填色的行");
    setRows((current) => current.map((row) => (selected.includes(row._key) ? { ...row, rowColor: color } : row)));
  };
  const save = async () => {
    if (!canEdit || saving) return;
    const nextErrors: Record<string, string> = {};
    const changed = rows.filter((row) => !row.id || !sameRow(row, original.current.get(row._key) || {}));
    changed.forEach((row) => {
      if (row.imageUrl && !/^https?:\/\//i.test(String(row.imageUrl))) nextErrors[`${row._key}:imageUrl`] = "图片须使用 http:// 或 https:// 网址";
      for (const key of moneyKeys)
        if (row[key] && !/^\d+(\.\d{1,2})?$/.test(String(row[key]))) nextErrors[`${row._key}:${key}`] = "金额最多两位小数";
    });
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return message.error("请修正表格中的红色单元格");
    }
    if (!changed.length) return message.info("没有待保存的修改");
    setSaving(true);
    let succeeded = 0;
    const failed: Record<string, string> = {};
    const savedRows: Record<string, Row> = {};
    try {
      for (const row of changed) {
        const body: Row = Object.fromEntries(editableKeys.map((key) => [key, clean(row[key])]));
        body.rowColor = row.rowColor || "NONE";
        if (row.id) body.expectedUpdatedAt = row.updatedAt;
        try {
          const result = await api(row.id ? `/style-selections/${row.id}` : "/style-selections", row.id ? "PATCH" : "POST", body, row._key);
          savedRows[row._key] = { ...row, ...result.data, _key: row._key };
          succeeded++;
        } catch (error) {
          failed[row._key] = (error as Error).message;
        }
      }
      setErrors(Object.fromEntries(Object.entries(failed).map(([key, value]) => [`${key}:xutiStyleNo`, value])));
      if (succeeded) {
        setRows((current) => current.map((row) => savedRows[row._key] || row));
        Object.values(savedRows).forEach((row) => original.current.set(row._key, { ...row }));
      }
      if (Object.keys(failed).length) message.warning(`已保存 ${succeeded} 行，${Object.keys(failed).length} 行需要修正后重试`);
      else message.success(`已保存 ${succeeded} 条选款登记`);
      if (!Object.keys(failed).length) {
        appliedSnapshot.current = "";
        await queryClient.invalidateQueries({ queryKey: ["style-selections"] });
      }
    } finally {
      setSaving(false);
    }
  };
  const renderCell = (row: Row, column: ColumnKey) => {
    const disabled = !canEdit;
    const error = errors[`${row._key}:${column}`];
    const common = { className: error ? "selection-cell-error" : "", title: error };
    if (column === "imageUrl")
      return <td {...common}><div className="selection-image-cell">{row.imageUrl && <img src={row.imageUrl} alt="款式图片" />}<input disabled={disabled} value={row.imageUrl || ""} onChange={(event) => update(row._key, column, event.target.value)} placeholder="粘贴图片网址" /></div></td>;
    return <td {...common}><input disabled={disabled} inputMode={moneyKeys.has(column) ? "decimal" : undefined} placeholder={moneyKeys.has(column) ? "0.00" : ""} value={row[column] || ""} onChange={(event) => update(row._key, column, event.target.value)} /></td>;
  };

  const filterContent = (
    <div className="selection-popover">
      <Input.Search autoFocus allowClear placeholder="搜索批次、款号、供应商、颜色或材质" value={search} onChange={(event) => setSearch(event.target.value)} />
      <Button onClick={() => { setSearch(""); setFilterOpen(false); }}>清除筛选</Button>
    </div>
  );

  return (
    <>
      <Header
        title="选款登记"
        subtitle="集中登记候选款的图片、款号、供应商、颜色、材质与定价信息。"
        extra={canEdit ? <Button type="primary" loading={saving} disabled={!dirtyCount} onClick={save}>保存登记{dirtyCount ? ` (${dirtyCount})` : ""}</Button> : undefined}
      />
      <Card className="selection-card">
        <div className="selection-toolbar" aria-label="选款登记表格工具栏">
          <Space wrap size={4}>
            <Button type="link" icon={<PlusOutlined />} disabled={!canEdit} onClick={add}>添加一行</Button>
            <Popover trigger="click" content={<div className="selection-column-settings">{columns.map((column) => <Checkbox key={column.key} checked={visible.includes(column.key)} onChange={(event) => setVisible((current) => event.target.checked ? [...current, column.key] : current.filter((key) => key !== column.key))}>{column.label}</Checkbox>)}</div>}>
              <Button type="text" icon={<SettingOutlined />}>表格设置</Button>
            </Popover>
            <Popover trigger="click" open={filterOpen} onOpenChange={setFilterOpen} content={filterContent}>
              <Button type="text" icon={<FilterOutlined />}>筛选</Button>
            </Popover>
            <Select className="selection-tool-select" value={groupBy} suffixIcon={<TeamOutlined />} options={[{ value: "none", label: "不分组" }, { value: "batch", label: "按登记批次分组" }, { value: "supplier", label: "按供应商编码分组" }, { value: "color", label: "按颜色分组" }]} onChange={setGroupBy} />
            <Select className="selection-tool-select" value={`${sort}:${direction}`} suffixIcon={<SortAscendingOutlined />} options={[
              { value: "updatedAt:desc", label: "最近修改" }, { value: "createdAt:desc", label: "最新登记" }, { value: "registrationBatch:asc", label: "登记批次" }, { value: "xutiStyleNo:asc", label: "序缇款号" }, { value: "supplierCode:asc", label: "供应商编码" }, { value: "supplyPriceExclTax:asc", label: "供货价" }, { value: "vipPrice:asc", label: "唯品价" },
            ]} onChange={(value) => { const [nextSort, nextDirection] = value.split(":"); setSort(nextSort); setDirection(nextDirection as "asc" | "desc"); }} />
            <Select className="selection-tool-select" value={rowHeight} suffixIcon={<UnorderedListOutlined />} options={[{ value: "compact", label: "紧凑行高" }, { value: "normal", label: "标准行高" }, { value: "loose", label: "宽松行高" }]} onChange={setRowHeight} />
            <Popover trigger="click" content={<div className="selection-color-menu">{colorOptions.map((option) => <Button key={option.value} type="text" onClick={() => applyColor(option.value)}><span className="selection-color-dot" style={{ background: option.color }} />{option.label}</Button>)}</div>}>
              <Button type="text" icon={<BgColorsOutlined />}>填色</Button>
            </Popover>
          </Space>
          <span className="selection-record-count">记录数 {rows.length} <b>·</b> 选中 {selected.length}</span>
        </div>
        <QueryState error={data.error} reload={() => data.refetch()} />
        <div className={`selection-sheet row-${rowHeight}`}>
          <table aria-label="选款登记在线智能表格">
            <thead>
              <tr>
                <th className="selection-check"><Checkbox aria-label="选择全部可见行" checked={!!rows.length && selected.length === rows.length} indeterminate={selected.length > 0 && selected.length < rows.length} onChange={(event) => setSelected(event.target.checked ? rows.map((row) => row._key) : [])} /></th>
                <th className="selection-index">#</th>
                {activeColumns.map((column) => <th key={column.key} style={{ minWidth: column.width }}><span>{column.label}</span></th>)}
              </tr>
            </thead>
            <tbody>
              {data.isLoading && <tr><td colSpan={activeColumns.length + 2} className="selection-placeholder">正在读取选款登记…</td></tr>}
              {!data.isLoading && !rows.length && <tr><td colSpan={activeColumns.length + 2} className="selection-placeholder"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无选款登记，点击添加一行开始录入" /></td></tr>}
              {grouped.map((group) => <Fragment key={group.label || "all"}>
                {group.label && <tr className="selection-group-row"><td colSpan={activeColumns.length + 2}>{group.label}<span>{group.rows.length} 条</span></td></tr>}
                {group.rows.map((row, index) => <tr key={row._key} style={{ backgroundColor: fills[row.rowColor || "NONE"] }}>
                  <td className="selection-check"><Checkbox aria-label={`选择 ${row.xutiStyleNo || "未填写序缇款号"}`} checked={selected.includes(row._key)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, row._key] : current.filter((key) => key !== row._key))} /></td>
                  <td className="selection-index">{index + 1}</td>
                  {activeColumns.map((column) => renderCell(row, column.key))}
                </tr>)}
              </Fragment>)}
            </tbody>
          </table>
        </div>
        <div className="selection-bottom-bar">
          <span>直接编辑单元格；图片列粘贴图片网址后即可预览；保存后才写入系统。</span>
          <span>{canEdit ? "填色会随登记一起保存。" : "当前账号仅可查看。"}</span>
        </div>
      </Card>
    </>
  );
}
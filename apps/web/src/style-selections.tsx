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

const statusOptions = [
  { value: "PENDING", label: "待选款", color: "gold" },
  { value: "SELECTED", label: "已入选", color: "green" },
  { value: "REVIEW", label: "待复核", color: "blue" },
  { value: "REJECTED", label: "不选", color: "default" },
];
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
  | "styleNo"
  | "name"
  | "categoryId"
  | "supplierId"
  | "selectionStatus"
  | "selectorId"
  | "estimatedCost"
  | "plannedSampleAt"
  | "sourceUrl"
  | "remark";

const columns: { key: ColumnKey; label: string; width: number; required?: boolean }[] = [
  { key: "styleNo", label: "款号", width: 165, required: true },
  { key: "name", label: "选款名称", width: 220, required: true },
  { key: "categoryId", label: "品类", width: 205 },
  { key: "supplierId", label: "来源供应商", width: 210 },
  { key: "selectionStatus", label: "选款状态", width: 150 },
  { key: "selectorId", label: "选款人", width: 150 },
  { key: "estimatedCost", label: "预估成本", width: 135 },
  { key: "plannedSampleAt", label: "到样日期", width: 155 },
  { key: "sourceUrl", label: "参考链接", width: 245 },
  { key: "remark", label: "备注", width: 260 },
];

const editableKeys = columns.map((column) => column.key);
const clean = (value: unknown) => (value === "" || value === undefined ? null : value);
const sameRow = (a: Row, b: Row) =>
  editableKeys.every((key) => String(clean(a[key]) ?? "") === String(clean(b[key]) ?? "")) &&
  String(a.rowColor || "NONE") === String(b.rowColor || "NONE");

function optionList(rows: Row[], label: (row: Row) => string) {
  return rows.map((row) => ({ value: String(row.id), label: label(row) }));
}

export function StyleSelectionsPage() {
  const canEdit = useCan("selection.manage");
  const { message } = App.useApp();
  const [filterOpen, setFilterOpen] = useState(false);
  const [visible, setVisible] = useState<ColumnKey[]>(columns.map((column) => column.key));
  const [filters, setFilters] = useState({ q: "", status: "", categoryId: "", supplierId: "", selectorId: "" });
  const [groupBy, setGroupBy] = useState<"none" | "status" | "supplier">("none");
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
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
    ...(filters.selectorId ? { selectorId: filters.selectorId } : {}),
    sort,
    direction,
  }).toString();
  const data = useQuery({
    queryKey: ["style-selections", queryString],
    queryFn: () => api("/style-selections?" + queryString),
  });
  const optionData = useQuery({
    queryKey: ["style-selection-options"],
    queryFn: () => api("/style-selections/options"),
  });
  const options = optionData.data?.data || { categories: [], suppliers: [], users: [] };
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
      groupBy === "status"
        ? statusOptions.find((option) => option.value === row.selectionStatus)?.label || "未设置状态"
        : row.supplierName || "未设置供应商";
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
    setRows((current) => [
      { _key: key, styleNo: "", name: "", selectionStatus: "PENDING", rowColor: "NONE" },
      ...current,
    ]);
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
      if (!String(row.styleNo || "").trim()) nextErrors[`${row._key}:styleNo`] = "请填写款号";
      if (!String(row.name || "").trim()) nextErrors[`${row._key}:name`] = "请填写选款名称";
      if (row.sourceUrl && !/^https?:\/\//i.test(row.sourceUrl)) nextErrors[`${row._key}:sourceUrl`] = "链接须以 http:// 或 https:// 开头";
      if (row.estimatedCost && !/^\d+(\.\d{1,2})?$/.test(String(row.estimatedCost))) nextErrors[`${row._key}:estimatedCost`] = "金额最多两位小数";
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
        const body = Object.fromEntries(editableKeys.map((key) => [key, clean(row[key])]));
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
      setErrors(Object.fromEntries(Object.entries(failed).map(([key, value]) => [`${key}:styleNo`, value])));
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
    if (column === "categoryId")
      return <td {...common}><Select disabled={disabled} value={row.categoryId || undefined} allowClear showSearch optionFilterProp="label" placeholder="选择品类" options={optionList(options.categories, (item) => `${item.code} · ${item.pathName}`)} onChange={(value) => update(row._key, column, value || null)} /></td>;
    if (column === "supplierId")
      return <td {...common}><Select disabled={disabled} value={row.supplierId || undefined} allowClear showSearch optionFilterProp="label" placeholder="选择供应商" options={optionList(options.suppliers, (item) => `${item.supplierCode} · ${item.name}`)} onChange={(value) => update(row._key, column, value || null)} /></td>;
    if (column === "selectorId")
      return <td {...common}><Select disabled={disabled} value={row.selectorId || undefined} allowClear showSearch optionFilterProp="label" placeholder="选择人员" options={optionList(options.users, (item) => item.displayName)} onChange={(value) => update(row._key, column, value || null)} /></td>;
    if (column === "selectionStatus")
      return <td {...common}><Select disabled={disabled} value={row.selectionStatus || "PENDING"} options={statusOptions.map(({ value, label }) => ({ value, label }))} onChange={(value) => update(row._key, column, value)} /></td>;
    if (column === "plannedSampleAt")
      return <td {...common}><input disabled={disabled} type="date" value={row.plannedSampleAt || ""} onChange={(event) => update(row._key, column, event.target.value)} /></td>;
    if (column === "estimatedCost")
      return <td {...common}><input disabled={disabled} inputMode="decimal" placeholder="0.00" value={row.estimatedCost || ""} onChange={(event) => update(row._key, column, event.target.value)} /></td>;
    return <td {...common}><input disabled={disabled} value={row[column] || ""} onChange={(event) => update(row._key, column, event.target.value)} placeholder={column === "sourceUrl" ? "https://" : ""} /></td>;
  };

  const filterContent = (
    <div className="selection-popover">
      <Input.Search allowClear placeholder="搜索款号、名称或备注" value={filters.q} onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))} />
      <Select allowClear placeholder="全部选款状态" value={filters.status || undefined} options={statusOptions.map(({ value, label }) => ({ value, label }))} onChange={(value) => setFilters((current) => ({ ...current, status: value || "" }))} />
      <Select allowClear showSearch optionFilterProp="label" placeholder="全部品类" value={filters.categoryId || undefined} options={optionList(options.categories, (item) => item.pathName)} onChange={(value) => setFilters((current) => ({ ...current, categoryId: value || "" }))} />
      <Select allowClear showSearch optionFilterProp="label" placeholder="全部供应商" value={filters.supplierId || undefined} options={optionList(options.suppliers, (item) => `${item.supplierCode} · ${item.name}`)} onChange={(value) => setFilters((current) => ({ ...current, supplierId: value || "" }))} />
      <Select allowClear showSearch optionFilterProp="label" placeholder="全部选款人" value={filters.selectorId || undefined} options={optionList(options.users, (item) => item.displayName)} onChange={(value) => setFilters((current) => ({ ...current, selectorId: value || "" }))} />
      <Button onClick={() => { setFilters({ q: "", status: "", categoryId: "", supplierId: "", selectorId: "" }); setFilterOpen(false); }}>清除筛选</Button>
    </div>
  );

  return (
    <>
      <Header
        title="选款登记"
        subtitle="集中登记候选款，按状态、人员、成本和到样日期推进选款决策。"
        extra={
          canEdit ? <Button type="primary" loading={saving} disabled={!dirtyCount} onClick={save}>保存登记{dirtyCount ? ` (${dirtyCount})` : ""}</Button> : undefined
        }
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
            <Select className="selection-tool-select" value={groupBy} suffixIcon={<TeamOutlined />} options={[{ value: "none", label: "不分组" }, { value: "status", label: "按选款状态分组" }, { value: "supplier", label: "按供应商分组" }]} onChange={setGroupBy} />
            <Select className="selection-tool-select" value={`${sort}:${direction}`} suffixIcon={<SortAscendingOutlined />} options={[
              { value: "updatedAt:desc", label: "最近修改" }, { value: "createdAt:desc", label: "最新登记" }, { value: "styleNo:asc", label: "款号升序" }, { value: "estimatedCost:asc", label: "成本升序" }, { value: "plannedSampleAt:asc", label: "到样日期" },
            ]} onChange={(value) => { const [nextSort, nextDirection] = value.split(":"); setSort(nextSort); setDirection(nextDirection as "asc" | "desc"); }} />
            <Select className="selection-tool-select" value={rowHeight} suffixIcon={<UnorderedListOutlined />} options={[{ value: "compact", label: "紧凑行高" }, { value: "normal", label: "标准行高" }, { value: "loose", label: "宽松行高" }]} onChange={setRowHeight} />
            <Popover trigger="click" content={<div className="selection-color-menu">{colorOptions.map((option) => <Button key={option.value} type="text" onClick={() => applyColor(option.value)}><span className="selection-color-dot" style={{ background: option.color }} />{option.label}</Button>)}</div>}>
              <Button type="text" icon={<BgColorsOutlined />}>填色</Button>
            </Popover>
          </Space>
          <span className="selection-record-count">记录数 {rows.length} <b>·</b> 选中 {selected.length}</span>
        </div>
        <QueryState error={data.error || optionData.error} reload={() => { data.refetch(); optionData.refetch(); }} />
        <div className={`selection-sheet row-${rowHeight}`}>
          <table aria-label="选款登记在线智能表格">
            <thead>
              <tr>
                <th className="selection-check"><Checkbox aria-label="选择全部可见行" checked={!!rows.length && selected.length === rows.length} indeterminate={selected.length > 0 && selected.length < rows.length} onChange={(event) => setSelected(event.target.checked ? rows.map((row) => row._key) : [])} /></th>
                <th className="selection-index">#</th>
                {activeColumns.map((column) => <th key={column.key} style={{ minWidth: column.width }}><span>{column.label}{column.required && <em> *</em>}</span></th>)}
              </tr>
            </thead>
            <tbody>
              {data.isLoading && <tr><td colSpan={activeColumns.length + 2} className="selection-placeholder">正在读取选款登记…</td></tr>}
              {!data.isLoading && !rows.length && <tr><td colSpan={activeColumns.length + 2} className="selection-placeholder"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无选款登记，点击添加一行开始录入" /></td></tr>}
              {grouped.map((group) => <Fragment key={group.label || "all"}>
                {group.label && <tr className="selection-group-row"><td colSpan={activeColumns.length + 2}>{group.label}<span>{group.rows.length} 条</span></td></tr>}
                {group.rows.map((row, index) => <tr key={row._key} style={{ backgroundColor: fills[row.rowColor || "NONE"] }}>
                  <td className="selection-check"><Checkbox aria-label={`选择 ${row.styleNo || "未填写款号"}`} checked={selected.includes(row._key)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, row._key] : current.filter((key) => key !== row._key))} /></td>
                  <td className="selection-index">{index + 1}</td>
                  {activeColumns.map((column) => renderCell(row, column.key))}
                </tr>)}
              </Fragment>)}
            </tbody>
          </table>
        </div>
        <div className="selection-bottom-bar">
          <span>直接编辑单元格；Tab 或 Enter 可继续录入；保存后才写入系统。</span>
          <span>{canEdit ? "填色会随登记一起保存。" : "当前账号仅可查看。"}</span>
        </div>
      </Card>
    </>
  );
}

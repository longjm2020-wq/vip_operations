import { useRef, useState } from "react";
import { Alert, App, Button, Dropdown, Modal, Radio, Space, Table, Tag, Tooltip, Upload } from "antd";
import { DownOutlined, DownloadOutlined, InboxOutlined, UploadOutlined } from "@ant-design/icons";
import { useSelectionWorkspace } from "./selection-workspace";
import { downloadSelectionWorkbook, parseSelectionWorkbook } from "./selection-workbook";
import { downloadVisibleSelectionWorkbook, visibleSelectionWorkbookFields } from "./selection-visible-workbook";
import { selectionLayoutSnapshotSchema, type SelectionField } from "../../../packages/contracts/src/selection-layout.js";
import { selectionImportLimits } from "../../../packages/contracts/src/selection-import-template.js";
import { prepareUpload, readUpload } from "./upload-file";
import type { Row } from "./shared";

export { fetchSelectionRows } from "./selection-data";
import { fetchSelectionRows } from "./selection-data";
const importFileLimitMb = selectionImportLimits.maxFileBytes / (1024 * 1024);

type ExistingStrategy = "OVERWRITE" | "SKIP";
type ImportPreviewRow = {
  values: Row;
  id?: string;
  expectedUpdatedAt?: string;
  operation: "CREATE" | "UPDATE" | "SKIP";
  changedFields: string[];
};
type ImportPlan = {
  rows: ImportPreviewRow[];
  fields: { header: string; key: string; label: string; type: string; isNew: boolean }[];
  fieldRevision: string;
  layoutRevision: number;
  created: number;
  updated: number;
  skipped: number;
};
function isImportPlan(value: unknown): value is ImportPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<ImportPlan>;
  return Array.isArray(plan.rows) && plan.rows.every(row => row && typeof row === "object" &&
    row.values && typeof row.values === "object" && !Array.isArray(row.values) && typeof row.values.xutiStyleNo === "string" && !!row.values.xutiStyleNo.trim() &&
    ["CREATE", "UPDATE", "SKIP"].includes(row.operation) && Array.isArray(row.changedFields) && row.changedFields.every(field => typeof field === "string")) &&
    Array.isArray(plan.fields) && plan.fields.every(field => field && typeof field === "object" &&
      [field.header, field.key, field.label, field.type].every(text => typeof text === "string" && !!text) && typeof field.isNew === "boolean") &&
    typeof plan.fieldRevision === "string" && /^[a-f0-9]{32}$/.test(plan.fieldRevision) &&
    [plan.layoutRevision, plan.created, plan.updated, plan.skipped].every(count => typeof count === "number" && Number.isInteger(count) && count >= 0);
}

export function SelectionTransfer({ canEdit, blocked, selectedRows, filteredRows, columns, ensureLayoutSaved, query, onImported }: {
  canEdit: boolean; blocked: boolean; selectedRows: Row[]; filteredRows?: Row[]; columns: SelectionField[]; ensureLayoutSaved: () => Promise<boolean>; query: string; onImported: () => void | Promise<void>;
}) {
  const { api, title, archiveReferences } = useSelectionWorkspace();
  const { message } = App.useApp();
  const loadLock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [records, setRecords] = useState<Row[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [existingStrategy, setExistingStrategy] = useState<ExistingStrategy | null>(null);
  const key = useRef("");
  const download = async (template: boolean) => {
    if (busy || loadLock.current) return;
    loadLock.current = true;
    setBusy(true); setError(""); setResult("");
    try {
      if (template) { await downloadSelectionWorkbook([], true); return; }
      if (!(await ensureLayoutSaved())) throw Error("请先处理未保存或冲突的字段设置，再导出");
      const records = [...selectedRows];
      if (!records.length) {
        records.push(...(filteredRows ?? (await fetchSelectionRows(query,undefined,undefined,undefined,api)).data));
      }
      const [freshRows, layout] = await Promise.all([
        fetchSelectionRows("",undefined,undefined,undefined,api),
        api("/style-selections/layout-preferences?shared=true"),
      ]);
      const preferences = selectionLayoutSnapshotSchema.parse(layout.data).preferences;
      const exportColumns = visibleSelectionWorkbookFields(columns, preferences);
      const fresh = new Map(freshRows.data.map((row:Row) => [String(row.id),row]));
      for (let index=0;index<records.length;index++) {
        const row = fresh.get(String(records[index].id));
        if (!row) throw Error("导出范围已变化，请刷新后重新选择");
        records[index] = row;
      }
      await downloadVisibleSelectionWorkbook(records, exportColumns, title, { archiveReferences });
    } catch (e) { if (template) setError((e as Error).message); else message.error((e as Error).message); }
    finally { loadLock.current = false; setBusy(false); }
  };
  const preview = async (source: Row[], strategy: ExistingStrategy) => {
    if (!(await ensureLayoutSaved())) throw Error("请先处理未保存或冲突的字段设置，再导入");
    // Keep the parsed rows for policy changes and retries. Uploaded images are
    // replaced in this cache, so changing the policy does not upload them again.
    for (const row of source) for (const image of [...(row.images || []), ...(row.labelImages || [])]) {
        if (!image.url.startsWith("data:image/")) continue;
        const [header, base64] = image.url.split(","), mime = header.slice(5, header.indexOf(";"));
        const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
        const file = await prepareUpload(new File([bytes], "import-image." + mime.split("/")[1], { type: mime }));
        image.url = (await api("/style-selections/images", "POST", { data: await readUpload(file) })).data.url;
    }
    const response = (await api("/style-selections/import/preview", "POST", { rows: source, existingStrategy: strategy })).data;
    if (!isImportPlan(response)) throw Error("导入服务正在更新，请刷新后重新预览");
    setPlan(response);
    key.current = crypto.randomUUID();
  };
  const load = async (file: File) => {
    if (!canEdit || blocked || busy || loadLock.current) return;
    loadLock.current = true;
    setOpen(true); setBusy(true); setError(""); setResult(""); setPlan(null); setRecords(null); setFileName("");
    try {
      if (!/\.xlsx$/i.test(file.name) || file.size > selectionImportLimits.maxFileBytes) throw Error(`请选择不超过 ${importFileLimitMb} MB 的 .xlsx 文件`);
      const parsed = await parseSelectionWorkbook(await file.arrayBuffer());
      setRecords(parsed); setFileName(file.name);
      if (existingStrategy) await preview(parsed, existingStrategy);
    } catch (e) { setError((e as Error).message); }
    finally { loadLock.current = false; setBusy(false); }
  };
  const refreshPreview = async (strategy: ExistingStrategy) => {
    if (!canEdit || blocked || busy || loadLock.current) return;
    setExistingStrategy(strategy); setPlan(null); setError(""); setResult("");
    if (!records) return;
    loadLock.current = true; setBusy(true);
    try { await preview(records, strategy); }
    catch (e) { setError((e as Error).message); }
    finally { loadLock.current = false; setBusy(false); }
  };
  const commit = async () => {
    if (!plan || !existingStrategy || !canEdit || blocked || busy || loadLock.current) return;
    loadLock.current = true;
    setBusy(true); setError("");
    try {
      if (!(await ensureLayoutSaved())) throw Error("请先处理未保存或冲突的字段设置，再导入");
      const response = await api("/style-selections/import", "POST", { rows: plan.rows, existingStrategy, fields: plan.fields, fieldRevision: plan.fieldRevision, layoutRevision: plan.layoutRevision }, key.current);
      setResult(`导入完成：新增 ${response.data.created} 款，覆盖更新 ${response.data.updated} 款，不覆盖 ${response.data.skipped ?? 0} 款`);
      setPlan(null); setRecords(null); setFileName("");
      try { await onImported(); }
      catch { message.warning("资料已导入，表格刷新失败，请刷新页面查看最新字段和资料"); }
    } catch (e) { setError((e as Error).message); }
    finally { loadLock.current = false; setBusy(false); }
  };
  const closeImport = () => { if (busy || loadLock.current) return; setOpen(false); setPlan(null); setRecords(null); setFileName(""); setExistingStrategy(null); };
  const openImport = () => { if (busy || loadLock.current) return; setPlan(null); setRecords(null); setFileName(""); setExistingStrategy(null); setError(""); setResult(""); setOpen(true); };
  return <><Space size={8}>
    <Dropdown trigger={["click"]} disabled={busy} menu={{ items: [{ key: "excel", label: "从 Excel 导入商品" }], onClick: openImport }}><Button aria-label="导入" disabled={busy} icon={<DownloadOutlined />}>导入 <DownOutlined /></Button></Dropdown>
    <Tooltip title={blocked ? "请先处理未保存的修改" : selectedRows.length ? `导出勾选的 ${selectedRows.length} 款` : "导出当前筛选下的全部款式"}><Dropdown trigger={["click"]} disabled={busy || blocked} menu={{ items: [{ key: "excel", label: "导出 Excel" }], onClick: () => { void download(false); } }}><Button aria-label="导出" disabled={busy || blocked} icon={<UploadOutlined />}>导出 <DownOutlined /></Button></Dropdown></Tooltip>
  </Space>
    <Modal title="从 Excel 导入商品" width={960} open={open} maskClosable={!busy} closable={!busy} keyboard={!busy} onCancel={closeImport} footer={<Space><Button disabled={busy} onClick={closeImport}>关闭</Button>{plan && <Button type="primary" loading={busy} disabled={!canEdit || blocked} onClick={() => void commit()}>确认导入</Button>}</Space>}>
      <div className="selection-import-guide"><span>模板包含24个默认字段，创建时间只读。序缇款号必填，可只导入款号和任意单列或多列资料；未提供的字段、空白值及已有创建时间均保留。</span><Button icon={<DownloadOutlined />} disabled={busy} onClick={() => void download(true)}>下载模板</Button></div>
      <div className="selection-import-strategy">
        <strong>相同序缇款号的处理方式</strong>
        <Radio.Group value={existingStrategy} disabled={!canEdit || blocked || busy} onChange={event => void refreshPreview(event.target.value as ExistingStrategy)}>
          <Radio value="SKIP">不覆盖，保留已有款全部资料</Radio>
          <Radio value="OVERWRITE">覆盖，仅更新本次填写的字段</Radio>
        </Radio.Group>
        <p>请选择一种方式后预览，新款均会新增。新表头导入为默认字段之后的自定义字段，初始仅本人可见，确认导入时才创建。</p>
      </div>
      <Upload.Dragger className="selection-import-upload" accept=".xlsx" multiple={false} showUploadList={false} disabled={!canEdit || busy || blocked} beforeUpload={file => { void load(file); return false; }}>
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">点击或拖拽 Excel 文件到这里上传</p>
        <p className="ant-upload-hint">仅支持 .xlsx 文件，不超过 {importFileLimitMb} MB，每次最多 {selectionImportLimits.maxRows} 款</p>
      </Upload.Dragger>
      {(!canEdit || blocked) && <p>{!canEdit ? "当前账号仅可下载模板，导入资料需要编辑权限。" : "请先处理表格中未保存的修改，再上传文件。"}</p>}
      {busy && !plan && <p>正在处理表格资料…</p>}
      {records && <div className="selection-import-file"><span>已读取：{fileName} · {records.length} 款</span>{existingStrategy ? <Button size="small" disabled={busy || blocked || !canEdit} onClick={() => void refreshPreview(existingStrategy)}>重新预览</Button> : <span>请选择已有款处理方式以生成预览。</span>}</div>}
      {error && <Alert type="error" showIcon title={error} />}
      {result && <Alert type="success" showIcon title={result} />}
      {plan && <><p>新增 {plan.created} 款，覆盖更新 {plan.updated} 款，不覆盖 {plan.skipped} 款。覆盖时填写图片或洗唛/吊牌图会分别替换对应图片；空白保留原值。确认后整批写入，任一冲突则整批不写入。</p>
        {plan.fields.some(field => field.isNew) && <Alert type="info" showIcon title="确认导入时新增自定义字段" description={<><span>排在模板默认字段之后，初始仅本人可见：</span>{plan.fields.filter(field => field.isNew).map(field => <Tag key={field.key}>{field.label}</Tag>)}</>} />}
        <Table size="small" rowKey={row => row.values.xutiStyleNo} dataSource={plan.rows} pagination={{ pageSize: 8 }} columns={[{ title: "序缇款号", render: (_, row) => row.values.xutiStyleNo }, { title: "操作", render: (_, row) => row.operation === "CREATE" ? "新增" : row.operation === "UPDATE" ? "覆盖更新" : "不覆盖" }, { title: "本次写入字段", render: (_, row) => row.operation === "SKIP" ? "保留已有款全部资料" : (row.operation === "CREATE" ? ["序缇款号", ...row.changedFields] : row.changedFields).join("、") || "内容与现值相同" }]} />
      </>}
    </Modal></>;
}

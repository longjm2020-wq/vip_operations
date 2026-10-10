import { useRef, useState } from "react";
import { Alert, App, Button, Dropdown, Modal, Space, Table, Tooltip, Upload } from "antd";
import { DownOutlined, DownloadOutlined, InboxOutlined, UploadOutlined } from "@ant-design/icons";
import { useSelectionWorkspace } from "./selection-workspace";
import { downloadSelectionWorkbook, parseSelectionWorkbook } from "./selection-workbook";
import { downloadVisibleSelectionWorkbook, visibleSelectionWorkbookFields } from "./selection-visible-workbook";
import { selectionLayoutSnapshotSchema, type SelectionField } from "../../../packages/contracts/src/selection-layout.js";
import { prepareUpload, readUpload } from "./upload-file";
import type { Row } from "./shared";

export { fetchSelectionRows } from "./selection-data";
import { fetchSelectionRows } from "./selection-data";

export function SelectionTransfer({ canEdit, blocked, selectedRows, filteredRows, columns, ensureLayoutSaved, query, onImported }: {
  canEdit: boolean; blocked: boolean; selectedRows: Row[]; filteredRows?: Row[]; columns: SelectionField[]; ensureLayoutSaved: () => Promise<boolean>; query: string; onImported: () => void;
}) {
  const { api, title, archiveReferences } = useSelectionWorkspace();
  const { message } = App.useApp();
  const loadLock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [plan, setPlan] = useState<Row | null>(null);
  const key = useRef("");
  const download = async (template: boolean) => {
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
    finally { setBusy(false); }
  };
  const load = async (file: File) => {
    if (!canEdit || blocked || busy || loadLock.current) return;
    loadLock.current = true;
    setOpen(true); setBusy(true); setError(""); setResult(""); setPlan(null);
    try {
      if (!/\.xlsx$/i.test(file.name) || file.size > 20 * 1024 * 1024) throw Error("请选择不超过 20 MB 的 .xlsx 文件");
      const records = await parseSelectionWorkbook(await file.arrayBuffer());
      for (const row of records) for (const image of [...(row.images || []), ...(row.labelImages || [])]) {
        if (!image.url.startsWith("data:image/")) continue;
        const [header, base64] = image.url.split(","), mime = header.slice(5, header.indexOf(";"));
        const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
        const file = await prepareUpload(new File([bytes], "import-image." + mime.split("/")[1], { type: mime }));
        image.url = (await api("/style-selections/images", "POST", { data: await readUpload(file) })).data.url;
      }
      setPlan((await api("/style-selections/import/preview", "POST", { rows: records })).data);
      key.current = crypto.randomUUID();
    } catch (e) { setError((e as Error).message); }
    finally { loadLock.current = false; setBusy(false); }
  };
  const commit = async () => {
    if (!plan || !canEdit || blocked || busy) return;
    setBusy(true); setError("");
    try {
      const response = await api("/style-selections/import", "POST", { rows: plan.rows }, key.current);
      setResult(`导入完成：新增 ${response.data.created} 款，更新 ${response.data.updated} 款`);
      setPlan(null); onImported();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const openImport = () => { setPlan(null); setError(""); setResult(""); setOpen(true); };
  return <><Space size={8}>
    <Dropdown trigger={["click"]} disabled={busy} menu={{ items: [{ key: "excel", label: "从 Excel 导入商品", disabled: !canEdit || blocked }, { key: "template", label: "下载模板" }], onClick: ({ key }) => { openImport(); if (key === "template") void download(true); } }}><Button aria-label="导入" disabled={busy} icon={<DownloadOutlined />}>导入 <DownOutlined /></Button></Dropdown>
    <Tooltip title={blocked ? "请先处理未保存的修改" : selectedRows.length ? `导出勾选的 ${selectedRows.length} 款` : "导出当前筛选下的全部款式"}><Dropdown trigger={["click"]} disabled={busy || blocked} menu={{ items: [{ key: "excel", label: "导出 Excel" }], onClick: () => { void download(false); } }}><Button aria-label="导出" disabled={busy || blocked} icon={<UploadOutlined />}>导出 <DownOutlined /></Button></Dropdown></Tooltip>
  </Space>
    <Modal title="从 Excel 导入商品" width={960} open={open} maskClosable={!busy} closable={!busy} onCancel={() => setOpen(false)} footer={<Space><Button disabled={busy} onClick={() => setOpen(false)}>关闭</Button>{plan && <Button type="primary" loading={busy} disabled={!canEdit || blocked} onClick={() => void commit()}>确认导入</Button>}</Space>}>
      <div className="selection-import-guide"><span>请使用模板填写资料，按序缇款号匹配：已有款更新，新款新增。空白字段保留原值，导入前可预览核对。</span><Button icon={<DownloadOutlined />} disabled={busy} onClick={() => void download(true)}>下载模板</Button></div>
      <Upload.Dragger className="selection-import-upload" accept=".xlsx" multiple={false} showUploadList={false} disabled={!canEdit || busy || blocked} beforeUpload={file => { void load(file); return false; }}>
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">点击或拖拽 Excel 文件到这里上传</p>
        <p className="ant-upload-hint">仅支持 .xlsx 文件，不超过 20 MB，每次最多 500 款</p>
      </Upload.Dragger>
      {(!canEdit || blocked) && <p>{!canEdit ? "当前账号仅可下载模板，导入资料需要编辑权限。" : "请先处理表格中未保存的修改，再上传文件。"}</p>}
      {busy && !plan && <p>正在处理表格资料…</p>}
      {error && <Alert type="error" showIcon title={error} />}
      {result && <Alert type="success" showIcon title={result} />}
      {plan && <><p>新增 {plan.created} 款，更新 {plan.updated} 款。空白字段保留原值；填写图片或洗唛/吊牌图会分别替换原有对应图片。确认后整批写入，任一冲突则整批不写入。</p><Table size="small" rowKey={row => row.values.xutiStyleNo} dataSource={plan.rows} pagination={{ pageSize: 8 }} columns={[{ title: "序缇款号", render: (_, row) => row.values.xutiStyleNo }, { title: "操作", render: (_, row) => row.id ? "更新" : "新增" }, { title: "颜色", render: (_, row) => row.values.color || "保留原值" }, { title: "图片", render: (_, row) => row.values.images ? `${row.values.images.length} 张` : "保留原值" }, { title: "洗唛/吊牌图", render: (_, row) => row.values.labelImages ? `${row.values.labelImages.length} 张` : "保留原值" }]} /></>}
    </Modal></>;
}

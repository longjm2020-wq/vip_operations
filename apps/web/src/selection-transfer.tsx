import { useRef, useState } from "react";
import { Alert, Button, Modal, Space, Table, Tooltip } from "antd";
import { api } from "./api";
import { downloadSelectionWorkbook, parseSelectionWorkbook } from "./selection-workbook";
import { prepareUpload, readUpload } from "./upload-file";
import type { Row } from "./shared";

export async function fetchSelectionRows(query: string, sort = "createdAt", direction = "asc") {
  const data: Row[] = []; let total = 0;
  for (let page = 1; ; page++) {
    const response = await api("/style-selections?" + new URLSearchParams({ q: query, page: String(page), pageSize: "100", sort, direction }));
    if (page === 1) total = response.total;
    if (response.total !== total) throw Error("读取期间记录数发生变化，请刷新重试");
    data.push(...response.data);
    if (data.length >= total) break;
    if (!response.data.length) throw Error("资料未读取完整，请重试");
  }
  if (new Set(data.map(row => row.id)).size !== data.length) throw Error("读取期间记录发生变化，请刷新重试");
  return { data, total };
}

export function SelectionTransfer({ canEdit, blocked, selectedRows, query, onImported }: {
  canEdit: boolean; blocked: boolean; selectedRows: Row[]; query: string; onImported: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [plan, setPlan] = useState<Row | null>(null);
  const key = useRef("");
  const download = async (template: boolean) => {
    setBusy(true); setError(""); setResult("");
    try {
      const records = template ? [] : [...selectedRows];
      if (!template && !records.length) {
        records.push(...(await fetchSelectionRows(query)).data);
      }
      if (!template && !records.length) throw Error("没有可导出的款式");
      await downloadSelectionWorkbook(records, template);
    } catch (e) { setError((e as Error).message); setOpen(true); }
    finally { setBusy(false); }
  };
  const load = async (file: File) => {
    setOpen(true); setBusy(true); setError(""); setResult(""); setPlan(null);
    try {
      if (!/\.xlsx$/i.test(file.name) || file.size > 20 * 1024 * 1024) throw Error("请选择不超过 20 MB 的 .xlsx 文件");
      const records = await parseSelectionWorkbook(await file.arrayBuffer());
      for (const row of records) for (const image of row.images || []) {
        if (!image.url.startsWith("data:image/")) continue;
        const [header, base64] = image.url.split(","), mime = header.slice(5, header.indexOf(";"));
        const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
        const file = await prepareUpload(new File([bytes], "import-image." + mime.split("/")[1], { type: mime }));
        image.url = (await api("/style-selections/images", "POST", { data: await readUpload(file) })).data.url;
      }
      setPlan((await api("/style-selections/import/preview", "POST", { rows: records })).data);
      key.current = crypto.randomUUID();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!plan || blocked) return;
    setBusy(true); setError("");
    try {
      const response = await api("/style-selections/import", "POST", { rows: plan.rows }, key.current);
      setResult(`导入完成：新增 ${response.data.created} 款，更新 ${response.data.updated} 款`);
      setPlan(null); onImported();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <><Space size={2}>
    <Tooltip title={blocked ? "请先处理未保存的修改" : selectedRows.length ? `导出勾选的 ${selectedRows.length} 款` : "导出当前筛选下的全部款式"}><Button type="text" disabled={busy || blocked} onClick={() => { setPlan(null); void download(false); }}>按款导出</Button></Tooltip>
    <Button type="text" disabled={!canEdit || busy || blocked} onClick={() => input.current?.click()}>导入资料</Button>
    <Button type="text" disabled={busy} onClick={() => { setPlan(null); void download(true); }}>模板下载</Button>
  </Space><input ref={input} hidden type="file" accept=".xlsx" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void load(file); }} />
    <Modal title="按款导入资料" width={720} open={open} maskClosable={!busy} closable={!busy} onCancel={() => setOpen(false)} footer={<Space><Button disabled={busy} onClick={() => setOpen(false)}>关闭</Button>{plan && <Button type="primary" loading={busy} disabled={blocked} onClick={() => void commit()}>确认导入</Button>}</Space>}>
      {busy && !plan && <p>正在处理表格资料…</p>}
      {error && <Alert type="error" showIcon title={error} />}
      {result && <Alert type="success" showIcon title={result} />}
      {plan && <><p>新增 {plan.created} 款，更新 {plan.updated} 款。空白字段保留原值；填写图片将替换原图片。确认后整批写入，任一冲突则整批不写入。</p><Table size="small" rowKey={row => row.values.xutiStyleNo} dataSource={plan.rows} pagination={{ pageSize: 8 }} columns={[{ title: "序缇款号", render: (_, row) => row.values.xutiStyleNo }, { title: "操作", render: (_, row) => row.id ? "更新" : "新增" }, { title: "颜色", render: (_, row) => row.values.color || "保留原值" }, { title: "图片", render: (_, row) => row.values.images ? `${row.values.images.length} 张` : "保留原值" }]} /></>}
    </Modal></>;
}

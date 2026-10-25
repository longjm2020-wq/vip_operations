import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Collapse, Empty, Modal, Pagination, Progress, Select, Space, Tag } from "antd";
import { SafetyCertificateOutlined } from "@ant-design/icons";
import type { api } from "./api";
import { CopyableCode } from "./copyable-code";
import { selectionStandardsAIPreviewSchema, standardsTargetEligible, type SelectionStandardsAIMode, type SelectionStandardsAIPreview } from "../../../packages/contracts/src/selection-standards-ai.js";
import type { SelectionTitleAiRow } from "./selection-title-ai";
import "./selection-standards-ai.css";

type PreviewRow = SelectionStandardsAIPreview["rows"][number];
type Batch = Omit<SelectionStandardsAIPreview, "rows"> & { rows: (Omit<PreviewRow, "values"> & { values: (PreviewRow["values"][number] & { checked: boolean })[] })[] };
type Props = {
  rows: SelectionTitleAiRow[]; fields: { key: string; label: string }[]; scope: string;
  apiRequest: typeof api; onClose: () => void; onApplied: () => Promise<void>;
};
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败，请重试";
export function SelectionStandardsAi({ rows, fields, scope, apiRequest: request, onClose, onApplied }: Props) {
  const { message } = App.useApp();
  const [mode, setMode] = useState<SelectionStandardsAIMode>("blank");
  const [keys, setKeys] = useState(() => fields.map(field => field.key));
  const [status, setStatus] = useState<{ ready: boolean; message: string } | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [completed, setCompleted] = useState<string[]>([]);
  const [busy, setBusy] = useState<"generate" | "apply" | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [now, setNow] = useState(Date.now());
  const [page, setPage] = useState(1);
  const [saveProgress, setSaveProgress] = useState({ done: 0, total: 0 });
  const alive = useRef(true), running = useRef(false), stop = useRef(false);
  const applyKeys = useRef(new Map<string, { payload: string; key: string }>());
  const eligible = rows.filter(row => keys.some(key => Object.hasOwn(row.values, key) && standardsTargetEligible(mode, row.values[key])));
  const remaining = eligible.filter(row => !completed.includes(row.id));
  const candidates = batches.flatMap(batch => batch.rows.map(row => ({ batch, row })));
  const expired = (batch: Batch) => Date.parse(batch.expiresAt) <= now;
  const expiredBatches = batches.filter(batch => expired(batch));
  const checkedCount = candidates.filter(({ batch }) => !expired(batch)).reduce((sum, { row }) => sum + row.values.filter(value => value.checked && value.value).length, 0);
  const proposedCount = candidates.reduce((sum, { row }) => sum + row.values.filter(value => value.value).length, 0);
  const pendingCount = candidates.reduce((sum, { row }) => sum + row.values.filter(value => !value.value).length, 0);
  const warnings = [...new Set(batches.flatMap(batch => batch.warnings))];
  const checkStatus = async () => {
    setStatusLoading(true);
    try {
      const response = await request("/style-selections/ai-standards/status");
      if (typeof response.data?.ready !== "boolean" || typeof response.data?.message !== "string") throw Error("AI 服务状态暂时无法确认，请刷新后重试");
      if (alive.current) { setStatus(response.data); setError(""); }
    } catch (error) { if (alive.current) { setStatus(null); setError(errorText(error)); } }
    finally { if (alive.current) setStatusLoading(false); }
  };
  useEffect(() => { alive.current = true; void checkStatus(); return () => { alive.current = false; stop.current = true; }; }, []);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 15000); return () => window.clearInterval(timer); }, []);
  const generate = async () => {
    if (running.current || !status?.ready || !keys.length || !remaining.length) return;
    running.current = true; stop.current = false; setBusy("generate"); setStopping(false); setError(""); setResult("");
    const queue = [...remaining], plans = [...batches];
    try {
      for (let offset = 0; offset < queue.length && !stop.current; offset += 5) {
        if (plans.some(batch => batch.rows.length && Date.parse(batch.expiresAt) - Date.now() <= 3 * 60000)) throw Error("候选即将过期，请先确认已生成的内容，再继续剩余款式");
        const group = queue.slice(offset, offset + 5);
        const response = await request("/style-selections/ai-standards/generate", "POST", { rowIds: group.map(row => row.id), targetKeys: keys, mode });
        if (!alive.current) return;
        const parsed = selectionStandardsAIPreviewSchema.safeParse(response.data);
        if (!parsed.success || new Set(parsed.data.rows.map(row => row.id)).size !== parsed.data.rows.length || parsed.data.rows.some(row => !group.some(item => item.id === row.id) ||
          new Set(row.values.map(value => value.key)).size !== row.values.length || row.values.some(value => !keys.includes(value.key)))) throw Error("适配结果格式已变化，请刷新后重试");
        const batch: Batch = { ...parsed.data, rows: parsed.data.rows.map(row => ({ ...row, values: row.values.map(value => ({ ...value, checked: !!value.value && value.value !== value.previousValue })) })) };
        plans.push(batch); setBatches(current => [...current, batch]); setCompleted(current => [...current, ...group.map(row => row.id)]); setNow(Date.now());
      }
    } catch (error) { if (alive.current) setError(`${errorText(error)}。已生成的候选保留。`); }
    finally { running.current = false; if (alive.current) { setBusy(null); setStopping(false); } }
  };
  const apply = async () => {
    if (running.current || !checkedCount) return;
    const selected = batches.filter(batch => Date.parse(batch.expiresAt) > Date.now()).map(batch => ({ batch,
      rows: batch.rows.map(row => ({ id: row.id, values: row.values.filter(value => value.checked && value.value).map(({ key, value }) => ({ key, value })) })).filter(row => row.values.length),
    })).filter(item => item.rows.length);
    running.current = true; stop.current = false; setBusy("apply"); setStopping(false); setError(""); setResult(""); setSaveProgress({ done: 0, total: selected.length });
    let saved = 0;
    try {
      for (const [index, item] of selected.entries()) {
        if (stop.current) break;
        const body = { planToken: item.batch.planToken, rows: item.rows }, payload = JSON.stringify(body);
        const prior = applyKeys.current.get(item.batch.planToken), key = prior?.payload === payload ? prior.key : crypto.randomUUID();
        applyKeys.current.set(item.batch.planToken, { payload, key });
        const response = await request("/style-selections/ai-standards/apply", "POST", body, key);
        if (response.data?.updatedCount !== item.rows.length || !Array.isArray(response.data?.ids)) throw Error("保存结果暂时无法确认，请刷新核对；重试会复用本次保存请求");
        saved += response.data.updatedCount;
        if (!alive.current) break;
        setBatches(current => current.filter(batch => batch.planToken !== item.batch.planToken));
        setSaveProgress({ done: index + 1, total: selected.length }); setResult(`已保存 ${saved} 款的安全类别 / 执行标准`);
      }
    } catch (error) { if (alive.current) setError(`${errorText(error)}。已成功保存的批次保留，未保存的候选可核对后重试。`); }
    finally {
      if (saved) { try { await onApplied(); } catch { void message.warning("资料已保存，表格刷新失败，请手动刷新核对"); } }
      running.current = false; if (alive.current) { setBusy(null); setStopping(false); }
    }
  };
  const clear = () => { setBatches([]); setCompleted([]); setPage(1); setError(""); setResult(""); applyKeys.current.clear(); };
  const removeExpired = () => {
    const tokens = new Set(expiredBatches.map(batch => batch.planToken)), ids = new Set(expiredBatches.flatMap(batch => batch.rows.map(row => row.id)));
    setBatches(current => current.filter(batch => !tokens.has(batch.planToken))); setCompleted(current => current.filter(id => !ids.has(id))); setNow(Date.now());
  };
  const toggle = (token: string, id: string, key: string, checked: boolean) => setBatches(current => current.map(batch => batch.planToken !== token ? batch : {
    ...batch, rows: batch.rows.map(row => row.id !== id ? row : { ...row, values: row.values.map(value => value.key !== key ? value : { ...value, checked }) }),
  }));
  const progress = busy === "apply" ? saveProgress : { done: completed.length, total: eligible.length };
  const activePage = Math.min(page, Math.max(1, Math.ceil(candidates.length / 4)));
  return <Modal open title={<Space><SafetyCertificateOutlined aria-hidden />AI 安全类别与执行标准</Space>} width={860} className="selection-standards-ai"
    onCancel={() => { if (!running.current) onClose(); }} closable={!busy} maskClosable={!busy} keyboard={!busy}
    footer={<Space wrap>{busy ? <Button disabled={stopping} onClick={() => { stop.current = true; setStopping(true); }}>{stopping ? "当前批次完成后停止…" : "停止后续批次"}</Button> : <>
      <Button onClick={onClose}>关闭</Button>
      {!!expiredBatches.length && <Button onClick={removeExpired}>移除过期候选</Button>}
      {!!completed.length && <Button onClick={clear}>清空候选</Button>}
      <Button disabled={statusLoading || !status?.ready || !keys.length || !remaining.length} onClick={() => void generate()}>{completed.length ? "继续适配剩余款式" : "一键适配"}</Button>
      <Button type="primary" disabled={!checkedCount} onClick={() => void apply()}>确认填入 {checkedCount} 个单元格</Button>
    </>}</Space>}>
    <p>范围：{scope} · {eligible.length} 款 · 每批 5 款，自动分批处理</p>
    <Alert type="info" showIcon title="结合商品图片、成分、三级类目和长标题适配，核对后填入" description="会将有权查看的本款商品字段和可读取的商品图发送至 OpenRouter 及模型供应商，产生 API 费用。洗唛/吊牌图不参与适配。请核对建议及其适用条件后确认填入；无法推荐的字段保留原值，建议不代表检测合格。" />
    <Space wrap className="standards-options"><strong>处理方式</strong><Select aria-label="标准适配处理方式" value={mode} disabled={!!busy || !!completed.length} style={{ width: 220 }} onChange={setMode}
      options={[{ value: "blank", label: "仅填补空白" }, { value: "replace", label: "重新适配（含已有内容）" }]} /></Space>
    <div className="standards-options"><strong>处理字段　</strong>{fields.map(field => <Checkbox key={field.key} disabled={!!busy || !!completed.length} checked={keys.includes(field.key)} onChange={event => setKeys(current => event.target.checked ? [...current, field.key] : current.filter(key => key !== field.key))}>{field.label}</Checkbox>)}</div>
    {mode === "replace" && <p>逐格对照原值；只有勾选的建议值会在确认后替换，相同值默认不勾选。</p>}
    {status && !status.ready && <Alert type="warning" showIcon title={status.message} />}
    {!statusLoading && !status?.ready && <Button onClick={() => void checkStatus()}>重新检查 AI 服务</Button>}
    {busy && <div role="status"><p>{busy === "generate" ? "正在适配款式" : "正在保存批次"} · {progress.done} / {progress.total}</p><Progress percent={progress.total ? Math.round(progress.done / progress.total * 100) : 0} size="small" /></div>}
    {error && <Alert type="error" showIcon title={error} />}{result && <Alert type="success" showIcon title={result} />}
    {!!warnings.length && <Alert type="warning" showIcon title={warnings.join("；")} />}
    {!!expiredBatches.length && <Alert type="warning" title="部分候选已过期，请移除后重新适配" />}
    {!!candidates.length && <p role="status">已处理 {completed.length} / {eligible.length} 款 · 建议 {proposedCount} 个单元格 · 待核对 {pendingCount} 个单元格</p>}
    {candidates.slice((activePage - 1) * 4, activePage * 4).map(({ batch, row }) => <section className="standards-candidate" key={`${batch.planToken}:${row.id}`}>
      <div className="standards-heading"><strong><CopyableCode value={row.xutiStyleNo} label="款号" /></strong><Tag color={expired(batch) ? "red" : undefined}>{expired(batch) ? "已过期" : "待核对"}</Tag></div>
      {row.values.map(value => <div className="standards-cell" key={value.key}>
        <Checkbox checked={value.checked} disabled={!!busy || expired(batch) || !value.value || value.value === value.previousValue} onChange={event => toggle(batch.planToken, row.id, value.key, event.target.checked)}>{value.label}</Checkbox>
        <div className="standards-comparison"><div><small>原值</small><span>{value.previousValue || "（空白）"}</span></div><div><small>{!value.value && value.candidateValue ? "AI 候选（暂不可填入）" : "建议值"}</small><strong>{value.value || value.candidateValue || "待补充资料"}</strong></div></div>
        <p className={!value.value ? "standards-pending" : ""}>{value.reason}</p>
        {value.verification && <p className={value.verification.status === "verified" ? "" : "standards-pending"}>{value.verification.message} · 核验时间 {new Date(value.verification.checkedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</p>}
        {!!value.checks.length && <div className="standards-checks"><strong>适用条件待核对</strong><ul>{value.checks.map((check, index) => <li key={index}>{check}</li>)}</ul></div>}
        {value.source && <a href={value.source.url} target="_blank" rel="noreferrer">查看标准来源 · {value.source.name}</a>}
      </div>)}
      {!!row.warnings.length && <p className="standards-pending">{row.warnings.join("；")}</p>}
      <Collapse ghost size="small" items={[{ key: "evidence", label: "查看适配依据", children: <ul>{row.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul> }]} />
      <small>适配规则：{batch.catalogCheckedAt} · 确认前请核对实物、商品资料和适用范围</small>
    </section>)}
    {candidates.length > 4 && <Pagination size="small" current={activePage} pageSize={4} total={candidates.length} showSizeChanger={false} onChange={setPage} />}
    {!eligible.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前方式没有可处理的单元格，可切换为重新适配或调整范围" />}
    <p className="standards-footnote">AI 先分析成人服装的款式、成分和用途，再核验候选标准的官方条目，支持纺织、皮革和毛皮服装，不限预设标准。编号现行不代表本款已检测合格。候选 30 分钟有效；保存前重新核验标准，并检查资料和权限。</p>
  </Modal>;
}

import { CopyableCode } from "./copyable-code";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Collapse, Empty, Input, Modal, Pagination, Progress, Select, Space, Tag, Typography } from "antd";
import { BulbOutlined } from "@ant-design/icons";
import type { api } from "./api";
import { useSelectionWorkspace } from "./selection-workspace";
import type { SelectionField } from "../../../packages/contracts/src/selection-layout.js";
import type { SelectionTitleAICandidate, SelectionTitleAIStatus, SelectionTitleAIRow, SelectionTitleAIPreview, SelectionTitleAIMode } from "../../../packages/contracts/src/selection-title-ai.js";
import { SELECTION_AI_LONG_TITLE_MIN_CHARACTERS, SELECTION_AI_TITLE_COMPLETION_CHARACTERS, selectionTitleMinimumCharacters, selectionTitleTargetEligible, selectionTitleWordingIssue } from "../../../packages/contracts/src/selection-title-ai.js";
import { countTextCharacters } from "../../../packages/contracts/src/selection-field-validation.js";
import "./selection-title-ai.css";

export type SelectionTitleAiRow = { id: string; rowKey: string; xutiStyleNo: string; values: Record<string, string> };
export type SelectionTitleAiField = Pick<SelectionField, "key" | "label" | "textConfig">;
type CandidateTitle = SelectionTitleAICandidate & { checked: boolean };
type CandidateRow = Omit<SelectionTitleAIRow, "titles"> & { titles: CandidateTitle[] };
type CandidateBatch = { planToken: string; expiresAt: string; rows: CandidateRow[]; warnings: string[]; model: string };
export type SelectionTitleAiProps = {
  open: boolean;
  onClose: () => void;
  rows: SelectionTitleAiRow[];
  fields: SelectionTitleAiField[];
  initialFieldKeys: string[];
  initialMode?: SelectionTitleAIMode;
  scopeLabel?: string;
  apiRequest?: typeof api;
  onApplied: () => Promise<void>;
  canConfigureAi?: boolean;
  onConfigureAi?: () => void;
};

const pageSize = 4;
const batchSize = 10;
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败，请重试";
const cellIssue = (title: CandidateTitle) => {
  const value = title.value.trim();
  if (!value) return "标题不能为空";
  if (countTextCharacters(value, "characters") < title.minCharacters) return `长标题至少${title.minCharacters}个字符`;
  if (title.maxCharacters && countTextCharacters(value, "characters") > title.maxCharacters) return `补全后的长标题须为${title.maxCharacters}个字符`;
  return countTextCharacters(value, title.countMode) > title.maxLength ? `超过${title.maxLength}${title.countMode === "han" ? "个汉字" : "个字符"}` : selectionTitleWordingIssue(value) || "";
};
const fieldIssue = (field: SelectionTitleAiField, mode: SelectionTitleAIMode) => {
  const minimum = selectionTitleMinimumCharacters("long", mode);
  return field.label === "长标题" && field.textConfig?.countMode === "characters" && field.textConfig.maxLength < minimum
    ? `长标题字段最多 ${field.textConfig.maxLength} 字符，小于 AI 长标题至少 ${minimum} 字符的要求。请在字段管理中将上限调整至 ${minimum} 或以上。` : "";
};
const modeOptions: { value: SelectionTitleAIMode; label: string }[] = [
  { value: "blank", label: "仅填补空白标题" },
  { value: "complete", label: "补全不足 30 字符的长标题" },
  { value: "improve", label: "基于现有描述完善标题" },
];
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
function validPreview(value: unknown, rowIds: ReadonlySet<string>, targetKeys: ReadonlySet<string>, mode: SelectionTitleAIMode): value is SelectionTitleAIPreview {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<SelectionTitleAIPreview>;
  return typeof plan.planToken === "string" && plan.planToken.length >= 20 && typeof plan.expiresAt === "string" && Number.isFinite(Date.parse(plan.expiresAt)) && typeof plan.model === "string" && stringList(plan.warnings) &&
    Array.isArray(plan.rows) && plan.rows.every(row => row && rowIds.has(row.id) && typeof row.xutiStyleNo === "string" && typeof row.expectedUpdatedAt === "string" && stringList(row.evidence) && stringList(row.warnings) &&
      Array.isArray(row.titles) && row.titles.length <= 2 && row.titles.every(title => title && targetKeys.has(title.key) && typeof title.label === "string" && ["long", "short"].includes(title.kind) && typeof title.value === "string" && Number.isInteger(title.maxLength) && title.maxLength > 0 && ["characters", "han"].includes(title.countMode) &&
        (title.minCharacters === selectionTitleMinimumCharacters(title.kind, mode) || (mode === "blank" && title.minCharacters === undefined)) &&
        (mode === "complete" ? title.kind === "long" && title.maxCharacters === SELECTION_AI_TITLE_COMPLETION_CHARACTERS : title.maxCharacters === undefined) &&
        (mode === "blank" ? title.previousValue === undefined || typeof title.previousValue === "string" : typeof title.previousValue === "string")) && new Set(row.titles.map(title => title.key)).size === row.titles.length) && new Set(plan.rows.map(row => row.id)).size === plan.rows.length;
}

/** Candidates are never sent through grid autosave. The signed apply endpoint
 * rechecks permissions, field limits, unchanged source rows and the signed mode. */
export function SelectionTitleAi({ open, onClose, rows, fields, initialFieldKeys, initialMode = "blank", scopeLabel, apiRequest, onApplied, canConfigureAi = false, onConfigureAi }: SelectionTitleAiProps) {
  const workspace = useSelectionWorkspace();
  const request = apiRequest || workspace.api;
  const { message } = App.useApp();
  const [status, setStatus] = useState<SelectionTitleAIStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [fieldKeys, setFieldKeys] = useState<string[]>([]);
  const [mode, setMode] = useState<SelectionTitleAIMode>(initialMode);
  const [usePoeticName, setUsePoeticName] = useState(true);
  const [instruction, setInstruction] = useState("");
  const [batches, setBatches] = useState<CandidateBatch[]>([]);
  const [completedIds, setCompletedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<"generate" | "apply" | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [resultPage, setResultPage] = useState(1);
  const [now, setNow] = useState(Date.now());
  const [applyProgress, setApplyProgress] = useState({ done: 0, total: 0 });
  const stopAfterBatch = useRef(false);
  const runId = useRef(0);
  const running = useRef(false);
  const applyKeys = useRef(new Map<string, { payload: string; key: string }>());
  const savedRows = useMemo(() => [...new Map(rows.filter(row => row.id).map(row => [row.id, row])).values()], [rows]);
  const candidates = batches.flatMap(batch => batch.rows.map(row => ({ batch, row })));
  const expired = (batch: CandidateBatch) => Date.parse(batch.expiresAt) <= now;
  const expiredBatches = batches.filter(batch => batch.rows.length && expired(batch));
  const expiringSoon = batches.some(batch => batch.rows.length && !expired(batch) && Date.parse(batch.expiresAt) - now <= 3 * 60 * 1000);
  const checkedTitles = candidates.filter(({ batch }) => !expired(batch)).flatMap(({ row }) => row.titles.filter(title => title.checked));
  const invalidChecked = checkedTitles.some(title => !!cellIssue(title));
  const incompatibleFields = fields.filter(field => !!fieldIssue(field, mode));
  const invalidSelectedFields = incompatibleFields.some(field => fieldKeys.includes(field.key));
  const generated = new Set(completedIds);
  const eligibleRows = savedRows.filter(row => fields.some(field => fieldKeys.includes(field.key) && Object.hasOwn(row.values, field.key) &&
    selectionTitleTargetEligible(mode, field.label === "长标题" ? "long" : "short", row.values[field.key])));
  const remaining = eligibleRows.filter(row => !generated.has(row.id));
  const warnings = [...new Set(batches.flatMap(batch => batch.warnings))];
  useEffect(() => { setResultPage(current => Math.min(current, Math.max(1, Math.ceil(candidates.length / pageSize)))); }, [candidates.length]);
  useEffect(() => {
    if (!open || !batches.some(batch => batch.rows.length)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, [open, batches]);

  const checkStatus = async (currentRun = runId.current) => {
    setStatusLoading(true);
    try {
      const response = await request("/style-selections/ai-titles/status");
      if (currentRun !== runId.current) return;
      if (!response.data || typeof response.data.ready !== "boolean" || typeof response.data.message !== "string") throw Error("AI 服务返回格式已变化，请刷新页面后重试");
      setStatus(response.data); setError("");
    } catch (error) {
      if (currentRun === runId.current) { setStatus(null); setError(errorText(error)); }
    } finally { if (currentRun === runId.current) setStatusLoading(false); }
  };
  useEffect(() => {
    runId.current++;
    if (!open) { stopAfterBatch.current = true; return; }
    stopAfterBatch.current = false;
    setMode(initialMode);
    setFieldKeys(initialFieldKeys.filter(key => fields.some(field => field.key === key && (initialMode !== "complete" || field.label === "长标题"))));
    setBatches([]); setCompletedIds([]); setError(""); setResult(""); setResultPage(1);
    setBusy(null); setStopping(false); running.current = false; applyKeys.current.clear();
    setStatus(null);
    setNow(Date.now());
    void checkStatus(runId.current);
  }, [open]);
  useEffect(() => () => { runId.current++; stopAfterBatch.current = true; }, []);

  const clear = () => {
    if (running.current) return;
    setBatches([]); setCompletedIds([]); setError(""); setResult(""); setResultPage(1); applyKeys.current.clear();
  };
  const stop = () => { stopAfterBatch.current = true; setStopping(true); };
  const removeExpired = () => {
    if (running.current) return;
    const tokens = new Set(expiredBatches.map(batch => batch.planToken));
    const ids = new Set(expiredBatches.flatMap(batch => batch.rows.map(row => row.id)));
    setBatches(current => current.filter(batch => !tokens.has(batch.planToken)));
    setCompletedIds(current => current.filter(id => !ids.has(id)));
    for (const token of tokens) applyKeys.current.delete(token);
    setError(""); setResult("过期候选已移除，可继续生成这些款式。");
  };
  const generate = async () => {
    if (running.current || !status?.ready || !fieldKeys.length || invalidSelectedFields || !remaining.length) return;
    running.current = true; stopAfterBatch.current = false;
    setBusy("generate"); setStopping(false); setError(""); setResult("");
    const currentRun = runId.current;
    const queue = [...remaining];
    const activePlans = [...batches];
    try {
      for (let offset = 0; offset < queue.length && !stopAfterBatch.current; offset += batchSize) {
        if (activePlans.some(batch => batch.rows.length && Date.parse(batch.expiresAt) - Date.now() <= 3 * 60 * 1000)) {
          setNow(Date.now());
          setError("候选即将过期，请先确认已生成内容，再继续剩余款式；已过期的候选请移除后重新生成。");
          break;
        }
        const group = queue.slice(offset, offset + batchSize);
        const response = await request("/style-selections/ai-titles/generate", "POST", {
          rowIds: group.map(row => row.id), targetKeys: fieldKeys, mode,
          preferences: { usePoeticName, ...(instruction.trim() ? { instruction: instruction.trim() } : {}) },
        });
        if (currentRun !== runId.current) return;
        const plan: unknown = response.data;
        if (!validPreview(plan, new Set(group.map(row => row.id)), new Set(fieldKeys), mode)) throw Error("标题服务返回格式已变化，请刷新页面后重试");
        const next = { ...plan, rows: plan.rows.map(row => ({ ...row, titles: row.titles.map(title => ({ ...title, minCharacters: selectionTitleMinimumCharacters(title.kind, mode), checked: true })) })) };
        activePlans.push(next);
        setBatches(current => [...current, next]);
        setCompletedIds(current => [...current, ...group.map(row => row.id)]);
        setNow(Date.now());
      }
    } catch (error) { if (currentRun === runId.current) setError(`${errorText(error)}。已生成的候选已保留，可继续生成剩余款式。`); }
    finally {
      if (currentRun === runId.current) { running.current = false; setBusy(null); setStopping(false); }
    }
  };
  const changeTitle = (planToken: string, id: string, key: string, patch: Partial<Pick<CandidateTitle, "value" | "checked">>) => {
    if (running.current) return;
    setBatches(current => current.map(batch => batch.planToken !== planToken ? batch : {
      ...batch, rows: batch.rows.map(row => row.id !== id ? row : { ...row, titles: row.titles.map(title => title.key !== key ? title : { ...title, ...patch }) }),
    }));
  };
  const apply = async () => {
    if (running.current || !checkedTitles.length || invalidChecked) return;
    const selected = batches.filter(batch => !expired(batch)).map(batch => ({
      batch,
      rows: batch.rows.map(row => ({ id: row.id, titles: row.titles.filter(title => title.checked).map(({ key, value }) => ({ key, value })) })).filter(row => row.titles.length),
    })).filter(item => item.rows.length);
    if (selected.some(item => Date.parse(item.batch.expiresAt) <= Date.now())) { setError("候选标题已过期，请清空候选后重新生成。"); return; }
    running.current = true; stopAfterBatch.current = false;
    setBusy("apply"); setStopping(false); setError(""); setResult(""); setApplyProgress({ done: 0, total: selected.length });
    let savedCount = 0;
    try {
      for (const [index, item] of selected.entries()) {
        if (stopAfterBatch.current) break;
        const body = { planToken: item.batch.planToken, rows: item.rows };
        const payload = JSON.stringify(body), existing = applyKeys.current.get(item.batch.planToken);
        const key = existing?.payload === payload ? existing.key : crypto.randomUUID();
        applyKeys.current.set(item.batch.planToken, { payload, key });
        const response = await request("/style-selections/ai-titles/apply", "POST", body, key);
        if (!Number.isInteger(response.data?.updatedCount) || response.data.updatedCount < 0) throw Error("保存结果暂时无法确认，请刷新表格核对；重试会复用本次保存请求。");
        savedCount += response.data.updatedCount;
        setBatches(current => current.filter(batch => batch.planToken !== item.batch.planToken));
        setApplyProgress({ done: index + 1, total: selected.length });
        setResult(mode === "blank" ? `已填补 ${savedCount} 款的空白标题。` : `已更新 ${savedCount} 款的标题。`);
      }
    } catch (error) { setError(`${errorText(error)}。未保存批次的候选已保留；如资料或权限已变化，请清空候选后重新生成。`); }
    finally {
      if (savedCount > 0) {
        try { await onApplied(); }
        catch { message.warning("标题已保存，表格刷新失败，请刷新页面查看最新内容"); }
      }
      running.current = false; setBusy(null); setStopping(false);
    }
  };
  const settingsLocked = !!busy || completedIds.length > 0;
  const progress = busy === "apply" ? applyProgress : { done: completedIds.length, total: eligibleRows.length };
  return <Modal className="selection-title-ai-modal" title={<Space><BulbOutlined aria-hidden />AI 商品标题生成</Space>} open={open} width={760}
    onCancel={() => { if (!running.current) onClose(); }} closable={!busy} maskClosable={!busy} keyboard={!busy}
    footer={<Space wrap>
      {busy ? <Button onClick={stop} disabled={stopping}>{stopping ? "正在完成当前批次…" : busy === "apply" ? "停止后续保存" : "停止后续生成"}</Button> : <>
        <Button onClick={onClose}>关闭</Button>
        {!!expiredBatches.length && <Button onClick={removeExpired}>移除过期候选</Button>}
        {!!completedIds.length && <Button onClick={clear}>清空候选</Button>}
        <Button disabled={statusLoading || !status?.ready || !fieldKeys.length || invalidSelectedFields || !remaining.length} onClick={() => void generate()}>{completedIds.length ? "继续生成剩余款式" : "生成候选标题"}</Button>
        <Button type="primary" disabled={!checkedTitles.length || invalidChecked} onClick={() => void apply()}>{mode === "blank" ? `确认填补 ${checkedTitles.length} 个空白单元格` : `确认更新 ${checkedTitles.length} 个标题单元格`}</Button>
      </>}
    </Space>}>
    <div className="selection-title-ai-scope">范围：{scopeLabel || "当前筛选结果"} · {eligibleRows.length} 款{mode === "blank" ? "有空白标题" : "符合处理条件"} · 每批最多 10 款，自动分批处理</div>
    <Alert type="info" showIcon title="先生成候选，核对后保存" description={`生成会将本范围内有权查看的商品成分、类目、现有描述、图片及少量已有标题示例发送至 OpenRouter 和所选模型供应商，并产生 API 费用。${mode === "blank" ? "已有标题保留" : "确认后替换勾选单元格的原文"}；季节、材质、工艺等必须有资料依据。`} />
    {status && !status.ready && <Alert className="selection-title-ai-alert" type="warning" showIcon title={status.message || "AI 服务尚未配置"} action={canConfigureAi && onConfigureAi ? <Button size="small" onClick={onConfigureAi}>配置 AI 服务</Button> : undefined} description="请联系有系统设置权限的管理员配置 AI 服务后重试。" />}
    {!status && !statusLoading && <Button size="small" onClick={() => void checkStatus()}>重新检查 AI 服务</Button>}
    <div className="selection-title-ai-options">
      <Space wrap className="selection-title-ai-mode"><strong>处理方式</strong><Select aria-label="标题处理方式" value={mode} disabled={settingsLocked} options={modeOptions} onChange={next => { setMode(next); if (next === "complete") setFieldKeys(fields.filter(field => field.label === "长标题").map(field => field.key)); }} /></Space>
      <p className="selection-title-ai-mode-help">{mode === "blank" ? "只填补空白标题，保留已有内容。" : mode === "complete" ? "仅处理空白或不足 30 字符的长标题，基于原文补到恰好 30 字符；汉字、数字、标点均计入，已有 30 字符及以上的标题跳过。" : "仅处理已有内容的标题，保留有依据的原意并完善表达；空白单元格跳过。"}</p>
      <Space wrap><strong>处理字段</strong>{fields.map(field => <Checkbox key={field.key} checked={fieldKeys.includes(field.key)} disabled={settingsLocked || (mode === "complete" && field.label !== "长标题") || (!!fieldIssue(field, mode) && !fieldKeys.includes(field.key))} onChange={event => setFieldKeys(current => event.target.checked ? [...current, field.key] : current.filter(key => key !== field.key))}>{field.label}{field.label === "长标题" ? mode === "complete" ? `（补全至 ${SELECTION_AI_TITLE_COMPLETION_CHARACTERS} 字符；` : `（至少 ${SELECTION_AI_LONG_TITLE_MIN_CHARACTERS} 字符；` : "（"}{field.textConfig ? `最多 ${field.textConfig.maxLength}${field.textConfig.countMode === "han" ? "汉字" : "字符"}）` : `默认最多 ${field.label === "短标题" ? 30 : 60} 字符）`}</Checkbox>)}</Space>
      {!!incompatibleFields.length && <Alert className="selection-title-ai-alert" type="warning" showIcon title={incompatibleFields.map(field => fieldIssue(field, mode)).join("；")} description={mode === "complete" ? "请先调整字段字符上限，或切换其他处理方式。" : invalidSelectedFields ? "当前不能生成长标题；也可取消勾选长标题，仅生成短标题。" : "长标题暂不可勾选；短标题可按原有上限独立生成。"} />}
      <Collapse ghost size="small" items={[{ key: "preferences", label: "标题偏好与规则", children: <>
        <Checkbox checked={usePoeticName} disabled={settingsLocked} onChange={event => setUsePoeticName(event.target.checked)}>结合款式尝试原创诗意款名</Checkbox>
        <Input.TextArea aria-label="标题偏好" value={instruction} disabled={settingsLocked} onChange={event => setInstruction(event.target.value)} maxLength={400} rows={2} placeholder="可填写语气、用词偏好；不会将偏好当作产品事实。" />
        <p>参考本表已有标题格式；长标题至少 {SELECTION_AI_LONG_TITLE_MIN_CHARACTERS} 字符，使用【有依据的卖点】与产品描述。视觉识别后可补充符合实物的季节、风格和常用搜索词，不能为凑字数编造事实；短标题精简。款名避开已知 IP、影视名，候选仍需人工核对。禁止杜撰非遗、材质比例、功效或夸大词。</p>
      </> }]} />
    </div>
    {busy && <div role="status" className="selection-title-ai-progress"><span>{busy === "generate" ? "正在生成候选" : "正在保存标题"} · {progress.done} / {progress.total}{busy === "generate" ? " 款" : " 批"}</span><Progress percent={progress.total ? Math.round(progress.done / progress.total * 100) : 0} size="small" />{stopping && <span>当前请求完成后停止，已完成内容会保留。</span>}</div>}
    {error && <Alert className="selection-title-ai-alert" type="error" showIcon title={error} />}
    {result && <Alert className="selection-title-ai-alert" type="success" showIcon title={result} />}
    {!!warnings.length && <Alert className="selection-title-ai-alert" type="warning" showIcon title={warnings.join("；")} />}
    {!!expiredBatches.length && <Alert className="selection-title-ai-alert" type="warning" showIcon title="部分候选已过期，不能保存" description="移除过期候选后，点击“继续生成剩余款式”重新生成；已保存的款式和其他有效候选保留。" />}
    {!expiredBatches.length && expiringSoon && <Alert className="selection-title-ai-alert" type="warning" showIcon title="候选即将过期，请先确认已生成内容，再继续剩余款式" />}
    {!!candidates.length && <>
      <div className="selection-title-ai-review-heading"><strong>候选标题 · {candidates.length} 款</strong><span>可修改标题、取消勾选。确认后按批保存；原内容及权限发生变化时须重新生成。</span></div>
      <div className="selection-title-ai-candidates">{candidates.slice((resultPage - 1) * pageSize, resultPage * pageSize).map(({ batch, row }) => <section className="selection-title-ai-candidate" key={`${batch.planToken}:${row.id}`}>
        <div className="selection-title-ai-candidate-heading"><strong><CopyableCode value={row.xutiStyleNo} label="款号" /></strong>{expired(batch) ? <Tag color="red">候选已过期</Tag> : <Tag>{batch.model}</Tag>}</div>
        {row.titles.map(title => <div className="selection-title-ai-title" key={title.key}>
          <Checkbox checked={title.checked} disabled={!!busy || expired(batch)} onChange={event => changeTitle(batch.planToken, row.id, title.key, { checked: event.target.checked })}>{title.label}</Checkbox>
          {mode !== "blank" && <div className="selection-title-ai-original" aria-label={`${row.xutiStyleNo} ${title.label}原文`}><strong>原文</strong><span>{title.previousValue?.trim() ? title.previousValue : "（空白）"}</span></div>}
          <Input.TextArea aria-label={`${row.xutiStyleNo} ${title.label}候选`} autoSize={{ minRows: 1, maxRows: 3 }} disabled={!!busy || expired(batch)} status={cellIssue(title) ? "error" : undefined} value={title.value} onChange={event => changeTitle(batch.planToken, row.id, title.key, { value: event.target.value })} />
          <span className={`selection-title-ai-count${cellIssue(title) ? " is-error" : ""}`}>{title.maxCharacters ? `${countTextCharacters(title.value.trim(), "characters")} / ${title.maxCharacters} 字符（补全目标） · ` : title.kind === "long" && title.countMode === "han" ? `${countTextCharacters(title.value.trim(), "characters")} 字符（至少 ${title.minCharacters}） · ` : ""}{countTextCharacters(title.value.trim(), title.countMode)} / {title.maxLength} {title.countMode === "han" ? "汉字" : "字符"}{title.kind === "long" && title.countMode === "characters" && !title.maxCharacters ? `（至少 ${title.minCharacters}）` : ""}{cellIssue(title) ? ` · ${cellIssue(title)}` : ""}</span>
        </div>)}
        {!!row.warnings.length && <div className="selection-title-ai-row-warning" role="status">核对提示：{row.warnings.join("；")}</div>}
        {!!row.evidence.length && <Collapse ghost size="small" items={[{ key: "evidence", label: "查看生成依据", children: <ul>{row.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul> }]} />}
      </section>)}</div>
      {candidates.length > pageSize && <Pagination size="small" current={Math.min(resultPage, Math.ceil(candidates.length / pageSize))} pageSize={pageSize} total={candidates.length} showSizeChanger={false} onChange={setResultPage} />}
      <Typography.Text type="secondary" className="selection-title-ai-footnote">AI 候选可能有误，请核对图片、成分与命名；保存时会再次检查资料、权限和长度。已保存批次不会因后续冲突撤销。</Typography.Text>
    </>}
    {!busy && !eligibleRows.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="此范围没有符合当前处理方式的标题，可切换处理方式或调整字段和选区。" />}
    {!busy && completedIds.length > 0 && !candidates.length && !result && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="资料不足以生成候选，请补充本款资料后重试。" />}
  </Modal>;
}

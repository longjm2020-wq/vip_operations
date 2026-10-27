import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Collapse, Input, InputNumber, Progress, Select, Space, Table, Tag } from "antd";
import { FolderOpenOutlined, PlayCircleOutlined, StopOutlined } from "@ant-design/icons";
import { buildImageBatchPlan, imageKindLabels, type BatchImageItem, type BatchPlan, type ColorFolderMode, type DirectoryLayout, type ImageKind } from "./image-batch-plan";
import { chooseImageDirectory, runImageBatch, scanImageDirectory, scanToItems, supportsImageDirectory, type BatchProgress, type BatchRunResult, type ImageScan, type LocalImageDirectory } from "./image-batch-local";
import "./image-batch-tool.css";

const kindOptions = Object.entries(imageKindLabels).map(([value, label]) => ({ value, label }));
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
function LocalThumbnail({ file, name }: { file?: File; name: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!file?.size) return;
    const objectUrl = URL.createObjectURL(file); setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return url ? <a href={url} target="_blank" rel="noreferrer" title="打开原图"><img className="image-batch-thumb" src={url} alt={name} loading="lazy" /></a> : <span>无法预览</span>;
}
export function ImageBatchTool({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [root, setRoot] = useState<LocalImageDirectory | null>(null);
  const [scan, setScan] = useState<ImageScan | null>(null);
  const [items, setItems] = useState<BatchImageItem[]>([]);
  const [layout, setLayout] = useState<DirectoryLayout>("auto");
  const [folderMode, setFolderMode] = useState<ColorFolderMode>("source");
  const [autoProcess, setAutoProcess] = useState(true);
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState<BatchProgress | null>(null);
  const [error, setError] = useState(""), [result, setResult] = useState<BatchRunResult | null>(null);
  const [onlyIssues, setOnlyIssues] = useState(false), [page, setPage] = useState(1);
  const [selected, setSelected] = useState<React.Key[]>([]), [batchGroup, setBatchGroup] = useState("");
  const [batchKind, setBatchKind] = useState<ImageKind | undefined>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { controller.current?.abort(); onBusyChange(false); }, [onBusyChange]);
  const plan = useMemo(() => buildImageBatchPlan(items, folderMode), [items, folderMode]);
  const targets = useMemo(() => new Map([...plan.entries, ...plan.review].map(entry => [entry.item.id, entry.target])), [plan]);
  const sources = useMemo(() => new Map(scan?.files.map(file => [file.sourcePath, file.file]) || []), [scan]);
  const issueCount = Object.keys(plan.issues).length;
  const totalCount = plan.entries.length + plan.review.length;
  const preview = onlyIssues ? items.filter(item => plan.issues[item.id]?.length) : items;
  const resultBySource = new Map(result?.files.map(file => [file.source, file]) || []);
  const supported = supportsImageDirectory();
  const changeItem = (id: string, patch: Partial<BatchImageItem>) => {
    setItems(current => current.map(item => item.id === id ? { ...item, ...patch, ...(patch.group !== undefined ? { groupNote: "手动设置颜色组" } : {}) } : item)); setResult(null);
  };
  async function execute(directory: LocalImageDirectory, batchPlan: BatchPlan, batchSources: Map<string, File>, active: AbortController) {
    setProgress({ phase: "准备输出目录", completed: 0, total: batchPlan.entries.length + batchPlan.review.length, file: "" });
    const completed = await runImageBatch(directory, batchPlan, batchSources, active.signal, setProgress);
    setResult(completed);
    setProgress({ phase: completed.cancelled ? "已停止" : "整个目录处理结束", completed: completed.files.length, total: completed.total, file: "" });
  }
  async function choose() {
    setBusy(true); setError("");
    const active = new AbortController(); controller.current = active;
    try {
      const directory = await chooseImageDirectory();
      if (autoProcess && await directory.requestPermission({ mode: "readwrite" }) !== "granted") throw Error("未获准写入目录，请在浏览器授权后重试");
      setRoot(directory); setScan(null); setItems([]); setResult(null); setSelected([]); setPage(1); setOnlyIssues(false);
      setProgress({ phase: "查找图片", completed: 0, total: 0, file: directory.name });
      const scanned = await scanImageDirectory(directory, active.signal, setProgress);
      const recognized = scanToItems(directory.name, scanned, layout);
      setScan(scanned); setItems(recognized);
      if (!scanned.files.length) setError("目录中没有 JPG、PNG 或 WebP 图片，请重新选择款号目录或包含款号的上级目录");
      else if (autoProcess) await execute(directory, buildImageBatchPlan(recognized, folderMode), new Map(scanned.files.map(file => [file.sourcePath, file.file])), active);
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === "AbortError")) setError(failure instanceof Error ? failure.message : "读取目录失败");
      setProgress(null);
    } finally { setBusy(false); controller.current = null; }
  }
  async function process() {
    if (!root || !totalCount) return;
    setError(""); setResult(null); setBusy(true);
    const active = new AbortController(); controller.current = active;
    try {
      if (await root.requestPermission({ mode: "readwrite" }) !== "granted") throw Error("未获准写入目录，请在浏览器授权后重试");
      await execute(root, plan, sources, active);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "处理失败，请重试"); }
    finally { setBusy(false); controller.current = null; }
  }
  const successCount = result?.files.filter(file => file.status === "success").length || 0;
  const failedCount = result?.files.filter(file => file.status === "failed").length || 0;
  const reviewCount = result?.files.filter(file => file.status === "review").length || 0;
  return <section className="image-batch-tool" aria-label="本地图片批量命名">
    <p className="image-batch-intro">选择目录后，自动识别并处理整个目录及子目录中的全部图片。自动分组、命名、压缩并保存到本机新文件夹，原图保留。</p>
    {!supported && <Alert type="warning" showIcon title="当前浏览器不支持目录读写" description="请使用桌面版 Chrome 或 Edge 打开本系统。选择目录时，可在系统窗口粘贴本地目录路径。" />}
    <div className="image-batch-controls">
      <label>目录结构<Select aria-label="目录结构" value={layout} disabled={busy} options={[{ value: "auto", label: "自动识别" }, { value: "single", label: "所选目录就是一款" }, { value: "batch", label: "下一级目录分别是款号" }]} onChange={value => { setLayout(value); if (scan && root) setItems(scanToItems(root.name, scan, value)); setResult(null); setSelected([]); setPage(1); }} /></label>
      <label>多色目录命名<Select aria-label="多色目录命名" value={folderMode} disabled={busy} options={[{ value: "source", label: "沿用颜色组名称" }, { value: "numbered", label: "颜色分组文件夹（1）（2）…" }]} onChange={value => { setFolderMode(value); setResult(null); }} /></label>
      <Button icon={<FolderOpenOutlined aria-hidden />} disabled={busy || !supported} onClick={() => void choose()}>选择本地目录</Button>
      <Checkbox checked={autoProcess} disabled={busy} onChange={event => setAutoProcess(event.target.checked)}>识别后自动处理整个目录</Checkbox>
    </div>
    <p className="image-batch-note">在系统选择窗口中粘贴目录路径即可定位。输出款号目录中的“-”自动替换为“X”，如 XFW19-31757L → XFW19X31757L。详情与 826 号图放在款号目录；单色款所有图片直接放在款号目录。多色款的轮播、30、50 号图分颜色保存。</p>
    <Collapse size="small" items={[{ key: "rules", label: "命名、分组与压缩规则", children: <ul className="image-batch-rules">
      <li>方形轮播：1、2、3、4、15～22.jpg，每色最多 12 张，每张 ≤ 1024 KB。</li>
      <li>详情图：按详情自身张数从 601.jpg 到 650.jpg，每款最多 50 张；保留长详情原尺寸。</li>
      <li>透明方形平铺：每色 1 张 30.png，≤ 600 KB；列表图：每色 1 张 50.jpg，≤ 1024 KB；吊牌合格证：每款 1 张 826.jpg，≤ 1024 KB。</li>
      <li>按原文件名自然排序。已有编号、名称提示及尺寸用于识别用途；优先沿用现有颜色目录或文件名标记。混在一起的多色图片，按本款列表图或平铺图的颜色特征自动匹配到颜色组。</li>
      <li>自动处理覆盖所有分页，不依赖勾选。取消「识别后自动处理整个目录」可先调整预览；勾选图片仅用于批量修改用途或颜色。</li>
      <li>颜色无法确定、不透明 30 号图、用途不明或超出编号的图片，原样保存到结果中的「_待确认」目录并记录原因，其余图片继续处理。</li>
      <li>先保留原尺寸压缩 JPEG，仍超限时等比缩小；PNG 必要时等比缩小并保留透明度。不裁切、不拉伸、不自动抠图。原格式和体积均合规时直接复制。</li>
      <li>每批最多 3000 张，每张原图 ≤ 50 MB、4000 万像素。处理过程中保持页面打开；停止后保留已完成文件。修改目录结构会重建预览。</li>
    </ul> }]} />
    {root && <div className="image-batch-summary"><strong>已选目录：{root.name}</strong><span>{plan.styles} 款 · {items.length} 张图片 · 可自动命名 {plan.entries.length} 张 · 原图待确认 {issueCount} 张 · 跳过 {plan.skipped} 张{scan?.ignored ? ` · 忽略其他文件 ${scan.ignored} 个` : ""}</span></div>}
    {error && <Alert type="error" showIcon title={error} />}
    {progress && <div role="status" className="image-batch-progress"><div>{progress.phase}{progress.total ? ` · ${progress.completed} / ${progress.total}` : ""}</div><Progress percent={progress.total ? Math.round(progress.completed / progress.total * 100) : 0} status={busy ? "active" : result?.cancelled || failedCount ? "exception" : undefined} /><small>{progress.file}</small></div>}
    {items.length > 0 && <>
      <Space wrap className="image-batch-bulk">
        <span>批量修改已选 {selected.length} 张 · 处理范围为整个目录 {totalCount} 张</span>
        <Input aria-label="批量颜色组" placeholder="颜色组，如黑色或款号001" value={batchGroup} disabled={busy} onChange={event => setBatchGroup(event.target.value)} />
        <Select aria-label="批量用途" placeholder="批量设置用途" allowClear value={batchKind} options={kindOptions} disabled={busy} onChange={setBatchKind} />
        <Button disabled={busy || !selected.length || (!batchGroup.trim() && !batchKind)} onClick={() => { setItems(current => current.map(item => selected.includes(item.id) ? { ...item, ...(batchGroup.trim() ? { group: batchGroup.trim(), groupNote: "手动设置颜色组" } : {}), ...(batchKind ? { kind: batchKind } : {}) } : item)); setResult(null); }}>应用到选中图片</Button>
        <Checkbox checked={onlyIssues} onChange={event => { setOnlyIssues(event.target.checked); setPage(1); }}>仅看待确认</Checkbox>
      </Space>
      <Table<BatchImageItem> className="image-batch-table" size="small" rowKey="id" dataSource={preview} scroll={{ x: 1160 }} pagination={{ current: page, pageSize: 20, onChange: setPage, showSizeChanger: false }}
        rowSelection={{ selectedRowKeys: selected, onChange: setSelected, getCheckboxProps: () => ({ disabled: busy }) }} columns={[
          { title: "原图", width: 82, render: (_, item) => <LocalThumbnail file={sources.get(item.sourcePath)} name={item.sourcePath} /> },
          { title: "源文件 / 规格", width: 210, render: (_, item) => <div className="image-batch-path"><strong>{item.sourcePath}</strong><small>{item.width} × {item.height} · {kb(item.size)}{item.transparent ? " · 透明" : ""}</small></div> },
          { title: "款号目录", width: 160, render: (_, item) => <Input aria-label={`款号目录 ${item.sourcePath}`} value={item.style} disabled={busy} onChange={event => changeItem(item.id, { style: event.target.value })} /> },
          { title: "颜色组", width: 170, render: (_, item) => <div className="image-batch-path"><Input aria-label={`颜色组 ${item.sourcePath}`} placeholder="单色 / 未分组" value={item.group} disabled={busy || ["detail", "certificate"].includes(item.kind)} onChange={event => changeItem(item.id, { group: event.target.value })} />{item.groupNote && <small>{item.groupNote}</small>}</div> },
          { title: "用途", width: 178, render: (_, item) => <Select aria-label={`用途 ${item.sourcePath}`} value={item.kind} options={kindOptions} disabled={busy} onChange={kind => changeItem(item.id, { kind })} /> },
          { title: "顺序", width: 84, render: (_, item) => <InputNumber aria-label={`顺序 ${item.sourcePath}`} min={1} max={99999} value={item.order} disabled={busy} onChange={order => changeItem(item.id, { order: order || 1 })} /> },
          { title: "输出 / 检查", width: 255, render: (_, item) => { const done = resultBySource.get(item.sourcePath); return <div className="image-batch-path"><span>{targets.get(item.id) || (item.kind === "skip" ? "跳过，不生成文件" : "待确认")}</span>{plan.issues[item.id]?.map(issue => <small className="image-batch-error" key={issue}>{issue}</small>)}{done && <><Tag color={done.status === "success" ? "green" : done.status === "review" ? "orange" : "red"}>{done.status === "success" ? "已完成" : done.status === "review" ? "原图已另存待确认" : "失败"}</Tag><small>{done.status !== "failed" ? `${done.width} × ${done.height} · ${kb(done.afterBytes!)}${done.changed ? " · 已转换/压缩" : " · 原图复制"}` : done.error}</small></>}</div>; } },
        ]} />
    </>}
    {result && <Alert showIcon type={result.cancelled || failedCount || reviewCount || result.reportError ? "warning" : "success"} title={`${result.cancelled ? "已停止" : "处理完成"}：成功 ${successCount} 张，原图另存待确认 ${reviewCount} 张，失败 ${failedCount} 张${result.cancelled ? `，未处理 ${result.total - result.files.length} 张` : ""}`} description={<div className="image-batch-path"><span>保存位置：{root?.name}/{result.directoryName}</span><span>原图保留。输出目录内的「处理清单.json」记录全部处理文件、目标路径、分组依据、待确认原因和结果。</span>{result.reportError && <span>清单保存失败：{result.reportError}</span>}</div>} />}
    <div className="image-batch-actions"><span>{issueCount ? `${issueCount} 张原图将另存「_待确认」，其余图片正常处理` : "处理整个目录及子目录的全部图片；勾选仅用于批量修改"}</span>{busy ? <Button icon={<StopOutlined aria-hidden />} onClick={() => controller.current?.abort()}>停止处理</Button> : <Button type="primary" icon={<PlayCircleOutlined aria-hidden />} disabled={!root || !totalCount} onClick={() => void process()}>{totalCount ? `处理整个目录 ${totalCount} 张` : "处理整个目录"}</Button>}</div>
  </section>;
}

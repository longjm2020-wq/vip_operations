import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Progress, Space } from "antd";
import { DownloadOutlined, CopyOutlined } from "@ant-design/icons";
import { prepareOfficeClipboard, writeOfficeClipboard, type OfficeClipboardCell, type OfficeClipboardImage, type OfficeClipboardPayload } from "./selection-office-clipboard";

export type OfficeCopyRequest = { cells: OfficeClipboardCell[][]; text: string; selected: Set<string> };
type Props = { request: OfficeCopyRequest | null; onClose: () => void; onCopied: (request: OfficeCopyRequest) => void;
  prepare: (images: OfficeClipboardImage[], signal: AbortSignal) => Promise<{ rowId: string; columnKey: string; url: string }[]> };

export function SelectionOfficeCopy({ request, onClose, onCopied, prepare }: Props) {
  const actions = useRef({ prepare, onCopied }); actions.current = { prepare, onCopied };
  const active = useRef<AbortController | null>(null);
  const [retry, setRetry] = useState(0), [payload, setPayload] = useState<OfficeClipboardPayload | null>(null);
  const [phase, setPhase] = useState<"preparing" | "ready" | "copying" | "copied" | "error">("preparing");
  const [completed, setCompleted] = useState(0), [error, setError] = useState(""), [downloading, setDownloading] = useState(false);
  const total = request?.cells.reduce((sum, row) => sum + row.filter(cell => cell.image).length, 0) || 0;
  useEffect(() => {
    if (!request) { setPayload(null); setError(""); setPhase("preparing"); return; }
    const controller = new AbortController(); active.current = controller;
    setPayload(null); setPhase("preparing"); setCompleted(0); setError(""); setDownloading(false);
    const timeout = window.setTimeout(() => controller.abort(), 120_000);
    void prepareOfficeClipboard(request.cells, request.text,
      images => actions.current.prepare(images, controller.signal), controller.signal,
      count => { if (!controller.signal.aborted) setCompleted(count); }).then(async result => {
      if (controller.signal.aborted) return;
      window.clearTimeout(timeout); setPayload(result); setPhase("ready");
      // Switching to WPS while pictures load must not publish a URL-only fallback.
      // Keep the prepared result and request a fresh copy gesture on return.
      if (!document.hasFocus()) return;
      try {
        setPhase("copying"); await writeOfficeClipboard(result);
        if (!controller.signal.aborted) { setPhase("copied"); actions.current.onCopied(request); }
      } catch {
        if (!controller.signal.aborted) { setPhase("ready"); setError("图片已准备，请点击「复制图文」或在此窗口按 Ctrl+C 后再切换到表格。"); }
      }
    }).catch(error => {
      if (active.current === controller) {
        const timedOut = controller.signal.aborted;
        controller.abort();
        setPhase("error"); setError(timedOut ? "图片准备超时，请减少选区后重试" : (error as Error).message || "图片读取失败，请重试");
      }
    }).finally(() => window.clearTimeout(timeout));
    return () => { active.current = null; controller.abort(); window.clearTimeout(timeout); };
  }, [request, retry]);

  const copy = async () => {
    if (!payload || !request || !active.current || phase === "copying") return;
    if (Date.now() >= payload.refreshAfter) { setRetry(value => value + 1); return; }
    const controller = active.current;
    setPhase("copying"); setError("");
    try {
      await writeOfficeClipboard(payload);
      if (!controller.signal.aborted) { setPhase("copied"); actions.current.onCopied(request); }
    } catch {
      if (!controller.signal.aborted) { setPhase("ready"); setError("浏览器未完成图文复制。可在此窗口按 Ctrl+C，或下载带图表格后打开。"); }
    }
  };
  const copyEvent = useCallback((event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault(); event.stopPropagation();
    event.clipboardData.clearData();
    if (!payload || !request || phase === "copying") { event.clipboardData.setData("text/plain", ""); return; }
    if (Date.now() >= payload.refreshAfter) { event.clipboardData.setData("text/plain", ""); setRetry(value => value + 1); return; }
    event.clipboardData.setData("text/plain", payload.text);
    event.clipboardData.setData("text/html", payload.html);
    setPhase("copied"); setError(""); actions.current.onCopied(request);
  }, [payload, request, phase]);
  // The modal focus sentinels are outside modalRender's content. Capture at the
  // document while the dialog is open so keyboard copy also works from them.
  useEffect(() => {
    if (!request) return;
    document.addEventListener("copy", copyEvent, true);
    return () => document.removeEventListener("copy", copyEvent, true);
  }, [request, copyEvent]);
  const download = async () => {
    if (!payload || !active.current) return;
    const controller = active.current; setDownloading(true); setError("");
    try {
      const { officeClipboardWorkbook } = await import("./selection-office-workbook");
      const blob = await officeClipboardWorkbook(payload);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = "表格选区_带图.xlsx"; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) { if (!controller.signal.aborted) setError((error as Error).message || "带图表格下载失败，请重试"); }
    finally { if (!controller.signal.aborted) setDownloading(false); }
  };
  return <Modal title="复制图文到 Excel / WPS" open={!!request} onCancel={onClose} width={620}
    footer={<Space wrap>
      <Button aria-label="关闭复制窗口" onClick={onClose}>{phase === "copied" ? "完成" : "关闭"}</Button>
      {phase === "error" && <Button onClick={() => setRetry(value => value + 1)}>重新准备</Button>}
      <Button icon={<DownloadOutlined />} disabled={!payload} loading={downloading} onClick={() => void download()}>下载带图表格</Button>
      <Button type="primary" aria-label={phase === "copied" ? "再次复制" : "复制图文"} icon={<CopyOutlined />} disabled={!payload} loading={phase === "copying"} onClick={() => void copy()}>{phase === "copied" ? "再次复制" : "复制图文"}</Button>
    </Space>}>
    <p>{request?.cells.length || 0} 行 · {request?.cells[0]?.length || 0} 列 · {total} 张图片（每个图片格第一张）</p>
    {phase === "preparing" ? <><Alert type="info" showIcon title="正在准备图片，尚未完成复制" description="请等待复制完成后再切换到 Excel / WPS。提前切换时可返回此窗口继续复制。" />
      <Progress percent={total ? Math.floor(completed / total * 100) : 0} format={() => `${completed} / ${total}`} /></>
      : phase === "copied" ? <Alert type="success" showIcon title="图文已复制，可切换到 Excel / WPS 粘贴" description="请使用普通粘贴或保留源格式。若目标表格仍只显示地址，请下载带图表格，图片已嵌入文件。" />
      : phase !== "error" && <Alert type="info" showIcon title={phase === "copying" ? "正在写入剪贴板…" : "图片已准备，请点击「复制图文」"} description="也可在此窗口按 Ctrl+C；看到复制完成后，再切换到 Excel / WPS 粘贴。" />}
    {!!error && <Alert style={{ marginTop: 12 }} type={phase === "error" ? "error" : "warning"} showIcon title={phase === "error" ? "本次图文未复制" : "复制提示"} description={error} />}
    <p style={{ marginBottom: 0, marginTop: 12 }}>「下载带图表格」保留可编辑文字及对应图片，打开文件后无需联网加载图片。关闭窗口不修改原表资料。</p>
  </Modal>;
}

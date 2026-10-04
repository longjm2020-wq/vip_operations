import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { App, Button, Dropdown, Progress } from "antd";
import { CloseOutlined, CopyOutlined, DownloadOutlined, FontSizeOutlined, LeftOutlined, LinkOutlined, RightOutlined, RotateLeftOutlined, RotateRightOutlined, ScissorOutlined, SwapOutlined, UndoOutlined, ZoomInOutlined, ZoomOutOutlined } from "@ant-design/icons";
import { copySelectionImage, copySelectionImageAddress, downloadSelectionImage } from "./selection-image-actions";
import { invalidSelectionImage } from "./selection-image-links";
import type { ImageTextProgress, ImageTextRegion } from "./selection-image-text";

export const selectionImageContextItems = [
  { key: "copy-image", label: "复制当前图片", icon: <CopyOutlined /> },
  { key: "download-image", label: "下载当前图片", icon: <DownloadOutlined /> },
  { key: "copy-image-url", label: "复制图片地址", icon: <LinkOutlined /> },
];

type PreviewImage = { id: string; url: string; color: string };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** A modeless image viewer: only the picture and its controls intercept input. */
export function SelectionImagePreview({ images, index, name, onIndexChange, onClose, onTextCopied }: {
  images: PreviewImage[];
  index: number;
  name: string;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onTextCopied: (text: string) => void;
}) {
  const { message } = App.useApp();
  const image = images[Math.min(index, images.length - 1)];
  const imageRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const textPanelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [naturalSize, setNaturalSize] = useState({ width: 640, height: 480 });
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [flipX, setFlipX] = useState(false);
  const [flipY, setFlipY] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const imageKey = `${image.id}:${image.url}`;
  const imageKeyRef = useRef(imageKey);
  imageKeyRef.current = imageKey;
  const textJob = useRef<AbortController | null>(null);
  const [textResult, setTextResult] = useState<{ key: string; phase: "running" | "ready" | "error"; text: string; error?: string; progress?: ImageTextProgress } | null>(null);
  const result = textResult?.key === imageKey ? textResult : null;
  const [cropMode, setCropMode] = useState(false);
  const cropDrag = useRef<{ id: number; x: number; y: number; bounds: DOMRect } | null>(null);
  const [cropRect, setCropRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const fit = Math.min(1, Math.max(1, viewport.width - 32) / naturalSize.width, Math.max(1, viewport.height - 112) / naturalSize.height);
  const width = naturalSize.width * fit, height = naturalSize.height * fit;
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) onCloseRef.current(); };
    window.addEventListener("resize", resize);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("resize", resize); window.removeEventListener("keydown", escape); };
  }, []);
  useEffect(() => {
    setScale(1); setRotate(0); setFlipX(false); setFlipY(false);
    setTextResult(null); setCropMode(false); setCropRect(null); cropDrag.current = null;
    return () => { textJob.current?.abort(); };
  }, [image.id, image.url]);
  useEffect(() => {
    const element = imageRef.current;
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault(); event.stopPropagation();
      if (cropMode) return;
      setScale(current => clamp(current * (event.deltaY < 0 ? 1.2 : 1 / 1.2), 0.25, 8));
    };
    element?.addEventListener("wheel", wheel, { passive: false });
    return () => element?.removeEventListener("wheel", wheel);
  }, [cropMode]);
  useLayoutEffect(() => {
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (closeRef.current) {
      closeRef.current.style.left = `${clamp(rect.right - 40, 8, viewport.width - 40)}px`;
      let top = clamp(rect.top + 8, 8, viewport.height - 40);
      const panel = textPanelRef.current?.getBoundingClientRect(), left = clamp(rect.right - 40, 8, viewport.width - 40);
      if (panel && left + 32 > panel.left && left < panel.right && top + 32 > panel.top && top < panel.bottom) top = Math.max(8, panel.top - 40);
      closeRef.current.style.top = `${top}px`;
    }
    if (toolbarRef.current) {
      const toolbar = toolbarRef.current;
      toolbar.style.left = `${clamp((rect.left + rect.right - toolbar.offsetWidth) / 2, 8, viewport.width - toolbar.offsetWidth - 8)}px`;
      toolbar.style.top = `${clamp(rect.bottom + 8, 8, viewport.height - toolbar.offsetHeight - 8)}px`;
    }
  }, [width, height, scale, rotate, offset.x, offset.y, viewport.width, viewport.height, result?.phase]);
  const recognize = async (region?: ImageTextRegion) => {
    textJob.current?.abort();
    const controller = new AbortController();
    textJob.current = controller;
    const active = () => !controller.signal.aborted && imageKeyRef.current === imageKey && textJob.current === controller;
    setTextResult({ key: imageKey, phase: "running", text: "", progress: { label: "正在准备文字识别…" } });
    try {
      const { recognizeSelectionImageText } = await import("./selection-image-text");
      const text = await recognizeSelectionImageText(image.url, { rotation: rotate, flipX, flipY, region }, controller.signal, progress => {
        if (active()) setTextResult({ key: imageKey, phase: "running", text: "", progress });
      });
      if (!active()) throw new DOMException("识别已取消", "AbortError");
      setTextResult({ key: imageKey, phase: "ready", text });
      return text;
    } catch (error) {
      if (active()) setTextResult({ key: imageKey, phase: "error", text: "", error: error instanceof TypeError ? "无法读取图片，请检查网络；外部图片可能禁止跨域读取" : error instanceof Error ? error.message : "文字识别失败，请重试" });
      throw error;
    } finally {
      if (textJob.current === controller) textJob.current = null;
    }
  };
  const copyText = async () => {
    try {
      const pending = result?.phase === "ready" ? Promise.resolve(result.text) : recognize();
      // Pass the pending OCR result to ClipboardItem while the right-click is
      // still a user gesture. The result remains selectable if copying fails.
      void pending.catch(() => {});
      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": pending.then(text => {
          if (!text.trim()) throw Error("没有可复制的文字");
          return new Blob([text], { type: "text/plain" });
        }) })]);
      } else {
        const text = await pending;
        if (!text.trim()) throw Error("没有可复制的文字");
        await navigator.clipboard.writeText(text);
      }
      const text = await pending;
      if (imageKeyRef.current !== imageKey) return;
      onTextCopied(text); message.success("图片文字已复制，换行会保留在同一单元格内");
    } catch (error) {
      if (imageKeyRef.current === imageKey && !(error instanceof DOMException && error.name === "AbortError")) message.error("未能复制文字，可在识别结果中选中文字后复制");
    }
  };
  const beginCrop = () => {
    textJob.current?.abort(); setTextResult(null); setCropMode(true); setCropRect(null); cropDrag.current = null;
  };
  const selectionRect = (event: PointerEvent<HTMLImageElement>, current: NonNullable<typeof cropDrag.current>) => {
    const x = clamp(event.clientX, current.bounds.left, current.bounds.right), y = clamp(event.clientY, current.bounds.top, current.bounds.bottom);
    return { left: Math.min(current.x, x), top: Math.min(current.y, y), width: Math.abs(x - current.x), height: Math.abs(y - current.y) };
  };
  const startDrag = (event: PointerEvent<HTMLImageElement>) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (cropMode) {
      cropDrag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, bounds: event.currentTarget.getBoundingClientRect() };
      setCropRect({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
      return;
    }
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: offset.x, originY: offset.y };
    setDragging(true);
  };
  const moveDrag = (event: PointerEvent<HTMLImageElement>) => {
    const selection = cropDrag.current;
    if (selection?.id === event.pointerId) { setCropRect(selectionRect(event, selection)); return; }
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const halfWidth = (rotate % 180 ? height : width) * scale / 2, halfHeight = (rotate % 180 ? width : height) * scale / 2;
    setOffset({
      x: clamp(current.originX + event.clientX - current.x, -viewport.width / 2 - halfWidth + 32, viewport.width / 2 + halfWidth - 32),
      y: clamp(current.originY + event.clientY - current.y, -viewport.height / 2 - halfHeight + 32, viewport.height / 2 + halfHeight - 32),
    });
  };
  const stopDrag = () => { drag.current = null; setDragging(false); };
  const finishDrag = (event: PointerEvent<HTMLImageElement>) => {
    const selection = cropDrag.current;
    cropDrag.current = null; setCropRect(null); stopDrag();
    if (!selection || selection.id !== event.pointerId) return;
    const rect = selectionRect(event, selection);
    if (rect.width < 8 || rect.height < 8) return;
    setCropMode(false);
    void recognize({ left: (rect.left - selection.bounds.left) / selection.bounds.width, top: (rect.top - selection.bounds.top) / selection.bounds.height, width: rect.width / selection.bounds.width, height: rect.height / selection.bounds.height }).catch(() => {});
  };
  const cancelDrag = () => { cropDrag.current = null; setCropRect(null); stopDrag(); };
  const reset = () => { setOffset({ x: 0, y: 0 }); setScale(1); setRotate(0); setFlipX(false); setFlipY(false); };
  return createPortal(<section className="selection-image-preview-layer" role="dialog" aria-modal={false} aria-label={`${name}图片预览`} onKeyDown={event => {
    if (event.target instanceof HTMLElement && event.target.closest("input,textarea,[contenteditable=true]")) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (event.key === "ArrowLeft" && index > 0) { event.preventDefault(); onIndexChange(index - 1); }
    if (event.key === "ArrowRight" && index < images.length - 1) { event.preventDefault(); onIndexChange(index + 1); }
  }}>
    <Dropdown trigger={["contextMenu"]} overlayStyle={{ zIndex: 1201 }} menu={{ items: [...selectionImageContextItems, { type: "divider" }, { key: "recognize-text", label: "识别图片文字", icon: <FontSizeOutlined /> }, { key: "crop-text", label: "框选识别文字", icon: <ScissorOutlined /> }, { key: "copy-text", label: "复制图片文字", icon: <CopyOutlined /> }], onClick: ({ key }) => {
      const imageName = `${name}-${index + 1}`;
      if (key === "copy-image") void copySelectionImage(image.url).then(() => message.success("图片已复制")).catch(() => message.error("无法复制图片；外部图片可能禁止跨域读取，可尝试复制图片地址"));
      if (key === "download-image") void downloadSelectionImage(image.url, imageName).then(() => message.success("图片已下载")).catch(() => message.error("无法下载图片；外部图片可能禁止跨域读取，可复制图片地址后打开保存"));
      if (key === "copy-image-url") void copySelectionImageAddress(image.url).then(() => message.success("图片地址已复制")).catch(() => message.error("无法复制图片地址"));
      if (key === "recognize-text") { setCropMode(false); void recognize().catch(() => {}); }
      if (key === "crop-text") beginCrop();
      if (key === "copy-text") { setCropMode(false); void copyText(); }
    } }}><img ref={imageRef} className={`selection-preview-image${dragging ? " is-dragging" : ""}${cropMode ? " is-cropping" : ""}`} src={image.url} alt={`${name} ${image.color || ""} ${index + 1}/${images.length}`} draggable={false} style={{ width, height, transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) rotate(${rotate}deg) scale(${flipX ? -scale : scale}, ${flipY ? -scale : scale})` }} onLoad={event => { const img = event.currentTarget; setNaturalSize({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 }); }} onError={event => { if (event.currentTarget.src !== invalidSelectionImage) event.currentTarget.src = invalidSelectionImage; }} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} onDoubleClick={() => { if (!cropMode) setScale(current => current === 1 ? 2 : 1); }} /></Dropdown>
    {cropRect && <div className="selection-preview-text-crop" style={cropRect} />}
    {cropMode && <div className="selection-preview-crop-hint">拖动框选图片上的文字区域<Button type="text" size="small" onClick={() => { setCropMode(false); cancelDrag(); }}>取消</Button></div>}
    <button ref={closeRef} type="button" className="selection-preview-close" aria-label="关闭图片预览" title="关闭图片预览" onClick={onClose}><CloseOutlined /></button>
    <div ref={toolbarRef} className="selection-preview-toolbar" role="toolbar" aria-label="图片预览工具">
      {images.length > 1 && <><Button type="text" aria-label="上一张大图" title="上一张" icon={<LeftOutlined />} disabled={index === 0} onClick={() => onIndexChange(index - 1)} /><span>{index + 1}/{images.length}</span><Button type="text" aria-label="下一张大图" title="下一张" icon={<RightOutlined />} disabled={index === images.length - 1} onClick={() => onIndexChange(index + 1)} /></>}
      <Button type="text" aria-label="缩小图片" title="缩小" icon={<ZoomOutOutlined />} disabled={cropMode || scale <= 0.25} onClick={() => setScale(current => Math.max(0.25, current / 1.2))} />
      <Button type="text" aria-label="放大图片" title="放大" icon={<ZoomInOutlined />} disabled={cropMode || scale >= 8} onClick={() => setScale(current => Math.min(8, current * 1.2))} />
      <Button type="text" aria-label="向左旋转图片" title="向左旋转" icon={<RotateLeftOutlined />} disabled={cropMode} onClick={() => setRotate(current => current - 90)} />
      <Button type="text" aria-label="向右旋转图片" title="向右旋转" icon={<RotateRightOutlined />} disabled={cropMode} onClick={() => setRotate(current => current + 90)} />
      <Button type="text" aria-label="水平翻转图片" title="水平翻转" icon={<SwapOutlined />} disabled={cropMode} onClick={() => setFlipX(current => !current)} />
      <Button type="text" aria-label="垂直翻转图片" title="垂直翻转" icon={<SwapOutlined rotate={90} />} disabled={cropMode} onClick={() => setFlipY(current => !current)} />
      <Button type="text" aria-label="重置图片预览" title="重置位置和缩放" icon={<UndoOutlined />} disabled={cropMode} onClick={reset} />
      <Button type="text" aria-label="识别图片文字" title="识别图片文字" icon={<FontSizeOutlined />} disabled={result?.phase === "running"} onClick={() => { setCropMode(false); void recognize().catch(() => {}); }} />
      <Button type="text" aria-label="框选识别文字" title="框选识别文字" aria-pressed={cropMode} icon={<ScissorOutlined />} onClick={beginCrop} />
    </div>
    {result && <aside ref={textPanelRef} className="selection-preview-text-panel" aria-label="图片文字识别结果">
      <header><strong>图片文字</strong><Button type="text" size="small" icon={<CloseOutlined />} aria-label="关闭文字结果" onClick={() => { textJob.current?.abort(); setTextResult(null); }} /></header>
      {result.phase === "running" ? <div className="selection-preview-text-status" role="status"><span>{result.progress?.label}{result.progress?.percent === undefined ? "" : ` ${result.progress.percent}%`}</span><Progress percent={result.progress?.percent || 0} showInfo={false} strokeColor="#d3540b" /><Button size="small" onClick={() => { textJob.current?.abort(); setTextResult(null); }}>取消识别</Button></div> : <>
        {result.error ? <p className="selection-preview-text-error" role="alert">{result.error}</p> : <><p>核对后复制，换行保留在同一单元格内。</p><textarea aria-label="图片识别文字" spellCheck={false} value={result.text} onChange={event => setTextResult({ ...result, text: event.target.value })} onCopy={event => { const input = event.currentTarget; const text = input.value.slice(input.selectionStart, input.selectionEnd); if (text) onTextCopied(text); }} /></>}
        <footer><Button size="small" onClick={() => void recognize().catch(() => {})}>重新识别</Button><Button size="small" onClick={beginCrop}>框选识别</Button><Button type="primary" size="small" aria-label="复制文字" icon={<CopyOutlined />} disabled={result.phase !== "ready" || !result.text.trim()} onClick={() => void copyText()}>复制文字</Button></footer>
      </>}
    </aside>}
  </section>, document.body);
}

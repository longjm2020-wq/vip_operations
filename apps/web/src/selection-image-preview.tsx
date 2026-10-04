import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { App, Button, Dropdown } from "antd";
import { CloseOutlined, CopyOutlined, DownloadOutlined, LeftOutlined, LinkOutlined, RightOutlined, RotateLeftOutlined, RotateRightOutlined, SwapOutlined, UndoOutlined, ZoomInOutlined, ZoomOutOutlined } from "@ant-design/icons";
import { copySelectionImage, copySelectionImageAddress, downloadSelectionImage } from "./selection-image-actions";
import { invalidSelectionImage } from "./selection-image-links";

export const selectionImageContextItems = [
  { key: "copy-image", label: "复制当前图片", icon: <CopyOutlined /> },
  { key: "download-image", label: "下载当前图片", icon: <DownloadOutlined /> },
  { key: "copy-image-url", label: "复制图片地址", icon: <LinkOutlined /> },
];

type PreviewImage = { id: string; url: string; color: string };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** A modeless image viewer: only the picture and its controls intercept input. */
export function SelectionImagePreview({ images, index, name, onIndexChange, onClose }: {
  images: PreviewImage[];
  index: number;
  name: string;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const image = images[Math.min(index, images.length - 1)];
  const imageRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
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
  const fit = Math.min(1, Math.max(1, viewport.width - 32) / naturalSize.width, Math.max(1, viewport.height - 112) / naturalSize.height);
  const width = naturalSize.width * fit, height = naturalSize.height * fit;
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) onCloseRef.current(); };
    window.addEventListener("resize", resize);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("resize", resize); window.removeEventListener("keydown", escape); };
  }, []);
  useEffect(() => { setScale(1); setRotate(0); setFlipX(false); setFlipY(false); }, [image.id, image.url]);
  useEffect(() => {
    const element = imageRef.current;
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault(); event.stopPropagation();
      setScale(current => clamp(current * (event.deltaY < 0 ? 1.2 : 1 / 1.2), 0.25, 8));
    };
    element?.addEventListener("wheel", wheel, { passive: false });
    return () => element?.removeEventListener("wheel", wheel);
  }, []);
  useLayoutEffect(() => {
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (closeRef.current) {
      closeRef.current.style.left = `${clamp(rect.right - 40, 8, viewport.width - 40)}px`;
      closeRef.current.style.top = `${clamp(rect.top + 8, 8, viewport.height - 40)}px`;
    }
    if (toolbarRef.current) {
      const toolbar = toolbarRef.current;
      toolbar.style.left = `${clamp((rect.left + rect.right - toolbar.offsetWidth) / 2, 8, viewport.width - toolbar.offsetWidth - 8)}px`;
      toolbar.style.top = `${clamp(rect.bottom + 8, 8, viewport.height - toolbar.offsetHeight - 8)}px`;
    }
  }, [width, height, scale, rotate, offset.x, offset.y, viewport.width, viewport.height]);
  const startDrag = (event: PointerEvent<HTMLImageElement>) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: offset.x, originY: offset.y };
    setDragging(true);
  };
  const moveDrag = (event: PointerEvent<HTMLImageElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const halfWidth = (rotate % 180 ? height : width) * scale / 2, halfHeight = (rotate % 180 ? width : height) * scale / 2;
    setOffset({
      x: clamp(current.originX + event.clientX - current.x, -viewport.width / 2 - halfWidth + 32, viewport.width / 2 + halfWidth - 32),
      y: clamp(current.originY + event.clientY - current.y, -viewport.height / 2 - halfHeight + 32, viewport.height / 2 + halfHeight - 32),
    });
  };
  const stopDrag = () => { drag.current = null; setDragging(false); };
  const reset = () => { setOffset({ x: 0, y: 0 }); setScale(1); setRotate(0); setFlipX(false); setFlipY(false); };
  return createPortal(<section className="selection-image-preview-layer" role="dialog" aria-modal={false} aria-label={`${name}图片预览`} onKeyDown={event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (event.key === "ArrowLeft" && index > 0) { event.preventDefault(); onIndexChange(index - 1); }
    if (event.key === "ArrowRight" && index < images.length - 1) { event.preventDefault(); onIndexChange(index + 1); }
  }}>
    <Dropdown trigger={["contextMenu"]} overlayStyle={{ zIndex: 1201 }} menu={{ items: selectionImageContextItems, onClick: ({ key }) => {
      const imageName = `${name}-${index + 1}`;
      if (key === "copy-image") void copySelectionImage(image.url).then(() => message.success("图片已复制")).catch(() => message.error("无法复制图片；外部图片可能禁止跨域读取，可尝试复制图片地址"));
      if (key === "download-image") void downloadSelectionImage(image.url, imageName).then(() => message.success("图片已下载")).catch(() => message.error("无法下载图片；外部图片可能禁止跨域读取，可复制图片地址后打开保存"));
      if (key === "copy-image-url") void copySelectionImageAddress(image.url).then(() => message.success("图片地址已复制")).catch(() => message.error("无法复制图片地址"));
    } }}><img ref={imageRef} className={`selection-preview-image${dragging ? " is-dragging" : ""}`} src={image.url} alt={`${name} ${image.color || ""} ${index + 1}/${images.length}`} draggable={false} style={{ width, height, transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) rotate(${rotate}deg) scale(${flipX ? -scale : scale}, ${flipY ? -scale : scale})` }} onLoad={event => { const img = event.currentTarget; setNaturalSize({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 }); }} onError={event => { if (event.currentTarget.src !== invalidSelectionImage) event.currentTarget.src = invalidSelectionImage; }} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag} onDoubleClick={() => setScale(current => current === 1 ? 2 : 1)} /></Dropdown>
    <button ref={closeRef} type="button" className="selection-preview-close" aria-label="关闭图片预览" title="关闭图片预览" onClick={onClose}><CloseOutlined /></button>
    <div ref={toolbarRef} className="selection-preview-toolbar" role="toolbar" aria-label="图片预览工具">
      {images.length > 1 && <><Button type="text" aria-label="上一张大图" title="上一张" icon={<LeftOutlined />} disabled={index === 0} onClick={() => onIndexChange(index - 1)} /><span>{index + 1}/{images.length}</span><Button type="text" aria-label="下一张大图" title="下一张" icon={<RightOutlined />} disabled={index === images.length - 1} onClick={() => onIndexChange(index + 1)} /></>}
      <Button type="text" aria-label="缩小图片" title="缩小" icon={<ZoomOutOutlined />} disabled={scale <= 0.25} onClick={() => setScale(current => Math.max(0.25, current / 1.2))} />
      <Button type="text" aria-label="放大图片" title="放大" icon={<ZoomInOutlined />} disabled={scale >= 8} onClick={() => setScale(current => Math.min(8, current * 1.2))} />
      <Button type="text" aria-label="向左旋转图片" title="向左旋转" icon={<RotateLeftOutlined />} onClick={() => setRotate(current => current - 90)} />
      <Button type="text" aria-label="向右旋转图片" title="向右旋转" icon={<RotateRightOutlined />} onClick={() => setRotate(current => current + 90)} />
      <Button type="text" aria-label="水平翻转图片" title="水平翻转" icon={<SwapOutlined />} onClick={() => setFlipX(current => !current)} />
      <Button type="text" aria-label="垂直翻转图片" title="垂直翻转" icon={<SwapOutlined rotate={90} />} onClick={() => setFlipY(current => !current)} />
      <Button type="text" aria-label="重置图片预览" title="重置位置和缩放" icon={<UndoOutlined />} onClick={reset} />
    </div>
  </section>, document.body);
}

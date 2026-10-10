import { Image } from "antd";
import { CloseOutlined, LeftOutlined, LockOutlined, PictureOutlined, RightOutlined } from "@ant-design/icons";
import { useEffect, useLayoutEffect, useRef, useState, type TouchEvent } from "react";
import { type Row } from "./shared";
import { readableSelectionCell } from "./selection-protection";
import { invalidSelectionImage } from "./selection-image-links";
import "./mobile-photo-result-preview.css";

const readable = (row: Row, key: string) =>
  readableSelectionCell(row, key) && !(Array.isArray(row.hiddenCells) && row.hiddenCells.includes(key));

type SwipeStart = { identifier: number; x: number; y: number };

export function MobilePhotoResultPreview({ row }: { row: Row }) {
  const canPreview = readable(row, "images");
  const images: Row[] = canPreview && Array.isArray(row.images)
    ? row.images.filter((image: Row) => image && typeof image.url === "string" && image.url.trim())
    : [];
  const name = readable(row, "xutiStyleNo") && row.xutiStyleNo || readable(row, "supplierStyleNo") && row.supplierStyleNo || "款式";
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const swipe = useRef<SwipeStart | null>(null);
  const current = Math.min(index, Math.max(0, images.length - 1));
  const previewOpen = open && canPreview && images.length > 0;

  useEffect(() => {
    setOpen(false);
    setIndex(0);
    swipe.current = null;
  }, [row.id, canPreview]);
  useLayoutEffect(() => {
    if (!previewOpen) return;
    const trigger = document.activeElement;
    return () => {
      swipe.current = null;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [previewOpen]);

  const startSwipe = (event: TouchEvent<HTMLDivElement>, scale: number) => {
    swipe.current = null;
    if (images.length < 2 || event.touches.length !== 1 || Math.abs(scale - 1) > 0.01) return;
    const touch = event.touches[0];
    swipe.current = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY };
    // At the original size a finger navigates the gallery. Let AntD handle
    // multiple fingers and enlarged-image movement without changing images.
    event.stopPropagation();
  };
  const moveSwipe = (event: TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1) {
      swipe.current = null;
      return;
    }
    if (swipe.current) event.stopPropagation();
  };
  const finishSwipe = (event: TouchEvent<HTMLDivElement>, scale: number) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start) return;
    event.stopPropagation();
    if (event.touches.length || Math.abs(scale - 1) > 0.01) return;
    const touch = Array.from(event.changedTouches).find(value => value.identifier === start.identifier);
    if (!touch) return;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.4) return;
    setIndex(Math.max(0, Math.min(images.length - 1, current + (dx < 0 ? 1 : -1))));
  };

  if (!canPreview || !images.length) return <span className="mobile-photo-result-placeholder" role="img" aria-label={canPreview ? "暂无图片" : "图片受保护"}>
    {canPreview ? <PictureOutlined aria-hidden="true" /> : <LockOutlined aria-hidden="true" />}
    <small>{canPreview ? "暂无图片" : "图片受保护"}</small>
  </span>;

  return <>
    <button type="button" className="mobile-photo-result-preview" aria-label={`预览 ${name} 商品图片`} onClick={event => {
      event.stopPropagation();
      setIndex(0);
      setOpen(true);
    }}>
      <Image src={images[0].url} alt="" loading="lazy" fallback={invalidSelectionImage} preview={false} width={64} height={64} />
      {images.length > 1 && <span className="mobile-photo-result-image-total" aria-hidden="true">{images.length} 张</span>}
    </button>
    {previewOpen && <Image.PreviewGroup
      items={images.map((image, imageIndex) => ({ src: image.url, alt: `${name} 商品图片 ${imageIndex + 1}/${images.length}${image.color ? ` · ${image.color}` : ""}` }))}
      fallback={invalidSelectionImage}
      classNames={{ popup: { root: "mobile-photo-result-image-preview" } }}
      preview={{
        open: true,
        current,
        onOpenChange: value => { if (!value) setOpen(false); },
        onChange: value => { swipe.current = null; setIndex(value); },
        icons: {
          prev: <span role="img" aria-label="上一张"><LeftOutlined aria-hidden="true" /></span>,
          next: <span role="img" aria-label="下一张"><RightOutlined aria-hidden="true" /></span>,
        },
        closeIcon: <span role="img" aria-label="关闭图片预览"><CloseOutlined aria-hidden="true" /></span>,
        countRender: (value, total) => <span className="mobile-photo-result-image-count" aria-live="polite">{value} / {total}</span>,
        imageRender: (node, { transform }) => <div className="mobile-photo-result-swipe"
          onTouchStartCapture={event => startSwipe(event, transform.scale)}
          onTouchMoveCapture={moveSwipe}
          onTouchEndCapture={event => finishSwipe(event, transform.scale)}
          onTouchCancelCapture={() => { swipe.current = null; }}
        >{node}</div>,
        actionsRender: (_, { actions, transform }) => <div className="mobile-photo-result-preview-actions">
          <button type="button" aria-label="缩小图片" disabled={transform.scale <= 1} onClick={actions.onZoomOut}>−</button>
          <button type="button" aria-label="放大图片" onClick={actions.onZoomIn}>＋</button>
          <button type="button" onClick={actions.onReset}>还原图片</button>
          {images.length > 1 && <span>左右滑动切换</span>}
        </div>,
      }}
    />}
  </>;
}

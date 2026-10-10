import { Image } from "antd";
import { CloseOutlined, LeftOutlined, LockOutlined, PictureOutlined, RightOutlined } from "@ant-design/icons";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { type Row } from "./shared";
import { readableSelectionCell } from "./selection-protection";
import { invalidSelectionImage } from "./selection-image-links";
import "./mobile-photo-result-preview.css";

const readable = (row: Row, key: string) =>
  readableSelectionCell(row, key) && !(Array.isArray(row.hiddenCells) && row.hiddenCells.includes(key));

// Keep a small decoded window only while this permitted gallery is open.
// Listing many styles must not download every full-size gallery in advance.
function useAdjacentImages(images: Row[], current: number, open: boolean) {
  const cache = useRef(new Map<string, HTMLImageElement>());
  const clear = () => {
    for (const image of cache.current.values()) {
      image.onload = null;
      image.removeAttribute("src");
    }
    cache.current.clear();
  };
  useEffect(() => {
    if (!open) { clear(); return; }
    const urls = new Set([current, current + 1, current - 1].map(index => images[index]?.url).filter(Boolean) as string[]);
    for (const url of urls) {
      if (cache.current.has(url)) continue;
      const image = new window.Image();
      image.decoding = "async";
      image.fetchPriority = url === images[current]?.url ? "auto" : "low";
      image.onload = () => {
        if (cache.current.get(url) === image && typeof image.decode === "function") void image.decode().catch(() => undefined);
      };
      cache.current.set(url, image);
      image.src = url;
    }
    // A little history makes reversing direction smooth without retaining a
    // whole large gallery. Evict the oldest image outside the active window.
    for (const [url, image] of cache.current) {
      if (cache.current.size <= 5) break;
      if (urls.has(url)) continue;
      image.onload = null;
      image.removeAttribute("src");
      cache.current.delete(url);
    }
  }, [images, current, open]);
  useEffect(() => clear, []);
}

type SwipeStart = { identifier: number; x: number; y: number; horizontal: boolean };

function PhotoSwipeSurface({ children, scale, current, total, onStep }: {
  children: ReactNode; scale: number; current: number; total: number; onStep: (offset: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const swipe = useRef<SwipeStart | null>(null);
  const frame = useRef<number | null>(null);
  const offset = useRef(0);
  const reset = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    offset.current = 0;
    swipe.current = null;
    if (track.current) {
      track.current.style.transform = "";
      track.current.style.willChange = "";
    }
  };
  useLayoutEffect(() => { reset(); return reset; }, [current, scale]);
  const startSwipe = (event: TouchEvent<HTMLDivElement>) => {
    reset();
    if (total < 2 || event.touches.length !== 1 || Math.abs(scale - 1) > 0.01) return;
    const touch = event.touches[0];
    swipe.current = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY, horizontal: false };
    event.stopPropagation();
  };
  const moveSwipe = (event: TouchEvent<HTMLDivElement>) => {
    const start = swipe.current;
    if (!start) return;
    if (event.touches.length !== 1) { reset(); return; }
    event.stopPropagation();
    const touch = Array.from(event.touches).find(value => value.identifier === start.identifier);
    if (!touch) { reset(); return; }
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (!start.horizontal && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.4) start.horizontal = true;
    if (!start.horizontal) return;
    const atEdge = dx > 0 ? current === 0 : current === total - 1;
    offset.current = dx * (atEdge ? 0.2 : 1);
    if (frame.current !== null) return;
    // Touch events can arrive faster than a screen refresh. Move just this
    // compositor layer once per frame instead of rendering the result list.
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (!track.current) return;
      track.current.style.willChange = "transform";
      track.current.style.transform = `translate3d(${offset.current}px, 0, 0)`;
    });
  };
  const finishSwipe = (event: TouchEvent<HTMLDivElement>) => {
    const start = swipe.current;
    reset();
    if (!start) return;
    event.stopPropagation();
    if (event.touches.length || Math.abs(scale - 1) > 0.01) return;
    const touch = Array.from(event.changedTouches).find(value => value.identifier === start.identifier);
    if (!touch) return;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.4) return;
    onStep(dx < 0 ? 1 : -1);
  };
  return <div className="mobile-photo-result-swipe"
    onTouchStartCapture={startSwipe}
    onTouchMoveCapture={moveSwipe}
    onTouchEndCapture={finishSwipe}
    onTouchCancelCapture={reset}
  ><div ref={track} className="mobile-photo-result-swipe-track">{children}</div></div>;
}

export function MobilePhotoResultPreview({ row }: { row: Row }) {
  const canPreview = readable(row, "images");
  const images: Row[] = useMemo(() => canPreview && Array.isArray(row.images)
    ? row.images.filter((image: Row) => image && typeof image.url === "string" && image.url.trim())
    : [], [row.images, canPreview]);
  const name = readable(row, "xutiStyleNo") && row.xutiStyleNo || readable(row, "supplierStyleNo") && row.supplierStyleNo || "款式";
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const current = Math.min(index, Math.max(0, images.length - 1));
  const previewOpen = open && canPreview && images.length > 0;
  const items = useMemo(() => images.map((image, imageIndex) => ({
    src: image.url, decoding: "async" as const,
    alt: `${name} 商品图片 ${imageIndex + 1}/${images.length}${image.color ? ` · ${image.color}` : ""}`,
  })), [images, name]);
  useAdjacentImages(images, current, previewOpen);

  useEffect(() => {
    setOpen(false);
    setIndex(0);
  }, [row.id, canPreview]);
  useLayoutEffect(() => {
    if (!previewOpen) return;
    const trigger = document.activeElement;
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [previewOpen]);

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
      <Image src={images[0].url} alt="" loading="lazy" decoding="async" fallback={invalidSelectionImage} preview={false} width={64} height={64} />
      {images.length > 1 && <span className="mobile-photo-result-image-total" aria-hidden="true">{images.length} 张</span>}
    </button>
    {previewOpen && <Image.PreviewGroup
      items={items}
      fallback={invalidSelectionImage}
      classNames={{ popup: { root: "mobile-photo-result-image-preview" } }}
      preview={{
        open: true,
        current,
        onOpenChange: value => { if (!value) setOpen(false); },
        onChange: setIndex,
        icons: {
          prev: <span role="img" aria-label="上一张"><LeftOutlined aria-hidden="true" /></span>,
          next: <span role="img" aria-label="下一张"><RightOutlined aria-hidden="true" /></span>,
        },
        closeIcon: <span role="img" aria-label="关闭图片预览"><CloseOutlined aria-hidden="true" /></span>,
        countRender: (value, total) => <span className="mobile-photo-result-image-count" aria-live="polite">{value} / {total}</span>,
        imageRender: (node, { transform }) => <PhotoSwipeSurface scale={transform.scale} current={current} total={images.length}
          onStep={offset => setIndex(value => Math.max(0, Math.min(images.length - 1, Math.min(value, images.length - 1) + offset)))}
        >{node}</PhotoSwipeSurface>,
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

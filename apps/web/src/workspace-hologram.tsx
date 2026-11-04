import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Alert, Button } from "antd";
import {
  AimOutlined,
  CloseOutlined,
  DragOutlined,
  MinusOutlined,
  PictureOutlined,
  PlusOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import type { AgentFile } from "../../../packages/contracts/src/assistant-agent";
import {
  useWorkspaceSceneCover,
  useWorkspacePresence,
  type WorkspacePresence,
} from "./workspace-scene-presence";
import "./workspace-hologram.css";

type Media = {
  name: string;
  url: string;
  kind: "image" | "video";
  local: boolean;
};
type View = { pitch: number; yaw: number; zoom: number };
const initialView = (): View => ({ pitch: 0, yaw: 0, zoom: 1 });
export const workspaceHologramEvent = "xuti-workspace-hologram";
// One-use, in-memory handoff survives navigation, without persisting a media URL or user file.
let queuedMedia: Media | null = null;
export function showWorkspaceHologram(
  file: Pick<AgentFile, "id" | "name" | "mime">,
) {
  if (
    !file.id ||
    (!file.mime.startsWith("image/") && !file.mime.startsWith("video/"))
  )
    return;
  queuedMedia = {
    name: file.name,
    kind: file.mime.startsWith("video/") ? "video" : "image",
    url: `/api/v1/my-workspace/assistant/files/${encodeURIComponent(file.id)}/content`,
    local: false,
  };
  window.dispatchEvent(new Event(workspaceHologramEvent));
}

export function WorkspaceHologram({
  onPresenceChange,
}: {
  onPresenceChange: (phase: WorkspacePresence) => void;
}) {
  const [open, setOpen] = useState(false),
    [media, setMedia] = useState<Media | null>(null),
    [error, setError] = useState("");
  const presence = useWorkspacePresence(open);
  const rendered = open || presence !== "closed";
  useWorkspaceSceneCover(open);
  useLayoutEffect(
    () => onPresenceChange(presence),
    [presence, onPresenceChange],
  );
  const [host, setHost] = useState<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null),
    input = useRef<HTMLInputElement>(null),
    screen = useRef<HTMLDivElement>(null),
    handle = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement | null>(null),
    localUrl = useRef<string | null>(null),
    releaseAfterExit = useRef(false),
    view = useRef(initialView()),
    frame = useRef(0);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    pitch: number;
    yaw: number;
  } | null>(null);
  const videoRef = useCallback((element: HTMLVideoElement | null) => {
    if (video.current && video.current !== element) video.current.pause();
    video.current = element;
  }, []);
  const paint = () => {
    frame.current = 0;
    const target = screen.current;
    if (!target) return;
    const { pitch, yaw, zoom } = view.current;
    target.style.setProperty("--hologram-pitch", `${pitch}deg`);
    target.style.setProperty("--hologram-yaw", `${yaw}deg`);
    target.style.setProperty("--hologram-zoom", String(zoom));
    target.dataset.hologramPitch = String(pitch);
    target.dataset.hologramYaw = String(yaw);
    target.dataset.hologramZoom = String(zoom);
    const output = target.querySelector("output");
    const label = `${Math.round(zoom * 100)}%`;
    if (output && output.textContent !== label) output.textContent = label;
  };
  const schedulePaint = () => {
    if (!frame.current) frame.current = requestAnimationFrame(paint);
  };
  const stopDrag = () => {
    if (frame.current) cancelAnimationFrame(frame.current);
    const previous = drag.current;
    drag.current = null;
    screen.current?.removeAttribute("data-dragging");
    if (previous && handle.current?.hasPointerCapture(previous.id))
      handle.current.releasePointerCapture(previous.id);
    paint();
  };
  const reset = () => {
    stopDrag();
    view.current = initialView();
    paint();
  };
  const zoom = (factor: number) => {
    view.current.zoom = Math.max(
      0.5,
      Math.min(3, Math.round(view.current.zoom * factor * 100) / 100),
    );
    paint();
  };
  const releaseLocal = () => {
    video.current?.pause();
    if (localUrl.current) URL.revokeObjectURL(localUrl.current);
    localUrl.current = null;
  };
  const choose = (file: File | undefined) => {
    if (!file) return;
    const image = /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(file.name),
      movie = /\.(mp4|webm|og[gv]|mov)$/i.test(file.name);
    if (!image && !movie) {
      setError(
        "请选择 PNG、JPEG、WebP、GIF、AVIF、BMP 图片，或 MP4、WebM、Ogg、MOV 视频。",
      );
      return;
    }
    releaseLocal();
    localUrl.current = URL.createObjectURL(file);
    setMedia({
      name: file.name,
      url: localUrl.current,
      kind: movie ? "video" : "image",
      local: true,
    });
    setError("");
    reset();
  };
  const close = () => {
    stopDrag();
    video.current?.pause();
    view.current = initialView();
    releaseAfterExit.current = true;
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    // Only release an explicitly closed preview. The initial closed render can
    // accept a queued assistant file before its state update has committed.
    if (open || presence !== "closed" || !releaseAfterExit.current) return;
    releaseAfterExit.current = false;
    if (localUrl.current) URL.revokeObjectURL(localUrl.current);
    localUrl.current = null;
    setMedia(null);
    setError("");
  }, [open, presence]);
  useEffect(() => {
    setHost(
      trigger.current?.closest<HTMLElement>(".personal-workspace") || null,
    );
    const acceptQueued = () => {
      if (!queuedMedia) return;
      const next = queuedMedia;
      queuedMedia = null;
      releaseAfterExit.current = false;
      video.current?.pause();
      if (localUrl.current) URL.revokeObjectURL(localUrl.current);
      localUrl.current = null;
      view.current = initialView();
      setMedia(next);
      setError("");
      setOpen(true);
    };
    const visibility = () => {
      if (document.hidden) video.current?.pause();
    };
    window.addEventListener(workspaceHologramEvent, acceptQueued);
    document.addEventListener("visibilitychange", visibility);
    acceptQueued();
    return () => {
      window.removeEventListener(workspaceHologramEvent, acceptQueued);
      document.removeEventListener("visibilitychange", visibility);
      if (frame.current) cancelAnimationFrame(frame.current);
      video.current?.pause();
      if (localUrl.current) URL.revokeObjectURL(localUrl.current);
      localUrl.current = null;
    };
  }, []);
  useEffect(() => {
    if (open && host) {
      paint();
      handle.current?.focus({ preventScroll: true });
    }
  }, [open, host, media]);
  useLayoutEffect(() => {
    if (!rendered || !host) return;
    let layoutFrame = 0;
    let captions: HTMLElement | null = null,
      composer: HTMLElement | null = null;
    const schedule = () => {
      if (!layoutFrame)
        layoutFrame = requestAnimationFrame(() => {
          layoutFrame = 0;
          place();
        });
    };
    const observer = new ResizeObserver(schedule);
    const write = (element: HTMLElement, name: string, value: string) => {
      if (element.style.getPropertyValue(name) !== value)
        element.style.setProperty(name, value);
    };
    const place = () => {
      const target = screen.current;
      if (!target) return;
      const nextCaptions = host.querySelector<HTMLElement>(
        ".workspace-voice-slot",
      );
      const nextComposer =
        host.querySelector<HTMLElement>(".assistant-compose");
      if (captions !== nextCaptions) {
        if (captions) observer.unobserve(captions);
        captions = nextCaptions;
        if (captions) observer.observe(captions);
      }
      if (composer !== nextComposer) {
        if (composer) observer.unobserve(composer);
        composer = nextComposer;
        if (composer) observer.observe(composer);
      }
      const hostBox = host.getBoundingClientRect();
      const captionBox = captions?.getBoundingClientRect();
      const top = Math.max(
        innerWidth <= 700 ? 100 : 60,
        captionBox && captionBox.height > 0
          ? captionBox.bottom - hostBox.top + 16
          : 0,
      );
      const composerBox = composer?.getBoundingClientRect();
      const errorHeight =
        target
          .querySelector(".workspace-hologram-error")
          ?.getBoundingClientRect().height || 0;
      // Short viewports grow the page instead of covering microphone controls or the composer.
      write(
        host,
        "--hologram-reserved-height",
        `${top + 180 + 90 + errorHeight + (composerBox?.height || 0) + 48}px`,
      );
      const bottom =
        composerBox && composerBox.height > 0
          ? composerBox.top - hostBox.top - 20
          : host.clientHeight - 24;
      write(target, "top", `${top}px`);
      write(
        target,
        "--hologram-media-height",
        `${Math.max(180, bottom - top - 88 - errorHeight)}px`,
      );
    };
    observer.observe(host);
    const mutations = new MutationObserver(schedule);
    mutations.observe(host, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    place();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      if (layoutFrame) cancelAnimationFrame(layoutFrame);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      host.style.removeProperty("--hologram-reserved-height");
    };
  }, [rendered, host]);
  const start = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      pitch: view.current.pitch,
      yaw: view.current.yaw,
    };
    screen.current?.setAttribute("data-dragging", "true");
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    view.current.pitch =
      Math.round(
        Math.max(
          -20,
          Math.min(20, current.pitch - (event.clientY - current.y) * 0.16),
        ) * 10,
      ) / 10;
    view.current.yaw =
      Math.round(
        Math.max(
          -28,
          Math.min(28, current.yaw + (event.clientX - current.x) * 0.16),
        ) * 10,
      ) / 10;
    schedulePaint();
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label="全息影像屏"
        title="全息影像屏"
        aria-expanded={open}
        onClick={() => {
          if (open) close();
          else {
            releaseAfterExit.current = false;
            releaseLocal();
            setMedia(null);
            setError("");
            setOpen(true);
          }
        }}
      >
        <PictureOutlined />
      </button>
      {rendered &&
        host &&
        createPortal(
          <div
            ref={screen}
            className="workspace-hologram"
            role="dialog"
            aria-label="全息影像屏"
            aria-modal="false"
            data-hologram-presence={presence}
            inert={!open}
            aria-hidden={!open}
            data-world-ui
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                close();
              }
            }}
          >
            <header className="workspace-hologram-header">
              <button
                ref={handle}
                className="workspace-hologram-grip"
                type="button"
                aria-label="调整全息影像视角"
                title="拖动调整视角，方向键微调，Home 复位"
                onPointerDown={start}
                onPointerMove={move}
                onPointerUp={stopDrag}
                onPointerCancel={stopDrag}
                onLostPointerCapture={stopDrag}
                onKeyDown={(event) => {
                  const directions: Record<string, [number, number]> = {
                    ArrowLeft: [-3, 0],
                    ArrowRight: [3, 0],
                    ArrowUp: [0, -3],
                    ArrowDown: [0, 3],
                  };
                  if (directions[event.key]) {
                    event.preventDefault();
                    const [x, y] = directions[event.key];
                    view.current.yaw = Math.max(
                      -28,
                      Math.min(28, view.current.yaw + x),
                    );
                    view.current.pitch = Math.max(
                      -20,
                      Math.min(20, view.current.pitch + y),
                    );
                    paint();
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    reset();
                  }
                }}
              >
                <DragOutlined />
                <span>全息影像屏</span>
              </button>
              <span className="workspace-hologram-name" title={media?.name}>
                {media?.name || ""}
              </span>
              <Button
                type="text"
                size="small"
                icon={<CloseOutlined />}
                aria-label="关闭全息影像屏"
                onClick={close}
              />
            </header>
            <div className="workspace-hologram-stage">
              <div className="workspace-hologram-plane">
                <div className="workspace-hologram-media">
                  {!media && (
                    <div className="workspace-hologram-empty">
                      <PictureOutlined aria-hidden />
                      <p>图片、动画、视频</p>
                      <span>选择媒体，在这里展开</span>
                    </div>
                  )}
                  {media?.kind === "image" && (
                    <img
                      key={media.url}
                      src={media.url}
                      alt={media.name}
                      draggable={false}
                      onError={() =>
                        setError(
                          "图片无法显示，请更换可读取的图片；助理文件可能已删除或当前账号无权访问。",
                        )
                      }
                    />
                  )}
                  {media?.kind === "video" && (
                    <video
                      key={media.url}
                      ref={videoRef}
                      src={media.url}
                      aria-label={media.name}
                      controls
                      playsInline
                      muted
                      preload="metadata"
                      onError={() =>
                        setError(
                          "视频无法播放，请尝试浏览器支持的 MP4 或 WebM；助理文件可能已删除或当前账号无权访问。",
                        )
                      }
                    />
                  )}
                </div>
              </div>
            </div>
            {error && (
              <Alert
                type="error"
                showIcon
                title={error}
                className="workspace-hologram-error"
              />
            )}
            <footer className="workspace-hologram-controls">
              <input
                ref={input}
                type="file"
                hidden
                accept=".png,.jpg,.jpeg,.webp,.gif,.avif,.bmp,.mp4,.webm,.ogg,.ogv,.mov"
                aria-label="选择全息媒体文件"
                onChange={(event) => {
                  choose(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <Button
                size="small"
                icon={<UploadOutlined />}
                type="text"
                title={
                  media?.local === false
                    ? "本人有权访问的助理文件；拖动标题调整视角，关闭后清空预览"
                    : "本地文件仅在本机预览，不上传；拖动标题调整视角，关闭后清空预览"
                }
                onClick={() => input.current?.click()}
              >
                {media ? "更换媒体" : "选择本地媒体"}
              </Button>
              <span className="workspace-hologram-spacer" />
              <Button
                size="small"
                type="text"
                icon={<MinusOutlined />}
                aria-label="缩小全息影像"
                disabled={media?.kind !== "image"}
                onClick={() => zoom(1 / 1.2)}
              />
              <output aria-label="全息影像缩放">100%</output>
              <Button
                size="small"
                type="text"
                icon={<PlusOutlined />}
                aria-label="放大全息影像"
                disabled={media?.kind !== "image"}
                onClick={() => zoom(1.2)}
              />
              <Button
                size="small"
                type="text"
                icon={<AimOutlined />}
                aria-label="复位全息影像"
                title="复位全息影像"
                onClick={reset}
              />
            </footer>
          </div>,
          host,
        )}
    </>
  );
}

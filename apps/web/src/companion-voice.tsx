import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  AudioMutedOutlined,
  AudioOutlined,
  CloseOutlined,
  CommentOutlined,
  PhoneOutlined,
  SendOutlined,
  SettingOutlined,
  SoundOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { useAssistantHub } from "./assistant-hub-context";
import "./companion-voice.css";

// Only the presentation moves between the workbench and the character. The
// shared provider continues to own the same microphone and voice session.
export function CompanionVoice({
  anchor,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
}) {
  const hub = useAssistantHub(),
    voice = hub.gptVoice;
  const bubble = useRef<HTMLDivElement>(null);
  const placeholder = useRef<HTMLDivElement>(null);
  const inlineHeight = useRef(84);
  const requestAlign = useRef<() => void>(() => {});
  const [workspaceSlot, setWorkspaceSlot] = useState<HTMLElement | null>(null);
  const [overlay, setOverlay] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width?: number;
  } | null>(null);
  useLayoutEffect(() => {
    const discover = () => {
      if (bubble.current?.classList.contains("companion-voice-inline"))
        inlineHeight.current = bubble.current.getBoundingClientRect().height;
      setWorkspaceSlot(
        document.querySelector<HTMLElement>(
          ".personal-workspace .workspace-voice-slot",
        ),
      );
      setOverlay(
        [
          ...document.querySelectorAll<HTMLElement>(
            ".ant-drawer-open, .ant-modal-wrap",
          ),
        ].some(
          (element) =>
            element.getBoundingClientRect().width > 0 &&
            getComputedStyle(element).visibility !== "hidden" &&
            getComputedStyle(element).display !== "none",
        ),
      );
      requestAlign.current();
    };
    const observer = new MutationObserver(discover);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "aria-hidden"],
    });
    discover();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (workspaceSlot && !overlay) return;
    let frame = 0;
    const align = () => {
      frame = 0;
      const a = anchor.current?.getBoundingClientRect(),
        b = bubble.current?.getBoundingClientRect();
      if (!a || !b) return;
      const width = document.documentElement.clientWidth;
      if (workspaceSlot) {
        const slot = workspaceSlot.getBoundingClientRect();
        const overlays = [
          ...document.querySelectorAll<HTMLElement>(
            ".ant-modal-wrap .ant-modal, .ant-drawer-open .ant-drawer-section",
          ),
        ].filter((node) => {
          const r = node.getBoundingClientRect();
          return (
            r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight
          );
        });
        const next = {
          left: Math.max(8, Math.min(slot.left, width - slot.width - 8)),
          top: Math.max(8, Math.min(slot.top, innerHeight - b.height - 8)),
          width: Math.min(slot.width, width - 16),
        };
        const overlayRects = overlays.map((node) =>
          node.getBoundingClientRect(),
        );
        const controls = overlays
          .flatMap((node) => [
            ...node.querySelectorAll<HTMLElement>(
              "button, a, input, textarea, select, label, [role=button], .ant-modal-header, .ant-drawer-header",
            ),
          ])
          .map((node) => node.getBoundingClientRect())
          .filter((r) => r.width && r.height);
        const candidates = [
          ...overlayRects.map((r) => r.top - b.height - 8),
          next.top,
          ...overlayRects.map((r) => r.bottom + 8),
          8,
          innerHeight - b.height - 8,
        ].map((top) => Math.max(8, Math.min(top, innerHeight - b.height - 8)));
        const overlap = (top: number) =>
          controls.reduce(
            (sum, r) =>
              sum +
              Math.max(
                0,
                Math.min(next.left + next.width, r.right + 6) -
                  Math.max(next.left, r.left - 6),
              ) *
                Math.max(
                  0,
                  Math.min(top + b.height, r.bottom + 6) -
                    Math.max(top, r.top - 6),
                ),
            0,
          );
        // Prefer the gap above the dialog, then the original subtitle position.
        // If neither fits, choose the least obstructive remaining screen area.
        next.top = candidates.sort((a, c) => overlap(a) - overlap(c))[0];
        if (
          placeholder.current &&
          placeholder.current.style.height !== `${b.height}px`
        )
          placeholder.current.style.height = `${b.height}px`;
        setPosition((old) =>
          old?.left === next.left &&
          old.top === next.top &&
          old.width === next.width
            ? old
            : next,
        );
        return;
      }
      const obstacles = [
        ...document.querySelectorAll(
          "button, a, input, textarea, select, [role=button]",
        ),
      ]
        .filter(
          (node) =>
            !node.closest(".workspace-companion-host, .companion-voice"),
        )
        .map((node) => node.getBoundingClientRect())
        .filter(
          (r) => r.width && r.height && r.bottom > 0 && r.top < innerHeight,
        );
      obstacles.push(a);
      const candidates = [
        ...[a.right + 8, a.left - b.width - 8].flatMap((x) =>
          [
            a.top + 10,
            a.bottom - b.height,
            a.top + (a.height - b.height) / 2,
          ].map((y) => ({ x, y })),
        ),
        { x: a.left + (a.width - b.width) / 2, y: a.bottom + 8 },
        { x: a.left + (a.width - b.width) / 2, y: a.top - b.height - 8 },
      ].map(({ x, y }) => ({
        left: Math.max(8, Math.min(x, width - b.width - 8)),
        top: Math.max(8, Math.min(y, innerHeight - b.height - 8)),
      }));
      const overlap = (p: (typeof candidates)[number]) =>
        obstacles.reduce(
          (sum, r) =>
            sum +
            Math.max(
              0,
              Math.min(p.left + b.width, r.right + 4) -
                Math.max(p.left, r.left - 4),
            ) *
              Math.max(
                0,
                Math.min(p.top + b.height, r.bottom + 4) -
                  Math.max(p.top, r.top - 4),
              ),
          0,
        );
      candidates.sort((p, q) => overlap(p) - overlap(q));
      const next = candidates[0];
      setPosition((old) =>
        old?.left === next.left &&
        old.top === next.top &&
        old.width === undefined
          ? old
          : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(align);
    };
    requestAlign.current = schedule;
    const host = anchor.current?.closest(".workspace-companion");
    const mutation = new MutationObserver(schedule);
    if (host)
      mutation.observe(host, {
        attributes: true,
        attributeFilter: ["style", "class"],
      });
    const resize = new ResizeObserver(schedule);
    if (anchor.current) resize.observe(anchor.current);
    if (bubble.current) resize.observe(bubble.current);
    if (workspaceSlot) resize.observe(workspaceSlot);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("xuti-workspace-view", schedule);
    align();
    return () => {
      requestAlign.current = () => {};
      cancelAnimationFrame(frame);
      mutation.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("xuti-workspace-view", schedule);
    };
  }, [anchor, workspaceSlot, overlay]);
  const state =
    voice.muted && voice.active
      ? "麦克风已静音"
      : {
          idle: "想聊什么？",
          connecting: "正在打开麦克风…",
          listening: "我在听，你说",
          thinking: "让我想一想…",
          speaking: "小序正在说话",
        }[voice.state];
  const last = voice.captions.at(-1);
  const problem =
    voice.error ||
    hub.voiceStatusError ||
    (!hub.voiceStatus?.ready
      ? hub.voiceStatus?.error || "语音尚未就绪，请检查语音设置。"
      : !voice.supported
        ? "此浏览器不支持语音，请使用 HTTPS 下的 Chrome / Edge。"
        : "");
  const caption =
    problem ||
    (last
      ? `${last.role === "user" ? "你" : "小序"}：${last.text}`
      : voice.active
        ? "说完停顿一下，我就会回应。"
        : voice.note || "点击开始，用声音和我聊聊。");
  const retry = !!workspaceSlot && !!voice.error && !voice.active;
  const elevated = !!workspaceSlot && overlay;
  const foregroundHost =
    anchor.current?.closest<HTMLElement>(".workspace-companion-host") ||
    document.body;
  return (
    <>
      {elevated &&
        createPortal(
          <div
            ref={placeholder}
            aria-hidden="true"
            style={{ height: inlineHeight.current }}
          />,
          workspaceSlot,
        )}
      {createPortal(
        <div
          ref={bubble}
          className={`companion-voice ${workspaceSlot ? "companion-voice-inline" : "companion-voice-bubble"}${elevated ? " companion-voice-elevated" : ""}`}
          data-state={voice.state}
          data-muted={voice.muted}
          style={
            workspaceSlot && !overlay
              ? undefined
              : { ...position, visibility: position ? "visible" : "hidden" }
          }
          role="region"
          aria-label="小序语音"
          onKeyDown={(e) => {
            if (e.key === "Escape") hub.closeVoice();
          }}
        >
          <div className="companion-voice-heading">
            <span className="companion-voice-wave" aria-hidden>
              <i />
              <i />
              <i />
              <i />
            </span>
            <strong role="status">{state}</strong>
            {!workspaceSlot && (
              <button
                aria-label={voice.active ? "结束并收起语音" : "收起语音"}
                title="收起并关闭麦克风"
                onClick={hub.closeVoice}
              >
                <CloseOutlined />
              </button>
            )}
          </div>
          <p
            className={
              problem ? "companion-voice-error" : "companion-voice-caption"
            }
            title={caption}
            tabIndex={workspaceSlot ? 0 : undefined}
            aria-label={workspaceSlot ? "语音字幕" : undefined}
            role={problem ? "alert" : undefined}
            aria-live="polite"
          >
            {caption}
          </p>
          <div className="companion-voice-controls">
            {!voice.active ? (
              <button
                className="companion-voice-start"
                disabled={
                  !hub.voiceStatus?.ready || !voice.supported || hub.busy
                }
                onClick={hub.startVoice}
              >
                <AudioOutlined /> {retry ? "重试语音" : "开始语音对话"}
              </button>
            ) : (
              <>
                <button
                  aria-label={voice.muted ? "取消静音" : "麦克风静音"}
                  title={voice.muted ? "取消静音" : "麦克风静音"}
                  disabled={voice.state === "connecting"}
                  onClick={voice.toggleMute}
                >
                  {voice.muted ? <AudioMutedOutlined /> : <AudioOutlined />}
                </button>
                <button
                  aria-label={
                    voice.state === "speaking" ? "打断并说话" : "发送这段"
                  }
                  title={voice.state === "speaking" ? "打断并说话" : "发送这段"}
                  disabled={
                    voice.state !== "speaking" &&
                    (voice.state !== "listening" || voice.muted)
                  }
                  onClick={
                    voice.state === "speaking" ? voice.interrupt : voice.send
                  }
                >
                  {voice.state === "speaking" ? (
                    <StopOutlined />
                  ) : (
                    <SendOutlined />
                  )}
                </button>
                <button
                  className="companion-voice-end"
                  aria-label="结束语音"
                  title="结束语音"
                  onClick={hub.closeVoice}
                >
                  <PhoneOutlined />
                </button>
              </>
            )}
            {workspaceSlot && !voice.active && (
              <button
                aria-label="收起语音"
                title="收起语音"
                onClick={hub.closeVoice}
              >
                <CloseOutlined />
              </button>
            )}
            <span className="companion-voice-spacer" />
            {voice.playbackBlocked && (
              <button
                aria-label="允许播放声音"
                title="允许播放声音"
                onClick={voice.play}
              >
                <SoundOutlined />
              </button>
            )}
            <button
              aria-label="查看完整对话"
              title="结束语音并查看完整对话"
              onClick={() => hub.openPanel("chat")}
            >
              <CommentOutlined />
            </button>
            <button
              aria-label="语音设置"
              title="语音设置"
              onClick={hub.openVoiceSettings}
            >
              <SettingOutlined />
            </button>
          </div>
        </div>,
        workspaceSlot && !overlay ? workspaceSlot : foregroundHost,
      )}
    </>
  );
}

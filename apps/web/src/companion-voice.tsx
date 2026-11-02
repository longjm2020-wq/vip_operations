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

// A small, non-modal speech bubble follows the character, including while dragged.
export function CompanionVoice({
  anchor,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
}) {
  const hub = useAssistantHub(),
    voice = hub.gptVoice;
  const bubble = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const align = () => {
      frame = 0;
      const a = anchor.current?.getBoundingClientRect(),
        b = bubble.current?.getBoundingClientRect();
      if (!a || !b) return;
      const width = document.documentElement.clientWidth;
      const obstacles = [
        ...document.querySelectorAll(
          ".workspace button, .workspace a, .workspace input, .workspace textarea, .workspace select, .workspace [role=button]",
        ),
      ]
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
        old?.left === next.left && old.top === next.top ? old : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(align);
    };
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
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    align();
    return () => {
      cancelAnimationFrame(frame);
      mutation.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [anchor]);
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
  return createPortal(
    <div
      ref={bubble}
      className="companion-voice-bubble"
      data-state={voice.state}
      data-muted={voice.muted}
      style={{ ...position, visibility: position ? "visible" : "hidden" }}
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
        <button
          aria-label={voice.active ? "结束并收起语音" : "收起语音"}
          title="收起并关闭麦克风"
          onClick={hub.closeVoice}
        >
          <CloseOutlined />
        </button>
      </div>
      <p
        className={
          problem ? "companion-voice-error" : "companion-voice-caption"
        }
        title={caption}
        aria-live="polite"
      >
        {caption}
      </p>
      <div className="companion-voice-controls">
        {!voice.active ? (
          <button
            className="companion-voice-start"
            disabled={!hub.voiceStatus?.ready || !voice.supported || hub.busy}
            onClick={hub.startVoice}
          >
            <AudioOutlined /> 开始语音对话
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
              {voice.state === "speaking" ? <StopOutlined /> : <SendOutlined />}
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
    document.body,
  );
}

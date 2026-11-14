import { useEffect, useRef, useState } from "react";
import { subscribeCompanionGaze } from "./companion-gaze";
import { useAssistantHub } from "./assistant-hub-context";
import { activityFingerprint } from "../../../packages/contracts/src/assistant-activity";
import "./sidebar-assistant.css";
import { CompanionVoice } from "./companion-voice";
import xiaoxuFront from "./assets/xiaoxu/front.webp";
import xiaoxuBack from "./assets/xiaoxu/back.webp";
import xiaoxuThreeQuarterLeft from "./assets/xiaoxu/three-quarter-left.webp";
import xiaoxuThreeQuarterRight from "./assets/xiaoxu/three-quarter-right.webp";

const companionPoses = [
  ["front", xiaoxuFront],
  ["back", xiaoxuBack],
  ["three-quarter-left", xiaoxuThreeQuarterLeft],
  ["three-quarter-right", xiaoxuThreeQuarterRight],
] as const;

const companionMouths = {
  front: {
    smile: "M 297.80 351.00 C 312.00 361.50, 329.00 360.30, 343.20 351.00",
    open: { cx: 320.5, cy: 355.5, rx: 18, ry: 8.5 },
  },
  "three-quarter-left": {
    smile: "M 227.20 373.53 C 238.33 384.40, 251.67 383.70, 262.80 373.97",
    open: { cx: 245, cy: 378.5, rx: 14, ry: 7 },
  },
  "three-quarter-right": {
    smile: "M 403.20 358.70 C 413.67 367.40, 426.33 367.70, 436.80 353.30",
    open: { cx: 420, cy: 360.5, rx: 14, ry: 7 },
  },
} as const;

export function SidebarAssistant({
  floating = false,
  docked = false,
  compact = false,
  onInteract,
}: {
  floating?: boolean;
  docked?: boolean;
  compact?: boolean;
  onInteract?: () => void;
}) {
  const hub = useAssistantHub();
  const launch = useRef<HTMLButtonElement>(null);
  const figure = useRef<HTMLDivElement>(null);
  const lastActive = useRef(Date.now());
  useEffect(() => {
    if (!figure.current) return;
    return subscribeCompanionGaze(figure.current);
  }, []);
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    const active = () => {
      lastActive.current = Date.now();
      setIdle(false);
    };
    window.addEventListener("pointerdown", active);
    window.addEventListener("keydown", active);
    const timer = window.setInterval(
      () => setIdle(Date.now() - lastActive.current > 90000),
      15000,
    );
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointerdown", active);
      window.removeEventListener("keydown", active);
    };
  }, []);
  const items = hub.feed?.items || [];
  const unread = items.filter(
    (item) => !hub.seen.includes(activityFingerprint(item)),
  );
  const running = items.find(
    (item) => item.kind === "task" && item.status === "running",
  );
  const attention = unread.find((item) => item.status === "attention");
  const state = hub.voiceState
    ? hub.voiceState
    : hub.busy || running
      ? "working"
      : hub.feedError ||
          hub.conversation?.state === "FAILED" ||
          (hub.voiceVisible && hub.gptVoice.error)
        ? "error"
        : attention || unread.some((item) => item.status !== "upcoming")
          ? "notice"
          : idle
            ? "slacking"
            : "idle";
  const announced = useRef<Set<string> | null>(null);
  const [reminder, setReminder] = useState("");
  useEffect(() => {
    if (compact || !hub.feed?.items) return;
    const fresh = hub.feed.items.filter(
      (item) =>
        !hub.seen.includes(activityFingerprint(item)) &&
        !announced.current?.has(activityFingerprint(item)),
    );
    // Existing history stays unread in the feed; only urgent items announce on first load.
    const next =
      fresh.find((item) => item.status === "attention") ||
      (announced.current ? fresh[0] : undefined);
    announced.current = new Set(
      [
        ...(announced.current || []),
        ...hub.feed.items.map(activityFingerprint),
      ].slice(-300),
    );
    if (next) {
      const text = next.title + "：" + next.detail;
      setReminder(text.length > 32 ? text.slice(0, 31) + "…" : text);
      hub.announce?.(text.slice(0, 100));
    }
  }, [compact, hub.feed, hub.seen, hub.announce]);
  useEffect(() => {
    if (!reminder) return;
    const timer = setTimeout(() => setReminder(""), 8000);
    return () => clearTimeout(timer);
  }, [reminder]);
  const openPanel = (tab: "chat" | "activity") => {
    hub.openPanel(tab);
  };
  const launchLabel = hub.allowed ? "打开小序文字对话" : "打开 AI 个人助理";
  return (
    <section
      className={`sidebar-assistant${compact ? " sidebar-assistant-compact" : ""}`}
      data-state={state}
      data-muted={hub.gptVoice.muted}
      data-compact={compact ? "true" : undefined}
      aria-label="小序个人助理"
    >
      <button
        ref={launch}
        className="companion-launch"
        type="button"
        aria-label={launchLabel}
        aria-haspopup="dialog"
        title={
          compact
            ? "点击回到文字对话"
            : docked
              ? "点击身体打开文字对话 · 点嘴实时语音 · 拖动离巢 · Home 回巢"
              : floating
                ? "点击身体打开文字对话 · 点嘴实时语音 · 拖动自由放置 · 方向键移动 · Home 寻找空位"
                : "点击身体打开文字对话 · 点嘴实时语音"
        }
        onClick={(event) => {
          onInteract?.();
          if (
            hub.allowed &&
            !compact &&
            (event.target as Element).closest(".companion-mouth-hitbox")
          ) {
            hub.startVoice();
            return;
          }
          openPanel(hub.allowed ? "chat" : "activity");
        }}
      >
        <div className="companion-stage" aria-hidden="true">
          {!floating && <div className="companion-grid" />}
          <div className="companion-robot">
            {!floating && <div className="companion-shadow" />}
            <div className="companion-body">
              <div className="companion-figure" ref={figure}>
                {companionPoses.map(([pose, src]) => (
                  <div
                    key={pose}
                    className={`companion-pose companion-pose-${pose}`}
                  >
                    <img src={src} alt="" draggable={false} />
                    {pose !== "back" ? (
                      <>
                        <span className="companion-eyes">
                          <span className="companion-eye companion-eye-left">
                            <span className="companion-eye-dot" />
                          </span>
                          <span className="companion-eye companion-eye-right">
                            <span className="companion-eye-dot" />
                          </span>
                        </span>
                        <svg
                          className="companion-mouth"
                          viewBox="0 0 640 640"
                          aria-hidden="true"
                        >
                          <path
                            className="companion-mouth-smile"
                            d={companionMouths[pose].smile}
                          />
                          <ellipse
                            className="companion-mouth-open"
                            cx={companionMouths[pose].open.cx}
                            cy={companionMouths[pose].open.cy}
                            rx={companionMouths[pose].open.rx}
                            ry={companionMouths[pose].open.ry}
                          />
                          {hub.allowed && !compact && (
                            <ellipse
                              className="companion-mouth-hitbox"
                              cx={companionMouths[pose].open.cx}
                              cy={companionMouths[pose].open.cy + 1.5}
                              rx={42}
                              ry={21}
                            >
                              <title>点嘴进行实时语音聊天</title>
                            </ellipse>
                          )}
                        </svg>
                      </>
                    ) : null}
                  </div>
                ))}
              </div>
              <span className="companion-sleep">
                <span>z</span>
                <span>z</span>
              </span>
            </div>
          </div>
        </div>
      </button>
      {hub.allowed && !compact && <CompanionVoice anchor={launch} />}
      {reminder && !compact && !hub.voiceVisible && (
        <div className="companion-reminder" role="status" aria-live="polite">
          {reminder}
        </div>
      )}
    </section>
  );
}

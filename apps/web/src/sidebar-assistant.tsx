import { useEffect, useRef, useState } from "react";
import {
  ArrowRightOutlined,
  MoreOutlined,
  AudioOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { Popover } from "antd";
import { useAssistantHub } from "./assistant-hub-context";
import { activityFingerprint } from "../../../packages/contracts/src/assistant-activity";
import "./sidebar-assistant.css";
import { CompanionVoice } from "./companion-voice";
import xiaoxuFront from "./assets/xiaoxu/front.webp";
import xiaoxuBack from "./assets/xiaoxu/back.webp";
import xiaoxuSideLeft from "./assets/xiaoxu/side-left.webp";
import xiaoxuSideRight from "./assets/xiaoxu/side-right.webp";
import xiaoxuThreeQuarterLeft from "./assets/xiaoxu/three-quarter-left.webp";
import xiaoxuThreeQuarterRight from "./assets/xiaoxu/three-quarter-right.webp";

const companionPoses = [
  ["front", xiaoxuFront],
  ["back", xiaoxuBack],
  ["side-left", xiaoxuSideLeft],
  ["side-right", xiaoxuSideRight],
  ["three-quarter-left", xiaoxuThreeQuarterLeft],
  ["three-quarter-right", xiaoxuThreeQuarterRight],
] as const;

export function SidebarAssistant({
  floating = false,
  docked = false,
  onInteract,
}: {
  floating?: boolean;
  docked?: boolean;
  onInteract?: () => void;
}) {
  const hub = useAssistantHub();
  const launch = useRef<HTMLButtonElement>(null);
  const lastActive = useRef(Date.now());
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
  const labels = {
    connecting: "正在连接",
    thinking: "思考中",
    listening: "正在聆听",
    speaking: "正在说话",
    working: "工作中",
    error: "需要关注",
    notice: "有新动态",
    slacking: "摸鱼中",
    idle: "待命中",
  };
  const preview =
    attention ||
    unread.find((item) => item.status !== "upcoming") ||
    items.find((item) => item.kind === "schedule");
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    if (!detailsOpen) return;
    const close = () => setDetailsOpen(false);
    window.addEventListener("xuti-workspace-view", close);
    return () => window.removeEventListener("xuti-workspace-view", close);
  }, [detailsOpen]);
  const announced = useRef<Set<string> | null>(null);
  const [reminder, setReminder] = useState("");
  useEffect(() => {
    if (!hub.feed?.items) return;
    const fresh = hub.feed.items.filter(
      (item) =>
        !hub.seen.includes(activityFingerprint(item)) &&
        !announced.current?.has(activityFingerprint(item)),
    );
    // Existing history stays in the badge; only urgent items announce on first load.
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
  }, [hub.feed, hub.seen, hub.announce]);
  useEffect(() => {
    if (!reminder) return;
    const timer = setTimeout(() => setReminder(""), 8000);
    return () => clearTimeout(timer);
  }, [reminder]);
  const openPanel = (tab: "chat" | "activity") => {
    setDetailsOpen(false);
    hub.openPanel(tab);
  };
  return (
    <section
      className="sidebar-assistant"
      data-state={state}
      data-muted={hub.gptVoice.muted}
      aria-label="小序个人助理"
    >
      <button
        ref={launch}
        className="companion-launch"
        type="button"
        aria-label={
          hub.allowed
            ? hub.gptVoice.state === "speaking"
              ? "打断小序并说话"
              : "与小序语音对话"
            : "打开 AI 个人助理"
        }
        title={
          docked
            ? "点击小序跃出对话 · 拖动离巢 · Home 回巢"
            : floating
              ? "点击语音对话 · 拖动自由放置 · 方向键移动 · Home 寻找空位"
              : undefined
        }
        onClick={() => {
          setDetailsOpen(false);
          onInteract?.();
          if (hub.allowed) hub.startVoice();
          else openPanel("activity");
        }}
      >
        <div className="companion-stage" aria-hidden="true">
          {!floating && <div className="companion-grid" />}
          <div className="companion-robot">
            {!floating && <div className="companion-shadow" />}
            <div className="companion-body">
              {companionPoses.map(([pose, src]) => (
                <img
                  key={pose}
                  className={`companion-pose companion-pose-${pose}`}
                  src={src}
                  alt=""
                  draggable={false}
                />
              ))}
              <span className="companion-sleep">
                <span>z</span>
                <span>z</span>
              </span>
              <span className="companion-notice">!</span>
            </div>
          </div>
        </div>
      </button>
      <Popover
        getPopupContainer={(trigger) =>
          trigger.closest<HTMLElement>(".workspace-companion-host") ||
          document.body
        }
        trigger="click"
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        destroyOnHidden
        placement={floating ? "topRight" : "right"}
        classNames={{ root: "companion-details-popover" }}
        content={
          <div
            className="companion-details"
            onKeyDown={(event) => {
              if (event.key === "Escape") setDetailsOpen(false);
            }}
          >
            <div className="companion-details-heading">
              <span className="companion-name">
                小序 <small>AI 助理</small>
              </span>
              <span className="companion-state">{labels[state]}</span>
            </div>
            <div className="companion-interactions">
              <button type="button" onClick={() => openPanel("chat")}>
                文字对话
              </button>
              {hub.allowed && (
                <button
                  type="button"
                  aria-label="与小序语音对话"
                  title="语音对话"
                  onClick={() => {
                    setDetailsOpen(false);
                    hub.startVoice();
                  }}
                >
                  <AudioOutlined />
                </button>
              )}
              {hub.allowed && (
                <button
                  type="button"
                  aria-label="语音设置"
                  title="语音设置"
                  onClick={() => {
                    setDetailsOpen(false);
                    hub.openVoiceSettings();
                  }}
                >
                  <SettingOutlined />
                </button>
              )}
            </div>
            <button
              className="companion-feedback"
              type="button"
              aria-label="查看助理动态反馈"
              onClick={() => openPanel("activity")}
            >
              <span>
                {hub.feedError
                  ? "动态连接中断，点击重试"
                  : hub.feedLoading
                    ? "正在读取动态…"
                    : preview?.title || "日程 · 项目 · 定时任务"}
                <small>{preview?.detail || "在这里查看工作反馈"}</small>
              </span>
              <ArrowRightOutlined />
            </button>
          </div>
        }
      >
        <button
          className="companion-count"
          type="button"
          aria-label="展开小序状态与动态"
          aria-expanded={detailsOpen}
          title={
            labels[state] +
            (unread.length
              ? " · " + unread.length + " 条新动态"
              : " · 点击展开")
          }
          onKeyDown={(event) => {
            if (event.key === "Escape") setDetailsOpen(false);
          }}
        >
          {unread.length > 0 ? (
            unread.length > 99 ? (
              "99+"
            ) : (
              unread.length
            )
          ) : (
            <MoreOutlined />
          )}
        </button>
      </Popover>
      {hub.allowed && <CompanionVoice anchor={launch} />}
      {reminder && !hub.voiceVisible && (
        <div className="companion-reminder" role="status" aria-live="polite">
          {reminder}
        </div>
      )}
    </section>
  );
}

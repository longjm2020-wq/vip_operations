import { useEffect, useRef, useState } from "react";
import {
  ArrowRightOutlined,
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
import xiaoxuThreeQuarterLeft from "./assets/xiaoxu/three-quarter-left.webp";
import xiaoxuThreeQuarterRight from "./assets/xiaoxu/three-quarter-right.webp";

const companionPoses = [
  ["front", xiaoxuFront],
  ["back", xiaoxuBack],
  ["three-quarter-left", xiaoxuThreeQuarterLeft],
  ["three-quarter-right", xiaoxuThreeQuarterRight],
] as const;

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
    setDetailsOpen(false);
    hub.openPanel(tab);
  };
  const launchLabel = hub.allowed
    ? "打开小序文字对话"
    : "打开 AI 个人助理";
  const menuTitle =
    labels[state] +
    (unread.length ? " · " + unread.length + " 条新动态" : " · 右键展开");
  const openMenu = () => setDetailsOpen(true);
  return (
    <section
      className={`sidebar-assistant${compact ? " sidebar-assistant-compact" : ""}`}
      data-state={state}
      data-muted={hub.gptVoice.muted}
      data-compact={compact ? "true" : undefined}
      aria-label="小序个人助理"
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu();
      }}
    >
      <Popover
        getPopupContainer={(trigger) =>
          trigger.closest<HTMLElement>(
            compact
              ? ".personal-assistant-drawer"
              : ".workspace-companion-host",
          ) || document.body
        }
        trigger="contextMenu"
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        destroyOnHidden
        placement={compact ? "bottomLeft" : floating ? "topRight" : "right"}
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
          ref={launch}
          className="companion-launch"
          type="button"
          aria-label={launchLabel}
          aria-haspopup="dialog"
          aria-expanded={detailsOpen}
          title={
            compact
              ? "点击回到文字对话 · 右键展开状态与动态"
              : docked
                ? "点击打开文字对话 · 右键展开状态与动态 · 拖动离巢 · Home 回巢"
                : floating
                  ? "点击打开文字对话 · 右键展开状态与动态 · 拖动自由放置 · 方向键移动 · Home 寻找空位"
                  : menuTitle
          }
          onClick={() => {
            setDetailsOpen(false);
            onInteract?.();
            openPanel(hub.allowed ? "chat" : "activity");
          }}
          onKeyDown={(event) => {
            if (
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            ) {
              event.preventDefault();
              openMenu();
            } else if (event.key === "Escape") setDetailsOpen(false);
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
      </Popover>
      {hub.allowed && !compact && <CompanionVoice anchor={launch} />}
      {reminder && !compact && !hub.voiceVisible && (
        <div className="companion-reminder" role="status" aria-live="polite">
          {reminder}
        </div>
      )}
    </section>
  );
}

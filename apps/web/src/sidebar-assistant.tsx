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
import { CompanionThreeVisual } from "./workspace-three";

export function SidebarAssistant({
  floating = false,
  docked = false,
  hasNest = false,
  onExplore,
  onHome,
  onInteract,
}: {
  floating?: boolean;
  docked?: boolean;
  hasNest?: boolean;
  onExplore?: () => void;
  onHome?: () => void;
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
          {!docked && <CompanionThreeVisual />}
          {!floating && <div className="companion-grid" />}
          <svg className="companion-robot" viewBox="0 0 180 160" fill="none">
            {!floating && (
              <ellipse
                className="companion-shadow"
                cx="90"
                cy="145"
                rx="39"
                ry="6"
              />
            )}
            <g className="companion-body">
              <path
                className="companion-antenna"
                d="M90 25V16"
                strokeWidth="3"
                strokeLinecap="round"
              />
              <circle className="companion-beacon" cx="90" cy="12" r="5" />
              <rect
                className="companion-ear"
                x="28"
                y="57"
                width="12"
                height="25"
                rx="6"
              />
              <rect
                className="companion-ear"
                x="140"
                y="57"
                width="12"
                height="25"
                rx="6"
              />
              <rect
                className="companion-helmet"
                x="35"
                y="29"
                width="110"
                height="78"
                rx="30"
              />
              <path
                className="companion-highlight"
                d="M51 48C56 38 69 37 78 37"
                strokeWidth="3"
                strokeLinecap="round"
              />
              <rect
                className="companion-face"
                x="44"
                y="45"
                width="92"
                height="49"
                rx="19"
              />
              <g className="companion-eyes">
                <rect x="63" y="61" width="10" height="15" rx="5" />
                <rect x="107" y="61" width="10" height="15" rx="5" />
              </g>
              <g
                className="companion-sleep-eyes"
                strokeWidth="3"
                strokeLinecap="round"
              >
                <path d="M62 71h13M106 71h13" />
              </g>
              <path
                className="companion-mouth"
                d="M84 80Q90 85 96 80"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <ellipse
                className="companion-speaking-mouth"
                cx="90"
                cy="81"
                rx="5"
                ry="4"
              />
              <rect
                className="companion-chassis"
                x="66"
                y="105"
                width="48"
                height="29"
                rx="12"
              />
              <path
                className="companion-core"
                d="m84 116 6 6 6-6"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                className="companion-arm companion-arm-left"
                d="M64 113q-16-3-19 6"
                strokeWidth="9"
                strokeLinecap="round"
              />
              <path
                className="companion-arm companion-arm-right"
                d="M116 113q16-3 19-16"
                strokeWidth="9"
                strokeLinecap="round"
              />
              <g className="companion-laptop">
                <path d="M63 112h54l-5 23H68z" />
                <path d="M61 137h58" strokeWidth="3" strokeLinecap="round" />
                <path d="m83 122-4 3 4 3m14-6 4 3-4 3" strokeWidth="1.6" />
              </g>
              <g className="companion-sleep">
                <text x="132" y="34">
                  z
                </text>
                <text x="148" y="21">
                  z
                </text>
              </g>
              <g className="companion-notice">
                <circle cx="139" cy="35" r="10" />
                <path
                  d="M139 30v6m0 3v.2"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </g>
            </g>
          </svg>
        </div>
      </button>
      <Popover
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
            {onExplore && (
              <div className="companion-interactions companion-placement-actions">
                <button
                  type="button"
                  onClick={() => {
                    setDetailsOpen(false);
                    onExplore();
                  }}
                >
                  换个位置
                </button>
                {hasNest && !docked && onHome && (
                  <button
                    type="button"
                    onClick={() => {
                      setDetailsOpen(false);
                      onHome();
                    }}
                  >
                    回到巢穴
                  </button>
                )}
              </div>
            )}
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
      {hub.allowed && hub.voiceVisible && <CompanionVoice anchor={launch} />}
      {reminder && !hub.voiceVisible && (
        <div className="companion-reminder" role="status" aria-live="polite">
          {reminder}
        </div>
      )}
    </section>
  );
}

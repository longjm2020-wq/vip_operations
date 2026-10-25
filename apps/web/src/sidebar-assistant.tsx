import { useEffect, useRef, useState } from "react";
import { ArrowRightOutlined, SmileOutlined } from "@ant-design/icons";
import { useAssistantHub } from "./assistant-hub-context";
import { activityFingerprint } from "../../../packages/contracts/src/assistant-activity";
import "./sidebar-assistant.css";

export function SidebarAssistant() {
  const hub = useAssistantHub();
  const lastActive = useRef(Date.now());
  const [idle, setIdle] = useState(false),
    [greeting, setGreeting] = useState(false);
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
  useEffect(() => {
    if (greeting) {
      const timer = setTimeout(() => setGreeting(false), 2600);
      return () => clearTimeout(timer);
    }
  }, [greeting]);
  const items = hub.feed?.items || [];
  const unread = items.filter(
    (item) => !hub.seen.includes(activityFingerprint(item)),
  );
  const running = items.find(
    (item) => item.kind === "task" && item.status === "running",
  );
  const attention = unread.find((item) => item.status === "attention");
  const state =
    hub.busy || running
      ? "working"
      : hub.feedError || hub.conversation?.state === "FAILED"
        ? "error"
        : greeting
          ? "happy"
          : attention || unread.some((item) => item.status !== "upcoming")
            ? "notice"
            : idle
              ? "slacking"
              : "idle";
  const labels = {
    working: "工作中",
    error: "需要关注",
    happy: "在呢，随时找我",
    notice: "有新动态",
    slacking: "摸鱼中",
    idle: "待命中",
  };
  const preview =
    attention ||
    unread.find((item) => item.status !== "upcoming") ||
    items.find((item) => item.kind === "schedule");
  return (
    <section
      className="sidebar-assistant"
      data-state={state}
      aria-label="小序个人助理"
    >
      <button
        className="companion-launch"
        type="button"
        aria-label="打开 AI 个人助理"
        onClick={() => hub.openPanel("chat")}
      >
        <div className="companion-stage" aria-hidden="true">
          <div className="companion-grid" />
          <svg className="companion-robot" viewBox="0 0 180 160" fill="none">
            <ellipse
              className="companion-shadow"
              cx="90"
              cy="145"
              rx="39"
              ry="6"
            />
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
          {unread.length > 0 && (
            <span className="companion-count">
              {unread.length > 99 ? "99+" : unread.length}
            </span>
          )}
        </div>
        <span className="companion-name">
          小序 <small>AI 助理</small>
        </span>
        <span className="companion-state">{labels[state]}</span>
      </button>
      <div className="companion-interactions">
        <span>点击与我聊聊</span>
        <button
          type="button"
          aria-label="和小序打个招呼"
          title="打个招呼"
          onClick={() => setGreeting(true)}
        >
          <SmileOutlined />
        </button>
      </div>
      <button
        className="companion-feedback"
        type="button"
        aria-label="查看助理动态反馈"
        onClick={() => hub.openPanel("activity")}
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
    </section>
  );
}

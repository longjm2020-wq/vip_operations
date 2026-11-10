import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CaretRightOutlined,
  CloseOutlined,
  LeftOutlined,
  MinusOutlined,
  PauseOutlined,
  RightOutlined,
} from "@ant-design/icons";
import {
  presentationMediaUrl,
  type PresentationChart,
  type PresentationSlide,
  type PresentationVisual,
} from "../../../packages/contracts/src/assistant-presentation";
import { usePresentationStore } from "./voice-presentation-store";
import "./voice-presentation.css";

const palette = [
  "var(--app-accent)",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
];
const format = (value: number) =>
  value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });

export function PresentationChartView({ chart }: { chart: PresentationChart }) {
  const width = 360,
    height = 190,
    pad = 28;
  if (chart.chart === "pie") {
    const values = chart.series[0]?.values ?? [];
    const total = values.reduce((sum, v) => sum + Math.max(0, v), 0) || 1;
    let angle = -Math.PI / 2;
    const r = 70,
      cx = 95,
      cy = height / 2;
    return (
      <svg
        className="voice-presentation-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`饼图：${chart.labels.join("、")}`}
      >
        {values.map((value, i) => {
          const share = Math.max(0, value) / total;
          const start = angle;
          angle += share * Math.PI * 2;
          const large = share > 0.5 ? 1 : 0;
          const d =
            share >= 0.9999
              ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`
              : `M ${cx} ${cy} L ${cx + r * Math.cos(start)} ${cy + r * Math.sin(start)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(angle)} ${cy + r * Math.sin(angle)} Z`;
          return (
            <path
              key={i}
              className="voice-presentation-pie"
              style={{ animationDelay: `${i * 80}ms` }}
              d={d}
              fill={palette[i % palette.length]}
            />
          );
        })}
        {chart.labels.slice(0, 8).map((label, i) => (
          <g key={label + i} transform={`translate(190 ${30 + i * 19})`}>
            <rect
              width="10"
              height="10"
              rx="2"
              fill={palette[i % palette.length]}
            />
            <text x="16" y="9" className="voice-presentation-chart-label">
              {label} {Math.round(((values[i] ?? 0) / total) * 1000) / 10}%
            </text>
          </g>
        ))}
      </svg>
    );
  }
  const all = chart.series.flatMap((s) => s.values);
  const max = Math.max(0, ...all),
    min = Math.min(0, ...all);
  const span = max - min || 1;
  const n = chart.labels.length;
  const x = (i: number) =>
    chart.chart === "bar"
      ? pad + ((width - 2 * pad) * (i + 0.5)) / n
      : pad + (width - 2 * pad) * (n === 1 ? 0.5 : i / (n - 1));
  const y = (v: number) =>
    height - pad - ((height - 2 * pad) * (v - min)) / span;
  const group = (width - 2 * pad) / n;
  const barWidth = Math.max(3, (group * 0.7) / chart.series.length);
  const every = Math.ceil(n / 8);
  return (
    <svg
      className="voice-presentation-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${chart.chart === "bar" ? "柱状图" : "折线图"}：${chart.series.map((s) => s.name).join("、")}`}
    >
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line
            x1={pad}
            x2={width - pad}
            y1={y(min + t * span)}
            y2={y(min + t * span)}
            className="voice-presentation-grid"
          />
          <text
            x={2}
            y={y(min + t * span) + 4}
            className="voice-presentation-chart-label"
          >
            {format(min + t * span)}
          </text>
        </g>
      ))}
      {chart.series.map((s, si) =>
        chart.chart === "bar" ? (
          s.values.map((v, i) => (
            <rect
              key={`${si}-${i}`}
              className="voice-presentation-bar"
              style={{ animationDelay: `${i * 40}ms` }}
              x={x(i) - (barWidth * chart.series.length) / 2 + si * barWidth}
              y={Math.min(y(v), y(0))}
              width={barWidth - 1}
              height={Math.max(1, Math.abs(y(v) - y(0)))}
              rx={2}
              fill={palette[si % palette.length]}
            >
              <title>{`${chart.labels[i]} ${s.name}：${format(v)}${chart.unit ?? ""}`}</title>
            </rect>
          ))
        ) : (
          <g key={si}>
            <polyline
              className="voice-presentation-line"
              fill="none"
              stroke={palette[si % palette.length]}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              pathLength={1}
              points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
            />
            {s.values.map((v, i) => (
              <circle
                key={i}
                cx={x(i)}
                cy={y(v)}
                r={2.6}
                fill={palette[si % palette.length]}
              >
                <title>{`${chart.labels[i]} ${s.name}：${format(v)}${chart.unit ?? ""}`}</title>
              </circle>
            ))}
          </g>
        ),
      )}
      {chart.labels.map((label, i) =>
        i % every ? null : (
          <text
            key={label + i}
            x={x(i)}
            y={height - 8}
            textAnchor="middle"
            className="voice-presentation-chart-label"
          >
            {label}
          </text>
        ),
      )}
      {chart.series.length > 1 &&
        chart.series.map((s, si) => (
          <g key={s.name + si} transform={`translate(${pad + si * 80} 4)`}>
            <rect
              width="10"
              height="10"
              rx="2"
              fill={palette[si % palette.length]}
            />
            <text x="14" y="9" className="voice-presentation-chart-label">
              {s.name}
            </text>
          </g>
        ))}
      {chart.unit && (
        <text
          x={width - 2}
          y={12}
          textAnchor="end"
          className="voice-presentation-chart-label"
        >
          单位：{chart.unit}
        </text>
      )}
    </svg>
  );
}

const reducedMotion = () =>
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const normalize = (v: string) => v.replace(/\s+/g, "").toLowerCase();
/** Find the most specific visible element on the page that shows the text. */
export function findSpotlightTarget(target: string): HTMLElement | null {
  const wanted = normalize(target);
  if (wanted.length < 2) return null;
  let best: HTMLElement | null = null,
    bestLength = Infinity;
  const visible = (el: HTMLElement) => {
    if (
      el.closest(
        ".voice-presentation, .voice-presentation-spotlight, [hidden], [aria-hidden='true']",
      )
    )
      return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !normalize(node.textContent || "").includes(wanted))
      continue;
    if (!visible(parent)) continue;
    const length = normalize(parent.textContent || "").length;
    if (length < bestLength) {
      best = parent;
      bestLength = length;
    }
  }
  if (best) {
    // Lift to a readable block (card, cell, button) when the match is a tiny span.
    const block = best.closest<HTMLElement>(
      "button, a, th, td, li, label, .ant-card, .ant-statistic, [class*='card'], [class*='metric'], h1, h2, h3, h4",
    );
    if (
      block &&
      visible(block) &&
      normalize(block.textContent || "").length < 160
    )
      return block;
    return best;
  }
  for (const el of document.body.querySelectorAll<HTMLElement>("body *")) {
    const text = normalize(el.textContent || "");
    if (text.length >= bestLength || !text.includes(wanted) || !visible(el))
      continue;
    best = el;
    bestLength = text.length;
  }
  return best;
}

function Spotlight({ target }: { target: string }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    const el = findSpotlightTarget(target);
    if (!el) {
      setRect(null);
      return;
    }
    el.scrollIntoView?.({
      block: "center",
      inline: "nearest",
      behavior: reducedMotion() ? "auto" : "smooth",
    });
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setRect(el.isConnected ? el.getBoundingClientRect() : null),
      );
    };
    update();
    const timer = setInterval(update, 500);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [target]);
  if (!rect) return null;
  return createPortal(
    <div
      className="voice-presentation-spotlight"
      aria-hidden="true"
      style={{
        left: rect.left - 6,
        top: rect.top - 6,
        width: rect.width + 12,
        height: rect.height + 12,
      }}
    />,
    document.body,
  );
}

function Visual({ visual }: { visual: PresentationVisual }) {
  const [failed, setFailed] = useState(false);
  if (visual.type === "image" || visual.type === "video") {
    // Defence in depth: re-check the allow-list right before rendering.
    const url = presentationMediaUrl(
      visual.url,
      visual.type,
      window.location.origin,
    );
    if (!url || failed)
      return (
        <div className="voice-presentation-media-missing">
          {visual.alt || "素材暂时无法显示"}
        </div>
      );
    return visual.type === "image" ? (
      <figure className="voice-presentation-media">
        <img
          src={url}
          alt={visual.alt}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
        {visual.alt && <figcaption>{visual.alt}</figcaption>}
      </figure>
    ) : (
      <figure className="voice-presentation-media">
        <video
          src={url}
          muted
          autoPlay={!reducedMotion()}
          loop
          playsInline
          controls={reducedMotion()}
          aria-label={visual.alt || "演示视频"}
          onError={() => setFailed(true)}
        />
        {visual.alt && <figcaption>{visual.alt}</figcaption>}
      </figure>
    );
  }
  if (visual.type === "chart") return <PresentationChartView chart={visual} />;
  if (visual.type === "highlight")
    return (
      <div className={`voice-presentation-highlight effect-${visual.effect}`}>
        <strong>{visual.text}</strong>
        {visual.caption && <span>{visual.caption}</span>}
      </div>
    );
  return (
    <div className="voice-presentation-spot-note">
      <span className="voice-presentation-spot-dot" />
      已在页面上标出「{visual.target}」
      {visual.caption ? `：${visual.caption}` : ""}
      <Spotlight target={visual.target} />
    </div>
  );
}

export function PresentationSlideView({ slide }: { slide: PresentationSlide }) {
  return (
    <div className="voice-presentation-slide">
      <h3>{slide.title}</h3>
      {slide.bullets.length > 0 && (
        <ul>
          {slide.bullets.map((b, i) => (
            <li key={i} style={{ animationDelay: `${120 + i * 90}ms` }}>
              {b}
            </li>
          ))}
        </ul>
      )}
      {slide.visual && <Visual visual={slide.visual} />}
    </div>
  );
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * Translucent deck shown while 小序 narrates during a realtime call. It sits
 * centre-right, away from the sidebar mascot, and never blocks the page: only
 * the panel itself receives pointer events.
 */
export function VoicePresentationPanel({
  voiceActive,
  speaking,
  caption,
}: {
  voiceActive: boolean;
  speaking: boolean;
  caption?: { id: string; text: string };
}) {
  const state = usePresentationStore();
  const { deck, index, paused, minimized, ended, dispatch } = state;
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(
    null,
  );
  const wasActive = useRef(voiceActive);
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  useEffect(() => {
    if (wasActive.current && !voiceActive) dispatch({ type: "call-ended" });
    wasActive.current = voiceActive;
  }, [voiceActive, dispatch]);
  useEffect(() => {
    if (caption)
      dispatch({ type: "transcript", id: caption.id, text: caption.text });
  }, [caption?.id, caption?.text, dispatch]);
  useEffect(() => {
    if (!deck || paused || ended) return;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      dispatch({ type: "tick", ms: now - last, speaking: speakingRef.current });
      last = now;
    }, 250);
    return () => clearInterval(timer);
  }, [deck, paused, ended, dispatch]);
  useEffect(() => setOffset({ x: 0, y: 0 }), [deck?.id]);
  useEffect(() => {
    if (!deck) return;
    const key = (e: KeyboardEvent) => {
      if (typing(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "ArrowRight") dispatch({ type: "next" });
      else if (e.key === "ArrowLeft") dispatch({ type: "prev" });
      else if (e.key === "Escape") dispatch({ type: "close" });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [deck, dispatch]);
  if (!deck) return null;
  const slide = deck.slides[index];
  const total = deck.slides.length;
  const progress = Math.min(1, state.elapsed / (slide.seconds * 1000));
  if (minimized)
    return createPortal(
      <button
        type="button"
        className="voice-presentation voice-presentation-pill"
        onClick={() => dispatch({ type: "minimize", minimized: false })}
        aria-label={`展开演示：${deck.title}，第${index + 1}页，共${total}页`}
      >
        <span className="voice-presentation-pill-dot" />
        演示 {index + 1}/{total}
      </button>,
      document.body,
    );
  return createPortal(
    <div
      className="voice-presentation"
      role="dialog"
      aria-modal="false"
      aria-label={`小序演示：${deck.title}`}
      tabIndex={-1}
      style={{
        transform: `translate(${offset.x}px, calc(-50% + ${offset.y}px))`,
      }}
    >
      <header
        className="voice-presentation-header"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            ox: offset.x,
            oy: offset.y,
          };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        <span className="voice-presentation-title" title={deck.title}>
          {deck.title}
        </span>
        <span className="voice-presentation-count" aria-live="polite">
          {index + 1}/{total}
        </span>
        <button
          type="button"
          aria-label="最小化演示"
          onClick={() => dispatch({ type: "minimize", minimized: true })}
        >
          <MinusOutlined />
        </button>
        <button
          type="button"
          aria-label="关闭演示"
          onClick={() => dispatch({ type: "close" })}
        >
          <CloseOutlined />
        </button>
      </header>
      <div className="voice-presentation-stage" key={`${deck.id}:${index}`}>
        <PresentationSlideView slide={slide} />
      </div>
      <footer className="voice-presentation-footer">
        <button
          type="button"
          aria-label="上一页"
          disabled={index === 0}
          onClick={() => dispatch({ type: "prev" })}
        >
          <LeftOutlined />
        </button>
        <div
          className="voice-presentation-dots"
          role="tablist"
          aria-label="演示页"
        >
          {deck.slides.map((s, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`第${i + 1}页：${s.title}`}
              className={i === index ? "active" : i < index ? "seen" : ""}
              onClick={() => dispatch({ type: "goto", index: i })}
            >
              {i === index && !paused && !ended && (
                <i style={{ transform: `scaleX(${progress})` }} />
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="下一页"
          disabled={index === total - 1}
          onClick={() => dispatch({ type: "next" })}
        >
          <RightOutlined />
        </button>
        <button
          type="button"
          className="voice-presentation-pause"
          aria-label={paused ? "继续自动翻页" : "暂停自动翻页"}
          aria-pressed={paused}
          disabled={ended}
          onClick={() => dispatch({ type: "pause" })}
        >
          {paused ? <CaretRightOutlined /> : <PauseOutlined />}
        </button>
      </footer>
      {ended && (
        <div className="voice-presentation-ended">
          通话已结束，可继续翻看或关闭
        </div>
      )}
    </div>,
    document.body,
  );
}

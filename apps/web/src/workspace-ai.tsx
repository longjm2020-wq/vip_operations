import { useEffect, useRef, type PointerEvent } from "react";
import { ReloadOutlined } from "@ant-design/icons";
import { useAssistantHub } from "./assistant-hub-context";
import { PersonalAssistant } from "./personal-assistant";
import { useUser, type Row } from "./shared";
import { canUsePersonalAssistant } from "../../../packages/contracts/src/personal-assistant";
import type { WorkspaceSchedule } from "../../../packages/contracts/src/personal-workspace";
import "./workspace-ai.css";

// Fixed geometry keeps this decorative core independent of timers and model calls.
const coreTicks = Array.from({ length: 60 }, (_, index) => index);

function requestCompanion(command: "home" | "explore") {
  window.dispatchEvent(
    new CustomEvent("xuti-companion-command", { detail: command }),
  );
}

function AssistantCore() {
  const core = useRef<HTMLDivElement>(null);
  const view = useRef({ pitch: -14, yaw: 18 });
  const frame = useRef<number | null>(null);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    pitch: number;
    yaw: number;
  } | null>(null);
  const writeView = () => {
    frame.current = null;
    const element = core.current;
    if (!element) return;
    element.style.setProperty("--core-pitch", `${view.current.pitch}deg`);
    element.style.setProperty("--core-yaw", `${view.current.yaw}deg`);
    element.dataset.viewPitch = String(view.current.pitch);
    element.dataset.viewYaw = String(view.current.yaw);
  };
  const queueView = (pitch: number, yaw: number) => {
    view.current = {
      pitch: Math.round(Math.max(-48, Math.min(48, pitch)) * 100) / 100,
      yaw: Math.round(Math.max(-55, Math.min(55, yaw)) * 100) / 100,
    };
    if (frame.current === null)
      frame.current = requestAnimationFrame(writeView);
  };
  const resetView = () => queueView(-14, 18);
  const isControl = (target: EventTarget) =>
    target instanceof Element &&
    !!target.closest(
      ".workspace-ai-companion-slot, button, a, input, textarea, select, [contenteditable=true]",
    );
  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    delete event.currentTarget.dataset.viewDragging;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    writeView();
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  useEffect(() => {
    const element = core.current;
    if (element) {
      element.style.setProperty("--core-pitch", "-14deg");
      element.style.setProperty("--core-yaw", "18deg");
      element.dataset.viewPitch = "-14";
      element.dataset.viewYaw = "18";
    }
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      const active = drag.current;
      drag.current = null;
      if (active && element?.hasPointerCapture(active.pointerId))
        element.releasePointerCapture(active.pointerId);
    };
  }, []);
  return (
    <div
      ref={core}
      className="workspace-ai-core"
      role="group"
      aria-label="小序巢穴三维视角"
      aria-description="拖动圆环空白处或使用方向键调整视角，双击空白处或按 Home 复位。"
      tabIndex={0}
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          !event.isPrimary ||
          drag.current ||
          isControl(event.target)
        )
          return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.viewDragging = "true";
        drag.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          ...view.current,
        };
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        queueView(
          active.pitch - (event.clientY - active.y) * 0.28,
          active.yaw + (event.clientX - active.x) * 0.28,
        );
      }}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      onDoubleClick={(event) => {
        if (!isControl(event.target)) resetView();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const directions: Record<string, [number, number]> = {
          ArrowUp: [-4, 0],
          ArrowDown: [4, 0],
          ArrowLeft: [0, -4],
          ArrowRight: [0, 4],
        };
        if (event.key === "Home") {
          event.preventDefault();
          resetView();
        } else if (directions[event.key]) {
          event.preventDefault();
          const [pitch, yaw] = directions[event.key];
          queueView(view.current.pitch + pitch, view.current.yaw + yaw);
        }
      }}
    >
      <div className="workspace-ai-core-perspective" aria-hidden="true">
        <div className="workspace-ai-core-scene">
          <div className="workspace-ai-core-aura" aria-hidden="true" />
          <div className="workspace-ai-core-resonance" aria-hidden="true" />
          <div className="workspace-ai-core-depth workspace-ai-core-depth-back" />
          <div className="workspace-ai-core-depth workspace-ai-core-depth-cross" />
          <svg
            className="workspace-ai-core-orbits"
            viewBox="0 0 320 320"
            aria-hidden="true"
          >
            <g className="workspace-ai-core-guides" fill="none">
              <circle cx="160" cy="160" r="151" />
              <circle cx="160" cy="160" r="131" />
              <circle cx="160" cy="160" r="103" />
              <path d="M160 2v8M160 310v8M2 160h8M310 160h8" />
            </g>
            <g className="workspace-ai-core-ticks">
              {coreTicks.map((tick) => (
                <line
                  key={tick}
                  x1="160"
                  y1={tick % 5 === 0 ? 18 : 23}
                  x2="160"
                  y2="28"
                  transform={`rotate(${tick * 6} 160 160)`}
                  className={tick % 5 === 0 ? "is-major" : undefined}
                />
              ))}
            </g>
            <g className="workspace-ai-core-outer" fill="none">
              <circle
                cx="160"
                cy="160"
                r="145"
                pathLength="100"
                strokeDasharray="16 11 3 20 16 11 3 20"
              />
              <circle cx="160" cy="15" r="2.6" className="is-node" />
              <circle cx="160" cy="305" r="2.6" className="is-node" />
            </g>
            <g className="workspace-ai-core-middle" fill="none">
              <circle
                cx="160"
                cy="160"
                r="120"
                pathLength="100"
                strokeDasharray="30 20 30 20"
              />
              <circle
                cx="160"
                cy="160"
                r="115"
                pathLength="100"
                strokeDasharray="4 46 4 46"
                className="is-trace"
              />
            </g>
            <g className="workspace-ai-core-orbit-plane" fill="none">
              <ellipse cx="160" cy="160" rx="111" ry="55" />
              <ellipse
                cx="160"
                cy="160"
                rx="111"
                ry="55"
                transform="rotate(60 160 160)"
              />
              <ellipse
                cx="160"
                cy="160"
                rx="111"
                ry="55"
                transform="rotate(120 160 160)"
              />
            </g>
            <g className="workspace-ai-core-inner" fill="none">
              <circle
                cx="160"
                cy="160"
                r="88"
                pathLength="100"
                strokeDasharray="22 3 22 3 22 3 22 3"
              />
              <circle cx="160" cy="160" r="79" className="is-inner-guide" />
            </g>
          </svg>
        </div>
      </div>
      <div className="workspace-ai-companion-slot" />
      <button
        className="workspace-ai-summon"
        type="button"
        onClick={() => requestCompanion("home")}
      >
        召唤小序
      </button>
      <button
        className="workspace-ai-view-reset"
        type="button"
        aria-label="重置圆环视角"
        title="重置视角（双击圆环或按 Home）"
        onClick={resetView}
      >
        <ReloadOutlined aria-hidden="true" />
      </button>
    </div>
  );
}

export function WorkspaceAI({
  available,
  schedule,
  onSchedule,
}: {
  available: Row[];
  schedule: WorkspaceSchedule[];
  onSchedule: (event: WorkspaceSchedule) => void;
}) {
  const user = useUser();
  const hub = useAssistantHub();
  if (!canUsePersonalAssistant({ permissions: user.permissions })) return null;
  const backgroundTaskRunning = hub.feed?.items?.some(
    (item) => item.kind === "task" && item.status === "running",
  );
  const state =
    hub.voiceState ||
    (hub.busy || backgroundTaskRunning
      ? "working"
      : hub.conversation?.ready
        ? "idle"
        : "unavailable");
  return (
    <section
      className="workspace-ai"
      data-core-state={state}
      aria-label="小序智能工作区"
    >
      <div className="workspace-ai-start">
        <div className="workspace-ai-core-stage">
          <AssistantCore />
          <div className="workspace-ai-orbit-slot" />
        </div>
        <PersonalAssistant
          available={available}
          schedule={schedule}
          onSchedule={onSchedule}
        />
      </div>
    </section>
  );
}

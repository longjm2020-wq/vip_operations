import { useEffect, useRef, useState } from "react";
import {
  CheckCircleOutlined,
  DownOutlined,
  FileTextOutlined,
  LoadingOutlined,
} from "@ant-design/icons";
import type {
  TeamArtifact,
  TeamRun,
  TeamStep,
} from "../../../packages/contracts/src/assistant-team";
import "./workspace-team-execution.css";

const statusLabels: Record<TeamRun["status"], string> = {
  QUEUED: "等待开始",
  PLANNING: "正在制定计划",
  RUNNING: "正在执行",
  REVIEWING: "正在验收",
  NEEDS_USER: "等待你补充",
  DONE: "已交付",
  FAILED: "执行中断",
  CANCELED: "已取消",
};
const stepLabels: Record<TeamStep["status"], string> = {
  PENDING: "等待开始",
  RUNNING: "正在执行",
  REVIEWING: "正在验收",
  REWORK: "正在修改",
  DONE: "已完成",
  NEEDS_USER: "等待你补充",
  FAILED: "步骤失败",
  CANCELED: "已取消",
};

/** Reveals already returned content; this is not a simulated model stream. */
function ReturnedText({
  text,
  identity,
  paused,
}: {
  text: string;
  identity: string;
  paused: boolean;
}) {
  const state = useRef({ identity: "", text: "", shown: 0 });
  const [display, setDisplay] = useState("");
  useEffect(() => {
    const current = state.current;
    if (current.identity !== identity || !text.startsWith(current.text))
      current.shown = 0;
    current.identity = identity;
    current.text = text;
    setDisplay(text.slice(0, current.shown));
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let previous = 0;
    const paint = (now: number) => {
      frame = 0;
      if (paused || document.hidden) {
        previous = 0;
        return;
      }
      if (reduced.matches) current.shown = text.length;
      else if (previous)
        current.shown = Math.min(
          text.length,
          current.shown +
            Math.min(now - previous, 100) * Math.max(0.045, text.length / 4000),
        );
      previous = now;
      setDisplay(text.slice(0, Math.floor(current.shown)));
      if (current.shown < text.length) frame = requestAnimationFrame(paint);
    };
    const resume = () => {
      previous = 0;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    resume();
    reduced.addEventListener("change", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      cancelAnimationFrame(frame);
      reduced.removeEventListener("change", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [text, identity, paused]);
  return (
    <div
      className="team-execution-output"
      data-typing={display.length < text.length}
    >
      <span className="team-execution-readable">{text}</span>
      <span aria-hidden="true">
        {display}
        <i className="team-execution-caret" />
      </span>
    </div>
  );
}

export function WorkspaceTeamExecution({
  run,
  covered,
  stale,
  onOpenArtifact,
  onRetry,
}: {
  run: TeamRun;
  covered: boolean;
  stale: boolean;
  onOpenArtifact: (artifact: TeamArtifact) => void;
  onRetry?: () => void;
}) {
  const rail = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  const [selected, setSelected] = useState("");
  useEffect(() => {
    const host = rail.current?.closest<HTMLElement>(".workspace-ai-core-stage");
    if (!host) return;
    const resize = new ResizeObserver(() =>
      setCompact(host.clientWidth < 1000),
    );
    setCompact(host.clientWidth < 1000);
    resize.observe(host);
    return () => resize.disconnect();
  }, []);
  const completed = run.steps.filter((step) => step.status === "DONE");
  const working = run.steps.filter((step) =>
    ["RUNNING", "REWORK", "REVIEWING"].includes(step.status),
  );
  const waiting = run.steps.find((step) => step.status === "NEEDS_USER");
  const failed = run.steps.find((step) => step.status === "FAILED");
  const step =
    run.status === "NEEDS_USER"
      ? waiting
      : run.status === "FAILED"
        ? failed
        : ["RUNNING", "REVIEWING"].includes(run.status)
          ? working.find((item) => item.id === selected) || working[0]
          : undefined;
  const memberName = (memberId: string) =>
    run.members
      .find((member) => member.id === memberId)
      ?.name.replace(/^小序\s*[·・]?\s*/, "");
  const problem = step?.error?.trim() || run.error.trim();
  const output = step?.result?.trim() || run.stage.trim();
  const live =
    !stale && ["PLANNING", "RUNNING", "REVIEWING"].includes(run.status);
  const terminal = run.status === "DONE";
  return (
    <aside
      ref={rail}
      className="team-execution-rail"
      aria-label="团队执行详情"
      data-compact={compact}
      data-delivered={terminal}
      data-world-ui
    >
      <details className="team-execution-completed" key={run.id}>
        <summary>
          <CheckCircleOutlined />
          <span>已完成</span>
          <b>{completed.length}</b>
          <DownOutlined />
        </summary>
        <div className="team-execution-completed-list">
          {!completed.length && (
            <p className="team-execution-empty">完成的步骤会保留在这里</p>
          )}
          {completed.map((item) => (
            <details className="team-execution-completed-step" key={item.id}>
              <summary>
                <span>{item.title}</span>
                <DownOutlined />
              </summary>
              <div className="team-execution-completed-copy">
                {memberName(item.memberId) && (
                  <small>{memberName(item.memberId)}</small>
                )}
                <p>{item.result || item.instruction}</p>
                {item.review && (
                  <p className="team-execution-review">{item.review}</p>
                )}
                {run.artifacts
                  .filter(
                    (artifact) =>
                      artifact.stepId === item.id &&
                      artifact.status !== "REJECTED",
                  )
                  .map((artifact) => (
                    <button
                      type="button"
                      key={artifact.id}
                      onClick={() => onOpenArtifact(artifact)}
                    >
                      <FileTextOutlined />
                      <span>{artifact.title}</span>
                    </button>
                  ))}
              </div>
            </details>
          ))}
        </div>
      </details>
      {stale && (
        <div className="team-execution-refresh" role="status">
          <span>进度暂未更新，保留上次内容</span>
          {onRetry && (
            <button type="button" onClick={onRetry}>
              重试
            </button>
          )}
        </div>
      )}
      {!terminal && (
        <section className="team-execution-current" data-active={live}>
          <header>
            <span className="team-execution-status">
              {live ? (
                <LoadingOutlined />
              ) : (
                <span className="team-execution-status-dot" />
              )}
              {stale
                ? "进度暂未更新"
                : step
                  ? stepLabels[step.status]
                  : statusLabels[run.status]}
            </span>
            {step && (
              <small>
                {run.steps.indexOf(step) + 1} / {run.steps.length}
              </small>
            )}
          </header>
          <h4>
            {step?.title ||
              (run.status === "PLANNING" ? "拆解任务与分配成员" : run.goal)}
          </h4>
          {step && memberName(step.memberId) && (
            <div className="team-execution-member">
              {memberName(step.memberId)}
            </div>
          )}
          {live && step && working.length > 1 && (
            <div className="team-execution-parallel" aria-label="并行执行步骤">
              {working.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={item.id === step?.id}
                  onClick={() => setSelected(item.id)}
                >
                  {item.title}
                </button>
              ))}
            </div>
          )}
          <div
            className="team-execution-scroll"
            tabIndex={0}
            aria-label="执行内容"
          >
            {problem && (
              <div className="team-execution-problem" role="status">
                {problem}
              </div>
            )}
            {step?.instruction && (
              <div className="team-execution-instruction">
                <small>执行目标</small>
                <p>{step.instruction}</p>
              </div>
            )}
            {output && (
              <div className="team-execution-returned">
                <small>{step?.result ? "已返回内容" : "当前状态"}</small>
                <ReturnedText
                  text={output}
                  identity={`${run.id}:${step?.id || run.status}`}
                  paused={covered || stale}
                />
              </div>
            )}
          </div>
        </section>
      )}
    </aside>
  );
}

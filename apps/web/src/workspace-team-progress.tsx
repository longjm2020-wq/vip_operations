import type { TeamRun } from "../../../packages/contracts/src/assistant-team";
import type { TeamEnergyTone } from "./workspace-team-state";
import {
  teamTaskProgress,
  type TeamProgressState,
} from "./workspace-team-progress-state";
import "./workspace-team-progress.css";

const stateLabels: Record<TeamProgressState, string> = {
  waiting: "等待开始",
  current: "进行中",
  complete: "已完成",
  paused: "已暂停",
  unverified: "待验收",
};

export function WorkspaceTeamProgress({
  run,
  stale,
  tone,
}: {
  run?: TeamRun;
  stale: boolean;
  tone: TeamEnergyTone;
}) {
  const progress = teamTaskProgress(run, stale);
  return (
    <section
      className="team-task-progress"
      aria-label="团队任务进度"
      data-status={run?.status || "LOADING"}
      data-health={progress.health}
      data-tone={tone}
      title={progress.note}
    >
      <ol>
        {progress.steps.map((step) => (
          <li
            key={step.key}
            data-step={step.key}
            data-state={step.state}
            aria-label={`${step.label}：${stateLabels[step.state]}`}
          >
            <span className="team-task-progress-dot" aria-hidden="true">
              {step.state === "complete" && (
                <svg viewBox="0 0 10 10">
                  <path d="m2 5 2 2 4-4" />
                </svg>
              )}
            </span>
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
      <span
        className="team-task-progress-note"
        role="status"
        aria-live="polite"
      >
        {progress.note}
      </span>
    </section>
  );
}

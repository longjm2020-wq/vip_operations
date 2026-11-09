import type { TeamRun } from "../../../packages/contracts/src/assistant-team.js";
import { hasTeamDelivery } from "./workspace-team-state.js";

export type TeamProgressKey = "planning" | "execution" | "review" | "delivery";
export type TeamProgressState =
  "waiting" | "current" | "complete" | "paused" | "unverified";
export type TeamProgressStep = {
  key: TeamProgressKey;
  label: string;
  state: TeamProgressState;
};

/** Milestones reflect server state, not elapsed time or an estimated percentage. */
export function teamTaskProgress(run?: TeamRun, stale = false) {
  const steps: TeamProgressStep[] = [
    { key: "planning", label: "规划", state: "waiting" },
    { key: "execution", label: "执行", state: "waiting" },
    { key: "review", label: "验收", state: "waiting" },
    { key: "delivery", label: "交付", state: "waiting" },
  ];
  let note = "正在读取任务进度";
  let health: "normal" | "attention" | "error" | "stale" = "normal";
  if (run?.status === "QUEUED") note = "排队等待";
  else if (run?.status === "PLANNING") {
    steps[0].state = "current";
    note = "正在规划";
  } else if (run) {
    const planned =
      run.steps.length > 0 ||
      ["RUNNING", "REVIEWING", "DONE"].includes(run.status);
    const reviewing =
      run.status === "REVIEWING" ||
      run.steps.some((step) => step.status === "REVIEWING");
    const executing = run.steps.some((step) =>
      ["PENDING", "RUNNING", "REWORK"].includes(step.status),
    );
    const finished = run.steps.filter((step) => step.status === "DONE").length;
    const count = run.steps.length
      ? ` · ${finished}/${run.steps.length} 步已完成`
      : "";
    steps[0].state = planned ? "complete" : "current";
    if (planned) steps[1].state = "current";
    if (reviewing) {
      steps[2].state = "current";
      if (!executing && run.steps.length) steps[1].state = "complete";
    }
    note = planned
      ? reviewing
        ? `执行与验收中${count}`
        : `执行中${count}`
      : "正在规划";
    if (run.status === "REVIEWING" && !executing) note = `正在验收${count}`;
    if (run.steps.some((step) => step.status === "REWORK"))
      note = `正在修改${count}`;
    if (run.status === "DONE") {
      const latestAttempts = new Map<string, number>();
      for (const artifact of run.artifacts) {
        const key = artifact.stepId || artifact.id;
        latestAttempts.set(
          key,
          Math.max(latestAttempts.get(key) ?? 0, artifact.attempt),
        );
      }
      const latest = run.artifacts.filter(
        (artifact) =>
          artifact.attempt ===
          latestAttempts.get(artifact.stepId || artifact.id),
      );
      const verified =
        latest.length > 0 &&
        latest.every((artifact) => artifact.status === "ACCEPTED");
      const delivered = hasTeamDelivery(run);
      steps[1].state = "complete";
      steps[2].state = verified ? "complete" : "unverified";
      steps[3].state = delivered ? "complete" : "waiting";
      note = delivered
        ? verified
          ? "成果已交付"
          : "已交付 · 待独立验收"
        : "执行结束 · 等待交付内容";
      if (!verified) health = "attention";
    } else if (["NEEDS_USER", "FAILED", "CANCELED"].includes(run.status)) {
      health = run.status === "FAILED" ? "error" : "attention";
      note =
        run.status === "NEEDS_USER"
          ? "等待补充资料"
          : run.status === "FAILED"
            ? "执行中断"
            : "任务已取消";
      for (const step of steps)
        if (step.state === "current") step.state = "paused";
    }
  }
  if (stale) {
    health = "stale";
    note = "进度暂未更新";
    for (const step of steps)
      if (step.state === "current") step.state = "paused";
  }
  return { steps, note, health };
}

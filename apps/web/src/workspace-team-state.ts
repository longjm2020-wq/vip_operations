import type {
  TeamArtifact,
  TeamMember,
  TeamRun,
} from "../../../packages/contracts/src/assistant-team";

export type TeamEnergyTone = "rose" | "ice";
export const teamIsRunning = (status: TeamRun["status"]) =>
  ["QUEUED", "PLANNING", "RUNNING", "REVIEWING"].includes(status);

/** Old drafts and rejected revisions are still accessible in the task details. */
export function teamSceneArtifacts(run: TeamRun): TeamArtifact[] {
  const latest = new Map<string, TeamArtifact>();
  for (const artifact of run.artifacts) {
    if (artifact.status === "REJECTED") continue;
    const key = artifact.stepId || artifact.id;
    const previous = latest.get(key);
    if (
      !previous ||
      artifact.attempt > previous.attempt ||
      (artifact.attempt === previous.attempt &&
        artifact.createdAt > previous.createdAt)
    )
      latest.set(key, artifact);
  }
  return [...latest.values()];
}

export function hasTeamDelivery(run: TeamRun) {
  return (
    !!run.summary.trim() ||
    teamSceneArtifacts(run).some(
      (item) =>
        !!item.content.trim() ||
        item.files.length > 0 ||
        item.citations.length > 0,
    )
  );
}

export function shouldCollectTeamEnergy(
  previous: TeamRun["status"] | undefined,
  run: TeamRun,
) {
  return (
    !!previous &&
    teamIsRunning(previous) &&
    run.status === "DONE" &&
    hasTeamDelivery(run)
  );
}

export function teamMemberActivity(run: TeamRun, member: TeamMember) {
  const steps = run.steps.filter((step) => step.memberId === member.id);
  const terminal = !teamIsRunning(run.status);
  if (run.status === "FAILED") return { label: "任务失败", active: false };
  if (run.status === "CANCELED") return { label: "任务已取消", active: false };
  if (run.status === "NEEDS_USER") return { label: "等待补充", active: false };
  if (member.role === "coordinator") {
    const reviewing =
      run.status === "REVIEWING" ||
      run.steps.some((s) => s.status === "REVIEWING");
    return {
      label: reviewing
        ? "正在验收"
        : terminal
          ? run.artifacts.some((a) => a.status === "ACCEPTED")
            ? "验收通过"
            : "未独立验收"
          : "等待交付",
      active: reviewing,
    };
  }
  if (member.role === "librarian") {
    const filing = !terminal && /归档|知识整理/.test(run.stage);
    return {
      label: terminal ? "成果已汇总" : filing ? "正在归档" : "资料协同",
      active: filing,
    };
  }
  if (steps.some((s) => s.status === "REWORK"))
    return { label: "正在修改", active: true };
  if (steps.some((s) => s.status === "RUNNING"))
    return { label: "正在执行", active: true };
  if (steps.some((s) => s.status === "REVIEWING"))
    return { label: "等待验收", active: true };
  if (steps.some((s) => s.status === "NEEDS_USER"))
    return { label: "等待补充", active: false };
  if (steps.some((s) => s.status === "FAILED"))
    return { label: "步骤失败", active: false };
  if (steps.length && steps.every((s) => s.status === "DONE"))
    return { label: "已完成", active: false };
  return { label: steps.length ? "等待前置步骤" : "未分配步骤", active: false };
}

export function teamSceneMembers(run: TeamRun) {
  // An external engine does not expose the site's configured member roster.
  if (run.engine === "deerflow") return [];
  const enabled = run.members.filter(
    (member) => member.enabled && member.role !== "orchestrator",
  );
  const assigned = new Set(run.steps.map((step) => step.memberId));
  return [...enabled].sort(
    (a, b) => Number(assigned.has(b.id)) - Number(assigned.has(a.id)),
  );
}

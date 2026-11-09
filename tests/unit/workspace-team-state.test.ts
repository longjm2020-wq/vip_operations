import { describe, expect, test } from "vitest";
import {
  defaultTeamSettings,
  type TeamArtifact,
  type TeamRun,
} from "../../packages/contracts/src/assistant-team";
import {
  hasTeamDelivery,
  shouldCollectTeamEnergy,
  teamMemberActivity,
  teamSceneArtifacts,
  teamSceneMembers,
} from "../../apps/web/src/workspace-team-state";

const base = (): TeamRun => ({
  id: "run",
  engine: "native",
  goal: "生成企划",
  status: "RUNNING",
  stage: "创作中",
  plan: "",
  steps: [],
  artifacts: [],
  summary: "",
  error: "",
  createdAt: "2026-11-09T10:00:00Z",
  updatedAt: "2026-11-09T10:00:00Z",
  members: defaultTeamSettings().members,
});
const artifact = (
  status: TeamArtifact["status"],
  attempt = 1,
): TeamArtifact => ({
  id: `a-${attempt}`,
  runId: "run",
  stepId: "writing",
  memberId: "writing",
  attempt,
  title: "企划",
  kind: "text",
  content: "实际正文",
  files: [],
  fileIds: [],
  citations: [],
  status,
  review: "",
  tags: [],
  createdAt: "2026-11-09T10:00:00Z",
});
describe("workspace team visualization reflects server results", () => {
  test("only a newly observed successful delivery can collect energy", () => {
    const run = {
      ...base(),
      status: "DONE" as const,
      artifacts: [artifact("ACCEPTED")],
    };
    expect(shouldCollectTeamEnergy("RUNNING", run)).toBe(true);
    expect(shouldCollectTeamEnergy("REVIEWING", run)).toBe(true);
    expect(shouldCollectTeamEnergy(undefined, run)).toBe(false);
    expect(shouldCollectTeamEnergy("DONE", run)).toBe(false);
    for (const status of ["FAILED", "NEEDS_USER", "CANCELED"] as const) {
      expect(shouldCollectTeamEnergy("RUNNING", { ...run, status })).toBe(
        false,
      );
      expect(shouldCollectTeamEnergy(status, run)).toBe(false);
    }
    expect(
      shouldCollectTeamEnergy("RUNNING", {
        ...run,
        artifacts: [],
        summary: "",
      }),
    ).toBe(false);
  });
  test("DeerFlow drafts remain drafts and never inherit the site's local team", () => {
    const run = {
      ...base(),
      engine: "deerflow" as const,
      status: "DONE" as const,
      artifacts: [artifact("DRAFT")],
    };
    expect(teamSceneMembers(run)).toEqual([]);
    expect(teamSceneArtifacts(run)[0].status).toBe("DRAFT");
    expect(hasTeamDelivery(run)).toBe(true);
  });
  test("rejected revisions are not promoted and the newest deliverable is selected", () => {
    const run = {
      ...base(),
      artifacts: [
        artifact("DRAFT"),
        artifact("ACCEPTED", 2),
        artifact("REJECTED", 3),
      ],
    };
    expect(teamSceneArtifacts(run).map((a) => a.id)).toEqual(["a-2"]);
    expect(hasTeamDelivery({ ...run, artifacts: [artifact("REJECTED")] })).toBe(
      false,
    );
    expect(
      hasTeamDelivery({ ...run, artifacts: [], summary: "实际任务总结" }),
    ).toBe(true);
  });
  test("unassigned roles are idle and failures cannot look like active work", () => {
    const run = base(),
      writer = run.members.find((m) => m.role === "writer")!;
    expect(teamMemberActivity(run, writer)).toEqual({
      label: "未分配步骤",
      active: false,
    });
    const failed = { ...run, status: "FAILED" as const };
    expect(teamMemberActivity(failed, writer)).toEqual({
      label: "任务失败",
      active: false,
    });
    const reviewer = run.members.find((m) => m.role === "coordinator")!;
    expect(teamMemberActivity({ ...run, status: "DONE" }, reviewer).label).toBe(
      "未独立验收",
    );
    expect(
      teamMemberActivity({ ...run, status: "REVIEWING" }, reviewer).active,
    ).toBe(true);
  });
});

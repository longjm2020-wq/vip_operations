import { describe, expect, test } from "vitest";
import type {
  TeamArtifact,
  TeamRun,
  TeamStep,
} from "../../packages/contracts/src/assistant-team.js";
import { teamTaskProgress } from "../../apps/web/src/workspace-team-progress-state.js";

const step = (status: TeamStep["status"], id = "writing"): TeamStep => ({
  id,
  title: "创作方案",
  memberId: "writer",
  instruction: "根据任务要求创作",
  dependencies: [],
  difficulty: "standard",
  deliverable: "text",
  acceptance: ["内容完整"],
  status,
  attempts: 1,
  jobIds: [],
  artifactIds: [],
});
const artifact = (
  status: TeamArtifact["status"],
  attempt = 1,
  id = `a-${attempt}`,
): TeamArtifact => ({
  id,
  runId: "run",
  stepId: "writing",
  memberId: "writer",
  attempt,
  title: "方案",
  kind: "text",
  content: "实际交付正文",
  fileIds: [],
  files: [],
  citations: [],
  status,
  review: "",
  tags: [],
  createdAt: "2026-11-10T10:00:00Z",
});
const run = (overrides: Partial<TeamRun> = {}): TeamRun => ({
  id: "run",
  engine: "native",
  goal: "创作方案",
  status: "RUNNING",
  stage: "执行中",
  plan: "",
  steps: [step("RUNNING")],
  artifacts: [],
  summary: "",
  error: "",
  createdAt: "2026-11-10T10:00:00Z",
  updatedAt: "2026-11-10T10:00:00Z",
  members: [],
  ...overrides,
});
const states = (result: ReturnType<typeof teamTaskProgress>) =>
  result.steps.map((item) => item.state);

describe("team task milestones use confirmed server progress", () => {
  test("unknown and queued runs do not claim planning has started", () => {
    expect(states(teamTaskProgress())).toEqual(Array(4).fill("waiting"));
    expect(teamTaskProgress().note).toBe("正在读取任务进度");
    const queued = teamTaskProgress(run({ status: "QUEUED" }));
    expect(states(queued)).toEqual(Array(4).fill("waiting"));
    expect(queued.note).toBe("排队等待");
  });

  test("replanning remains in planning even when previous steps exist", () => {
    const result = teamTaskProgress(
      run({ status: "PLANNING", steps: [step("DONE")] }),
    );
    expect(states(result)).toEqual([
      "current",
      "waiting",
      "waiting",
      "waiting",
    ]);
    expect(result.note).toBe("正在规划");
  });

  test("execution and review may run together without completing delivery", () => {
    const result = teamTaskProgress(
      run({
        steps: [
          step("DONE", "research"),
          step("RUNNING"),
          step("REVIEWING", "design"),
        ],
      }),
    );
    expect(states(result)).toEqual([
      "complete",
      "current",
      "current",
      "waiting",
    ]);
    expect(result.note).toBe("执行与验收中 · 1/3 步已完成");
    const review = teamTaskProgress(
      run({ status: "REVIEWING", steps: [step("REVIEWING")] }),
    );
    expect(states(review)).toEqual([
      "complete",
      "complete",
      "current",
      "waiting",
    ]);
    expect(review.note).toBe("正在验收 · 0/1 步已完成");
  });

  test("accepted artifacts cannot complete an active run", () => {
    const result = teamTaskProgress(
      run({
        steps: [step("DONE")],
        artifacts: [artifact("ACCEPTED")],
      }),
    );
    expect(states(result)).toEqual([
      "complete",
      "current",
      "waiting",
      "waiting",
    ]);
  });

  test("completion requires a real delivery and verified latest artifacts", () => {
    const result = teamTaskProgress(
      run({
        status: "DONE",
        steps: [step("DONE")],
        artifacts: [artifact("REJECTED"), artifact("ACCEPTED", 2)],
      }),
    );
    expect(states(result)).toEqual(Array(4).fill("complete"));
    expect(result.note).toBe("成果已交付");
    const empty = teamTaskProgress(run({ status: "DONE", steps: [] }));
    expect(empty.steps[3].state).toBe("waiting");
    expect(empty.note).toBe("执行结束 · 等待交付内容");
  });

  test("draft deliveries and mixed artifacts in the same attempt remain unverified", () => {
    const draft = teamTaskProgress(
      run({
        engine: "deerflow",
        status: "DONE",
        artifacts: [artifact("DRAFT")],
      }),
    );
    expect(states(draft)).toEqual([
      "complete",
      "complete",
      "unverified",
      "complete",
    ]);
    expect(draft.note).toBe("已交付 · 待独立验收");
    expect(draft.health).toBe("attention");
    for (const artifacts of [
      [artifact("DRAFT", 2, "draft"), artifact("ACCEPTED", 2, "accepted")],
      [artifact("ACCEPTED"), artifact("REJECTED", 2)],
    ]) {
      expect(
        teamTaskProgress(run({ status: "DONE", artifacts })).steps[2].state,
      ).toBe("unverified");
    }
  });

  test("interruptions preserve known milestones and pause unfinished work", () => {
    for (const [status, note, health] of [
      ["NEEDS_USER", "等待补充资料", "attention"],
      ["FAILED", "执行中断", "error"],
      ["CANCELED", "任务已取消", "attention"],
    ] as const) {
      const result = teamTaskProgress(run({ status }));
      expect(states(result)).toEqual([
        "complete",
        "paused",
        "waiting",
        "waiting",
      ]);
      expect(result).toMatchObject({ note, health });
    }
    expect(
      states(teamTaskProgress(run({ status: "FAILED", steps: [] }))),
    ).toEqual(["paused", "waiting", "waiting", "waiting"]);
  });

  test("failed refresh freezes active milestones and retains confirmed completion", () => {
    const result = teamTaskProgress(
      run({
        steps: [step("RUNNING"), step("REVIEWING", "design")],
      }),
      true,
    );
    expect(states(result)).toEqual(["complete", "paused", "paused", "waiting"]);
    expect(result).toMatchObject({ health: "stale", note: "进度暂未更新" });
    const completed = run({
      status: "DONE",
      artifacts: [artifact("ACCEPTED")],
    });
    expect(states(teamTaskProgress(completed, true))).toEqual(
      Array(4).fill("complete"),
    );
  });
});

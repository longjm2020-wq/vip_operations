import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  defaultTeamSettings,
  type TeamArtifact,
  type TeamPlanStep,
} from "../../packages/contracts/src/assistant-team.js";
import {
  executeTeamRun,
  readTeamModelResponse,
  teamDelay,
  type TeamExecutionDependencies,
  type TeamExecutionInput,
  type TeamModelRequest,
  type TeamModelResult,
} from "../../apps/api/src/modules/workspace/team-executor.js";

function step(
  id: string,
  dependencies: string[] = [],
  deliverable: TeamPlanStep["deliverable"] = "text",
): TeamPlanStep {
  return {
    id,
    title: id,
    memberId: "writing",
    instruction: "写出完整可交付内容",
    dependencies,
    difficulty: "standard",
    deliverable,
    acceptance: ["包含完整正文且不编造事实"],
  };
}
function fixture(steps: TeamPlanStep[] = [step("write")]) {
  const input: TeamExecutionInput = {
    id: randomUUID(),
    goal: "创作一份使用说明",
    attachmentIds: [],
    useKnowledge: true,
    settings: defaultTeamSettings(),
    settingsVersion: 1,
  };
  const calls: TeamModelRequest[] = [];
  const artifacts: TeamArtifact[] = [];
  const save = vi.fn();
  let handler:
    | ((
        request: TeamModelRequest,
      ) => Promise<Partial<TeamModelResult> | undefined>)
    | undefined;
  const deps: TeamExecutionDependencies = {
    check: vi.fn(async () => {}),
    save,
    knowledge: vi.fn(async () => []),
    artifact: vi.fn(async (a) => {
      const i = artifacts.findIndex((item) => item.id === a.id);
      if (i < 0) artifacts.push(structuredClone(a));
      else artifacts[i] = structuredClone(a);
    }),
    call: vi.fn(async (request) => {
      calls.push(request);
      const override = await handler?.(request);
      const data =
        request.purpose === "plan"
          ? { summary: "实际协作计划", steps }
          : request.purpose === "brief"
            ? { brief: "根据已授权资料创作，引用来源，不编造事实" }
            : request.purpose === "execute"
              ? { status: "completed", content: "这是一份完整说明正文。" }
              : request.purpose === "review"
                ? { accepted: true, review: "正文满足全部验收项" }
                : request.purpose === "archive"
                  ? { summary: "使用说明已验收归档", tags: ["说明"] }
                  : request.purpose === "summary"
                    ? { summary: "全部已验收成果已汇总" }
                    : { ids: [], summary: "无相关历史内容" };
      return {
        data,
        model: "actual/model",
        modelId: "engine/id",
        routeReason: "按任务难度选择",
        files: [],
        citations: [],
        ...override,
      };
    }),
  };
  return {
    input,
    deps,
    calls,
    artifacts,
    save,
    handle(fn: NonNullable<typeof handler>) {
      handler = fn;
    },
    run(signal = new AbortController().signal) {
      return executeTeamRun(input, deps, signal);
    },
  };
}

describe("team orchestration", () => {
  it("executes ready steps concurrently, waits for acceptance before dependencies, and archives actual results", async () => {
    const f = fixture([
      step("first"),
      step("parallel"),
      step("dependent", ["first", "parallel"]),
    ]);
    let running = 0,
      maxRunning = 0;
    f.handle(async (request) => {
      if (request.purpose === "execute") {
        running++;
        maxRunning = Math.max(maxRunning, running);
        if (request.step!.id === "dependent")
          expect(
            f.artifacts.filter((a) => a.status === "ACCEPTED"),
          ).toHaveLength(2);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
      }
      return undefined;
    });
    const result = await f.run();
    expect(result.status).toBe("DONE");
    expect(maxRunning).toBe(2);
    expect(f.artifacts).toHaveLength(3);
    expect(f.artifacts.every((a) => a.status === "ACCEPTED")).toBe(true);
    expect(
      f.calls
        .filter((r) => r.purpose === "review")
        .every((r) => r.member.role === "coordinator"),
    ).toBe(true);
    expect(
      f.calls
        .filter((r) => r.purpose === "archive")
        .every((r) => r.member.role === "librarian"),
    ).toBe(true);
    expect(result.state.steps[0].model).toBe("actual/model");
    expect(f.save.mock.calls.at(-1)?.[1]).toBe("DONE");
  });
  it("requires actual completed files and never accepts queued receipts as deliverables", async () => {
    const f = fixture([
      step("document", [], "document"),
      step("blocked", ["document"]),
      step("independent"),
    ]);
    f.handle(async (request) => {
      if (request.purpose === "execute" && request.step!.id === "document") {
        await request.onJob!("queued-job");
        return { data: { status: "completed", content: "任务已排队" } };
      }
      return undefined;
    });
    const result = await f.run();
    expect(result.status).toBe("NEEDS_USER");
    expect(result.state.steps[0].jobIds).toEqual(["queued-job"]);
    expect(result.state.steps[0].status).toBe("NEEDS_USER");
    expect(result.state.steps[1].status).toBe("NEEDS_USER");
    expect(
      f.calls.some((r) => r.purpose === "execute" && r.step?.id === "blocked"),
    ).toBe(false);
    expect(result.state.steps[2].status).toBe("DONE");
    expect(f.artifacts).toHaveLength(1);
  });
  it("passes actual output files to review and only accepted predecessor files to the next step", async () => {
    const f = fixture([
      step("document", [], "document"),
      step("followup", ["document"]),
    ]);
    const file = {
      id: randomUUID(),
      name: "真实文档.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 1200,
      source: "generated" as const,
      createdAt: new Date().toISOString(),
    };
    f.handle(async (request) =>
      request.purpose === "execute" && request.step!.id === "document"
        ? { files: [file] }
        : undefined,
    );
    await f.run();
    expect(f.calls.find((r) => r.purpose === "review")?.fileIds).toEqual([
      file.id,
    ]);
    expect(
      f.calls.find((r) => r.purpose === "execute" && r.step!.id === "followup")
        ?.fileIds,
    ).toEqual([file.id]);
    expect(f.artifacts[0].files).toEqual([file]);
  });
  it("compares review against original source files and supplies rejected files for revision", async () => {
    const f = fixture([step("image", [], "image")]);
    const sourceId = randomUUID(),
      generatedId = randomUUID();
    f.input.attachmentIds = [sourceId];
    let reviews = 0;
    f.handle(async (request) => {
      if (request.purpose === "execute")
        return {
          files: [
            {
              id: generatedId,
              name: "产物.png",
              mime: "image/png",
              size: 1000,
              source: "generated",
              createdAt: new Date().toISOString(),
            },
          ],
        };
      if (request.purpose === "review")
        return {
          data: {
            accepted: ++reviews > 1,
            review: reviews === 1 ? "在原图上修改标题" : "修改符合要求",
          },
        };
      return undefined;
    });
    await f.run();
    const review = f.calls.filter((r) => r.purpose === "review");
    expect(review[0].fileIds).toEqual([sourceId, generatedId]);
    const revision = f.calls.filter((r) => r.purpose === "execute")[1];
    expect(revision.fileIds).toEqual([sourceId, generatedId]);
    expect(revision.prompt).toContain("previousDeliverable");
    expect(revision.prompt).toContain(generatedId);
    expect(f.artifacts.map((a) => a.status)).toEqual(["REJECTED", "ACCEPTED"]);
  });
  it("revises only after an actual rejection and stops at the configured limit", async () => {
    const f = fixture();
    f.input.settings.maxRevisions = 1;
    f.handle(async (request) =>
      request.purpose === "review"
        ? { data: { accepted: false, review: "缺少第二部分的实质内容" } }
        : undefined,
    );
    const result = await f.run();
    expect(result.status).toBe("NEEDS_USER");
    expect(result.state.steps[0].attempts).toBe(2);
    expect(f.calls.filter((r) => r.purpose === "execute")).toHaveLength(2);
    expect(f.calls.filter((r) => r.purpose === "archive")).toHaveLength(0);
    expect(f.artifacts.map((a) => a.status)).toEqual(["REJECTED", "REJECTED"]);
    expect(f.calls.filter((r) => r.purpose === "execute")[1].prompt).toContain(
      "缺少第二部分",
    );
  });
  it("does not retry failed provider work, and keeps independent accepted work", async () => {
    const f = fixture([step("failed"), step("usable")]);
    f.handle(async (request) => {
      if (request.purpose === "execute" && request.step!.id === "failed")
        throw Error("provider secret body");
      return undefined;
    });
    const result = await f.run();
    expect(result.status).toBe("NEEDS_USER");
    expect(
      f.calls.filter((r) => r.purpose === "execute" && r.step!.id === "failed"),
    ).toHaveLength(1);
    expect(result.state.steps[0].error).not.toContain("secret");
    expect(f.artifacts[0].status).toBe("ACCEPTED");
  });
  it("requires verified citations for research", async () => {
    const f = fixture([step("research", [], "research")]);
    const result = await f.run();
    expect(result.status).toBe("NEEDS_USER");
    expect(f.artifacts).toHaveLength(0);
  });
  it("distributes only selected accepted knowledge and rejects invented archive IDs", async () => {
    const f = fixture();
    const record = {
      id: randomUUID(),
      title: "历史知识",
      content: "核实后的旧内容",
      tags: [],
      citations: [],
      fileIds: [],
    } as unknown as TeamArtifact;
    f.deps.knowledge = async () => [record];
    f.handle(async (request) =>
      request.purpose === "knowledge"
        ? { data: { ids: [record.id], summary: "相关" } }
        : undefined,
    );
    await f.run();
    expect(f.calls.find((r) => r.purpose === "brief")?.prompt).toContain(
      "核实后的旧内容",
    );
    const invalid = fixture();
    invalid.deps.knowledge = async () => [record];
    invalid.handle(async (request) =>
      request.purpose === "knowledge"
        ? { data: { ids: [randomUUID()], summary: "虚构" } }
        : undefined,
    );
    await expect(invalid.run()).rejects.toThrow("不存在的资料");
    expect(invalid.calls.some((r) => r.purpose === "execute")).toBe(false);
  });
  it("interrupts before accepting late model output and does not dispatch dependent actions", async () => {
    const f = fixture([step("first"), step("later", ["first"])]),
      controller = new AbortController();
    f.handle(async (request) => {
      if (request.purpose === "execute") controller.abort();
      return undefined;
    });
    await expect(f.run(controller.signal)).rejects.toThrow();
    expect(f.artifacts).toHaveLength(0);
    expect(f.calls.some((r) => r.purpose === "review")).toBe(false);
    expect(f.calls.some((r) => r.step?.id === "later")).toBe(false);
  });
  it("rejects invalid cyclic/future dependencies before any execution", async () => {
    const f = fixture([step("a", ["b"]), step("b", ["a"])]);
    await expect(f.run()).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });
  it("stops a pending media wait immediately on cancellation", async () => {
    const controller = new AbortController();
    const pending = teamDelay(60000, controller.signal);
    controller.abort(new Error("canceled"));
    await expect(pending).rejects.toThrow("canceled");
  });
  it("bounds model response bytes and does not expose rejected provider content", async () => {
    await expect(
      readTeamModelResponse(
        Response.json({ text: "private".repeat(50000) }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("大小限制");
    await expect(
      readTeamModelResponse(
        new Response("private malformed body"),
        new AbortController().signal,
      ),
    ).rejects.toThrow("格式无效");
    await expect(
      readTeamModelResponse(
        Response.json({ good: true }),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ good: true });
  });
  it("aborts a stalled provider body without waiting for its stream", async () => {
    const controller = new AbortController();
    const pending = readTeamModelResponse(
      new Response(new ReadableStream()),
      controller.signal,
    );
    controller.abort(new Error("canceled"));
    await expect(pending).rejects.toThrow("canceled");
  });
});

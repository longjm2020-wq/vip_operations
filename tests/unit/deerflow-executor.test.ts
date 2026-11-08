import { installAiManagementSchema } from "../fixtures/ai-management-schema.js";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Context } from "../../apps/api/src/core.js";
import type { Row, Tx } from "../../packages/database/src/index.js";

const f = vi.hoisted(() => ({
  db: null as PGlite | null,
  beforeTransaction: undefined as (() => Promise<void>) | undefined,
  knowledge: vi.fn(),
  createClient: vi.fn(),
  client: {
    createThread: vi.fn(),
    upload: vi.fn(),
    startRun: vi.fn(),
    getRun: vi.fn(),
    listRuns: vi.fn(),
    getState: vi.fn(),
    downloadFile: vi.fn(),
    cancel: vi.fn(),
  },
}));
vi.mock("../../packages/database/src/index.js", async (original) => {
  const actual =
    await original<typeof import("../../packages/database/src/index.js")>();
  const wrap = (connection: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) =>
      (await connection.query(sql, params)).rows,
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) =>
      (await connection.query(sql, params)).affectedRows || 0,
  });
  return {
    ...actual,
    db: {
      $queryRawUnsafe: async (sql: string, ...params: unknown[]) =>
        (await f.db!.query(sql, params)).rows,
      $executeRawUnsafe: async (sql: string, ...params: unknown[]) =>
        (await f.db!.query(sql, params)).affectedRows || 0,
      $transaction: async (work: (tx: Tx) => Promise<unknown>) => {
        const hook = f.beforeTransaction;
        f.beforeTransaction = undefined;
        if (hook) await hook();
        return f.db!.transaction((tx) => work(wrap(tx) as unknown as Tx));
      },
    },
  };
});
vi.mock(
  "../../apps/api/src/modules/workspace/deerflow-client.js",
  async (original) => ({
    ...(await original<
      typeof import("../../apps/api/src/modules/workspace/deerflow-client.js")
    >()),
    createDeerFlowClient: f.createClient,
  }),
);
vi.mock("../../apps/api/src/modules/workspace/team-knowledge.js", () => ({
  searchTeamKnowledge: f.knowledge,
}));
vi.mock("../../apps/api/src/modules/workspace/team-executor.js", () => ({
  TeamNeedsUser: class extends Error {},
}));
vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));

import {
  runDeerFlowExecution,
  stopOrphanedDeerFlowRuns,
} from "../../apps/api/src/modules/workspace/deerflow-executor.js";

const context = (id = "7"): Context => ({
  actor: {
    id,
    username: "test",
    displayName: "Test",
    permissions: ["analytics.read", "analytics.manage"],
  },
  requestId: randomUUID(),
});
async function row(sql: string, params: unknown[] = []) {
  return (await f.db!.query<Row>(sql, params)).rows[0];
}
async function task(
  input: Partial<{
    attachmentIds: string[];
    useKnowledge: boolean;
    conversationContext: string;
  }> = {},
) {
  const id = randomUUID(),
    lease = randomUUID();
  await f.db!.query(
    "INSERT INTO personal_assistant_team_runs(id,user_id,request_hash,input,state,status,lease_id) VALUES($1,7,'test',$2,'{}','PLANNING',$3)",
    [
      id,
      JSON.stringify({
        engine: "deerflow",
        goal: "整理产品资料",
        attachmentIds: [],
        useKnowledge: false,
        ...input,
      }),
      lease,
    ],
  );
  return {
    run: (await row("SELECT * FROM personal_assistant_team_runs WHERE id=$1", [
      id,
    ]))!,
    lease,
  };
}
async function addFile(owner = 7) {
  const id = randomUUID();
  await f.db!.query(
    "INSERT INTO personal_assistant_files(id,user_id,name,mime,size,source,content) VALUES($1,$2,'资料.txt','text/plain',4,'upload',$3)",
    [id, owner, new Uint8Array([100, 97, 116, 97])],
  );
  return id;
}
const execute = ({ run, lease }: Awaited<ReturnType<typeof task>>) =>
  runDeerFlowExecution(context(), run, lease, new AbortController().signal);

beforeAll(async () => {
  f.db = new PGlite();
  await f.db.exec(
    "CREATE TABLE users(id bigint PRIMARY KEY,status text); INSERT INTO users VALUES(7,'ACTIVE'),(8,'ACTIVE'); CREATE TABLE permissions(id bigint PRIMARY KEY,code text); INSERT INTO permissions VALUES(1,'analytics.read'); CREATE TABLE roles(id bigint PRIMARY KEY,code text); INSERT INTO roles VALUES(1,'STAFF'); CREATE TABLE user_roles(user_id bigint,role_id bigint); INSERT INTO user_roles VALUES(7,1),(8,1); CREATE TABLE role_permissions(role_id bigint,permission_id bigint); INSERT INTO role_permissions VALUES(1,1);",
  );
  await installAiManagementSchema(f.db);
  for (const file of ["083_assistant_agent.sql", "090_assistant_team.sql"])
    await f.db.exec(
      await readFile("packages/database/migrations/" + file, "utf8"),
    );
  await f.db.exec(
    "INSERT INTO permissions VALUES(2,'analytics.manage'); INSERT INTO role_permissions VALUES(1,2);",
  );
});
beforeEach(async () => {
  await f.db!.exec(
    "TRUNCATE personal_assistant_team_runs CASCADE; TRUNCATE personal_assistant_files; UPDATE users SET status='ACTIVE';",
  );
  vi.clearAllMocks();
  for (const method of Object.values(f.client)) method.mockReset();
  f.beforeTransaction = undefined;
  f.knowledge.mockReset().mockResolvedValue([]);
  f.createClient.mockReset().mockReturnValue(f.client);
  f.client.createThread.mockResolvedValue(undefined);
  f.client.upload.mockImplementation(async (_id, file) => ({
    filename: file.name,
    size: file.content.length,
    virtualPath: `/mnt/user-data/uploads/${file.name}`,
  }));
  f.client.startRun.mockImplementation(async (threadId) => ({
    run_id: "remote-run",
    thread_id: threadId,
    status: "success",
  }));
  f.client.getState.mockResolvedValue({
    text: "已整理资料，交付供核对。",
    artifacts: [],
    interrupted: false,
  });
  f.client.downloadFile.mockResolvedValue({
    name: "报告.md",
    mime: "text/markdown",
    content: Buffer.from("# 研究报告"),
  });
  f.client.cancel.mockResolvedValue(undefined);
  f.client.listRuns.mockImplementation(async (threadId) => [
    { thread_id: threadId, run_id: "orphan", status: "running" },
  ]);
});
afterAll(async () => {
  await f.db?.close();
});

describe("DeerFlow execution ownership and truthful delivery", () => {
  it("uploads only owned requested/reference files and stores returned files as an unaccepted draft", async () => {
    const attached = await addFile(),
      reference = await addFile();
    f.knowledge.mockResolvedValue([
      {
        title: "参考资料",
        content: "旧资料正文",
        review: "已验收",
        citations: [],
        file_ids: [reference, attached],
      },
    ]);
    f.client.getState.mockResolvedValue({
      text: "研究报告正文",
      artifacts: ["/mnt/user-data/outputs/report.md"],
      interrupted: false,
    });
    const current = await task({
      attachmentIds: [attached],
      useKnowledge: true,
      conversationContext: "当前聊天主题：秋季轻旅",
    });
    await execute(current);
    expect(f.knowledge).toHaveBeenCalledWith("7", "整理产品资料", true);
    expect(f.client.upload).toHaveBeenCalledTimes(2);
    expect(f.client.startRun).toHaveBeenCalledTimes(1);
    expect(f.client.startRun.mock.calls[0][1]).toContain("旧资料正文");
    expect(f.client.startRun.mock.calls[0][1]).toContain(
      "当前聊天主题：秋季轻旅",
    );
    expect(f.client.startRun.mock.calls[0][3]).toEqual({
      idempotencyKey: current.run.id,
    });
    expect(f.createClient.mock.calls.every((call) => call[0] === "7")).toBe(
      true,
    );
    const artifact = await row(
      "SELECT * FROM personal_assistant_team_artifacts",
    );
    expect(artifact).toMatchObject({
      user_id: 7,
      status: "DRAFT",
      content: "研究报告正文",
    });
    expect(artifact!.review).toContain("尚未经过本站独立验收");
    const file = await row(
      "SELECT id,user_id,source FROM personal_assistant_files WHERE source='generated'",
    );
    expect(file).toMatchObject({ user_id: 7, source: "generated" });
    expect(artifact!.file_ids).toEqual([file!.id]);
    expect(
      (await row(
        "SELECT count(*)::int AS n FROM personal_assistant_team_artifacts WHERE status='ACCEPTED'",
      ))!.n,
    ).toBe(0);
    expect(
      await row(
        "SELECT status,summary FROM personal_assistant_team_runs WHERE id=$1",
        [current.run.id],
      ),
    ).toMatchObject({ status: "DONE", summary: "研究报告正文" });
  });

  it("skips missing, invalid, and foreign knowledge references while retaining the owned reference", async () => {
    const owned = await addFile(),
      deleted = await addFile(),
      foreign = await addFile(8);
    await f.db!.query("DELETE FROM personal_assistant_files WHERE id=$1", [
      deleted,
    ]);
    f.knowledge.mockResolvedValue([
      {
        title: "仍可复用的档案正文",
        content: "文件已删除时仍保留正文",
        file_ids: [deleted, randomUUID(), "invalid", foreign, owned, owned],
      },
    ]);
    await execute(await task({ useKnowledge: true }));
    expect(f.client.upload).toHaveBeenCalledTimes(1);
    expect(f.client.upload.mock.calls[0][1].name).toContain(owned);
    expect(f.client.startRun).toHaveBeenCalledTimes(1);
    const prompt = f.client.startRun.mock.calls[0][1];
    expect(prompt).toContain("文件已删除时仍保留正文");
    expect(prompt).toContain("已删除或超出本次10份文件范围的文件未提供");
    for (const id of [deleted, foreign, owned])
      expect(prompt).not.toContain(id);
  });

  it("bounds matched archive text and associated files while preserving all explicit attachments", async () => {
    const attached: string[] = [],
      references: string[] = [];
    for (let i = 0; i < 6; i++) attached.push(await addFile());
    for (let i = 0; i < 12; i++) references.push(await addFile());
    f.knowledge.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({
        title: `${i}:` + "t".repeat(200),
        content: "c".repeat(12000) + `omitted-tail-${i}`,
        review: "r".repeat(2500),
        file_ids: i === 0 ? [...references, ...attached] : [],
        citations: Array.from({ length: 6 }, () => ({
          title: "s".repeat(220),
          url: "https://example.com/" + "u".repeat(2200),
        })),
      })),
    );
    await execute(await task({ attachmentIds: attached, useKnowledge: true }));
    expect(f.knowledge).toHaveBeenCalledWith("7", "整理产品资料", true);
    expect(f.client.upload).toHaveBeenCalledTimes(10);
    const uploadedIds = f.client.upload.mock.calls.map((call) =>
      call[1].name.slice(0, 36),
    );
    expect(uploadedIds.slice(0, 6)).toEqual(attached);
    expect(new Set(uploadedIds).size).toBe(10);
    expect(uploadedIds.slice(6).every((id) => references.includes(id))).toBe(
      true,
    );
    const prompt = f.client.startRun.mock.calls[0][1] as string;
    const archives = JSON.parse(prompt.slice(prompt.indexOf("[{")));
    expect(archives).toHaveLength(4);
    for (const [i, archive] of archives.entries()) {
      expect(archive.title.startsWith(`${i}:`)).toBe(true);
      expect(archive.title).toHaveLength(180);
      expect(archive.content).toBe("c".repeat(12000));
      expect(archive.review).toHaveLength(2000);
      expect(archive.citations).toHaveLength(3);
      for (const citation of archive.citations) {
        expect(citation.title).toHaveLength(180);
        expect(citation.url).toHaveLength(2000);
      }
    }
    expect(prompt).not.toContain("omitted-tail");
    expect(prompt.length).toBeLessThan(120000);
    expect(f.client.startRun).toHaveBeenCalledTimes(1);
  });

  it("rejects a deleted explicit attachment instead of silently omitting it", async () => {
    const deleted = await addFile();
    await f.db!.query("DELETE FROM personal_assistant_files WHERE id=$1", [
      deleted,
    ]);
    await expect(
      execute(await task({ attachmentIds: [deleted], useKnowledge: true })),
    ).rejects.toMatchObject({
      response: { error: { code: "FILE_NOT_FOUND" } },
    });
    expect(f.client.createThread).not.toHaveBeenCalled();
    expect(f.client.upload).not.toHaveBeenCalled();
    expect(f.client.startRun).not.toHaveBeenCalled();
  });

  it("rejects another user's attachment before opening or executing a remote thread", async () => {
    const foreign = await addFile(8);
    await expect(
      execute(await task({ attachmentIds: [foreign] })),
    ).rejects.toMatchObject({
      response: { error: { code: "FILE_NOT_FOUND" } },
    });
    expect(f.client.createThread).not.toHaveBeenCalled();
    expect(f.client.upload).not.toHaveBeenCalled();
    expect(f.client.startRun).not.toHaveBeenCalled();
    expect(f.knowledge).not.toHaveBeenCalled();
  });

  it("honors cancellation between the ownership check and the file transaction without saving late results", async () => {
    const current = await task();
    f.client.getState.mockResolvedValue({
      text: "迟到的结果",
      artifacts: ["/mnt/user-data/outputs/late.md"],
      interrupted: false,
    });
    f.client.downloadFile.mockImplementation(async () => {
      f.beforeTransaction = async () => {
        await f.db!.query(
          "UPDATE personal_assistant_team_runs SET status='CANCELED',lease_id=NULL WHERE id=$1",
          [current.run.id],
        );
      };
      return {
        name: "late.md",
        mime: "text/markdown",
        content: Buffer.from("late"),
      };
    });
    await expect(execute(current)).rejects.toThrow(/已停止/);
    expect(
      (await row("SELECT count(*)::int AS n FROM personal_assistant_files"))!.n,
    ).toBe(0);
    expect(
      (await row(
        "SELECT count(*)::int AS n FROM personal_assistant_team_artifacts",
      ))!.n,
    ).toBe(0);
    expect(
      await row(
        "SELECT status,summary FROM personal_assistant_team_runs WHERE id=$1",
        [current.run.id],
      ),
    ).toMatchObject({ status: "CANCELED", summary: "" });
    expect(f.client.cancel).toHaveBeenCalledExactlyOnceWith(
      current.run.id,
      "remote-run",
    );
  });

  it("never resubmits a failed remote run or archives a failed run as completed", async () => {
    const current = await task();
    f.client.startRun.mockResolvedValue({
      thread_id: current.run.id,
      run_id: "failed-run",
      status: "running",
    });
    f.client.getRun.mockResolvedValue({
      thread_id: current.run.id,
      run_id: "failed-run",
      status: "error",
    });
    await expect(execute(current)).rejects.toThrow("未自动重新提交");
    expect(f.client.startRun).toHaveBeenCalledTimes(1);
    expect(f.client.getState).not.toHaveBeenCalled();
    expect(f.client.cancel).toHaveBeenCalledExactlyOnceWith(
      current.run.id,
      "failed-run",
    );
    expect(
      (await row(
        "SELECT count(*)::int AS n FROM personal_assistant_team_artifacts",
      ))!.n,
    ).toBe(0);
  });

  it("keeps interrupted output as a draft and requests user input without retrying", async () => {
    const current = await task();
    f.client.startRun.mockResolvedValue({
      thread_id: current.run.id,
      run_id: "paused-run",
      status: "interrupted",
    });
    f.client.getState.mockResolvedValue({
      text: "请补充目标受众。",
      artifacts: [],
      interrupted: true,
    });
    await execute(current);
    expect(
      await row(
        "SELECT status,summary FROM personal_assistant_team_runs WHERE id=$1",
        [current.run.id],
      ),
    ).toMatchObject({ status: "NEEDS_USER", summary: "请补充目标受众。" });
    expect(
      await row("SELECT status FROM personal_assistant_team_artifacts"),
    ).toMatchObject({ status: "DRAFT" });
    expect(f.client.startRun).toHaveBeenCalledTimes(1);
    expect(f.client.cancel).not.toHaveBeenCalled();
  });

  it("persists an ambiguous submission for reconciliation without creating a second remote run", async () => {
    const current = await task();
    f.client.startRun.mockRejectedValueOnce(
      new Error("connection lost after submission"),
    );
    await expect(execute(current)).rejects.toThrow(
      "connection lost after submission",
    );
    const saved = await row(
      "SELECT state FROM personal_assistant_team_runs WHERE id=$1",
      [current.run.id],
    );
    expect(saved!.state.deerflow).toMatchObject({ runId: "", settled: false });
    expect(saved!.state.deerflow.submittedAt).toBeGreaterThan(0);
    await f.db!.query(
      "UPDATE personal_assistant_team_runs SET status='NEEDS_USER' WHERE id=$1",
      [current.run.id],
    );
    f.client.listRuns.mockResolvedValue([
      { thread_id: current.run.id, run_id: "uncertain-run", status: "running" },
    ]);
    await stopOrphanedDeerFlowRuns();
    expect(f.client.startRun).toHaveBeenCalledTimes(1);
    expect(f.client.cancel).toHaveBeenCalledExactlyOnceWith(
      current.run.id,
      "uncertain-run",
    );
    expect(
      (await row("SELECT state FROM personal_assistant_team_runs WHERE id=$1", [
        current.run.id,
      ]))!.state.deerflow.settled,
    ).toBe(false);
    f.client.listRuns.mockResolvedValue([
      {
        thread_id: current.run.id,
        run_id: "uncertain-run",
        status: "interrupted",
      },
    ]);
    await stopOrphanedDeerFlowRuns();
    expect(f.client.cancel).toHaveBeenCalledTimes(1);
    expect(
      (await row("SELECT state FROM personal_assistant_team_runs WHERE id=$1", [
        current.run.id,
      ]))!.state.deerflow.settled,
    ).toBe(true);
  });

  it("reconciles stopped remote handles using their owner and does not resubmit work", async () => {
    const current = await task();
    await f.db!.query(
      "UPDATE personal_assistant_team_runs SET status='CANCELED',state=$2 WHERE id=$1",
      [
        current.run.id,
        JSON.stringify({
          deerflow: {
            runId: "orphan",
            threadId: current.run.id,
            settled: false,
          },
        }),
      ],
    );
    await stopOrphanedDeerFlowRuns();
    expect(f.createClient.mock.calls[0][0]).toBe("7");
    expect(f.client.cancel).toHaveBeenCalledExactlyOnceWith(
      current.run.id,
      "orphan",
    );
    expect(f.client.startRun).not.toHaveBeenCalled();
    expect(
      (await row("SELECT state FROM personal_assistant_team_runs WHERE id=$1", [
        current.run.id,
      ]))!.state.deerflow.settled,
    ).toBe(false);
    f.client.listRuns.mockResolvedValue([
      { thread_id: current.run.id, run_id: "orphan", status: "interrupted" },
    ]);
    await stopOrphanedDeerFlowRuns();
    expect(f.client.cancel).toHaveBeenCalledTimes(1);
    expect(
      (await row("SELECT state FROM personal_assistant_team_runs WHERE id=$1", [
        current.run.id,
      ]))!.state.deerflow.settled,
    ).toBe(true);
  });

  it("keeps an uncertain submission under review even when an old remote receipt is still missing", async () => {
    const current = await task();
    await f.db!.query(
      "UPDATE personal_assistant_team_runs SET status='NEEDS_USER',state=$2 WHERE id=$1",
      [
        current.run.id,
        JSON.stringify({
          deerflow: {
            settled: false,
            runId: "",
            submittedAt: Date.now() - 600_000,
          },
        }),
      ],
    );
    f.client.listRuns.mockResolvedValue([]);
    await stopOrphanedDeerFlowRuns();
    const saved = (await row(
      "SELECT state FROM personal_assistant_team_runs WHERE id=$1",
      [current.run.id],
    ))!.state.deerflow;
    expect(saved.settled).toBe(false);
    expect(saved.lastStopCheckAt).toBeTruthy();
    expect(f.client.cancel).not.toHaveBeenCalled();
    expect(f.client.startRun).not.toHaveBeenCalled();
  });

  it("rotates reconciliation so failing earlier handles do not starve later stopped tasks", async () => {
    const tasks = await Promise.all(Array.from({ length: 4 }, () => task()));
    for (const current of tasks) {
      await f.db!.query(
        "UPDATE personal_assistant_team_runs SET status='CANCELED',state=$2 WHERE id=$1",
        [
          current.run.id,
          JSON.stringify({
            deerflow: { settled: false, runId: "", submittedAt: Date.now() },
          }),
        ],
      );
    }
    f.client.listRuns.mockRejectedValue(new Error("service unavailable"));
    await stopOrphanedDeerFlowRuns();
    expect(f.client.listRuns).toHaveBeenCalledTimes(3);
    await stopOrphanedDeerFlowRuns();
    expect(
      new Set(f.client.listRuns.mock.calls.map((call) => call[0])).size,
    ).toBe(4);
    expect(f.client.startRun).not.toHaveBeenCalled();
  });
});

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Tx } from "../../packages/database/src/index.js";
import type { Context } from "../../apps/api/src/core.js";
import { defaultTeamSettings } from "../../packages/contracts/src/assistant-team.js";
const f = vi.hoisted(() => ({
  db: null as PGlite | null,
  route: vi.fn(),
  queue: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("../../packages/database/src/index.js", async (original) => {
  const actual =
    await original<typeof import("../../packages/database/src/index.js")>();
  const wrap = (db: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) =>
      (await db.query(sql, values)).rows,
    $executeRawUnsafe: async (sql: string, ...values: unknown[]) =>
      (await db.query(sql, values)).affectedRows || 0,
  });
  return {
    ...actual,
    db: {
      $queryRawUnsafe: async (sql: string, ...values: unknown[]) =>
        (await f.db!.query(sql, values)).rows,
      $executeRawUnsafe: async (sql: string, ...values: unknown[]) =>
        (await f.db!.query(sql, values)).affectedRows || 0,
      $transaction: (fn: (tx: Tx) => Promise<unknown>) =>
        f.db!.transaction((tx) => fn(wrap(tx) as unknown as Tx)),
    },
  };
});
vi.mock("../../apps/api/src/modules/analytics/secrets.js", () => ({
  encryptionReady: () => true,
  decryptSecret: () => "test-only-credential",
}));
vi.mock("../../apps/api/src/modules/workspace/team-models.js", () => ({
  resolveTeamModel: f.route,
  resolveTeamImageModel: async () => ({ id: "engine/image" }),
}));
vi.mock("../../apps/api/src/modules/workspace/team-video.js", () => ({
  publicTeamVideoCatalog: async () => [],
  videoGenerationTool: {
    type: "function",
    function: { name: "generate_video" },
  },
}));
vi.mock(
  "../../apps/api/src/modules/workspace/agent-jobs.js",
  async (original) => ({
    ...(await original<
      typeof import("../../apps/api/src/modules/workspace/agent-jobs.js")
    >()),
    queueAgentJob: f.queue,
  }),
);
import { runTeamExecution } from "../../apps/api/src/modules/workspace/team-executor.js";

const c: Context = {
  actor: {
    id: "1",
    username: "test",
    displayName: "Test",
    permissions: [],
    roleCodes: [],
  },
  requestId: "test",
  key: "test",
};
const model = {
  id: "engine/fixed",
  name: "Test",
  actual: "test/model",
  vision: true,
  pdf: true,
  structured: true,
  parameters: ["tools", "response_format"],
  tier: "strong",
  selectionReason: "固定测试模型",
};
beforeAll(async () => {
  f.db = new PGlite();
  await f.db
    .exec(`CREATE TABLE users(id bigint PRIMARY KEY,username text,display_name text,status text);
    INSERT INTO users VALUES(1,'test','Test','ACTIVE');
    CREATE TABLE permissions(id bigint PRIMARY KEY,code text);INSERT INTO permissions VALUES(1,'product.read'),(2,'product.update');
    CREATE TABLE roles(id bigint PRIMARY KEY,code text);INSERT INTO roles VALUES(1,'USER');
    CREATE TABLE user_roles(user_id bigint,role_id bigint);INSERT INTO user_roles VALUES(1,1);
    CREATE TABLE role_permissions(role_id bigint,permission_id bigint);INSERT INTO role_permissions VALUES(1,1),(1,2);
    CREATE TABLE compass_ai_settings(id int,enabled bool,verified_at timestamptz,api_key_encrypted text);INSERT INTO compass_ai_settings VALUES(1,true,now(),'test');
    CREATE TABLE personal_assistant_files(id uuid PRIMARY KEY,user_id bigint,name text,mime text,size int,source text,metadata jsonb,created_at timestamptz,content bytea,extracted_text text);
    CREATE TABLE personal_assistant_jobs(id uuid PRIMARY KEY,user_id bigint,request_id uuid,status text,output_ids jsonb,error_note text,stage text,updated_at timestamptz);`);
  await f.db.exec(
    await readFile(
      "packages/database/migrations/090_assistant_team.sql",
      "utf8",
    ),
  );
});
afterAll(async () => {
  await f.db?.close();
});
beforeEach(async () => {
  await f.db!.exec(
    "TRUNCATE personal_assistant_team_artifacts,personal_assistant_team_runs,personal_assistant_jobs,personal_assistant_files CASCADE",
  );
  f.route.mockReset().mockResolvedValue(model);
  f.queue.mockReset();
  f.fetch.mockReset();
  vi.stubGlobal("fetch", f.fetch);
});
afterEach(() => vi.unstubAllGlobals());
const response = (data: unknown) =>
  Response.json({
    model: "test/model",
    choices: [{ message: { content: JSON.stringify(data) } }],
  });
async function runRow() {
  const id = randomUUID(),
    lease = randomUUID();
  const input = {
    id,
    goal: "生成可下载的文字文件",
    attachmentIds: [],
    useKnowledge: false,
    model: "engine/fixed",
    settings: defaultTeamSettings(),
    settingsVersion: 1,
  };
  await f.db!.query(
    "INSERT INTO personal_assistant_team_runs(id,user_id,request_hash,input,status,lease_id,heartbeat_at) VALUES($1,1,'hash',$2::jsonb,'PLANNING',$3,now())",
    [id, JSON.stringify(input), lease],
  );
  return { run: { id, user_id: "1", input }, lease };
}
function startDocumentScenario(kind = "document", memberId = "writing") {
  f.fetch
    .mockResolvedValueOnce(
      response({
        summary: "交付实际产物",
        steps: [
          {
            id: "write",
            title: "实际产物",
            memberId,
            instruction: "交付完整内容和文件",
            dependencies: [],
            difficulty: "simple",
            deliverable: kind,
            acceptance: ["实际产物完整且可使用"],
          },
        ],
      }),
    )
    .mockResolvedValueOnce(response({ brief: "按工具真实结果交付" }));
}
function toolResponse(name = "create_document") {
  return Response.json({
    model: "test/model",
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "create-once",
              type: "function",
              function: {
                name,
                arguments: JSON.stringify({
                  title: "说明",
                  format: "txt",
                  sections: [
                    { heading: "说明", text: "实际文件正文", rows: [] },
                  ],
                }),
              },
            },
          ],
        },
      },
    ],
  });
}
function finishDocumentScenario() {
  f.fetch
    .mockResolvedValueOnce(
      response({ accepted: true, review: "实际文件已核对" }),
    )
    .mockResolvedValueOnce(response({ summary: "已验收文件", tags: ["说明"] }))
    .mockResolvedValueOnce(response({ summary: "真实文件已完成并验收" }));
}
function successfulFileJob(runId: string) {
  const fileId = randomUUID(),
    jobId = randomUUID();
  f.queue.mockImplementation(async () => {
    await f.db!.query(
      "INSERT INTO personal_assistant_files VALUES($1,1,'说明.txt','text/plain',12,'generated','{}',now(),$2,'实际文件正文')",
      [fileId, Buffer.from("实际文件正文")],
    );
    await f.db!.query(
      "INSERT INTO personal_assistant_jobs(id,user_id,request_id,status,output_ids) VALUES($1,1,$2,'DONE',$3::jsonb)",
      [jobId, runId, JSON.stringify([fileId])],
    );
    return { id: jobId, status: "QUEUED" };
  });
  return { fileId, jobId };
}
describe("production team adapter", () => {
  it("corrects a completed document with no file once, calls the real job path, then resumes strict final JSON", async () => {
    const { run, lease } = await runRow(),
      { fileId } = successfulFileJob(run.id);
    startDocumentScenario();
    f.fetch
      .mockResolvedValueOnce(
        response({ status: "completed", content: "这里是完整的说明正文。" }),
      )
      .mockResolvedValueOnce(toolResponse())
      .mockResolvedValueOnce(
        response({
          status: "completed",
          content: "实际文件已生成，内容为完整说明。",
        }),
      );
    finishDocumentScenario();
    const result = await runTeamExecution(
      c,
      run,
      lease,
      new AbortController().signal,
    );
    expect(result.status).toBe("DONE");
    expect(result.artifacts[0].fileIds).toEqual([fileId]);
    expect(f.queue).toHaveBeenCalledTimes(1);
    const execution = f.fetch.mock.calls
      .map((call) => JSON.parse(call[1].body))
      .filter((body) => body.tools?.length);
    expect(execution).toHaveLength(3);
    expect(execution[0].response_format).toBeUndefined();
    expect(execution[1]).toMatchObject({
      tool_choice: { type: "function", function: { name: "create_document" } },
    });
    expect(execution[1].response_format).toBeUndefined();
    expect(execution[2]).toMatchObject({
      tool_choice: "none",
      response_format: { json_schema: { name: "team_execute", strict: true } },
    });
  });
  it("accepts plain working text through a final-schema decision before a bounded missing-file correction", async () => {
    const { run, lease } = await runRow();
    successfulFileJob(run.id);
    startDocumentScenario();
    f.fetch
      .mockResolvedValueOnce(
        Response.json({
          model: "test/model",
          choices: [{ message: { content: "这是已经写好的说明正文。" } }],
        }),
      )
      .mockResolvedValueOnce(
        response({ status: "completed", content: "这是完整说明正文。" }),
      )
      .mockResolvedValueOnce(toolResponse())
      .mockResolvedValueOnce(
        response({ status: "completed", content: "实际文件完成。" }),
      );
    finishDocumentScenario();
    expect(
      (await runTeamExecution(c, run, lease, new AbortController().signal))
        .status,
    ).toBe("DONE");
    const execution = f.fetch.mock.calls
      .map((call) => JSON.parse(call[1].body))
      .filter((body) => body.tools?.length);
    expect(execution).toHaveLength(4);
    expect(execution[1].response_format.json_schema.name).toBe("team_execute");
    expect(f.queue).toHaveBeenCalledTimes(1);
  });
  it("honors explicit missing-input needs_user without forcing file creation", async () => {
    const { run, lease } = await runRow();
    startDocumentScenario();
    f.fetch
      .mockResolvedValueOnce(
        response({
          status: "needs_user",
          content: "缺少应作为依据的原始商品数据。",
        }),
      )
      .mockResolvedValueOnce(
        response({ summary: "缺少原始商品数据，未创建文件。" }),
      );
    const result = await runTeamExecution(
      c,
      run,
      lease,
      new AbortController().signal,
    );
    expect(result.status).toBe("NEEDS_USER");
    expect(f.queue).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });
  it("does not retry a failed file tool after the one-time correction", async () => {
    const { run, lease } = await runRow();
    startDocumentScenario();
    f.fetch
      .mockResolvedValueOnce(
        response({ status: "completed", content: "完整正文。" }),
      )
      .mockResolvedValueOnce(toolResponse())
      .mockResolvedValueOnce(
        response({ summary: "文件工具失败，未完成交付。" }),
      );
    f.queue.mockRejectedValueOnce(Error("任务文件生成失败"));
    const result = await runTeamExecution(
      c,
      run,
      lease,
      new AbortController().signal,
    );
    expect(result.status).toBe("NEEDS_USER");
    expect(f.queue).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(5);
  });
  it("does not keep correcting repeated completed claims without tool evidence", async () => {
    const { run, lease } = await runRow();
    startDocumentScenario();
    f.fetch
      .mockResolvedValueOnce(
        response({ status: "completed", content: "完整正文。" }),
      )
      .mockResolvedValueOnce(
        response({ status: "completed", content: "仍然只有正文。" }),
      )
      .mockResolvedValueOnce(
        response({ summary: "执行成员没有完成真实文件交付。" }),
      );
    const result = await runTeamExecution(
      c,
      run,
      lease,
      new AbortController().signal,
    );
    expect(result.status).toBe("NEEDS_USER");
    expect(f.queue).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(5);
    expect(result.state.steps[0].error).toContain("不表示系统缺少该能力");
  });
  it("does not force another image generation after a successful tool receipt lacks the required file type", async () => {
    const { run, lease } = await runRow();
    successfulFileJob(run.id);
    startDocumentScenario("image", "design");
    f.fetch
      .mockResolvedValueOnce(toolResponse("generate_image"))
      .mockResolvedValueOnce(
        response({ status: "completed", content: "已完成。" }),
      )
      .mockResolvedValueOnce(
        response({ summary: "执行成员没有交付要求的图片文件。" }),
      );
    const result = await runTeamExecution(
      c,
      run,
      lease,
      new AbortController().signal,
    );
    expect(result.status).toBe("NEEDS_USER");
    expect(f.queue).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(5);
    const execution = f.fetch.mock.calls
      .map((call) => JSON.parse(call[1].body))
      .filter((body) => body.tools?.length);
    expect(
      execution.every((body) => typeof body.tool_choice === "string"),
    ).toBe(true);
  });
  it("persists a real file result through planning, queue completion, source review, archive and final status", async () => {
    const { run, lease } = await runRow(),
      fileId = randomUUID(),
      jobId = randomUUID();
    f.queue.mockImplementation(async (...args: unknown[]) => {
      expect(args[3]).toBe(run.id);
      expect(args[8]).toBe(lease);
      await f.db!.query(
        "INSERT INTO personal_assistant_files VALUES($1,1,'说明.txt','text/plain',12,'generated','{}',now(),$2,'实际文件正文')",
        [fileId, Buffer.from("实际文件正文")],
      );
      await f.db!.query(
        "INSERT INTO personal_assistant_jobs(id,user_id,request_id,status,output_ids) VALUES($1,1,$2,'DONE',$3::jsonb)",
        [jobId, run.id, JSON.stringify([fileId])],
      );
      return { id: jobId, status: "QUEUED" };
    });
    f.fetch
      .mockResolvedValueOnce(
        response({
          summary: "创作说明文件",
          steps: [
            {
              id: "write",
              title: "文字文件",
              memberId: "writing",
              instruction: "创建完整文件",
              dependencies: [],
              difficulty: "simple",
              deliverable: "document",
              acceptance: ["文件确实存在且含正文"],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({ brief: "创建实际可下载文件并按正文验收" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          model: "test/model",
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "one",
                    type: "function",
                    function: {
                      name: "create_document",
                      arguments: JSON.stringify({
                        title: "说明",
                        format: "txt",
                        sections: [
                          { heading: "说明", text: "实际文件正文", rows: [] },
                        ],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          status: "completed",
          content: "已完成实际说明文件，正文为实际文件正文。",
        }),
      )
      .mockResolvedValueOnce(
        response({ accepted: true, review: "已对照实际文件内容验收" }),
      )
      .mockResolvedValueOnce(
        response({ summary: "可下载说明", tags: ["说明"] }),
      )
      .mockResolvedValueOnce(response({ summary: "真实文件已完成并验收" }));
    const result = await runTeamExecution(
      c,
      run,
      lease,
      new AbortController().signal,
    );
    expect(result.status).toBe("DONE");
    expect(f.queue).toHaveBeenCalledTimes(1);
    const stored = (
      await f.db!.query<{
        status: string;
        state: { steps: { jobIds: string[] }[] };
      }>("SELECT status,state FROM personal_assistant_team_runs WHERE id=$1", [
        run.id,
      ])
    ).rows[0];
    expect(stored.status).toBe("DONE");
    expect(stored.state.steps[0].jobIds).toEqual([jobId]);
    const artifacts = (
      await f.db!.query<{
        status: string;
        file_ids: string[];
        content: string;
      }>("SELECT * FROM personal_assistant_team_artifacts")
    ).rows;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].status).toBe("ACCEPTED");
    expect(artifacts[0].file_ids).toEqual([fileId]);
    const bodies = f.fetch.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(
      bodies.every(
        (body) =>
          body.model === "test/model" && body.parallel_tool_calls === undefined,
      ),
    ).toBe(true);
    expect(
      f.route.mock.calls.every((call) => call[0].taskModel === "engine/fixed"),
    ).toBe(true);
    const reviewBody = bodies.find(
      (body) => body.response_format?.json_schema.name === "team_review",
    );
    expect(JSON.stringify(reviewBody.messages)).toContain("实际文件正文");
  });
  it("does not make any provider call after cancellation invalidates the lease", async () => {
    const { run, lease } = await runRow();
    await f.db!.query(
      "UPDATE personal_assistant_team_runs SET status='CANCELED',lease_id=NULL WHERE id=$1",
      [run.id],
    );
    await expect(
      runTeamExecution(c, run, lease, new AbortController().signal),
    ).rejects.toThrow("租约");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.queue).not.toHaveBeenCalled();
  });
  it("refuses a different returned model without fallback or paid retry", async () => {
    const { run, lease } = await runRow();
    f.fetch.mockResolvedValueOnce(
      Response.json({
        model: "unexpected/model",
        choices: [{ message: { content: "{}" } }],
      }),
    );
    await expect(
      runTeamExecution(c, run, lease, new AbortController().signal),
    ).rejects.toThrow("非指定型号");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.queue).not.toHaveBeenCalled();
  });
  it("records the selected model before a failing execution request and persists its safe diagnosis", async () => {
    const { run, lease } = await runRow();
    f.fetch.mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      switch (body.response_format?.json_schema.name || "team_execute") {
        case "team_plan":
          return response({
            summary: "创作文字",
            steps: [
              {
                id: "write",
                title: "文字",
                memberId: "writing",
                instruction: "写正文",
                dependencies: [],
                difficulty: "simple",
                deliverable: "text",
                acceptance: ["实际正文完整"],
              },
            ],
          });
        case "team_brief":
          return response({ brief: "创作正文" });
        case "team_execute": {
          const stored = (
            await f.db!.query<{
              state: { steps: { model: string; status: string }[] };
            }>("SELECT state FROM personal_assistant_team_runs WHERE id=$1", [
              run.id,
            ])
          ).rows[0];
          expect(stored.state.steps[0]).toMatchObject({
            model: "test/model",
            status: "RUNNING",
          });
          return Response.json(
            {
              error: {
                code: 404,
                message: "private-key-or-request",
                metadata: { error_type: "not_found" },
              },
            },
            { status: 404 },
          );
        }
        case "team_summary":
          return response({ summary: "写作模型端点不可用，尚未完成" });
        default:
          throw Error("Unexpected request");
      }
    });
    const result = await runTeamExecution(
      c,
      run,
      lease,
      new AbortController().signal,
    );
    expect(result.state.steps[0]).toMatchObject({
      status: "NEEDS_USER",
      model: "test/model",
      modelId: "engine/fixed",
      routeReason: "固定测试模型",
    });
    expect(result.state.steps[0].error).toContain(
      "HTTP 404，code=404，type=not_found",
    );
    expect(JSON.stringify(result)).not.toContain("private-key-or-request");
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });
});

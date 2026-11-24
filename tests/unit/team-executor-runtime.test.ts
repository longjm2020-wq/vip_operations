import { installAiManagementSchema } from "../fixtures/ai-management-schema.js";
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
import {
  employeeMemberId,
  employeeTemplate,
} from "../../packages/contracts/src/assistant-employees.js";
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
  fallbackTeamModel: async () => undefined,
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
import { saveKnowledge } from "../../apps/api/src/modules/workspace/assistant-knowledge.js";
import { readTeamRun } from "../../apps/api/src/modules/workspace/assistant-team.js";
import {
  listEmployeeTasks,
  supplementEmployeeTask,
} from "../../apps/api/src/modules/workspace/assistant-employees.js";
import { claimAssistantRun } from "../../apps/api/src/modules/workspace/employee-runtime.js";

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
  actual: "gpt-6.1-sol",
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
    CREATE TABLE personal_assistant_jobs(id uuid PRIMARY KEY,user_id bigint,request_id uuid,status text,output_ids jsonb,error_note text,stage text,updated_at timestamptz,title text,kind text,model text,created_at timestamptz DEFAULT now());`);
  await installAiManagementSchema(f.db);
  await f.db.exec(
    await readFile(
      "packages/database/migrations/090_assistant_team.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    await readFile(
      "packages/database/migrations/101_assistant_employees.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    await readFile(
      "packages/database/migrations/110_assistant_knowledge.sql",
      "utf8",
    ),
  );
});
afterAll(async () => {
  await f.db?.close();
});
beforeEach(async () => {
  await f.db!.exec(
    "TRUNCATE personal_assistant_team_artifacts,personal_assistant_team_runs,personal_assistant_jobs,personal_assistant_files,ai_model_usage CASCADE",
  );
  f.route.mockReset().mockResolvedValue(model);
  await f.db!.exec(
    "UPDATE compass_ai_settings SET enabled=true; UPDATE agentai_settings SET enabled=false,api_key_encrypted=NULL,verified_at=NULL; TRUNCATE agentai_model_verifications",
  );
  f.queue.mockReset();
  f.fetch.mockReset();
  vi.stubGlobal("fetch", f.fetch);
});
afterEach(() => vi.unstubAllGlobals());
const response = (data: unknown) =>
  Response.json({
    id: "fixture-response",
    created: 1,
    model: "gpt-6.1-sol",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(data) },
      },
    ],
  });
async function runRow(engine: "native" | false = "native") {
  const id = randomUUID(),
    lease = randomUUID(),
    employeeId = randomUUID();
  const profile = employeeTemplate("writing");
  const input = {
    id,
    ...(engine ? { engine } : {}),
    goal: "生成可下载的文字文件",
    attachmentIds: [],
    useKnowledge: false,
    model: "engine/fixed",
    settings: defaultTeamSettings(),
    employeeContext: {
      origin: "direct",
      employeeId,
      employees: [{ id: employeeId, version: 1, profile }],
      maxModelCalls: 120,
    },
    settingsVersion: 1,
  };
  await f.db!.query(
    "INSERT INTO personal_assistant_team_runs(id,user_id,request_hash,input,status,lease_id,heartbeat_at) VALUES($1,1,'hash',$2::jsonb,'PLANNING',$3,now())",
    [id, JSON.stringify(input), lease],
  );
  await f.db!.query(
    "INSERT INTO personal_assistant_employees(id,user_id,profile) VALUES($1,1,$2::jsonb)",
    [employeeId, JSON.stringify(profile)],
  );
  await f.db!.query(
    "INSERT INTO personal_assistant_employee_tasks(run_id,user_id,employee_id,employee_ids,origin,max_model_calls) VALUES($1,1,$2,$3::uuid[],'direct',120)",
    [id, employeeId, [employeeId]],
  );
  return { run: { id, user_id: "1", input }, lease };
}
function startDocumentScenario(kind = "document", memberId = "writing") {
  f.fetch.mockResolvedValueOnce(
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
  );
}
function toolResponse(name = "create_document") {
  return Response.json({
    id: "fixture-tool",
    created: 1,
    model: "gpt-6.1-sol",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
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
  f.fetch.mockResolvedValueOnce(
    response({ accepted: true, review: "实际文件已核对" }),
  );
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
async function configureAgentAiRuntime() {
  await f.db!.exec(`UPDATE compass_ai_settings SET enabled=false;
    UPDATE agentai_settings SET enabled=true,api_key_encrypted='agentai-test',verified_at=now(),version=1,catalog_at=now(),
      model_catalog='[{"model":"gpt-6.1-sol","name":"Test","type":"chat","vision":true,"available":true}]';
    INSERT INTO agentai_model_verifications(model,settings_version,chat_verified_at,tools_verified_at,structured_verified_at)
      VALUES('gpt-6.1-sol',1,now(),now(),now())`);
  f.route.mockResolvedValue({ ...model, provider: "agentai" });
}
describe("production team adapter", () => {
  it("accepts attachment-only replies once and resumes the original task with its budget and owner", async () => {
    const { run, lease } = await runRow();
    const signal = new AbortController().signal;
    f.fetch.mockResolvedValueOnce(
      response({ summary: "请上传商品说明。", steps: [] }),
    );
    await runTeamExecution(c, run, lease, signal);
    const waiting = (
      await listEmployeeTasks(c, run.input.employeeContext.employeeId)
    )[0];
    expect(waiting).toMatchObject({
      id: run.id,
      modelCalls: 1,
      inputRequestId: expect.any(String),
    });
    const fileId = randomUUID();
    const reply = {
      requestId: waiting.inputRequestId!,
      text: "",
      attachmentIds: [fileId],
    };
    await expect(
      supplementEmployeeTask(c, run.id, reply),
    ).rejects.toMatchObject({ status: 404 });
    await f.db!.query(
      "INSERT INTO personal_assistant_files VALUES($1,1,'商品.txt','text/plain',12,'upload','{}',now(),$2,'面料为棉')",
      [fileId, Buffer.from("面料为棉")],
    );
    await expect(
      supplementEmployeeTask(
        { ...c, actor: { ...c.actor, id: "2" } },
        run.id,
        reply,
      ),
    ).rejects.toMatchObject({ status: 404 });
    const queued = await supplementEmployeeTask(c, run.id, reply);
    expect(queued).toMatchObject({
      id: run.id,
      status: "QUEUED",
      goal: run.input.goal,
      modelCalls: 1,
      attachments: [{ id: fileId }],
    });
    await expect(
      supplementEmployeeTask(c, run.id, { ...reply, text: "不同补充" }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await supplementEmployeeTask(c, run.id, reply)).id).toBe(run.id);
    expect(await listEmployeeTasks(c)).toHaveLength(1);
    const nextLease = randomUUID();
    const claimed = await claimAssistantRun(nextLease);
    expect(claimed?.id).toBe(run.id);
    startDocumentScenario("text");
    f.fetch.mockResolvedValueOnce(
      response({ status: "completed", content: "棉质商品。" }),
    );
    finishDocumentScenario();
    const completed = await runTeamExecution(c, claimed!, nextLease, signal);
    expect(completed.status).toBe("DONE");
    expect(completed.summary).toBe("棉质商品。");
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(f.fetch.mock.calls[2])).toContain("面料为棉");
    expect((await supplementEmployeeTask(c, run.id, reply)).modelCalls).toBe(4);
    expect(await claimAssistantRun(randomUUID())).toBeUndefined();
  });
  it("continues only the missing step and its dependencies, preserving accepted work", async () => {
    const { run, lease } = await runRow();
    const signal = new AbortController().signal;
    const planned = ["first", "second", "last"].map((id, i) => ({
      id,
      title: id,
      memberId: "writing",
      instruction: "按当前交办完成段落",
      dependencies: i ? [i === 1 ? "first" : "second"] : [],
      difficulty: "simple",
      deliverable: "text",
      acceptance: ["符合交办目标"],
    }));
    f.fetch
      .mockResolvedValueOnce(
        response({ summary: "完成三份依次交付的内容", steps: planned }),
      )
      .mockResolvedValueOnce(
        response({ status: "completed", content: "已交付第一稿" }),
      );
    finishDocumentScenario();
    f.fetch.mockResolvedValueOnce(
      response({ status: "needs_input", content: "请提供款号" }),
    );
    const waiting = await runTeamExecution(c, run, lease, signal);
    expect(waiting.state.steps.map((s) => s.status)).toEqual([
      "DONE",
      "NEEDS_USER",
      "NEEDS_USER",
    ]);
    expect(waiting.summary).toContain("请提供款号");
    const acceptedId = waiting.artifacts[0].id;
    await supplementEmployeeTask(c, run.id, {
      requestId: waiting.state.inputRequestId,
      text: "款号 X1",
      attachmentIds: [],
    });
    const nextLease = randomUUID();
    const claimed = await claimAssistantRun(nextLease);
    expect(claimed?.input.goal).toContain("款号 X1");
    for (const content of ["第二稿", "第三稿"]) {
      f.fetch.mockResolvedValueOnce(response({ status: "completed", content }));
      finishDocumentScenario();
    }
    const done = await runTeamExecution(c, claimed!, nextLease, signal);
    expect(done.status).toBe("DONE");
    expect(done.artifacts.map((a) => a.stepId)).toEqual([
      "first",
      "second",
      "last",
    ]);
    expect(done.artifacts[0].id).toBe(acceptedId);
    expect(f.fetch).toHaveBeenCalledTimes(8);
  });
  it("keeps shared planning and public search free of retrieved passages and records each employee's versioned evidence", async () => {
    const { run, lease } = await runRow();
    const author = run.input.employeeContext.employees[0];
    const reviewer = {
      id: randomUUID(),
      version: 1,
      profile: employeeTemplate("review"),
    };
    await f.db!.query(
      "INSERT INTO personal_assistant_employees(id,user_id,profile) VALUES($1,1,$2::jsonb)",
      [reviewer.id, JSON.stringify(reviewer.profile)],
    );
    const owner = {
      ...c,
      actor: { ...c.actor, permissions: ["product.read", "product.update"] },
    };
    const addNote = (employeeId: string, title: string, content: string) =>
      saveKnowledge(owner, {
        id: randomUUID(),
        version: 0,
        title,
        content,
        employeeIds: [employeeId],
      });
    const writeNote = await addNote(
      author.id,
      "产品文案规范",
      "## 语气\n保密片段 ALPHA，只使用日常词。",
    );
    const reviewNote = await addNote(
      reviewer.id,
      "产品文案验收",
      "## 检查\n保密片段 BRAVO，检查颜色名。",
    );
    const authorMember = employeeMemberId(author.id);
    const input = {
      ...run.input,
      goal: "依据产品文案规范完成文字审核",
      employeeContext: {
        origin: "dispatch",
        employees: [author, reviewer],
        maxModelCalls: 20,
      },
      settings: {
        ...run.input.settings,
        allowWeb: true,
        members: run.input.settings.members.map((m) =>
          m.id === "writing"
            ? { ...m, role: "custom", id: authorMember }
            : m.role === "coordinator"
              ? { ...m, id: employeeMemberId(reviewer.id) }
              : m,
        ),
      },
    };
    startDocumentScenario("research", authorMember);
    f.fetch
      .mockResolvedValueOnce(response("跳过"))
      .mockResolvedValueOnce(
        response({ status: "completed", content: "采用日常词。[K1]" }),
      )
      .mockResolvedValueOnce(
        response({ accepted: true, review: "颜色已核对。[K1]" }),
      );
    const result = await runTeamExecution(
      c,
      { ...run, input },
      lease,
      new AbortController().signal,
    );
    expect(result.status).toBe("DONE");
    const requests = f.fetch.mock.calls.map(([, init]) =>
      JSON.parse(init.body),
    );
    expect(requests).toHaveLength(4);
    const prompts = requests.map((body) => JSON.stringify(body.messages));
    expect(prompts.filter((text) => text.includes("ALPHA"))).toEqual([
      prompts[2],
    ]);
    expect(prompts.filter((text) => text.includes("BRAVO"))).toEqual([
      prompts[3],
    ]);
    expect(requests[1].tools.map((t: any) => t.function.name)).toEqual([
      "search_web",
    ]);
    expect(
      requests[2].tools.some((t: any) => t.function.name === "search_web"),
    ).toBe(false);
    const saved = (await readTeamRun(c, run.id, "employee")).artifacts[0];
    expect(saved.content).toContain("产品文案规范（v1）");
    expect(saved.review).toContain("产品文案验收（v1）");
    expect(saved.citations).toEqual([
      {
        title: "执行引用 [K1] · 产品文案规范（v1） · 语气",
        url: `/my-workspace?assistant=knowledge&note=${writeNote.id}&version=1`,
        consultedOnly: false,
      },
      {
        title: "验收引用 [K1] · 产品文案验收（v1） · 检查",
        url: `/my-workspace?assistant=knowledge&note=${reviewNote.id}&version=1`,
        consultedOnly: false,
      },
    ]);
  });
  it("stops private work if the note grant is revoked during a model call", async () => {
    const { run, lease } = await runRow();
    const author = run.input.employeeContext.employees[0];
    const owner = {
      ...c,
      actor: { ...c.actor, permissions: ["product.read", "product.update"] },
    };
    const note = await saveKnowledge(owner, {
      id: randomUUID(),
      version: 0,
      title: "说明正文",
      content: "## 真实产物\n生成文字文件时列出日期。",
      employeeIds: [author.id],
    });
    const memberId = employeeMemberId(author.id);
    const input = {
      ...run.input,
      settings: {
        ...run.input.settings,
        members: run.input.settings.members.map((m) =>
          m.id === "writing" ? { ...m, id: memberId } : m,
        ),
      },
    };
    startDocumentScenario("document", memberId);
    f.fetch.mockImplementationOnce(async () => {
      await saveKnowledge(owner, {
        employeeIds: [],
        id: note.id,
        title: note.title,
        content: note.content,
        version: note.version,
      });
      return toolResponse();
    });
    const result = await runTeamExecution(
      c,
      { ...run, input },
      lease,
      new AbortController().signal,
    );
    expect(result.status).toBe("NEEDS_USER");
    expect(result.state.steps[0].error).toContain(
      "知识库资料或员工授权已经变化",
    );
    expect(f.queue).not.toHaveBeenCalled();
  });
  it.each(["openrouter", "agentai"])(
    "uses employee snapshots and the selected %s connection with independent metering",
    async (provider) => {
      if (provider === "agentai") {
        await configureAgentAiRuntime();
      }
      const { run, lease } = await runRow(),
        employeeId = run.input.employeeContext.employeeId,
        memberId = employeeMemberId(employeeId);
      const profile = {
        ...employeeTemplate("writing"),
        knowledge: "独立品牌语气：克制",
        workModel: { mode: "fixed" as const, modelIds: ["engine/fixed"] },
      };
      const input = {
        ...run.input,
        employeeContext: {
          origin: "direct",
          employeeId,
          employees: [{ id: employeeId, version: 1, profile }],
          maxModelCalls: 6,
        },
        settings: {
          ...run.input.settings,
          members: run.input.settings.members.map((m) =>
            m.id === "writing" ? { ...m, id: memberId } : m,
          ),
        },
      };
      await f.db!.query(
        "UPDATE personal_assistant_team_runs SET input=$2::jsonb WHERE id=$1",
        [run.id, JSON.stringify(input)],
      );
      await f.db!.query(
        "UPDATE personal_assistant_employee_tasks SET max_model_calls=6 WHERE run_id=$1",
        [run.id],
      );
      startDocumentScenario("text", memberId);
      f.fetch.mockResolvedValueOnce(
        response({ status: "completed", content: "实际员工文案" }),
      );
      finishDocumentScenario();
      const result = await runTeamExecution(
        c,
        { ...run, input },
        lease,
        new AbortController().signal,
      );
      expect(result.status).toBe("DONE");
      expect(f.fetch).toHaveBeenCalledTimes(3);
      expect(
        f.fetch.mock.calls.every(([url]) =>
          String(url).startsWith(
            provider === "agentai"
              ? "https://agentai.token6688.com/v1/"
              : "https://openrouter.ai/api/v1/",
          ),
        ),
      ).toBe(true);
      if (provider === "agentai")
        for (const [, init] of f.fetch.mock.calls) {
          expect(JSON.parse(init.body)).not.toHaveProperty("provider");
          expect(JSON.parse(init.body)).not.toHaveProperty("reasoning");
        }
      expect(
        f.route.mock.calls.some(
          ([options]) => options.policy?.mode === "fixed",
        ),
      ).toBe(true);
      expect(JSON.stringify(f.fetch.mock.calls)).toContain("独立品牌语气");
      expect(
        (
          await f.db!.query<{ model_calls: number }>(
            "SELECT model_calls FROM personal_assistant_employee_tasks WHERE run_id=$1",
            [run.id],
          )
        ).rows[0].model_calls,
      ).toBe(3);
      await vi.waitFor(async () =>
        expect(
          (
            await f.db!.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM ai_model_usage WHERE feature_id='assistant_employee'",
            )
          ).rows[0].n,
        ).toBe(3),
      );
    },
  );
  it.each([true, false])(
    "executes stored native and legacy snapshots without sending internal fields as public input (engine: %s)",
    async (includeEngine) => {
      const { run, lease } = await runRow(includeEngine ? "native" : false);
      startDocumentScenario("text");
      f.fetch.mockResolvedValueOnce(
        response({ status: "completed", content: "连接检查测试正文。" }),
      );
      finishDocumentScenario();
      const result = await runTeamExecution(
        c,
        run,
        lease,
        new AbortController().signal,
      );
      expect(result.status).toBe("DONE");
      expect(result.artifacts[0]).toMatchObject({
        status: "ACCEPTED",
        content: "连接检查测试正文。",
      });
      expect(f.fetch).toHaveBeenCalledTimes(3);
      expect(f.queue).not.toHaveBeenCalled();
    },
  );
  it("still rejects unexpected public task fields before making a provider call", async () => {
    const { run, lease } = await runRow();
    await expect(
      runTeamExecution(
        c,
        { ...run, input: { ...run.input, unexpected: true } },
        lease,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(["native", "mastra", "deerflow"])(
    "does not execute a retired %s team snapshot",
    async (engine) => {
      const { run, lease } = await runRow();
      const input = { ...run.input, engine, employeeContext: undefined };
      await expect(
        runTeamExecution(
          c,
          { ...run, input },
          lease,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      if (engine !== "native") {
        await expect(
          runTeamExecution(
            c,
            { ...run, input: { ...run.input, engine } },
            lease,
            new AbortController().signal,
          ),
        ).rejects.toThrow();
      }
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.queue).not.toHaveBeenCalled();
    },
  );
  it("durably archives an independently accepted file with no metadata or summary provider request", async () => {
    const { run, lease } = await runRow(),
      { fileId } = successfulFileJob(run.id);
    startDocumentScenario();
    f.fetch
      .mockResolvedValueOnce(toolResponse())
      .mockResolvedValueOnce(
        response({ status: "completed", content: "实际文件已生成。" }),
      )
      .mockResolvedValueOnce(
        response({ accepted: true, review: "原始文件与内容已逐项核验通过" }),
      );
    const result = await runTeamExecution(
      c,
      run,
      lease,
      new AbortController().signal,
    );
    expect(result.status).toBe("DONE");
    expect(result.artifacts[0]).toMatchObject({
      status: "ACCEPTED",
      fileIds: [fileId],
      tags: [],
    });
    expect(result.artifacts[0].review).toBe("原始文件与内容已逐项核验通过");
    expect(result.summary).toBe("实际文件已生成。");
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(f.queue).toHaveBeenCalledTimes(1);
    const stored = (
      await f.db!.query<{ status: string; review: string }>(
        "SELECT status,review FROM personal_assistant_team_artifacts WHERE run_id=$1",
        [run.id],
      )
    ).rows[0];
    expect(stored.status).toBe("ACCEPTED");
    expect(stored.review).toContain("逐项核验通过");
    expect(
      (await listEmployeeTasks(c))[0].resultFiles?.map((f) => f.id),
    ).toEqual([fileId]);
    await f.db!.query(
      "UPDATE personal_assistant_team_artifacts SET status='REJECTED' WHERE run_id=$1",
      [run.id],
    );
    expect((await listEmployeeTasks(c))[0].resultFiles).toEqual([]);
  });
  it("does not execute a potentially truncated tool call when finish_reason is length", async () => {
    const { run, lease } = await runRow();
    startDocumentScenario();
    const truncated = await toolResponse().json();
    truncated.choices[0].finish_reason = "length";
    truncated.usage = {
      completion_tokens: 7500,
      completion_tokens_details: { reasoning_tokens: 7400 },
    };
    f.fetch.mockResolvedValueOnce(Response.json(truncated));
    const result = await runTeamExecution(
      c,
      run,
      lease,
      new AbortController().signal,
    );
    expect(result.status).toBe("NEEDS_USER");
    expect(result.state.steps[0].error).toContain("finish_reason=length");
    expect(f.queue).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("reports empty output accurately and accepts only ordinary text content arrays", async () => {
    const empty = await runRow();
    f.fetch.mockResolvedValueOnce(
      Response.json({
        model: "gpt-6.1-sol",
        choices: [{ finish_reason: "stop", message: { content: null } }],
      }),
    );
    await expect(
      runTeamExecution(c, empty.run, empty.lease, new AbortController().signal),
    ).rejects.toThrow("团队规划未返回可用正文");
    const { run, lease } = await runRow();
    startDocumentScenario("text");
    const text = JSON.stringify({
      status: "completed",
      content: "实际文字内容。",
    });
    f.fetch.mockResolvedValueOnce(
      Response.json({
        model: "gpt-6.1-sol",
        choices: [
          {
            message: {
              content: [
                { type: "text", text: text.slice(0, 10) },
                { type: "text", text: text.slice(10) },
              ],
            },
          },
        ],
      }),
    );
    finishDocumentScenario();
    expect(
      (await runTeamExecution(c, run, lease, new AbortController().signal))
        .status,
    ).toBe("DONE");
    expect(f.queue).not.toHaveBeenCalled();
  });
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
          model: "gpt-6.1-sol",
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
    f.fetch.mockResolvedValueOnce(
      response({
        status: "needs_user",
        content: "缺少应作为依据的原始商品数据。",
      }),
    );
    const result = await runTeamExecution(
      c,
      run,
      lease,
      new AbortController().signal,
    );
    expect(result.status).toBe("NEEDS_USER");
    expect(f.queue).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("does not retry a failed file tool after the one-time correction", async () => {
    const { run, lease } = await runRow();
    startDocumentScenario();
    f.fetch
      .mockResolvedValueOnce(
        response({ status: "completed", content: "完整正文。" }),
      )
      .mockResolvedValueOnce(toolResponse());
    f.queue.mockRejectedValueOnce(Error("任务文件生成失败"));
    const result = await runTeamExecution(
      c,
      run,
      lease,
      new AbortController().signal,
    );
    expect(result.status).toBe("NEEDS_USER");
    expect(f.queue).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(3);
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
      );
    const result = await runTeamExecution(
      c,
      run,
      lease,
      new AbortController().signal,
    );
    expect(result.status).toBe("NEEDS_USER");
    expect(f.queue).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(3);
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
      );
    const result = await runTeamExecution(
      c,
      run,
      lease,
      new AbortController().signal,
    );
    expect(result.status).toBe("NEEDS_USER");
    expect(f.queue).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(3);
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
        Response.json({
          model: "gpt-6.1-sol",
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
      );
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
          body.model === "gpt-6.1-sol" &&
          body.parallel_tool_calls === undefined,
      ),
    ).toBe(true);
    expect(
      f.route.mock.calls.every((call) => call[0].taskModel === "engine/fixed"),
    ).toBe(true);
    const reviewBody = bodies.find(
      (body) => body.response_format?.json_schema.name === "team_review",
    );
    expect(JSON.stringify(reviewBody.messages)).toContain("实际文件正文");
    const writerSystem = bodies
      .map((body) => String(body.messages?.[0]?.content || ""))
      .find((text) => text.includes("小序 · 编剧"));
    expect(writerSystem).toContain("<操作技能>");
    expect(writerSystem).toContain("不虚构产品参数");
    expect(writerSystem!.indexOf("职责：")).toBeLessThan(
      writerSystem!.indexOf("<操作技能>"),
    );
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
        case "team_execute": {
          const stored = (
            await f.db!.query<{
              state: { steps: { model: string; status: string }[] };
            }>("SELECT state FROM personal_assistant_team_runs WHERE id=$1", [
              run.id,
            ])
          ).rows[0];
          expect(stored.state.steps[0]).toMatchObject({
            model: "gpt-6.1-sol",
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
      model: "gpt-6.1-sol",
      modelId: "engine/fixed",
      routeReason: "固定测试模型",
    });
    expect(result.state.steps[0].error).toContain(
      "HTTP 404，code=404，type=not_found",
    );
    expect(JSON.stringify(result)).not.toContain("private-key-or-request");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
});

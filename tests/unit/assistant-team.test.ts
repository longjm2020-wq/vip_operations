import { installAiManagementSchema } from "../fixtures/ai-management-schema.js";
import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Context } from "../../apps/api/src/core.js";
import type { Tx } from "../../packages/database/src/index.js";
import { defaultTeamSettings } from "../../packages/contracts/src/assistant-team.js";
import {
  employeeWorkerConcurrency,
  pollAssistantTeamJobs,
  startAssistantTeamJobs,
} from "../../apps/worker/src/assistant-team-jobs.js";
import {
  employeeTemplate,
  employeeMemberId,
  maxEmployees,
  maxEmployeesPerTask,
  maxOpenEmployeeTasks,
  recentClosedEmployeeTasks,
  type Employee,
} from "../../packages/contracts/src/assistant-employees.js";
import {
  saveEmployee,
  archiveEmployee,
  listEmployees,
  createEmployeeTask,
  controlEmployeeTask,
  readEmployeeTask,
  listEmployeeTasks,
  employeeTeamSettings,
} from "../../apps/api/src/modules/workspace/assistant-employees.js";
import {
  claimAssistantRun,
  reserveEmployeeCall,
} from "../../apps/api/src/modules/workspace/employee-runtime.js";
import {
  applyEmployeeSkillDocuments,
  readEmployeeSkillDocuments,
  employeeSkillDocumentId,
} from "../../apps/api/src/modules/workspace/employee-skills.js";
const f = vi.hoisted(() => ({
  db: null as PGlite | null,
  videos: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("../../apps/api/src/modules/workspace/team-executor.js", () => ({
  runTeamExecution: f.execute,
  safeTeamError: () => "test execution ended",
}));
vi.mock("../../packages/database/src/index.js", async (original) => {
  const exports =
    await original<typeof import("../../packages/database/src/index.js")>();
  const wrap = (c: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...p: unknown[]) =>
      (await c.query(sql, p)).rows,
    $executeRawUnsafe: async (sql: string, ...p: unknown[]) =>
      (await c.query(sql, p)).affectedRows || 0,
  });
  return {
    ...exports,
    db: {
      $queryRawUnsafe: async (sql: string, ...p: unknown[]) =>
        (await f.db!.query(sql, p)).rows,
      $executeRawUnsafe: async (sql: string, ...p: unknown[]) =>
        (await f.db!.query(sql, p)).affectedRows || 0,
      $transaction: (work: (tx: Tx) => Promise<unknown>) =>
        f.db!.transaction((tx) => work(wrap(tx) as unknown as Tx)),
    },
  };
});
vi.mock("../../apps/api/src/modules/analytics/secrets.js", () => ({
  encryptionReady: () => true,
}));
vi.mock("../../apps/api/src/modules/workspace/team-video.js", () => ({
  publicTeamVideoCatalog: f.videos,
}));
vi.mock("../../apps/api/src/modules/workspace/agent-models.js", () => ({
  agentModelCandidates: async () => ({
    models: [
      {
        id: "engine/strong",
        actual: "openai/gpt-6.1-sol",
        name: "通用助手",
        vision: true,
        pdf: true,
        structured: true,
        parameters: ["tools"],
      },
      {
        id: "engine/batch",
        actual: "google/gemini-4-argon:batch",
        name: "批处理型号",
        vision: true,
        pdf: true,
        structured: true,
        parameters: ["tools"],
      },
    ],
    imageModels: [
      {
        id: "engine/image",
        actual: "image/model",
        name: "图像创作",
        reference: true,
        aspects: ["1:1"],
      },
    ],
    defaultModel: "engine/strong",
  }),
}));
import {
  retiredTeamEntry,
  readTeamRun,
  listTeamRuns,
  cancelTeamRun,
  readTeamLibrary,
} from "../../apps/api/src/modules/workspace/assistant-team.js";
const actor = (id = "7"): Context => ({
  actor: {
    id,
    username: "test",
    displayName: "Test",
    permissions: ["analytics.read", "analytics.manage"],
  },
  requestId: randomUUID(),
});
const body = () => ({
  id: randomUUID(),
  goal: "整理资料并制作宣传文案",
  attachmentIds: [],
  useKnowledge: true,
});
const employeeRequest = () => ({
  id: randomUUID(),
  goal: "整理资料并制作宣传文案",
});
async function seedHistoricalRun(
  user: Context,
  request: ReturnType<typeof body>,
  engine = "native",
) {
  const input = { ...request, engine, settings: defaultTeamSettings() };
  await f.db!.query(
    "INSERT INTO personal_assistant_team_runs(id,user_id,request_hash,input) VALUES($1,$2,'historical',$3::jsonb)",
    [request.id, user.actor.id, JSON.stringify(input)],
  );
  return request;
}
const errorCode = (code: string) => ({ response: { error: { code } } });
beforeAll(async () => {
  f.db = new PGlite();
  await f.db.exec(
    "CREATE TABLE users(id bigint PRIMARY KEY); INSERT INTO users VALUES(7),(8); CREATE TABLE compass_ai_settings(id int PRIMARY KEY,enabled boolean,verified_at timestamptz,api_key_encrypted text); INSERT INTO compass_ai_settings VALUES(1,true,now(),'private-provider-key');",
  );
  await installAiManagementSchema(f.db);
  await f.db
    .exec(`ALTER TABLE users ADD COLUMN username text, ADD COLUMN display_name text, ADD COLUMN status text DEFAULT 'ACTIVE';
    CREATE TABLE roles(id bigint PRIMARY KEY, code text);
    CREATE TABLE user_roles(user_id bigint,role_id bigint);`);
  for (const file of [
    "069_personal_assistant.sql",
    "083_assistant_agent.sql",
    "090_assistant_team.sql",
    "101_assistant_employees.sql",
  ])
    await f.db.exec(
      await readFile("packages/database/migrations/" + file, "utf8"),
    );
});
beforeEach(async () => {
  await f.db!.exec("TRUNCATE personal_assistant_employees CASCADE");
  await f.db!.exec(
    "TRUNCATE personal_assistant_team_runs CASCADE; TRUNCATE personal_assistant_conversations; TRUNCATE personal_assistant_teams; TRUNCATE personal_assistant_jobs; TRUNCATE personal_assistant_files; UPDATE compass_ai_settings SET enabled=true;",
  );
  f.videos.mockReset().mockResolvedValue([]);
  f.execute.mockReset();
});
afterAll(async () => {
  await f.db?.close();
});
afterEach(() => vi.unstubAllEnvs());

describe("assistant team storage and owner boundaries", () => {
  it("supports a 120-employee directory and finds available employees across it for auto dispatch", async () => {
    const profile = employeeTemplate("writing");
    const ids = Array.from({ length: maxEmployees }, () => randomUUID());
    await f.db!.query(
      `INSERT INTO personal_assistant_employees(id,user_id,profile,created_at)
      SELECT employee,7,($1::jsonb || jsonb_build_object('name','员工' || idx)),now()+idx*interval '1 millisecond'
      FROM unnest($2::uuid[]) WITH ORDINALITY AS staff(employee,idx)`,
      [JSON.stringify(profile), ids],
    );
    await f.db!.query(
      "UPDATE personal_assistant_employees SET profile=$2::jsonb WHERE id=$1",
      [ids.at(-1), JSON.stringify(employeeTemplate("review"))],
    );
    const directory = await listEmployees(actor());
    expect(directory.maxEmployees).toBe(120);
    expect(directory.employees.map((e) => e.id)).toEqual(ids);
    await expect(
      saveEmployee(actor(), { id: randomUUID(), version: 0, profile }),
    ).rejects.toMatchObject(errorCode("EMPLOYEE_LIMIT"));
    const first = await createEmployeeTask(actor(), employeeRequest());
    const next = await createEmployeeTask(actor(), employeeRequest());
    expect(first.employeeIds).toHaveLength(maxEmployeesPerTask);
    expect(first.employeeIds).toContain(ids.at(-1));
    expect(next.employeeIds).toHaveLength(maxEmployeesPerTask);
    expect(
      next.employeeIds.filter((id) => first.employeeIds.includes(id)),
    ).toEqual([ids.at(-1)]);
    const direct = await createEmployeeTask(actor(), {
      ...employeeRequest(),
      employeeId: ids.at(-2),
    });
    expect(direct.employeeId).toBe(ids.at(-2));
    const refreshed = await listEmployees(actor());
    expect(
      refreshed.employees.find((e) => e.id === ids.at(-1))?.queuedTasks,
    ).toBe(2);
    expect(
      refreshed.employees.find((e) => e.id === ids.at(-2))?.queuedTasks,
    ).toBe(1);
  });
  it("lists all 150 unfinished tasks and limits closed history without exposing snapshots", async () => {
    const employee = await saveEmployee(actor(), {
      id: randomUUID(),
      version: 0,
      profile: {
        ...employeeTemplate("writing"),
        knowledge: "仅用于执行的资料",
      },
    });
    const sample = await createEmployeeTask(actor(), {
      ...employeeRequest(),
      employeeId: employee.id,
    });
    const plan = `INSERT INTO personal_assistant_team_runs(id,user_id,request_hash,input,state,stage,status,created_at)
      SELECT gen_random_uuid(),base.user_id,'fixture',base.input,$4::jsonb,base.stage,$2,
        base.created_at+idx*interval '1 second'
      FROM personal_assistant_team_runs base CROSS JOIN generate_series(1,$3::int) AS series(idx)
      WHERE base.id=$1 RETURNING id`;
    const register = async (status: string, count: number) => {
      const slots = (
        await f.db!.query<{ id: string }>(plan, [
          sample.id,
          status,
          count,
          JSON.stringify({
            steps: [{ status: "DONE" }, { status: "PENDING" }],
            plan: "仅详情有完整计划",
          }),
        ])
      ).rows.map((r) => r.id);
      await f.db!.query(
        `INSERT INTO personal_assistant_employee_tasks(run_id,user_id,employee_id,employee_ids,origin,max_model_calls)
        SELECT id,7,$2::uuid,ARRAY[$2::uuid],'direct',40 FROM unnest($1::uuid[]) AS task(id)`,
        [slots, employee.id],
      );
      return slots;
    };
    const queued = await register("QUEUED", maxOpenEmployeeTasks - 1);
    const finished = await register("DONE", recentClosedEmployeeTasks + 5);
    const list = await listEmployeeTasks(actor(), employee.id);
    expect(list.filter((task) => task.status === "QUEUED")).toHaveLength(150);
    expect(list.some((task) => task.id === sample.id)).toBe(true);
    expect(list.filter((task) => task.status === "DONE")).toHaveLength(30);
    expect(list.some((task) => task.id === finished[0])).toBe(false);
    expect(list.find((task) => task.id === queued[0])).toMatchObject({
      summaryOnly: true,
      stepCount: 2,
      completedSteps: 1,
      members: [],
      steps: [],
    });
    expect(JSON.stringify(list)).not.toContain("仅用于执行的资料");
    expect(await listEmployeeTasks(actor("8"), employee.id)).toEqual([]);
    await expect(
      createEmployeeTask(actor(), {
        ...employeeRequest(),
        employeeId: employee.id,
      }),
    ).rejects.toMatchObject(errorCode("EMPLOYEE_QUEUE_FULL"));
  });
  it("fills matched empty skills without changing existing instructions or policies, and new tasks snapshot them", async () => {
    const docs = await readEmployeeSkillDocuments(actor());
    expect(docs).toHaveLength(10);
    const staff: Employee[] = [];
    for (const doc of docs) {
      const profile = {
        ...employeeTemplate("custom"),
        name: doc.name,
        knowledge: "保留品牌资料",
        priority: 8,
      };
      expect(employeeSkillDocumentId(profile)).toBe(doc.id);
      staff.push(
        await saveEmployee(actor(), { id: randomUUID(), version: 0, profile }),
      );
    }
    const existing = await saveEmployee(actor(), {
      id: randomUUID(),
      version: 0,
      profile: { ...employeeTemplate("writing"), skill: "原有的定制工作法" },
    });
    const unknown = await saveEmployee(actor(), {
      id: randomUUID(),
      version: 0,
      profile: { ...employeeTemplate("custom"), name: "特殊岗位" },
    });
    const oldTask = await createEmployeeTask(actor(), {
      id: randomUUID(),
      employeeId: staff[0].id,
      goal: "原配置下的任务",
    });
    const input = {
      employees: [...staff, existing, unknown].map((e) => ({
        id: e.id,
        version: e.version,
      })),
    };
    expect(await applyEmployeeSkillDocuments(actor(), input)).toEqual({
      applied: expect.arrayContaining(docs.map((d) => d.name)),
      kept: [existing.name],
      unmatched: [unknown.name],
    });
    const found = (await listEmployees(actor())).employees;
    for (const before of staff) {
      const after = found.find((e) => e.id === before.id)!;
      expect(after).toMatchObject({
        version: 2,
        knowledge: before.knowledge,
        instructions: before.instructions,
        workModel: before.workModel,
        priority: 8,
      });
      expect(after.skill).toBe(
        docs.find((d) => d.name === before.name)!.content,
      );
    }
    expect(found.find((e) => e.id === existing.id)).toMatchObject({
      version: 1,
      skill: existing.skill,
    });
    const newTask = await createEmployeeTask(actor(), {
      id: randomUUID(),
      employeeId: staff[0].id,
      goal: "新技能下的任务",
    });
    const raw = (
      await f.db!.query<{
        id: string;
        input: { settings: { members: { id: string; skill: string }[] } };
      }>(
        "SELECT id,input FROM personal_assistant_team_runs WHERE id=ANY($1::uuid[])",
        [[oldTask.id, newTask.id]],
      )
    ).rows;
    expect(
      raw
        .find((r) => r.id === oldTask.id)!
        .input.settings.members.find(
          (m) => m.id === employeeMemberId(staff[0].id),
        )!.skill,
    ).toBe("");
    expect(
      raw
        .find((r) => r.id === newTask.id)!
        .input.settings.members.find(
          (m) => m.id === employeeMemberId(staff[0].id),
        )!.skill,
    ).toBe(docs[0].content);
  });
  it("rejects stale, archived and foreign employee skill writes atomically", async () => {
    const first = await saveEmployee(actor(), {
      id: randomUUID(),
      version: 0,
      profile: employeeTemplate("image"),
    });
    const second = await saveEmployee(actor(), {
      id: randomUUID(),
      version: 0,
      profile: employeeTemplate("video"),
    });
    const input = {
      employees: [first, second].map((e) => ({ id: e.id, version: e.version })),
    };
    await saveEmployee(actor(), {
      id: second.id,
      version: 1,
      profile: employeeTemplate("video"),
    });
    await expect(
      applyEmployeeSkillDocuments(actor(), input),
    ).rejects.toMatchObject(errorCode("VERSION_CONFLICT"));
    expect(
      (await listEmployees(actor())).employees.every((e) => !e.skill),
    ).toBe(true);
    await expect(
      applyEmployeeSkillDocuments(actor("8"), input),
    ).rejects.toMatchObject(errorCode("NOT_FOUND"));
    await archiveEmployee(actor(), first.id, { version: 1, archived: true });
    await expect(
      applyEmployeeSkillDocuments(actor(), {
        employees: [{ id: first.id, version: 2 }],
      }),
    ).rejects.toMatchObject(errorCode("NOT_FOUND"));
    await expect(
      readEmployeeSkillDocuments({
        ...actor(),
        actor: { ...actor().actor, permissions: ["supply.portal"] },
      }),
    ).rejects.toBeDefined();
    expect(employeeSkillDocumentId({ name: "剪辑师1", kind: "video" })).toBe(
      "xuti-video-edit",
    );
    expect(
      employeeSkillDocumentId({ name: "未知自定义", kind: "custom" }),
    ).toBeUndefined();
  });
  it("isolates employee ownership, snapshots configuration, retries creation idempotently and keeps the main chat untouched", async () => {
    const profile = employeeTemplate("writing"),
      id = randomUUID();
    const employee = await saveEmployee(actor(), { id, version: 0, profile });
    await expect(
      saveEmployee(actor("8"), { id, version: 1, profile }),
    ).rejects.toMatchObject(errorCode("NOT_FOUND"));
    await expect(
      saveEmployee(actor(), { id, version: 0, profile }),
    ).rejects.toMatchObject(errorCode("VERSION_CONFLICT"));
    const input = {
      id: randomUUID(),
      employeeId: id,
      goal: "完成员工专属文案",
      attachmentIds: [],
    };
    const task = await createEmployeeTask(actor(), input);
    expect(task).toMatchObject({
      origin: "direct",
      employeeId: id,
      status: "QUEUED",
      profiles: [{ version: 1, profile: { name: profile.name } }],
    });
    await saveEmployee(actor(), {
      id,
      version: employee.version,
      profile: { ...profile, name: "新称呼" },
    });
    expect((await createEmployeeTask(actor(), input)).profiles[0].version).toBe(
      1,
    );
    await expect(
      createEmployeeTask(actor(), { ...input, goal: "不同目标" }),
    ).rejects.toMatchObject(errorCode("IDEMPOTENCY_CONFLICT"));
    await expect(readEmployeeTask(actor("8"), task.id)).rejects.toMatchObject(
      errorCode("NOT_FOUND"),
    );
    await expect(
      controlEmployeeTask(actor("8"), task.id, { action: "stop" }),
    ).rejects.toMatchObject(errorCode("NOT_FOUND"));
    expect(await listTeamRuns(actor())).toEqual([]);
    expect(
      (await f.db!.query("SELECT * FROM personal_assistant_conversations"))
        .rows,
    ).toEqual([]);
    expect((await listEmployees(actor("8"))).employees).toEqual([]);
  });
  it("keeps direct task context within one employee and excludes unrelated main chat", async () => {
    const id = randomUUID();
    await saveEmployee(actor(), {
      id,
      version: 0,
      profile: employeeTemplate("writing"),
    });
    const first = await createEmployeeTask(actor(), {
      id: randomUUID(),
      employeeId: id,
      goal: "专属语气是温柔克制",
    });
    await f.db!.query(
      "UPDATE personal_assistant_team_runs SET status='DONE',summary='记住克制语气' WHERE id=$1",
      [first.id],
    );
    const second = await createEmployeeTask(actor(), {
      id: randomUUID(),
      employeeId: id,
      goal: "继续创作第二份文案",
    });
    const stored = (
      await f.db!.query<{ input: { conversationContext: string } }>(
        "SELECT input FROM personal_assistant_team_runs WHERE id=$1",
        [second.id],
      )
    ).rows[0];
    expect(stored.input.conversationContext).toContain("温柔克制");
  });
  it("checks dispatch switches, separates reviewers, prevents busy archives and preserves history after archive", async () => {
    const id = randomUUID(),
      reviewer = randomUUID();
    await saveEmployee(actor(), {
      id,
      version: 0,
      profile: { ...employeeTemplate("writing"), allowDispatch: false },
    });
    await expect(
      createEmployeeTask(actor(), {
        id: randomUUID(),
        employeeIds: [id],
        goal: "派单创作文案",
      }),
    ).rejects.toMatchObject(errorCode("EMPLOYEE_DISPATCH_DISABLED"));
    const task = await createEmployeeTask(actor(), {
      id: randomUUID(),
      employeeId: id,
      goal: "直接创作文案",
    });
    await expect(
      archiveEmployee(actor(), id, { version: 1, archived: true }),
    ).rejects.toMatchObject(errorCode("EMPLOYEE_BUSY"));
    await controlEmployeeTask(actor(), task.id, { action: "stop" });
    const archived = await archiveEmployee(actor(), id, {
      version: 1,
      archived: true,
    });
    expect(archived.archived).toBe(true);
    expect((await readEmployeeTask(actor(), task.id)).status).toBe("CANCELED");
    await archiveEmployee(actor(), id, {
      version: archived.version,
      archived: false,
    });
    const context = {
      origin: "dispatch" as const,
      employees: [
        { id, version: 1, profile: employeeTemplate("image") },
        { id: reviewer, version: 1, profile: employeeTemplate("review") },
      ],
      maxModelCalls: 80,
    };
    const settings = employeeTeamSettings(context);
    expect(settings.members.find((m) => m.role === "coordinator")?.id).toBe(
      employeeMemberId(reviewer),
    );
    expect(
      settings.members.filter((m) => m.enabled && m.role === "designer"),
    ).toHaveLength(1);
  });
  it("claims by priority without exceeding employee capacity, skips paused and non-accepting queues, and bounds calls by owner and lease", async () => {
    const id = randomUUID();
    await saveEmployee(actor(), {
      id,
      version: 0,
      profile: { ...employeeTemplate("writing"), maxModelCalls: 6 },
    });
    const first = await createEmployeeTask(actor(), {
      id: randomUUID(),
      employeeId: id,
      goal: "第一份文案",
    });
    const second = await createEmployeeTask(actor(), {
      id: randomUUID(),
      employeeId: id,
      goal: "第二份文案",
    });
    await expect(readTeamRun(actor(), first.id)).rejects.toMatchObject(
      errorCode("NOT_FOUND"),
    );
    await expect(cancelTeamRun(actor(), first.id)).rejects.toMatchObject(
      errorCode("NOT_FOUND"),
    );
    await controlEmployeeTask(actor(), first.id, { action: "pause" });
    const lease = randomUUID(),
      claimed = await claimAssistantRun(lease);
    expect(claimed?.id).toBe(second.id);
    await controlEmployeeTask(actor(), first.id, { action: "resume" });
    expect(await claimAssistantRun(randomUUID())).toBeUndefined();
    expect(await reserveEmployeeCall(second.id, "8", lease)).toBe(false);
    expect(await reserveEmployeeCall(second.id, "7", randomUUID())).toBe(false);
    for (let i = 0; i < 6; i++)
      expect(await reserveEmployeeCall(second.id, "7", lease)).toBe(true);
    expect(await reserveEmployeeCall(second.id, "7", lease)).toBe(false);
    await controlEmployeeTask(actor(), second.id, { action: "stop" });
    await saveEmployee(actor(), {
      id,
      version: 1,
      profile: { ...employeeTemplate("writing"), accepting: false },
    });
    expect(await claimAssistantRun(randomUUID())).toBeUndefined();
    await saveEmployee(actor(), {
      id,
      version: 2,
      profile: employeeTemplate("writing"),
    });
    expect((await claimAssistantRun(randomUUID()))?.id).toBe(first.id);
  });
  it("blocks the retired team entry and preserves owner-scoped, read-only historical runs", async () => {
    expect(() => retiredTeamEntry(actor())).toThrow();
    try {
      retiredTeamEntry(actor());
    } catch (error) {
      expect(error).toMatchObject({
        status: 410,
        ...errorCode("TEAM_RETIRED"),
      });
    }
    const denied = actor();
    denied.actor.permissions = [];
    expect(() => retiredTeamEntry(denied)).toThrow();
    const input = body();
    await seedHistoricalRun(actor(), input, "mastra");
    const remote = await seedHistoricalRun(actor("8"), body(), "deerflow");
    expect(await listTeamRuns(actor())).toHaveLength(1);
    expect(await claimAssistantRun(randomUUID())).toBeUndefined();
    expect(await readTeamRun(actor("8"), remote.id)).toMatchObject({
      engine: "deerflow",
      status: "CANCELED",
    });
    const repeat = await readTeamRun(actor(), input.id);
    expect(repeat).toMatchObject({ engine: "mastra", status: "CANCELED" });
    await expect(readTeamRun(actor("8"), input.id)).rejects.toMatchObject(
      errorCode("NOT_FOUND"),
    );
    await expect(cancelTeamRun(actor("8"), input.id)).rejects.toMatchObject(
      errorCode("NOT_FOUND"),
    );
    const serialized = JSON.stringify(repeat);
    expect(serialized).not.toMatch(
      /request_hash|lease_id|private-provider-key|settingsVersion/,
    );
    await f.db!.query(
      "UPDATE personal_assistant_team_runs SET state=$2::jsonb WHERE id=$1",
      [
        input.id,
        JSON.stringify({
          plan: "公开计划",
          internalContext: "private-runtime-context",
          steps: [
            {
              id: "step1",
              title: "写作",
              memberId: "writing",
              instruction: "完成文案",
              dependencies: [],
              difficulty: "standard",
              deliverable: "text",
              acceptance: ["正文完整"],
              status: "RUNNING",
              attempts: 1,
              jobIds: [],
              artifactIds: [],
              providerPayload: "private-provider-payload",
            },
          ],
        }),
      ],
    );
    const viewed = await readTeamRun(actor(), input.id);
    expect(viewed.steps[0].title).toBe("写作");
    expect(JSON.stringify(viewed)).not.toMatch(
      /private-runtime-context|private-provider-payload|providerPayload/,
    );
  });
  it("drains a live historical lease, preserves interrupted remote receipts, and never claims either run", async () => {
    const live = await seedHistoricalRun(actor(), body(), "mastra");
    const lost = await seedHistoricalRun(actor(), body(), "deerflow");
    const receipt = { deerflow: { runId: "original-request" } };
    await f.db!.query(
      "UPDATE personal_assistant_team_runs SET status='RUNNING',lease_id=$1,heartbeat_at=now() WHERE id=$2",
      [randomUUID(), live.id],
    );
    await f.db!.query(
      "UPDATE personal_assistant_team_runs SET status='RUNNING',lease_id=$1,heartbeat_at=NULL,updated_at=now()-interval '4 minutes',state=$3::jsonb WHERE id=$2",
      [randomUUID(), lost.id, JSON.stringify(receipt)],
    );
    await pollAssistantTeamJobs(new AbortController().signal);
    expect(await readTeamRun(actor(), live.id)).toMatchObject({
      status: "RUNNING",
    });
    const interrupted = (
      await f.db!.query(
        "SELECT status,state,lease_id FROM personal_assistant_team_runs WHERE id=$1",
        [lost.id],
      )
    ).rows[0];
    expect(interrupted).toMatchObject({
      status: "NEEDS_USER",
      state: receipt,
      lease_id: null,
    });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("fills the configured employee slots in one poll and observes each member's capacity", async () => {
    expect(employeeWorkerConcurrency("")).toBe(6);
    expect(employeeWorkerConcurrency("24")).toBe(24);
    expect(employeeWorkerConcurrency("25")).toBe(6);
    vi.stubEnv("ASSISTANT_EMPLOYEE_WORKER_CONCURRENCY", "6");
    const queued: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const employeeId = randomUUID();
      await saveEmployee(actor(), {
        id: employeeId,
        version: 0,
        profile: { ...employeeTemplate("writing"), priority: 9 - index },
      });
      const task = await createEmployeeTask(actor(), {
        id: randomUUID(),
        employeeId,
        goal: "准备文案",
      });
      queued.push(task.id);
      if (index === 0) {
        const duplicate = await createEmployeeTask(actor(), {
          id: randomUUID(),
          employeeId,
          goal: "准备下一份文案",
        });
        queued.push(duplicate.id);
      }
    }
    f.execute.mockImplementation(
      async (_actor, _run, _lease, signal: AbortSignal) => {
        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
      },
    );
    const stop = startAssistantTeamJobs();
    try {
      await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(6), {
        timeout: 2_500,
      });
      const claimed = f.execute.mock.calls.map(([, run]) => run.id);
      expect(claimed).toEqual([queued[0], ...queued.slice(2, 7)]);
      const waiting = (
        await f.db!.query<{ id: string }>(
          "SELECT id FROM personal_assistant_team_runs WHERE status='QUEUED' ORDER BY created_at",
        )
      ).rows.map((row) => row.id);
      expect(waiting).toEqual([queued[1], queued[7]]);
    } finally {
      await stop();
    }
  });
  it("keeps child jobs owned by a newer employee lease if the old execution fails late", async () => {
    const employeeId = randomUUID(),
      nextLease = randomUUID(),
      child = randomUUID();
    await saveEmployee(actor(), {
      id: employeeId,
      version: 0,
      profile: employeeTemplate("writing"),
    });
    const run = await createEmployeeTask(actor(), {
      id: randomUUID(),
      employeeId,
      goal: "准备文案",
    });
    f.execute.mockImplementationOnce(async () => {
      await f.db!.query(
        "UPDATE personal_assistant_team_runs SET lease_id=$2 WHERE id=$1",
        [run.id, nextLease],
      );
      await f.db!.query(
        "INSERT INTO personal_assistant_jobs(id,user_id,request_id,call_id,kind,title,input,status) VALUES($1,7,$2,$3,'document','file','{}','QUEUED')",
        [child, run.id, randomUUID()],
      );
      throw Error("previous lease ended");
    });
    await pollAssistantTeamJobs(new AbortController().signal);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(
      (
        await f.db!.query(
          "SELECT lease_id,status FROM personal_assistant_team_runs WHERE id=$1",
          [run.id],
        )
      ).rows[0],
    ).toMatchObject({ lease_id: nextLease, status: "PLANNING" });
    expect(
      (
        await f.db!.query(
          "SELECT status FROM personal_assistant_jobs WHERE id=$1",
          [child],
        )
      ).rows[0],
    ).toMatchObject({ status: "QUEUED" });
  });
  it("cancels a historical run and its active children only for that owner, idempotently", async () => {
    const inputs = [body(), body()];
    for (const input of inputs) await seedHistoricalRun(actor(), input);
    const childIds: string[] = [];
    for (const [id, status, owner] of [
      [inputs[0].id, "QUEUED", 7],
      [inputs[0].id, "RUNNING", 7],
      [inputs[1].id, "QUEUED", 7],
      [inputs[0].id, "QUEUED", 8],
    ] as const) {
      const childId = randomUUID();
      childIds.push(childId);
      // Equal timestamps must not change which owner's children are canceled.
      await f.db!.query(
        "INSERT INTO personal_assistant_jobs(id,user_id,request_id,call_id,kind,title,input,status,created_at) VALUES($1,$2,$3,$4,'image','test','{}',$5,'2026-01-01T00:00:00Z')",
        [childId, owner, id, randomUUID(), status],
      );
    }
    expect(await cancelTeamRun(actor(), inputs[0].id)).toMatchObject({
      canceled: true,
      note: expect.stringContaining("不保证远端停止或费用回退"),
    });
    expect(await cancelTeamRun(actor(), inputs[0].id)).toMatchObject({
      canceled: true,
    });
    expect((await readTeamRun(actor(), inputs[0].id)).status).toBe("CANCELED");
    const jobs = (
      await f.db!.query<{ id: string; status: string }>(
        "SELECT id,status FROM personal_assistant_jobs",
      )
    ).rows;
    expect(Object.fromEntries(jobs.map((job) => [job.id, job.status]))).toEqual(
      {
        [childIds[0]]: "CANCELED",
        [childIds[1]]: "CANCELED",
        [childIds[2]]: "QUEUED",
        [childIds[3]]: "QUEUED",
      },
    );
  });
  it("archives only accepted owner artifacts, searches literal text and enforces cross-owner foreign keys", async () => {
    const input = body();
    await seedHistoricalRun(actor(), input);
    const other = body();
    await seedHistoricalRun(actor("8"), other);
    for (const [run, owner, status] of [
      [input.id, 7, "DRAFT"],
      [input.id, 7, "REJECTED"],
      [input.id, 7, "ACCEPTED"],
      [other.id, 8, "ACCEPTED"],
    ] as const)
      await f.db!.query(
        "INSERT INTO personal_assistant_team_artifacts(id,user_id,run_id,step_id,member_id,attempt,title,kind,content,status,citations) VALUES($1,$2,$3,$4,'writing',1,$5,'text','body',$6,$7::jsonb)",
        [
          randomUUID(),
          owner,
          run,
          status,
          owner === 7 ? "归档 needle" : "other-private",
          status,
          JSON.stringify([
            { title: "unsafe", url: "javascript:alert(1)" },
            { title: "来源", url: "https://example.com/a" },
          ]),
        ],
      );
    const library = await readTeamLibrary(actor(), "needle");
    expect(library).toHaveLength(1);
    expect(library[0].status).toBe("ACCEPTED");
    expect(library[0].citations).toEqual([
      { title: "来源", url: "https://example.com/a" },
    ]);
    const mine = randomUUID(),
      foreign = randomUUID();
    await f.db!.query(
      "INSERT INTO personal_assistant_files(id,user_id,name,mime,size,source,content) VALUES($1,7,'mine.txt','text/plain',1,'generated',$3),($2,8,'private.txt','text/plain',1,'generated',$3)",
      [mine, foreign, new Uint8Array([65])],
    );
    await f.db!.query(
      "UPDATE personal_assistant_team_artifacts SET file_ids=$2::jsonb WHERE id=$1",
      [library[0].id, JSON.stringify([foreign, mine])],
    );
    const files = (await readTeamLibrary(actor(), "needle"))[0];
    expect(files.fileIds).toEqual([mine]);
    expect(files.files.map((file) => file.id)).toEqual([mine]);
    expect(await readTeamLibrary(actor(), "%")).toEqual([]);
    expect(JSON.stringify(await readTeamLibrary(actor()))).not.toContain(
      "other-private",
    );
    await expect(
      f.db!.query(
        "INSERT INTO personal_assistant_team_artifacts(id,user_id,run_id,step_id,member_id,attempt,title,kind) VALUES($1,8,$2,'foreign','writing',1,'bad','text')",
        [randomUUID(), input.id],
      ),
    ).rejects.toThrow();
    expect((await readTeamRun(actor(), input.id)).artifacts).toHaveLength(3);
  });
});

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
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { Context } from "../../apps/api/src/core.js";
import type { Row, Tx } from "../../packages/database/src/index.js";
import type { AuthRequest } from "../../apps/api/src/http.js";

const fixture = vi.hoisted(() => ({
  database: null as PGlite | null,
  encrypted: true,
  inventory: vi.fn(),
  queueInventory: vi.fn(),
  queueCompass: vi.fn(),
  activity: vi.fn(),
}));
vi.mock("../../apps/api/src/modules/inventory/summary.js", () => ({
  inventorySummary: fixture.inventory,
}));
vi.mock("../../apps/api/src/modules/inventory/jushuitan.js", () => ({
  queueJushuitan: fixture.queueInventory,
}));
vi.mock("../../apps/api/src/modules/analytics/browser-update.js", () => ({
  requestCompassUpdate: fixture.queueCompass,
}));
vi.mock("../../apps/api/src/modules/workspace/activity.js", () => ({
  assistantActivity: fixture.activity,
}));
vi.mock("../../packages/database/src/index.js", async (original) => {
  const exports =
    await original<typeof import("../../packages/database/src/index.js")>();
  const wrap = (connection: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) =>
      (await connection.query(sql, parameters)).rows,
    $executeRawUnsafe: async (sql: string, ...parameters: unknown[]) =>
      (await connection.query(sql, parameters)).affectedRows || 0,
  });
  return {
    ...exports,
    db: {
      $queryRawUnsafe: async (sql: string, ...parameters: unknown[]) =>
        (await fixture.database!.query(sql, parameters)).rows,
      $executeRawUnsafe: async (sql: string, ...parameters: unknown[]) =>
        (await fixture.database!.query(sql, parameters)).affectedRows || 0,
      $transaction: (work: (tx: Tx) => Promise<unknown>) =>
        fixture.database!.transaction((transaction) =>
          work(wrap(transaction) as unknown as Tx),
        ),
    },
  };
});
vi.mock("../../apps/api/src/modules/analytics/ai.js", () => ({
  COMPASS_AI_MODEL: "openai/gpt-6.1-sol",
  COMPASS_AI_ENDPOINT: "https://openrouter.ai/api/v1/chat/completions",
}));
vi.mock("../../apps/api/src/modules/analytics/secrets.js", () => ({
  encryptionReady: () => fixture.encrypted,
  decryptSecret: () => "test-only-secret",
}));
import {
  assistantContext,
  clearAssistant,
  parseAssistantAnswer,
  readAssistant,
  sendAssistant,
} from "../../apps/api/src/modules/workspace/assistant.js";
import { PersonalWorkspaceController } from "../../apps/api/src/modules/workspace/controller.js";
import { workspaceSaveSchema } from "../../packages/contracts/src/personal-workspace.js";
import {
  readAssistantMemory,
  saveAssistantMemory,
} from "../../apps/api/src/modules/workspace/assistant-memory.js";
import { executeAssistantAction } from "../../apps/api/src/modules/workspace/assistant-actions.js";
import {
  executeAssistantTool,
  type AssistantToolSession,
} from "../../apps/api/src/modules/workspace/assistant-tools.js";

const actor = (id = "7"): Context => ({
  actor: {
    id,
    username: "test",
    displayName: "Test",
    permissions: ["analytics.manage", "analytics.read"],
    roleCodes: [],
  },
  requestId: "test",
  key: randomUUID(),
});
const input = (version = 0) => ({
  message: "安排明天的选款会",
  version,
  requestId: randomUUID(),
  includePersonalContext: false,
});
const event = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "评审",
  date: "2026-11-01",
  startTime: "15:00",
  endTime: "16:00",
  note: "",
};
const reply = {
  text: "已整理为草稿，请确认。",
  schedules: [
    {
      title: event.title,
      date: event.date,
      startTime: event.startTime,
      endTime: event.endTime,
      note: "",
    },
  ],
  tools: ["analytics"],
};
const provider = (content: unknown = reply, model = "openai/gpt-6.1-sol") =>
  new Response(
    JSON.stringify({
      id: "fixture",
      model,
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(content) },
        },
      ],
    }),
    { status: 200 },
  );
let calls: Row[];
beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(
    "CREATE TABLE users(id bigint PRIMARY KEY); INSERT INTO users VALUES(7),(8); CREATE TABLE compass_ai_settings(id int PRIMARY KEY,enabled boolean,api_key_encrypted text,verified_at timestamptz); INSERT INTO compass_ai_settings VALUES(1,true,'test-only',now()); CREATE TABLE idempotency_records(id bigserial PRIMARY KEY,actor_id bigint,operation text,idempotency_key text,request_hash text,response_status int,response_body jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());",
  );
  for (const name of [
    "036_personal_workspaces.sql",
    "069_personal_assistant.sql",
    "079_assistant_tools_memory.sql",
  ])
    await fixture.database.exec(
      await readFile(`packages/database/migrations/${name}`, "utf8"),
    );
  await fixture.database.exec(`
    CREATE TABLE projects(id bigint PRIMARY KEY,name text,status text,owner_id bigint,visibility text,deleted_at timestamptz,document jsonb,updated_at timestamptz DEFAULT now());
    CREATE TABLE project_members(project_id bigint,user_id bigint);
    CREATE TABLE project_library_acl(kind text,resource_id bigint,user_id bigint,access text);
  `);
});
beforeEach(async () => {
  fixture.encrypted = true;
  calls = [];
  await fixture.database!.exec(
    "TRUNCATE personal_assistant_conversations,personal_workspaces,idempotency_records,personal_assistant_actions,personal_assistant_memories,projects,project_members,project_library_acl; UPDATE compass_ai_settings SET enabled=true,verified_at=now()",
  );
  fixture.inventory.mockReset();
  fixture.queueInventory.mockReset();
  fixture.queueCompass.mockReset();
  fixture.activity.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return provider();
    }),
  );
});

const toolReply = (name: string, argumentsValue: object) =>
  new Response(
    JSON.stringify({
      id: "tool-fixture",
      model: "openai/gpt-6.1-sol",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              {
                type: "function",
                id: randomUUID(),
                function: { name, arguments: JSON.stringify(argumentsValue) },
              },
            ],
          },
        },
      ],
    }),
  );
const toolSession = (): AssistantToolSession => ({
  evidence: [],
  actions: [],
  memorySuggestions: [],
});
describe("assistant business tools and private memory", () => {
  it("saves memory only for its owner, detects edits from another tab and sends memory only by opt-in", async () => {
    const mine = {
      id: randomUUID(),
      title: "工作偏好",
      content: "prefer-a-short-checklist",
    };
    const theirs = {
      id: randomUUID(),
      title: "私有偏好",
      content: "another-user-memory",
    };
    const body = { version: 0, entries: [mine] },
      c = actor();
    await saveAssistantMemory(c, body);
    expect((await saveAssistantMemory(c, body)).version).toBe(1);
    await saveAssistantMemory(actor("8"), { version: 0, entries: [theirs] });
    await expect(saveAssistantMemory(actor(), body)).rejects.toMatchObject({
      response: { error: { code: "VERSION_CONFLICT" } },
    });
    expect((await readAssistantMemory(actor())).entries).toEqual([mine]);
    await sendAssistant(actor(), input());
    expect(JSON.stringify(calls)).not.toContain(mine.content);
    const current = await readAssistant(actor());
    await sendAssistant(actor(), {
      ...input(current.version),
      includeMemory: true,
    });
    expect(JSON.stringify(calls[1])).toContain(mine.content);
    expect(JSON.stringify(calls)).not.toContain(theirs.content);
    await saveAssistantMemory(actor(), {
      version: 1,
      entries: [{ ...mine, content: "edited" }],
    });
    await saveAssistantMemory(actor(), { version: 2, entries: [] });
    expect((await readAssistantMemory(actor())).entries).toEqual([]);
    expect((await readAssistantMemory(actor("8"))).entries).toEqual([theirs]);
    const denied = actor();
    denied.actor.permissions = ["analytics.read"];
    await expect(readAssistantMemory(denied)).rejects.toThrow();
    await expect(
      saveAssistantMemory(actor(), { version: 3, entries: [mine, mine] }),
    ).rejects.toThrow();
  });
  it("queries the authorized JST snapshot with full string identifiers and attaches server evidence", async () => {
    const c = actor();
    c.actor.permissions.push("inventory.read");
    const barcode = "000123456789012345678901234";
    fixture.inventory.mockResolvedValue({
      stock_source_info: {
        warehouse_name: "杭州总仓",
        finished_at: "2026-11-01T08:00:00Z",
      },
      total: 1,
      totals: { physical_qty: 15, return_qty: null },
      data: [
        {
          barcode,
          style_no: "XFA16X31196L",
          color_name: "粉色",
          size_name: "L",
          physical_qty: 15,
          return_qty: null,
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(async (_url, init) => {
          calls.push(JSON.parse(init.body));
          return toolReply("query_inventory", { query: "XFA16X31196L" });
        })
        .mockImplementationOnce(async (_url, init) => {
          calls.push(JSON.parse(init.body));
          return provider({
            text: "实际库存15件，销退仓数据不完整。",
            schedules: [],
            tools: [],
          });
        }),
    );
    const result = await sendAssistant(c, {
      ...input(),
      message: "查一下XFA16X31196L库存",
    });
    expect(result.state).toBe("IDLE");
    expect(fixture.inventory.mock.calls[0][0]).toMatchObject({
      stockSource: "jushuitan",
      q: "XFA16X31196L",
      pageSize: 12,
    });
    expect(fixture.inventory.mock.calls[0][2]).toBe("7");
    const evidence = result.messages.at(-1).evidence[0];
    expect(evidence.summary).toContain("2026-11-01T08:00:00.000Z");
    expect(evidence.rows[0].label).toContain(barcode);
    expect(evidence.rows[0].value).toContain("销退仓 数据不完整");
    expect(
      calls[1].messages.find((m: Row) => m.role === "tool").content,
    ).toContain(barcode);
    expect(fixture.queueInventory).not.toHaveBeenCalled();
  });
  it("rejects unauthorized and wildcard queries even when a model requests them", async () => {
    const session = toolSession();
    await executeAssistantTool(
      actor(),
      "query_inventory",
      '{"query":"S15"}',
      session,
      false,
    );
    const c = actor();
    c.actor.permissions.push("inventory.read");
    await executeAssistantTool(
      c,
      "query_inventory",
      '{"query":"%"}',
      session,
      false,
    );
    await executeAssistantTool(
      c,
      "arbitrary_sql",
      '{"query":"SELECT *"}',
      session,
      false,
    );
    expect(fixture.inventory).not.toHaveBeenCalled();
    expect(session.evidence.every((item) => !item.ok)).toBe(true);
  });
  it("honors project ACLs and never includes opted-out schedules in tool results", async () => {
    await fixture.database!
      .exec(`INSERT INTO projects(id,name,status,owner_id,visibility,document) VALUES
      (1,'我的项目','ACTIVE',7,'PRIVATE','{"tasks":[{"status":"DONE"},{"status":"ACTIVE"}]}'),
      (2,'协作项目','ACTIVE',8,'PRIVATE','{"tasks":[]}'),(3,'拒绝项目','ACTIVE',8,'PUBLIC','{"tasks":[]}'),
      (4,'私有项目','ACTIVE',8,'PRIVATE','{"tasks":[]}'),(5,'草稿项目','DRAFT',8,'PRIVATE','{"tasks":[]}'),
      (6,'公共项目','ACTIVE',8,'PUBLIC','{"tasks":[]}');
      INSERT INTO project_members VALUES(2,7),(3,7),(5,7);
      INSERT INTO project_library_acl VALUES('project',3,7,'DENY');`);
    const c = actor();
    c.actor.permissions.push("project.read");
    const session = toolSession();
    await executeAssistantTool(
      c,
      "query_projects",
      '{"query":""}',
      session,
      false,
    );
    expect(session.evidence[0].rows?.map((row) => row.label).sort()).toEqual([
      "协作项目",
      "我的项目",
    ]);
    expect(
      session.evidence[0].rows?.find((row) => row.label === "我的项目")?.value,
    ).toContain("已验收 1 / 2");
    await executeAssistantTool(
      c,
      "query_projects",
      '{"query":"项目"}',
      session,
      false,
    );
    expect(session.evidence[1].rows?.map((row) => row.label).sort()).toEqual([
      "公共项目",
      "协作项目",
      "我的项目",
    ]);
    fixture.activity.mockResolvedValue({
      items: [
        {
          kind: "schedule",
          title: "private-day",
          detail: "10:00",
          href: "/my-workspace",
        },
        {
          kind: "task",
          title: "report",
          detail: "执行中",
          href: "/analytics/compass",
        },
      ],
    });
    await executeAssistantTool(c, "query_activity", "{}", session, false);
    expect(JSON.stringify(session.evidence.at(-1))).not.toContain(
      "private-day",
    );
    await executeAssistantTool(c, "query_activity", "{}", session, true);
    expect(JSON.stringify(session.evidence.at(-1))).toContain("private-day");
  });
  it("only queues a proposed action after its owner clicks, checks current permissions and replays without duplication", async () => {
    fixture.queueCompass.mockResolvedValue({
      job: { id: "9007199254740993000", status: "QUEUED" },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(toolReply("prepare_sync", { kind: "compass" }))
        .mockResolvedValueOnce(
          provider({ text: "请点击操作卡片。", schedules: [], tools: [] }),
        ),
    );
    const result = await sendAssistant(actor(), {
      ...input(),
      message: "更新罗盘报表",
    });
    const action = result.messages.at(-1).actions[0];
    expect(action.status).toBe("PROPOSED");
    expect(fixture.queueCompass).not.toHaveBeenCalled();
    await expect(
      executeAssistantAction(actor("8"), { id: action.id }),
    ).rejects.toMatchObject({ response: { error: { code: "NOT_FOUND" } } });
    const denied = actor();
    denied.actor.permissions = ["product.read", "product.update"];
    expect(
      (await readAssistant(denied)).messages.at(-1).actions[0].canExecute,
    ).toBe(false);
    await expect(
      executeAssistantAction(denied, { id: action.id }),
    ).rejects.toThrow();
    const submitted = await executeAssistantAction(actor(), { id: action.id });
    expect(submitted).toMatchObject({
      status: "SUBMITTED",
      jobId: "9007199254740993000",
    });
    expect(submitted.note).not.toContain("已完成");
    await executeAssistantAction(actor(), { id: action.id });
    expect(fixture.queueCompass).toHaveBeenCalledTimes(1);
    expect(fixture.queueCompass.mock.calls[0][0].key).toBe(
      `assistant:${action.id}`,
    );
  });
  it("enforces JST administrator permission, retries with a stable key, and expires or cancels unused actions", async () => {
    const id = randomUUID();
    await fixture.database!.query(
      "INSERT INTO personal_assistant_actions(id,user_id,kind) VALUES($1,7,'jushuitan')",
      [id],
    );
    const c = actor();
    c.actor.permissions.push("inventory.adjust");
    await expect(executeAssistantAction(c, { id })).rejects.toThrow();
    c.actor.roleCodes = ["SUPER_ADMIN"];
    fixture.queueInventory
      .mockRejectedValueOnce(new Error("private connection information"))
      .mockResolvedValue({ id: "run", status: "QUEUED" });
    expect(await executeAssistantAction(c, { id })).toMatchObject({
      status: "FAILED",
      note: "服务暂不可用，请稍后重试",
    });
    expect(await executeAssistantAction(c, { id })).toMatchObject({
      status: "SUBMITTED",
    });
    expect(
      fixture.queueInventory.mock.calls.map((call) => call[0].key),
    ).toEqual([`assistant:${id}`, `assistant:${id}`]);
    const stale = randomUUID();
    await fixture.database!.query(
      "INSERT INTO personal_assistant_actions(id,user_id,kind,created_at) VALUES($1,7,'compass',now()-interval '2 days')",
      [stale],
    );
    await expect(
      executeAssistantAction(actor(), { id: stale }),
    ).rejects.toMatchObject({
      response: { error: { code: "ACTION_EXPIRED" } },
    });
    const proposed = randomUUID();
    await fixture.database!.query(
      "INSERT INTO personal_assistant_actions(id,user_id,kind) VALUES($1,7,'compass')",
      [proposed],
    );
    const result = await sendAssistant(actor(), input());
    await clearAssistant(actor(), { version: result.version });
    expect(
      (
        await fixture.database!.query<Row>(
          "SELECT status FROM personal_assistant_actions WHERE id=$1",
          [proposed],
        )
      ).rows[0].status,
    ).toBe("CANCELED");
    expect(
      (
        await fixture.database!.query<Row>(
          "SELECT status FROM personal_assistant_actions WHERE id=$1",
          [id],
        )
      ).rows[0].status,
    ).toBe("SUBMITTED");
  });
  it("does not save model-proposed memory or persist actions from an invalid final response, and bounds tool loops", async () => {
    const session = toolSession();
    await executeAssistantTool(
      actor(),
      "propose_memory",
      '{"title":"偏好","content":"简洁回复"}',
      session,
      false,
    );
    expect(session.memorySuggestions).toHaveLength(1);
    expect((await readAssistantMemory(actor())).entries).toEqual([]);
    const fetcher = vi
      .fn()
      .mockImplementation(async () =>
        toolReply("prepare_sync", { kind: "compass" }),
      );
    vi.stubGlobal("fetch", fetcher);
    const result = await sendAssistant(actor(), input());
    expect(result.state).toBe("FAILED");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      (
        await fixture.database!.query(
          "SELECT * FROM personal_assistant_actions",
        )
      ).rows,
    ).toHaveLength(0);
    expect(fixture.queueCompass).not.toHaveBeenCalled();
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => fixture.database?.close());

describe("private personal assistant", () => {
  it("recovers an expired request without pretending it completed or retrying on read", async () => {
    await sendAssistant(actor(), input());
    await fixture.database!.exec(
      "UPDATE personal_assistant_conversations SET state='PENDING',pending_since=now()-interval '4 minutes'",
    );
    const expired = await readAssistant(actor());
    expect(expired.state).toBe("FAILED");
    expect(expired.error).toContain("超时");
    expect(calls).toHaveLength(1);
    const resumed = await sendAssistant(actor(), input(expired.version));
    expect(resumed.state).toBe("IDLE");
    expect(calls).toHaveLength(2);
  });
  it("does not call the provider on read, does not expose credentials, and enforces permissions", async () => {
    const state = await readAssistant(actor());
    expect(state.ready).toBe(true);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(state)).not.toContain("test-only");
    const denied = actor();
    denied.actor.permissions = ["analytics.read"];
    await expect(readAssistant(denied)).rejects.toMatchObject({
      response: { error: { code: "FORBIDDEN" } },
    });
    await expect(sendAssistant(denied, input())).rejects.toThrow();
    fixture.encrypted = false;
    expect((await readAssistant(actor())).ready).toBe(false);
    await expect(sendAssistant(actor(), input())).rejects.toMatchObject({
      response: { error: { code: "AI_NOT_READY" } },
    });
    expect(calls).toHaveLength(0);
  });
  it("persists a private conversation and replays the same request without another model call", async () => {
    const body = input();
    const result = await sendAssistant(actor(), body);
    expect(result.messages).toHaveLength(2);
    expect(result.state).toBe("IDLE");
    expect(result.messages[1].responseModel).toBe("openai/gpt-6.1-sol");
    expect((await sendAssistant(actor(), body)).messages).toEqual(
      result.messages,
    );
    expect(calls).toHaveLength(1);
    expect((await readAssistant(actor("8"))).messages).toEqual([]);
    await expect(
      sendAssistant(actor(), { ...body, message: "different" }),
    ).rejects.toMatchObject({
      response: { error: { code: "REQUEST_CONFLICT" } },
    });
    await expect(sendAssistant(actor(), input())).rejects.toMatchObject({
      response: { error: { code: "VERSION_CONFLICT" } },
    });
  });
  it("only sends opted-in, bounded personal context, never the private memo or another user's data", async () => {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const config = {
      shortcuts: [],
      note: "never-send-this-memo",
      todos: [
        { id: randomUUID(), title: "my-task", done: false, dueDate: today },
      ],
      schedule: [{ ...event, date: today, title: "my-event" }],
    };
    await fixture.database!.query(
      "INSERT INTO personal_workspaces(user_id,config) VALUES(7,$1),(8,$2)",
      [
        JSON.stringify(config),
        JSON.stringify({
          ...config,
          note: "other-secret",
          todos: [{ title: "other-task" }],
        }),
      ],
    );
    await sendAssistant(actor(), input());
    expect(JSON.stringify(calls[0])).not.toContain("my-event");
    const current = await readAssistant(actor());
    await sendAssistant(actor(), {
      ...input(current.version),
      includePersonalContext: true,
    });
    const sent = JSON.stringify(calls[1]);
    expect(sent).toContain("my-event");
    expect(sent).toContain("my-task");
    expect(sent).not.toContain("never-send-this-memo");
    expect(sent).not.toContain("other-task");
    expect(
      assistantContext(
        { ...config, todos: Array.from({ length: 80 }, () => config.todos[0]) },
        today,
      ).todos,
    ).toHaveLength(50);
  });
  it("never writes proposed schedules, rejects unknown tools, invalid dates and a different response model", async () => {
    await sendAssistant(actor(), input());
    expect(
      (await fixture.database!.query("SELECT * FROM personal_workspaces")).rows,
    ).toHaveLength(0);
    expect(() =>
      parseAssistantAnswer({ ...reply, tools: ["users"] }, ["analytics"]),
    ).toThrow();
    expect(() =>
      parseAssistantAnswer(
        {
          ...reply,
          schedules: [{ ...reply.schedules[0], date: "2026-02-30" }],
        },
        ["analytics"],
      ),
    ).toThrow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => provider(reply, "different-model")),
    );
    const current = await readAssistant(actor());
    const result = await sendAssistant(actor(), input(current.version));
    expect(result.state).toBe("FAILED");
    expect(result.error).toContain("模型标识不符");
    expect(
      result.messages.filter((item: Row) => item.role === "assistant"),
    ).toHaveLength(1);
  });
  it("preserves provider failures without retry or leaking response data", async () => {
    const fetcher = vi.fn(
      async () => new Response("sensitive-provider-detail", { status: 402 }),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await sendAssistant(actor(), input());
    expect(result.state).toBe("FAILED");
    expect(result.error).toContain("余额或额度不足");
    expect(JSON.stringify(result)).not.toContain("sensitive-provider-detail");
    await readAssistant(actor());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("prevents parallel requests and clearing an in-flight conversation", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await blocked;
        return provider();
      }),
    );
    const pending = sendAssistant(actor(), input());
    await vi.waitFor(async () =>
      expect((await readAssistant(actor())).state).toBe("PENDING"),
    );
    const current = await readAssistant(actor());
    await expect(
      sendAssistant(actor(), input(current.version)),
    ).rejects.toMatchObject({ response: { error: { code: "AI_BUSY" } } });
    await expect(
      clearAssistant(actor(), { version: current.version }),
    ).rejects.toThrow();
    release();
    await pending;
  });
  it("applies rate limits across clearing conversation and isolates clear to the current owner", async () => {
    await sendAssistant(actor(), input());
    await sendAssistant(actor("8"), input());
    await fixture.database!.exec(
      "UPDATE personal_assistant_conversations SET request_count=20 WHERE user_id=7",
    );
    const current = await readAssistant(actor());
    const cleared = await clearAssistant(actor(), { version: current.version });
    expect(cleared.messages).toEqual([]);
    expect((await readAssistant(actor("8"))).messages).toHaveLength(2);
    await expect(
      sendAssistant(actor(), input(cleared.version)),
    ).rejects.toMatchObject({ response: { error: { code: "AI_RATE_LIMIT" } } });
  });
  it("rejects invalid schedule times and duplicates; legacy workspace clients retain saved schedules", async () => {
    const config = {
      shortcuts: [],
      note: "private",
      todos: [],
      schedule: [event],
    };
    expect(
      workspaceSaveSchema.safeParse({ ...config, version: 0 }).success,
    ).toBe(true);
    expect(
      workspaceSaveSchema.safeParse({
        ...config,
        version: 0,
        schedule: [event, event],
      }).success,
    ).toBe(false);
    expect(
      workspaceSaveSchema.safeParse({
        ...config,
        version: 0,
        schedule: [{ ...event, endTime: "14:00" }],
      }).success,
    ).toBe(false);
    await fixture.database!.query(
      "INSERT INTO personal_workspaces(user_id,config) VALUES(7,$1)",
      [JSON.stringify(config)],
    );
    const controller = new PersonalWorkspaceController();
    const request = {
      actor: actor().actor,
      requestId: "workspace-test",
      get: () => randomUUID(),
    } as unknown as AuthRequest;
    await controller.save(request, {
      version: 1,
      shortcuts: [],
      note: "updated",
      todos: [],
    });
    const row = (
      await fixture.database!.query<Row>(
        "SELECT config FROM personal_workspaces WHERE user_id=7",
      )
    ).rows[0];
    expect(row.config.schedule).toEqual([event]);
    expect(row.config.note).toBe("updated");
    await expect(
      controller.save(request, { ...config, version: 1 }),
    ).rejects.toMatchObject({
      response: { error: { code: "VERSION_CONFLICT" } },
    });
  });
});

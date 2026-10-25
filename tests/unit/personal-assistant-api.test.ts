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
  ])
    await fixture.database.exec(
      await readFile(`packages/database/migrations/${name}`, "utf8"),
    );
});
beforeEach(async () => {
  fixture.encrypted = true;
  calls = [];
  await fixture.database!.exec(
    "TRUNCATE personal_assistant_conversations,personal_workspaces,idempotency_records; UPDATE compass_ai_settings SET enabled=true,verified_at=now()",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return provider();
    }),
  );
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

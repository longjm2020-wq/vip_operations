import { installAiManagementSchema } from "../fixtures/ai-management-schema.js";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { hash, type Context } from "../../apps/api/src/core.js";
import type { Row, Tx } from "../../packages/database/src/index.js";
import { desktopActionSchema } from "../../packages/contracts/src/assistant-desktop.js";

const fixture = vi.hoisted(() => ({
  db: null as PGlite | null,
  session: true,
  beforeControlUpdate: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../../packages/database/src/index.js", async (original) => {
  const real =
    await original<typeof import("../../packages/database/src/index.js")>();
  const wrap = (c: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...p: unknown[]) =>
      (await c.query(sql, p)).rows,
    $executeRawUnsafe: async (sql: string, ...p: unknown[]) =>
      sql.includes("pg_advisory_xact_lock")
        ? 0
        : (await c.query(sql, p)).affectedRows || 0,
  });
  return {
    ...real,
    db: {
      $queryRawUnsafe: async (sql: string, ...p: unknown[]) => {
        if (sql.startsWith("UPDATE assistant_desktop_tasks SET status=$3,")) {
          const beforeUpdate = fixture.beforeControlUpdate;
          fixture.beforeControlUpdate = undefined;
          await beforeUpdate?.();
        }
        return (await fixture.db!.query(sql, p)).rows;
      },
      $executeRawUnsafe: async (sql: string, ...p: unknown[]) =>
        sql.includes("pg_advisory_xact_lock")
          ? 0
          : (await fixture.db!.query(sql, p)).affectedRows || 0,
      $transaction: (f: (tx: Tx) => Promise<unknown>) =>
        fixture.db!.transaction((tx) => f(wrap(tx) as unknown as Tx)),
    },
  };
});
vi.mock("../../apps/api/src/modules/auth/service.js", () => ({
  actorForSessionHash: async (h: string) => {
    if (!fixture.session || h !== hash("owner-session"))
      throw Error("会话已失效");
    return actor().actor;
  },
}));
vi.mock("../../apps/api/src/modules/analytics/secrets.js", () => ({
  encryptionReady: () => true,
  decryptSecret: () => "test-only",
}));
vi.mock("../../apps/api/src/modules/analytics/ai.js", () => ({
  COMPASS_AI_MODEL: "openai/gpt-6.1-sol",
  COMPASS_AI_ENDPOINT: "https://example.invalid/completion",
}));
import {
  acknowledgeDesktop,
  createDesktopPair,
  desktopControl,
  desktopProviderDiagnostic,
  desktopIdentity,
  desktopState,
  pairDesktop,
  permitDesktop,
  planDesktop,
  pollDesktop,
  queueDesktopTask,
  readDesktopProviderError,
  revokeDesktop,
  setDesktopAuthorization,
} from "../../apps/api/src/modules/workspace/desktop.js";
const actor = (id = "7"): Context => ({
  actor: {
    id,
    username: "test",
    displayName: "测试",
    permissions: ["analytics.read", "analytics.manage"],
  },
  requestId: randomUUID(),
});
beforeAll(async () => {
  fixture.db = new PGlite();
  await fixture.db.exec(
    "CREATE TABLE users(id bigint PRIMARY KEY);INSERT INTO users VALUES(7),(8);CREATE TABLE compass_ai_settings(id int PRIMARY KEY,enabled boolean,api_key_encrypted text,verified_at timestamptz);INSERT INTO compass_ai_settings VALUES(1,true,'fixture',now());",
  );
  await installAiManagementSchema(fixture.db);
  await fixture.db.exec(
    await readFile(
      "packages/database/migrations/084_assistant_desktop.sql",
      "utf8",
    ),
  );
  await fixture.db.exec(
    await readFile(
      "packages/database/migrations/088_desktop_authorization.sql",
      "utf8",
    ),
  );
});
beforeEach(async () => {
  fixture.session = true;
  fixture.beforeControlUpdate = undefined;
  await fixture.db!.exec(
    "TRUNCATE assistant_desktop_tasks,assistant_desktop_devices;",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      model({
        kind: "click",
        x: 250,
        y: 400,
        button: "left",
        description: "点击文本区",
      }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(async () => {
  await fixture.db?.close();
});
const model = (action: unknown) =>
  new Response(
    JSON.stringify({
      model: "openai/gpt-6.1-sol",
      choices: [{ message: { content: JSON.stringify(action) } }],
    }),
  );
async function paired() {
  const p = await createDesktopPair(actor(), "owner-session");
  return {
    ...(await pairDesktop({ code: p.code, name: "测试电脑" })),
    code: p.code,
  };
}
async function queued() {
  const d = await paired();
  const t = await queueDesktopTask(actor(), {
    deviceId: d.deviceId,
    requestId: randomUUID(),
    instruction: "整理记事本里的段落",
  });
  return { d, t };
}
async function allowed() {
  const r = await queued();
  await desktopControl(
    actor(),
    r.t.id,
    { action: "allow", window: "笔记", application: "notepad" },
    r.d.deviceId,
  );
  return r;
}
async function shot() {
  return {
    requestId: randomUUID(),
    image: (
      await sharp({
        create: { width: 400, height: 400, channels: 3, background: "white" },
      })
        .jpeg()
        .toBuffer()
    ).toString("base64"),
    width: 400,
    height: 400,
    window: "笔记",
    application: "notepad",
    controls: "Edit: 文本区",
  };
}

describe("paired desktop task execution", () => {
  it.each([
    ["openrouter_guardrail_budget", "DESKTOP_PROVIDER_BUDGET"],
    ["openrouter_workspace_budget", "DESKTOP_PROVIDER_BUDGET"],
    ["openrouter_key_limit", "DESKTOP_PROVIDER_BUDGET"],
  ])(
    "classifies the documented budget source %s without provider text",
    (limit_source, code) => {
      const result = desktopProviderDiagnostic(403, {
        error: {
          code: 403,
          message: "secret-account-value",
          metadata: { limit_source, raw: "secret-provider-body" },
        },
      });
      expect(result).toMatchObject({
        code,
        category: limit_source,
        upstreamCode: 403,
        upstreamStatus: 403,
      });
      expect(result.message).toContain("上游 HTTP 403");
      expect(JSON.stringify(result)).not.toContain("secret");
    },
  );
  it.each([
    ["permission_denied", "DESKTOP_PROVIDER_PERMISSION"],
    ["content_policy_violation", "DESKTOP_PROVIDER_POLICY"],
    ["refusal", "DESKTOP_PROVIDER_POLICY"],
    ["authentication", "DESKTOP_PROVIDER_AUTH"],
  ])("uses only the known error type %s", (error_type, code) => {
    expect(
      desktopProviderDiagnostic(403, { error: { metadata: { error_type } } })
        .code,
    ).toBe(code);
  });
  it.each([
    ["Budget limit exceeded (private account)", "DESKTOP_PROVIDER_BUDGET"],
    ["Key limit reached.", "DESKTOP_PROVIDER_BUDGET"],
    ["Access denied by security policy", "DESKTOP_PROVIDER_PERMISSION"],
    ["User not found.", "DESKTOP_PROVIDER_AUTH"],
    ["Inference is blocked on this account", "DESKTOP_PROVIDER_PERMISSION"],
    [
      "No endpoints found that match your data policy. Private detail",
      "DESKTOP_PROVIDER_PRIVACY",
    ],
  ])(
    "recognizes the anchored standard message %s without exposing it",
    (message, code) => {
      const result = desktopProviderDiagnostic(403, { error: { message } });
      expect(result.code).toBe(code);
      expect(result.message).not.toContain(message);
    },
  );
  it("does not guess unknown 403 causes or echo arbitrary codes and messages", () => {
    const result = desktopProviderDiagnostic(403, {
      error: {
        code: "private-token",
        message: "Details mention Budget limit exceeded but this is unrelated",
        metadata: { error_type: "private-cause", raw: "private-body" },
      },
    });
    expect(result).toEqual({
      code: "DESKTOP_PROVIDER_HTTP",
      message:
        "智能服务拒绝了此次请求，尚未提供可识别的原因（上游 HTTP 403）；任务已暂停",
      upstreamStatus: 403,
    });
  });
  it("bounds upstream error reads and does not wait indefinitely for a streaming error", async () => {
    expect(
      await readDesktopProviderError(
        new Response(JSON.stringify({ error: { code: 403 } })),
      ),
    ).toEqual({ error: { code: 403 } });
    expect(
      await readDesktopProviderError(new Response(" ".repeat(8193))),
    ).toBeUndefined();
    expect(
      await readDesktopProviderError(
        new Response("<html>private error</html>"),
      ),
    ).toBeUndefined();
    vi.useFakeTimers();
    const cancel = vi.fn();
    const pending = readDesktopProviderError(
      new Response(new ReadableStream({ cancel })),
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("persists a safe provider reason and preserves it against the native failure handoff", async () => {
    const { d, t } = await allowed();
    const c = actor();
    const observation = await shot();
    const logs = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 403,
                message: "private-credential",
                metadata: {
                  limit_source: "openrouter_key_limit",
                  raw: "private-provider-body",
                },
              },
            }),
            { status: 403 },
          ),
      ),
    );
    await expect(
      planDesktop(c, d.deviceId, t.id, observation),
    ).rejects.toMatchObject({
      response: { error: { code: "DESKTOP_PROVIDER_BUDGET" } },
    });
    const paused = (await desktopState(actor())).tasks[0];
    expect(paused.status).toBe("PAUSED");
    expect(paused.stage).toContain("预算已达上限");
    expect(paused.stage).toContain("HTTP 403");
    expect(
      (
        await desktopControl(
          actor(),
          t.id,
          { action: "handoff", startupFailure: true, note: "客户端连接错误" },
          d.deviceId,
        )
      ).stage,
    ).toBe(paused.stage);
    const record = JSON.parse(String(logs.mock.calls[0][0]));
    expect(record).toMatchObject({
      event: "desktop_plan_failed",
      requestId: c.requestId,
      taskId: t.id,
      code: "DESKTOP_PROVIDER_BUDGET",
      upstreamStatus: 403,
      upstreamCode: 403,
      category: "openrouter_key_limit",
    });
    expect(JSON.stringify(logs.mock.calls)).not.toContain("private-");
    expect(JSON.stringify(logs.mock.calls)).not.toContain(observation.image);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(observation.controls);
  });
  it("cannot replace a user stop when a late upstream failure arrives", async () => {
    const { d, t } = await allowed();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let finish!: (r: Response) => void;
    let started!: () => void;
    const start = new Promise<void>((r) => {
      started = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((r) => {
            finish = r;
            started();
          }),
      ),
    );
    const pending = planDesktop(actor(), d.deviceId, t.id, await shot());
    const rejected = expect(pending).rejects.toThrow();
    await start;
    const stopped = await desktopControl(actor(), t.id, { action: "stop" });
    finish(
      new Response(JSON.stringify({ error: { code: 403 } }), { status: 403 }),
    );
    await rejected;
    expect((await desktopState(actor())).tasks[0]).toMatchObject({
      status: "CANCELED",
      stage: stopped.stage,
    });
  });
  it("remembers a device grant across polls, isolates ownership and does not expose its identifier to the website", async () => {
    const d = await paired();
    expect((await desktopState(actor())).devices[0].crossWindowAuthorized).toBe(
      false,
    );
    const grant = await setDesktopAuthorization(actor(), d.deviceId, true);
    expect(grant.authorizationId).toBeTruthy();
    expect(await setDesktopAuthorization(actor(), d.deviceId, true)).toEqual(
      grant,
    );
    expect((await pollDesktop(actor(), d.deviceId)).authorizationId).toBe(
      grant.authorizationId,
    );
    const state = await desktopState(actor());
    expect(state.devices[0].crossWindowAuthorized).toBe(true);
    expect(JSON.stringify(state)).not.toContain(grant.authorizationId);
    const task = await queueDesktopTask(actor(), {
      deviceId: d.deviceId,
      requestId: randomUUID(),
      instruction: "整理笔记",
    });
    expect(task.status).toBe("WAITING");
    expect(task.stage).toBe("等待本机按设备授权开始");
    await expect(
      setDesktopAuthorization(actor("8"), d.deviceId, false),
    ).rejects.toThrow();
    const other = await paired();
    expect(
      (await pollDesktop(actor(), other.deviceId)).authorizationId,
    ).toBeNull();
    await setDesktopAuthorization(actor(), d.deviceId, false);
    expect((await pollDesktop(actor(), d.deviceId)).authorizationId).toBeNull();
    expect(
      (await setDesktopAuthorization(actor(), d.deviceId, true))
        .authorizationId,
    ).not.toBe(grant.authorizationId);
  });
  it("requires the native device and its current grant before enabling cross-window execution", async () => {
    const { d, t } = await queued();
    const grant = await setDesktopAuthorization(actor(), d.deviceId, true);
    const input = {
      action: "allow",
      window: "笔记",
      application: "notepad",
      windowId: randomUUID(),
      ...grant,
    };
    await expect(desktopControl(actor(), t.id, input)).rejects.toThrow();
    await expect(
      desktopControl(actor(), t.id, input, randomUUID()),
    ).rejects.toThrow();
    await expect(
      desktopControl(
        actor(),
        t.id,
        { ...input, authorizationId: randomUUID() },
        d.deviceId,
      ),
    ).rejects.toThrow();
    expect((await pollDesktop(actor(), d.deviceId)).task?.status).toBe(
      "WAITING",
    );
    expect((await desktopControl(actor(), t.id, input, d.deviceId)).scope).toBe(
      "device",
    );
    await setDesktopAuthorization(actor(), d.deviceId, false);
    await setDesktopAuthorization(actor(), d.deviceId, true);
    await expect(
      desktopControl(actor(), t.id, input, d.deviceId),
    ).rejects.toThrow();
  });
  it("switches only to an observed window and binds the next screenshot after an acknowledged switch", async () => {
    const { d, t } = await queued();
    const grant = await setDesktopAuthorization(actor(), d.deviceId, true);
    const first = { id: randomUUID(), title: "笔记", application: "notepad" };
    const second = {
      id: randomUUID(),
      title: "业务网页",
      application: "msedge",
    };
    await desktopControl(
      actor(),
      t.id,
      {
        action: "allow",
        window: first.title,
        application: first.application,
        windowId: first.id,
        ...grant,
      },
      d.deviceId,
    );
    const observation = {
      ...(await shot()),
      windowId: first.id,
      windows: [first, second],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        model({
          kind: "switch_window",
          windowId: second.id,
          description: "查看业务网页",
        }),
      ),
    );
    const plan = await planDesktop(actor(), d.deviceId, t.id, observation);
    expect(plan.command?.targetWindow).toEqual(second);
    expect(
      (
        await permitDesktop(actor(), d.deviceId, t.id, {
          commandId: plan.command!.id,
        })
      ).allowed,
    ).toBe(true);
    const next = {
      ...observation,
      requestId: randomUUID(),
      windowId: second.id,
      window: second.title,
      application: second.application,
    };
    await expect(
      planDesktop(actor(), d.deviceId, t.id, next),
    ).rejects.toMatchObject({
      response: { error: { code: "WINDOW_CHANGED" } },
    });
    const ack = { commandId: plan.command!.id, outcome: "ok", note: "已切换" };
    expect(
      (await acknowledgeDesktop(actor(), d.deviceId, t.id, ack)).window,
    ).toBe(second.title);
    expect(
      (await acknowledgeDesktop(actor(), d.deviceId, t.id, ack)).step,
    ).toBe(1);
    await expect(
      planDesktop(actor(), d.deviceId, t.id, observation),
    ).rejects.toMatchObject({
      response: { error: { code: "WINDOW_CHANGED" } },
    });
    await desktopControl(actor(), t.id, { action: "resume" });
    await desktopControl(
      actor(),
      t.id,
      {
        action: "allow",
        window: second.title,
        application: second.application,
        windowId: second.id,
        ...grant,
      },
      d.deviceId,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => model({ kind: "wait", description: "等待网页加载" })),
    );
    expect(
      (await planDesktop(actor(), d.deviceId, t.id, next)).command?.action.kind,
    ).toBe("wait");
    const sent = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(sent.messages[0].content).toContain("switch_window");
    expect(JSON.parse(sent.messages[1].content[0].text).windows).toEqual([
      first,
      second,
    ]);
  });
  it.each(["unknown", "duplicate", "missing"])(
    "rejects %s window targets or observations",
    async (mode) => {
      const { d, t } = await queued();
      const grant = await setDesktopAuthorization(actor(), d.deviceId, true);
      const first = { id: randomUUID(), title: "笔记", application: "notepad" };
      await desktopControl(
        actor(),
        t.id,
        {
          action: "allow",
          window: first.title,
          application: first.application,
          windowId: first.id,
          ...grant,
        },
        d.deviceId,
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          model({
            kind: "switch_window",
            windowId: randomUUID(),
            description: "切换",
          }),
        ),
      );
      await expect(
        planDesktop(actor(), d.deviceId, t.id, {
          ...(await shot()),
          windowId: first.id,
          ...(mode !== "missing"
            ? { windows: mode === "duplicate" ? [first, first] : [first] }
            : {}),
        }),
      ).rejects.toThrow();
    },
  );
  it("keeps legacy tasks in one window even when the device has a saved grant", async () => {
    const { d, t } = await allowed();
    await setDesktopAuthorization(actor(), d.deviceId, true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        model({
          kind: "switch_window",
          windowId: randomUUID(),
          description: "切换",
        }),
      ),
    );
    const observation = await shot();
    await expect(
      planDesktop(actor(), d.deviceId, t.id, {
        ...observation,
        windows: [{ id: randomUUID(), title: "笔记", application: "notepad" }],
      }),
    ).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
    await desktopControl(actor(), t.id, { action: "resume" });
    await desktopControl(
      actor(),
      t.id,
      { action: "allow", window: "笔记", application: "notepad" },
      d.deviceId,
    );
    await expect(
      planDesktop(actor(), d.deviceId, t.id, observation),
    ).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
    expect((await pollDesktop(actor(), d.deviceId)).task?.status).toBe(
      "PAUSED",
    );
  });
  it("revokes a pending switch, never revives it on a late ack, and allows single-window use afterward", async () => {
    const { d, t } = await queued();
    const grant = await setDesktopAuthorization(actor(), d.deviceId, true);
    const first = { id: randomUUID(), title: "笔记", application: "notepad" };
    const second = { id: randomUUID(), title: "表格", application: "EXCEL" };
    await desktopControl(
      actor(),
      t.id,
      {
        action: "allow",
        window: first.title,
        application: first.application,
        windowId: first.id,
        ...grant,
      },
      d.deviceId,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        model({
          kind: "switch_window",
          windowId: second.id,
          description: "切换",
        }),
      ),
    );
    const plan = await planDesktop(actor(), d.deviceId, t.id, {
      ...(await shot()),
      windowId: first.id,
      windows: [first, second],
    });
    await setDesktopAuthorization(actor(), d.deviceId, false);
    expect(
      (
        await permitDesktop(actor(), d.deviceId, t.id, {
          commandId: plan.command!.id,
        })
      ).allowed,
    ).toBe(false);
    const late = await acknowledgeDesktop(actor(), d.deviceId, t.id, {
      commandId: plan.command!.id,
      outcome: "ok",
      note: "迟到",
    });
    expect(late.status).toBe("PAUSED");
    expect(late.window).toBe(first.title);
    expect(late.step).toBe(0);
    expect(
      (
        await desktopControl(
          actor(),
          t.id,
          {
            action: "allow",
            window: first.title,
            application: first.application,
          },
          d.deviceId,
        )
      ).scope,
    ).toBe("window");
  });
  it("discards analysis completed after authorization was revoked and regranted", async () => {
    const { d, t } = await queued();
    const grant = await setDesktopAuthorization(actor(), d.deviceId, true);
    const first = { id: randomUUID(), title: "笔记", application: "notepad" };
    const input = {
      action: "allow",
      window: first.title,
      application: first.application,
      windowId: first.id,
      ...grant,
    };
    await desktopControl(actor(), t.id, input, d.deviceId);
    let finish!: (r: Response) => void;
    let started!: () => void;
    const start = new Promise<void>((r) => {
      started = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((r) => {
            finish = r;
            started();
          }),
      ),
    );
    const pending = planDesktop(actor(), d.deviceId, t.id, {
      ...(await shot()),
      windowId: first.id,
      windows: [first],
    });
    await start;
    await setDesktopAuthorization(actor(), d.deviceId, false);
    const next = await setDesktopAuthorization(actor(), d.deviceId, true);
    await desktopControl(actor(), t.id, { ...input, ...next }, d.deviceId);
    finish(model({ kind: "key", key: "ENTER", description: "迟到步骤" }));
    expect((await pending).command).toBeNull();
    expect((await pollDesktop(actor(), d.deviceId)).task?.step).toBe(0);
  });
  it("makes pairing single-use and credentials owner-only, rejects browser use and revoked sessions", async () => {
    const d = await paired();
    await expect(
      pairDesktop({ code: d.code, name: "其他电脑" }),
    ).rejects.toThrow();
    const record = (
      await fixture.db!.query<Row>("SELECT * FROM assistant_desktop_devices")
    ).rows[0];
    expect(record.token_hash).toBe(hash(d.token));
    expect(record.pair_hash).toBeNull();
    expect(JSON.stringify(await desktopState(actor()))).not.toContain(d.token);
    expect((await desktopState(actor("8"))).devices).toHaveLength(0);
    await expect(
      desktopIdentity("Bearer " + d.token, "https://site.invalid"),
    ).rejects.toThrow();
    expect(
      (await desktopIdentity("Bearer " + d.token, undefined)).c.actor.id,
    ).toBe("7");
    fixture.session = false;
    await expect(
      desktopIdentity("Bearer " + d.token, undefined),
    ).rejects.toThrow("会话已失效");
  });
  it("expires unused pair codes and rejects missing assistant permission", async () => {
    const p = await createDesktopPair(actor(), "owner-session");
    await fixture.db!.exec(
      "UPDATE assistant_desktop_devices SET pair_expires_at=now()-interval '1 minute'",
    );
    await expect(pairDesktop({ code: p.code, name: "电脑" })).rejects.toThrow();
    const denied = actor();
    denied.actor.permissions = [];
    await expect(desktopState(denied)).rejects.toThrow();
  });
  it("isolates devices, deduplicates task requests and requires local consent", async () => {
    const d = await paired(),
      request = {
        deviceId: d.deviceId,
        requestId: randomUUID(),
        instruction: "整理笔记",
      };
    const task = await queueDesktopTask(actor(), request);
    expect((await queueDesktopTask(actor(), request)).id).toBe(task.id);
    await expect(
      queueDesktopTask(actor(), { ...request, instruction: "不同操作" }),
    ).rejects.toThrow();
    await expect(
      queueDesktopTask(actor("8"), { ...request, requestId: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      desktopControl(actor(), task.id, {
        action: "allow",
        window: "笔记",
        application: "notepad",
      }),
    ).rejects.toThrow();
    await expect(
      desktopControl(actor("8"), task.id, { action: "stop" }),
    ).rejects.toThrow();
    expect(
      (await planDesktop(actor(), d.deviceId, task.id, await shot())).command,
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["WAITING", "RUNNING"])(
    "records a native startup failure from %s and invalidates pending execution",
    async (status) => {
      const { d, t } = status === "RUNNING" ? await allowed() : await queued();
      await fixture.db!.query(
        "UPDATE assistant_desktop_tasks SET pending=$2::jsonb,planning_id=$3::uuid WHERE id=$1::uuid",
        [t.id, JSON.stringify({ id: randomUUID() }), randomUUID()],
      );
      const result = await desktopControl(
        actor(),
        t.id,
        {
          action: "handoff",
          startupFailure: true,
          note: "没有可操作窗口，请打开应用后继续",
        },
        d.deviceId,
      );
      expect(result.status).toBe("NEEDS_USER");
      expect(result.stage).toBe("没有可操作窗口，请打开应用后继续");
      expect(result.step).toBe(0);
      const stored = (
        await fixture.db!.query<Row>(
          "SELECT pending,planning_id FROM assistant_desktop_tasks WHERE id=$1::uuid",
          [t.id],
        )
      ).rows[0];
      expect(stored).toEqual({ pending: null, planning_id: null });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each(["PAUSED", "NEEDS_USER", "CANCELED", "DONE", "FAILED"])(
    "preserves %s and its reason when a startup failure arrives later",
    async (status) => {
      const { d, t } = await queued();
      await fixture.db!.query(
        "UPDATE assistant_desktop_tasks SET status=$2,stage='已由用户或执行器确认' WHERE id=$1::uuid",
        [t.id, status],
      );
      const result = await desktopControl(
        actor(),
        t.id,
        { action: "handoff", startupFailure: true, note: "迟到的启动失败" },
        d.deviceId,
      );
      expect(result.status).toBe(status);
      expect(result.stage).toBe("已由用户或执行器确认");
      expect((await desktopState(actor())).tasks[0]).toMatchObject({
        status,
        stage: result.stage,
      });
    },
  );
  it("accepts startup failure only from the owning native device with handoff", async () => {
    const { d, t } = await queued();
    const input = { action: "handoff", startupFailure: true, note: "启动失败" };
    await expect(desktopControl(actor(), t.id, input)).rejects.toMatchObject({
      response: { error: { code: "FORBIDDEN" } },
    });
    await expect(
      desktopControl(actor("8"), t.id, input, d.deviceId),
    ).rejects.toMatchObject({ response: { error: { code: "NOT_FOUND" } } });
    await expect(
      desktopControl(actor(), t.id, input, randomUUID()),
    ).rejects.toMatchObject({ response: { error: { code: "NOT_FOUND" } } });
    for (const action of ["pause", "stop", "resume", "allow"])
      await expect(
        desktopControl(actor(), t.id, { ...input, action }, d.deviceId),
      ).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
    await expect(
      desktopControl(
        actor(),
        t.id,
        { ...input, startupFailure: false },
        d.deviceId,
      ),
    ).rejects.toMatchObject({
      response: { error: { code: "VALIDATION_ERROR" } },
    });
    expect((await pollDesktop(actor(), d.deviceId)).task?.status).toBe(
      "WAITING",
    );
    await desktopControl(actor(), t.id, { action: "pause" });
    expect(
      (
        await desktopControl(
          actor(),
          t.id,
          { action: "handoff", note: "旧客户端接手" },
          d.deviceId,
        )
      ).status,
    ).toBe("NEEDS_USER");
  });
  it.each(["PAUSED", "CANCELED"])(
    "does not overwrite %s committed between reading and updating a startup failure",
    async (status) => {
      const { d, t } = await allowed();
      fixture.beforeControlUpdate = async () => {
        await fixture.db!.query(
          "UPDATE assistant_desktop_tasks SET status=$2,stage='用户先停止了启动' WHERE id=$1::uuid",
          [t.id, status],
        );
      };
      const result = await desktopControl(
        actor(),
        t.id,
        { action: "handoff", startupFailure: true, note: "迟到的启动失败" },
        d.deviceId,
      );
      expect(result).toMatchObject({ status, stage: "用户先停止了启动" });
      expect((await desktopState(actor())).tasks[0]).toMatchObject({
        status,
        stage: "用户先停止了启动",
      });
    },
  );
  it("executes one validated step and acknowledges exactly once without storing the screen", async () => {
    const { d, t } = await allowed(),
      observation = await shot();
    const p = await planDesktop(actor(), d.deviceId, t.id, observation);
    expect(p.command?.action.kind).toBe("click");
    const commandId = p.command!.id;
    expect(
      await permitDesktop(actor(), d.deviceId, t.id, { commandId }),
    ).toEqual({ allowed: true });
    const ack = { commandId, outcome: "ok", note: "点击完成" };
    expect(
      (await acknowledgeDesktop(actor(), d.deviceId, t.id, ack)).step,
    ).toBe(1);
    expect(
      (await acknowledgeDesktop(actor(), d.deviceId, t.id, ack)).step,
    ).toBe(1);
    expect(
      await permitDesktop(actor(), d.deviceId, t.id, { commandId }),
    ).toEqual({ allowed: false });
    const stored = (
      await fixture.db!.query<Row>("SELECT * FROM assistant_desktop_tasks")
    ).rows[0];
    expect(stored.pending).toBeNull();
    expect(JSON.stringify(stored)).not.toContain(observation.image);
  });
  it("drops a late model response when stopped and cannot be revived by acknowledgment", async () => {
    const { d, t } = await allowed();
    let finish!: (r: Response) => void;
    let started!: () => void;
    const start = new Promise<void>((r) => {
      started = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((r) => {
            finish = r;
            started();
          }),
      ),
    );
    const pending = planDesktop(actor(), d.deviceId, t.id, await shot());
    await start;
    await desktopControl(actor(), t.id, { action: "stop" });
    finish(model({ kind: "key", key: "ENTER", description: "回车" }));
    expect((await pending).command).toBeNull();
    await acknowledgeDesktop(actor(), d.deviceId, t.id, {
      commandId: randomUUID(),
      outcome: "ok",
      note: "迟到反馈",
    });
    expect((await desktopState(actor())).tasks[0].status).toBe("CANCELED");
  });
  it("pauses on invalid actions, binds the selected window and revokes pending execution", async () => {
    const { d, t } = await allowed();
    await expect(
      planDesktop(actor(), d.deviceId, t.id, {
        ...(await shot()),
        application: "cmd",
      }),
    ).rejects.toThrow();
    expect((await desktopState(actor())).tasks[0]).toMatchObject({
      status: "PAUSED",
      stage: "操作窗口或窗口列表已变化，请核对窗口后继续",
    });
    await desktopControl(actor(), t.id, { action: "resume" });
    await desktopControl(
      actor(),
      t.id,
      { action: "allow", window: "笔记", application: "notepad" },
      d.deviceId,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => model({ kind: "shell", command: "whoami" })),
    );
    await expect(
      planDesktop(actor(), d.deviceId, t.id, await shot()),
    ).rejects.toThrow();
    expect((await pollDesktop(actor(), d.deviceId)).task?.status).toBe(
      "PAUSED",
    );
    await revokeDesktop(actor(), d.deviceId);
    await expect(
      desktopIdentity("Bearer " + d.token, undefined),
    ).rejects.toThrow();
    expect((await desktopState(actor())).tasks[0].status).toBe("CANCELED");
  });
  it("describes resuming a pre-start pause using the current device grant without binding the task early", async () => {
    const { d, t } = await queued();
    await setDesktopAuthorization(actor(), d.deviceId, true);
    await desktopControl(actor(), t.id, { action: "pause" });
    const resumed = await desktopControl(actor(), t.id, { action: "resume" });
    expect(resumed).toMatchObject({
      status: "WAITING",
      stage: "等待本机按设备授权继续",
      scope: "window",
      window: "",
      step: 0,
    });
    expect(
      (
        await fixture.db!.query<Row>(
          "SELECT authorization_id,window_id FROM assistant_desktop_tasks WHERE id=$1::uuid",
          [t.id],
        )
      ).rows[0],
    ).toEqual({ authorization_id: null, window_id: null });
    await setDesktopAuthorization(actor(), d.deviceId, false);
    expect(
      (await desktopControl(actor(), t.id, { action: "resume" })).stage,
    ).toBe("请在本机重新确认操作窗口");
  });
  it("requires a fresh local selection after resume and exposes handoffs honestly", async () => {
    const { d, t } = await allowed();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        model({ kind: "handoff", description: "请自行登录后继续" }),
      ),
    );
    const result = await planDesktop(actor(), d.deviceId, t.id, await shot());
    expect(result.task.status).toBe("NEEDS_USER");
    expect(result.command).toBeNull();
    expect(
      (await desktopControl(actor(), t.id, { action: "resume" })).status,
    ).toBe("WAITING");
    expect(
      (await planDesktop(actor(), d.deviceId, t.id, await shot())).command,
    ).toBeNull();
    await expect(
      desktopControl(actor(), t.id, { action: "pause", window: "替换窗口" }),
    ).rejects.toThrow();
  });
  it("rejects arbitrary scripts, unsafe shortcuts and malformed normalized coordinates", () => {
    expect(
      desktopActionSchema.safeParse({
        kind: "key",
        key: "WIN_R",
        description: "运行",
      }).success,
    ).toBe(false);
    expect(
      desktopActionSchema.safeParse({
        kind: "click",
        x: 1001,
        y: 0,
        button: "left",
        description: "越界",
      }).success,
    ).toBe(false);
    expect(
      desktopActionSchema.safeParse({
        kind: "type",
        text: "文本",
        description: "输入",
        script: "run",
      }).success,
    ).toBe(false);
  });
});

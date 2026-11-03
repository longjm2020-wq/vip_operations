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
      $queryRawUnsafe: async (sql: string, ...p: unknown[]) =>
        (await fixture.db!.query(sql, p)).rows,
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
  desktopIdentity,
  desktopState,
  pairDesktop,
  permitDesktop,
  planDesktop,
  pollDesktop,
  queueDesktopTask,
  revokeDesktop,
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
  await fixture.db.exec(
    await readFile(
      "packages/database/migrations/084_assistant_desktop.sql",
      "utf8",
    ),
  );
});
beforeEach(async () => {
  fixture.session = true;
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
afterEach(() => vi.unstubAllGlobals());
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

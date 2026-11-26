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
        if (
          sql.startsWith("UPDATE assistant_desktop_tasks SET status=$3,") ||
          sql.startsWith(
            "UPDATE assistant_desktop_tasks t SET status='NEEDS_USER',stage='等待本机只读核验原粘贴结果'",
          )
        ) {
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
  controlMacFileCopy,
  controlBackgroundCopy,
  desktopControl,
  desktopTaskView,
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
  setDesktopPurpose,
  yieldDesktopObservation,
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
  await fixture.db.exec(
    await readFile(
      "packages/database/migrations/098_desktop_device_purpose.sql",
      "utf8",
    ),
  );
  await fixture.db.exec(
    await readFile(
      "packages/database/migrations/109_assistant_local_browser.sql",
      "utf8",
    ),
  );
  await fixture.db.exec(
    await readFile(
      "packages/database/migrations/114_desktop_execution_readiness.sql",
      "utf8",
    ),
  );
  await fixture.db.exec(
    await readFile(
      "packages/database/migrations/115_desktop_window_continuations.sql",
      "utf8",
    ),
  );
  await fixture.db.exec(await readFile("packages/database/migrations/117_desktop_file_shortcuts.sql", "utf8"));
  await fixture.db.exec(await readFile("packages/database/migrations/118_desktop_folder_copy.sql", "utf8"));
  await fixture.db.exec(await readFile("packages/database/migrations/119_desktop_file_copy_verification.sql", "utf8"));
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
  const newCapabilities = {
    fileCopyShortcuts: true,
    desktopFolderCopy: true,
    backgroundFileCopy: true,
    fileCopyVerification: true,
  };
  const compound = String.raw`在我的电脑新建文件夹"自动化112601"，并将路径D:\Desktop\AI0520下的内容复制进来`;
  async function oldUncertainCopy() {
    const c = actor(),
      { deviceId } = await paired();
    const { authorizationId } = await setDesktopAuthorization(
      c,
      deviceId,
      true,
    );
    await pollDesktop(c, deviceId, false, {
      fileCopyShortcuts: true,
      desktopFolderCopy: true,
    });
    const task = await queueDesktopTask(c, {
      deviceId,
      requestId: randomUUID(),
      instruction: compound,
    });
    const commandId = randomUUID();
    const history = [
      {
        step: 7,
        action: "key",
        description: "复制已选中的源文件",
        result: "ok",
        confirmedTotal: 6,
      },
      {
        step: 8,
        action: "switch_window",
        description: "切换到指定的目标目录",
        result: "ok",
        confirmedTotal: 7,
      },
      {
        step: 9,
        action: "key",
        description: "向目标目录粘贴并核验文件",
        result: "uncertain",
        confirmedTotal: 7,
      },
    ];
    await fixture.db!.query(
      `UPDATE assistant_desktop_tasks SET status='NEEDS_USER',stage='操作已中止，请核对窗口。',
      application='explorer',window_id=$2,step=9,history=$3::jsonb,last_ack=$4 WHERE id=$1`,
      [task.id, randomUUID(), JSON.stringify(history), commandId],
    );
    const migration = await readFile(
      "packages/database/migrations/119_desktop_file_copy_verification.sql",
      "utf8",
    );
    const backfill = () =>
      fixture.db!.exec(
        migration.slice(migration.indexOf("UPDATE assistant_desktop_tasks")),
      );
    const poll = () => pollDesktop(c, deviceId, false, newCapabilities);
    const verify = (outcome: string, extra = {}) =>
      acknowledgeDesktop(c, deviceId, task.id, {
        commandId,
        authorizationId,
        fileCopyVerified: true,
        outcome,
        note: "本机已核对",
        ...extra,
      });
    return {
      c,
      deviceId,
      task,
      authorizationId,
      commandId,
      poll,
      verify,
      backfill,
    };
  }
  it("reconciles the old uncertain paste against its own verified files without issuing a command", async () => {
    const r = await oldUncertainCopy();
    expect((await r.poll()).task?.fileCopyVerification).toBeUndefined();
    await r.backfill();
    expect((await r.poll()).task?.fileCopyVerification).toEqual({
      commandId: r.commandId,
      authorizationId: r.authorizationId,
    });
    await expect(r.verify("ok", { commandId: randomUUID() })).rejects.toThrow();
    await expect(
      r.verify("ok", { authorizationId: randomUUID() }),
    ).rejects.toThrow();
    const done = await r.verify("ok");
    expect(done).toMatchObject({
      status: "DONE",
      step: 9,
      confirmedSteps: 8,
      fileCopyProgress: "verified",
    });
    expect(done.recentSteps?.at(-1)).toEqual({
      step: 9,
      action: "key",
      fileShortcut: "paste",
      result: "ok",
      verifiedAfterPaste: true,
    });
    expect((await r.verify("ok")).step).toBe(9);
    expect((await r.poll()).task).toBeNull();
  });
  const exitNotice = {
    action: "pause",
    note: "小序桌面端已退出，请重新打开并核对窗口后继续",
  };
  it("keeps the original uncertain paste across a normal 1.2.13 exit and first 1.2.14 poll", async () => {
    const r = await oldUncertainCopy();
    await r.backfill();
    await expect(desktopControl(r.c, r.task.id, exitNotice)).rejects.toThrow();
    await expect(
      desktopControl(r.c, r.task.id, exitNotice, randomUUID()),
    ).rejects.toThrow();
    const exited = await desktopControl(r.c, r.task.id, exitNotice, r.deviceId);
    expect(exited).toMatchObject({
      status: "NEEDS_USER",
      fileCopyProgress: "awaiting_verification",
      step: 9,
      stage: "操作已中止，请核对窗口。",
    });
    expect((await r.poll()).task?.fileCopyVerification).toEqual({
      commandId: r.commandId,
      authorizationId: r.authorizationId,
    });
    expect(await r.verify("ok")).toMatchObject({
      status: "DONE",
      step: 9,
      confirmedSteps: 8,
    });
  });
  it("keeps explicit pause effective across exit and resumes only read-only verification on an upgraded client", async () => {
    const r = await oldUncertainCopy();
    await r.backfill();
    const paused = await desktopControl(
      r.c,
      r.task.id,
      { ...exitNotice, note: "你已暂停操作" },
      r.deviceId,
    );
    expect(paused).toMatchObject({ status: "PAUSED", stage: "你已暂停操作" });
    expect(
      (await desktopControl(r.c, r.task.id, exitNotice, r.deviceId)).stage,
    ).toBe("你已暂停操作");
    await expect(
      desktopControl(r.c, r.task.id, { action: "resume" }),
    ).rejects.toMatchObject({
      response: { error: { code: "FILE_COPY_VERIFICATION_REQUIRED" } },
    });
    expect((await r.poll()).task?.fileCopyVerification).toBeUndefined();
    await expect(r.verify("ok")).rejects.toThrow();
    expect(
      await desktopControl(r.c, r.task.id, { action: "resume" }),
    ).toMatchObject({
      status: "NEEDS_USER",
      fileCopyProgress: "awaiting_verification",
      step: 9,
    });
    expect((await r.poll()).task?.fileCopyVerification?.commandId).toBe(
      r.commandId,
    );
    expect(await r.verify("ok")).toMatchObject({
      status: "DONE",
      step: 9,
      confirmedSteps: 8,
    });
  });
  it.each(["pause", "stop", "revoke"])(
    "keeps a concurrent %s ahead of a read-only resume",
    async (action) => {
      const r = await oldUncertainCopy();
      await r.backfill();
      await r.poll();
      await desktopControl(r.c, r.task.id, { action: "pause" });
      fixture.beforeControlUpdate = async () => {
        if (action === "revoke")
          await setDesktopAuthorization(r.c, r.deviceId, false);
        else await desktopControl(r.c, r.task.id, { action });
      };
      await expect(
        desktopControl(r.c, r.task.id, { action: "resume" }),
      ).rejects.toThrow();
      if (action === "revoke") {
        await setDesktopAuthorization(r.c, r.deviceId, true);
        await expect(
          desktopControl(r.c, r.task.id, { action: "resume" }),
        ).rejects.toThrow();
      }
      const task = (await r.poll()).task;
      expect(task?.fileCopyVerification).toBeUndefined();
      expect(task?.status ?? "CANCELED").toBe(
        action === "stop" ? "CANCELED" : "PAUSED",
      );
      await expect(r.verify("ok")).rejects.toThrow();
    },
  );
  it("refuses read-only resume from an expired original connection", async () => {
    const r = await oldUncertainCopy();
    await r.backfill();
    await r.poll();
    await desktopControl(r.c, r.task.id, { action: "pause" });
    await fixture.db!.query(
      "UPDATE assistant_desktop_devices SET expires_at=now()-interval '1 second' WHERE id=$1",
      [r.deviceId],
    );
    await expect(
      desktopControl(r.c, r.task.id, { action: "resume" }),
    ).rejects.toThrow();
    await expect(r.verify("ok")).rejects.toThrow();
    expect((await r.poll()).task).toBeNull();
  });
  it("lets a user stop while an unqualified client exit is overtaken by migration", async () => {
    const r = await oldUncertainCopy();
    fixture.beforeControlUpdate = async () => {
      await r.backfill();
      await desktopControl(r.c, r.task.id, { action: "stop" });
    };
    expect(
      (await desktopControl(r.c, r.task.id, exitNotice, r.deviceId)).status,
    ).toBe("CANCELED");
    expect((await r.poll()).task).toBeNull();
  });
  it("applies a normal exit pause to ordinary work but preserves a concurrently recorded verification", async () => {
    const { d, t } = await allowed();
    expect(
      (await desktopControl(actor(), t.id, exitNotice, d.deviceId)).status,
    ).toBe("PAUSED");
    const r = await oldUncertainCopy();
    fixture.beforeControlUpdate = async () => {
      await r.backfill();
    };
    expect(
      (await desktopControl(r.c, r.task.id, exitNotice, r.deviceId)).status,
    ).toBe("NEEDS_USER");
    expect((await r.poll()).task?.fileCopyVerification?.commandId).toBe(
      r.commandId,
    );
  });
  it.each(["stop", "pause", "revoke"])(
    "never revives a %s against a delayed verification",
    async (action) => {
      const r = await oldUncertainCopy();
      await r.backfill();
      await r.poll();
      if (action === "revoke")
        await setDesktopAuthorization(r.c, r.deviceId, false);
      else await desktopControl(r.c, r.task.id, { action });
      await expect(r.verify("blocked")).rejects.toThrow();
      await expect(r.verify("ok")).rejects.toThrow();
      expect((await r.poll()).task?.fileCopyVerification).toBeUndefined();
    },
  );
  it("requeues only the original proven unsent paste once and claims it in background", async () => {
    const r = await oldUncertainCopy();
    await r.backfill();
    await r.poll();
    const retry = await r.verify("blocked");
    expect(retry).toMatchObject({
      id: r.task.id,
      status: "WAITING",
      fileCopyMode: "background",
      fileCopyProgress: "retrying",
      step: 9,
      confirmedSteps: 7,
    });
    expect(retry.recentSteps?.at(-1)?.result).toBe("blocked");
    expect((await r.verify("blocked")).status).toBe("WAITING");
    expect(
      (
        await pollDesktop(r.c, r.deviceId, false, {
          fileCopyShortcuts: true,
          desktopFolderCopy: true,
        })
      ).task,
    ).toBeNull();
    await r.poll();
    const attemptId = randomUUID();
    const bg = (action: string, extra = {}) =>
      controlBackgroundCopy(r.c, r.deviceId, r.task.id, {
        action,
        attemptId,
        authorizationId: r.authorizationId,
        ...extra,
      });
    await expect(bg("permit")).rejects.toThrow();
    await bg("start");
    await expect(bg("complete")).rejects.toThrow();
    await bg("permit");
    await expect(bg("permit")).rejects.toThrow();
    await expect(bg("complete", { attemptId: randomUUID() })).rejects.toThrow();
    expect((await r.poll()).task?.backgroundCopyAttempt).toEqual({
      attemptId,
      permitted: true,
    });
    expect((await bg("check")).status).toBe("RUNNING");
    expect(await bg("complete")).toMatchObject({
      status: "DONE",
      step: 10,
      confirmedSteps: 8,
    });
    expect((await bg("complete")).recentSteps?.at(-1)?.action).toBe(
      "file_copy",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps an inconclusive check stopped and preserves the reason on repeated reports", async () => {
    const r = await oldUncertainCopy();
    await r.backfill();
    await r.poll();
    expect(await r.verify("uncertain")).toMatchObject({
      status: "NEEDS_USER",
      step: 9,
      confirmedSteps: 7,
      stage: "本机已核对",
    });
    expect((await r.poll()).task?.fileCopyVerification).toBeUndefined();
    await expect(r.verify("blocked")).rejects.toThrow();
    expect((await r.verify("uncertain")).step).toBe(9);
  });
  it("can stop the same task while a definitive never-sent result is being committed", async () => {
    const r = await oldUncertainCopy();
    await r.backfill();
    await r.poll();
    fixture.beforeControlUpdate = async () => {
      expect((await r.verify("blocked")).status).toBe("WAITING");
    };
    expect(
      (await desktopControl(r.c, r.task.id, { action: "stop" })).status,
    ).toBe("CANCELED");
    expect((await r.poll()).task).toBeNull();
  });
  it.each(["pause", "different grant", "wrong history"])(
    "skips legacy backfill with %s",
    async (cause) => {
      const r = await oldUncertainCopy();
      if (cause === "pause")
        await desktopControl(r.c, r.task.id, { action: "pause" });
      if (cause === "different grant")
        await fixture.db!.query(
          "UPDATE assistant_desktop_tasks SET authorization_id=$2 WHERE id=$1",
          [r.task.id, randomUUID()],
        );
      if (cause === "wrong history")
        await fixture.db!.query(
          "UPDATE assistant_desktop_tasks SET history=history-1 WHERE id=$1",
          [r.task.id],
        );
      await r.backfill();
      expect((await r.poll()).task?.fileCopyVerification).toBeUndefined();
      await expect(r.verify("ok")).rejects.toThrow();
    },
  );
  it.each([true, false])(
    "reconciles a newly uncertain receipt only with its original paste permit (%s)",
    async (permitted) => {
      const r = await oldUncertainCopy();
      const pending = {
        id: r.commandId,
        action: {
          kind: "key",
          key: "PASTE",
          description: "向目标目录粘贴并核验文件",
        },
      };
      await fixture.db!.query(
        `UPDATE assistant_desktop_tasks SET status='RUNNING',history=history-2,step=8,
      pending=$2,last_ack=NULL,file_copy_phase=$3 WHERE id=$1`,
        [
          r.task.id,
          JSON.stringify(pending),
          permitted ? "paste_permitted" : "at_target",
        ],
      );
      await acknowledgeDesktop(r.c, r.deviceId, r.task.id, {
        commandId: r.commandId,
        outcome: "uncertain",
        note: "正在等待核验",
      });
      expect(!!(await r.poll()).task?.fileCopyVerification).toBe(permitted);
      if (permitted)
        expect(await r.verify("ok")).toMatchObject({
          status: "DONE",
          step: 9,
          confirmedSteps: 8,
        });
      else await expect(r.verify("ok")).rejects.toThrow();
    },
  );
  it("fences a still-running paste before considering a never-sent confirmation", async () => {
    const r = await oldUncertainCopy();
    const pending = {
      id: r.commandId,
      action: {
        kind: "key",
        key: "PASTE",
        description: "向目标目录粘贴并核验文件",
      },
    };
    await fixture.db!.query(
      `UPDATE assistant_desktop_tasks SET status='RUNNING',history=history-2,step=8,
      pending=$2,last_ack=NULL,file_copy_phase='paste_permitted' WHERE id=$1`,
      [r.task.id, JSON.stringify(pending)],
    );
    expect((await r.poll()).task?.fileCopyVerification?.commandId).toBe(
      r.commandId,
    );
    expect(await r.verify("blocked")).toMatchObject({
      status: "NEEDS_USER",
      fileCopyProgress: "awaiting_verification",
    });
    expect(
      await permitDesktop(r.c, r.deviceId, r.task.id, {
        commandId: r.commandId,
        fileShortcut: "paste",
      }),
    ).toEqual({ allowed: false });
    expect((await r.poll()).task?.fileCopyVerification?.commandId).toBe(
      r.commandId,
    );
    expect((await r.verify("blocked")).status).toBe("WAITING");
  });
  it("defaults to background on a capable Windows receiver, keeps explicit keys and rejects background downgrades", async () => {
    const c = actor(),
      { deviceId } = await paired();
    const { authorizationId } = await setDesktopAuthorization(
      c,
      deviceId,
      true,
    );
    const standalone = String.raw`把「D:\样品\说明.txt」复制到「D:\归档」`;
    const create = (instruction: string) =>
      queueDesktopTask(c, { deviceId, requestId: randomUUID(), instruction });
    await pollDesktop(c, deviceId, false, { fileCopyShortcuts: true });
    await expect(create("在后台" + standalone)).rejects.toMatchObject({
      response: { error: { code: "BACKGROUND_COPY_UNAVAILABLE" } },
    });
    await pollDesktop(c, deviceId, false, newCapabilities);
    for (const text of [
      "在我的电脑上后台点击记事本",
      String.raw`在后台复制 D:\样品\说明.txt`,
    ])
      await expect(create(text)).rejects.toMatchObject({
        response: { error: { code: "BACKGROUND_COPY_UNAVAILABLE" } },
      });
    const keys = await create("用 Ctrl+C、Ctrl+V " + standalone);
    expect(keys.fileCopyMode).toBeUndefined();
    await desktopControl(c, keys.id, { action: "stop" });
    const task = await create(standalone);
    expect(task.fileCopyMode).toBe("background");
    const attemptId = randomUUID();
    const bg = (action: string) =>
      controlBackgroundCopy(c, deviceId, task.id, {
        action,
        attemptId,
        authorizationId,
      });
    await expect(bg("start")).rejects.toThrow();
    await pollDesktop(c, deviceId, false, newCapabilities);
    await bg("start");
    await bg("permit");
    await desktopControl(c, task.id, { action: "pause" });
    await expect(bg("check")).rejects.toThrow();
    await expect(bg("complete")).rejects.toThrow();
    await desktopControl(c, task.id, { action: "resume" });
    await pollDesktop(c, deviceId, false, newCapabilities);
    await expect(bg("start")).rejects.toThrow();
  });
  it("yields only the unpermitted command from the matching foreground observation and replans from a fresh frame", async () => {
    const { d, t } = await allowed();
    const original = await shot();
    const { command } = await planDesktop(actor(), d.deviceId, t.id, original);
    const body = { commandId: command!.id, requestId: original.requestId };
    const release = (value = body, device = d.deviceId, c = actor()) => yieldDesktopObservation(c, device, t.id, value);
    await expect(release({ ...body, requestId: randomUUID() })).rejects.toThrow();
    await expect(release(body, randomUUID())).rejects.toThrow();
    await expect(release(body, d.deviceId, actor("8"))).rejects.toThrow();
    await expect(release()).resolves.toEqual({ yielded: true });
    expect((await fixture.db!.query("SELECT status,step,history,pending FROM assistant_desktop_tasks WHERE id=$1", [t.id])).rows)
      .toEqual([{ status: "RUNNING", step: 0, history: [], pending: null }]);
    expect(await permitDesktop(actor(), d.deviceId, t.id, { commandId: body.commandId })).toEqual({ allowed: false });
    const latest = await shot();
    const fresh = await planDesktop(actor(), d.deviceId, t.id, latest);
    expect(fresh.command?.id).not.toBe(body.commandId);
    await expect(release()).rejects.toThrow();
    expect(await permitDesktop(actor(), d.deviceId, t.id, { commandId: fresh.command!.id })).toEqual({ allowed: true });
    await expect(release({ commandId: fresh.command!.id, requestId: latest.requestId })).rejects.toThrow();
  });

  it("cannot yield historical commands without permit evidence or supersede pause, stop and device revocation", async () => {
    const { d, t } = await allowed(), frame = await shot();
    const { command } = await planDesktop(actor(), d.deviceId, t.id, frame);
    const body = { requestId: frame.requestId, commandId: command!.id };
    const release = () => yieldDesktopObservation(actor(), d.deviceId, t.id, body);
    await fixture.db!.query("UPDATE assistant_desktop_tasks SET pending=pending-'permitIssued' WHERE id=$1", [t.id]);
    await expect(release()).rejects.toThrow();
    await fixture.db!.query("UPDATE assistant_desktop_tasks SET pending=pending || '{\"permitIssued\":false}',native_action='focus_notepad' WHERE id=$1", [t.id]);
    await expect(release()).rejects.toThrow();
    await fixture.db!.query("UPDATE assistant_desktop_tasks SET native_action=NULL,file_copy_flow=true WHERE id=$1", [t.id]);
    await expect(release()).rejects.toThrow();
    await fixture.db!.query("UPDATE assistant_desktop_tasks SET file_copy_flow=false,authorization_id=$2::uuid WHERE id=$1", [t.id, randomUUID()]);
    await expect(release()).rejects.toThrow();
    await fixture.db!.query("UPDATE assistant_desktop_tasks SET authorization_id=NULL WHERE id=$1", [t.id]);
    await desktopControl(actor(), t.id, { action: "pause" });
    await expect(release()).rejects.toThrow();
    await desktopControl(actor(), t.id, { action: "stop" });
    await expect(release()).rejects.toThrow();
    expect((await desktopState(actor())).tasks[0]).toMatchObject({ status: "CANCELED", step: 0 });
  });

  it("cannot both issue a permit and discard the same observation concurrently", async () => {
    const { d, t } = await allowed(), frame = await shot();
    const { command } = await planDesktop(actor(), d.deviceId, t.id, frame);
    const commandId = command!.id;
    const [issued, yielded] = await Promise.allSettled([
      permitDesktop(actor(), d.deviceId, t.id, { commandId }),
      yieldDesktopObservation(actor(), d.deviceId, t.id, { commandId, requestId: frame.requestId }),
    ]);
    expect(issued.status).toBe("fulfilled");
    expect(issued.status === "fulfilled" && issued.value.allowed).toBe(yielded.status === "rejected");
  });
  it("dispatches Finder from chat with one-use permissions and verified native receipts", async () => {
    const p = await createDesktopPair(actor(), "owner-session");
    const { deviceId } = await pairDesktop({ code: p.code, name: "测试 Mac", platform: "macos" });
    const c = actor();
    const { authorizationId } = await setDesktopAuthorization(c, deviceId, true);
    const request = { deviceId, requestId: randomUUID(), instruction: "将 ~/Desktop/样品 下的文件复制到 ~/Desktop/归档" };
    const capabilities = { platform: "macos" as const, fileCopyShortcuts: true };
    await pollDesktop(c, deviceId, false, { statusOnly: true });
    await expect(queueDesktopTask(c, request)).rejects.toThrow();
    await pollDesktop(c, deviceId, false, capabilities);
    await expect(queueDesktopTask(c, { ...request, instruction: "在本机打开终端" })).rejects.toThrow();
    await expect(queueDesktopTask(c, { ...request, localBrowser: true })).rejects.toThrow();
    const task = await queueDesktopTask(c, request);
    expect(task.nativeAction).toBe("copy_finder_files");
    expect((await queueDesktopTask(c, request)).id).toBe(task.id);
    expect((await desktopState(c)).devices[0].platform).toBe("macos");
    expect((await pollDesktop(c, deviceId, true, { nativeActions: true })).task).toBeNull();
    let attemptId = randomUUID();
    const act = (action: string) => controlMacFileCopy(c, deviceId, task.id, { action, attemptId, authorizationId });
    await expect(act("start")).rejects.toThrow();
    const work = await pollDesktop(c, deviceId, false, capabilities);
    expect(work.task?.fileCopy).toEqual({ source: "~/Desktop/样品", destination: "~/Desktop/归档", selection: "files" });
    await act("start");
    await expect(act("permit_paste")).rejects.toThrow();
    await expect(controlMacFileCopy(c, deviceId, task.id, { action: "permit_copy", attemptId, authorizationId: randomUUID() })).rejects.toThrow();
    await act("permit_copy");
    await expect(act("permit_copy")).rejects.toThrow();
    await act("copied");
    await act("permit_paste");
    await expect(act("permit_paste")).rejects.toThrow();
    await desktopControl(c, task.id, { action: "pause" });
    await expect(act("complete")).rejects.toThrow();
    await desktopControl(c, task.id, { action: "resume" });
    await pollDesktop(c, deviceId, false, capabilities);
    await expect(act("start")).rejects.toThrow();
    attemptId = randomUUID();
    await act("start");
    await expect(act("permit_paste")).rejects.toThrow();
    await act("permit_copy");
    await act("copied");
    await act("permit_paste");
    expect(await act("complete")).toMatchObject({ status: "DONE", step: 3, confirmedSteps: 3 });
    await expect(act("complete")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["COPY", "PASTE"])("rejects an unverified shortcut %s from the visual model", async key => {
    const { d, t } = await allowed();
    vi.mocked(fetch).mockResolvedValueOnce(model({ kind: "key", key, description: "执行快捷键" }));
    await expect(planDesktop(actor(), d.deviceId, t.id, await shot())).rejects.toThrow();
    expect((await desktopState(actor())).tasks[0]).toMatchObject({ status: "PAUSED", confirmedSteps: 0 });
  });

  it.each([false, true])("dispatches Windows copy, target switch and paste with consumed permits and no model (new desktop folder %s)", async compound => {
    const { deviceId } = await paired();
    const c = actor();
    const { authorizationId } = await setDesktopAuthorization(c, deviceId, true);
    const request = { deviceId, requestId: randomUUID(), instruction: compound
      ? String.raw`在我的电脑新建文件夹"自动化112601"，并将路径D:\Desktop\AI0520下的内容复制进来`
      : String.raw`将路径D:\Desktop\AI0520下的文件复制到D:\Desktop\自动化666\新建文件夹` };
    await expect(queueDesktopTask(c, request)).rejects.toThrow();
    const poll = (desktopFolderCopy = compound) => pollDesktop(c, deviceId, false, { fileCopyShortcuts: true, desktopFolderCopy });
    if (compound) {
      await poll(false);
      await expect(queueDesktopTask(c, request)).rejects.toMatchObject({ response: { error: { code: "DESKTOP_FOLDER_COPY_UPDATE" } } });
    }
    await poll();
    await expect(queueDesktopTask(c, { ...request, instruction: "copy ~/Desktop/a.txt to ~/Desktop/b" })).rejects.toThrow();
    await expect(queueDesktopTask(c, { ...request, instruction: request.instruction + "，然后打开终端" })).rejects.toThrow();
    const t = await queueDesktopTask(c, request);
    // Downgraded clients cannot claim this task.
    expect((await pollDesktop(c, deviceId, true, { nativeActions: true })).task).toBeNull();
    if (compound) {
      expect((await poll(false)).task).toBeNull();
      await desktopControl(c, t.id, { action: "pause" });
      await expect(desktopControl(c, t.id, { action: "resume" })).rejects.toMatchObject({ response: { error: { code: "DESKTOP_FOLDER_COPY_UPDATE" } } });
      await poll();
      await desktopControl(c, t.id, { action: "resume" });
    }
    const source = { id: randomUUID(), title: "AI0520", application: "explorer" };
    const target = { id: randomUUID(), title: "新建文件夹", application: "explorer" };
    if (compound) {
      await expect(desktopControl(c, t.id, { action: "allow", authorizationId, application: source.application, windowId: source.id, window: source.title }, deviceId)).rejects.toThrow();
      expect((await poll()).task?.fileCopy).toMatchObject({ selection: "contents", destination: "自动化112601", destinationKind: "newDesktopFolder" });
    } else {
      expect((await poll()).task?.fileCopy?.selection).toBe("files");
    }
    await desktopControl(c, t.id, { action: "allow", authorizationId, application: source.application, windowId: source.id, window: source.title }, deviceId);
    const plan = (w: typeof source, fileShortcut?: string) => planDesktop(c, deviceId, t.id, {
      fileCopy: true, requestId: randomUUID(), windowId: w.id, window: w.title, application: w.application,
      windows: [source, target], fileShortcut,
    });
    const permit = (commandId: string, fileShortcut?: string) => permitDesktop(c, deviceId, t.id, { commandId, fileShortcut });
    const ack = (commandId: string) => acknowledgeDesktop(c, deviceId, t.id, { commandId, outcome: "ok", note: "本机已核验" });
    const copy = (await plan(source, "copy")).command!;
    expect(copy.action.key).toBe("COPY");
    if (compound) {
      expect((await poll(false)).task).toBeNull();
      expect((await permit(copy.id, "copy")).allowed).toBe(false);
      await poll();
    }
    expect((await permit(copy.id)).allowed).toBe(false);
    await expect(ack(copy.id)).rejects.toThrow();
    expect((await permit(copy.id, "copy")).allowed).toBe(true);
    expect((await permit(copy.id, "copy")).allowed).toBe(false);
    await ack(copy.id);
    const move = (await plan(source)).command!;
    expect(move.action.windowId).toBe(target.id);
    expect((await permit(move.id)).allowed).toBe(true);
    await ack(move.id);
    const paste = (await plan(target, "paste")).command!;
    expect(paste.action.key).toBe("PASTE");
    expect((await permit(paste.id, "copy")).allowed).toBe(false);
    expect((await permit(paste.id, "paste")).allowed).toBe(true);
    expect(await ack(paste.id)).toMatchObject({ status: "DONE", confirmedSteps: 3 });
    expect((await permit(paste.id, "paste")).allowed).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  const desktopFolders =
    "在我的电脑桌面新建文件夹命名“自动化测试1126”，并在文件夹内新建两个子文件夹和1个记事本，在记事本内写入“自动化测试666”";

  it("offers Explorer only on a compatible authorized execution poll and the user's continuation", async () => {
    const d = await paired();
    const task = await queueDesktopTask(actor(), {
      deviceId: d.deviceId,
      requestId: randomUUID(),
      instruction: desktopFolders,
    });
    const poll = (enabled: boolean) =>
      pollDesktop(actor(), d.deviceId, true, { desktopExplorer: enabled });
    expect((await poll(true)).task?.startLocation).toBeUndefined();
    await setDesktopAuthorization(actor(), d.deviceId, true);
    expect((await poll(false)).task?.startLocation).toBeUndefined();
    expect((await poll(true)).task).toMatchObject({
      id: task.id,
      startLocation: "desktopExplorer",
      status: "WAITING",
    });
    expect(
      (await desktopState(actor())).tasks[0].startLocation,
    ).toBeUndefined();
    await desktopControl(actor(), task.id, { action: "pause" });
    expect((await poll(true)).task).toMatchObject({
      startLocation: "desktopExplorer",
      status: "PAUSED",
    });
    await desktopControl(actor(), task.id, { action: "resume" });
    expect((await poll(true)).task).toMatchObject({
      id: task.id,
      startLocation: "desktopExplorer",
      status: "WAITING",
    });
    await fixture.db!.query(
      "UPDATE assistant_desktop_tasks SET status='NEEDS_USER',browser_only=true WHERE id=$1",
      [task.id],
    );
    expect((await poll(true)).task?.startLocation).toBeUndefined();
    await fixture.db!.query(
      "UPDATE assistant_desktop_tasks SET browser_only=false,previous_task_id=id WHERE id=$1",
      [task.id],
    );
    const bound = await pollDesktop(actor(), d.deviceId, true, {
      desktopExplorer: true,
      windowContinuations: true,
      retainedTaskId: task.id,
    });
    expect(bound.task?.id).toBe(task.id);
    expect(bound.task?.startLocation).toBeUndefined();
  });

  it.each([
    {
      instruction: desktopFolders,
      app: "explorer",
      observed: true,
      grant: true,
      allowed: true,
    },
    {
      instruction: desktopFolders,
      app: "explorer",
      observed: false,
      grant: true,
      allowed: false,
    },
    {
      instruction: "在桌面新建一个文本文档",
      app: "explorer",
      observed: true,
      grant: true,
      allowed: false,
    },
    {
      instruction: desktopFolders,
      app: "notepad",
      observed: true,
      grant: true,
      allowed: false,
    },
    {
      instruction: desktopFolders,
      app: "explorer",
      observed: true,
      grant: false,
      allowed: false,
    },
  ])(
    "gates the new-folder key on the actual Explorer observation: $app / $observed / $grant / $allowed",
    async ({ instruction, app, observed, grant, allowed }) => {
      const d = await paired(),
        windowId = randomUUID(),
        window = "桌面";
      const task = await queueDesktopTask(actor(), {
        deviceId: d.deviceId,
        requestId: randomUUID(),
        instruction,
      });
      const auth = grant
        ? await setDesktopAuthorization(actor(), d.deviceId, true)
        : {};
      await desktopControl(
        actor(),
        task.id,
        { action: "allow", window, application: app, windowId, ...auth },
        d.deviceId,
      );
      vi.mocked(fetch).mockResolvedValueOnce(
        model({ kind: "key", key: "CTRL_SHIFT_N", description: "新建文件夹" }),
      );
      const plan = planDesktop(actor(), d.deviceId, task.id, {
        ...(await shot()),
        window,
        application: app,
        windowId,
        ...(grant
          ? { windows: [{ id: windowId, title: window, application: app }] }
          : {}),
        ...(observed ? { desktopExplorer: true } : {}),
      });
      if (!allowed) {
        await expect(plan).rejects.toMatchObject({
          response: { error: { code: "FORBIDDEN" } },
        });
        return;
      }
      const result = await plan;
      expect(result.command?.action).toMatchObject({
        kind: "key",
        key: "CTRL_SHIFT_N",
      });
      expect(
        await permitDesktop(actor(), d.deviceId, task.id, {
          commandId: result.command!.id,
        }),
      ).toEqual({ allowed: true });
      const payload = JSON.parse(
        String(vi.mocked(fetch).mock.calls[0][1]?.body),
      );
      expect(payload.messages[0].content).toContain("画面可核验");
    },
  );

  it("exposes fixed receipt fields, counts confirmed inputs and avoids reconstructing truncated history", () => {
    const task = {
      id: randomUUID(),
      device_id: randomUUID(),
      created_at: Date.now(),
      updated_at: Date.now(),
      status: "NEEDS_USER",
      stage: "",
      step: 3,
      history: [
        {
          step: 1,
          action: "click",
          result: "ok",
          description: "私人文件名",
          path: "未公开路径",
        },
        { step: 2, action: "type", result: "uncertain", text: "隐藏内容" },
        { step: 3, action: "scroll", result: "blocked" },
      ],
    };
    const view = desktopTaskView(task);
    expect(view.confirmedSteps).toBe(1);
    expect(view.recentSteps).toEqual([
      { step: 1, action: "click", result: "ok" },
      { step: 2, action: "type", result: "uncertain" },
      { step: 3, action: "scroll", result: "blocked" },
    ]);
    expect(
      desktopTaskView({ ...task, history: task.history.slice(1) })
        .confirmedSteps,
    ).toBeUndefined();
    expect(
      desktopTaskView({
        ...task,
        step: 15,
        history: [
          { step: 15, action: "key", result: "uncertain", confirmedTotal: 10 },
        ],
      }).confirmedSteps,
    ).toBe(10);
    expect(
      desktopTaskView({
        ...task,
        history: [{ step: 3, action: "私人动作", result: "ok" }],
      }).recentSteps,
    ).toBeUndefined();
  });
  it("distinguishes device authorization and status-only checks from an actual receiving engine", async () => {
    const d = await paired();
    const grant = await setDesktopAuthorization(actor(), d.deviceId, true);
    const request = {
      deviceId: d.deviceId,
      requestId: randomUUID(),
      instruction: "整理记事本里的段落",
    };
    await pollDesktop(actor(), d.deviceId, false, { statusOnly: true });
    await desktopIdentity("Bearer " + d.token, undefined);
    await pollDesktop(actor(), d.deviceId);
    expect((await desktopState(actor())).devices[0]).toMatchObject({
      online: true,
      crossWindowAuthorized: true,
      engineReady: false,
    });
    await expect(queueDesktopTask(actor(), request)).rejects.toMatchObject({
      response: { error: { code: "DEVICE_ENGINE_UNAVAILABLE" } },
    });
    await pollDesktop(actor(), d.deviceId, true);
    const t = await queueDesktopTask(actor(), request);
    expect(
      await pollDesktop(actor(), d.deviceId, false, { statusOnly: true }),
    ).toEqual({ task: null, authorizationId: grant.authorizationId });
    await fixture.db!.query(
      "UPDATE assistant_desktop_tasks SET updated_at=now()-interval '40 seconds' WHERE id=$1",
      [t.id],
    );
    expect((await pollDesktop(actor(), d.deviceId, true)).task?.status).toBe(
      "NEEDS_USER",
    );
    await desktopControl(actor(), t.id, { action: "resume" });
    expect((await pollDesktop(actor(), d.deviceId, true)).task?.status).toBe(
      "WAITING",
    );
    await fixture.db!.query(
      "UPDATE assistant_desktop_tasks SET updated_at=now()-interval '40 seconds' WHERE id=$1",
      [t.id],
    );
    expect((await desktopState(actor())).tasks[0].status).toBe("WAITING");
    await fixture.db!.query(
      "UPDATE assistant_desktop_devices SET engine_seen_at=now()-interval '40 seconds' WHERE id=$1",
      [d.deviceId],
    );
    await fixture.db!.query(
      "UPDATE assistant_desktop_tasks SET delivered_at=now()-interval '40 seconds' WHERE id=$1",
      [t.id],
    );
    expect((await pollDesktop(actor(), d.deviceId, true)).task?.status).toBe(
      "NEEDS_USER",
    );
  });
  it("keeps an ambiguous older client available for manual pickup and expires an unreceived task", async () => {
    const d = await paired();
    await pollDesktop(actor(), d.deviceId);
    expect(
      (await desktopState(actor())).devices[0].engineReady,
    ).toBeUndefined();
    const task = await queueDesktopTask(actor(), {
      deviceId: d.deviceId,
      requestId: randomUUID(),
      instruction: "在我的电脑上打开记事本",
    });
    expect((await pollDesktop(actor(), d.deviceId)).task?.id).toBe(task.id);
    await fixture.db!.query(
      "UPDATE assistant_desktop_tasks SET updated_at=now()-interval '40 seconds' WHERE id=$1",
      [task.id],
    );
    expect((await desktopState(actor())).tasks[0].status).toBe("NEEDS_USER");
  });
  it("binds exact Notepad requests to the receiving device, live grant and native attempt", async () => {
    const d = await paired();
    const other = await paired();
    const grant = await setDesktopAuthorization(actor(), d.deviceId, true);
    await pollDesktop(actor(), d.deviceId, true, { nativeActions: true });
    const request = {
      deviceId: d.deviceId,
      requestId: randomUUID(),
      instruction: "在我的电脑上切换到已打开的记事本窗口",
    };
    const task = await queueDesktopTask(actor(), request);
    expect(task).toMatchObject({
      nativeAction: "focus_notepad",
      scope: "device",
      status: "WAITING",
    });
    expect((await pollDesktop(actor(), d.deviceId)).task).toBeNull();
    const start = {
      action: "start_native",
      authorizationId: grant.authorizationId,
      attemptId: randomUUID(),
    };
    const done = {
      ...start,
      action: "complete_native",
      window: "无标题 - 记事本",
      windowId: randomUUID(),
      application: "notepad",
    };
    const ctl = (body: unknown, deviceId?: string) =>
      desktopControl(actor(), task.id, body, deviceId);
    await expect(ctl(start, d.deviceId)).rejects.toThrow();
    expect(
      (await pollDesktop(actor(), d.deviceId, true, { nativeActions: true }))
        .task?.id,
    ).toBe(task.id);
    await expect(ctl(start)).rejects.toThrow();
    await expect(ctl(start, other.deviceId)).rejects.toThrow();
    await expect(
      ctl({ ...start, authorizationId: randomUUID() }, d.deviceId),
    ).rejects.toThrow();
    expect((await ctl(start, d.deviceId)).status).toBe("RUNNING");
    await expect(ctl(start, d.deviceId)).rejects.toThrow();
    await expect(
      ctl({ ...done, application: "other" }, d.deviceId),
    ).rejects.toThrow();
    await ctl({ action: "pause" });
    await expect(ctl(done, d.deviceId)).rejects.toThrow();
    await ctl({ action: "resume" });
    await pollDesktop(actor(), d.deviceId, true, { nativeActions: true });
    const secondAttempt = randomUUID();
    await ctl({ ...start, attemptId: secondAttempt }, d.deviceId);
    await expect(ctl(done, d.deviceId)).rejects.toThrow();
    expect(
      (
        await ctl(
          {
            action: "handoff",
            startupFailure: true,
            attemptId: start.attemptId,
            note: "迟到的结果",
          },
          d.deviceId,
        )
      ).status,
    ).toBe("RUNNING");
    expect(
      await ctl({ ...done, attemptId: secondAttempt }, d.deviceId),
    ).toMatchObject({ status: "DONE", step: 1, window: done.window });
    expect((await queueDesktopTask(actor(), request)).id).toBe(task.id);
    const open = await queueDesktopTask(actor(), {
      ...request,
      requestId: randomUUID(),
      instruction: "打开记事本",
    });
    expect(open.nativeAction).toBe("open_notepad");
    await pollDesktop(actor(), d.deviceId, true, { nativeActions: true });
    await setDesktopAuthorization(actor(), d.deviceId, false);
    await expect(
      desktopControl(actor(), open.id, start, d.deviceId),
    ).rejects.toThrow();
    await desktopControl(actor(), open.id, { action: "stop" });
    await setDesktopAuthorization(actor(), d.deviceId, true);
    const composite = await queueDesktopTask(actor(), {
      ...request,
      requestId: randomUUID(),
      instruction: "打开记事本，然后输入你好",
    });
    expect(composite.nativeAction).toBeUndefined();
    await expect(
      desktopControl(actor(), composite.id, start, d.deviceId),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires a live receipt for the original Notepad, never substitutes another window, and retries idempotently", async () => {
    const { deviceId } = await paired();
    const { authorizationId } = await setDesktopAuthorization(
      actor(),
      deviceId,
      true,
    );
    const client = { nativeActions: true, windowContinuations: true };
    await pollDesktop(actor(), deviceId, true, client);
    const source = await queueDesktopTask(actor(), {
      deviceId,
      requestId: randomUUID(),
      instruction: "麻烦把我的电脑上的记事本调到前台",
    });
    const ctl = (id: string, body: unknown) =>
      desktopControl(actor(), id, body, deviceId);
    const windowId = randomUUID();
    const start = {
      action: "start_native",
      authorizationId,
      attemptId: randomUUID(),
    };
    const done = {
      ...start,
      action: "complete_native",
      application: "notepad",
      window: "无标题 - 记事本",
      windowId,
      retainedWindow: true,
    };
    await pollDesktop(actor(), deviceId, true, client);
    await ctl(source.id, start);
    await ctl(source.id, done);
    expect((await desktopState(actor())).tasks[0].canContinueTyping).toBe(true);
    const input = {
      deviceId,
      requestId: randomUUID(),
      instruction: "输入9999999",
    };
    const context = { previousTaskId: source.id };
    await pollDesktop(actor(), deviceId, true, { nativeActions: true });
    await expect(queueDesktopTask(actor(), input, context)).rejects.toThrow();
    await pollDesktop(actor(), deviceId, true, {
      ...client,
      retainedTaskId: source.id,
    });
    const task = await queueDesktopTask(actor(), input, context);
    expect(task).toMatchObject({
      nativeAction: "type_notepad",
      nativeText: "9999999",
      scope: "window",
      previousTaskId: source.id,
      boundWindowId: windowId,
    });
    expect(
      (await pollDesktop(actor(), deviceId, true, { nativeActions: true }))
        .task,
    ).toBeNull();
    await pollDesktop(actor(), deviceId, true, {
      ...client,
      retainedTaskId: source.id,
    });
    await ctl(task.id, start);
    await expect(
      ctl(task.id, { ...done, windowId: randomUUID() }),
    ).rejects.toThrow();
    expect(await ctl(task.id, done)).toMatchObject({
      status: "DONE",
      step: 1,
      scope: "window",
    });
    expect((await queueDesktopTask(actor(), input, context)).id).toBe(task.id);
    await expect(
      queueDesktopTask(actor(), { ...input, requestId: randomUUID() }, context),
    ).rejects.toThrow();
    const disappeared = await queueDesktopTask(
      actor(),
      { ...input, requestId: randomUUID() },
      { previousTaskId: task.id },
    );
    expect(
      (await pollDesktop(actor(), deviceId, true, client)).task,
    ).toMatchObject({ id: disappeared.id, status: "NEEDS_USER" });
    await expect(ctl(disappeared.id, start)).rejects.toThrow();
    expect(
      (await desktopState(actor())).tasks[0].canContinueTyping,
    ).toBeUndefined();
    await expect(
      queueDesktopTask(
        actor(),
        { ...input, requestId: randomUUID() },
        { previousTaskId: task.id },
      ),
    ).rejects.toThrow();
  });
  it("keeps a modeled continuation in its original window even with a saved device grant", async () => {
    const { deviceId } = await paired();
    const { authorizationId } = await setDesktopAuthorization(
      actor(),
      deviceId,
      true,
    );
    const protocol = { nativeActions: true, windowContinuations: true };
    await pollDesktop(actor(), deviceId, true, protocol);
    const source = await queueDesktopTask(actor(), {
      deviceId,
      requestId: randomUUID(),
      instruction: "核对当前笔记",
    });
    const window = {
      windowId: randomUUID(),
      window: "笔记",
      application: "notes",
    };
    const allow = { action: "allow", authorizationId, ...window };
    await desktopControl(actor(), source.id, allow, deviceId);
    await fixture.db!.query(
      "UPDATE assistant_desktop_tasks SET status='DONE' WHERE id=$1",
      [source.id],
    );
    await pollDesktop(actor(), deviceId, true, {
      ...protocol,
      retainedTaskId: source.id,
    });
    const task = await queueDesktopTask(
      actor(),
      { deviceId, requestId: randomUUID(), instruction: "输入9999999" },
      { previousTaskId: source.id },
    );
    expect(task).toMatchObject({
      scope: "window",
      boundWindowId: window.windowId,
    });
    await expect(
      desktopControl(
        actor(),
        task.id,
        { ...allow, windowId: randomUUID() },
        deviceId,
      ),
    ).rejects.toThrow();
    await expect(
      desktopControl(
        actor(),
        task.id,
        { ...allow, authorizationId: undefined },
        deviceId,
      ),
    ).rejects.toThrow();
    expect(
      await desktopControl(actor(), task.id, allow, deviceId),
    ).toMatchObject({ status: "RUNNING", scope: "window" });
    await expect(
      planDesktop(actor(), deviceId, task.id, {
        ...(await shot()),
        ...window,
        windows: [
          {
            id: window.windowId,
            title: window.window,
            application: window.application,
          },
        ],
      }),
    ).rejects.toThrow();
  });
  it("resumes the same expired legacy Notepad task through the native path only if it never started", async () => {
    const d = await paired();
    await setDesktopAuthorization(actor(), d.deviceId, true);
    await pollDesktop(actor(), d.deviceId, true);
    const request = {
      deviceId: d.deviceId,
      requestId: randomUUID(),
      instruction: "在我的电脑上切换到已打开的记事本窗口",
    };
    const task = await queueDesktopTask(actor(), request);
    expect(task.nativeAction).toBeUndefined();
    const originalModel = (
      await fixture.db!.query<Row>(
        "SELECT model_ref FROM assistant_desktop_tasks WHERE id=$1",
        [task.id],
      )
    ).rows[0].model_ref;
    expect(originalModel).toMatch(/^engine\//);
    await fixture.db!.query(
      "UPDATE assistant_desktop_tasks SET updated_at=now()-interval '1 hour' WHERE id=$1",
      [task.id],
    );
    expect(
      (await pollDesktop(actor(), d.deviceId, true, { nativeActions: true }))
        .task,
    ).toMatchObject({ id: task.id, status: "NEEDS_USER" });
    expect((await desktopState(actor())).tasks[0].nativeAction).toBeUndefined();
    expect(
      await desktopControl(actor(), task.id, { action: "resume" }),
    ).toMatchObject({
      id: task.id,
      nativeAction: "focus_notepad",
      status: "WAITING",
    });
    expect((await queueDesktopTask(actor(), request)).id).toBe(task.id);
    expect(
      (await queueDesktopTask(actor(), { ...request, model: originalModel }))
        .id,
    ).toBe(task.id);
    await expect(
      queueDesktopTask(actor(), {
        ...request,
        model: "engine/123456789012345678901234",
      }),
    ).rejects.toMatchObject({
      response: { error: { code: "REQUEST_CONFLICT" } },
    });
    await desktopControl(actor(), task.id, { action: "stop" });
    await pollDesktop(actor(), d.deviceId, true);
    const started = await queueDesktopTask(actor(), {
      ...request,
      requestId: randomUUID(),
    });
    await desktopControl(
      actor(),
      started.id,
      { action: "allow", window: "旧窗口", application: "notepad" },
      d.deviceId,
    );
    await desktopControl(actor(), started.id, { action: "pause" });
    await pollDesktop(actor(), d.deviceId, true, { nativeActions: true });
    expect(
      (await desktopControl(actor(), started.id, { action: "resume" }))
        .nativeAction,
    ).toBeUndefined();
  });
  it("keeps legacy pairing personal until the owner explicitly selects an independent environment", async () => {
    const first = await paired();
    const second = await paired();
    const initial = await desktopState(actor());
    expect(initial.preferredDedicatedDeviceId).toBeNull();
    expect(initial.devices).toHaveLength(2);
    expect(
      initial.devices.every(
        (d) => d.purpose === "personal" && !d.crossWindowAuthorized,
      ),
    ).toBe(true);
    const selected = await setDesktopPurpose(actor(), first.deviceId, {
      purpose: "dedicated",
    });
    expect(selected.preferredDedicatedDeviceId).toBe(first.deviceId);
    expect(selected.devices.find((d) => d.id === first.deviceId)).toMatchObject(
      { purpose: "dedicated", crossWindowAuthorized: false },
    );
    expect(
      selected.devices.find((d) => d.id === second.deviceId)?.purpose,
    ).toBe("personal");
    // Re-running the additive migration must preserve an explicit preference.
    await fixture.db!.exec(
      await readFile(
        "packages/database/migrations/098_desktop_device_purpose.sql",
        "utf8",
      ),
    );
    expect((await desktopState(actor())).preferredDedicatedDeviceId).toBe(
      first.deviceId,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps an explicitly selected offline environment and never substitutes the online personal computer", async () => {
    const independent = await paired();
    const personal = await paired();
    await fixture.db!.query(
      "UPDATE assistant_desktop_devices SET last_seen_at=now()-interval '1 minute' WHERE id=$1::uuid",
      [independent.deviceId],
    );
    const state = await setDesktopPurpose(actor(), independent.deviceId, {
      purpose: "dedicated",
    });
    expect(state.preferredDedicatedDeviceId).toBe(independent.deviceId);
    expect(
      state.devices.find((d) => d.id === independent.deviceId),
    ).toMatchObject({ online: false, purpose: "dedicated" });
    expect(state.devices.find((d) => d.id === personal.deviceId)).toMatchObject(
      { online: true, purpose: "personal" },
    );
    await expect(
      queueDesktopTask(actor(), {
        deviceId: state.preferredDedicatedDeviceId,
        requestId: randomUUID(),
        instruction: "整理笔记",
      }),
    ).rejects.toMatchObject({
      response: { error: { code: "DEVICE_OFFLINE" } },
    });
    expect((await desktopState(actor())).tasks).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("changes only the explicit default, preserves task ownership and never selects a replacement on removal", async () => {
    const { d: first, t } = await allowed();
    const grant = await setDesktopAuthorization(actor(), first.deviceId, true);
    const second = await paired();
    await setDesktopPurpose(actor(), first.deviceId, { purpose: "dedicated" });
    let state = await setDesktopPurpose(actor(), second.deviceId, {
      purpose: "dedicated",
    });
    expect(state.preferredDedicatedDeviceId).toBe(second.deviceId);
    expect(state.devices.every((d) => d.purpose === "dedicated")).toBe(true);
    expect(state.tasks.find((task) => task.id === t.id)).toMatchObject({
      deviceId: first.deviceId,
      status: "RUNNING",
      scope: "window",
    });
    expect((await pollDesktop(actor(), first.deviceId)).authorizationId).toBe(
      grant.authorizationId,
    );
    state = await setDesktopPurpose(actor(), second.deviceId, {
      purpose: "personal",
    });
    expect(state.preferredDedicatedDeviceId).toBeNull();
    expect(state.devices.find((d) => d.id === first.deviceId)?.purpose).toBe(
      "dedicated",
    );
    await setDesktopPurpose(actor(), second.deviceId, { purpose: "dedicated" });
    await revokeDesktop(actor(), second.deviceId);
    expect((await desktopState(actor())).preferredDedicatedDeviceId).toBeNull();
    expect(
      (await desktopState(actor())).tasks.find((task) => task.id === t.id)
        ?.status,
    ).toBe("RUNNING");
  });
  it("rejects another owner's, unpaired, expired or revoked devices without changing the existing preference", async () => {
    const selected = await paired();
    const other = await paired();
    await setDesktopPurpose(actor(), selected.deviceId, {
      purpose: "dedicated",
    });
    await expect(
      setDesktopPurpose(actor("8"), other.deviceId, { purpose: "dedicated" }),
    ).rejects.toMatchObject({ response: { error: { code: "NOT_FOUND" } } });
    expect(
      (await desktopState(actor("8"))).preferredDedicatedDeviceId,
    ).toBeNull();
    const pair = await createDesktopPair(actor(), "owner-session");
    const pending = (
      await fixture.db!.query<Row>(
        "SELECT id FROM assistant_desktop_devices WHERE pair_hash=$1",
        [hash(pair.code)],
      )
    ).rows[0];
    await expect(
      setDesktopPurpose(actor(), pending.id, { purpose: "dedicated" }),
    ).rejects.toThrow();
    await fixture.db!.query(
      "UPDATE assistant_desktop_devices SET expires_at=now()-interval '1 minute' WHERE id=$1::uuid",
      [other.deviceId],
    );
    await expect(
      setDesktopPurpose(actor(), other.deviceId, { purpose: "dedicated" }),
    ).rejects.toThrow();
    await revokeDesktop(actor(), other.deviceId);
    await expect(
      setDesktopPurpose(actor(), other.deviceId, { purpose: "personal" }),
    ).rejects.toThrow();
    await expect(
      setDesktopPurpose(actor(), selected.deviceId, {
        purpose: "dedicated",
        authorizationId: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      setDesktopPurpose(actor(), selected.deviceId, {
        purpose: "virtual_machine",
      }),
    ).rejects.toThrow();
    expect((await desktopState(actor())).preferredDedicatedDeviceId).toBe(
      selected.deviceId,
    );
    await fixture.db!.query(
      "UPDATE assistant_desktop_devices SET expires_at=now()-interval '1 minute' WHERE id=$1::uuid",
      [selected.deviceId],
    );
    expect((await desktopState(actor())).preferredDedicatedDeviceId).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
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
  it("delivers local browser tasks only to clients that advertise support and bind the browser window", async () => {
    const d = await paired();
    const request = {
      deviceId: d.deviceId,
      requestId: randomUUID(),
      instruction: "在本地浏览器中点击详情",
      localBrowser: true,
    };
    await expect(queueDesktopTask(actor(), request)).rejects.toMatchObject({
      response: { error: { code: "LOCAL_BROWSER_UNAVAILABLE" } },
    });
    await pollDesktop(actor(), d.deviceId, true);
    const task = await queueDesktopTask(actor(), request);
    expect(task).toMatchObject({
      status: "WAITING",
      localBrowser: true,
      scope: "window",
    });
    expect((await pollDesktop(actor(), d.deviceId)).task).toBeNull();
    expect((await pollDesktop(actor(), d.deviceId, true)).task?.id).toBe(
      task.id,
    );
    const windowId = randomUUID();
    const approval = {
      action: "allow",
      window: "小序本机浏览器",
      application: "XutiDesktop",
      windowId,
    };
    await expect(
      desktopControl(actor(), task.id, approval, d.deviceId),
    ).rejects.toMatchObject({
      response: { error: { code: "LOCAL_BROWSER_SCOPE" } },
    });
    const grant = await setDesktopAuthorization(actor(), d.deviceId, true);
    const started = await desktopControl(
      actor(),
      task.id,
      { ...approval, ...grant, localBrowser: true },
      d.deviceId,
    );
    expect(started).toMatchObject({
      status: "RUNNING",
      localBrowser: true,
      scope: "window",
    });
    const observation = {
      ...(await shot()),
      window: approval.window,
      application: approval.application,
      windowId,
      localBrowser: true,
    };
    const { command } = await planDesktop(
      actor(),
      d.deviceId,
      task.id,
      observation,
    );
    expect(command?.action.kind).toBe("click");
    expect(
      await permitDesktop(actor(), d.deviceId, task.id, {
        commandId: command!.id,
      }),
    ).toEqual({ allowed: true });
    await acknowledgeDesktop(actor(), d.deviceId, task.id, {
      commandId: command!.id,
      outcome: "ok",
      note: "已点击",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        model({
          kind: "switch_window",
          windowId: randomUUID(),
          description: "切换到其他窗口",
        }),
      ),
    );
    await expect(
      planDesktop(actor(), d.deviceId, task.id, {
        ...observation,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
    expect((await pollDesktop(actor(), d.deviceId, true)).task?.status).toBe(
      "PAUSED",
    );
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

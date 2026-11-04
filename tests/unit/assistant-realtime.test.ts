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
import { realtimeModel } from "../../packages/contracts/src/assistant-realtime.js";
const f = vi.hoisted(() => ({
  db: null as PGlite | null,
  read: vi.fn(),
  send: vi.fn(),
  verifyDoubao: vi.fn(),
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
vi.mock("../../apps/api/src/modules/workspace/assistant.js", () => ({
  readAssistant: f.read,
  sendAssistant: f.send,
}));
vi.mock("../../apps/api/src/modules/analytics/secrets.js", () => ({
  encryptionReady: () => true,
  encryptSecret: (v: string) => "encrypted:" + v,
  decryptSecret: () => "server-only-key",
}));
vi.mock("../../apps/api/src/modules/workspace/doubao-realtime.js", () => ({
  verifyDoubaoRealtime: f.verifyDoubao,
}));
import {
  readRealtimeStatus,
  saveRealtimeSettings,
  verifyRealtimeSettings,
  startRealtime,
  closeRealtime,
  checkRealtime,
  runRealtimeTool,
  saveRealtimeCaptions,
  claimRealtimeSocket,
  activateRealtimeSocket,
} from "../../apps/api/src/modules/workspace/assistant-realtime.js";

const actor = (admin = false, id = "7"): Context => ({
  actor: {
    id,
    username: "test",
    displayName: "Test",
    permissions: ["analytics.read", "analytics.manage"],
    roleCodes: admin ? ["SUPER_ADMIN"] : [],
  },
  requestId: randomUUID(),
});
const input = () => ({
  id: randomUUID(),
  sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n",
  includePersonalContext: true,
  includeMemory: false,
});
beforeAll(async () => {
  f.db = new PGlite();
  await f.db
    .exec(`CREATE TABLE users(id bigint PRIMARY KEY); INSERT INTO users VALUES(7),(8);
    CREATE TABLE personal_assistant_conversations(user_id bigint PRIMARY KEY, messages jsonb DEFAULT '[]', state text DEFAULT 'IDLE', version int DEFAULT 0, updated_at timestamptz DEFAULT now());`);
  await f.db.exec(
    await readFile(
      "packages/database/migrations/085_assistant_realtime.sql",
      "utf8",
    ),
  );
  await f.db.exec(
    await readFile(
      "packages/database/migrations/086_doubao_realtime.sql",
      "utf8",
    ),
  );
});
beforeEach(async () => {
  await f.db!
    .exec(`TRUNCATE assistant_realtime_sessions CASCADE; TRUNCATE personal_assistant_conversations;
    UPDATE assistant_realtime_settings SET provider='openai',enabled=true,voice='marin',api_key_encrypted='encrypted',verified_at=now(),error_note='',version=0,
    doubao_voice='zh_female_vv_uranus_bigtts',doubao_api_key_encrypted=NULL,doubao_verified_at=NULL,doubao_error_note='';`);
  f.verifyDoubao.mockReset().mockResolvedValue(undefined);
  f.read.mockReset().mockResolvedValue({
    ready: true,
    state: "IDLE",
    version: 3,
    messages: [],
  });
  f.send.mockReset().mockResolvedValue({
    state: "IDLE",
    messages: [
      {
        id: randomUUID(),
        role: "assistant",
        text: "正在打开经营分析",
        navigation: "analytics",
      },
    ],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/client_secrets")
        ? new Response(
            JSON.stringify({
              value: "ephemeral-secret-not-returned",
              session: { model: realtimeModel },
            }),
          )
        : url.endsWith("/hangup")
          ? new Response(null, { status: 200 })
          : new Response("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", {
              status: 201,
              headers: { Location: "/v1/realtime/calls/rtc_test" },
            }),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await f.db?.close();
});

describe("native realtime voice authorization and lifecycle", () => {
  it("keeps provider credentials separate and issues an owner-bound one-use socket ticket", async () => {
    const admin = actor(true);
    const configured = await saveRealtimeSettings(admin, {
      version: 0,
      enabled: true,
      provider: "doubao",
      voice: "zh_female_vv_uranus_bigtts",
      apiKey: "doubao-private-opaque-api-key",
    });
    expect(configured.transport).toBe("websocket");
    expect(configured.ready).toBe(false);
    expect(configured.profiles!.openai.apiKeyConfigured).toBe(true);
    const verified = await verifyRealtimeSettings(admin);
    expect(verified.ready).toBe(true);
    expect(f.verifyDoubao).toHaveBeenCalledWith(
      "encrypted:doubao-private-opaque-api-key",
      "zh_female_vv_uranus_bigtts",
      expect.any(Object),
    );
    expect(fetch).not.toHaveBeenCalled();
    const publicStatus = await readRealtimeStatus(actor());
    expect(publicStatus.profiles).toBeUndefined();
    expect(JSON.stringify(publicStatus)).not.toContain("private-opaque");
    const id = randomUUID();
    const started = await startRealtime(actor(), { id });
    expect(started.transport).toBe("websocket");
    expect(started.ticket).toMatch(/^[\w-]{43}$/);
    expect(JSON.stringify(started)).not.toContain("private-opaque");
    expect(
      JSON.stringify(
        (await f.db!.query("SELECT * FROM assistant_realtime_sessions")).rows,
      ),
    ).not.toContain(started.ticket!);
    await expect(
      claimRealtimeSocket(actor(false, "8"), id, started.ticket!),
    ).rejects.toBeDefined();
    await expect(
      claimRealtimeSocket(actor(), id, "incorrect-ticket"),
    ).rejects.toBeDefined();
    expect(
      await claimRealtimeSocket(actor(), id, started.ticket!),
    ).toMatchObject({ key: "encrypted:doubao-private-opaque-api-key" });
    await expect(
      claimRealtimeSocket(actor(), id, started.ticket!),
    ).rejects.toBeDefined();
    await activateRealtimeSocket(actor(), id);
    expect((await checkRealtime(actor(), id)).active).toBe(true);
    await closeRealtime(actor(), id);
    expect(fetch).not.toHaveBeenCalled();
    const restored = await saveRealtimeSettings(admin, {
      version: verified.version,
      provider: "openai",
      enabled: true,
      voice: "marin",
    });
    expect(restored.ready).toBe(true);
    expect(restored.transport).toBe("webrtc");
    expect(restored.profiles!.doubao.apiKeyConfigured).toBe(true);
  });
  it("rejects expired/cancelled socket tickets and isolates provider voice validation", async () => {
    await expect(
      saveRealtimeSettings(actor(true), {
        version: 0,
        provider: "doubao",
        enabled: true,
        voice: "marin",
      }),
    ).rejects.toBeDefined();
    await f.db!.exec(
      "UPDATE assistant_realtime_settings SET provider='doubao',doubao_api_key_encrypted='encrypted',doubao_verified_at=now()",
    );
    const first = await startRealtime(actor(), { id: randomUUID() });
    await f.db!.exec(
      "UPDATE assistant_realtime_sessions SET expires_at=now()-interval '1 second'",
    );
    await expect(
      claimRealtimeSocket(actor(), first.id, first.ticket!),
    ).rejects.toBeDefined();
    const next = await startRealtime(actor(), { id: randomUUID() });
    await closeRealtime(actor(), next.id);
    await expect(
      claimRealtimeSocket(actor(), next.id, next.ticket!),
    ).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("redacts secrets and models, rejects other-provider keys and non-admin edits", async () => {
    const status = await readRealtimeStatus(actor());
    expect(status.ready).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/encrypted|gpt-|secret/);
    await expect(
      saveRealtimeSettings(actor(), {
        version: 0,
        enabled: false,
        voice: "marin",
      }),
    ).rejects.toBeDefined();
    await expect(
      saveRealtimeSettings(actor(true), {
        version: 0,
        enabled: true,
        voice: "marin",
        apiKey: "sk-or-some-wrong-provider-key",
      }),
    ).rejects.toBeDefined();
    const changed = await saveRealtimeSettings(actor(true), {
      version: 0,
      enabled: true,
      voice: "cedar",
      apiKey: "sk-proj-test-private-new-key",
    });
    expect(changed.verifiedAt).toBeNull();
    expect(changed.ready).toBe(false);
    await expect(
      saveRealtimeSettings(actor(true), {
        version: 0,
        enabled: true,
        voice: "marin",
      }),
    ).rejects.toBeDefined();
    const verified = await verifyRealtimeSettings(actor(true));
    expect(verified.ready).toBe(true);
    expect(JSON.stringify(verified)).not.toContain("ephemeral");
    expect(
      JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
        .expires_after.seconds,
    ).toBe(10);
  });
  it("creates WebRTC using a server-only key, semantic turn detection and native audio", async () => {
    const b = input();
    const result = await startRealtime(actor(), b);
    expect(result.sdp).toContain("v=0");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      "Bearer server-only-key",
    );
    const config = JSON.parse(
      (init!.body as FormData).get("session") as string,
    );
    expect(config.audio.input.turn_detection).toMatchObject({
      type: "semantic_vad",
      interrupt_response: true,
    });
    expect(config.tools[0].name).toBe("workspace_request");
    expect(config.model).toBe(realtimeModel);
    expect(JSON.stringify(result)).not.toMatch(/server-only|rtc_test|gpt-/);
    const rows = (
      await f.db!.query("SELECT * FROM assistant_realtime_sessions")
    ).rows;
    expect(JSON.stringify(rows)).not.toMatch(/m=audio|server-only/);
    await expect(startRealtime(actor(), input())).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(checkRealtime(actor(false, "8"), b.id)).rejects.toBeDefined();
    await closeRealtime(actor(), b.id);
    expect(vi.mocked(fetch).mock.calls[1][0]).toContain("rtc_test/hangup");
    await expect(checkRealtime(actor(), b.id)).rejects.toBeDefined();
  });
  it("rechecks configuration and permissions on active calls", async () => {
    const b = input();
    await startRealtime(actor(), b);
    await saveRealtimeSettings(actor(true), {
      version: 0,
      enabled: false,
      voice: "marin",
    });
    await expect(checkRealtime(actor(), b.id)).rejects.toBeDefined();
    await expect(
      runRealtimeTool(actor(), b.id, { callId: "x", request: "更新罗盘数据" }),
    ).rejects.toBeDefined();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("deduplicates tool calls and keeps consent from the original session", async () => {
    const b = input();
    await startRealtime(actor(), b);
    const body = { callId: "call_once", request: "打开经营分析" };
    const first = await runRealtimeTool(actor(), b.id, body);
    expect(await runRealtimeTool(actor(), b.id, body)).toEqual(first);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][1]).toMatchObject({
      message: body.request,
      includePersonalContext: true,
      includeMemory: false,
    });
    await expect(
      runRealtimeTool(actor(), b.id, { ...body, request: "更新罗盘数据" }),
    ).rejects.toBeDefined();
    await expect(
      runRealtimeTool(actor(false, "8"), b.id, body),
    ).rejects.toBeDefined();
  });
  it("never re-executes a failed or still-pending instruction", async () => {
    const b = input();
    await startRealtime(actor(), b);
    let resolve!: (v: unknown) => void;
    f.send.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const body = { callId: "pending", request: "同步聚水潭库存" };
    const first = runRealtimeTool(actor(), b.id, body);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    await expect(runRealtimeTool(actor(), b.id, body)).rejects.toBeDefined();
    resolve({ state: "FAILED", error: "同步失败", messages: [] });
    const result = await first;
    expect(await runRealtimeTool(actor(), b.id, body)).toEqual(result);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("saves only scoped plain captions, once, without accepting action objects", async () => {
    const b = input();
    await startRealtime(actor(), b);
    const messages = [
      { id: randomUUID(), role: "user", text: "你好" },
      { id: randomUUID(), role: "assistant", text: "你好，我是小序" },
    ];
    await saveRealtimeCaptions(actor(), b.id, { messages });
    await saveRealtimeCaptions(actor(), b.id, { messages });
    const row = (
      await f.db!.query<{ messages: unknown[] }>(
        "SELECT messages FROM personal_assistant_conversations WHERE user_id=7",
      )
    ).rows[0];
    expect(row.messages).toHaveLength(2);
    await expect(
      saveRealtimeCaptions(actor(false, "8"), b.id, { messages }),
    ).rejects.toBeDefined();
    await expect(
      saveRealtimeCaptions(actor(), b.id, {
        messages: [{ ...messages[1], navigation: "analytics" }],
      }),
    ).rejects.toBeDefined();
  });
  it("closes a provider call if the user stops while SDP is pending", async () => {
    let finish!: (r: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const b = input(),
      start = startRealtime(actor(), b);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await closeRealtime(actor(), b.id);
    finish(
      new Response("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111", {
        headers: { Location: "/v1/realtime/calls/rtc_late" },
      }),
    );
    await expect(start).rejects.toBeDefined();
    expect(vi.mocked(fetch).mock.calls.at(-1)![0]).toContain("rtc_late/hangup");
  });
  it("fails without exposing provider bodies or silently switching models", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("private provider diagnostic sk-sensitive", { status: 401 }),
    );
    const status = await verifyRealtimeSettings(actor(true));
    expect(status.ready).toBe(false);
    expect(status.error).toContain("401");
    expect(status.error).not.toMatch(/sk-sensitive|private provider/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

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
import type { Context } from "../../apps/api/src/core.js";
import type { Tx } from "../../packages/database/src/index.js";
import type { VoiceEvent } from "../../packages/contracts/src/assistant-voice.js";
import { wavFromFrames } from "../../apps/web/src/voice-pcm.js";
const fixture = vi.hoisted(() => ({
  database: null as PGlite | null,
  send: vi.fn(),
  read: vi.fn(),
  encrypted: true,
}));
vi.mock("../../packages/database/src/index.js", async (original) => {
  const exports =
    await original<typeof import("../../packages/database/src/index.js")>();
  const wrap = (connection: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...p: unknown[]) =>
      (await connection.query(sql, p)).rows,
    $executeRawUnsafe: async (sql: string, ...p: unknown[]) =>
      (await connection.query(sql, p)).affectedRows || 0,
  });
  return {
    ...exports,
    db: {
      $queryRawUnsafe: async (sql: string, ...p: unknown[]) =>
        (await fixture.database!.query(sql, p)).rows,
      $executeRawUnsafe: async (sql: string, ...p: unknown[]) =>
        (await fixture.database!.query(sql, p)).affectedRows || 0,
      $transaction: (work: (tx: Tx) => Promise<unknown>) =>
        fixture.database!.transaction((tx) => work(wrap(tx) as unknown as Tx)),
    },
  };
});
vi.mock("../../apps/api/src/modules/workspace/assistant.js", () => ({
  readAssistant: fixture.read,
  sendAssistant: fixture.send,
}));
vi.mock("../../apps/api/src/modules/analytics/secrets.js", () => ({
  encryptionReady: () => fixture.encrypted,
  encryptSecret: (v: string) => "encrypted:" + v,
  decryptSecret: () => "test-secret-never-return",
}));
import {
  readVoiceStatus,
  saveVoiceSettings,
  verifyVoiceSettings,
  runVoiceTurn,
  runVoiceSpeech,
  voiceErrorEvent,
  validateVoiceWav,
  streamVoiceSpeech,
  voiceSafeError,
} from "../../apps/api/src/modules/workspace/assistant-voice.js";
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
const audio = () =>
  wavFromFrames([
    Float32Array.from({ length: 12000 }, (_, i) => Math.sin(i / 10) * 0.1),
  ]);
const input = () => ({
  id: randomUUID(),
  audio: audio(),
  includePersonalContext: false,
  includeMemory: false,
});
const config = {
  model: "openai/gpt-audio",
  voice: "coral",
  api_key_encrypted: "encrypted",
};
const speech = (model = "openai/gpt-audio") =>
  new Response(
    new ReadableStream({
      start(controller) {
        const body = `data: ${JSON.stringify({ model, choices: [{ delta: { audio: { data: "AAABAAIA", transcript: "你好" } } }] })}\n\ndata: [DONE]\n\n`;
        const bytes = new TextEncoder().encode(body);
        for (let i = 0; i < bytes.length; i += 13)
          controller.enqueue(bytes.slice(i, i + 13));
        controller.close();
      },
    }),
  );
beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(
    "CREATE TABLE users(id bigint PRIMARY KEY); INSERT INTO users VALUES(7),(8)",
  );
  await fixture.database.exec(
    await readFile(
      "packages/database/migrations/082_assistant_voice.sql",
      "utf8",
    ),
  );
});
beforeEach(async () => {
  fixture.encrypted = true;
  fixture.read.mockReset();
  fixture.send.mockReset();
  fixture.read.mockResolvedValue({
    ready: true,
    state: "IDLE",
    version: 4,
    messages: [],
  });
  fixture.send.mockResolvedValue({
    ready: true,
    state: "IDLE",
    version: 6,
    messages: [
      {
        id: "reply-id",
        role: "assistant",
        text: "库存为5件，来源为已同步快照。",
      },
    ],
  });
  await fixture.database!.exec(
    "TRUNCATE assistant_voice_requests; UPDATE assistant_voice_settings SET enabled=true,model='openai/gpt-audio',voice='coral',api_key_encrypted='encrypted',verified_at=now(),version=0,error_note='' WHERE id=1",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) =>
      JSON.parse(init.body).stream
        ? speech()
        : new Response(
            JSON.stringify({
              model: "openai/gpt-audio",
              choices: [
                {
                  finish_reason: "stop",
                  message: { content: "查询 XFA16X31196L029004 库存" },
                },
              ],
            }),
          ),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await fixture.database?.close();
});
describe("OpenRouter GPT voice", () => {
  it("redacts credentials and limits configuration to administrators", async () => {
    const value = await readVoiceStatus(actor());
    expect(value.ready).toBe(true);
    expect(JSON.stringify(value)).not.toContain("encrypted");
    await expect(
      saveVoiceSettings(actor(), {
        version: 0,
        enabled: true,
        model: "openai/gpt-audio",
        voice: "coral",
      }),
    ).rejects.toBeDefined();
    const updated = await saveVoiceSettings(actor(true), {
      version: 0,
      enabled: true,
      model: "openai/gpt-audio",
      voice: "coral",
      apiKey: "sk-or-test-new-secret-12345",
    });
    expect(updated.verifiedAt).toBeNull();
    expect(updated.ready).toBe(false);
    expect(JSON.stringify(updated)).not.toContain("sk-or");
    await expect(
      saveVoiceSettings(actor(true), {
        version: 0,
        enabled: false,
        model: "openai/gpt-audio",
        voice: "coral",
      }),
    ).rejects.toBeDefined();
  });
  it("refuses silent, malformed and oversized WAV before charging any request", async () => {
    expect(() => validateVoiceWav(audio())).not.toThrow();
    expect(() =>
      validateVoiceWav(wavFromFrames([new Float32Array(12000)])),
    ).toThrow();
    expect(() =>
      validateVoiceWav(Buffer.from("not audio").toString("base64")),
    ).toThrow();
    const b = Buffer.from(audio(), "base64");
    b.writeUInt32LE(48000, 24);
    await expect(
      runVoiceTurn(
        actor(),
        { ...input(), audio: b.toString("base64") },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("handles split SSE and checks the actual model before relaying PCM", async () => {
    const events: VoiceEvent[] = [];
    await streamVoiceSpeech(config, "你好", new AbortController().signal, (e) =>
      events.push(e),
    );
    expect(events.map((e) => e.type)).toEqual(["model", "audio", "spoken"]);
    vi.mocked(fetch).mockResolvedValueOnce(speech("different/model"));
    await expect(
      streamVoiceSpeech(config, "你好", new AbortController().signal, () => {
        throw Error("must not emit");
      }),
    ).rejects.toBeDefined();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('data: {"model":"openai/gpt-audio","choices":[]}\n\n'),
    );
    await expect(
      streamVoiceSpeech(config, "你好", new AbortController().signal, () => {}),
    ).rejects.toBeDefined();
  });
  it("reuses the authenticated assistant, preserves long identifiers and explicit opt-ins", async () => {
    const events: VoiceEvent[] = [],
      b = input();
    await runVoiceTurn(actor(), b, new AbortController().signal, (e) =>
      events.push(e),
    );
    expect(fixture.send).toHaveBeenCalledWith(
      expect.objectContaining({ actor: expect.objectContaining({ id: "7" }) }),
      expect.objectContaining({
        message: "查询 XFA16X31196L029004 库存",
        version: 4,
        includePersonalContext: false,
        includeMemory: false,
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(events.map((e) => e.type)).toEqual([
      "stage",
      "transcript",
      "stage",
      "reply",
      "stage",
      "model",
      "audio",
      "spoken",
      "done",
    ]);
    const stored = (
      await fixture.database!.query<{ state: string }>(
        "SELECT * FROM assistant_voice_requests",
      )
    ).rows[0];
    expect(stored.state).toBe("DONE");
    expect(JSON.stringify(stored)).not.toContain(b.audio);
    await expect(
      runVoiceTurn(actor(), b, new AbortController().signal, () => {}),
    ).rejects.toBeDefined();
    expect(fixture.send).toHaveBeenCalledTimes(1);
  });
  it("stops after canceled recognition and never executes business work", async () => {
    const controller = new AbortController();
    vi.mocked(fetch).mockImplementationOnce(async () => {
      controller.abort();
      return new Response(
        JSON.stringify({
          model: "openai/gpt-audio",
          choices: [{ message: { content: "同步库存" } }],
        }),
      );
    });
    await expect(
      runVoiceTurn(actor(), input(), controller.signal, () => {}),
    ).rejects.toBeDefined();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(
      (
        await fixture.database!.query<{ state: string }>(
          "SELECT state FROM assistant_voice_requests",
        )
      ).rows[0].state,
    ).toBe("FAILED");
  });
  it("enforces concurrency but allows voice beyond 20 requests", async () => {
    await fixture.database!.query(
      "INSERT INTO assistant_voice_requests(id,user_id) VALUES($1,7)",
      [randomUUID()],
    );
    await expect(
      runVoiceTurn(actor(), input(), new AbortController().signal, () => {}),
    ).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
    await fixture.database!.exec("TRUNCATE assistant_voice_requests");
    for (let i = 0; i < 20; i++)
      await fixture.database!.query(
        "INSERT INTO assistant_voice_requests(id,user_id,state) VALUES($1,7,'DONE')",
        [randomUUID()],
      );
    await runVoiceTurn(
      actor(),
      input(),
      new AbortController().signal,
      () => {},
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("returns to listening only for unusable recognition, without asking the assistant", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: config.model,
          choices: [{ message: { content: "[无语音]" } }],
        }),
      ),
    );
    let failure: unknown;
    try {
      await runVoiceTurn(
        actor(),
        input(),
        new AbortController().signal,
        () => {},
      );
    } catch (e) {
      failure = e;
    }
    expect(voiceErrorEvent(failure)).toEqual({ type: "retry-listening" });
    expect(fixture.send).not.toHaveBeenCalled();
    expect(voiceErrorEvent(new Error("network"))).toMatchObject({
      type: "error",
    });
    await runVoiceTurn(
      actor(),
      input(),
      new AbortController().signal,
      () => {},
    );
    expect(fixture.send).toHaveBeenCalledTimes(1);
  });
  it("reads only the owner's saved reply, uses the configured voice and never reruns business work", async () => {
    const messageId = randomUUID(),
      b = { id: randomUUID(), messageId };
    fixture.read.mockImplementation(async (c: Context) => ({
      ready: true,
      state: "IDLE",
      version: 0,
      messages:
        c.actor.id === "7"
          ? [{ id: messageId, role: "assistant", text: "已提交后台任务。" }]
          : [],
    }));
    await expect(
      runVoiceSpeech(
        actor(false, "8"),
        b,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toBeDefined();
    await expect(
      runVoiceSpeech(
        actor(),
        { ...b, text: "伪造正文" },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
    await fixture.database!.exec(
      "UPDATE assistant_voice_settings SET voice='shimmer' WHERE id=1",
    );
    await runVoiceSpeech(actor(), b, new AbortController().signal, () => {});
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.audio.voice).toBe("shimmer");
    expect(body.messages[1].content).toMatch(/^请原样朗读/);
    expect(JSON.parse(body.messages[1].content.split("\n")[1])).toEqual({
      text: "已提交后台任务。",
    });
    expect(fixture.send).not.toHaveBeenCalled();
    await expect(
      runVoiceSpeech(actor(), b, new AbortController().signal, () => {}),
    ).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("verifies actual generated audio and retains safe failure status without provider secrets", async () => {
    const success = await verifyVoiceSettings(actor(true));
    expect(success.verifiedAt).toBeTruthy();
    expect(success.sample).toBe("AAABAAIA");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("test-secret-never-return", { status: 402 }),
    );
    const failed = await verifyVoiceSettings(actor(true));
    expect(failed.verifiedAt).toBeNull();
    expect(failed.error).toContain("额度");
    expect(JSON.stringify(failed)).not.toContain("test-secret");
    expect(voiceSafeError(Error("secret"))).not.toContain("secret");
  });
});

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
  readDictationStatus,
  runVoiceDictation,
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
const qwenConfig = {
  provider: "qwen",
  model: "qwen3.8-omni-flash",
  voice: "Serena",
  api_key_encrypted: "qwen-encrypted",
  qwen_workspace_id: "ws-test",
};
const qwenSpeech = (finish = true) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const pcm = Buffer.from(audio(), "base64")
          .subarray(44)
          .toString("base64");
        const parts = [
          { request_id: "qwen-tts-test", output: { audio: { data: pcm } } },
          ...(finish
            ? [
                {
                  request_id: "qwen-tts-test",
                  output: { finish_reason: "stop", audio: { data: "" } },
                  usage: { characters: 8, input_tokens: 0, output_tokens: 0 },
                },
              ]
            : []),
        ];
        const bytes = new TextEncoder().encode(
          parts.map((p) => `data: ${JSON.stringify(p)}\n\n`).join(""),
        );
        for (let i = 0; i < bytes.length; i += 137)
          controller.enqueue(bytes.slice(i, i + 137));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
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
  await installAiManagementSchema(fixture.database);
  await fixture.database.exec(
    await readFile(
      "packages/database/migrations/082_assistant_voice.sql",
      "utf8",
    ),
  );
  await fixture.database.exec(
    await readFile(
      "packages/database/migrations/092_qwen_segmented_voice.sql",
      "utf8",
    ),
  );
  await fixture.database.exec(
    "CREATE TABLE assistant_realtime_settings(id int PRIMARY KEY,qwen_api_key_encrypted text,qwen_workspace_id text); INSERT INTO assistant_realtime_settings VALUES(1,'existing-qwen-key','ws-test')",
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
    "TRUNCATE assistant_voice_requests; UPDATE assistant_voice_settings SET provider='openrouter',qwen_api_key_encrypted=NULL,qwen_verified_at=NULL,qwen_error_note='',qwen_workspace_id='',qwen_voice='Serena',enabled=true,model='openai/gpt-audio',voice='coral',api_key_encrypted='encrypted',verified_at=now(),version=0,error_note='' WHERE id=1",
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
  it("transcribes an unsent draft with the configured audio model, separate usage, and no business calls", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: randomUUID(),
          model: "openai/gpt-audio",
          choices: [
            {
              finish_reason: "stop",
              message: { content: "查询 XFA16X31196L029004 库存" },
            },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 8,
            total_tokens: 28,
            cost: 0.002,
          },
        }),
      ),
    );
    expect(await readDictationStatus(actor())).toEqual({
      ready: true,
      maxSeconds: 25,
      message: "听写已就绪",
    });
    const body = { id: randomUUID(), audio: audio() };
    const result = await runVoiceDictation(
      actor(),
      body,
      new AbortController().signal,
    );
    expect(result.text).toBe("查询 XFA16X31196L029004 库存");
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
    const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(sent).toMatchObject({
      model: "openai/gpt-audio",
      modalities: ["text"],
      stream: false,
    });
    expect(sent.messages[1].content[0]).toMatchObject({
      type: "input_audio",
      input_audio: { format: "wav", data: body.audio },
    });
    const usage = await fixture.database!.query<Record<string, unknown>>(
      "SELECT feature_id,model,total_tokens,amount FROM ai_model_usage WHERE feature_id='browser_dictation'",
    );
    expect(
      usage.rows.map((row) => ({
        ...row,
        total_tokens: Number(row.total_tokens),
        amount: Number(row.amount),
      })),
    ).toMatchObject([
      {
        feature_id: "browser_dictation",
        model: "openai/gpt-audio",
        total_tokens: 28,
        amount: 0.002,
      },
    ]);
    await expect(
      runVoiceDictation(actor(), body, new AbortController().signal),
    ).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("refuses unconfigured, unauthorized or silent dictation before an API charge", async () => {
    const unprivileged = actor();
    unprivileged.actor.permissions = [];
    await expect(readDictationStatus(unprivileged)).rejects.toBeDefined();
    await expect(
      runVoiceDictation(
        actor(),
        { id: randomUUID(), audio: wavFromFrames([new Float32Array(12000)]) },
        new AbortController().signal,
      ),
    ).rejects.toBeDefined();
    await fixture.database!.exec(
      "UPDATE assistant_voice_settings SET enabled=false WHERE id=1",
    );
    expect((await readDictationStatus(actor())).ready).toBe(false);
    await expect(
      runVoiceDictation(
        actor(),
        { id: randomUUID(), audio: audio() },
        new AbortController().signal,
      ),
    ).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
  });
  it("does not return late dictation after cancellation and releases the request reservation", async () => {
    const abort = new AbortController();
    vi.mocked(fetch).mockImplementationOnce(async () => {
      abort.abort();
      return new Response(
        JSON.stringify({
          model: "openai/gpt-audio",
          choices: [{ message: { content: "迟到的文字" } }],
        }),
      );
    });
    const id = randomUUID();
    await expect(
      runVoiceDictation(actor(), { id, audio: audio() }, abort.signal),
    ).rejects.toBeDefined();
    const saved = await fixture.database!.query(
      "SELECT state FROM assistant_voice_requests WHERE id=$1",
      [id],
    );
    expect(saved.rows).toEqual([{ state: "FAILED" }]);
    expect(fixture.send).not.toHaveBeenCalled();
  });
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

describe("Qwen segmented speech and dictation", () => {
  const saveQwen = () =>
    saveVoiceSettings(actor(true), {
      version: 0,
      enabled: true,
      provider: "qwen",
      model: "qwen3.8-omni-flash",
      voice: "Serena",
      useRealtimeCredentials: true,
    });
  it("copies the existing Beijing credential on the server and preserves the other profile", async () => {
    const status = await saveQwen();
    expect(status).toMatchObject({
      provider: "qwen",
      model: "qwen3.8-omni-flash",
      speechModel: "qwen3-tts-flash",
      workspaceId: "ws-test",
      apiKeyConfigured: true,
      verifiedAt: null,
      ready: false,
    });
    expect(JSON.stringify(status)).not.toMatch(
      /existing-qwen-key|encrypted|test-secret/,
    );
    const row = (
      await fixture.database!.query("SELECT * FROM assistant_voice_settings")
    ).rows[0] as Record<string, unknown>;
    expect(row.api_key_encrypted).toBe("encrypted");
    expect(row.qwen_api_key_encrypted).toBe("existing-qwen-key");
    expect(fetch).not.toHaveBeenCalled();
    const restored = await saveVoiceSettings(actor(true), {
      version: 1,
      enabled: true,
      model: "openai/gpt-audio",
      voice: "coral",
    });
    expect(restored).toMatchObject({ provider: "openrouter", ready: true });
  });
  it("rejects a mismatched provider credential or unsupported voice before making requests", async () => {
    for (const change of [
      { apiKey: "sk-or-this-key-is-for-openrouter" },
      { voice: "coral" },
      { workspaceId: "https://evil.example" },
    ]) {
      await expect(
        saveVoiceSettings(actor(true), {
          version: 0,
          enabled: true,
          provider: "qwen",
          model: "qwen3.8-omni-flash",
          voice: "Serena",
          workspaceId: "ws-test",
          ...change,
        }),
      ).rejects.toThrow();
    }
    await expect(
      saveVoiceSettings(actor(), {
        version: 0,
        enabled: true,
        provider: "qwen",
        model: "qwen3.8-omni-flash",
        voice: "Serena",
        useRealtimeCredentials: true,
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("routes unsent dictation to the exact Omni model, without thinking or business tools", async () => {
    await saveQwen();
    await fixture.database!.exec(
      "UPDATE assistant_voice_settings SET qwen_verified_at=now()",
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: "qwen3.8-omni-flash",
          choices: [
            {
              finish_reason: "stop",
              message: { content: "查询商品 A123 库存" },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        }),
      ),
    );
    expect(
      await runVoiceDictation(
        actor(),
        { id: randomUUID(), audio: audio() },
        new AbortController().signal,
      ),
    ).toEqual({ text: "查询商品 A123 库存" });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(
      "https://ws-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "qwen3.8-omni-flash",
      stream: false,
      modalities: ["text"],
      reasoning_effort: "none",
    });
    expect(body.provider).toBeUndefined();
    expect(body.messages[1].content[0].input_audio.data).toBe(
      "data:audio/wav;base64," + audio(),
    );
    expect(fixture.send).not.toHaveBeenCalled();
    const rows = await fixture.database!.query(
      "SELECT source,model,total_tokens FROM ai_model_usage WHERE feature_id='browser_dictation' ORDER BY started_at DESC LIMIT 1",
    );
    expect(rows.rows[0]).toMatchObject({
      source: "ws-test.cn-beijing.maas.aliyuncs.com",
      model: "qwen3.8-omni-flash",
      total_tokens: "25",
    });
  });
  it("streams fragmented PCM and records actual characters without inventing a returned model or money", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(qwenSpeech());
    const events: VoiceEvent[] = [];
    await streamVoiceSpeech(
      qwenConfig,
      "你好，我是小序。",
      new AbortController().signal,
      (e) => events.push(e),
    );
    expect(events.some((e) => e.type === "audio")).toBe(true);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(
      "https://ws-test.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "qwen3-tts-flash",
      input: {
        text: "你好，我是小序。",
        voice: "Serena",
        language_type: "Auto",
      },
    });
    const receipt = (
      await fixture.database!.query(
        "SELECT input_characters,amount,response_model,status FROM ai_model_usage WHERE provider_request_id='qwen-tts-test'",
      )
    ).rows[0];
    expect(receipt).toMatchObject({
      input_characters: "8",
      amount: null,
      response_model: null,
      status: "responded",
    });
  });
  it("verifies both synthesis and recognition before enabling the connection", async () => {
    await saveQwen();
    vi.mocked(fetch)
      .mockResolvedValueOnce(qwenSpeech())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "qwen3.8-omni-flash",
            choices: [
              {
                finish_reason: "stop",
                message: { content: "你好，我是小序。" },
              },
            ],
          }),
        ),
      );
    const result = await verifyVoiceSettings(actor(true));
    expect(result.ready).toBe(true);
    expect(result.verifiedAt).toBeTruthy();
    expect(result.sample).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fixture.send).not.toHaveBeenCalled();
  });
  it("leaves the connection unverified when recognition fails after successful synthesis", async () => {
    await saveQwen();
    vi.mocked(fetch)
      .mockResolvedValueOnce(qwenSpeech())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "AllocationQuota.FreeTierOnly",
            message: "secret provider detail",
          }),
          { status: 403 },
        ),
      );
    const result = await verifyVoiceSettings(actor(true));
    expect(result.ready).toBe(false);
    expect(result.verifiedAt).toBeNull();
    expect(result.sample).toBeNull();
    expect(result.error).toContain("免费额度");
    expect(JSON.stringify(result)).not.toContain("secret provider detail");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects truncated audio and honors cancellation without switching providers", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(qwenSpeech(false));
    await expect(
      streamVoiceSpeech(
        qwenConfig,
        "你好",
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow();
    const cancel = new AbortController();
    cancel.abort();
    await expect(
      streamVoiceSpeech(qwenConfig, "你好", cancel.signal, () => {}),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

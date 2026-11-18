import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Context } from "../../apps/api/src/core.js";
import type { Tx } from "../../packages/database/src/index.js";
import { installAiManagementSchema } from "../fixtures/ai-management-schema.js";
const fixture = vi.hoisted(() => ({
  db: null as PGlite | null,
  address: "1.1.1.1",
  downloads: 0,
  pinned: "",
  redirect: "",
  addresses: null as { address: string; family: number }[] | null,
  attempted: [] as string[],
  failures: [] as string[],
  hang: false,
  dnsHang: false,
  bodyHang: false,
  redirects: [] as string[],
  responseDelays: [] as number[],
}));
vi.mock("node:dns/promises", () => ({
  lookup: async () =>
    fixture.dnsHang
      ? new Promise<never>(() => {})
      : fixture.addresses || [{ address: fixture.address, family: 4 }],
}));
vi.mock("node:https", async () => {
  const { EventEmitter } = await import("node:events");
  const { Readable } = await import("node:stream");
  return {
    request: (
      _url: unknown,
      options: Record<string, any>,
      receive: (response: unknown) => void,
    ) => {
      fixture.downloads++;
      options.lookup(
        "audio.real-cdn.net",
        { all: true },
        (_error: unknown, result: { address: string }[]) => {
          fixture.pinned = result[0].address;
          fixture.attempted.push(result[0].address);
        },
      );
      expect(options.agent).toBe(false);
      expect(options.headers.authorization).toBeUndefined();
      const req = new EventEmitter() as any;
      req.destroy = (error: Error) => {
        req.emit("error", error);
      };
      req.end = () => {
        if (fixture.hang) return;
        if (fixture.failures.includes(fixture.pinned)) {
          req.emit(
            "error",
            Object.assign(Error("fixture transport failure"), {
              code: "ECONNREFUSED",
            }),
          );
          return;
        }
        const socket = new EventEmitter();
        req.emit("socket", socket);
        socket.emit("secureConnect");
        const nextRedirect = fixture.redirects.shift() || fixture.redirect;
        const receiveResponse = () => {
          const response = fixture.bodyHang
            ? (new Readable({ read() {} }) as any)
            : (Readable.from([Buffer.from("ID3returned audio")]) as any);
          response.statusCode = nextRedirect ? 302 : 200;
          response.headers = nextRedirect
            ? { location: nextRedirect }
            : { "content-type": "audio/mpeg" };
          receive(response);
        };
        const delay = fixture.responseDelays.shift() || 0;
        if (delay) setTimeout(receiveResponse, delay);
        else receiveResponse();
      };
      return req;
    },
  };
});
vi.mock("../../packages/database/src/index.js", async (original) => {
  const real =
    await original<typeof import("../../packages/database/src/index.js")>();
  const wrap = (database: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) =>
      sql.includes("pg_advisory_xact_lock")
        ? []
        : (await database.query(sql, args)).rows,
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) =>
      (await database.query(sql, args)).affectedRows || 0,
  });
  return {
    ...real,
    db: {
      $queryRawUnsafe: (sql: string, ...args: unknown[]) =>
        wrap(fixture.db!).$queryRawUnsafe(sql, ...args),
      $executeRawUnsafe: (sql: string, ...args: unknown[]) =>
        wrap(fixture.db!).$executeRawUnsafe(sql, ...args),
      $transaction: (fn: (tx: Tx) => Promise<unknown>) =>
        fixture.db!.transaction((tx) => fn(wrap(tx) as unknown as Tx)),
    },
  };
});
import { encryptSecret } from "../../apps/api/src/modules/analytics/secrets.js";
import {
  agentAiAudioResult,
  audioParams,
  createAgentAiSpeech,
  createAgentAiVoice,
  downloadAgentAiAudio,
  estimateAgentAiAudio,
  inspectVoiceSample,
  readAgentAiAudio,
  refreshAgentAiAudio,
  safeAudioUrl,
  syncAgentAiVoices,
} from "../../apps/api/src/modules/workspace/agentai-audio.js";
const key = "fixture-audio-key-not-real";
const admin = (id = "7"): Context => ({
  actor: {
    id,
    username: "admin",
    displayName: "Admin",
    permissions: ["analytics.manage"],
    roleCodes: ["SUPER_ADMIN"],
  },
  requestId: randomUUID(),
  key: randomUUID(),
});
const input = (model = "doubao-tts-2.0") => ({
  model,
  input: "语音制作测试",
  voice:
    model === "speech-2.8" ? "female-tianmei" : "zh_female_vv_uranus_bigtts",
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const query = async (sql: string, args: unknown[] = []) =>
  (await fixture.db!.query<Record<string, any>>(sql, args)).rows;
let calls: { url: string; init: RequestInit }[];
let quoteResponse: Record<string, any>;
let submit: (url: string, init: RequestInit) => Promise<Response>;
let poll: Record<string, any>;
const taskId = "audio-task-123";
async function network(url: string | URL, init: RequestInit = {}) {
  const target = String(url);
  calls.push({ url: target, init });
  expect(init.redirect).toBe("error");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer " + key);
  expect(new Headers(init.headers).get("x-schedule-strategy")).toBe("balanced");
  if (target.endsWith("/v1/pricing-estimate")) return json(quoteResponse);
  if (target.includes("/v1/tasks/")) return json(poll);
  if (target.includes("/v1/audio/voices/"))
    return json({ id: "omfvc_own_voice", name: "我的音色", status: "ready" });
  return submit(target, init);
}
beforeAll(async () => {
  fixture.db = new PGlite();
  await fixture.db.exec(
    "CREATE TABLE users(id bigint PRIMARY KEY); INSERT INTO users VALUES(7),(8)",
  );
  // Load the production DDL: a text-only entity_id fixture masked UUID writes.
  const initial = await readFile(
    "packages/database/migrations/001_initial.sql",
    "utf8",
  );
  const auditDdl = initial.match(/CREATE TABLE audit_logs \([\s\S]*?\);/)?.[0];
  if (!auditDdl) throw Error("Production audit schema missing");
  await fixture.db.exec(auditDdl);
  await installAiManagementSchema(fixture.db);
  const migration = await readFile(
    "packages/database/migrations/107_agentai_audio.sql",
    "utf8",
  );
  await fixture.db.exec(migration);
  await fixture.db.exec(migration);
}, 30000);
beforeEach(async () => {
  vi.stubEnv("COMPASS_MAIL_KEY", "11".repeat(32));
  await fixture.db!.exec(
    "TRUNCATE agentai_audio_tasks,agentai_audio_quotes,agentai_audio_voices,ai_model_usage,audit_logs",
  );
  await fixture.db!.query(
    "UPDATE agentai_settings SET enabled=true,verified_at=now(),version=1,api_key_encrypted=$1,model_catalog=$2::jsonb,catalog_at=now()",
    [
      encryptSecret(key),
      JSON.stringify(
        ["speech-2.8", "doubao-tts-2.0"].map((model) => ({
          model,
          available: true,
          type: "audio",
        })),
      ),
    ],
  );
  calls = [];
  fixture.address = "1.1.1.1";
  fixture.downloads = 0;
  fixture.pinned = "";
  fixture.redirect = "";
  fixture.addresses = null;
  fixture.attempted = [];
  fixture.failures = [];
  fixture.hang = false;
  fixture.dnsHang = false;
  fixture.bodyHang = false;
  fixture.redirects = [];
  fixture.responseDelays = [];
  quoteResponse = {
    effective_total_rmb: 0.1,
    max_effective_total_rmb: 0.15,
    required_freeze_rmb: 0.15,
  };
  submit = async () =>
    json(
      { task_id: taskId, status: "processing", model: "doubao-tts-2.0" },
      202,
    );
  poll = {
    id: taskId,
    model: "doubao-tts-2.0",
    status: "processing",
    is_final: false,
  };
  vi.stubGlobal("fetch", vi.fn(network));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await fixture.db?.close();
});
const error = (code: string) => ({ response: { error: { code } } });

it("quotes real parameters privately, submits once without pinning and replays the same quote without paying twice", async () => {
  const c = admin(),
    estimate = await estimateAgentAiAudio(c, input());
  expect(estimate).toMatchObject({
    characters: 6,
    estimatedCny: 0.1,
    maxCny: 0.15,
    freezeCny: 0.15,
  });
  const saved = (await query("SELECT * FROM agentai_audio_quotes"))[0];
  expect(saved.payload_encrypted).not.toContain("语音制作测试");
  const estimatedBody = JSON.parse(String(calls[0].init.body));
  expect(estimatedBody).toMatchObject({
    model: "doubao-tts-2.0",
    modality: "audio",
    strategy: "balanced",
    params: {
      input: "语音制作测试",
      voice: "zh_female_vv_uranus_bigtts",
      response_format: "mp3",
      speed: "1",
    },
  });
  const request = { quoteId: estimate.quoteId, requestId: randomUUID() };
  const first = await createAgentAiSpeech(c, request);
  expect(first).toMatchObject({ status: "processing", providerTaskId: taskId });
  expect(await createAgentAiSpeech(c, request)).toEqual(first);
  expect(
    await createAgentAiSpeech(c, { ...request, requestId: randomUUID() }),
  ).toEqual(first);
  const submitted = calls.filter((x) =>
    x.url.endsWith("/api/v1/model-runtime/invoke"),
  );
  expect(submitted).toHaveLength(1);
  expect(JSON.parse(String(submitted[0].init.body))).toMatchObject({
    modality: "audio",
    operation: "speech",
    params: estimatedBody.params,
    client_request_id: "xuti-audio-" + first.id,
  });
  expect(JSON.parse(String(submitted[0].init.body))).not.toHaveProperty(
    "lane_id",
  );
  const state = await readAgentAiAudio(c);
  expect(JSON.stringify(state)).not.toContain(key);
  expect(JSON.stringify(state)).not.toContain("语音制作测试");
  expect(
    (await query("SELECT payload_encrypted FROM agentai_audio_quotes"))[0]
      .payload_encrypted,
  ).toBe("");
  expect(
    (await query("SELECT count(*)::int AS count FROM ai_model_usage"))[0].count,
  ).toBe(1);
  const audit = (await query("SELECT entity_id,after_data FROM audit_logs"))[0];
  expect(audit.entity_id).toBeNull();
  expect(audit.after_data).toMatchObject({
    taskId: first.id,
    model: "doubao-tts-2.0",
    characters: 6,
  });
});

it("uses true terminal receipts for completion, keeps pending tasks pending and meters the final cost once", async () => {
  const c = admin(),
    quote = await estimateAgentAiAudio(c, input());
  const task = await createAgentAiSpeech(c, {
    quoteId: quote.quoteId,
    requestId: randomUUID(),
  });
  poll = {
    id: taskId,
    model: "doubao-tts-2.0",
    status: "completed",
    is_final: false,
  };
  expect((await refreshAgentAiAudio(c, task.id)).status).toBe("processing");
  await fixture.db!.exec("UPDATE agentai_audio_tasks SET last_polled_at=NULL");
  poll = {
    id: taskId,
    model: "doubao-tts-2.0",
    status: "completed",
    is_final: true,
    output_url: "https://audio.real-cdn.net/result.mp3",
    usage: { characters: 6, cost_rmb: 0.075, cost_currency: "CNY" },
  };
  const completed = await refreshAgentAiAudio(c, task.id);
  expect(completed).toMatchObject({
    status: "completed",
    resultHref: `/api/v1/ai-model-management/agentai/audio/tasks/${task.id}/result`,
  });
  expect(JSON.stringify(completed)).not.toContain("real-cdn");
  expect(await refreshAgentAiAudio(c, task.id)).toEqual(completed);
  const usage = await query("SELECT * FROM ai_model_usage");
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({
    status: "success",
    amount_unit: "CNY",
    provider_request_id: taskId,
  });
  expect(Number(usage[0].amount)).toBe(0.075);
  expect(Number(usage[0].input_characters)).toBe(6);
});

it("requires user ownership even for admin refresh and downloads and never imports shared-key voices", async () => {
  const c = admin(),
    quote = await estimateAgentAiAudio(c, input());
  const task = await createAgentAiSpeech(c, {
    quoteId: quote.quoteId,
    requestId: randomUUID(),
  });
  expect((await readAgentAiAudio(admin("8"))).tasks).toHaveLength(0);
  await expect(refreshAgentAiAudio(admin("8"), task.id)).rejects.toMatchObject(
    error("NOT_FOUND"),
  );
  await expect(agentAiAudioResult(admin("8"), task.id)).rejects.toMatchObject(
    error("NOT_FOUND"),
  );
  const before = calls.length;
  const state = await syncAgentAiVoices(c);
  expect(state.voices).toHaveLength(2);
  expect(calls).toHaveLength(before);
});

it("rejects expired quotes, a changed connection and a higher fallback cost without generating", async () => {
  const c = admin(),
    quote = await estimateAgentAiAudio(c, input());
  quoteResponse.max_effective_total_rmb = 0.2;
  await expect(
    createAgentAiSpeech(c, { quoteId: quote.quoteId, requestId: randomUUID() }),
  ).rejects.toMatchObject(error("AGENTAI_AUDIO_PRICE_CHANGED"));
  await fixture.db!.exec("UPDATE agentai_settings SET version=2");
  await expect(
    createAgentAiSpeech(c, { quoteId: quote.quoteId, requestId: randomUUID() }),
  ).rejects.toMatchObject(error("VERSION_CONFLICT"));
  await fixture.db!.exec(
    "UPDATE agentai_audio_quotes SET expires_at=now()-interval '1 second'",
  );
  await expect(
    createAgentAiSpeech(c, { quoteId: quote.quoteId, requestId: randomUUID() }),
  ).rejects.toMatchObject(error("AGENTAI_AUDIO_QUOTE_EXPIRED"));
  expect(
    calls.filter((x) => x.url.endsWith("/api/v1/model-runtime/invoke")),
  ).toHaveLength(0);
});

it("keeps uncertain submissions durable and does not resubmit or invent a zero bill", async () => {
  const c = admin(),
    quote = await estimateAgentAiAudio(c, input());
  submit = async () => {
    throw Error("socket closed with unknown provider acceptance");
  };
  const request = { quoteId: quote.quoteId, requestId: randomUUID() };
  const task = await createAgentAiSpeech(c, request);
  expect(task).toMatchObject({
    status: "uncertain",
    providerTaskId: null,
    estimatedCny: 0.1,
  });
  expect(await createAgentAiSpeech(c, request)).toEqual(task);
  expect(
    calls.filter((x) => x.url.endsWith("/api/v1/model-runtime/invoke")),
  ).toHaveLength(1);
  expect(
    (await query("SELECT amount FROM ai_model_usage"))[0].amount,
  ).toBeNull();
});

it("clones with explicit current consent, a real uploaded file and an idempotency key, then exposes only the owner's ready voice", async () => {
  const c = admin(),
    form = {
      requestId: randomUUID(),
      name: "我的声音",
      previewText: "你好",
      consentAgreed: "true",
      consentStatementVersion: "voice-v1",
    };
  const file = {
    name: "sample.mp3",
    content: Buffer.from("ID3some fixture audio bytes"),
  };
  await expect(
    createAgentAiVoice(c, { ...form, consentAgreed: "false" }, file),
  ).rejects.toMatchObject(error("VALIDATION_ERROR"));
  await expect(
    createAgentAiVoice(
      c,
      { ...form, consentStatementVersion: "voice-v0" },
      file,
    ),
  ).rejects.toMatchObject(error("VALIDATION_ERROR"));
  submit = async (url, init) => {
    expect(url).toBe("https://agentai.token6688.com/v1/audio/voices");
    expect(init.body).toBeInstanceOf(FormData);
    const body = init.body as FormData;
    expect(body.get("model")).toBe("speech-2.8");
    expect(body.get("consent_agreed")).toBe("true");
    expect(body.get("consent_statement_version")).toBe("voice-v1");
    expect(body.get("file")).toBeInstanceOf(Blob);
    expect(new Headers(init.headers).get("content-type")).toBeNull();
    expect(new Headers(init.headers).get("idempotency-key")).toMatch(
      /^xuti-audio-/,
    );
    return json(
      { id: "omfvc_own_voice", task_id: taskId, status: "processing" },
      202,
    );
  };
  const task = await createAgentAiVoice(c, form, file);
  expect(await createAgentAiVoice(c, form, file)).toEqual(task);
  await expect(
    createAgentAiVoice(c, { ...form, name: "另一名字" }, file),
  ).rejects.toMatchObject(error("IDEMPOTENCY_CONFLICT"));
  expect(calls.filter((x) => x.url.endsWith("/v1/audio/voices"))).toHaveLength(
    1,
  );
  const synced = await syncAgentAiVoices(c);
  expect(synced.voices.find((v) => v.custom)).toMatchObject({
    id: "omfvc_own_voice",
    name: "我的声音",
    status: "ready",
  });
  expect(
    (await readAgentAiAudio(admin("8"))).voices.some((v) => v.custom),
  ).toBe(false);
  expect(
    (await query("SELECT after_data FROM audit_logs"))[0].after_data,
  ).toMatchObject({ consentStatementVersion: "voice-v1" });
  expect(JSON.stringify(await query("SELECT * FROM audit_logs"))).not.toContain(
    "fixture audio",
  );
  poll = {
    id: taskId,
    model: "speech-2.8",
    status: "completed",
    is_final: true,
    usage: { cost_rmb: 0.025, cost_currency: "CNY" },
  };
  expect((await refreshAgentAiAudio(c, task.id)).status).toBe("completed");
  const usage = await query("SELECT * FROM ai_model_usage");
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({
    provider_request_id: taskId,
    feature_id: "agentai_voice_clone",
    amount_unit: "CNY",
    input_tokens: null,
    input_characters: null,
  });
  expect(Number(usage[0].amount)).toBe(0.025);
});

it("does not finalize a model mismatch or a result still transferring to CDN", async () => {
  const c = admin(),
    quote = await estimateAgentAiAudio(c, input());
  const task = await createAgentAiSpeech(c, {
    quoteId: quote.quoteId,
    requestId: randomUUID(),
  });
  poll = {
    id: taskId,
    model: "speech-2.8",
    status: "completed",
    is_final: true,
    output_url: "https://audio.real-cdn.net/result.mp3",
  };
  await expect(refreshAgentAiAudio(c, task.id)).rejects.toMatchObject(
    error("AGENTAI_AUDIO_MODEL_MISMATCH"),
  );
  await fixture.db!.exec("UPDATE agentai_audio_tasks SET last_polled_at=NULL");
  poll.model = "doubao-tts-2.0";
  poll.cdn_pending = true;
  expect((await refreshAgentAiAudio(c, task.id)).status).toBe("processing");
  expect(
    (await query("SELECT amount FROM ai_model_usage"))[0].amount,
  ).toBeNull();
});

it("retains a paid cloned voice after saving the same credential but isolates a different credential", async () => {
  const c = admin();
  submit = async () =>
    json({ id: "omfvc_own_voice", task_id: taskId, status: "processing" }, 202);
  await createAgentAiVoice(
    c,
    {
      requestId: randomUUID(),
      name: "保留音色",
      consentAgreed: "true",
      consentStatementVersion: "voice-v1",
    },
    { name: "sample.mp3", content: Buffer.from("ID3valid fixture") },
  );
  await syncAgentAiVoices(c);
  await fixture.db!.query(
    "UPDATE agentai_settings SET version=2,api_key_encrypted=$1",
    [encryptSecret(key)],
  );
  const kept = await readAgentAiAudio(c);
  expect(kept.voices.find((v) => v.custom)).toMatchObject({
    id: "omfvc_own_voice",
    status: "ready",
  });
  expect(JSON.stringify(kept)).not.toContain("credential_fingerprint");
  await expect(
    estimateAgentAiAudio(c, {
      ...input("speech-2.8"),
      voice: "omfvc_own_voice",
    }),
  ).resolves.toMatchObject({ model: "speech-2.8" });
  await fixture.db!.query(
    "UPDATE agentai_settings SET version=3,api_key_encrypted=$1",
    [encryptSecret("different-fixture-key-not-real")],
  );
  expect((await readAgentAiAudio(c)).voices.some((v) => v.custom)).toBe(false);
  await expect(
    estimateAgentAiAudio(c, {
      ...input("speech-2.8"),
      voice: "omfvc_own_voice",
    }),
  ).rejects.toMatchObject(error("AGENTAI_VOICE_INVALID"));
});

it("recovers a server-interrupted submission as uncertain while preserving its idempotency record", async () => {
  const c = admin(),
    quote = await estimateAgentAiAudio(c, input());
  const request = { quoteId: quote.quoteId, requestId: randomUUID() };
  const task = await createAgentAiSpeech(c, request);
  await fixture.db!.exec(
    "UPDATE agentai_audio_tasks SET status='submitting',provider_task_id=NULL,created_at=now()-interval '3 minutes'",
  );
  expect((await readAgentAiAudio(c)).tasks[0].status).toBe("uncertain");
  expect((await createAgentAiSpeech(c, request)).id).toBe(task.id);
  expect(
    calls.filter((x) => x.url.endsWith("/api/v1/model-runtime/invoke")),
  ).toHaveLength(1);
});

it("rejects unavailable models, unknown voices, forged sample formats and unsafe output URLs before use", async () => {
  const c = admin();
  await expect(
    estimateAgentAiAudio(c, { ...input(), model: "gpt-4o-mini-tts" }),
  ).rejects.toMatchObject(error("VALIDATION_ERROR"));
  await expect(
    estimateAgentAiAudio(c, { ...input(), voice: "omfvc_someone_else" }),
  ).rejects.toMatchObject(error("AGENTAI_VOICE_INVALID"));
  await expect(
    estimateAgentAiAudio(c, {
      ...input("speech-2.8"),
      voice: "omfvc_someone_else",
    }),
  ).rejects.toMatchObject(error("AGENTAI_VOICE_INVALID"));
  expect(() =>
    inspectVoiceSample("sample.wav", Buffer.from("ID3wrong file")),
  ).toThrow();
  expect(() =>
    inspectVoiceSample("sample.mp3", Buffer.alloc(20 * 1024 * 1024)),
  ).toThrow();
  for (const url of [
    "http://audio.cdn.net/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://x.local/x",
    "https://a:b@audio.cdn.net/x",
    "https://audio.cdn.net:8443/x",
  ])
    expect(safeAudioUrl(url)).toBeNull();
  expect(safeAudioUrl("https://audio.real-cdn.net/x.mp3")?.protocol).toBe(
    "https:",
  );
  expect(calls).toHaveLength(0);
});

it("uses the fixed 2.8 version and rejects an unsupported MMX format", () => {
  expect(
    audioParams({
      ...input("speech-2.8"),
      model: "speech-2.8",
      speed: "1",
      emotion: "auto",
      tier: "turbo",
      responseFormat: "mp3",
    }),
  ).toMatchObject({ version: "2.8", tier: "turbo" });
  expect(() =>
    audioParams({
      ...input("speech-2.8"),
      model: "speech-2.8",
      speed: "1",
      emotion: "auto",
      tier: "hd",
      responseFormat: "wav",
    }),
  ).toThrow();
});

it("pins public DNS addresses when proxying audio and rejects private DNS and redirects without exposing credentials", async () => {
  const c = admin(),
    quote = await estimateAgentAiAudio(c, input());
  const task = await createAgentAiSpeech(c, {
    quoteId: quote.quoteId,
    requestId: randomUUID(),
  });
  await fixture.db!.query(
    "UPDATE agentai_audio_tasks SET status='completed',output_url='https://audio.real-cdn.net/result.mp3' WHERE id=$1",
    [task.id],
  );
  fixture.address = "127.0.0.1";
  await expect(agentAiAudioResult(c, task.id)).rejects.toMatchObject(
    error("AGENTAI_AUDIO_DOWNLOAD_FAILED"),
  );
  expect(fixture.downloads).toBe(0);
  fixture.address = "1.1.1.1";
  const result = await agentAiAudioResult(c, task.id);
  expect(result.bytes.toString()).toBe("ID3returned audio");
  expect(result.mime).toBe("audio/mpeg");
  expect(fixture.pinned).toBe("1.1.1.1");
  fixture.redirect = "https://127.0.0.1/private";
  await expect(agentAiAudioResult(c, task.id)).rejects.toMatchObject(
    error("AGENTAI_AUDIO_DOWNLOAD_FAILED"),
  );
  expect(fixture.downloads).toBe(2);
});

it("prefers validated public IPv4 over an earlier IPv6 answer and retries only safe GET candidates", async () => {
  fixture.addresses = [
    { address: "2606:4700:4700::1111", family: 6 },
    { address: "1.1.1.1", family: 4 },
    { address: "8.8.8.8", family: 4 },
  ];
  fixture.failures = ["1.1.1.1"];
  expect(
    (
      await downloadAgentAiAudio("https://audio.real-cdn.net/output.mp3")
    ).toString(),
  ).toBe("ID3returned audio");
  expect(fixture.attempted).toEqual(["1.1.1.1", "8.8.8.8"]);
  expect(calls).toHaveLength(0);
});

it("rejects the whole DNS answer when any candidate is private before attempting a public fallback", async () => {
  fixture.addresses = [
    { address: "1.1.1.1", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await expect(
    downloadAgentAiAudio("https://audio.real-cdn.net/output.mp3"),
  ).rejects.toMatchObject({ code: "AUDIO_DNS_PRIVATE", phase: "DNS" });
  expect(fixture.downloads).toBe(0);
});

it("bounds DNS and all connection candidates within one total deadline", async () => {
  vi.useFakeTimers();
  fixture.addresses = Array.from({ length: 8 }, (_, i) => ({
    address: `8.8.8.${i + 1}`,
    family: 4,
  }));
  fixture.hang = true;
  const result = downloadAgentAiAudio(
    "https://audio.real-cdn.net/output.mp3",
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(25001);
  expect(await result).toMatchObject({ code: "AUDIO_DEADLINE" });
  expect(fixture.downloads).toBeLessThanOrEqual(5);
  expect(vi.getTimerCount()).toBe(0);
  fixture.hang = false;
  fixture.dnsHang = true;
  const dns = downloadAgentAiAudio(
    "https://audio.real-cdn.net/output.mp3",
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(8001);
  expect(await dns).toMatchObject({ code: "AUDIO_DNS_TIMEOUT", phase: "DNS" });
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the total deadline while a connected response never finishes", async () => {
  vi.useFakeTimers();
  fixture.bodyHang = true;
  const result = downloadAgentAiAudio(
    "https://audio.real-cdn.net/output.mp3",
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(25001);
  expect(await result).toMatchObject({
    code: "AUDIO_DEADLINE",
    phase: "DOWNLOAD",
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("shares one total deadline across a delayed redirect and a hanging final response", async () => {
  vi.useFakeTimers();
  fixture.bodyHang = true;
  fixture.redirects = ["https://second.real-cdn.net/final.mp3"];
  fixture.responseDelays = [9000, 0];
  const result = downloadAgentAiAudio(
    "https://audio.real-cdn.net/output.mp3",
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(25001);
  expect(await result).toMatchObject({
    code: "AUDIO_DEADLINE",
    phase: "DOWNLOAD",
  });
  expect(fixture.downloads).toBe(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("logs only task identifier and safe error code/phase when an authorized result cannot be downloaded", async () => {
  const c = admin(),
    quote = await estimateAgentAiAudio(c, input());
  const task = await createAgentAiSpeech(c, {
    quoteId: quote.quoteId,
    requestId: randomUUID(),
  });
  await fixture.db!.query(
    "UPDATE agentai_audio_tasks SET status='completed',output_url='https://audio.real-cdn.net/result.mp3?token=private-fixture-token' WHERE id=$1",
    [task.id],
  );
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  fixture.address = "127.0.0.1";
  await expect(agentAiAudioResult(c, task.id)).rejects.toMatchObject(
    error("AGENTAI_AUDIO_DOWNLOAD_FAILED"),
  );
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0][0])).toEqual({
    event: "agentai_audio_download_failed",
    taskId: task.id,
    code: "AUDIO_DNS_PRIVATE",
    phase: "DNS",
  });
  expect(JSON.stringify(log.mock.calls)).not.toMatch(
    /real-cdn|private-fixture-token|fixture-audio-key/,
  );
});

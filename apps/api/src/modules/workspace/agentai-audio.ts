import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import Busboy from "busboy";
import type { Request } from "express";
import { z } from "zod";
import {
  db,
  one,
  rows,
  type Row,
} from "../../../../../packages/database/src/index.js";
import {
  agentAiAudioInputSchema,
  agentAiCloneSchema,
  agentAiSpeechSchema,
  type AgentAiAudioInput,
  type AgentAiAudioQuote,
  type AgentAiAudioState,
  type AgentAiAudioTask,
  type AgentAiAudioVoice,
} from "../../../../../packages/contracts/src/agentai-audio.js";
import { audit, canonical, fail, parse, type Context } from "../../core.js";
import { aiFetch, recordAiReceipt } from "../../ai-metering.js";
import { requireAIConfiguration } from "../analytics/ai.js";
import {
  decryptSecret,
  encryptSecret,
  encryptionReady,
} from "../analytics/secrets.js";
import {
  agentaiConnection,
  agentaiReady,
  readAgentAiConnection,
} from "./agentai-connection.js";

const origin = "https://agentai.token6688.com";
const source = "agentai.token6688.com";
const allowedModels = new Set(["speech-2.8", "doubao-tts-2.0"]);
const uuid = z.string().uuid();
const remoteId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,179}$/;
const MiB = 1024 * 1024;
const presets: AgentAiAudioVoice[] = [
  {
    id: "female-tianmei",
    name: "甜美女声",
    model: "speech-2.8",
    status: "ready",
    custom: false,
  },
  {
    id: "zh_female_vv_uranus_bigtts",
    name: "豆包 VV 女声",
    model: "doubao-tts-2.0",
    status: "ready",
    custom: false,
  },
];
const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
const credentialFingerprint = (encrypted: string) =>
  hash(decryptSecret(encrypted));
const iso = (v: unknown) => new Date(String(v)).toISOString();
const number = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
export function audioTaskView(row: Row): AgentAiAudioTask {
  return {
    id: row.id,
    kind: row.kind,
    model: row.model,
    name: row.name,
    status: row.status,
    providerTaskId: row.provider_task_id || null,
    voiceId: row.provider_voice_id || null,
    characters: Number(row.characters),
    estimatedCny: row.estimated_cny === null ? null : Number(row.estimated_cny),
    maxCny: row.max_cny === null ? null : Number(row.max_cny),
    errorNote: row.error_note,
    resultHref:
      row.kind === "speech" && row.status === "completed" && row.output_url
        ? `/api/v1/ai-model-management/agentai/audio/tasks/${row.id}/result`
        : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
async function ownedTask(c: Context, id: unknown) {
  requireAIConfiguration(c);
  const task = await one(
    db,
    "SELECT * FROM public.agentai_audio_tasks WHERE id=$1::uuid AND actor_id=$2::bigint",
    parse(uuid, id),
    c.actor.id,
  );
  if (!task) fail("NOT_FOUND", "音频任务不存在", 404);
  return task;
}
async function readyModel(model: string) {
  if (!allowedModels.has(model))
    fail("AGENTAI_AUDIO_MODEL_INVALID", "请选择已接入的语音型号", 400);
  const settings = await agentaiConnection();
  if (
    !Array.isArray(settings.model_catalog) ||
    !settings.model_catalog.some(
      (m: Row) => m.model === model && m.available && m.type === "audio",
    )
  )
    fail(
      "AGENTAI_AUDIO_MODEL_UNAVAILABLE",
      "当前连接未开放这个语音型号，请同步目录",
      409,
    );
  return settings;
}
function headers(encrypted: string, json = true) {
  return {
    authorization: `Bearer ${decryptSecret(encrypted)}`,
    "X-Schedule-Strategy": "balanced",
    ...(json ? { "content-type": "application/json" } : {}),
  };
}
async function readJson(response: Response) {
  if (!response.body) throw Error("EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MiB) throw Error("RESPONSE_LIMIT");
      chunks.push(value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw Error("INVALID_RESPONSE");
    return result as Row;
  } finally {
    void reader.cancel().catch(() => {});
  }
}
async function remoteJson(
  path: string,
  encrypted: string,
  options: RequestInit = {},
) {
  const response = await fetch(origin + path, {
    ...options,
    headers: { ...headers(encrypted), ...options.headers },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    void response.body?.cancel();
    fail(
      "AGENTAI_AUDIO_REQUEST_FAILED",
      `AgentAI 语音请求失败（HTTP ${response.status}），请核对权限与余额`,
      502,
    );
  }
  return readJson(response);
}
export async function readAgentAiAudio(c: Context): Promise<AgentAiAudioState> {
  requireAIConfiguration(c);
  await db.$executeRawUnsafe(
    "UPDATE public.agentai_audio_tasks SET status='uncertain',error_note='提交结果待核对，未自动重新提交；请核对 AgentAI 调用日志',updated_at=now() WHERE actor_id=$1::bigint AND status='submitting' AND created_at<now()-interval '2 minutes'",
    c.actor.id,
  );
  const settings = await readAgentAiConnection();
  const voices =
    settings?.api_key_encrypted && encryptionReady()
      ? await rows(
          db,
          "SELECT id,name,status FROM public.agentai_audio_voices WHERE actor_id=$1::bigint AND credential_fingerprint=$2 ORDER BY created_at DESC LIMIT 100",
          c.actor.id,
          credentialFingerprint(settings.api_key_encrypted),
        )
      : [];
  return {
    ready: agentaiReady(settings),
    voices: [
      ...presets,
      ...voices.map((v) => ({
        id: v.id,
        name: v.name,
        status: v.status,
        model: "speech-2.8" as const,
        custom: true,
      })),
    ],
    tasks: (
      await rows(
        db,
        "SELECT * FROM public.agentai_audio_tasks WHERE actor_id=$1::bigint ORDER BY created_at DESC LIMIT 30",
        c.actor.id,
      )
    ).map(audioTaskView),
    maxCharacters: 5000,
    consentStatementVersion: "voice-v1",
  };
}
async function checkVoice(c: Context, settings: Row, body: AgentAiAudioInput) {
  if (presets.some((v) => v.model === body.model && v.id === body.voice))
    return;
  if (body.model !== "speech-2.8")
    fail("AGENTAI_VOICE_INVALID", "该音色不属于所选模型", 400);
  const own = await one(
    db,
    "SELECT id FROM public.agentai_audio_voices WHERE actor_id=$1::bigint AND credential_fingerprint=$2 AND id=$3 AND status='ready'",
    c.actor.id,
    credentialFingerprint(settings.api_key_encrypted),
    body.voice,
  );
  if (!own) fail("AGENTAI_VOICE_INVALID", "请选择你已完成克隆的音色", 400);
}
export function audioParams(body: AgentAiAudioInput) {
  if (body.model === "speech-2.8" && body.responseFormat !== "mp3")
    fail("AGENTAI_AUDIO_FORMAT", "MMX 语音当前输出 MP3", 400);
  return {
    input: body.input,
    voice: body.voice,
    speed: body.speed,
    emotion: body.emotion,
    ...(body.model === "speech-2.8"
      ? { version: "2.8", tier: body.tier }
      : { response_format: body.responseFormat }),
  };
}
export async function estimateAgentAiAudio(
  c: Context,
  input: unknown,
): Promise<AgentAiAudioQuote> {
  requireAIConfiguration(c);
  const body = parse(agentAiAudioInputSchema, input);
  const settings = await readyModel(body.model);
  await checkVoice(c, settings, body);
  const recent = await one(
    db,
    "SELECT count(*)::int AS count FROM public.agentai_audio_quotes WHERE actor_id=$1::bigint AND created_at>now()-interval '1 minute'",
    c.actor.id,
  );
  if (Number(recent?.count) >= 15)
    fail("RATE_LIMIT", "估价过于频繁，请稍后再试", 429);
  const params = audioParams(body);
  const quote = await remoteJson(
    "/v1/pricing-estimate",
    settings.api_key_encrypted,
    {
      method: "POST",
      body: JSON.stringify({
        model: body.model,
        modality: "audio",
        params,
        strategy: "balanced",
        include_all_channels: true,
      }),
    },
  );
  const estimated = number(quote.effective_total_rmb),
    max = number(quote.max_effective_total_rmb),
    freeze = number(quote.required_freeze_rmb);
  if (
    estimated === null ||
    max === null ||
    freeze === null ||
    max < estimated ||
    freeze < estimated ||
    (Array.isArray(quote.param_adjustments) &&
      quote.param_adjustments.some(
        (v: Row) =>
          v.requested !== null &&
          JSON.stringify(v.requested) !== JSON.stringify(v.applied),
      ))
  )
    fail(
      "AGENTAI_AUDIO_ESTIMATE_INVALID",
      "语音报价缺失或参数发生调整，请重新核对",
      502,
    );
  const id = randomUUID(),
    expires = new Date(Date.now() + 5 * 60000);
  await db.$executeRawUnsafe(
    "DELETE FROM public.agentai_audio_quotes WHERE expires_at<now()-interval '1 day' AND id NOT IN (SELECT quote_id FROM public.agentai_audio_tasks WHERE quote_id IS NOT NULL)",
  );
  await db.$executeRawUnsafe(
    "INSERT INTO public.agentai_audio_quotes(id,actor_id,settings_version,model,payload_encrypted,characters,estimated_cny,max_cny,freeze_cny,expires_at) VALUES($1::uuid,$2::bigint,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)",
    id,
    c.actor.id,
    settings.version,
    body.model,
    encryptSecret(JSON.stringify(body)),
    [...body.input].length,
    estimated,
    max,
    freeze,
    expires.toISOString(),
  );
  return {
    quoteId: id,
    model: body.model,
    characters: [...body.input].length,
    estimatedCny: estimated,
    maxCny: max,
    freezeCny: freeze,
    expiresAt: expires.toISOString(),
  };
}
async function reserveTask(
  c: Context,
  options: {
    requestId: string;
    fingerprint: string;
    settings: Row;
    kind: string;
    model: string;
    name: string;
    characters?: number;
    estimated?: number;
    max?: number;
    format?: string;
    quoteId?: string;
  },
) {
  return db.$transaction(async (tx) => {
    await rows(
      tx,
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
      `agentai-audio:${c.actor.id}`,
    );
    const old = await one(
      tx,
      "SELECT * FROM public.agentai_audio_tasks WHERE actor_id=$1::bigint AND (request_id=$2::uuid OR quote_id=$3::uuid)",
      c.actor.id,
      options.requestId,
      options.quoteId || null,
    );
    if (old) {
      if (old.request_hash !== options.fingerprint)
        fail("IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同内容", 409);
      return { task: old, fresh: false };
    }
    const count = await one(
      tx,
      "SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at>now()-interval '10 seconds')::int AS recent,count(*) FILTER(WHERE status IN ('submitting','processing'))::int AS active FROM public.agentai_audio_tasks WHERE actor_id=$1::bigint AND created_at>now()-interval '1 day'",
      c.actor.id,
    );
    if (
      Number(count?.total) >= 100 ||
      Number(count?.recent) >= 1 ||
      Number(count?.active) >= 5
    )
      fail("RATE_LIMIT", "音频任务过多，请等待当前任务处理后再试", 429);
    const task = await one(
      tx,
      "INSERT INTO public.agentai_audio_tasks(id,actor_id,request_id,request_hash,settings_version,credential_encrypted,kind,model,name,status,characters,estimated_cny,max_cny,response_format,quote_id) VALUES($1::uuid,$2::bigint,$3::uuid,$4,$5,$6,$7,$8,$9,'submitting',$10,$11,$12,$13,$14::uuid) RETURNING *",
      randomUUID(),
      c.actor.id,
      options.requestId,
      options.fingerprint,
      options.settings.version,
      options.settings.api_key_encrypted,
      options.kind,
      options.model,
      options.name,
      options.characters || 0,
      options.estimated ?? null,
      options.max ?? null,
      options.format || "mp3",
      options.quoteId || null,
    );
    await audit(
      tx,
      c,
      options.kind === "clone" ? "agentai.audio.clone" : "agentai.audio.speech",
      "agentai_audio_task",
      // The shared audit entity_id is BIGINT; UUID tasks belong in JSON data.
      null,
      null,
      {
        taskId: task!.id,
        model: options.model,
        characters: options.characters || 0,
        consentStatementVersion:
          options.kind === "clone" ? "voice-v1" : undefined,
      },
    );
    return { task: task!, fresh: true };
  });
}
async function submitTask(
  c: Context,
  task: Row,
  path: string,
  body: string | FormData,
) {
  const feature =
    task.kind === "clone" ? "agentai_voice_clone" : "agentai_speech";
  try {
    const current = await readAgentAiConnection();
    if (
      !current ||
      current.version !== task.settings_version ||
      !agentaiReady(current)
    ) {
      const stopped = await one(
        db,
        "UPDATE public.agentai_audio_tasks SET status='failed',error_note='连接已变更，本次任务未提交，请重新核对连接',updated_at=now() WHERE id=$1::uuid RETURNING *",
        task.id,
      );
      return audioTaskView(stopped!);
    }
    const response = await aiFetch(feature, origin + path, {
      method: "POST",
      headers: {
        ...headers(task.credential_encrypted, typeof body === "string"),
        "Idempotency-Key": "xuti-audio-" + task.id,
      },
      body,
      signal: AbortSignal.timeout(45000),
      redirect: "error",
    });
    const data = await readJson(response);
    const providerId = data.task_id;
    if (typeof providerId === "string" && remoteId.test(providerId)) {
      const voiceId =
        task.kind === "clone" &&
        typeof data.id === "string" &&
        remoteId.test(data.id)
          ? data.id
          : null;
      const updated = await one(
        db,
        "UPDATE public.agentai_audio_tasks SET provider_task_id=$2,provider_voice_id=$3,status='processing',updated_at=now() WHERE id=$1::uuid RETURNING *",
        task.id,
        providerId,
        voiceId,
      );
      if (voiceId)
        await db.$executeRawUnsafe(
          "INSERT INTO public.agentai_audio_voices(id,actor_id,settings_version,name,status,credential_fingerprint) VALUES($1,$2::bigint,$3,$4,'processing',$5) ON CONFLICT(actor_id,credential_fingerprint,id) DO UPDATE SET status='processing'",
          voiceId,
          c.actor.id,
          task.settings_version,
          task.name,
          credentialFingerprint(task.credential_encrypted),
        );
      return audioTaskView(updated!);
    }
    const definite = response.status >= 400 && response.status < 500;
    const updated = await one(
      db,
      "UPDATE public.agentai_audio_tasks SET status=$2,error_note=$3,updated_at=now() WHERE id=$1::uuid RETURNING *",
      task.id,
      definite ? "failed" : "uncertain",
      definite
        ? `供应商未受理（HTTP ${response.status}），请核对权限、余额与参数`
        : "提交结果待核对，未自动重新提交；请核对 AgentAI 调用日志",
    );
    return audioTaskView(updated!);
  } catch {
    const updated = await one(
      db,
      "UPDATE public.agentai_audio_tasks SET status='uncertain',error_note='提交结果待核对，未自动重新提交；请核对 AgentAI 调用日志',updated_at=now() WHERE id=$1::uuid RETURNING *",
      task.id,
    );
    return audioTaskView(updated!);
  }
}
export async function createAgentAiSpeech(c: Context, input: unknown) {
  requireAIConfiguration(c);
  const b = parse(agentAiSpeechSchema, input);
  const old = await one(
    db,
    "SELECT * FROM public.agentai_audio_tasks WHERE actor_id=$1::bigint AND (request_id=$2::uuid OR quote_id=$3::uuid)",
    c.actor.id,
    b.requestId,
    b.quoteId,
  );
  if (old) {
    if (old.request_hash !== hash(b.quoteId))
      fail("IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同内容", 409);
    return audioTaskView(old);
  }
  const quote = await one(
    db,
    "SELECT * FROM public.agentai_audio_quotes WHERE id=$1::uuid AND actor_id=$2::bigint AND expires_at>now()",
    b.quoteId,
    c.actor.id,
  );
  if (!quote)
    fail("AGENTAI_AUDIO_QUOTE_EXPIRED", "报价已过期，请重新估价", 409);
  const body = parse(
    agentAiAudioInputSchema,
    JSON.parse(decryptSecret(quote.payload_encrypted)),
  );
  const settings = await readyModel(body.model);
  if (settings.version !== quote.settings_version)
    fail("VERSION_CONFLICT", "连接已更新，请重新估价", 409);
  await checkVoice(c, settings, body);
  const currentQuote = await remoteJson(
    "/v1/pricing-estimate",
    settings.api_key_encrypted,
    {
      method: "POST",
      body: JSON.stringify({
        model: body.model,
        modality: "audio",
        params: audioParams(body),
        strategy: "balanced",
        include_all_channels: true,
      }),
    },
  );
  const currentMax = number(currentQuote.max_effective_total_rmb),
    currentFreeze = number(currentQuote.required_freeze_rmb),
    currentEstimated = number(currentQuote.effective_total_rmb);
  if (
    currentMax === null ||
    currentFreeze === null ||
    currentEstimated === null ||
    currentMax < currentEstimated ||
    currentFreeze < currentEstimated ||
    currentMax > Number(quote.max_cny) + 0.000001 ||
    currentFreeze > Number(quote.freeze_cny) + 0.000001 ||
    (Array.isArray(currentQuote.param_adjustments) &&
      currentQuote.param_adjustments.some(
        (v: Row) =>
          v.requested !== null &&
          JSON.stringify(v.requested) !== JSON.stringify(v.applied),
      ))
  )
    fail(
      "AGENTAI_AUDIO_PRICE_CHANGED",
      "语音报价已变化，请重新估价并确认",
      409,
    );
  const reserved = await reserveTask(c, {
    requestId: b.requestId,
    fingerprint: hash(b.quoteId),
    settings,
    kind: "speech",
    model: body.model,
    name: body.model === "speech-2.8" ? "MMX 语音合成" : "豆包语音合成",
    characters: quote.characters,
    estimated: Number(quote.estimated_cny),
    max: Number(quote.max_cny),
    format: body.responseFormat,
    quoteId: b.quoteId,
  });
  if (!reserved.fresh) return audioTaskView(reserved.task);
  await db.$executeRawUnsafe(
    "UPDATE public.agentai_audio_quotes SET payload_encrypted='' WHERE id=$1::uuid",
    quote.id,
  );
  return submitTask(
    c,
    reserved.task,
    "/api/v1/model-runtime/invoke",
    JSON.stringify({
      model_id: body.model,
      modality: "audio",
      operation: "speech",
      params: audioParams(body),
      client_request_id: "xuti-audio-" + reserved.task.id,
    }),
  );
}
export function inspectVoiceSample(name: string, bytes: Buffer) {
  if (!bytes.length || bytes.length >= 20 * MiB)
    fail("FILE_LIMIT", "请选择小于20MiB的声音样本", 400);
  const ext = name.toLowerCase().match(/\.(mp3|wav|m4a)$/)?.[1];
  const wav =
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WAVE";
  const mp3 =
    bytes.subarray(0, 3).toString() === "ID3" ||
    (bytes[0] === 255 && (bytes[1] & 224) === 224);
  const m4a = bytes.subarray(4, 8).toString() === "ftyp";
  if (
    (ext === "wav" && wav) ||
    (ext === "mp3" && mp3) ||
    (ext === "m4a" && m4a)
  )
    return {
      name: "voice-sample." + ext,
      mime:
        ext === "mp3"
          ? "audio/mpeg"
          : ext === "wav"
            ? "audio/wav"
            : "audio/mp4",
    };
  fail("FILE_INVALID", "请上传格式与扩展名一致的MP3、WAV或M4A声音样本", 400);
}
export async function createAgentAiVoice(
  c: Context,
  input: unknown,
  file: { name: string; content: Buffer },
) {
  requireAIConfiguration(c);
  const b = parse(agentAiCloneSchema, input),
    sample = inspectVoiceSample(file.name, file.content);
  const settings = await readyModel("speech-2.8");
  const reserved = await reserveTask(c, {
    requestId: b.requestId,
    fingerprint: hash(canonical({ ...b, sample: hash(file.content) })),
    settings,
    kind: "clone",
    model: "speech-2.8",
    name: b.name,
  });
  if (!reserved.fresh) return audioTaskView(reserved.task);
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array(file.content)], { type: sample.mime }),
    sample.name,
  );
  form.set("model", "speech-2.8");
  form.set("name", b.name);
  form.set("preview_text", b.previewText);
  form.set("consent_agreed", "true");
  form.set("consent_statement_version", "voice-v1");
  return submitTask(c, reserved.task, "/v1/audio/voices", form);
}
export async function uploadAgentAiVoice(c: Context, req: Request) {
  requireAIConfiguration(c);
  if (
    !req.is("multipart/form-data") ||
    Number(req.headers["content-length"] || 0) > 21 * MiB
  )
    fail("FILE_INVALID", "请上传一个小于20MiB的声音文件", 400);
  const incoming = await new Promise<{
    body: Record<string, string>;
    file: { name: string; content: Buffer };
  }>((resolve, reject) => {
    const body: Record<string, string> = {};
    let file: { name: string; content: Buffer } | undefined,
      invalid = false;
    const parser = Busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fileSize: 20 * MiB,
        fields: 6,
        fieldSize: 2000,
        parts: 8,
      },
    });
    const timer = setTimeout(() => {
      req.unpipe(parser);
      parser.destroy();
      reject(Error("上传超时"));
    }, 60000);
    parser.on("field", (key, value, info) => {
      if (key in body || info.valueTruncated) invalid = true;
      body[key] = value;
    });
    parser.on("file", (key, stream, info) => {
      if (key !== "file") invalid = true;
      const chunks: Buffer[] = [];
      stream.on("data", (b) => chunks.push(b));
      stream.on("limit", () => {
        invalid = true;
      });
      stream.on("end", () => {
        file = { name: info.filename || "", content: Buffer.concat(chunks) };
      });
      stream.on("error", () => {
        invalid = true;
      });
    });
    for (const event of ["filesLimit", "fieldsLimit", "partsLimit"] as const)
      parser.on(event, () => {
        invalid = true;
      });
    parser.on("error", () => {
      clearTimeout(timer);
      reject(Error("上传失败"));
    });
    req.once("aborted", () => {
      clearTimeout(timer);
      parser.destroy();
      reject(Error("上传中断"));
    });
    parser.on("close", () => {
      clearTimeout(timer);
      if (invalid || !file) reject(Error("上传字段或文件不符合要求"));
      else resolve({ body, file });
    });
    req.pipe(parser);
  }).catch(() =>
    fail("FILE_INVALID", "声音文件上传失败，请检查文件和字段", 400),
  );
  return createAgentAiVoice(c, incoming.body, incoming.file);
}
export async function syncAgentAiVoices(c: Context) {
  requireAIConfiguration(c);
  const settings = await readyModel("speech-2.8");
  // The shared provider key can contain other people's voices. Only reconcile
  // locally created voice IDs owned by this website actor; never import all.
  const own = await rows(
    db,
    "SELECT id FROM public.agentai_audio_voices WHERE actor_id=$1::bigint AND credential_fingerprint=$2 ORDER BY created_at DESC LIMIT 100",
    c.actor.id,
    credentialFingerprint(settings.api_key_encrypted),
  );
  await Promise.allSettled(
    own.slice(0, 20).map(async (voice) => {
      try {
        const remote = await remoteJson(
          "/v1/audio/voices/" + encodeURIComponent(voice.id),
          settings.api_key_encrypted,
        );
        if (remote.id !== voice.id) return;
        await db.$executeRawUnsafe(
          "UPDATE public.agentai_audio_voices SET status=$4 WHERE actor_id=$1::bigint AND credential_fingerprint=$2 AND id=$3",
          c.actor.id,
          credentialFingerprint(settings.api_key_encrypted),
          voice.id,
          remote.status === "ready"
            ? "ready"
            : remote.status === "expired"
              ? "expired"
              : "processing",
        );
      } catch {
        /* A temporary provider failure does not remove a saved voice. */
      }
    }),
  );
  return readAgentAiAudio(c);
}
export async function refreshAgentAiAudio(c: Context, id: unknown) {
  const task = await ownedTask(c, id);
  if (
    ["completed", "failed", "uncertain"].includes(task.status) ||
    !task.provider_task_id
  )
    return audioTaskView(task);
  const lease = await one(
    db,
    "UPDATE public.agentai_audio_tasks SET last_polled_at=now() WHERE id=$1::uuid AND (last_polled_at IS NULL OR last_polled_at<now()-interval '3 seconds') RETURNING id",
    task.id,
  );
  if (!lease) return audioTaskView(task);
  const data = await remoteJson(
    "/v1/tasks/" + encodeURIComponent(task.provider_task_id),
    task.credential_encrypted,
  );
  if ((data.id || data.task_id) !== task.provider_task_id)
    fail("AGENTAI_AUDIO_TASK_MISMATCH", "语音任务回执不匹配", 502);
  if (typeof data.model === "string" && data.model !== task.model)
    fail("AGENTAI_AUDIO_MODEL_MISMATCH", "语音任务型号与提交不一致", 502);
  if (data.is_final !== true || data.cdn_pending === true)
    return audioTaskView(task);
  const completed = data.status === "completed" && !data.error;
  const output =
    completed && task.kind === "speech"
      ? safeAudioUrl(data.output_url)?.href
      : null;
  if (completed && task.kind === "speech" && !output)
    fail("AGENTAI_AUDIO_RESULT_INVALID", "语音结果地址无效，请稍后核对", 502);
  if (task.kind === "clone" && task.provider_voice_id)
    await db.$executeRawUnsafe(
      "UPDATE public.agentai_audio_voices SET status=$4 WHERE actor_id=$1::bigint AND credential_fingerprint=$2 AND id=$3",
      c.actor.id,
      credentialFingerprint(task.credential_encrypted),
      task.provider_voice_id,
      completed ? "ready" : "expired",
    );
  await recordAiReceipt(
    task.kind === "clone" ? "agentai_voice_clone" : "agentai_speech",
    source,
    task.model,
    data,
  );
  const updated = await one(
    db,
    "UPDATE public.agentai_audio_tasks SET status=$2,output_url=$3,error_note=$4,updated_at=now() WHERE id=$1::uuid RETURNING *",
    task.id,
    completed ? "completed" : "failed",
    output,
    completed
      ? ""
      : "供应商语音任务失败；请在 AgentAI 调用日志核对原因，未自动重新提交",
  );
  return audioTaskView(updated!);
}
export function safeAudioUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      isIP(url.hostname) ||
      !url.hostname.includes(".") ||
      /(?:^|\.)(localhost|local|internal|invalid|test|example|onion)$/.test(
        url.hostname,
      )
    )
      return null;
    return url;
  } catch {
    return null;
  }
}
// Keep families separate: Node matches IPv4 addresses against IPv4-mapped
// IPv6 ranges too, so one combined ::ffff:/96 block would reject public IPv4.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedV4.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blockedV6.addSubnet(address, prefix, "ipv6");
async function downloadAudio(value: string, redirects = 0): Promise<Buffer> {
  const url = safeAudioUrl(value);
  if (!url) fail("AGENTAI_AUDIO_RESULT_INVALID", "语音结果地址无效", 502);
  const addresses = await lookup(url.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((a) =>
      a.family === 4
        ? blockedV4.check(a.address, "ipv4")
        : blockedV6.check(a.address, "ipv6"),
    )
  )
    fail("AGENTAI_AUDIO_RESULT_INVALID", "语音结果地址不可访问", 502);
  // Pin the validated public address into the TLS request, preventing a second
  // DNS lookup from rebinding the result request to an internal address.
  const address = addresses[0];
  return new Promise<Buffer>((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        agent: false,
        lookup: (_host, options, done) => {
          if (typeof options === "object" && "all" in options && options.all) {
            (
              done as unknown as (
                error: null,
                values: { address: string; family: number }[],
              ) => void
            )(null, [address]);
          } else done(null, address.address, address.family);
        },
        timeout: 30000,
        headers: { accept: "audio/*,application/octet-stream" },
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
          response.resume();
          if (redirects >= 3 || !response.headers.location)
            return reject(Error("AUDIO_REDIRECT"));
          void downloadAudio(
            new URL(response.headers.location, url).href,
            redirects + 1,
          ).then(resolve, reject);
          return;
        }
        if (
          response.statusCode !== 200 ||
          Number(response.headers["content-length"] || 0) > 64 * MiB
        ) {
          response.resume();
          reject(Error("AUDIO_DOWNLOAD"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 64 * MiB) req.destroy(Error("AUDIO_LIMIT"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          if (!size) reject(Error("AUDIO_EMPTY"));
          else resolve(Buffer.concat(chunks));
        });
        response.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(Error("AUDIO_TIMEOUT")));
    req.on("error", reject);
    req.end();
  });
}
export async function agentAiAudioResult(c: Context, id: unknown) {
  const task = await ownedTask(c, id);
  if (task.kind !== "speech" || task.status !== "completed" || !task.output_url)
    fail("AGENTAI_AUDIO_NOT_READY", "音频尚未完成", 409);
  const bytes = await downloadAudio(task.output_url).catch(() =>
    fail("AGENTAI_AUDIO_DOWNLOAD_FAILED", "音频下载暂未完成，请稍后再试", 502),
  );
  return {
    bytes,
    mime: task.response_format === "wav" ? "audio/wav" : "audio/mpeg",
    filename: `xuti-audio-${task.id}.${task.response_format}`,
  };
}

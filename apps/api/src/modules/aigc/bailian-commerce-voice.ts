import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import Busboy from "busboy";
import type { Request } from "express";
import { HttpException } from "@nestjs/common";
import { z } from "zod";
import {
  db,
  one,
  rows,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import {
  bailianCommerceSpeechCost,
  bailianCommerceVoiceModels,
  bailianCommerceVoiceModelSchema,
  type BailianCommerceVoice,
  type BailianCommerceVoiceCatalog,
  type BailianCommerceVoiceModel,
} from "../../../../../packages/contracts/src/bailian-commerce-voice.js";
import {
  canonical,
  fail,
  hash,
  parse,
  requirePermission,
  type Actor,
  type Context,
} from "../../core.js";
import { runMedia } from "../workspace/agent-media.js";
import {
  BailianVoiceError,
  deleteBailianVoice,
  enrollBailianVoice,
  findBailianVoice,
  getBailianVoiceConnection,
  queryBailianVoice,
  synthesizeBailianVoice,
} from "./bailian-voice-provider.js";

const maxSampleBytes = 10_000_000;
const consentVersion = "bailian-voice-v1";
const uploadInput = z.strictObject({
  requestId: z.uuid(),
  name: z.string().trim().min(1).max(50),
  authorized: z.literal("true"),
  model: bailianCommerceVoiceModelSchema,
});
const previewInput = z.strictObject({
  requestId: z.uuid(),
  text: z.string().trim().min(1).max(120),
});
const speechInput = z.strictObject({
  runId: z.uuid(),
  voiceId: z.uuid(),
  text: z.string().trim().min(1).max(1500),
  maxCny: z.number().positive().max(20),
});
const connectionMissing =
  "请管理员在 AIGC 服务配置中设置百炼北京业务空间和 API Key。";
const uncertainEnrollment =
  "百炼音色创建结果待核对。请刷新本条音色，系统会查询原申请。";
const uncertainSpeech =
  "百炼配音结果待核对。原申请可能已计费，请核对供应商记录。";
const deletedDuringUse = "此音色正在配音，请在当前任务结束后删除。";
const expirationMs = 120_000;
type Connection = NonNullable<
  Awaited<ReturnType<typeof getBailianVoiceConnection>>
>;
type VoiceSnapshot = BailianCommerceVoice & { available: boolean };

function requireVoiceAccess(actor: Actor) {
  requirePermission(actor, "aigc.use");
  requirePermission(actor, "product.read");
}

function snapshot(
  voice: Row,
  connection: Connection | undefined,
): VoiceSnapshot {
  const matched = connection?.workspaceId === voice.workspace_id;
  const pendingExpired =
    voice.status === "pending" &&
    !voice.provider_voice_id &&
    Date.now() - new Date(voice.created_at).getTime() >= expirationMs;
  const status =
    voice.deleting_at || pendingExpired
      ? "unknown"
      : (voice.status as BailianCommerceVoice["status"]);
  const note = voice.deleting_at
    ? "删除结果待核对，可再次尝试删除。"
    : pendingExpired
      ? uncertainEnrollment
      : voice.note ||
        (!matched ? "当前百炼业务空间与此音色绑定的业务空间不同。" : undefined);
  return {
    id: voice.id,
    name: voice.name,
    model: voice.model,
    status,
    available: Boolean(matched && status === "ready"),
    note,
  };
}

export async function bailianCommerceVoiceCatalog(): Promise<BailianCommerceVoiceCatalog> {
  const connection = await getBailianVoiceConnection();
  return {
    configured: Boolean(connection),
    models: bailianCommerceVoiceModels,
    ...(connection ? {} : { reason: connectionMissing }),
  };
}

export async function currentBailianCommerceVoices(
  actor: Actor,
): Promise<VoiceSnapshot[]> {
  if (
    !actor.permissions.includes("aigc.use") ||
    !actor.permissions.includes("product.read")
  )
    return [];
  const connection = await getBailianVoiceConnection();
  if (!connection) return [];
  const own = await rows(
    db,
    "SELECT * FROM public.commerce_bailian_voices WHERE user_id=$1::bigint AND workspace_id=$2 AND status='ready' AND deleted_at IS NULL AND deleting_at IS NULL ORDER BY created_at DESC",
    actor.id,
    connection.workspaceId,
  );
  return own.map((voice) => snapshot(voice, connection));
}

export async function listBailianCommerceVoices(
  actor: Actor,
): Promise<VoiceSnapshot[]> {
  requireVoiceAccess(actor);
  const [own, connection] = await Promise.all([
    rows(
      db,
      "SELECT * FROM public.commerce_bailian_voices WHERE user_id=$1::bigint AND deleted_at IS NULL ORDER BY created_at DESC",
      actor.id,
    ),
    getBailianVoiceConnection(),
  ]);
  return own.map((voice) => snapshot(voice, connection));
}

async function ownedVoice(actor: Actor, id: string, tx: Tx = db, lock = false) {
  const voice = await one(
    tx,
    "SELECT * FROM public.commerce_bailian_voices WHERE user_id=$1::bigint AND id=$2::uuid AND deleted_at IS NULL" +
      (lock ? " FOR UPDATE" : ""),
    actor.id,
    id,
  );
  if (!voice) fail("BAILIAN_VOICE_NOT_FOUND", "找不到可访问的百炼音色。", 404);
  return voice;
}

async function lockVoiceRequestsForUser(tx: Tx, actor: Actor) {
  await rows(
    tx,
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
    "commerce-bailian:" + actor.id,
  );
}

export async function normalizeBailianVoiceSample(
  filename: string,
  content: Buffer,
) {
  const formats: Record<string, string> = {
    ".wav": "wav",
    ".mp3": "mp3",
    ".m4a": "mov",
  };
  const ext = extname(filename).toLowerCase();
  const format = Object.hasOwn(formats, ext) ? formats[ext] : undefined;
  if (!format || !content.length || content.length > maxSampleBytes)
    fail(
      "BAILIAN_VOICE_SAMPLE_INVALID",
      "请上传 10 MB 以内的 WAV、MP3 或 M4A 录音。",
      400,
    );
  const dir = await mkdtemp(join(tmpdir(), "bailian-voice-"));
  const source = join(dir, "source" + ext);
  const target = join(dir, "sample.wav");
  try {
    await writeFile(source, content);
    const log = await runMedia(
      [
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        format,
        "-i",
        source,
        "-map",
        "0:a:0",
        "-t",
        "61",
        "-vn",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-ac",
        "1",
        "-ar",
        "24000",
        "-c:a",
        "pcm_s16le",
        target,
      ],
      undefined,
      30_000,
    );
    if (/Stream #[^\r\n]+Video:(?![^\r\n]*\(attached pic\))/.test(log))
      fail("BAILIAN_VOICE_SAMPLE_INVALID", "请上传不含视频的单人录音。", 400);
    const audio = await readFile(target);
    let pcmLength = 0;
    for (let offset = 12; offset + 8 <= audio.length;) {
      const size = audio.readUInt32LE(offset + 4);
      if (audio.toString("ascii", offset, offset + 4) === "data") {
        pcmLength = Math.min(size, audio.length - offset - 8);
        break;
      }
      offset += 8 + size + (size % 2);
    }
    const duration = pcmLength / 48_000;
    if (duration < 5 || duration > 60)
      fail(
        "BAILIAN_VOICE_SAMPLE_DURATION",
        "录音需为 5～60 秒，建议 10～20 秒清晰的单人讲话。",
        400,
      );
    return audio;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parseSampleUpload(req: Request) {
  if (
    !req.is("multipart/form-data") ||
    Number(req.headers["content-length"] || 0) > maxSampleBytes + 16384
  )
    fail(
      "BAILIAN_VOICE_SAMPLE_INVALID",
      "请上传 10 MB 以内的 WAV、MP3 或 M4A 录音。",
      400,
    );
  return new Promise<{
    fields: Record<string, string>;
    file: { name: string; content: Buffer };
  }>((resolve, reject) => {
    const fields: Record<string, string> = Object.create(null);
    let file: { name: string; content: Buffer } | undefined;
    let invalid = false;
    const parser = Busboy({
      headers: req.headers,
      limits: {
        fileSize: maxSampleBytes + 1,
        files: 1,
        fields: 4,
        fieldSize: 400,
        parts: 6,
      },
    });
    const timedOut = () => {
      req.unpipe(parser);
      parser.destroy();
      reject(Error("upload timed out"));
    };
    const timeout = setTimeout(timedOut, 60_000);
    const onAborted = () => parser.destroy(Error("upload aborted"));
    const finish = () => {
      clearTimeout(timeout);
      req.removeListener("aborted", onAborted);
    };
    req.once("aborted", onAborted);
    parser.on("field", (name, value, info) => {
      if (
        Object.hasOwn(fields, name) ||
        info.valueTruncated ||
        info.nameTruncated
      )
        invalid = true;
      fields[name] = value;
    });
    parser.on("file", (name, stream, info) => {
      if (name !== "file") invalid = true;
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("limit", () => {
        invalid = true;
      });
      stream.on("error", () => {
        invalid = true;
      });
      stream.on("end", () => {
        file = { name: info.filename || "", content: Buffer.concat(chunks) };
      });
    });
    for (const event of ["filesLimit", "fieldsLimit", "partsLimit"] as const)
      parser.on(event, () => {
        invalid = true;
      });
    parser.on("error", (error) => {
      finish();
      reject(error);
    });
    parser.on("close", () => {
      finish();
      if (invalid || !file) reject(Error("invalid upload"));
      else resolve({ fields, file });
    });
    req.pipe(parser);
  }).catch(() =>
    fail(
      "BAILIAN_VOICE_SAMPLE_INVALID",
      "录音上传失败，请检查文件和上传字段。",
      400,
    ),
  );
}

function checkedVoiceRequest(old: Row, fingerprint: string) {
  if (old.request_hash !== fingerprint)
    fail("IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同的音色或录音。");
  if (old.deleted_at)
    fail("BAILIAN_VOICE_NOT_FOUND", "本次创建对应的音色已删除。", 404);
  return old;
}

function safeProviderFailure(error: unknown, fallback: string) {
  if (error instanceof BailianVoiceError && !error.uncertain)
    return error.message;
  return fallback;
}

async function checkBailianVoice(
  voice: Row,
  connection: Connection | undefined,
) {
  if (
    !connection ||
    connection.workspaceId !== voice.workspace_id ||
    voice.deleting_at ||
    !["pending", "unknown"].includes(voice.status)
  )
    return voice;
  const claimed = await one(
    db,
    `
    UPDATE public.commerce_bailian_voices SET checked_at=now()
    WHERE id=$1::uuid AND deleted_at IS NULL AND deleting_at IS NULL AND status IN ('pending','unknown')
      AND (checked_at IS NULL OR checked_at < now()-interval '4 seconds')
      AND (provider_voice_id IS NOT NULL OR status='unknown' OR created_at < now()-interval '2 minutes')
    RETURNING *
  `,
    voice.id,
  );
  if (!claimed) return voice;
  try {
    const known = claimed.provider_voice_id
      ? {
          voiceId: claimed.provider_voice_id as string,
          ...(await queryBailianVoice(
            connection,
            claimed.provider_voice_id,
            claimed.model,
          )),
        }
      : await findBailianVoice(
          connection,
          claimed.provider_prefix,
          claimed.model,
        );
    const status = known?.status || "unknown";
    const note =
      status === "failed"
        ? "百炼无法使用此录音创建音色，请检查录音内容后重新创建。"
        : status === "unknown"
          ? uncertainEnrollment
          : null;
    return (
      (await one(
        db,
        `
      UPDATE public.commerce_bailian_voices SET status=$2,provider_voice_id=COALESCE(provider_voice_id,$3),note=$4
      WHERE id=$1::uuid AND deleted_at IS NULL AND deleting_at IS NULL AND status IN ('pending','unknown')
      RETURNING *
    `,
        voice.id,
        status,
        known?.voiceId ?? null,
        note,
      )) || voice
    );
  } catch {
    return claimed;
  }
}

export async function createBailianCommerceVoice(c: Context, req: Request) {
  requireVoiceAccess(c.actor);
  const { fields, file } = await parseSampleUpload(req);
  const input = parse(uploadInput, fields);
  const sampleHash = createHash("sha256").update(file.content).digest("hex");
  const fingerprint = hash(canonical({ ...input, sampleHash, consentVersion }));
  const previous = await one(
    db,
    "SELECT * FROM public.commerce_bailian_voices WHERE user_id=$1::bigint AND request_id=$2::uuid",
    c.actor.id,
    input.requestId,
  );
  const connection = await getBailianVoiceConnection();
  if (previous)
    return snapshot(
      await checkBailianVoice(
        checkedVoiceRequest(previous, fingerprint),
        connection,
      ),
      connection,
    );
  if (!connection) fail("BAILIAN_VOICE_NOT_CONFIGURED", connectionMissing, 503);
  const audio = await normalizeBailianVoiceSample(
    file.name,
    file.content,
  ).catch((error: unknown) => {
    if (error instanceof HttpException) throw error;
    fail(
      "BAILIAN_VOICE_SAMPLE_INVALID",
      "录音无法解码，请上传有效的 WAV、MP3 或 M4A 文件。",
      400,
    );
  });
  const reserved = await db.$transaction(async (tx) => {
    await lockVoiceRequestsForUser(tx, c.actor);
    const prior = await one(
      tx,
      "SELECT * FROM public.commerce_bailian_voices WHERE user_id=$1::bigint AND request_id=$2::uuid",
      c.actor.id,
      input.requestId,
    );
    if (prior)
      return { voice: checkedVoiceRequest(prior, fingerprint), fresh: false };
    const enrolling = await one(
      tx,
      `
      SELECT count(*) AS total FROM public.commerce_bailian_voices
      WHERE user_id=$1::bigint AND deleted_at IS NULL AND status='pending'
      AND created_at > now()-interval '2 minutes'
    `,
      c.actor.id,
    );
    if (Number(enrolling?.total) >= 3)
      fail(
        "BAILIAN_VOICE_ENROLL_BUSY",
        "当前有多个音色正在创建，请稍候。",
        429,
      );
    const id = randomUUID();
    const prefix = (BigInt("0x" + id.replace(/-/g, "")) % 36n ** 10n)
      .toString(36)
      .padStart(10, "0");
    const voice = (await one(
      tx,
      `
      INSERT INTO public.commerce_bailian_voices
      (id,user_id,request_id,request_hash,name,workspace_id,provider_prefix,model,status,consent_version)
      VALUES ($1::uuid,$2::bigint,$3::uuid,$4,$5,$6,$7,$8,'pending',$9) RETURNING *
    `,
      id,
      c.actor.id,
      input.requestId,
      fingerprint,
      input.name,
      connection.workspaceId,
      prefix,
      input.model,
      consentVersion,
    ))!;
    return { voice, fresh: true };
  });
  if (!reserved.fresh) return snapshot(reserved.voice, connection);
  try {
    const remote = await enrollBailianVoice(connection, {
      model: input.model,
      prefix: reserved.voice.provider_prefix,
      audio,
      mime: "audio/wav",
    });
    const note =
      remote.status === "failed"
        ? "百炼无法使用此录音创建音色，请重新录制。"
        : null;
    const stored = (await one(
      db,
      `
      UPDATE public.commerce_bailian_voices SET provider_voice_id=$2,status=$3,note=$4
      WHERE id=$1::uuid AND deleted_at IS NULL RETURNING *
    `,
      reserved.voice.id,
      remote.voiceId,
      remote.status,
      note,
    ))!;
    return snapshot(stored, connection);
  } catch (error) {
    const rejected = error instanceof BailianVoiceError && !error.uncertain;
    const stored = await one(
      db,
      `
      UPDATE public.commerce_bailian_voices SET status=$2,note=$3
      WHERE id=$1::uuid AND status='pending' AND deleted_at IS NULL RETURNING *
    `,
      reserved.voice.id,
      rejected ? "failed" : "unknown",
      safeProviderFailure(error, uncertainEnrollment),
    );
    return snapshot(
      stored || (await ownedVoice(c.actor, reserved.voice.id)),
      connection,
    );
  }
}

export async function readBailianCommerceVoice(c: Context, rawId: string) {
  requireVoiceAccess(c.actor);
  const id = parse(z.uuid(), rawId);
  const [voice, connection] = await Promise.all([
    ownedVoice(c.actor, id),
    getBailianVoiceConnection(),
  ]);
  return snapshot(await checkBailianVoice(voice, connection), connection);
}

export async function deleteBailianCommerceVoice(c: Context, rawId: string) {
  requireVoiceAccess(c.actor);
  const id = parse(z.uuid(), rawId);
  const connection = await getBailianVoiceConnection();
  const claimed = await db.$transaction(async (tx) => {
    const voice = await one(
      tx,
      "SELECT * FROM public.commerce_bailian_voices WHERE user_id=$1::bigint AND id=$2::uuid FOR UPDATE",
      c.actor.id,
      id,
    );
    if (!voice)
      fail("BAILIAN_VOICE_NOT_FOUND", "找不到可访问的百炼音色。", 404);
    if (voice.deleted_at) return undefined;
    const elapsed = Date.now() - new Date(voice.created_at).getTime();
    if (
      voice.status === "pending" &&
      !voice.provider_voice_id &&
      elapsed < expirationMs
    )
      fail("BAILIAN_VOICE_ENROLL_BUSY", "音色正在创建，请等待创建回执。", 409);
    if (
      voice.deleting_at &&
      Date.now() - new Date(voice.deleting_at).getTime() < expirationMs
    )
      fail("BAILIAN_VOICE_DELETE_PENDING", "音色正在删除，请稍候刷新。", 409);
    if (
      await one(
        tx,
        `
      SELECT id FROM public.commerce_bailian_speech WHERE voice_id=$1::uuid AND status='processing'
      AND created_at > now()-interval '2 minutes' LIMIT 1
    `,
        id,
      )
    )
      fail("BAILIAN_VOICE_IN_USE", deletedDuringUse, 409);
    if (
      (voice.provider_voice_id || voice.status !== "failed") &&
      connection?.workspaceId !== voice.workspace_id
    )
      fail(
        "BAILIAN_VOICE_WORKSPACE_MISMATCH",
        "请恢复该音色所属的百炼业务空间后再删除。",
        409,
      );
    await tx.$executeRawUnsafe(
      "UPDATE public.commerce_bailian_voices SET deleting_at=now() WHERE id=$1::uuid",
      id,
    );
    return voice;
  });
  if (!claimed) return { deleted: true };
  try {
    let remote = claimed.provider_voice_id as string | undefined;
    if (!remote && claimed.status !== "failed" && connection) {
      remote = (
        await findBailianVoice(
          connection,
          claimed.provider_prefix,
          claimed.model,
        )
      )?.voiceId;
      if (!remote)
        fail(
          "BAILIAN_VOICE_DELETE_UNCERTAIN",
          "百炼仍未确认该音色。请稍候再次删除，或检查业务空间中的音色。",
          409,
        );
    }
    if (connection && remote) await deleteBailianVoice(connection, remote);
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "UPDATE public.commerce_bailian_voices SET deleted_at=now() WHERE id=$1::uuid AND deleting_at IS NOT NULL",
        id,
      );
      await tx.$executeRawUnsafe(
        "UPDATE public.commerce_bailian_speech SET audio=NULL WHERE voice_id=$1::uuid",
        id,
      );
    });
  } catch (error) {
    // Keep the voice unavailable when the remote deletion may have happened.
    await db.$executeRawUnsafe(
      `
      UPDATE public.commerce_bailian_voices
      SET deleting_at=CASE WHEN $2::boolean THEN NULL ELSE now()-interval '2 minutes' END
      WHERE id=$1::uuid AND deleted_at IS NULL
    `,
      id,
      !claimed.deleting_at &&
        error instanceof BailianVoiceError &&
        !error.uncertain,
    );
    if (error instanceof HttpException) throw error;
    fail(
      "BAILIAN_VOICE_DELETE_FAILED",
      safeProviderFailure(
        error,
        "删除结果待核对。可用同一音色再次查询或尝试删除。",
      ),
      502,
    );
  }
  return { deleted: true };
}

type SpeechPurpose = "preview" | "commerce";
type SpeechReservation = {
  requestId: string;
  voiceId: string;
  text: string;
  maxCny?: number;
  purpose: SpeechPurpose;
};

async function synthesize(c: Context, input: SpeechReservation) {
  const connection = await getBailianVoiceConnection();
  if (!connection) fail("BAILIAN_VOICE_NOT_CONFIGURED", connectionMissing, 503);
  const digest = hash(input.text);
  const fingerprint = hash(
    canonical([input.voiceId, input.text, input.maxCny ?? null]),
  );
  const reserved = await db.$transaction(async (tx) => {
    await lockVoiceRequestsForUser(tx, c.actor);
    const voice = await ownedVoice(c.actor, input.voiceId, tx, true);
    if (
      voice.workspace_id !== connection.workspaceId ||
      voice.status !== "ready" ||
      voice.deleting_at ||
      !voice.provider_voice_id
    )
      fail(
        "BAILIAN_VOICE_UNAVAILABLE",
        "音色未就绪、已撤销或与当前百炼业务空间不匹配。",
        409,
      );
    if (
      input.purpose === "commerce" &&
      bailianCommerceSpeechCost(voice.model, input.text) > (input.maxCny || 0)
    )
      fail(
        "BAILIAN_VOICE_BUDGET_TOO_LOW",
        "服装口播配音的预计费用超过本次授权上限。",
        409,
      );
    const sameRequest =
      input.purpose === "preview"
        ? await one(
            tx,
            `SELECT s.*,k.request_hash AS key_hash
          FROM public.commerce_bailian_preview_keys k JOIN public.commerce_bailian_speech s ON s.id=k.speech_id
          WHERE k.user_id=$1::bigint AND k.request_id=$2::uuid`,
            c.actor.id,
            input.requestId,
          )
        : await one(
            tx,
            `SELECT *,request_hash AS key_hash FROM public.commerce_bailian_speech
          WHERE user_id=$1::bigint AND purpose='commerce' AND request_id=$2::uuid`,
            c.actor.id,
            input.requestId,
          );
    if (sameRequest) {
      if (sameRequest.key_hash !== fingerprint)
        fail("IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同的口播内容。");
      return { task: sameRequest, fresh: false, voice };
    }
    let sharedPreview =
      input.purpose === "preview"
        ? await one(
            tx,
            `
      SELECT * FROM public.commerce_bailian_speech
      WHERE voice_id=$1::uuid AND preview_digest=$2 AND purpose='preview' AND status IN ('processing','ready','unknown')
    `,
            voice.id,
            digest,
          )
        : undefined;
    const fresh = !sharedPreview;
    if (fresh) {
      const active = await one(
        tx,
        `SELECT count(*) AS total FROM public.commerce_bailian_speech
        WHERE user_id=$1::bigint AND status='processing' AND created_at > now()-interval '2 minutes'`,
        c.actor.id,
      );
      if (Number(active?.total) >= 3)
        fail(
          "BAILIAN_VOICE_PREVIEW_PENDING",
          "当前有多个配音任务处理中，请稍候。",
          409,
        );
      sharedPreview = (await one(
        tx,
        `
        INSERT INTO public.commerce_bailian_speech (id,user_id,voice_id,request_id,purpose,request_hash,status,preview_digest)
        VALUES ($1::uuid,$2::bigint,$3::uuid,$4::uuid,$5,$6,'processing',$7) RETURNING *
      `,
        randomUUID(),
        c.actor.id,
        voice.id,
        input.requestId,
        input.purpose,
        fingerprint,
        input.purpose === "preview" ? digest : null,
      ))!;
    }
    const task = sharedPreview!;
    if (input.purpose === "preview")
      await tx.$executeRawUnsafe(
        `INSERT INTO public.commerce_bailian_preview_keys
        (user_id,request_id,speech_id,request_hash) VALUES ($1::bigint,$2::uuid,$3::uuid,$4)`,
        c.actor.id,
        input.requestId,
        task.id,
        fingerprint,
      );
    return { task, fresh, voice };
  });
  if (!reserved.fresh) {
    if (
      reserved.task.status === "processing" &&
      Date.now() - new Date(reserved.task.created_at).getTime() >= expirationMs
    ) {
      return (
        (await one(
          db,
          `
        UPDATE public.commerce_bailian_speech SET status='unknown',note=$2
        WHERE id=$1::uuid AND status='processing' RETURNING *
      `,
          reserved.task.id,
          uncertainSpeech,
        )) ||
        (await one(
          db,
          "SELECT * FROM public.commerce_bailian_speech WHERE id=$1::uuid",
          reserved.task.id,
        ))!
      );
    }
    return reserved.task;
  }
  try {
    const generated = await synthesizeBailianVoice(connection, {
      model: reserved.voice.model as BailianCommerceVoiceModel,
      voiceId: reserved.voice.provider_voice_id,
      text: input.text,
    });
    return (await one(
      db,
      `
      UPDATE public.commerce_bailian_speech
      SET status='ready',audio=$2::bytea,provider_request_id=$3,billable_characters=$4,note=NULL
      WHERE id=$1::uuid AND status IN ('processing','unknown') RETURNING *
    `,
      reserved.task.id,
      generated.bytes,
      generated.providerRequestId ?? null,
      generated.characters,
    ))!;
  } catch (error) {
    const rejected = error instanceof BailianVoiceError && !error.uncertain;
    return (await one(
      db,
      `
      UPDATE public.commerce_bailian_speech SET status=$2,note=$3
      WHERE id=$1::uuid AND status IN ('processing','unknown') RETURNING *
    `,
      reserved.task.id,
      rejected ? "failed" : "unknown",
      safeProviderFailure(error, uncertainSpeech),
    ))!;
  }
}

export async function previewBailianCommerceVoice(
  c: Context,
  rawId: string,
  body: unknown,
): Promise<Buffer> {
  requireVoiceAccess(c.actor);
  const voiceId = parse(z.uuid(), rawId);
  const input = parse(previewInput, body);
  const task = await synthesize(c, { ...input, voiceId, purpose: "preview" });
  if (task.status === "processing")
    fail(
      "BAILIAN_VOICE_PREVIEW_PENDING",
      "正在生成试听，稍候可继续查看本次试听。",
      409,
    );
  if (task.status === "unknown")
    fail("BAILIAN_VOICE_PREVIEW_UNCERTAIN", task.note || uncertainSpeech, 409);
  if (task.status !== "ready" || !task.audio)
    fail(
      "BAILIAN_VOICE_PREVIEW_FAILED",
      task.note || "百炼未生成有效的试听音频。",
      502,
    );
  return Buffer.from(task.audio);
}

type SpeechResult = {
  audio?: Buffer;
  status: "ready" | "awaiting_audio" | "failed" | "unknown";
  note?: string;
};

export async function advanceBailianCommerceSpeech(
  c: Context,
  input: { runId: string; voiceId: string; text: string; maxCny?: number },
): Promise<SpeechResult> {
  requireVoiceAccess(c.actor);
  const { runId, voiceId, text, maxCny } = parse(speechInput, input);
  try {
    const task = await synthesize(c, {
      requestId: runId,
      voiceId,
      text,
      maxCny,
      purpose: "commerce",
    });
    if (task.status === "ready" && task.audio)
      return { audio: Buffer.from(task.audio), status: "ready" };
    if (task.status === "processing") return { status: "awaiting_audio" };
    if (task.status === "unknown")
      return { status: "unknown", note: task.note || uncertainSpeech };
    return { status: "failed", note: task.note || "百炼未生成有效配音。" };
  } catch (error) {
    if (error instanceof HttpException) {
      const detail = error.getResponse() as {
        error?: { code?: string; message?: string };
      };
      return detail?.error?.code === "BAILIAN_VOICE_PREVIEW_PENDING"
        ? { status: "awaiting_audio" }
        : { status: "failed", note: detail?.error?.message };
    }
    throw error;
  }
}

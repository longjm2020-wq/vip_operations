import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Studio,
  StudioUser,
} from "../../../../../packages/aigc-engine/index.mjs";
import {
  FAL_LIP_SYNC_MAX_SECONDS,
  FAL_LIP_SYNC_MIN_SECONDS,
} from "../../../../../packages/aigc-engine/vendor/cloud/fal-lip-sync.mjs";
import { fail } from "../../core.js";
import { inspectAudio, runMedia } from "../workspace/agent-media.js";

type FalOperation = {
  id: string;
  status: string;
  message?: string;
  duration?: number;
  output?: string;
};
type CommerceFalProfile = { presenterId: string; portraitId: string };
type ActiveCommerceFal = {
  operationId: string;
  status: string;
  message?: string;
};
export type CommerceFalVideo = {
  operationId: string | null;
  status: string;
  content?: Buffer;
  duration?: number;
  message?: string;
};

const portraitSource = "commerce-presenter-portrait";
const outputSource = "commerce-presenter-fal-output";
const maxAudioBytes = 10 * 1024 * 1024;
// Keep enough room for MP3 encoder delay and FFmpeg's reported duration rounding.
const minimumAudioDuration = FAL_LIP_SYNC_MIN_SECONDS + 0.08;
const maximumAudioDuration = FAL_LIP_SYNC_MAX_SECONDS - 0.12;
const maximumTempo = 1.25;

export function commerceFalConfigured(studio: Studio): boolean {
  return Boolean(studio.digitalHuman.lipSync?.configured());
}

function activeResult(op: FalOperation): ActiveCommerceFal {
  return { operationId: op.id, status: op.status, message: op.message };
}

export function findCommerceFalVideo(
  studio: Studio,
  user: StudioUser,
  runId: string,
  profile?: CommerceFalProfile,
): ActiveCommerceFal | undefined {
  const op = studio.digitalHuman.lipSync?.findCommerce(user, runId);
  if (
    op &&
    profile &&
    (op.presenterId !== profile.presenterId ||
      op.portraitId !== profile.portraitId)
  )
    fail("COMMERCE_FAL_RUN_MISMATCH", "这次口播已经绑定到另一份主播素材", 409);
  return op && activeResult(op);
}

export function commerceFalOwnsVideo(
  studio: Studio,
  user: StudioUser,
  operationId: string,
): boolean {
  return Boolean(studio.digitalHuman.lipSync?.readCommerce(user, operationId));
}

async function prepareCommerceFalAudio(audio: Buffer) {
  if (!audio.length || audio.length > maxAudioBytes)
    fail("COMMERCE_FAL_AUDIO", "口播配音须为 10 MB 以内的 MP3", 400);
  const { duration } = await inspectAudio(audio, ".mp3").catch(() =>
    fail("COMMERCE_FAL_AUDIO", "口播配音无法播放，请检查主播音色", 400),
  );
  if (
    duration >= FAL_LIP_SYNC_MIN_SECONDS &&
    duration <= FAL_LIP_SYNC_MAX_SECONDS
  )
    return audio;
  if (duration < 0.5)
    fail("COMMERCE_FAL_AUDIO", "口播配音过短，请补充一段可朗读的文案", 400);
  if (duration > maximumAudioDuration * maximumTempo)
    fail(
      "COMMERCE_FAL_AUDIO_DURATION",
      "配音太长，单段口型视频最多 15 秒。请缩短文案后重试。",
      400,
    );
  const filter =
    duration < FAL_LIP_SYNC_MIN_SECONDS
      ? `apad=whole_dur=${minimumAudioDuration}`
      : `atempo=${(duration / maximumAudioDuration).toFixed(6)}`;
  const dir = await mkdtemp(join(tmpdir(), "xuti-commerce-fal-"));
  try {
    const source = join(dir, "narration.mp3");
    const target = join(dir, "prepared.mp3");
    await writeFile(source, audio);
    await runMedia(
      [
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        "mp3",
        "-i",
        source,
        "-map",
        "0:a:0",
        "-af",
        filter,
        "-ar",
        "24000",
        "-ac",
        "1",
        "-c:a",
        "libmp3lame",
        "-threads",
        "1",
        target,
      ],
      undefined,
      15000,
    );
    return await readFile(target);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function startCommerceFalVideo(
  studio: Studio,
  user: StudioUser,
  profile: CommerceFalProfile,
  runId: string,
  audio: Buffer,
): Promise<CommerceFalVideo> {
  const prior = findCommerceFalVideo(studio, user, runId, profile);
  if (prior) return prior;
  if (!commerceFalConfigured(studio))
    fail(
      "COMMERCE_FAL_UNAVAILABLE",
      "服装口播的 fal 口型服务尚未连接，请联系管理员",
      409,
    );
  const lipSync = studio.digitalHuman.lipSync;
  const waiting = {
    operationId: null,
    status: "awaiting_presenter",
    message: "等待同账号当前服装口播完成",
  } as const;
  if (lipSync.busyCommerce(user)) return waiting;

  const meta = studio.store.getAssetMetadata(profile.portraitId);
  if (
    meta?.ownerId !== user.id ||
    meta.source !== portraitSource ||
    meta.kind !== portraitSource ||
    meta.mime !== "image/jpeg"
  )
    fail("COMMERCE_FAL_PORTRAIT", "主播照片已失效，请重新上传并授权", 404);
  const portrait = await studio.store.readAsset(profile.portraitId);
  if (!portrait)
    fail("COMMERCE_FAL_PORTRAIT", "主播照片已失效，请重新上传并授权", 404);
  const mp3 = await prepareCommerceFalAudio(audio);
  try {
    const op: FalOperation = await lipSync.create(
      user,
      async () => ({
        requestId: runId,
        authorized: "true",
        image: new File([new Uint8Array(portrait.buffer)], "portrait.jpg", {
          type: "image/jpeg",
        }),
        audio: new File([new Uint8Array(mp3)], "narration.mp3", {
          type: "audio/mpeg",
        }),
      }),
      { commerce: true, ...profile },
    );
    return activeResult(op);
  } catch (error) {
    if ((error as { statusCode?: number })?.statusCode === 429) return waiting;
    throw error;
  }
}

export async function readCommerceFalVideo(
  studio: Studio,
  user: StudioUser,
  operationId: string,
): Promise<CommerceFalVideo> {
  const op: FalOperation | undefined =
    studio.digitalHuman.lipSync?.readCommerce(user, operationId);
  if (!op) fail("COMMERCE_FAL_NOT_FOUND", "没有找到此账号的服装口播", 404);
  if (op.status !== "completed") return activeResult(op);
  const metadata = op.output && studio.store.getAssetMetadata(op.output);
  if (
    !op.output ||
    metadata?.ownerId !== user.id ||
    metadata.source !== `${outputSource}:${op.id}` ||
    metadata.projectId !== op.id ||
    metadata.mime !== "video/mp4"
  )
    fail("COMMERCE_FAL_OUTPUT_MISSING", "服装口播原片已失效", 404);
  const result = await studio.store.readAsset(op.output);
  if (!result) fail("COMMERCE_FAL_OUTPUT_MISSING", "服装口播原片已失效", 404);
  return {
    ...activeResult(op),
    content: result.buffer,
    duration: op.duration,
  };
}

import { createHash, randomUUID } from "node:crypto";
import type { Request } from "express";
import { z } from "zod";
import type {
  Studio,
  StudioUser,
} from "../../../../../packages/aigc-engine/index.mjs";
import { fail, parse, requirePermission, type Actor } from "../../core.js";
import {
  advanceCommerceSpeech,
  commerceClonedVoices,
} from "../workspace/agentai-audio.js";

const uuid = z.string().uuid();
const key = z.string().regex(/^[A-Za-z0-9_-]{1,150}$/);
const authorizationVersion = "commerce-presenter-v1";
const providerDefault = "default:provider";
const portraitLimit = 10 * 1024 * 1024;
const activePortraitUploads = new Set<string>();

type Voice = { id: string; name: string; kind: "default" | "cloned" };
type Avatar = { id: string; name: string };
type Presenter = {
  id: string;
  ownerId: string;
  name: string;
  avatarId: string;
  voiceId: string;
  authorizationVersion: string;
  authorizedAt: string;
  revokedAt?: string;
};
type PresenterVideo = {
  operationId: string | null;
  status: string;
  content?: Buffer;
  duration?: number;
  message?: string;
};
const presenterInput = z
  .object({
    name: z.string().trim().min(1).max(50),
    avatarId: key,
    voiceId: z.string().min(1).max(180),
    authorized: z.literal(true),
  })
  .strict();

function asStudioUser(actor: Actor): StudioUser {
  requirePermission(actor, "aigc.use");
  return {
    id: actor.id,
    username: actor.username,
    displayName: actor.displayName,
    role: actor.permissions.includes("aigc.manage")
      ? "super_admin"
      : "operator",
  };
}

const avatarView = ({ id, name }: Avatar): Avatar => ({ id, name });
const presenterRecords = (studio: Studio): Record<string, Presenter> =>
  studio.digitalHuman.data.commercePresenters || {};

async function availableVoices(studio: Studio, actor: Actor): Promise<Voice[]> {
  const settings = studio.digitalHuman.settings();
  const configured: { id: string; label: string }[] = settings.voices || [];
  const defaultVoices: Voice[] = settings.textEnabled
    ? [
        { id: providerDefault, name: "系统音色", kind: "default" },
        ...configured.map(({ id, label }): Voice => ({
          id: `default:voice:${id}`,
          name: label,
          kind: "default",
        })),
      ]
    : [];
  const cloned = await commerceClonedVoices(actor);
  return [
    ...defaultVoices,
    ...cloned.map(({ id, name }): Voice => ({
      id: `cloned:${id}`,
      name,
      kind: "cloned",
    })),
  ];
}

export async function commercePresenterOptions(studio: Studio, actor: Actor) {
  const user = asStudioUser(actor);
  const catalog = studio.digitalHuman.catalog(user);
  const avatars = (catalog.avatars as Avatar[]).map(avatarView);
  const voices = await availableVoices(studio, actor);
  const presenters = Object.values(presenterRecords(studio))
    .filter(
      (item) =>
        item.ownerId === user.id &&
        !item.revokedAt &&
        avatars.some((avatar) => avatar.id === item.avatarId),
    )
    .flatMap((item) => {
      const voice = voices.find((entry) => entry.id === item.voiceId);
      return voice
        ? [{ id: item.id, name: item.name, voiceKind: voice.kind }]
        : [];
    });
  return {
    available: Boolean(catalog.enabled && voices.length > 0),
    presenters,
    avatars,
    voices,
    templates: (catalog.templates as Avatar[]).map(avatarView),
    canClone: Boolean(
      actor.roleCodes?.includes("SUPER_ADMIN") &&
      actor.permissions.includes("analytics.manage"),
    ),
  };
}

export async function saveCommercePresenter(
  studio: Studio,
  actor: Actor,
  input: unknown,
) {
  const user = asStudioUser(actor);
  const body = parse(presenterInput, input);
  const avatar = studio.digitalHuman.avatar(user, body.avatarId);
  const voice = (await availableVoices(studio, actor)).find(
    (item) => item.id === body.voiceId,
  );
  if (!voice)
    fail(
      "COMMERCE_PRESENTER_VOICE_UNAVAILABLE",
      "所选音色暂不可用，请更换后再保存",
      409,
    );
  return studio.store.mutate(
    (data: {
      digitalHuman: { commercePresenters?: Record<string, Presenter> };
    }) => {
      const records = (data.digitalHuman.commercePresenters ??= {});
      const own = Object.values(records).filter(
        (item) => item.ownerId === user.id && !item.revokedAt,
      );
      const existing = own.find(
        (item) =>
          item.name === body.name &&
          item.avatarId === avatar.id &&
          item.voiceId === voice.id,
      );
      if (existing)
        return { id: existing.id, name: existing.name, voiceKind: voice.kind };
      if (own.length >= 100)
        fail(
          "COMMERCE_PRESENTER_LIMIT",
          "最多保存 100 个口播主播，请先移除不用的主播",
          409,
        );
      const id = randomUUID();
      records[id] = {
        id,
        ownerId: user.id,
        name: body.name,
        avatarId: avatar.id,
        voiceId: voice.id,
        authorizationVersion,
        authorizedAt: new Date().toISOString(),
      };
      return { id, name: body.name, voiceKind: voice.kind };
    },
  );
}

export async function removeCommercePresenter(
  studio: Studio,
  actor: Actor,
  id: unknown,
) {
  const user = asStudioUser(actor);
  const presenterId = parse(uuid, id);
  await studio.store.mutate(
    (data: {
      digitalHuman: { commercePresenters?: Record<string, Presenter> };
    }) => {
      const records = data.digitalHuman.commercePresenters;
      if (!records || records[presenterId]?.ownerId !== user.id)
        fail("NOT_FOUND", "口播主播不存在", 404);
      records[presenterId].revokedAt ||= new Date().toISOString();
    },
  );
  return { ok: true };
}

export async function uploadCommercePresenterPortrait(
  studio: Studio,
  actor: Actor,
  req: Request,
) {
  const user = asStudioUser(actor);
  if (activePortraitUploads.has(user.id) || activePortraitUploads.size >= 3)
    fail("COMMERCE_PORTRAIT_BUSY", "形象照正在处理，请稍后再试", 429);
  activePortraitUploads.add(user.id);
  try {
    return await createPortrait(studio, user, req);
  } finally {
    activePortraitUploads.delete(user.id);
  }
}

async function createPortrait(studio: Studio, user: StudioUser, req: Request) {
  const contentType = req.get("Content-Type");
  const maxBytes = portraitLimit + 64 * 1024;
  if (!contentType || !req.is("multipart/form-data"))
    fail("COMMERCE_PORTRAIT_INVALID", "请通过表单上传形象照", 415);
  if (Number(req.get("Content-Length")) > maxBytes)
    fail("COMMERCE_PORTRAIT_INVALID", "形象照须为 10 MB 以内", 413);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      req.resume();
      fail("COMMERCE_PORTRAIT_INVALID", "形象照须为 10 MB 以内", 413);
    }
    chunks.push(chunk);
  }
  const form = await new globalThis.Request(
    "http://localhost/commerce-portrait",
    {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(Buffer.concat(chunks)),
    },
  )
    .formData()
    .catch(() =>
      fail("COMMERCE_PORTRAIT_INVALID", "形象照上传失败，请重新选择", 400),
    );
  const body = parse(
    z.object({
      requestId: uuid,
      templateId: key,
      name: z.string().trim().min(1).max(50),
      authorized: z.literal("true"),
    }),
    Object.fromEntries(form),
  );
  const file = form.get("file");
  if (
    !(file instanceof File) ||
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    !file.size ||
    file.size > portraitLimit ||
    form.getAll("file").length !== 1
  )
    fail(
      "COMMERCE_PORTRAIT_INVALID",
      "请上传 10 MB 以内的 JPG、PNG 或 WebP 形象照",
      400,
    );
  const result = await studio.digitalHuman.createAvatar(user, {
    ...body,
    file,
    authorizationVersion,
  });
  return {
    avatar: result.avatar ? avatarView(result.avatar) : null,
    status: result.operation.status,
    message: result.operation.message,
  };
}

function ownedPresenter(studio: Studio, actor: Actor, id: string) {
  const presenter = presenterRecords(studio)[parse(uuid, id)];
  if (
    !presenter ||
    presenter.ownerId !== actor.id ||
    presenter.revokedAt ||
    presenter.authorizationVersion !== authorizationVersion
  )
    fail(
      "COMMERCE_PRESENTER_UNAVAILABLE",
      "口播主播不存在或已撤销使用授权",
      404,
    );
  return presenter;
}

function speechRequestId(runId: string) {
  const digest = createHash("sha256")
    .update(`commerce-speech:${runId}`)
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export async function startCommercePresenterVideo(
  studio: Studio,
  actor: Actor,
  input: {
    runId: string;
    presenterId: string;
    text: string;
    title?: string;
    maxSpeechCny?: number;
    audio?: Buffer;
  },
): Promise<PresenterVideo> {
  const user = asStudioUser(actor);
  const runId = parse(uuid, input.runId);
  const projectId = `commerce-${runId}`;
  const digital = studio.digitalHuman;
  const previous = Object.values<{
    id: string;
    status: string;
    message?: string;
    ownerId: string;
    projectId: string;
    requestId: string;
  }>(digital.data.operations).find(
    (operation) =>
      operation.ownerId === user.id &&
      operation.projectId === projectId &&
      operation.requestId === projectId,
  );
  if (previous)
    return {
      operationId: previous.id,
      status: previous.status,
      message: previous.message,
    };

  digital.assertEnabled(user);
  const presenter = ownedPresenter(studio, actor, input.presenterId);
  digital.avatar(user, presenter.avatarId);
  if (digital.videoBusy(user))
    return {
      operationId: null,
      status: "awaiting_presenter",
      message: "等待当前数字人任务完成",
    };
  await digital.gpu.assertRunning();
  const voice = (await availableVoices(studio, actor)).find(
    (item) => item.id === presenter.voiceId,
  );
  if (!voice)
    fail(
      "COMMERCE_PRESENTER_VOICE_UNAVAILABLE",
      "主播音色已失效，请在主播设置中重新选择",
      409,
    );
  let audio = input.audio;
  if (!audio && voice.kind === "cloned") {
    const result = await advanceCommerceSpeech(
      { actor, requestId: runId },
      {
        requestId: speechRequestId(runId),
        text: input.text,
        voiceId: voice.id.slice("cloned:".length),
        maxCny: input.maxSpeechCny,
      },
    );
    if (!result.audio)
      return {
        operationId: null,
        status:
          result.task.status === "processing" ||
          result.task.status === "submitting"
            ? "awaiting_audio"
            : result.task.status,
        message: result.task.errorNote || "正在合成主播配音",
      };
    audio = result.audio.bytes;
  }

  // Recheck consent after pending speech or provider I/O and before starting the presenter job.
  ownedPresenter(studio, actor, input.presenterId);
  const voiceId = voice.id.startsWith("default:voice:")
    ? voice.id.slice("default:voice:".length)
    : "";
  if (!digital.data.projects[projectId]) {
    await studio.store.mutate(
      (data: {
        digitalHuman: { projects: Record<string, { ownerId: string }> };
      }) => {
        if (data.digitalHuman.projects[projectId]) return;
        const timestamp = new Date().toISOString();
        Object.assign(data.digitalHuman.projects, {
          [projectId]: {
            id: projectId,
            ownerId: user.id,
            createdAt: timestamp,
            updatedAt: timestamp,
            mode: "video",
            avatarId: presenter.avatarId,
            name: input.title?.trim().slice(0, 80) || "服装带货口播",
            commerceVideo: true,
          },
        });
      },
    );
  }
  const file = audio
    ? new File([new Uint8Array(audio)], "presenter.mp3", { type: "audio/mpeg" })
    : undefined;
  const operation = await digital.createVideo(
    user,
    projectId,
    {
      requestId: projectId,
      avatarId: presenter.avatarId,
      text: input.text,
      voice: voiceId,
      ...(file ? { file } : {}),
    },
    { commerce: true, presenterId: presenter.id },
  );
  return {
    operationId: operation.id,
    status: operation.status,
    message: operation.message,
  };
}

export async function readCommercePresenterVideo(
  studio: Studio,
  actor: Actor,
  operationId: string,
): Promise<PresenterVideo> {
  const user = asStudioUser(actor);
  const operation =
    studio.digitalHuman.data.operations[parse(uuid, operationId)];
  if (
    !operation ||
    operation.ownerId !== user.id ||
    operation.type !== "video" ||
    !studio.digitalHuman.data.projects[operation.projectId]?.commerceVideo
  )
    fail("NOT_FOUND", "口播生成任务不存在", 404);
  const result = {
    operationId,
    status: operation.status,
    duration: operation.duration,
    message: operation.message,
  };
  if (operation.status !== "completed") return result;
  const media = await studio.store.readAsset(operation.output);
  if (
    !media ||
    media.metadata.ownerId !== user.id ||
    media.metadata.projectId !== operation.projectId
  )
    fail("COMMERCE_PRESENTER_OUTPUT_UNAVAILABLE", "口播视频暂不可读取", 409);
  return { ...result, content: media.buffer };
}

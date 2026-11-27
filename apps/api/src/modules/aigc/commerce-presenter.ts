import { createHash, randomUUID } from "node:crypto";
import type { Request } from "express";
import sharp from "sharp";
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
import type { BailianCommerceVoiceModel } from "../../../../../packages/contracts/src/bailian-commerce-voice.js";
import {
  advanceBailianCommerceSpeech,
  bailianCommerceVoiceCatalog,
  currentBailianCommerceVoices,
} from "./bailian-commerce-voice.js";
import {
  commerceFalConfigured,
  commerceFalOwnsVideo,
  findCommerceFalVideo,
  readCommerceFalVideo,
  startCommerceFalVideo,
} from "./commerce-fal.js";

const uuid = z.string().uuid();
const key = z.string().regex(/^[A-Za-z0-9_-]{1,150}$/);
const authorizationVersion = "commerce-presenter-v1";
const providerDefault = "default:provider";
const portraitLimit = 10 * 1024 * 1024;
const activePortraitUploads = new Set<string>();

type Voice = {
  id: string;
  name: string;
  kind: "default" | "cloned";
  provider?: "agentai" | "bailian";
  model?: BailianCommerceVoiceModel;
};
type Avatar = { id: string; name: string; engine?: "fal" };
type Presenter = {
  id: string;
  ownerId: string;
  name: string;
  avatarId: string;
  voiceId: string;
  authorizationVersion: string;
  authorizedAt: string;
  revokedAt?: string;
  engine?: "fal";
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

const avatarView = ({ id, name, engine }: Avatar): Avatar => ({
  id,
  name,
  engine,
});
const presenterRecords = (studio: Studio): Record<string, Presenter> =>
  studio.digitalHuman.data.commercePresenters || {};
const portraitSource = "commerce-presenter-portrait";

type PortraitAsset = {
  id: string;
  ownerId: string;
  source: string;
  kind: string;
  name: string;
  projectId?: string;
};

function ownPortraits(studio: Studio, ownerId: string): PortraitAsset[] {
  return Object.values<PortraitAsset>(studio.store.data.assets || {}).filter(
    (asset) =>
      asset.ownerId === ownerId &&
      asset.source === portraitSource &&
      asset.kind === portraitSource,
  );
}

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
  const [cloned, bailian] = await Promise.all([
    commerceClonedVoices(actor),
    currentBailianCommerceVoices(actor),
  ]);
  return [
    ...defaultVoices,
    ...cloned.map(({ id, name }): Voice => ({
      id: `cloned:${id}`,
      name,
      kind: "cloned",
      provider: "agentai",
    })),
    ...bailian.map(({ id, name, model }): Voice => ({
      id: `bailian:${id}`,
      name,
      kind: "cloned",
      provider: "bailian",
      model,
    })),
  ];
}

function presenterView(
  item: Pick<Presenter, "id" | "name" | "engine">,
  voice: Voice,
) {
  return {
    id: item.id,
    name: item.name,
    voiceKind: voice.kind,
    voiceProvider: voice.provider,
    voiceModel: voice.model,
    engine: item.engine,
  };
}

export async function commercePresenterOptions(studio: Studio, actor: Actor) {
  const user = asStudioUser(actor);
  const catalog = studio.digitalHuman.catalog(user);
  const fal = commerceFalConfigured(studio);
  const avatars = [
    ...((catalog.enabled ? catalog.avatars : []) as Avatar[]).map(avatarView),
    ...(fal
      ? ownPortraits(studio, user.id).map(({ id, name }): Avatar => ({
          id,
          name,
          engine: "fal",
        }))
      : []),
  ];
  const [voices, bailian] = await Promise.all([
    availableVoices(studio, actor),
    bailianCommerceVoiceCatalog(),
  ]);
  const presenters = Object.values(presenterRecords(studio))
    .filter(
      (item) =>
        item.ownerId === user.id &&
        !item.revokedAt &&
        avatars.some((avatar) => avatar.id === item.avatarId),
    )
    .flatMap((item) => {
      const voice = voices.find((entry) => entry.id === item.voiceId);
      return voice && (item.engine !== "fal" || voice.kind === "cloned")
        ? [presenterView(item, voice)]
        : [];
    });
  const script = Boolean(studio.config.openrouterApiKey);
  const presenter = Boolean(catalog.enabled || fal);
  const hasVoice =
    fal && !catalog.enabled
      ? voices.some((voice) => voice.kind === "cloned")
      : voices.length > 0;
  const issues = [];
  if (!script)
    issues.push(
      "脚本服务缺少已验证的共享 OpenRouter 连接，请在 AI 模型管理中配置。",
    );
  if (!presenter)
    issues.push(
      "尚未连接视频口型服务，请在 AIGC 服务配置中设置 fal 或数字人服务。",
    );
  if (!hasVoice)
    issues.push(
      bailian.configured
        ? "还没有可用的主播音色。打开「设置主播」录入或选择已授权的音色。"
        : "还没有可用音色。请管理员配置百炼北京业务空间，或使用已启用的音色服务。",
    );
  if (script && presenter && hasVoice && !presenters.length)
    issues.push("请在「设置主播」绑定形象和音色后生成视频。");
  return {
    available: presenter && hasVoice,
    presenters,
    avatars,
    voices,
    bailian,
    templates: ((catalog.enabled ? catalog.templates : []) as Avatar[]).map(
      avatarView,
    ),
    canClone: Boolean(
      actor.roleCodes?.includes("SUPER_ADMIN") &&
      actor.permissions.includes("analytics.manage"),
    ),
    readiness: {
      script,
      presenter,
      fal,
      profile: presenters.length > 0,
      issues,
    },
  };
}

export async function saveCommercePresenter(
  studio: Studio,
  actor: Actor,
  input: unknown,
) {
  const user = asStudioUser(actor);
  const body = parse(presenterInput, input);
  const photo = ownPortraits(studio, user.id).find(
    (item) => item.id === body.avatarId,
  );
  if (photo && !commerceFalConfigured(studio))
    fail("COMMERCE_FAL_UNAVAILABLE", "fal 口型服务尚未配置", 409);
  const avatar = photo || studio.digitalHuman.avatar(user, body.avatarId);
  const voice = (await availableVoices(studio, actor)).find(
    (item) => item.id === body.voiceId,
  );
  if (!voice)
    fail(
      "COMMERCE_PRESENTER_VOICE_UNAVAILABLE",
      "所选音色暂不可用，请更换后再保存",
      409,
    );
  if (photo && voice.kind !== "cloned")
    fail(
      "COMMERCE_FAL_VOICE_REQUIRED",
      "上传照片的主播需要选择已授权的复刻音色",
      422,
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
      if (existing) return presenterView(existing, voice);
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
        ...(photo ? { engine: "fal" } : {}),
        voiceId: voice.id,
        authorizationVersion,
        authorizedAt: new Date().toISOString(),
      };
      return presenterView(records[id], voice);
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
      templateId: key.optional(),
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
  if (!body.templateId) {
    if (!commerceFalConfigured(studio))
      fail(
        "COMMERCE_FAL_UNAVAILABLE",
        "fal 口型服务尚未配置，当前需要选择数字人模板",
        409,
      );
    const photos = ownPortraits(studio, user.id);
    const existing = photos.find((item) => item.projectId === body.requestId);
    if (!existing && photos.length >= 100)
      fail("COMMERCE_PORTRAIT_LIMIT", "本账号最多可保存 100 张主播照片", 409);
    let photo: Buffer;
    try {
      const image = sharp(Buffer.from(await file.arrayBuffer()), {
        limitInputPixels: 40_000_000,
      });
      const info = await image.metadata();
      if (
        !["jpeg", "png", "webp"].includes(info.format || "") ||
        (info.pages || 1) !== 1
      )
        throw Error("Invalid format");
      const result = await image
        .rotate()
        .resize({
          width: 1536,
          height: 1536,
          fit: "inside",
          withoutEnlargement: true,
        })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 88 })
        .toBuffer({ resolveWithObject: true });
      if (Math.min(result.info.width, result.info.height) < 256)
        fail(
          "COMMERCE_PORTRAIT_INVALID",
          "请选择宽和高都至少 256 像素的主播照片",
          422,
        );
      photo = result.data;
    } catch (error) {
      if (error instanceof Error && "getStatus" in error) throw error;
      return fail(
        "COMMERCE_PORTRAIT_INVALID",
        "无法读取此主播照片，请选择有效的 JPG、PNG 或 WebP",
        422,
      );
    }
    if (existing) {
      const previous = await studio.store.readAsset(existing.id);
      if (
        !previous ||
        existing.name !== body.name ||
        !photo.equals(previous.buffer)
      )
        fail(
          "IDEMPOTENCY_CONFLICT",
          "请求已用于另一张主播照片，请重新上传",
          409,
        );
      return {
        avatar: avatarView({
          id: existing.id,
          name: existing.name,
          engine: "fal",
        }),
        status: "completed",
      };
    }
    const asset = await studio.store.putAsset({
      buffer: photo,
      name: body.name,
      kind: portraitSource,
      source: portraitSource,
      mime: "image/jpeg",
      ownerId: user.id,
      projectId: body.requestId,
    });
    return {
      avatar: avatarView({ id: asset.path, name: body.name, engine: "fal" }),
      status: "completed",
    };
  }
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

export function commercePresenterEngine(
  studio: Studio,
  actor: Actor,
  id: string,
) {
  return ownedPresenter(studio, actor, id).engine;
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
  const presenter = ownedPresenter(studio, actor, input.presenterId);
  if (presenter.engine === "fal") {
    const existing = findCommerceFalVideo(studio, user, runId, {
      portraitId: presenter.avatarId,
      presenterId: presenter.id,
    });
    if (existing) return existing;
    if (
      !commerceFalConfigured(studio) ||
      !ownPortraits(studio, user.id).some(
        (photo) => photo.id === presenter.avatarId,
      )
    )
      fail(
        "COMMERCE_FAL_UNAVAILABLE",
        "口型连接或主播照片已失效，请在设置主播中检查",
        409,
      );
  }
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

  if (presenter.engine !== "fal") {
    digital.assertEnabled(user);
    digital.avatar(user, presenter.avatarId);
    if (digital.videoBusy(user))
      return {
        operationId: null,
        status: "awaiting_presenter",
        message: "等待当前数字人任务完成",
      };
    await digital.gpu.assertRunning();
  }
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
  if (!audio && voice.provider === "bailian") {
    const result = await advanceBailianCommerceSpeech(
      { actor, requestId: runId },
      {
        runId,
        text: input.text,
        voiceId: voice.id.slice("bailian:".length),
        maxCny: input.maxSpeechCny,
      },
    );
    if (!result.audio)
      return {
        operationId: null,
        status: result.status === "unknown" ? "uncertain" : result.status,
        message: result.note || "正在合成百炼主播配音",
      };
    audio = result.audio;
  } else if (!audio && voice.provider === "agentai") {
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
  if (
    voice.provider === "bailian" &&
    !(await currentBailianCommerceVoices(actor)).some(
      (entry) => `bailian:${entry.id}` === voice.id,
    )
  )
    fail(
      "COMMERCE_PRESENTER_VOICE_UNAVAILABLE",
      "百炼音色已删除或连接已切换，请重新选择主播音色",
      409,
    );
  if (presenter.engine === "fal") {
    if (!audio)
      fail(
        "COMMERCE_FAL_VOICE_REQUIRED",
        "生成 fal 口播前需要选择复刻音色",
        422,
      );
    return startCommerceFalVideo(
      studio,
      user,
      { portraitId: presenter.avatarId, presenterId: presenter.id },
      runId,
      audio,
    );
  }
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
  parse(uuid, operationId);
  if (commerceFalOwnsVideo(studio, user, operationId))
    return readCommerceFalVideo(studio, user, operationId);
  const operation = studio.digitalHuman.data.operations[operationId];
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

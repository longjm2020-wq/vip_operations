import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { z } from "zod";
import {
  db,
  one,
  rows,
  type Row,
} from "../../../../../packages/database/src/index.js";
import {
  documentJobSchema,
  imageJobSchema,
  videoJobSchema,
  videoGenerationSchema,
  type AgentJob,
} from "../../../../../packages/contracts/src/assistant-agent.js";
import { assistantPublicText } from "../../../../../packages/contracts/src/ai-presentation.js";
import { fail, parse, type Context } from "../../core.js";
import { requireAssistant } from "./assistant-memory.js";
import {
  agentFileView,
  ownedAgentFiles,
  saveAgentFile,
  inspectAgentUpload,
} from "./agent-files.js";
import { resolveImageModel } from "./agent-models.js";
import { createAgentDocument } from "./agent-documents.js";
import { editVideo } from "./agent-media.js";
import { decryptSecret, encryptionReady } from "../analytics/secrets.js";
import sharp from "sharp";
import { generateTeamVideo, resolveTeamVideoModel } from "./team-video.js";

const common = {
  title: { type: "string", description: "简短的文件/任务名称" },
};
export const agentToolDefinitions = [
  {
    type: "function",
    function: {
      name: "create_document",
      description:
        "按用户要求创建或根据附件内容整理可下载的办公文件。将实际内容写入sections；不执行代码、宏或公式，不覆盖原文件。返回后台任务ID，任务完成后才有文件。",
      parameters: {
        type: "object",
        properties: {
          ...common,
          format: {
            type: "string",
            enum: ["docx", "xlsx", "pptx", "md", "txt", "csv"],
          },
          sections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                heading: { type: "string" },
                text: { type: "string" },
                rows: {
                  type: "array",
                  items: {
                    type: "array",
                    items: { type: ["string", "number", "boolean", "null"] },
                  },
                },
              },
              required: ["heading", "text", "rows"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "format", "sections"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "根据用户明确要求生图或参考图片编辑，使用界面选择的图像创作服务，每次一张。原始图片保持不变。仅能引用本次/历史对话的附件ID，返回后台任务。",
      parameters: {
        type: "object",
        properties: {
          ...common,
          prompt: { type: "string" },
          referenceIds: { type: "array", items: { type: "string" } },
          aspectRatio: {
            type: "string",
            enum: ["1:1", "16:9", "9:16", "4:3", "3:4"],
          },
        },
        required: ["title", "prompt", "referenceIds", "aspectRatio"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_video",
      description:
        "真实剪辑已上传视频：按clips顺序裁切和拼接，可0.5~2倍速、静音、调整画幅（等比缩放留边），成片最长10分钟。时间以秒为单位，不支持无素材文生视频、音轨识别、字幕或自动精确镜头定位。返回后台任务，成功才可下载MP4。",
      parameters: {
        type: "object",
        properties: {
          ...common,
          clips: {
            type: "array",
            items: {
              type: "object",
              properties: {
                fileId: { type: "string" },
                start: { type: "number" },
                end: { type: "number" },
                speed: { type: "number" },
              },
              required: ["fileId", "start", "end", "speed"],
              additionalProperties: false,
            },
          },
          aspectRatio: {
            type: "string",
            enum: ["original", "16:9", "9:16", "1:1"],
          },
          mute: { type: "boolean" },
        },
        required: ["title", "clips", "aspectRatio", "mute"],
        additionalProperties: false,
      },
    },
  },
];
export async function queueAgentJob(
  c: Context,
  name: string,
  args: string,
  requestId: string,
  callId: string,
  allowedIds: string[],
  imageRef?: string,
  videoRef?: string,
  teamLease?: string,
) {
  requireAssistant(c);
  if (args.length > 100000)
    fail("TOOL_INVALID", "任务内容过大，请分段处理", 400);
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    fail("TOOL_INVALID", "任务参数无效", 400);
  }
  const kind =
    name === "create_document"
      ? "document"
      : name === "generate_image"
        ? "image"
        : name === "edit_video" || name === "generate_video"
          ? "video"
          : null;
  if (!kind) fail("TOOL_INVALID", "工具不可用", 400);
  const parsed =
    kind === "document"
      ? parse(documentJobSchema, value)
      : kind === "image"
        ? parse(imageJobSchema, value)
        : name === "generate_video"
          ? parse(videoGenerationSchema, value)
          : parse(videoJobSchema, value);
  const body: Row = { ...parsed };
  body.title = assistantPublicText(body.title);
  const refs: string[] =
    kind === "image" || name === "generate_video"
      ? body.referenceIds
      : kind === "video"
        ? body.clips.map((clip: Row) => clip.fileId)
        : [];
  if (refs.some((id) => !allowedIds.includes(id)))
    fail("FILE_SCOPE", "请先将所需素材附加到本次对话", 400);
  const files = await ownedAgentFiles(c, refs);
  if (kind === "image") {
    if (files.some((f) => !f.mime.startsWith("image/")))
      fail("FILE_TYPE", "参考素材必须为图片", 400);
    const model = await resolveImageModel(imageRef);
    if (!model.aspects.includes(body.aspectRatio))
      fail(
        "IMAGE_ASPECT",
        "所选图像能力不支持此画幅，可用比例：" +
          model.aspects.filter((v) => v !== "auto").join("、"),
        400,
      );
    if (refs.length && !model.reference)
      fail("IMAGE_REFERENCE", "所选图像能力不支持参考图，请重新选择", 400);
    body.model = model.actual;
  }
  if (name === "generate_video") {
    if (files.some((f) => !f.mime.startsWith("image/")))
      fail("FILE_TYPE", "视频生成参考素材必须为图片", 400);
    const selected = await resolveTeamVideoModel(
      c,
      videoRef,
      body as { duration: number; aspectRatio: string; referenceIds: string[] },
    );
    body.generation = true;
    body.videoSelection = selected.selection;
    body.model = selected.info.model;
  }
  if (kind === "video" && name !== "generate_video")
    for (const clip of body.clips) {
      const file = files.find((f) => f.id === clip.fileId);
      if (
        !file?.mime.startsWith("video/") ||
        clip.end > Number(file.metadata?.duration) + 0.1
      )
        fail("VIDEO_RANGE", "素材类型或裁切时间无效，请核对视频时长", 400);
    }
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      "assistant-jobs:" + c.actor.id,
    );
    if (teamLease) {
      const parent = await one(
        tx,
        "SELECT id FROM public.personal_assistant_team_runs WHERE id=$1::uuid AND user_id=$2::bigint AND lease_id=$3::uuid AND status IN ('PLANNING','RUNNING','REVIEWING') FOR UPDATE",
        requestId,
        c.actor.id,
        teamLease,
      );
      if (!parent)
        fail("TEAM_STOPPED", "团队任务已停止，未提交新的创作任务", 409);
    }
    const previous = await one(
      tx,
      "SELECT id,status FROM public.personal_assistant_jobs WHERE user_id=$1::bigint AND request_id=$2::uuid AND call_id=$3",
      c.actor.id,
      requestId,
      callId,
    );
    if (previous)
      return { id: previous.id, status: previous.status, title: body.title };
    const active = await one(
      tx,
      "SELECT count(*)::int AS n FROM public.personal_assistant_jobs WHERE user_id=$1::bigint AND status IN ('QUEUED','RUNNING')",
      c.actor.id,
    );
    if (active!.n >= 5)
      fail("JOBS_BUSY", "已有5个任务在处理中，请等待完成后继续", 409);
    const id = randomUUID();
    await tx.$executeRawUnsafe(
      "INSERT INTO public.personal_assistant_jobs(id,user_id,request_id,call_id,kind,title,input,model) VALUES($1::uuid,$2::bigint,$3::uuid,$4,$5,$6,$7::jsonb,$8)",
      id,
      c.actor.id,
      requestId,
      callId,
      kind,
      body.title,
      JSON.stringify(body),
      body.model || null,
    );
    return {
      id,
      status: "QUEUED",
      title: body.title,
      note: "已加入后台任务，尚未完成。结果显示在任务与文件，不要声称已生成成功。",
    };
  });
}
export async function listAgentJobs(c: Context): Promise<AgentJob[]> {
  requireAssistant(c);
  const jobs = await rows(
    db,
    "SELECT id,request_id,kind,title,status,stage,progress,output_ids,error_note,created_at,updated_at FROM public.personal_assistant_jobs WHERE user_id=$1::bigint ORDER BY created_at DESC LIMIT 60",
    c.actor.id,
  );
  const ids = jobs.flatMap((j) => j.output_ids);
  const files = ids.length
    ? await rows(
        db,
        "SELECT id,name,mime,size,source,metadata,created_at FROM public.personal_assistant_files WHERE user_id=$1::bigint AND id=ANY($2::uuid[])",
        c.actor.id,
        ids,
      )
    : [];
  return jobs.map((j) => ({
    id: j.id,
    requestId: j.request_id,
    kind: j.kind,
    title: assistantPublicText(j.title),
    status: j.status,
    stage: assistantPublicText(j.stage),
    progress: j.progress,
    error: assistantPublicText(j.error_note),
    files: files.filter((f) => j.output_ids.includes(f.id)).map(agentFileView),
    createdAt: new Date(j.created_at).toISOString(),
    updatedAt: new Date(j.updated_at).toISOString(),
  }));
}
export async function cancelAgentJob(c: Context, id: string) {
  requireAssistant(c);
  parse(z.string().uuid(), id);
  const row = await one(
    db,
    "UPDATE public.personal_assistant_jobs SET status='CANCELED',stage='已取消',updated_at=now() WHERE id=$1::uuid AND user_id=$2::bigint AND status='QUEUED' RETURNING id",
    id,
    c.actor.id,
  );
  if (!row) fail("JOB_STATE", "任务已开始或结束，无法取消排队", 409);
  return { canceled: true };
}
export const safeAgentError = (e: unknown) =>
  assistantPublicText(
    e instanceof HttpException
      ? (e.getResponse() as Row).error?.message || "任务服务暂不可用"
      : e instanceof Error &&
          /^(媒体|视频|裁切|成片|图像|文档|任务|个人|所选)/.test(e.message)
        ? e.message.slice(0, 220)
        : "任务处理失败，请检查素材与参数后重新发起；未自动重试",
  );
export async function runAgentJob(
  c: Context,
  job: Row,
  progress: (n: number, stage: string) => Promise<void>,
  signal: AbortSignal,
) {
  requireAssistant(c);
  await progress(5, "准备素材");
  let content: Buffer, mime: string, name: string;
  if (job.kind === "document") {
    const input = parse(documentJobSchema, job.input);
    await progress(35, "整理文档内容");
    ({ content, mime } = await createAgentDocument(input));
    name = input.title + "." + input.format;
  } else if (job.kind === "video" && job.input.generation) {
    content = await generateTeamVideo(c, job, progress, signal);
    mime = "video/mp4";
    name = job.input.title + ".mp4";
  } else if (job.kind === "video") {
    const input = parse(videoJobSchema, job.input);
    const files = await ownedAgentFiles(
      c,
      input.clips.map((v) => v.fileId),
      true,
    );
    content = await editVideo(
      input,
      new Map(
        files.map((f) => [
          f.id,
          {
            content: Buffer.from(f.content),
            duration: f.metadata.duration,
            audio: !!f.metadata.audio,
          },
        ]),
      ),
      progress,
      signal,
    );
    mime = "video/mp4";
    name = input.title + ".mp4";
  } else if (job.kind === "image") {
    const { model, ...raw } = job.input,
      input = parse(imageJobSchema, raw);
    const settings = await one(
      db,
      "SELECT enabled,verified_at,api_key_encrypted FROM public.compass_ai_settings WHERE id=1",
    );
    if (
      !encryptionReady() ||
      !settings?.enabled ||
      !settings.verified_at ||
      !settings.api_key_encrypted
    )
      throw Error("图像服务未启用或未验证");
    const files = await ownedAgentFiles(c, input.referenceIds, true);
    const refs = await Promise.all(
      files.map(async (file) => ({
        type: "image_url",
        image_url: {
          url:
            "data:image/png;base64," +
            (
              await sharp(Buffer.from(file.content))
                .resize({
                  width: 1800,
                  height: 1800,
                  fit: "inside",
                  withoutEnlargement: true,
                })
                .png()
                .toBuffer()
            ).toString("base64"),
        },
      })),
    );
    await progress(20, "图像创作中");
    const response = await fetch("https://openrouter.ai/api/v1/images", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
      headers: {
        Authorization: "Bearer " + decryptSecret(settings.api_key_encrypted),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        n: 1,
        aspect_ratio: input.aspectRatio,
        output_format: "png",
        ...(refs.length ? { input_references: refs } : {}),
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(
        `图像服务返回 HTTP ${response.status}，请检查服务配置、余额或稍后重试`,
      );
    }
    const reader = response.body!.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > 40 * 1024 * 1024) {
        await reader.cancel();
        throw Error("图像返回文件过大");
      }
      chunks.push(r.value);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    if (payload.model && payload.model !== model)
      throw Error("图像服务返回信息不符，未采用结果");
    if (typeof payload.data?.[0]?.b64_json !== "string")
      throw Error("图像服务没有返回图片，未采用结果");
    content = await sharp(Buffer.from(payload.data[0].b64_json, "base64"), {
      limitInputPixels: 40000000,
    })
      .png()
      .toBuffer();
    mime = "image/png";
    name = input.title + ".png";
  } else throw Error("任务类型不受支持");
  signal.throwIfAborted();
  await progress(95, "保存处理结果");
  const inspection = await inspectAgentUpload(name, content, true);
  signal.throwIfAborted();
  await progress(98, "核验任务并归档文件");
  const file = await saveAgentFile(
    c,
    name,
    mime,
    content,
    "generated",
    inspection.text,
    { ...inspection.metadata, jobId: job.id },
    undefined,
    { id: job.id, leaseId: job.lease_id },
  );
  return [file.id];
}

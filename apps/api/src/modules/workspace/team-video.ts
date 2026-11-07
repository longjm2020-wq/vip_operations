import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import {
  videoProviders,
  videoKey,
  selectVideoRoute,
  validateVideoInput,
  preflightXhaiVideo,
  submitVideo,
  XhaiVideoAdjustmentError,
  pollVideo,
  uploadXhaiImages,
  withJobSignal,
} from "../../../../../packages/aigc-engine/team-video.mjs";
import {
  db,
  one,
  type Row,
} from "../../../../../packages/database/src/index.js";
import { videoGenerationSchema } from "../../../../../packages/contracts/src/assistant-agent.js";
import type { TeamVideoModel } from "../../../../../packages/contracts/src/assistant-team.js";
import { fail, parse, requirePermission, type Context } from "../../core.js";
import { engineConfig } from "../aigc/config.js";
import { ownedAgentFiles } from "./agent-files.js";
import { modelRef } from "./agent-models.js";

const signature = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function catalog(c: Context) {
  if (!c.actor.permissions.includes("aigc.use")) return [];
  const config = await engineConfig();
  return videoProviders(config).flatMap((provider) =>
    provider.models.flatMap((model) => {
      if (model.legacy) return [];
      const route = selectVideoRoute(config, {
        providerId: provider.id,
        modelId: model.id,
      });
      if (!videoKey(config, route)) return [];
      const info: TeamVideoModel = {
        id: modelRef(`video/${provider.id}/${model.id}`),
        name: `${provider.label} · ${model.label}`,
        model: model.model,
        durations: route.model.durations.filter((n) => n <= 15),
        aspects: model.aspects,
        minImages: model.inputMode === "first-frame" ? 1 : 2,
        maxImages: Math.min(4, model.maxImages),
        resolution: route.resolution,
      };
      return info.durations.length
        ? [
            {
              config,
              route,
              info,
              selection: {
                providerId: provider.id,
                modelId: model.id,
                resolution: route.resolution,
                signature: signature(route),
              },
            },
          ]
        : [];
    }),
  );
}
export async function publicTeamVideoCatalog(
  c: Context,
): Promise<TeamVideoModel[]> {
  return (await catalog(c)).map((item) => item.info);
}
export async function resolveTeamVideoModel(
  c: Context,
  ref?: string,
  input?: { duration: number; aspectRatio: string; referenceIds: string[] },
) {
  requirePermission(c.actor, "aigc.use");
  const models = await catalog(c);
  const matches = (m: (typeof models)[number]) =>
    !input ||
    (m.info.durations.includes(input.duration) &&
      m.info.aspects.includes(input.aspectRatio) &&
      input.referenceIds.length >= m.info.minImages &&
      input.referenceIds.length <= m.info.maxImages);
  const found = ref
    ? models.find((m) => m.info.id === ref)
    : models.find(matches);
  if (!found)
    fail(
      "VIDEO_UNAVAILABLE",
      "视频生成服务未配置或没有适合本次素材、时长和画幅的模型，请在 AIGC 服务设置中检查",
      400,
    );
  if (!matches(found))
    fail(
      "VIDEO_CAPABILITY",
      "所选视频模型不支持本次参考图数量、时长或画幅；未替换模型，请调整参数",
      400,
    );
  return found;
}

export const videoGenerationTool = {
  type: "function",
  function: {
    name: "generate_video",
    description:
      "使用已配置的 AIGC 视频模型生成真实短片，最长15秒。需要本任务授权的1至4张参考图（具体数量/时长/画幅见视频目录）。返回后台任务ID，必须等待真实文件完成才能交付；不改变用户指定模型、时长或画幅。没有参考图时可先由图像成员生成。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["title", "prompt", "referenceIds", "duration", "aspectRatio"],
      properties: {
        title: { type: "string" },
        prompt: { type: "string" },
        referenceIds: { type: "array", items: { type: "string" } },
        duration: { type: "integer", minimum: 1, maximum: 15 },
        aspectRatio: {
          type: "string",
          enum: ["16:9", "9:16", "1:1", "4:3", "3:4"],
        },
      },
    },
  },
};

const privateV4 = new BlockList(),
  privateV6 = new BlockList();
for (const [ip, prefix] of [
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
  ["224.0.0.0", 3],
] as const)
  privateV4.addSubnet(ip, prefix, "ipv4");
for (const [ip, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const)
  privateV6.addSubnet(ip, prefix, "ipv6");
export function publicVideoAddress(address: string) {
  const family = isIP(address);
  return family === 4
    ? !privateV4.check(address, "ipv4")
    : family === 6 && !privateV6.check(address, "ipv6");
}
/** Pin a public DNS result for every redirect; never fetch local/private URLs returned by providers. */
export async function downloadTeamVideo(
  raw: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<Buffer> {
  const url = new URL(raw),
    host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    redirects > 3
  )
    throw Error("视频结果地址不受支持");
  signal.throwIfAborted();
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (
    !addresses.length ||
    addresses.some((item) => !publicVideoAddress(item.address))
  )
    throw Error("视频结果地址不属于公开网络");
  const address = addresses[0];
  const response = await new Promise<import("node:http").IncomingMessage>(
    (resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
          lookup: (_hostname, options, callback) => {
            if (options.all)
              callback(null, [
                { address: address.address, family: address.family },
              ]);
            else callback(null, address.address, address.family);
          },
        },
        resolve,
      );
      req.on("error", reject);
      req.end();
    },
  );
  if (
    [301, 302, 303, 307, 308].includes(response.statusCode || 0) &&
    response.headers.location
  ) {
    response.destroy();
    return downloadTeamVideo(
      new URL(response.headers.location, url).href,
      signal,
      redirects + 1,
    );
  }
  const limit = 100 * 1024 * 1024;
  if (
    response.statusCode !== 200 ||
    Number(response.headers["content-length"] || 0) > limit
  ) {
    response.destroy();
    throw Error("视频下载失败或文件超过100MB");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > limit) throw Error("视频文件超过100MB");
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    response.destroy();
  }
  if (!size) throw Error("视频服务返回空文件");
  return Buffer.concat(chunks);
}

export async function generateTeamVideo(
  c: Context,
  job: Row,
  progress: (n: number, stage: string) => Promise<void>,
  signal: AbortSignal,
) {
  requirePermission(c.actor, "aigc.use");
  const {
    generation: _generation,
    videoSelection,
    model: _model,
    providerRequestId: _remote,
    ...raw
  } = job.input;
  const input = parse(videoGenerationSchema, raw);
  const config = await engineConfig();
  const route = selectVideoRoute(config, videoSelection);
  if (signature(route) !== videoSelection.signature || !videoKey(config, route))
    throw Error("视频服务配置已变化，未自动换模型或重新提交");
  const files = await ownedAgentFiles(c, input.referenceIds, true);
  const references: string[] = [];
  for (const file of files) {
    if (!file.mime.startsWith("image/"))
      throw Error("视频生成参考素材必须为图片");
    const meta = await sharp(Buffer.from(file.content), {
      limitInputPixels: 40000000,
    }).metadata();
    if (
      route.model.minImageSide &&
      Math.min(meta.width || 0, meta.height || 0) < route.model.minImageSide
    )
      throw Error("视频参考图尺寸低于所选模型要求");
    const buffer = await sharp(Buffer.from(file.content), {
      limitInputPixels: 40000000,
    })
      .resize({
        width: 1800,
        height: 1800,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 90 })
      .toBuffer();
    if (buffer.length > 5 * 1024 * 1024) throw Error("视频参考图压缩后超过5MB");
    references.push("data:image/jpeg;base64," + buffer.toString("base64"));
  }
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20 * 60000)]);
  return withJobSignal(deadline, async () => {
    const payload = {
      prompt: input.prompt,
      duration: input.duration,
      aspectRatio: input.aspectRatio,
      referenceImages: references,
    };
    validateVideoInput(route, payload);
    if (route.protocol === "xhai")
      payload.referenceImages = await uploadXhaiImages(
        route.baseUrl,
        videoKey(config, route)!,
        references,
      );
    const preflight = await preflightXhaiVideo(config, route, payload);
    await progress(15, "提交视频生成");
    let remote: string;
    let adjusted = false;
    try {
      remote = await submitVideo(config, route, payload, preflight);
    } catch (error) {
      if (!(error instanceof XhaiVideoAdjustmentError)) throw error;
      remote = error.taskId;
      adjusted = true;
    }
    const saved = await one(
      db,
      "UPDATE public.personal_assistant_jobs SET input=input || $3::jsonb,updated_at=now() WHERE id=$1::uuid AND lease_id=$2::uuid AND user_id=$4::bigint AND status IN ('RUNNING','CANCELED','FAILED') RETURNING id,status",
      job.id,
      job.lease_id,
      JSON.stringify({ providerRequestId: remote }),
      c.actor.id,
    );
    if (!saved || saved.status !== "RUNNING")
      throw Error("视频任务已中断，远端提交结果需核对；未自动重试");
    if (adjusted)
      throw Error(
        "视频服务已创建任务但调整了请求参数；已保存远端任务编号，请人工核对，未自动重试或归档",
      );
    for (let poll = 0; poll < 240; poll++) {
      deadline.throwIfAborted();
      await progress(Math.min(85, 20 + poll), "视频模型生成中");
      const result = await pollVideo(config, route, remote);
      if (!result.pending) {
        if (!result.url)
          throw Error("视频服务未生成可下载成片，已停止；未自动重试");
        await progress(90, "下载视频成片");
        return downloadTeamVideo(result.url, deadline);
      }
      await delay(5000, undefined, { signal: deadline });
    }
    throw Error("视频生成等待超时，远端任务可能仍在处理；请核对后再决定重试");
  });
}

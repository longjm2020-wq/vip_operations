import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Studio } from "../../../../../packages/aigc-engine/index.mjs";
import {
  db,
  one,
  rows,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import { HttpException } from "@nestjs/common";
import { aiFetch } from "../../ai-metering.js";
import {
  canonical,
  fail,
  hash,
  id,
  parse,
  requirePermission,
  type Actor,
} from "../../core.js";
import { activeActor } from "../auth/service.js";
import {
  inspectCommercePresenter,
  renderCommerceVideo,
} from "../workspace/commerce-video-render.js";
import { maxAssetBytes } from "./persistence.js";
import {
  commerceProduct,
  commerceProductImage,
  findCommerceProducts,
} from "./commerce-products.js";
import {
  commercePresenterOptions,
  commercePresenterEngine,
  saveCommercePresenter,
  removeCommercePresenter,
  uploadCommercePresenterPortrait,
  startCommercePresenterVideo,
  readCommercePresenterVideo,
} from "./commerce-presenter.js";
import {
  createBailianCommerceVoice,
  deleteBailianCommerceVoice,
  listBailianCommerceVoices,
  previewBailianCommerceVoice,
  readBailianCommerceVoice,
} from "./bailian-commerce-voice.js";
import { handleCommerceTalkWorkflow } from "./commerce-talk-workflow.js";
import { handleDigitalHumanCharacters } from "./digital-human-characters.js";

const prefix = "/api/v1/aigc/commerce-video";
const photoId = z.string().min(1).max(100);
const jobInput = z
  .object({
    requestId: z.uuid(),
    productId: id,
    presenterId: z.uuid(),
    prompt: z.string().trim().min(3).max(800),
    imageIds: z.array(photoId).max(4).default([]),
    maxSpeechCny: z.number().positive().multipleOf(0.01).max(20).optional(),
  })
  .strict();
const batchInput = jobInput
  .omit({ productId: true, imageIds: true })
  .extend({
    productIds: z.array(id).min(2).max(10).refine(
      (ids) => new Set(ids).size === ids.length,
      "同一批次不能重复选择款号",
    ),
  });
const editInput = z
  .object({ requestId: z.uuid(), imageId: photoId.nullable() })
  .strict();
const scriptInput = z
  .object({
    scenes: z
      .array(
        z
          .object({
            caption: z.string().trim().min(4).max(42),
            showProduct: z.boolean(),
          })
          .strict(),
      )
      .min(3)
      .max(8),
  })
  .strict();
type Scene = {
  caption: string;
  imageId?: string;
  start?: number;
  end?: number;
};
type Product = Awaited<ReturnType<typeof commerceProduct>>;
type JobInput = z.infer<typeof jobInput>;
type BatchItem = {
  productId: string;
  styleNo?: string;
  jobId?: string;
  message?: string;
};

function productCard(product: Product) {
  return {
    id: product.id,
    styleNo: product.styleNo,
    name: product.name,
    images: product.images.map(({ id, color }) => ({
      id,
      color,
      url: imageUrl(product.id, id),
    })),
  };
}
function imageUrl(product: string, photo: string) {
  return `${prefix}/products/${product}/images/${encodeURIComponent(photo)}`;
}
function view(job: Row) {
  const videoUrl = job.output_id
    ? `/api/v1/aigc/assets/${job.output_id}`
    : undefined;
  return {
    id: job.id,
    productId: String(job.product_id),
    styleNo: job.style_no,
    presenterName: job.presenter_name,
    prompt: job.prompt,
    state: job.state,
    message: job.message || undefined,
    editable:
      Boolean(job.operation_id) && ["completed", "failed"].includes(job.state),
    scenes: (job.scenes as Scene[]).map((scene) => ({
      ...scene,
      imageUrl: scene.imageId
        ? imageUrl(String(job.product_id), scene.imageId)
        : undefined,
    })),
    videoUrl,
    downloadUrl: videoUrl ? `${videoUrl}?download=1` : undefined,
    createdAt: new Date(job.created_at).toISOString(),
  };
}

async function ownedJob(actor: Actor, jobId: string) {
  const job = await one(
    db,
    "SELECT * FROM public.commerce_videos WHERE id=$1::uuid AND user_id=$2::bigint",
    jobId,
    actor.id,
  );
  if (!job) fail("NOT_FOUND", "找不到该口播任务", 404);
  return job;
}

async function readyPresenter(studio: Studio, actor: Actor, input: Pick<JobInput, "presenterId" | "maxSpeechCny">) {
  const options = await commercePresenterOptions(studio, actor);
  if (!studio.config.openrouterApiKey || !options.available)
    fail("COMMERCE_NOT_READY", "请先在服务设置验证脚本与数字人服务", 503);
  const presenter = options.presenters.find((p) => p.id === input.presenterId);
  if (!presenter)
    fail("PRESENTER_NOT_FOUND", "请选择当前账号可用的已授权角色", 422);
  if (presenter.voiceKind === "cloned" && !input.maxSpeechCny)
    fail("COMMERCE_SPEECH_BUDGET", "请为克隆音色设置本次语音合成费用上限", 422);
  return presenter;
}

async function lockQueue(tx: Tx, actor: Actor) {
  await one(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text", `commerce-video:${actor.id}`);
}

async function pendingCount(tx: Tx, actor: Actor) {
  const pending = await one(tx, `SELECT count(*)::int n FROM public.commerce_videos
    WHERE user_id=$1::bigint AND state IN ('queued','writing','speaking','editing')`, actor.id);
  return pending!.n as number;
}

async function insertJob(tx: Tx, actor: Actor, input: JobInput, presenterName: string, styleNo: string, fingerprint: string) {
  await tx.$executeRawUnsafe(
    `INSERT INTO public.commerce_videos (id,user_id,product_id,presenter_id,presenter_name,style_no,prompt,image_ids,max_speech_cny,request_hash)
     VALUES ($1::uuid,$2::bigint,$3::bigint,$4::uuid,$5,$6,$7,$8::jsonb,$9,$10) ON CONFLICT (id) DO NOTHING`,
    input.requestId, actor.id, input.productId, input.presenterId, presenterName, styleNo,
    input.prompt, JSON.stringify(input.imageIds), input.maxSpeechCny ?? null, fingerprint,
  );
  const saved = await one(tx, "SELECT * FROM public.commerce_videos WHERE id=$1::uuid AND user_id=$2::bigint", input.requestId, actor.id);
  if (!saved || saved.request_hash !== fingerprint)
    fail("IDEMPOTENCY_CONFLICT", "请求内容已改变，请重新提交");
  return saved;
}

function findBatch(tx: Tx, actor: Actor, batch: string) {
  return one(tx, "SELECT * FROM public.commerce_video_batches WHERE id=$1::uuid AND user_id=$2::bigint", batch, actor.id);
}

async function batchView(actor: Actor, batch: Row) {
  const items = batch.items as BatchItem[];
  const ids = items.flatMap((item) => item.jobId ? [item.jobId] : []);
  const jobs = ids.length
    ? await rows(db, `SELECT * FROM public.commerce_videos WHERE user_id=$1::bigint
        AND id IN (SELECT jsonb_array_elements_text($2::jsonb)::uuid)`, actor.id, JSON.stringify(ids))
    : [];
  const byId = new Map(jobs.map((job) => [job.id, view(job)]));
  return {
    id: batch.id,
    createdAt: new Date(batch.created_at).toISOString(),
    items: items.map(({ jobId, ...item }) => ({ ...item, job: jobId ? byId.get(jobId) : undefined })),
  };
}

async function enqueueBatch(studio: Studio, actor: Actor, input: z.infer<typeof batchInput>) {
  const fingerprint = hash(canonical(input));
  const check = (batch: Row) => {
    if (batch.request_hash !== fingerprint)
      fail("IDEMPOTENCY_CONFLICT", "批次内容已改变，请重新提交");
    return batch;
  };
  const prior = await findBatch(db, actor, input.requestId);
  if (prior) return check(prior);

  const presenter = await readyPresenter(studio, actor, input);
  const items: Array<BatchItem & { imageId?: string }> = [];
  for (const productId of input.productIds) {
    try {
      const product = await commerceProduct(actor, productId);
      const imageId = product.images[0]?.id;
      items.push({
        productId, styleNo: product.styleNo, imageId,
        ...(imageId ? {} : { message: "商品档案缺少已上传的实拍图" }),
      });
    } catch (error) {
      if (!(error instanceof HttpException) || ![403, 404].includes(error.getStatus())) throw error;
      items.push({ productId, message: "找不到当前账号可查看的款号" });
    }
  }
  return db.$transaction(async (tx: Tx) => {
    await lockQueue(tx, actor);
    const current = await findBatch(tx, actor, input.requestId);
    if (current) return check(current);
    const planned = items.filter((item) => item.imageId).length;
    if (planned > 0 && (await pendingCount(tx, actor)) + planned > 10)
      fail("COMMERCE_QUEUE", "账号最多可同时排队 10 条口播，请等待上一批办理", 429);
    const results: BatchItem[] = [];
    for (const { imageId, ...item } of items) {
      if (imageId && item.styleNo) {
        const job: JobInput = {
          requestId: randomUUID(), productId: item.productId,
          presenterId: input.presenterId, prompt: input.prompt,
          maxSpeechCny: input.maxSpeechCny, imageIds: [imageId],
        };
        await insertJob(tx, actor, job, presenter.name, item.styleNo, hash(canonical(job)));
        item.jobId = job.requestId;
      }
      results.push(item);
    }
    const created = await one(tx, `INSERT INTO public.commerce_video_batches (id,user_id,request_hash,items)
      VALUES ($1::uuid,$2::bigint,$3,$4::jsonb) ON CONFLICT (id) DO NOTHING RETURNING *`,
      input.requestId, actor.id, fingerprint, JSON.stringify(results));
    if (!created) fail("IDEMPOTENCY_CONFLICT", "批次编号已使用，请重新提交");
    return created;
  }, { timeout: 15_000 });
}

export async function handleCommerceVideo(
  studio: Studio,
  actor: Actor,
  suffix: string,
  req: Request,
  res: Response,
  readBody: () => Promise<unknown>,
) {
  requirePermission(actor, "product.read");
  if (suffix === "/workflows" || suffix.startsWith("/workflows/")) {
    return handleCommerceTalkWorkflow(studio, actor, suffix, req, res, readBody);
  }
  if (suffix === "/characters" || suffix.startsWith("/characters/")) {
    return handleDigitalHumanCharacters(studio, actor, suffix, req, res, readBody);
  }
  if (suffix === "/options" && req.method === "GET") {
    const options = await commercePresenterOptions(studio, actor);
    return res.json({
      ...options,
      available: options.available && Boolean(studio.config.openrouterApiKey),
    });
  }
  if (suffix === "/presenters" && req.method === "POST")
    return res
      .status(201)
      .json(await saveCommercePresenter(studio, actor, await readBody()));
  if (suffix === "/presenters/portrait" && req.method === "POST")
    return res
      .status(201)
      .json(await uploadCommercePresenterPortrait(studio, actor, req));
  const presenterRoute = /^\/presenters\/([\w-]+)$/.exec(suffix);
  if (presenterRoute && req.method === "DELETE")
    return res.json(
      await removeCommercePresenter(studio, actor, presenterRoute[1]),
    );
  if (suffix === "/voices" || suffix.startsWith("/voices/")) {
    const c = { actor, requestId: String(res.getHeader("X-Request-Id") || "") };
    if (suffix === "/voices" && req.method === "GET")
      return res.json({ voices: await listBailianCommerceVoices(actor) });
    if (suffix === "/voices" && req.method === "POST")
      return res.status(201).json(await createBailianCommerceVoice(c, req));
    const match = /^\/voices\/([a-f0-9-]{36})(\/preview)?$/i.exec(suffix);
    if (match) {
      const [, voiceId, preview] = match;
      if (preview && req.method === "POST") {
        const audio = await previewBailianCommerceVoice(
          c,
          voiceId,
          await readBody(),
        );
        return res.type("audio/mpeg").send(audio);
      }
      if (!preview && req.method === "GET")
        return res.json(await readBailianCommerceVoice(c, voiceId));
      if (!preview && req.method === "DELETE")
        return res.json(await deleteBailianCommerceVoice(c, voiceId));
    }
    fail("NOT_FOUND", "找不到该口播音色接口", 404);
  }
  if (suffix === "/products" && req.method === "GET") {
    const q = parse(z.string().trim().max(100), req.query.q || "");
    const products = await findCommerceProducts(actor, q);
    return res.json({
      products: products.flatMap((p) => (p ? [productCard(p)] : [])),
    });
  }
  const productRoute = /^\/products\/(\d+)(?:\/images\/([^/]+))?$/.exec(suffix);
  if (productRoute && req.method === "GET") {
    const product = await commerceProduct(actor, parse(id, productRoute[1]));
    if (!productRoute[2]) return res.json(productCard(product));
    const requested = product.images.find(
      (image) => encodeURIComponent(image.id) === productRoute[2],
    );
    if (!requested) fail("NOT_FOUND", "找不到可用的商品图片", 404);
    const image = await commerceProductImage(requested.source, product.tableId);
    return res.type(image.type).send(image.content);
  }
  if (suffix === "/jobs" && req.method === "GET") {
    const jobs = await rows(
      db,
      "SELECT * FROM public.commerce_videos WHERE user_id=$1::bigint ORDER BY created_at DESC LIMIT 30",
      actor.id,
    );
    return res.json({ jobs: jobs.map(view) });
  }
  if (suffix === "/batches" && req.method === "GET") {
    const batches = await rows(db, `SELECT id, created_at, jsonb_array_length(items) AS count
      FROM public.commerce_video_batches WHERE user_id=$1::bigint ORDER BY created_at DESC LIMIT 12`, actor.id);
    return res.json({ batches: batches.map((batch) => ({ id: batch.id, createdAt: new Date(batch.created_at).toISOString(), count: batch.count })) });
  }
  if (suffix === "/batches" && req.method === "POST") {
    const batch = await enqueueBatch(studio, actor, parse(batchInput, await readBody()));
    return res.status(202).json(await batchView(actor, batch));
  }
  const batchRoute = /^\/batches\/([\w-]+)$/.exec(suffix);
  if (batchRoute && req.method === "GET") {
    const batch = await findBatch(db, actor, parse(z.uuid(), batchRoute[1]));
    if (!batch) fail("NOT_FOUND", "找不到该批量口播任务", 404);
    return res.json(await batchView(actor, batch));
  }
  if (suffix === "/jobs" && req.method === "POST") {
    const input = parse(jobInput, await readBody());
    const fingerprint = hash(canonical(input));
    const old = await one(
      db,
      "SELECT * FROM public.commerce_videos WHERE id=$1::uuid AND user_id=$2::bigint",
      input.requestId,
      actor.id,
    );
    if (old) {
      if (old.request_hash !== fingerprint)
        fail("IDEMPOTENCY_CONFLICT", "请求内容已改变，请重新提交");
      return res.json(view(old));
    }
    const [product, presenter] = await Promise.all([
      commerceProduct(actor, input.productId),
      readyPresenter(studio, actor, input),
    ]);
    const selected = input.imageIds.length
      ? [...new Set(input.imageIds)]
      : product.images.slice(0, 1).map((image) => image.id);
    if (
      !selected.length ||
      selected.some((id) => !product.images.some((image) => image.id === id))
    )
      fail("COMMERCE_IMAGE", "请选择至少一张当前款号的已上传商品实拍图", 422);
    const job = await db.$transaction(async (tx: Tx) => {
      await lockQueue(tx, actor);
      const retry = await one(tx, "SELECT * FROM public.commerce_videos WHERE id=$1::uuid AND user_id=$2::bigint", input.requestId, actor.id);
      if (retry) {
        if (retry.request_hash !== fingerprint)
          fail("IDEMPOTENCY_CONFLICT", "请求内容已改变，请重新提交");
        return retry;
      }
      if (await pendingCount(tx, actor) >= 4)
        fail("COMMERCE_QUEUE", "已有 4 条口播视频处理中，请稍后再提交", 429);
      return insertJob(tx, actor, { ...input, imageIds: selected }, presenter.name, product.styleNo, fingerprint);
    });
    return res.status(202).json(view(job));
  }
  const jobRoute = /^\/jobs\/([\w-]+)(?:\/scenes\/(\d+))?$/.exec(suffix);
  if (jobRoute) {
    const job = await ownedJob(actor, parse(z.uuid(), jobRoute[1]));
    if (req.method === "GET" && jobRoute[2] === undefined)
      return res.json(view(job));
    if (req.method === "PATCH" && jobRoute[2] !== undefined) {
      const input = parse(editInput, await readBody());
      if (job.revision_request === input.requestId) return res.json(view(job));
      const scenes: Scene[] = job.scenes.slice();
      const index = Number(jobRoute[2]);
      if (!scenes[index]) fail("NOT_FOUND", "找不到该分镜", 404);
      if (!job.operation_id || !["completed", "failed"].includes(job.state))
        fail("COMMERCE_NOT_EDITABLE", "请等待口播生成完成，再替换分镜", 409);
      const product = await commerceProduct(actor, String(job.product_id));
      if (
        input.imageId &&
        !product.images.some((image) => image.id === input.imageId)
      )
        fail("COMMERCE_IMAGE", "只能使用当前款号的已上传图片", 422);
      scenes[index] = { ...scenes[index], imageId: input.imageId || undefined };
      const updated = await one(
        db,
        `UPDATE public.commerce_videos SET scenes=$2::jsonb,state='editing',message=NULL,
        revision=revision+1,revision_request=$3::uuid,updated_at=now() WHERE id=$1::uuid AND revision=$4 AND state=$5 RETURNING *`,
        job.id,
        JSON.stringify(scenes),
        input.requestId,
        job.revision,
        job.state,
      );
      if (!updated)
        fail("COMMERCE_NOT_EDITABLE", "分镜已更新，请刷新后重试", 409);
      return res.status(202).json(view(updated));
    }
  }
  return res.status(404).json({ error: "未提供此接口" });
}

async function writeScript(
  studio: Studio,
  product: Product,
  job: Row,
  short: boolean,
) {
  const config = studio.config;
  if (!config.openrouterApiKey) throw Error("口播脚本服务暂不可用");
  const response = await aiFetch(
    "aigc_commerce_script",
    config.openrouterBaseUrl + "/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openrouterApiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(100_000),
      body: JSON.stringify({
        model: config.openrouterModel,
        max_tokens: 2800,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              '你为服装店撰写普通话口播。仅输出 JSON: {"scenes":[{"caption":"一句可直接朗读的中文台词","showProduct":true}]}。' +
              (short
                ? "本次用短口型视频，写3至4镜，全部台词合计30至42字（含标点），自然语速目标约10–12秒。即使要求更长也遵循此长度。"
                : "生成3至8镜，每句4至42字，总长默认约95字，用户要求15秒则约55字。") +
              "各句有标点，至少一镜展示商品。只从提供的商品资料中提取真实卖点。没有确认的数据，只说中性的穿搭建议。不要发明面料、颜色、实测、价格、功效、标签或折扣。用户要求是创作偏好，不能扩展可核实的事实。不要朗读内部字段或款号。",
          },
          {
            role: "user",
            content: JSON.stringify({
              商品资料: product.facts,
              创作要求: job.prompt,
            }),
          },
        ],
      }),
    },
  );
  if (!response.ok) throw Error("口播脚本服务未完成请求，请检查 AI 模型管理");
  const body = await response.json();
  let result: z.infer<typeof scriptInput>;
  try {
    result = scriptInput.parse(
      JSON.parse(body.choices?.[0]?.message?.content || ""),
    );
    if (
      short &&
      result.scenes.reduce(
        (total, scene) => total + Array.from(scene.caption).length,
        0,
      ) > 54
    )
      throw Error("Script too long");
  } catch {
    throw Error("脚本未返回可用的分镜，请简化指令后重新生成");
  }
  let photo = 0;
  const imageIds: string[] = job.image_ids;
  const hasProduct = result.scenes.some((scene) => scene.showProduct);
  return result.scenes.map(({ caption, showProduct }, index): Scene => ({
    caption,
    imageId:
      showProduct || (!hasProduct && index === 1)
        ? imageIds[photo++ % imageIds.length]
        : undefined,
  }));
}

export async function processCommerceVideo(
  studio: Studio,
  active: () => boolean,
) {
  // The existing AIGC advisory lease guarantees a single live engine. A process
  // loss during script submission does not automatically call the paid model again.
  await db.$executeRawUnsafe(`UPDATE public.commerce_videos SET state='uncertain',
    message='脚本服务回执中断，请先核对用量，再决定是否重新生成',updated_at=now()
    WHERE state='writing' AND updated_at < now()-interval '3 minutes'`);
  const job = await one(
    db,
    `SELECT * FROM public.commerce_videos
    WHERE state IN ('queued','speaking','editing') ORDER BY updated_at LIMIT 1`,
  );
  if (!job || !active()) return;
  let phase = String(job.state);
  try {
    const actor = await activeActor(String(job.user_id));
    requirePermission(actor, "aigc.use");
    const product = await commerceProduct(actor, String(job.product_id));
    if (!active()) return;
    if (phase === "queued") {
      for (const imageId of job.image_ids as string[]) {
        const photo = product.images.find((image) => image.id === imageId);
        if (!photo) throw Error("商品实拍图已变更，请补图后重试");
        await commerceProductImage(photo.source, product.tableId);
      }
      if (!active()) return;
      const claimed = await db.$executeRawUnsafe(
        "UPDATE public.commerce_videos SET state='writing',updated_at=now() WHERE id=$1::uuid AND state='queued'",
        job.id,
      );
      if (claimed !== 1) return;
      phase = "writing";
      const scenes = await writeScript(
        studio,
        product,
        job,
        commercePresenterEngine(studio, actor, job.presenter_id) === "fal",
      );
      if (active())
        await db.$executeRawUnsafe(
          "UPDATE public.commerce_videos SET state='speaking',scenes=$2::jsonb,updated_at=now() WHERE id=$1::uuid AND state='writing'",
          job.id,
          JSON.stringify(scenes),
        );
      return;
    }
    if (phase === "speaking") {
      const current = job.operation_id
        ? await readCommercePresenterVideo(studio, actor, job.operation_id)
        : await startCommercePresenterVideo(studio, actor, {
            runId: job.id,
            presenterId: job.presenter_id,
            title: product.styleNo + " 服装口播",
            text: (job.scenes as Scene[])
              .map((scene) => scene.caption)
              .join("\n"),
            maxSpeechCny:
              job.max_speech_cny === null
                ? undefined
                : Number(job.max_speech_cny),
          });
      if (!active()) return;
      if (["failed", "stopped"].includes(current.status))
        throw Error(
          current.message ||
            "口播语音或数字人视频未完成，请检查音色额度与服务连接",
        );
      if (current.status === "uncertain") {
        await db.$executeRawUnsafe(
          "UPDATE public.commerce_videos SET state='uncertain',operation_id=$2,message='语音或数字人服务提交结果待核对，请先查看已有任务',updated_at=now() WHERE id=$1::uuid AND state='speaking'",
          job.id,
          current.operationId,
        );
        return;
      }
      if (active())
        await db.$executeRawUnsafe(
          "UPDATE public.commerce_videos SET state=$3,operation_id=$2,message=$4,updated_at=now() WHERE id=$1::uuid AND state='speaking'",
          job.id,
          current.operationId,
          current.status === "completed" ? "editing" : "speaking",
          current.status === "awaiting_presenter"
            ? "等待同账号上一条数字人口播完成"
            : current.status === "awaiting_audio"
              ? "正在生成配音"
              : null,
        );
      return;
    }
    const video = await readCommercePresenterVideo(
      studio,
      actor,
      job.operation_id,
    );
    if (!video.content) throw Error("找不到数字人口播原片，请检查作品库");
    const marker = `commerce-video:${job.id}:${job.revision}`;
    const scenes: Scene[] = job.scenes;
    const { duration } = await inspectCommercePresenter(video.content);
    const total = scenes.reduce(
      (sum, scene) => sum + Array.from(scene.caption).length,
      0,
    );
    let offset = 0;
    const timed = scenes.map((scene) => {
      const start = (offset * duration) / total;
      offset += Array.from(scene.caption).length;
      return { ...scene, start, end: (offset * duration) / total };
    });
    const photoIds = [
      ...new Set(
        scenes.flatMap((scene) => (scene.imageId ? [scene.imageId] : [])),
      ),
    ];
    const productImages = await Promise.all(
      photoIds.map(async (id) => {
        const photo = product.images.find((image) => image.id === id);
        if (!photo)
          throw Error("分镜里的商品照片已变更，请选择当前款号的图片后重剪");
        return (await commerceProductImage(photo.source, product.tableId))
          .content;
      }),
    );
    const priorAsset = (Object.values(studio.store.data.assets) as Row[]).find(
      (asset) => asset.source === marker && asset.ownerId === actor.id,
    );
    const name = `${product.styleNo} · 服装口播`;
    let asset = priorAsset
      ? {
          path: priorAsset.id,
          name: priorAsset.name,
          size: priorAsset.size,
          kind: priorAsset.kind,
          mime: priorAsset.mime,
        }
      : undefined;
    if (!asset) {
      const rendered = await renderCommerceVideo({
        presenter: video.content,
        productImages,
        scenes: timed.map((scene) => ({
          ...scene,
          productImageIndex: scene.imageId
            ? photoIds.indexOf(scene.imageId)
            : undefined,
        })),
      });
      if (!active()) return;
      if (rendered.content.length > maxAssetBytes())
        throw Error("成片超过当前 AIGC 存储上限，请缩短口播文案");
      asset = await studio.store.putAsset({
        buffer: rendered.content,
        name: `${name}.mp4`,
        kind: "output",
        mime: "video/mp4",
        ownerId: actor.id,
        source: marker,
      });
    }
    const assetId = asset!.path;
    await studio.store.mutate((data: Row) => {
      const workId = `commerce-${job.id}`;
      const work = data.appState.works.find((work: Row) => work.id === workId);
      const next = {
        id: workId,
        ownerId: actor.id,
        category: "digital_human",
        title: name,
        updatedAt: new Date().toISOString(),
        cover: asset,
        videos: [asset],
      };
      if (work) Object.assign(work, next);
      else data.appState.works.push({ ...next, createdAt: next.updatedAt });
    });
    if (active())
      await db.$executeRawUnsafe(
        "UPDATE public.commerce_videos SET state='completed',output_id=$2::uuid,scenes=$3::jsonb,message=NULL,updated_at=now() WHERE id=$1::uuid AND state='editing' AND revision=$4",
        job.id,
        assetId,
        JSON.stringify(timed),
        job.revision,
      );
  } catch (error) {
    if (!active()) return;
    const uncertain =
      phase === "writing" &&
      (error instanceof TypeError ||
        (error instanceof Error && error.name === "TimeoutError"));
    const status =
      error instanceof HttpException ? error.getStatus() : undefined;
    const response =
      error instanceof HttpException
        ? (error.getResponse() as { error?: { message?: string } })
        : undefined;
    const explanation =
      response?.error?.message ||
      (error instanceof Error && /^[\p{Script=Han}]/u.test(error.message)
        ? error.message.slice(0, 140)
        : "");
    await db.$executeRawUnsafe(
      "UPDATE public.commerce_videos SET state=$2,message=$3,updated_at=now() WHERE id=$1::uuid AND state=$4",
      job.id,
      uncertain ? "uncertain" : "failed",
      uncertain
        ? "脚本服务回执中断，请先核对用量，再决定是否重新生成"
        : status === 403
          ? "当前账号已失去所需权限"
          : explanation || "视频制作未完成，请检查服务和素材后重试",
      phase,
    );
  }
}

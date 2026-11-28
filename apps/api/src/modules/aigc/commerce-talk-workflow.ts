import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import Busboy from "busboy";
import type { Request, Response } from "express";
import sharp from "sharp";
import { z } from "zod";
import type { Studio } from "../../../../../packages/aigc-engine/index.mjs";
// @ts-expect-error 复用内部 ESM 模块（无独立 d.mts）
import { inspectCozyClayProject } from "../../../../../packages/aigc-engine/vendor/shared/cozyclay.mjs";
import { buildCozyClayProjectV5 } from "../../../../../packages/aigc-engine/vendor/shared/cozyclay-export.mjs";
import {
  imageCatalog,
  imageRouteConfigured,
  keyframeImageBody,
  keyframeImageRoute,
  pollKeyframe,
  submitKeyframe,
  // @ts-expect-error 复用内部 ESM 模块（无独立 d.mts）
} from "../../../../../packages/aigc-engine/vendor/cloud/image-provider.mjs";
import {
  pollVideo,
  selectVideoRoute,
  submitVideo,
  videoCatalog,
  videoKey,
  // @ts-expect-error 复用内部 ESM 模块（无独立 d.mts）
} from "../../../../../packages/aigc-engine/vendor/cloud/video-providers.mjs";
import { bailianCommerceVoiceModels } from "../../../../../packages/contracts/src/bailian-commerce-voice.js";
import {
  advanceWorkflowInputSchema,
  aiEditWorkflowInputSchema,
  createWorkflowInputSchema,
  magi2VideoModelSpec,
  recommendedScriptModels,
  smartCreateWorkflowInputSchema,
  updateWorkflowInputSchema,
  workflowActiveStages,
  workflowDeconstructSchema,
  workflowEffects,
  workflowFilters,
  workflowMotions,
  workflowShotPostEditSchema,
  workflowShotSchema,
  workflowSubtitleStyles,
  workflowTransitions,
  type SmartCreateWorkflowInput,
  type WorkflowAssetsConfig,
  type WorkflowCozyClayState,
  type WorkflowDeconstructData,
  type WorkflowModelConfig,
  type WorkflowRunMode,
  type WorkflowShot,
  type WorkflowStage,
} from "../../../../../packages/contracts/src/commerce-talk-workflow.js";
import {
  db,
  one,
  rows,
  type Row,
} from "../../../../../packages/database/src/index.js";
import { aiFetch } from "../../ai-metering.js";
import { fail, parse, requirePermission, type Actor } from "../../core.js";
import { decryptSecret, encryptionReady } from "../analytics/secrets.js";
import { activeActor } from "../auth/service.js";
import { runMedia } from "../workspace/agent-media.js";
import {
  renderWorkflowVideo,
  type WorkflowRenderSegment,
} from "../workspace/commerce-video-render.js";
import {
  buildAfterEffectsScript,
  buildHeuristicPostEditPlan,
  sanitizeAiPostEditResponse,
} from "../workspace/workflow-post-edit.js";
import { listRelayStations } from "../workspace/smart-models.js";
import { commerceFalConfigured } from "./commerce-fal.js";
import {
  commercePresenterOptions,
  readCommercePresenterVideo,
  startCommercePresenterVideo,
} from "./commerce-presenter.js";
import { commerceProduct, commerceProductImage } from "./commerce-products.js";
import {
  characterAnglePromptHint,
  listDigitalHumanCharacters,
  loadDigitalHumanCharactersByIds,
  pickCharacterViewAssetIds,
} from "./digital-human-characters.js";
import { maxAssetBytes } from "./persistence.js";
import { downloadPublicReference } from "./public-reference-download.js";

const workflowPrefix = "/api/v1/aigc/commerce-video/workflows";
const assetUrl = (assetId?: string) =>
  assetId ? `/api/v1/aigc/assets/${assetId}` : undefined;

/** 将工作流 ID 与分镜 ID 稳定派生为确定性 UUID，保证对口型/配音幂等 */
function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 将数据库行转换为前端安全视图 */
function workflowView(row: Row) {
  const shots = (Array.isArray(row.shots) ? row.shots : []) as WorkflowShot[];
  const assetsConfig = (row.assets_config || {}) as Partial<WorkflowAssetsConfig>;
  const cozyclayState = (row.cozyclay_state || {}) as Partial<WorkflowCozyClayState>;
  const outputUrl = assetUrl(row.output_asset_id || undefined);
  return {
    id: row.id as string,
    title: row.title as string,
    runMode: row.run_mode as WorkflowRunMode,
    stage: row.stage as WorkflowStage,
    sourcePlatform: row.source_platform as string,
    sourceUrl: (row.source_url as string) || undefined,
    sourceMeta: (row.source_meta || {}) as Record<string, unknown>,
    referenceAssetId: (row.reference_asset_id as string) || undefined,
    referenceVideoUrl: assetUrl(row.reference_asset_id || undefined),
    deconstructData: (row.deconstruct_data as WorkflowDeconstructData | null) || undefined,
    assetsConfig: {
      productImageIds: [],
      sceneMode: "smart",
      creativeBrief: "",
      aspectRatio: "9:16",
      targetDurationSec: 20,
      pauseBeforePrevis: true,
      ...assetsConfig,
      characters: (assetsConfig.characters || []).map((c) => ({
        ...c,
        url: assetUrl(c.assetId),
      })),
      props: (assetsConfig.props || []).map((p) => ({
        ...p,
        url: assetUrl(p.assetId),
      })),
      scenes: (assetsConfig.scenes || []).map((s) => ({
        ...s,
        url: assetUrl(s.assetId),
      })),
      garments: (assetsConfig.garments || []).map((g) => ({
        ...g,
        url: assetUrl(g.assetId),
      })),
      sceneKeywords: assetsConfig.sceneKeywords || [],
      propKeywords: assetsConfig.propKeywords || [],
      garmentKeywords: assetsConfig.garmentKeywords || [],
    },
    modelConfig: (row.model_config || {}) as WorkflowModelConfig,
    shots: shots.map((shot) => ({
      ...shot,
      storyboardUrl: assetUrl(shot.storyboardAssetId),
      greyboxUrl: assetUrl(shot.greyboxAssetId),
      firstFrameUrl: assetUrl(shot.firstFrameAssetId),
      lastFrameUrl: assetUrl(shot.lastFrameAssetId),
      audioUrl: assetUrl(shot.audioAssetId),
      clipUrl: assetUrl(shot.clipAssetId),
    })),
    cozyclayState: {
      importedShots: [],
      skipped: false,
      authorized: false,
      ...cozyclayState,
      importedProjectUrl: assetUrl(cozyclayState.importedProjectAssetId),
    },
    maxSpeechCny:
      row.max_speech_cny == null ? undefined : Number(row.max_speech_cny),
    outputAssetId: (row.output_asset_id as string) || undefined,
    videoUrl: outputUrl,
    downloadUrl: outputUrl ? `${outputUrl}?download=1` : undefined,
    message: (row.message as string) || undefined,
    revision: Number(row.revision || 0),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function ownedWorkflow(actor: Actor, workflowId: string) {
  const row = await one(
    db,
    "SELECT * FROM public.commerce_talk_workflows WHERE id=$1::uuid AND user_id=$2::bigint",
    workflowId,
    actor.id,
  );
  if (!row) fail("NOT_FOUND", "找不到该服装口播工作流", 404);
  return row;
}

/** 汇总全环节可选模型目录（拆解/脚本、分镜图、克隆语音、对口型、视频生成含 Magi-2 动态探测） */
export async function workflowCatalog(studio: Studio, actor: Actor) {
  const [presenterOptions, relayStations] = await Promise.all([
    commercePresenterOptions(studio, actor),
    listRelayStations().catch(() => []),
  ]);
  const openrouterReady = Boolean(studio.config.openrouterApiKey);
  const agentaiKey = Boolean(studio.config.videoSecrets?.AGENTAI_API_KEY);
  const falReady = commerceFalConfigured(studio);

  // 1. 拆解与分镜脚本模型目录（OpenRouter 强模型 + AgentAI + 中转站）
  const scriptModels: Array<{
    id: string;
    label: string;
    provider: string;
    configured: boolean;
    description: string;
  }> = recommendedScriptModels.map((item) => ({
    id: item.id,
    label: item.label,
    provider: "openrouter",
    configured: openrouterReady,
    description: item.description,
  }));

  for (const m of (studio.config.agentaiModels || []) as Array<Record<string, any>>) {
    if (m.type === "chat" && typeof m.model === "string") {
      scriptModels.push({
        id: `agentai|${m.model}`,
        label: `${m.name || m.model}（AgentAI）`,
        provider: "agentai",
        configured: agentaiKey && Boolean(m.available),
        description: "通过已接入的 AgentAI 聊天模型执行",
      });
    }
  }

  for (const station of relayStations) {
    if (!station.enabled) continue;
    for (const model of (station.models || []).slice(0, 12)) {
      if (model.category === "chat") {
        scriptModels.push({
          id: `relay:${station.id}|${model.model}`,
          label: `${model.name || model.model}（${station.name}）`,
          provider: "relay",
          configured: Boolean(station.apiKeyConfigured && model.available),
          description: `通过中转站「${station.name}」执行`,
        });
      }
    }
  }

  // 2. 分镜图生成模型目录
  const imgCat = imageCatalog(studio.config);
  const imageModels = imgCat.models.map((m: Record<string, any>) => ({
    id: m.id as string,
    label: m.label as string,
    configured: Boolean(m.configured),
    maxImages: Number(m.maxImages || 4),
    detail: String(m.detail || ""),
  }));

  // 3. 克隆音色模型目录
  const voiceModels = bailianCommerceVoiceModels.map((m) => ({
    id: m.id,
    label: m.label,
    provider: "bailian",
    cnyPer10k: m.cnyPer10k,
    configured: Boolean(presenterOptions.bailian?.configured),
  }));

  // 4. 对口型模型目录
  const lipSyncModels = [
    {
      id: "fal-minimax-h3-max-lip-sync",
      label: "MiniMax H3 Max Lip Sync（fal）",
      provider: "fal",
      configured: falReady,
      note: "支持 5～15 秒单人正脸授权照 + 克隆音频高精度对口型",
    },
  ];

  // 5. 视频生成模型目录（百炼 MiniMax H3、AgentAI MiniMax H3 / Seedance 2.5 等 + 动态探测 Magi-2）
  const rawVideoProviders = videoCatalog(studio.config);
  const videoModels: Array<{
    id: string;
    providerId: string;
    modelId: string;
    label: string;
    configured: boolean;
    supportsPrevis: boolean;
    resolutions: string[];
    durations: number[];
    note: string;
  }> = [];

  for (const provider of rawVideoProviders) {
    for (const model of provider.models) {
      videoModels.push({
        id: `${provider.id}|${model.id}`,
        providerId: provider.id,
        modelId: model.id,
        label: `${model.label}（${provider.label}）`,
        configured: Boolean(model.configured),
        supportsPrevis:
          provider.id === "bailian" &&
          model.mediaReferences?.audio?.field === "driving_audio",
        resolutions: model.resolutions || ["720p"],
        durations: model.durations || [5, 10],
        note: model.note || "",
      });
    }
  }

  // 动态探测 Magi-2 是否存在于 AgentAI 目录、已启用中转站或 fal 连接中
  const agentaiMagi = ((studio.config.agentaiModels || []) as Array<Record<string, any>>).find(
    (m) =>
      typeof m.model === "string" &&
      /magi[-_]?2/i.test(`${m.model} ${m.publicId || ""}`),
  );
  const relayMagiStation = relayStations.find(
    (s) =>
      s.enabled &&
      s.apiKeyConfigured &&
      (s.models || []).some((m) => /magi[-_]?2/i.test(m.model)),
  );
  const relayMagiModel = relayMagiStation?.models?.find((m) =>
    /magi[-_]?2/i.test(m.model),
  );

  const magiRoute = agentaiMagi
    ? {
        id: `agentai|${agentaiMagi.model}`,
        providerId: "agentai",
        modelId: String(agentaiMagi.model),
        configured: agentaiKey && Boolean(agentaiMagi.available),
        label: "Magi-2（AgentAI 动态目录）",
      }
    : relayMagiStation && relayMagiModel
      ? {
          id: `relay:${relayMagiStation.id}|${relayMagiModel.model}`,
          providerId: `relay:${relayMagiStation.id}`,
          modelId: relayMagiModel.model,
          configured: true,
          label: `Magi-2（${relayMagiStation.name}）`,
        }
      : {
          id: "fal|fal-ai/magi-2",
          providerId: "fal",
          modelId: "fal-ai/magi-2",
          configured: falReady,
          label: "Magi-2（fal / 动态目录）",
        };

  videoModels.push({
    ...magiRoute,
    supportsPrevis: false,
    resolutions: [...magi2VideoModelSpec.resolutions],
    durations: [...magi2VideoModelSpec.durations],
    note: magi2VideoModelSpec.note,
  });

  const characters = await listDigitalHumanCharacters(actor).catch(() => []);
  return {
    scriptModels,
    imageModels,
    voiceModels,
    lipSyncModels,
    videoModels,
    cozyclayBaseUrl: String((studio.config as Record<string, any>).cozyclayBaseUrl || ""),
    presenters: presenterOptions.presenters,
    bailian: presenterOptions.bailian,
    characters,
    defaults: {
      deconstructModel: "openrouter|google/gemini-4-neon",
      scriptModel: "openrouter|openai/gpt-6.2-astra",
      storyboardImageModel: imgCat.defaultModelId,
      voiceModel: bailianCommerceVoiceModels[0].id,
      lipSyncModel: "fal-minimax-h3-max-lip-sync",
      videoModel:
        videoModels.find((v) => v.configured)?.id || "bailian|minimax-h3",
    },
  };
}

/** 解析中转站凭据（仅在服务端执行调用时使用） */
async function readRelayStationSecret(stationId: string) {
  if (!encryptionReady()) return undefined;
  const row = await one(
    db,
    "SELECT id,name,base_url,api_key_encrypted,enabled FROM public.ai_relay_stations WHERE id=$1",
    stationId,
  );
  if (!row?.enabled || !row.api_key_encrypted) return undefined;
  return {
    name: String(row.name),
    baseUrl: String(row.base_url).replace(/\/+$/, ""),
    apiKey: decryptSecret(String(row.api_key_encrypted)),
  };
}

/** 统一调用已配置的多模态/文本大模型（OpenRouter / AgentAI / 中转站） */
async function callWorkflowLlm(
  studio: Studio,
  modelSpec: string | undefined,
  systemPrompt: string,
  userContent: string | Array<Record<string, unknown>>,
) {
  const spec = (modelSpec || "").trim() || `openrouter|${studio.config.openrouterModel || "openai/gpt-6.1-sol"}`;
  const [rawProvider, ...rest] = spec.split("|");
  const modelId = rest.join("|").trim();
  if (!modelId) throw Error("所选脚本/拆解模型配置无效，请重新选择模型");

  let endpoint = "";
  let apiKey = "";
  if (rawProvider === "openrouter") {
    if (!studio.config.openrouterApiKey)
      throw Error("OpenRouter 尚未配置或未验证，请在 AI 模型管理中检查连接");
    endpoint = `${studio.config.openrouterBaseUrl || "https://openrouter.ai/api/v1"}/chat/completions`;
    apiKey = studio.config.openrouterApiKey;
  } else if (rawProvider === "agentai") {
    const key = studio.config.videoSecrets?.AGENTAI_API_KEY;
    if (!key) throw Error("AgentAI 尚未连接，请先在 AI 模型管理中配置");
    endpoint = "https://agentai.token6688.com/v1/chat/completions";
    apiKey = key;
  } else if (rawProvider.startsWith("relay:")) {
    const stationId = rawProvider.slice("relay:".length);
    const station = await readRelayStationSecret(stationId);
    if (!station) throw Error("所选中转站未启用或密钥无效");
    endpoint = `${station.baseUrl}/chat/completions`;
    apiKey = station.apiKey;
  } else {
    throw Error(`暂不支持该模型渠道：${rawProvider}`);
  }

  const response = await aiFetch("aigc_commerce_script", endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: modelId,
      max_tokens: 4000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const errText = (await response.text()).slice(0, 200);
      const parsed = JSON.parse(errText) as { error?: { message?: string } | string };
      detail =
        typeof parsed?.error === "string"
          ? parsed.error
          : parsed?.error?.message || "";
    } catch {
      /* 忽略非 JSON 错误体 */
    }
    throw Error(
      `模型调用失败（${rawProvider} / ${modelId}，HTTP ${response.status}${detail ? `：${detail.slice(0, 120)}` : ""}），请检查模型可用性与余额`,
    );
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = String(body.choices?.[0]?.message?.content || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? raw;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw Error("模型未返回合法的 JSON 结构，请重试或切换更强模型");
  return JSON.parse(fenced.slice(start, end + 1)) as Record<string, unknown>;
}

/** 从参考视频抽取最多 5 帧代表关键帧，用于多模态逆向拆解 */
async function extractReferenceKeyframes(videoBuffer: Buffer): Promise<{
  frames: Array<{ sec: number; dataUrl: string }>;
  durationSec?: number;
}> {
  const dir = await mkdtemp(join(tmpdir(), "xuti-wf-frames-"));
  const videoPath = join(dir, "ref.mp4");
  try {
    await writeFile(videoPath, videoBuffer);
    let durationSec: number | undefined;
    try {
      const log = await runMedia(
        ["-hide_banner", "-i", videoPath, "-t", "0.1", "-f", "null", "-"],
        undefined,
        20_000,
      );
      const m = log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) durationSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    } catch (err) {
      const text = String((err as Error)?.message || "");
      const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) durationSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    }
    const dur = durationSec && durationSec > 1 ? durationSec : 15;
    const count = Math.min(5, Math.max(3, Math.round(dur / 4)));
    const frames: Array<{ sec: number; dataUrl: string }> = [];
    for (let i = 0; i < count; i++) {
      const sec = Number((((i + 0.5) / count) * dur).toFixed(2));
      const framePath = join(dir, `f-${i}.jpg`);
      try {
        await runMedia(
          [
            "-y",
            "-ss",
            String(sec),
            "-i",
            videoPath,
            "-frames:v",
            "1",
            "-vf",
            "scale='min(960,iw)':-2",
            framePath,
          ],
          undefined,
          25_000,
        );
        const buf = await readFile(framePath);
        const jpg = await sharp(buf).jpeg({ quality: 78 }).toBuffer();
        frames.push({
          sec,
          dataUrl: `data:image/jpeg;base64,${jpg.toString("base64")}`,
        });
      } catch {
        // 单帧抽帧失败忽略，继续抽取其余关键帧
      }
    }
    return { frames, durationSec };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 处理工作流素材 multipart 上传（参考视频、角色图、道具图、场景图、分镜图、CozyClay 工程/灰模/首尾帧） */
async function uploadWorkflowAsset(
  studio: Studio,
  actor: Actor,
  workflow: Row,
  req: Request,
) {
  const maxBytes = maxAssetBytes();
  const parsed = await new Promise<{
    fields: Record<string, string>;
    file?: { buffer: Buffer; filename: string; mime: string };
  }>((resolve, reject) => {
    const bb = Busboy({
      headers: req.headers,
      limits: { fileSize: maxBytes, files: 1, fields: 16 },
    });
    const fields: Record<string, string> = {};
    let file: { buffer: Buffer; filename: string; mime: string } | undefined;
    let truncated = false;
    bb.on("field", (name, val) => {
      fields[name] = val.slice(0, 500);
    });
    bb.on("file", (_name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on("data", (d: Buffer) => chunks.push(d));
      stream.on("limit", () => {
        truncated = true;
      });
      stream.on("end", () => {
        file = {
          buffer: Buffer.concat(chunks),
          filename: info.filename || "upload.bin",
          mime: info.mimeType || "application/octet-stream",
        };
      });
    });
    bb.on("error", reject);
    bb.on("finish", () => {
      if (truncated)
        reject(
          Object.assign(new Error("上传文件超过大小上限"), { statusCode: 413 }),
        );
      else resolve({ fields, file });
    });
    req.pipe(bb);
  });

  if (!parsed.file || !parsed.file.buffer.length)
    fail("UPLOAD_EMPTY", "请选择要上传的文件", 400);

  const slot = parsed.fields.slot || "";
  const label = (parsed.fields.name || parsed.file.filename).slice(0, 80);
  const shotId = parsed.fields.shotId || "";
  const allowedSlots = new Set([
    "referenceVideo",
    "character",
    "prop",
    "scene",
    "garment",
    "storyboard",
    "cozyclayProject",
    "greybox",
    "firstFrame",
    "lastFrame",
  ]);
  if (!allowedSlots.has(slot)) fail("INVALID_SLOT", "不支持的素材类型", 400);

  let cozyclayMeta: ReturnType<typeof inspectCozyClayProject> | undefined;
  if (slot === "cozyclayProject") {
    cozyclayMeta = inspectCozyClayProject(parsed.file.buffer.toString("utf8"));
  }

  const asset = await studio.store.putAsset({
    buffer: parsed.file.buffer,
    name: parsed.file.filename,
    kind: `workflow_${slot}`,
    mime: parsed.file.mime,
    ownerId: actor.id,
    projectId: workflow.id,
    source: `commerce-talk-workflow:${workflow.id}:${slot}`,
  });

  const assetsConfig = {
    ...(workflow.assets_config || {}),
  } as WorkflowAssetsConfig;
  const shots = ([...(workflow.shots || [])] as WorkflowShot[]);
  const cozyclayState = {
    ...(workflow.cozyclay_state || {}),
  } as WorkflowCozyClayState;
  let referenceAssetId = workflow.reference_asset_id as string | null;

  if (slot === "referenceVideo") {
    referenceAssetId = asset.path;
  } else if (
    slot === "character" ||
    slot === "prop" ||
    slot === "scene" ||
    slot === "garment"
  ) {
    const key =
      slot === "character"
        ? "characters"
        : slot === "prop"
          ? "props"
          : slot === "scene"
            ? "scenes"
            : "garments";
    const list = Array.isArray(assetsConfig[key]) ? [...assetsConfig[key]] : [];
    list.push({
      id: randomUUID(),
      name: label,
      assetId: asset.path,
      note: parsed.fields.note || undefined,
    });
    assetsConfig[key] = list;
  } else if (slot === "cozyclayProject" && cozyclayMeta) {
    cozyclayState.importedProjectAssetId = asset.path;
    cozyclayState.importedProjectName = cozyclayMeta.name;
    cozyclayState.importedShots = cozyclayMeta.shots;
    cozyclayState.skipped = false;
  } else if (
    shotId &&
    ["storyboard", "greybox", "firstFrame", "lastFrame"].includes(slot)
  ) {
    const idx = shots.findIndex((s) => s.id === shotId);
    if (idx < 0) fail("SHOT_NOT_FOUND", "找不到对应分镜", 404);
    const patch: Partial<WorkflowShot> =
      slot === "storyboard"
        ? { storyboardAssetId: asset.path }
        : slot === "greybox"
          ? { greyboxAssetId: asset.path, type: "previs_video" }
          : slot === "firstFrame"
            ? { firstFrameAssetId: asset.path }
            : { lastFrameAssetId: asset.path };
    shots[idx] = { ...shots[idx], ...patch };
  }

  const updated = await one(
    db,
    `UPDATE public.commerce_talk_workflows
     SET reference_asset_id=$2::uuid, assets_config=$3::jsonb, shots=$4::jsonb,
         cozyclay_state=$5::jsonb, revision=revision+1, updated_at=now()
     WHERE id=$1::uuid RETURNING *`,
    workflow.id,
    referenceAssetId,
    JSON.stringify(assetsConfig),
    JSON.stringify(shots),
    JSON.stringify(cozyclayState),
  );
  return {
    asset: { id: asset.path, name: asset.name, url: assetUrl(asset.path) },
    workflow: workflowView(updated!),
  };
}

/** 根据用户输入、多轮对话、附件或剧本文本智能识别创作意图（优先 LLM，失败时启发式兜底） */
async function analyzeSmartCreateIntent(
  studio: Studio,
  input: SmartCreateWorkflowInput,
) {
  const combinedText = [
    ...input.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content),
    input.prompt,
    input.scriptContent || "",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();

  const urlMatch = combinedText.match(/https?:\/\/[^\s"'<>]+/i);
  const hasViralUrl = Boolean(
    urlMatch &&
      (/douyin\.com|iesdouyin\.com|xiaohongshu\.com|xhslink\.com|rednote\.com/i.test(
        urlMatch[0],
      ) ||
        input.mode === "viral_link"),
  );
  const looksLikeScript = Boolean(
    input.mode === "script" ||
      input.scriptContent?.trim() ||
      /(第[一二三四五六七八九十\d]+[场镜幕]|分镜\s*\d+|镜头\s*\d+|景别|台词[:：]|旁白[:：]|画面[:：])/i.test(
        combinedText,
      ),
  );

  let detectedIntent: "viral_link" | "script" | "chat" =
    input.mode === "viral_link"
      ? "viral_link"
      : input.mode === "script"
        ? "script"
        : input.mode === "chat"
          ? "chat"
          : hasViralUrl
            ? "viral_link"
            : looksLikeScript
              ? "script"
              : "chat";

  const sourcePlatform: "douyin" | "xhs" | "url" | "manual" =
    detectedIntent === "viral_link"
      ? /douyin\.com|iesdouyin\.com/i.test(combinedText)
        ? "douyin"
        : /xiaohongshu\.com|xhslink\.com|rednote\.com/i.test(combinedText)
          ? "xhs"
          : urlMatch
            ? "url"
            : "manual"
      : "manual";

  // 启发式提取题材推荐（场景/道具/服饰）
  const isWuxia = /武侠|江湖|侠客|古风|仙侠|刀剑|铠甲/.test(combinedText);
  const isOutdoor = /户外|露营|街拍|citywalk|公园|海边/i.test(combinedText);
  const isStudio = /棚拍|极简|高级|杂志|纯色|大片/.test(combinedText);
  const suggestedScenes = isWuxia
    ? ["竹林深处武侠秘境：苍翠竹海、晨雾光束、古风江湖意境"]
    : isOutdoor
      ? ["巴黎午后街拍：法式街角咖啡馆、柔和自然日光、松弛通勤氛围"]
      : isStudio
        ? ["极简纯白影棚：柔和漫反射灯光、高级杂志质感、干净背景"]
        : ["现代买手店展厅：暖调射灯、木质陈列架、高级穿搭氛围"];
  const suggestedProps = isWuxia
    ? ["长剑", "佩刀", "折扇"]
    : isOutdoor
      ? ["咖啡杯", "手提包", "墨镜"]
      : ["衣架", "穿搭镜", "手提包"];
  const suggestedGarments = isWuxia
    ? ["玄铁铠甲", "粗麻布衣", "侠客披风"]
    : ["通勤西装外套", "垂感阔腿裤"];

  // 从剧本中启发式切分初始分镜
  const parseScriptShots = (raw: string): WorkflowShot[] => {
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const blocks: string[] = [];
    for (const line of lines) {
      if (
        /^(第[一二三四五六七八九十\d]+[场镜幕]|分镜\s*\d+|镜头\s*\d+|S\d+|\d+[\.、])/i.test(
          line,
        ) ||
        !blocks.length
      ) {
        blocks.push(line);
      } else {
        blocks[blocks.length - 1] += ` ${line}`;
      }
    }
    return blocks.slice(0, 8).map((block, idx) => ({
      id: `S${String(idx + 1).padStart(2, "0")}`,
      order: idx + 1,
      title: block.slice(0, 18) || `分镜 ${idx + 1}`,
      type: idx === 0 ? "talking_head" : "broll_video",
      caption: block.slice(0, 120),
      camera: idx === 0 ? "中近景竖屏，平视焦点" : "中景跟拍，展示细节",
      action: block.slice(0, 140),
      props: suggestedProps.slice(0, 2).join("、"),
      scene: suggestedScenes[0]?.split("：")[0] || "室内实拍场景",
      characterNames: ["主播"],
      durationSec: 5,
      storyboardPrompt: block.slice(0, 160),
      status: "pending",
    }));
  };

  const defaultTitle =
    detectedIntent === "viral_link"
      ? sourcePlatform === "douyin"
        ? "抖音爆款复刻成片"
        : sourcePlatform === "xhs"
          ? "小红书爆款复刻成片"
          : "爆款链接复刻成片"
      : detectedIntent === "script"
        ? (input.scriptFileName?.replace(/\.[^.]+$/, "") ||
            combinedText.split(/\r?\n/)[0]?.slice(0, 24) ||
            "创作剧本智能成片")
        : combinedText.slice(0, 22) || "AI 对话智能成片";

  let intent = {
    detectedIntent,
    sourcePlatform,
    sourceUrl: urlMatch?.[0] || (detectedIntent === "viral_link" ? combinedText : undefined),
    title: defaultTitle,
    creativeBrief: combinedText.slice(0, 1200) || "自然流畅的短视频智能成片创作",
    aspectRatio: (/16:9|横屏/.test(combinedText)
      ? "16:9"
      : /3:4|小红书/.test(combinedText)
        ? "3:4"
        : "9:16") as "9:16" | "16:9" | "3:4",
    targetDurationSec: Number(combinedText.match(/(\d{1,2})\s*秒/)?.[1]) || 20,
    intentSummary:
      detectedIntent === "viral_link"
        ? `已识别为${sourcePlatform === "douyin" ? "抖音" : sourcePlatform === "xhs" ? "小红书" : "外部"}爆款视频链接，将自动拉取并逆向拆解镜头与钩子。`
        : detectedIntent === "script"
          ? "已识别为创作剧本，将自动提取结构要点并拆分为可执行分镜轨道。"
          : `已识别为 AI 对话创作需求${input.attachmentNames.length ? `（含 ${input.attachmentNames.length} 个附件）` : ""}，已智能提炼拍摄方案并匹配场景/道具/服饰。`,
    assistantReply:
      detectedIntent === "viral_link"
        ? "已识别到爆款参考链接，点击创建后将立即导入并执行逆向拆解，提取前 3 秒钩子与分镜节奏。"
        : detectedIntent === "script"
          ? "已解析你的创作剧本，并自动拆分了初始分镜与参演资产建议。你可以继续补充修改，或直接创建项目进入时间轴精修。"
          : `已理解你的创作意图：「${defaultTitle}」。已为你规划 ${/16:9|横屏/.test(combinedText) ? "16:9 横屏" : "9:16 竖屏"}、推荐场景与服饰道具。你可以继续对话微调，或直接点击创建项目。`,
    suggestedScenes,
    suggestedProps,
    suggestedGarments,
    deconstructData:
      detectedIntent !== "viral_link" && combinedText
        ? {
            summary: combinedText.slice(0, 260),
            hook: combinedText.split(/[。！？\n]/)[0]?.slice(0, 80) || "开场直接切入核心看点",
            pacing: "前 3 秒强吸引钩子，中段细节展示，结尾自然收束引导",
            sellingPoints: [defaultTitle],
            targetAudience: "短视频精准兴趣人群",
            estimatedDurationSec: 20,
            referenceShots: [],
          }
        : undefined,
    initialShots:
      detectedIntent === "script" && combinedText
        ? parseScriptShots(input.scriptContent || combinedText)
        : ([] as WorkflowShot[]),
  };

  // 若配置了大模型且有有效文本，调用 LLM 增强意图识别与剧本拆分（超时/异常自动回退启发式结果）
  if (combinedText && (studio.config.openrouterApiKey || studio.config.videoSecrets?.AGENTAI_API_KEY)) {
    try {
      const llmRaw = await callWorkflowLlm(
        studio,
        input.modelConfig?.scriptModel,
        '你是专业短视频导演与创作意图识别助手。请根据用户输入、对话历史、附件文件名和剧本文本，识别创作意图并输出严格 JSON：{"detectedIntent":"viral_link|script|chat","title":"简短项目标题(<=24字)","intentSummary":"一句话总结AI识别到的创作意图","assistantReply":"以导演口吻回复用户(<=100字)，说明已理解的创意要点并引导建项或补充","creativeBrief":"整理后的完整拍摄与剪辑需求","aspectRatio":"9:16|16:9|3:4","targetDurationSec":20,"suggestedScenes":["场景名称：关键词"],"suggestedProps":["道具1"],"suggestedGarments":["服饰1"],"hook":"前3秒钩子","summary":"整体结构总结","pacing":"节奏建议","sellingPoints":["核心卖点1"],"shots":[{"title":"分镜标题","caption":"台词/旁白","camera":"机位景别","action":"画面动作","durationSec":5}]}。仅在识别为 script 时输出 shots（3~8 镜），其他模式 shots 输出空数组。',
        JSON.stringify({
          mode: input.mode,
          prompt: input.prompt,
          messages: input.messages.slice(-8),
          scriptFileName: input.scriptFileName,
          scriptContent: input.scriptContent?.slice(0, 6000),
          attachmentNames: input.attachmentNames,
        }),
      );
      const llmIntent = String(llmRaw.detectedIntent || "");
      if (
        input.mode === "auto" &&
        (llmIntent === "viral_link" || llmIntent === "script" || llmIntent === "chat")
      ) {
        detectedIntent = llmIntent;
      }
      const llmShotsRaw = Array.isArray(llmRaw.shots) ? llmRaw.shots : [];
      const llmShots: WorkflowShot[] =
        detectedIntent === "script" && llmShotsRaw.length
          ? llmShotsRaw.slice(0, 10).map((s: any, idx: number) => ({
              id: `S${String(idx + 1).padStart(2, "0")}`,
              order: idx + 1,
              title: String(s?.title || `分镜 ${idx + 1}`).slice(0, 60),
              type: idx === 0 ? "talking_head" : "broll_video",
              caption: String(s?.caption || "").slice(0, 300),
              camera: String(s?.camera || "中景竖屏").slice(0, 120),
              action: String(s?.action || "").slice(0, 300),
              props: (Array.isArray(llmRaw.suggestedProps)
                ? llmRaw.suggestedProps.slice(0, 2).join("、")
                : suggestedProps.slice(0, 2).join("、")),
              scene: String(
                (Array.isArray(llmRaw.suggestedScenes) && llmRaw.suggestedScenes[0]) ||
                  suggestedScenes[0] ||
                  "",
              ).slice(0, 80),
              characterNames: ["主播"],
              durationSec: Math.max(2, Math.min(20, Number(s?.durationSec) || 5)),
              storyboardPrompt: String(s?.action || s?.title || "").slice(0, 300),
              status: "pending",
            }))
          : intent.initialShots;

      intent = {
        ...intent,
        detectedIntent,
        title: String(llmRaw.title || intent.title).slice(0, 60),
        intentSummary: String(llmRaw.intentSummary || intent.intentSummary).slice(0, 220),
        assistantReply: String(llmRaw.assistantReply || intent.assistantReply).slice(0, 300),
        creativeBrief: String(llmRaw.creativeBrief || intent.creativeBrief).slice(0, 1500),
        aspectRatio:
          llmRaw.aspectRatio === "16:9" || llmRaw.aspectRatio === "3:4"
            ? llmRaw.aspectRatio
            : "9:16",
        targetDurationSec: Math.max(
          5,
          Math.min(90, Math.round(Number(llmRaw.targetDurationSec) || intent.targetDurationSec)),
        ),
        suggestedScenes:
          Array.isArray(llmRaw.suggestedScenes) && llmRaw.suggestedScenes.length
            ? llmRaw.suggestedScenes.map((x: unknown) => String(x).slice(0, 80)).slice(0, 4)
            : intent.suggestedScenes,
        suggestedProps:
          Array.isArray(llmRaw.suggestedProps) && llmRaw.suggestedProps.length
            ? llmRaw.suggestedProps.map((x: unknown) => String(x).slice(0, 40)).slice(0, 6)
            : intent.suggestedProps,
        suggestedGarments:
          Array.isArray(llmRaw.suggestedGarments) && llmRaw.suggestedGarments.length
            ? llmRaw.suggestedGarments.map((x: unknown) => String(x).slice(0, 40)).slice(0, 6)
            : intent.suggestedGarments,
        deconstructData:
          detectedIntent !== "viral_link"
            ? {
                summary: String(llmRaw.summary || intent.deconstructData?.summary || "").slice(0, 800),
                hook: String(llmRaw.hook || intent.deconstructData?.hook || "").slice(0, 300),
                pacing: String(llmRaw.pacing || intent.deconstructData?.pacing || "").slice(0, 300),
                sellingPoints: Array.isArray(llmRaw.sellingPoints)
                  ? llmRaw.sellingPoints.map((x: unknown) => String(x).slice(0, 100)).slice(0, 8)
                  : intent.deconstructData?.sellingPoints || [],
                targetAudience: "短视频精准兴趣人群",
                estimatedDurationSec: intent.targetDurationSec,
                referenceShots: [],
              }
            : undefined,
        initialShots: llmShots,
      };
    } catch {
      // 模型未配置或超时时平滑使用启发式识别结果
    }
  }

  return intent;
}

/** 服装口播爆款复刻工作流 REST API 路由处理 */
export async function handleCommerceTalkWorkflow(
  studio: Studio,
  actor: Actor,
  suffix: string,
  req: Request,
  res: Response,
  readBody: () => Promise<unknown>,
) {
  requirePermission(actor, "product.read");

  if (suffix === "/workflows/catalog" && req.method === "GET") {
    return res.json(await workflowCatalog(studio, actor));
  }

  if (suffix === "/workflows/smart-create" && req.method === "POST") {
    const input = parse(smartCreateWorkflowInputSchema, await readBody());
    const intent = await analyzeSmartCreateIntent(studio, input);
    if (input.previewOnly) {
      return res.json({ intent });
    }

    const id = randomUUID();
    const isViral = intent.detectedIntent === "viral_link" && Boolean(intent.sourceUrl);
    const hasScriptShots =
      intent.detectedIntent === "script" && intent.initialShots.length > 0;
    const initialStage: WorkflowStage = isViral
      ? "importing"
      : hasScriptShots
        ? "review_script"
        : "draft";

    const assetsConfig: Partial<WorkflowAssetsConfig> = {
      creativeBrief: intent.creativeBrief,
      aspectRatio: intent.aspectRatio,
      targetDurationSec: intent.targetDurationSec,
      sceneKeywords: intent.suggestedScenes,
      propKeywords: intent.suggestedProps,
      garmentKeywords: intent.suggestedGarments,
    };

    const created = await one(
      db,
      `INSERT INTO public.commerce_talk_workflows
       (id, user_id, title, run_mode, stage, source_platform, source_url, source_meta, deconstruct_data, assets_config, model_config, shots)
       VALUES ($1::uuid, $2::bigint, $3, 'assisted', $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb)
       RETURNING *`,
      id,
      actor.id,
      intent.title,
      initialStage,
      intent.sourcePlatform,
      intent.sourceUrl || null,
      JSON.stringify({
        intentType: intent.detectedIntent,
        intentSummary: intent.intentSummary,
        scriptFileName: input.scriptFileName,
      }),
      intent.deconstructData ? JSON.stringify(intent.deconstructData) : null,
      JSON.stringify(assetsConfig),
      JSON.stringify(input.modelConfig || {}),
      JSON.stringify(intent.initialShots || []),
    );
    return res.status(201).json({
      workflow: workflowView(created!),
      intent,
    });
  }

  if (suffix === "/workflows" && req.method === "GET") {
    const list = await rows(
      db,
      "SELECT * FROM public.commerce_talk_workflows WHERE user_id=$1::bigint ORDER BY updated_at DESC LIMIT 30",
      actor.id,
    );
    return res.json({ workflows: list.map(workflowView) });
  }

  if (suffix === "/workflows" && req.method === "POST") {
    const input = parse(createWorkflowInputSchema, await readBody());
    const id = randomUUID();
    const title =
      input.title ||
      input.sourceMeta?.title?.slice(0, 80) ||
      (input.sourcePlatform === "douyin"
        ? "抖音爆款复刻口播"
        : input.sourcePlatform === "xhs"
          ? "小红书爆款复刻口播"
          : "服装口播工作流");
    const initialStage: WorkflowStage =
      input.autoStart && input.sourceUrl ? "importing" : "draft";
    const created = await one(
      db,
      `INSERT INTO public.commerce_talk_workflows
       (id, user_id, title, run_mode, stage, source_platform, source_url, source_meta, assets_config, model_config, max_speech_cny)
       VALUES ($1::uuid, $2::bigint, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11)
       RETURNING *`,
      id,
      actor.id,
      title,
      input.runMode,
      initialStage,
      input.sourcePlatform,
      input.sourceUrl || null,
      JSON.stringify(input.sourceMeta || {}),
      JSON.stringify(input.assetsConfig || {}),
      JSON.stringify(input.modelConfig || {}),
      input.maxSpeechCny ?? null,
    );
    return res.status(201).json(workflowView(created!));
  }

  const wfMatch =
    /^\/workflows\/([a-f0-9-]{36})(?:\/(assets|import-reference|advance|cozyclay\/export|ai-edit|ae-script)|\/shots\/([\w-]+)\/regenerate)?$/i.exec(
      suffix,
    );
  if (!wfMatch) return res.status(404).json({ error: "找不到该工作流接口" });

  const [, workflowId, action, shotId] = wfMatch;
  const workflow = await ownedWorkflow(actor, workflowId);

  if (!action && !shotId) {
    if (req.method === "GET") return res.json(workflowView(workflow));
    if (req.method === "DELETE") {
      await db.$executeRawUnsafe(
        "DELETE FROM public.commerce_talk_workflows WHERE id=$1::uuid AND user_id=$2::bigint",
        workflow.id,
        actor.id,
      );
      return res.json({ deleted: true });
    }
    if (req.method === "PATCH") {
      const patch = parse(updateWorkflowInputSchema, await readBody());
      const mergedAssets = patch.assetsConfig
        ? { ...(workflow.assets_config || {}), ...patch.assetsConfig }
        : workflow.assets_config;
      const mergedModels = patch.modelConfig
        ? { ...(workflow.model_config || {}), ...patch.modelConfig }
        : workflow.model_config;
      const mergedCozyclay = patch.cozyclayState
        ? { ...(workflow.cozyclay_state || {}), ...patch.cozyclayState }
        : workflow.cozyclay_state;
      const updated = await one(
        db,
        `UPDATE public.commerce_talk_workflows
         SET title=COALESCE($2, title),
             run_mode=COALESCE($3, run_mode),
             deconstruct_data=COALESCE($4::jsonb, deconstruct_data),
             assets_config=$5::jsonb,
             model_config=$6::jsonb,
             shots=COALESCE($7::jsonb, shots),
             cozyclay_state=$8::jsonb,
             max_speech_cny=CASE WHEN $9 THEN $10 ELSE max_speech_cny END,
             revision=revision+1,
             updated_at=now()
         WHERE id=$1::uuid RETURNING *`,
        workflow.id,
        patch.title ?? null,
        patch.runMode ?? null,
        patch.deconstructData ? JSON.stringify(patch.deconstructData) : null,
        JSON.stringify(mergedAssets || {}),
        JSON.stringify(mergedModels || {}),
        patch.shots ? JSON.stringify(patch.shots) : null,
        JSON.stringify(mergedCozyclay || {}),
        patch.maxSpeechCny !== undefined,
        patch.maxSpeechCny ?? null,
      );
      return res.json(workflowView(updated!));
    }
  }

  if (action === "assets" && req.method === "POST") {
    return res
      .status(201)
      .json(await uploadWorkflowAsset(studio, actor, workflow, req));
  }

  if (action === "import-reference" && req.method === "POST") {
    const body = parse(
      z
        .object({
          shareText: z.string().trim().min(1).max(4096),
          fallbackVideoUrl: z.string().trim().max(4096).optional(),
          sourcePlatform: z
            .enum(["douyin", "xhs", "url", "upload", "manual"])
            .optional(),
          title: z.string().trim().max(200).optional(),
        })
        .strict(),
      await readBody(),
    );
    const dir = await mkdtemp(join(tmpdir(), "xuti-wf-ref-"));
    const target = join(dir, "reference.bin");
    const controller = new AbortController();
    try {
      let downloaded;
      try {
        downloaded = await downloadPublicReference(
          body.shareText,
          target,
          maxAssetBytes(),
          controller.signal,
        );
      } catch (primaryErr) {
        if (!body.fallbackVideoUrl) throw primaryErr;
        downloaded = await downloadPublicReference(
          body.fallbackVideoUrl,
          target,
          maxAssetBytes(),
          controller.signal,
        );
      }
      const buffer = await readFile(target);
      const asset = await studio.store.putAsset({
        buffer,
        name: downloaded.name || `reference${extname(target) || ".mp4"}`,
        kind: "workflow_referenceVideo",
        mime: downloaded.mime || "video/mp4",
        ownerId: actor.id,
        projectId: workflow.id,
        source: `commerce-talk-workflow:${workflow.id}:reference`,
      });
      const updated = await one(
        db,
        `UPDATE public.commerce_talk_workflows
         SET source_url=$2,
             source_platform=COALESCE($3, source_platform),
             title=CASE WHEN $4<>'' THEN $4 ELSE title END,
             reference_asset_id=$5::uuid,
             message=NULL,
             revision=revision+1,
             updated_at=now()
         WHERE id=$1::uuid RETURNING *`,
        workflow.id,
        body.shareText,
        body.sourcePlatform ?? null,
        body.title || downloaded.name || "",
        asset.path,
      );
      return res.status(201).json(workflowView(updated!));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  if (action === "cozyclay/export" && req.method === "GET") {
    const assetsConfig = (workflow.assets_config || {}) as Partial<WorkflowAssetsConfig>;
    const shots = (Array.isArray(workflow.shots) ? workflow.shots : []) as WorkflowShot[];
    const project = buildCozyClayProjectV5({
      workflowId: workflow.id,
      title: workflow.title,
      characters: [
        { id: "char_presenter", name: "主播" },
        ...(assetsConfig.characters || []).map((c) => ({ id: c.id, name: c.name })),
      ],
      props: (assetsConfig.props || []).map((p) => ({
        id: p.id,
        name: p.name,
        note: p.note,
      })),
      shots,
    });
    const nextState = {
      ...(workflow.cozyclay_state || {}),
      exportedAt: new Date().toISOString(),
    };
    await db.$executeRawUnsafe(
      "UPDATE public.commerce_talk_workflows SET cozyclay_state=$2::jsonb, updated_at=now() WHERE id=$1::uuid",
      workflow.id,
      JSON.stringify(nextState),
    );
    if (req.query.download === "1") {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="xuti-previs-${String(workflow.id).slice(0, 8)}.cclayproject"`,
      );
    }
    return res.json(project);
  }

  // AI 代码自动化智能剪辑：调用大模型（带确定性节奏编排降级）自动编排全部分镜的转场、滤镜、特效、运镜动画与动态字幕
  if (action === "ai-edit" && req.method === "POST") {
    const input = parse(aiEditWorkflowInputSchema, await readBody());
    const shots = (Array.isArray(workflow.shots) ? workflow.shots : []) as WorkflowShot[];
    if (!shots.length) {
      fail("NO_SHOTS", "当前工作流尚无分镜，请先生成分镜脚本或新增分镜后再执行 AI 智能剪辑", 400);
    }

    const fallback = buildHeuristicPostEditPlan(shots, input);
    let plan = fallback;
    let engine: "llm" | "heuristic" = "heuristic";

    try {
      const modelConfig = (workflow.model_config || {}) as Partial<WorkflowModelConfig>;
      const systemPrompt = [
        "你是资深服装短视频与 Adobe After Effects 后期剪辑导演。",
        "请根据用户的剪辑指令与分镜脚本，为每个分镜编排最契合节奏的后期剪辑参数（仅输出合法 JSON）。",
        `可选 transition: ${workflowTransitions.join(", ")}（第1镜固定 none）`,
        `可选 filter: ${workflowFilters.join(", ")}`,
        `可选 effect: ${workflowEffects.join(", ")}`,
        `可选 motion: ${workflowMotions.join(", ")}`,
        `可选 subtitleStyle: ${workflowSubtitleStyles.join(", ")}`,
        "JSON 格式：{ \"summary\": \"一句话剪辑思路\", \"shots\": [{ \"id\": \"S01\", \"postEdit\": { \"transition\": \"none\", \"transitionDurationSec\": 0.4, \"filter\": \"warm_fashion\", \"effect\": \"flash_in\", \"motion\": \"pop_in\", \"subtitleStyle\": \"hormozi_pop\", \"titleOverlay\": \"显瘦神裤\" } }] }",
      ].join("\n");
      const userPrompt = JSON.stringify({
        preset: input.preset,
        instruction: input.instruction || "自动优化服装带货短视频的节奏、转场、滤镜、特效、运镜与字幕动效",
        title: workflow.title,
        shots: shots.map((s) => ({
          id: s.id,
          title: s.title,
          type: s.type,
          durationSec: s.durationSec,
          caption: s.caption,
          action: s.action,
        })),
      });
      const raw = await callWorkflowLlm(
        studio,
        modelConfig.scriptModel,
        systemPrompt,
        userPrompt,
      );
      plan = sanitizeAiPostEditResponse(raw, shots, fallback);
      engine = "llm";
    } catch {
      // 未配置外部大模型或网络异常时，无缝降级为内置智能节奏编排引擎，保证功能 100% 可用
      plan = fallback;
      engine = "heuristic";
    }

    const nextShots: WorkflowShot[] = shots.map((shot) => ({
      ...shot,
      postEdit: plan.shotEdits[shot.id] || shot.postEdit,
    }));
    const nextAssetsConfig = {
      ...(workflow.assets_config || {}),
      postEditDefaults: plan.postEditDefaults,
    };

    const updated = await one(
      db,
      `UPDATE public.commerce_talk_workflows
       SET shots=$2::jsonb,
           assets_config=$3::jsonb,
           message=$4,
           revision=revision+1,
           updated_at=now()
       WHERE id=$1::uuid RETURNING *`,
      workflow.id,
      JSON.stringify(nextShots),
      JSON.stringify(nextAssetsConfig),
      plan.summary,
    );
    return res.json({
      workflow: workflowView(updated!),
      summary: plan.summary,
      engine,
    });
  }

  // 导出标准 Adobe After Effects ExtendScript (.jsx) 自动化剪辑脚本
  if (action === "ae-script" && req.method === "GET") {
    const assetsConfig = (workflow.assets_config || {}) as Partial<WorkflowAssetsConfig>;
    const shots = (Array.isArray(workflow.shots) ? workflow.shots : []) as WorkflowShot[];
    const script = buildAfterEffectsScript({
      id: workflow.id,
      title: workflow.title,
      aspectRatio: assetsConfig.aspectRatio,
      shots,
    });
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    if (req.query.download === "1") {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="xuti-ae-edit-${String(workflow.id).slice(0, 8)}.jsx"`,
      );
    }
    return res.send(script);
  }

  if (action === "advance" && req.method === "POST") {
    const { action: step } = parse(advanceWorkflowInputSchema, await readBody());
    if (workflowActiveStages.includes(workflow.stage)) {
      fail("WORKFLOW_BUSY", "当前步骤正在后台处理中，请稍候", 409);
    }
    let nextStage: WorkflowStage = workflow.stage;
    let nextRunMode: WorkflowRunMode = workflow.run_mode;
    const cozyclayState = {
      ...(workflow.cozyclay_state || {}),
    } as WorkflowCozyClayState;

    if (step === "deconstruct") nextStage = "deconstructing";
    else if (step === "script") nextStage = "scripting";
    else if (step === "storyboard") nextStage = "storyboarding";
    else if (step === "skip_previs") {
      cozyclayState.skipped = true;
      nextStage = "producing";
    } else if (step === "produce") nextStage = "producing";
    else if (step === "render") nextStage = "rendering";
    else if (step === "auto_finish") {
      nextRunMode = "auto";
      if (workflow.stage === "draft")
        nextStage = workflow.source_url && !workflow.reference_asset_id ? "importing" : "deconstructing";
      else if (workflow.stage === "review_deconstruct") nextStage = "scripting";
      else if (workflow.stage === "review_script") nextStage = "storyboarding";
      else if (workflow.stage === "review_storyboard" || workflow.stage === "previs")
        nextStage = "producing";
      else if (workflow.stage === "review_clips") nextStage = "rendering";
      else nextStage = "deconstructing";
    }

    const updated = await one(
      db,
      `UPDATE public.commerce_talk_workflows
       SET stage=$2, run_mode=$3, cozyclay_state=$4::jsonb, message=NULL, revision=revision+1, updated_at=now()
       WHERE id=$1::uuid RETURNING *`,
      workflow.id,
      nextStage,
      nextRunMode,
      JSON.stringify(cozyclayState),
    );
    return res.status(202).json(workflowView(updated!));
  }

  if (shotId && req.method === "POST") {
    const body = parse(
      z
        .object({
          target: z.enum(["storyboard", "clip"]),
          videoModelOverride: z.string().trim().max(160).optional(),
        })
        .strict(),
      await readBody(),
    );
    const shots = ([...(workflow.shots || [])] as WorkflowShot[]);
    const idx = shots.findIndex((s) => s.id === shotId);
    if (idx < 0) fail("SHOT_NOT_FOUND", "找不到该分镜", 404);
    if (body.target === "storyboard") {
      shots[idx] = {
        ...shots[idx],
        storyboardAssetId: undefined,
        status: "pending",
        error: undefined,
      };
    } else {
      shots[idx] = {
        ...shots[idx],
        clipAssetId: undefined,
        operationId: undefined,
        videoModelOverride: body.videoModelOverride ?? shots[idx].videoModelOverride,
        status: "ready",
        error: undefined,
      };
    }
    const nextStage: WorkflowStage =
      body.target === "storyboard" ? "storyboarding" : "producing";
    const updated = await one(
      db,
      `UPDATE public.commerce_talk_workflows
       SET shots=$2::jsonb, stage=$3, message=NULL, revision=revision+1, updated_at=now()
       WHERE id=$1::uuid RETURNING *`,
      workflow.id,
      JSON.stringify(shots),
      nextStage,
    );
    return res.status(202).json(workflowView(updated!));
  }

  return res.status(405).json({ error: "不支持此操作" });
}

/** 后台异步状态机：按阶段推进服装口播工作流（支持全自动与人工介入暂停） */
export async function processCommerceTalkWorkflow(
  studio: Studio,
  active: () => boolean,
) {
  const wf = await one(
    db,
    `SELECT * FROM public.commerce_talk_workflows
     WHERE stage IN ('importing','deconstructing','scripting','storyboarding','producing','rendering')
     ORDER BY updated_at LIMIT 1`,
  );
  if (!wf || !active()) return;

  const stage = String(wf.stage) as WorkflowStage;
  const runMode = String(wf.run_mode) as WorkflowRunMode;
  const modelConfig = (wf.model_config || {}) as WorkflowModelConfig;
  const assetsConfig = (wf.assets_config || {}) as Partial<WorkflowAssetsConfig>;

  try {
    const actor = await activeActor(String(wf.user_id));
    requirePermission(actor, "aigc.use");
    requirePermission(actor, "product.read");

    // 阶段 A：自动导入抖音/小红书参考视频
    if (stage === "importing") {
      const sourceUrl = String(wf.source_url || "");
      const meta = (wf.source_meta || {}) as Record<string, any>;
      if (!sourceUrl && !wf.reference_asset_id) {
        await db.$executeRawUnsafe(
          "UPDATE public.commerce_talk_workflows SET stage='deconstructing', updated_at=now() WHERE id=$1::uuid",
          wf.id,
        );
        return;
      }
      let refAssetId = wf.reference_asset_id as string | null;
      if (!refAssetId && sourceUrl) {
        const dir = await mkdtemp(join(tmpdir(), "xuti-wf-imp-"));
        const target = join(dir, "ref.bin");
        try {
          let downloaded;
          try {
            downloaded = await downloadPublicReference(
              sourceUrl,
              target,
              maxAssetBytes(),
              AbortSignal.timeout(45_000),
            );
          } catch {
            if (typeof meta.fallbackVideoUrl === "string" && meta.fallbackVideoUrl) {
              downloaded = await downloadPublicReference(
                meta.fallbackVideoUrl,
                target,
                maxAssetBytes(),
                AbortSignal.timeout(45_000),
              );
            }
          }
          if (downloaded) {
            const buffer = await readFile(target);
            const stored = await studio.store.putAsset({
              buffer,
              name: downloaded.name || "reference.mp4",
              kind: "workflow_referenceVideo",
              mime: downloaded.mime || "video/mp4",
              ownerId: actor.id,
              projectId: wf.id,
              source: `commerce-talk-workflow:${wf.id}:reference`,
            });
            refAssetId = stored.path;
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      await db.$executeRawUnsafe(
        `UPDATE public.commerce_talk_workflows
         SET reference_asset_id=$2::uuid, stage='deconstructing', message=$3, updated_at=now()
         WHERE id=$1::uuid`,
        wf.id,
        refAssetId,
        refAssetId ? null : "未能自动拉取视频文件，已基于页面元数据继续逆向拆解（你也可手动上传参考视频）",
      );
      return;
    }

    // 阶段 B：爆款视频逆向拆解
    if (stage === "deconstructing") {
      const contentParts: Array<Record<string, unknown>> = [];
      let durationSec: number | undefined;
      if (wf.reference_asset_id) {
        const ref = await studio.store.readAsset(wf.reference_asset_id);
        if (ref?.buffer) {
          const extracted = await extractReferenceKeyframes(ref.buffer);
          durationSec = extracted.durationSec;
          for (const frame of extracted.frames) {
            contentParts.push({
              type: "text",
              text: `参考视频关键帧（约 ${frame.sec} 秒）`,
            });
            contentParts.push({
              type: "image_url",
              image_url: { url: frame.dataUrl },
            });
          }
        }
      }
      contentParts.unshift({
        type: "text",
        text: JSON.stringify({
          来源平台: wf.source_platform,
          来源链接: wf.source_url || "",
          页面元数据: wf.source_meta || {},
          参考时长秒: durationSec || null,
          拍摄需求补充: assetsConfig.creativeBrief || "",
        }),
      });
      const systemPrompt =
        '你是资深服装短视频爆款导演。请对提供的同行爆款服装口播参考视频关键帧及元数据进行逆向拆解，严格输出 JSON：{"summary":"整体结构总结","hook":"前3秒留人钩子","pacing":"节奏与转场分析","sellingPoints":["卖点1"],"targetAudience":"目标受众","estimatedDurationSec":20,"referenceShots":[{"index":1,"timeRange":"0-4s","shotType":"口播/展示/特写","camera":"景别与运镜","action":"人物动作与展示重点","transcript":"推断口播要点","visualHook":"视觉吸睛点"}]}。只输出合法 JSON。';
      const raw = await callWorkflowLlm(
        studio,
        modelConfig.deconstructModel || "openrouter|google/gemini-4-neon",
        systemPrompt,
        contentParts,
      );
      const deconstruct = workflowDeconstructSchema.parse({
        ...raw,
        estimatedDurationSec:
          Number(raw.estimatedDurationSec) || durationSec || 20,
      });
      const nextStage: WorkflowStage =
        runMode === "auto" ? "scripting" : "review_deconstruct";
      await db.$executeRawUnsafe(
        `UPDATE public.commerce_talk_workflows
         SET deconstruct_data=$2::jsonb, stage=$3, message=NULL, updated_at=now()
         WHERE id=$1::uuid`,
        wf.id,
        JSON.stringify(deconstruct),
        nextStage,
      );
      return;
    }

    // 阶段 C：融合数字人角色库（面部+三视图+音色）/商品/道具/场景/需求重构多角度出镜分镜脚本
    if (stage === "scripting") {
      const product = assetsConfig.productId
        ? await commerceProduct(actor, assetsConfig.productId).catch(() => undefined)
        : undefined;
      const boundCharacters = await loadDigitalHumanCharactersByIds(
        actor,
        assetsConfig.characterLibraryIds || [],
      );
      const systemPrompt =
        '你是服装口播分镜导演。请结合「同行爆款拆解结构」「我的商品真实资料」「数字人角色库（具备面部与正面/背面/侧面三视图）」「道具/场景」「拍摄需求」创作可直接拍摄与 AI 生成的多角度出镜分镜脚本。重要原则：数字人可以自然参与全片各类镜头出镜，严禁局限于固定一个角度位置进行呆板口播，应合理编排正面近景（front_closeup）、正面中景（front_medium）、45°/90°侧面轮廓（side_profile）、背面展示/回眸（back_turn）、全身走动交互（walking_full）、过肩/对镜视角（over_shoulder）。严格输出 JSON：{"shots":[{"id":"S01","order":1,"title":"开场痛点钩子","type":"talking_head|previs_video|broll_video|product_insert","characterId":"绑定角色库ID（可选）","characterAngle":"front_closeup|front_medium|side_profile|back_turn|walking_full|over_shoulder|auto","caption":"自然普通话口播台词（6至42字，严禁编造未提供的面料/价格）","camera":"景别与机位描述","action":"人物动作、走位转身与服装展示细节","props":"涉及道具或服饰细节","scene":"场景光影与环境","characterNames":["角色名"],"durationSec":5,"storyboardPrompt":"用于生图模型的高质量竖屏9:16分镜画面提示词"}]}。共生成 3 至 8 镜，只输出合法 JSON。';
      const userPayload = JSON.stringify({
        爆款拆解结构: wf.deconstruct_data || {},
        商品资料: product?.facts || { 说明: "未绑定档案商品，按拍摄需求中性表达" },
        数字人角色库: boundCharacters.map((c) => ({
          id: c.id,
          name: c.name,
          persona: c.persona,
          已备视图: [
            c.faceAssetId ? "面部" : null,
            c.frontAssetId ? "正面" : null,
            c.backAssetId ? "背面" : null,
            c.sideAssetId ? "侧面" : null,
          ].filter(Boolean),
        })),
        补充角色图: (assetsConfig.characters || []).map((c) => c.name),
        服饰库: [
          ...(assetsConfig.garments || []).map((g) => g.name),
          ...(assetsConfig.garmentKeywords || []),
        ],
        道具库: [
          ...(assetsConfig.props || []).map((p) => p.name),
          ...(assetsConfig.propKeywords || []),
        ],
        场景库: [
          ...(assetsConfig.scenes || []).map((s) => s.name),
          ...(assetsConfig.sceneKeywords || []),
        ],
        场景模式: assetsConfig.sceneMode || "smart",
        目标时长秒: assetsConfig.targetDurationSec || 20,
        拍摄需求: assetsConfig.creativeBrief || "自然真实服装带货口播，多机位多角度出镜",
      });
      const raw = await callWorkflowLlm(
        studio,
        modelConfig.scriptModel || "openrouter|openai/gpt-6.2-astra",
        systemPrompt,
        userPayload,
      );
      const rawShots = Array.isArray(raw.shots) ? raw.shots : [];
      if (!rawShots.length)
        throw Error("脚本模型未返回有效分镜，请补充拍摄需求后重试");
      const productImageIds = assetsConfig.productImageIds || [];
      const validCharIds = new Set(boundCharacters.map((c) => c.id));
      const defaultChar = boundCharacters[0];
      const shots: WorkflowShot[] = rawShots.slice(0, 12).map((item: any, idx: number) =>
        workflowShotSchema.parse({
          id: `S${String(idx + 1).padStart(2, "0")}`,
          order: idx + 1,
          title: String(item.title || `分镜 ${idx + 1}`).slice(0, 80),
          type: [
            "talking_head",
            "previs_video",
            "broll_video",
            "product_insert",
          ].includes(item.type)
            ? item.type
            : idx === 0
              ? "talking_head"
              : "broll_video",
          caption: String(item.caption || "").slice(0, 180),
          camera: String(item.camera || "").slice(0, 600),
          action: String(item.action || "").slice(0, 800),
          props: String(item.props || "").slice(0, 300),
          scene: String(item.scene || "").slice(0, 400),
          characterNames: Array.isArray(item.characterNames)
            ? item.characterNames.slice(0, 4).map((n: unknown) => String(n).slice(0, 60))
            : defaultChar
              ? [defaultChar.name]
              : ["主播"],
          characterId:
            typeof item.characterId === "string" && validCharIds.has(item.characterId)
              ? item.characterId
              : defaultChar?.id,
          characterAngle: [
            "auto",
            "front_closeup",
            "front_medium",
            "side_profile",
            "back_turn",
            "walking_full",
            "over_shoulder",
          ].includes(item.characterAngle)
            ? item.characterAngle
            : idx === 0
              ? "front_medium"
              : idx % 3 === 1
                ? "side_profile"
                : idx % 3 === 2
                  ? "walking_full"
                  : "back_turn",
          productImageId: productImageIds.length
            ? productImageIds[idx % productImageIds.length]
            : undefined,
          durationSec: Math.max(3, Math.min(15, Number(item.durationSec) || 5)),
          storyboardPrompt: String(
            item.storyboardPrompt || `${item.camera || ""} ${item.action || ""} ${item.scene || ""}`,
          ).slice(0, 2000),
          status: "pending",
        }),
      );
      const nextStage: WorkflowStage =
        runMode === "auto" ? "storyboarding" : "review_script";
      await db.$executeRawUnsafe(
        `UPDATE public.commerce_talk_workflows
         SET shots=$2::jsonb, stage=$3, message=NULL, updated_at=now()
         WHERE id=$1::uuid`,
        wf.id,
        JSON.stringify(shots),
        nextStage,
      );
      return;
    }

    // 阶段 D：分镜图（关键帧）批量生成
    if (stage === "storyboarding") {
      const shots = ([...(wf.shots || [])] as WorkflowShot[]);
      const imgRoute = keyframeImageRoute(studio.config, {
        modelId: modelConfig.storyboardImageModel,
      });
      const imageReady = imageRouteConfigured(studio.config, imgRoute);

      // 收集公共参考图（补充角色 + 商品 + 道具 + 场景）以及角色库多视图映射
      const boundCharacters = await loadDigitalHumanCharactersByIds(
        actor,
        [
          ...(assetsConfig.characterLibraryIds || []),
          ...shots.map((s) => s.characterId || ""),
        ],
      );
      const characterMap = new Map(boundCharacters.map((c) => [c.id, c]));
      const baseRefBuffers: Buffer[] = [];
      for (const item of [
        ...(assetsConfig.garments || []).slice(0, 2),
        ...(assetsConfig.characters || []).slice(0, 2),
        ...(assetsConfig.props || []).slice(0, 2),
        ...(assetsConfig.scenes || []).slice(0, 1),
      ]) {
        const loaded = await studio.store.readAsset(item.assetId);
        if (loaded?.buffer) baseRefBuffers.push(loaded.buffer);
      }
      if (assetsConfig.productId && assetsConfig.productImageIds?.length) {
        const product = await commerceProduct(actor, assetsConfig.productId).catch(
          () => undefined,
        );
        if (product) {
          for (const pid of assetsConfig.productImageIds.slice(0, 2)) {
            const p = product.images.find((img) => img.id === pid);
            if (p) {
              const img = await commerceProductImage(p.source, product.tableId).catch(
                () => undefined,
              );
              if (img?.content) baseRefBuffers.push(img.content);
            }
          }
        }
      }

      const toDataUri = async (buf: Buffer) => {
        const jpg = await sharp(buf)
          .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 84 })
          .toBuffer();
        return `data:image/jpeg;base64,${jpg.toString("base64")}`;
      };

      let hadEnoughRefs = baseRefBuffers.length >= 2 || boundCharacters.length > 0;
      if (imageReady && hadEnoughRefs) {
        const baseDataUris = await Promise.all(baseRefBuffers.slice(0, 4).map(toDataUri));
        for (let i = 0; i < shots.length; i++) {
          if (!active()) return;
          const shot = shots[i];
          if (shot.storyboardAssetId || shot.type === "product_insert") {
            shots[i] = { ...shot, status: "ready" };
            continue;
          }
          try {
            // 优先按分镜视角注入该数字人角色的面部 + 正/背/侧对应三视图
            const shotChar =
              (shot.characterId ? characterMap.get(shot.characterId) : undefined) ||
              boundCharacters[0];
            const charViewUris: string[] = [];
            if (shotChar) {
              const viewIds = pickCharacterViewAssetIds(
                shotChar,
                shot.characterAngle || "auto",
              ).slice(0, 3);
              for (const vid of viewIds) {
                const loaded = await studio.store.readAsset(vid);
                if (loaded?.buffer) charViewUris.push(await toDataUri(loaded.buffer));
              }
            }
            const shotImages = [...charViewUris, ...baseDataUris].slice(0, 6);
            if (shotImages.length < 2) {
              hadEnoughRefs = false;
              shots[i] = { ...shot, status: "ready" };
              continue;
            }
            const angleHint = characterAnglePromptHint(shot.characterAngle || "auto");
            const body = keyframeImageBody(imgRoute, {
              prompt: `服装带货竖屏分镜图：${shot.storyboardPrompt || `${shot.camera}，${shot.action}，${shot.scene}`}。出镜视角要求：${angleHint}。${shotChar?.persona ? `出镜数字人特征：${shotChar.persona}。` : ""}严格保持参考数字人的面部五官、身形三视图与服装外观一致，电影级真实光影，无文字水印。`,
              images: shotImages,
              aspectRatio: assetsConfig.aspectRatio || "9:16",
            });
            const taskId = await submitKeyframe(studio.config, imgRoute, body);
            let url = "";
            for (let poll = 0; poll < 30; poll++) {
              if (!active()) return;
              await new Promise((r) => setTimeout(r, 3000));
              const res = await pollKeyframe(studio.config, imgRoute, taskId);
              if (!res.pending) {
                if (res.state === "success" && res.url) url = res.url;
                break;
              }
            }
            if (url) {
              const fetched = await fetch(url, { signal: AbortSignal.timeout(30_000) });
              if (fetched.ok) {
                const imgBuf = Buffer.from(await fetched.arrayBuffer());
                const saved = await studio.store.putAsset({
                  buffer: imgBuf,
                  name: `storyboard-${shot.id}.png`,
                  kind: "workflow_storyboard",
                  mime: "image/png",
                  ownerId: actor.id,
                  projectId: wf.id,
                  source: `commerce-talk-workflow:${wf.id}:storyboard:${shot.id}`,
                });
                shots[i] = {
                  ...shot,
                  storyboardAssetId: saved.path,
                  status: "ready",
                  error: undefined,
                };
                continue;
              }
            }
            shots[i] = { ...shot, status: "ready", error: "分镜图未返回，可手动上传或重试" };
          } catch (err) {
            shots[i] = {
              ...shot,
              status: "ready",
              error: (err as Error).message.slice(0, 120),
            };
          }
        }
      } else {
        for (let i = 0; i < shots.length; i++) {
          shots[i] = { ...shots[i], status: "ready" };
        }
      }

      const nextStage: WorkflowStage =
        runMode === "auto"
          ? assetsConfig.pauseBeforePrevis
            ? "previs"
            : "producing"
          : "review_storyboard";
      const notice = !imageReady
        ? "当前未配置 AgentAI 图像生图服务，已跳过自动生分镜图（你仍可手动上传分镜图或直接继续）。"
        : !hadEnoughRefs
          ? "自动生成分镜图需要至少 2 张参考图（数字人角色三视图/商品/场景），已进入审阅，你可补充素材后重试或手动上传。"
          : null;
      await db.$executeRawUnsafe(
        `UPDATE public.commerce_talk_workflows
         SET shots=$2::jsonb, stage=$3, message=$4, updated_at=now()
         WHERE id=$1::uuid`,
        wf.id,
        JSON.stringify(shots),
        nextStage,
        notice,
      );
      return;
    }

    // 阶段 E：逐镜生产（克隆配音 + 对口型 / 数字人多角度动态出镜 / CozyClay 预演 H3 / 多模型视频生成）
    if (stage === "producing") {
      const shots = ([...(wf.shots || [])] as WorkflowShot[]);
      const boundCharacters = await loadDigitalHumanCharactersByIds(
        actor,
        [
          ...(assetsConfig.characterLibraryIds || []),
          ...shots.map((s) => s.characterId || ""),
        ],
      );
      const characterMap = new Map(boundCharacters.map((c) => [c.id, c]));
      let allDone = true;

      for (let i = 0; i < shots.length; i++) {
        if (!active()) return;
        const shot = shots[i];
        if (shot.status === "completed") continue;

        // 1. 商品实拍特写镜直接标记完成（在合成阶段以图片动效渲染）
        if (shot.type === "product_insert") {
          shots[i] = { ...shot, status: "completed", error: undefined };
          continue;
        }

        // 2. 固定正面数字人口播对口型分镜（当镜头为非正面多角度视角如侧身/背面/全身走动时，自动转为多模态视频生成以打破固定角度限制）
        const isFixedFrontTalking =
          shot.type === "talking_head" &&
          Boolean(assetsConfig.presenterId) &&
          !["side_profile", "back_turn", "walking_full", "over_shoulder"].includes(
            shot.characterAngle || "auto",
          );
        if (isFixedFrontTalking) {
          if (!assetsConfig.presenterId) {
            throw Error("请先在「资产与模型」中选择已授权的数字人主播");
          }
          const runId = deterministicUuid(`${wf.id}:${shot.id}:${wf.revision}`);
          const current = shot.operationId
            ? await readCommercePresenterVideo(studio, actor, shot.operationId)
            : await startCommercePresenterVideo(studio, actor, {
                runId,
                presenterId: assetsConfig.presenterId,
                title: `${wf.title} · ${shot.id}`,
                text: shot.caption || shot.title || "欢迎来看这款实拍穿搭。",
                maxSpeechCny:
                  wf.max_speech_cny == null ? undefined : Number(wf.max_speech_cny),
              });

          if (["failed", "stopped"].includes(current.status)) {
            shots[i] = {
              ...shot,
              status: "failed",
              error: current.message || "数字人口播生成失败",
            };
            continue;
          }
          if (current.status === "completed" && current.content) {
            const saved = await studio.store.putAsset({
              buffer: current.content,
              name: `clip-${shot.id}.mp4`,
              kind: "workflow_clip",
              mime: "video/mp4",
              ownerId: actor.id,
              projectId: wf.id,
              source: `commerce-talk-workflow:${wf.id}:clip:${shot.id}`,
            });
            shots[i] = {
              ...shot,
              operationId: current.operationId || shot.operationId,
              clipAssetId: saved.path,
              status: "completed",
              error: undefined,
            };
          } else {
            allDone = false;
            shots[i] = {
              ...shot,
              operationId: current.operationId || shot.operationId,
              status: "producing",
            };
          }
          continue;
        }

        // 3. 视频生成分镜（broll_video / previs_video -> 百炼 MiniMax H3 / Seedance 2.5 / Magi-2）
        const chosenModel =
          shot.videoModelOverride ||
          modelConfig.videoModel ||
          "bailian|minimax-h3";
        const [providerId, ...modelRest] = chosenModel.split("|");
        const modelId = modelRest.join("|");

        try {
          const route = selectVideoRoute(studio.config, {
            providerId: shot.type === "previs_video" ? "bailian" : providerId,
            modelId: shot.type === "previs_video" ? "minimax-h3" : modelId,
            resolution: modelConfig.videoResolution,
          });
          if (!videoKey(studio.config, route)) {
            throw Error(`视频模型 ${chosenModel} 尚未配置 API Key`);
          }
          if (!shot.operationId) {
            const refImages: string[] = [];
            if (shot.storyboardAssetId) {
              const sb = await studio.store.readAsset(shot.storyboardAssetId);
              if (sb?.buffer) {
                refImages.push(
                  `data:image/jpeg;base64,${(await sharp(sb.buffer).jpeg({ quality: 86 }).toBuffer()).toString("base64")}`,
                );
              }
            }
            // 自动注入该分镜出镜数字人的面部 + 匹配角度三视图（正/背/侧），实现跨角度高一致性出镜
            const shotChar =
              (shot.characterId ? characterMap.get(shot.characterId) : undefined) ||
              boundCharacters[0];
            if (shotChar) {
              const viewIds = pickCharacterViewAssetIds(
                shotChar,
                shot.characterAngle || "auto",
              ).slice(0, 3);
              for (const vid of viewIds) {
                const loaded = await studio.store.readAsset(vid);
                if (loaded?.buffer && refImages.length < 4) {
                  refImages.push(
                    `data:image/jpeg;base64,${(await sharp(loaded.buffer).resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 84 }).toBuffer()).toString("base64")}`,
                  );
                }
              }
            }
            const angleHint = characterAnglePromptHint(shot.characterAngle || "auto");
            const prompt = [
              shot.type === "previs_video"
                ? "严格遵循 CozyClay 三维预演机位、人物走位与服装道具轨迹。"
                : "",
              `出镜视角：${angleHint}。`,
              shotChar?.persona ? `出镜数字人特征：${shotChar.persona}。` : "",
              shot.camera,
              shot.action,
              shot.props ? `道具细节：${shot.props}` : "",
              shot.scene,
            ]
              .filter(Boolean)
              .join(" ");
            const taskId = await submitVideo(studio.config, route, {
              prompt: prompt || "竖屏服装实拍展示，自然光影，高清细节。",
              duration: Math.max(4, Math.min(15, Math.round(shot.durationSec || 5))),
              aspectRatio: assetsConfig.aspectRatio || "9:16",
              referenceImages: refImages,
            });
            allDone = false;
            shots[i] = { ...shot, operationId: String(taskId), status: "producing" };
          } else {
            const polled = await pollVideo(studio.config, route, shot.operationId);
            if (polled.pending) {
              allDone = false;
              shots[i] = { ...shot, status: "producing" };
            } else if (polled.state === "success" && polled.url) {
              const fetched = await fetch(polled.url, {
                signal: AbortSignal.timeout(45_000),
              });
              if (!fetched.ok) throw Error("下载分镜生成视频失败");
              const saved = await studio.store.putAsset({
                buffer: Buffer.from(await fetched.arrayBuffer()),
                name: `clip-${shot.id}.mp4`,
                kind: "workflow_clip",
                mime: "video/mp4",
                ownerId: actor.id,
                projectId: wf.id,
                source: `commerce-talk-workflow:${wf.id}:clip:${shot.id}`,
              });
              shots[i] = {
                ...shot,
                clipAssetId: saved.path,
                status: "completed",
                error: undefined,
              };
            } else {
              shots[i] = {
                ...shot,
                status: "failed",
                error: polled.errorHint || "分镜视频生成失败",
              };
            }
          }
        } catch (err) {
          shots[i] = {
            ...shot,
            status: "failed",
            error: (err as Error).message.slice(0, 140),
          };
        }
      }

      const hasFailed = shots.some((s) => s.status === "failed");
      const nextStage: WorkflowStage = !allDone
        ? "producing"
        : hasFailed || runMode === "assisted"
          ? "review_clips"
          : "rendering";

      await db.$executeRawUnsafe(
        `UPDATE public.commerce_talk_workflows
         SET shots=$2::jsonb, stage=$3, message=$4, updated_at=now()
         WHERE id=$1::uuid`,
        wf.id,
        JSON.stringify(shots),
        nextStage,
        hasFailed ? "部分分镜生成失败，可在下方查看原因并单独重试或切换模型" : null,
      );
      return;
    }

    // 阶段 F：FFmpeg 多分镜混剪 + 中文字幕烧录 + 入库 AIGC 作品库
    if (stage === "rendering") {
      const shots = (Array.isArray(wf.shots) ? wf.shots : []) as WorkflowShot[];
      const product = assetsConfig.productId
        ? await commerceProduct(actor, assetsConfig.productId).catch(() => undefined)
        : undefined;

      const segments: WorkflowRenderSegment[] = [];
      for (const shot of shots) {
        const mergedPostEdit =
          shot.postEdit || assetsConfig.postEditDefaults
            ? workflowShotPostEditSchema.parse({
                ...(assetsConfig.postEditDefaults || {}),
                ...(shot.postEdit || {}),
              })
            : undefined;
        if (shot.clipAssetId) {
          const clip = await studio.store.readAsset(shot.clipAssetId);
          if (clip?.buffer) {
            segments.push({
              kind: "video",
              content: clip.buffer,
              caption: shot.caption || "",
              durationSec: shot.durationSec || 5,
              postEdit: mergedPostEdit,
            });
            continue;
          }
        }
        if (shot.storyboardAssetId) {
          const img = await studio.store.readAsset(shot.storyboardAssetId);
          if (img?.buffer) {
            segments.push({
              kind: "image",
              content: img.buffer,
              caption: shot.caption || "",
              durationSec: shot.durationSec || 4,
              postEdit: mergedPostEdit,
            });
            continue;
          }
        }
        if (product && shot.productImageId) {
          const p = product.images.find((x) => x.id === shot.productImageId);
          if (p) {
            const loaded = await commerceProductImage(p.source, product.tableId);
            segments.push({
              kind: "image",
              content: loaded.content,
              caption: shot.caption || "",
              durationSec: shot.durationSec || 4,
              postEdit: mergedPostEdit,
            });
          }
        }
      }

      if (!segments.length)
        throw Error("暂无可合成的分镜视频或图片，请先完成至少一个分镜制作");

      const rendered = await renderWorkflowVideo(segments);
      if (!active()) return;
      if (rendered.content.length > maxAssetBytes())
        throw Error("最终成片超过 AIGC 存储上限，请精简分镜时长");

      const asset = await studio.store.putAsset({
        buffer: rendered.content,
        name: `${wf.title}.mp4`,
        kind: "output",
        mime: "video/mp4",
        ownerId: actor.id,
        projectId: wf.id,
        source: `commerce-talk-workflow:${wf.id}:output:${wf.revision}`,
      });

      await studio.store.mutate((data: Row) => {
        const workId = `commerce-wf-${wf.id}`;
        const existing = data.appState.works.find((w: Row) => w.id === workId);
        const entry = {
          id: workId,
          ownerId: actor.id,
          category: "digital_human",
          title: wf.title,
          updatedAt: new Date().toISOString(),
          cover: asset,
          videos: [asset],
        };
        if (existing) Object.assign(existing, entry);
        else data.appState.works.push({ ...entry, createdAt: entry.updatedAt });
      });

      await db.$executeRawUnsafe(
        `UPDATE public.commerce_talk_workflows
         SET stage='completed', output_asset_id=$2::uuid, message=NULL, updated_at=now()
         WHERE id=$1::uuid`,
        wf.id,
        asset.path,
      );
    }
  } catch (error) {
    if (!active()) return;
    const message =
      error instanceof Error ? error.message.slice(0, 240) : "工作流执行中断";
    await db.$executeRawUnsafe(
      `UPDATE public.commerce_talk_workflows
       SET stage='failed', message=$2, updated_at=now()
       WHERE id=$1::uuid AND stage=$3`,
      wf.id,
      message,
      stage,
    );
  }
}

export { workflowPrefix };

import { z } from "zod";
import { db, one, rows } from "../../../../../packages/database/src/index.js";
import {
  decryptSecret,
  encryptSecret,
  encryptionReady,
} from "../analytics/secrets.js";
import { maxAssetBytes } from "./persistence.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { aiFetch, recordAiReceipt } from "../../ai-metering.js";
import { featureModelRef } from "../../ai-model-routing.js";
import { isAllowedAgentAiModel } from "../../../../../packages/contracts/src/agentai-policy.js";
import {
  readAgentAiConnection,
  agentaiReady,
} from "../workspace/agentai-connection.js";

export const secretNames = [
  "BAILIAN_VIDEO_API_KEY",
  "BAILIAN_VOICE_API_KEY",
  "XAI_API_KEY",
  "RUNNINGHUB_API_KEY",
  "OPENTALKING_GATEWAY_KEY",
  "FAL_LIP_SYNC_API_KEY",
] as const;
export const bailianVoiceWorkspacePattern =
  /^(?:ws-[a-z0-9]{8,60}|llm-[a-z0-9]{8,59})$/;
export const bailianVoiceKeyPattern = /^sk-(?!or-|sp-)[A-Za-z0-9._-]{8,4093}$/;

const voiceConnectionInput = z
  .object({
    revision: z.number().int().positive(),
    bailianVoiceWorkspaceId: z.string().trim().max(63),
    apiKey: z.string().trim().max(4096).optional(),
    useSavedQwenVoiceConnection: z.boolean().default(false),
  })
  .strict();
const endpoint = z
  .string()
  .max(500)
  .refine((value) => {
    if (!value) return true;
    try {
      const u = new URL(value);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash
      );
    } catch {
      return false;
    }
  }, "请填写不含凭据的 HTTPS 服务地址");
const cozyclayEndpoint = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    if (!value) return true;
    try {
      const u = new URL(value);
      const local =
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
      return (
        (u.protocol === "https:" || local) &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash
      );
    } catch {
      return false;
    }
  }, "请填写不含凭据的 HTTPS 地址或本机 localhost 地址");
const inputSchema = z.object({
  revision: z.number().int().positive(),
  bailianWorkspaceId: z
    .string()
    .trim()
    .regex(/^(?:ws-[a-z0-9]{8,64})?$/, "请填写百炼北京业务空间 ID")
    .default(""),
  useSavedQwenConnection: z.boolean().default(false),
  opentalkingBaseUrl: endpoint,
  cozyclayBaseUrl: cozyclayEndpoint.optional().default(""),
  runninghubWorkflowId: z
    .string()
    .max(120)
    .regex(/^[\w-]*$/),
  secrets: z
    .partialRecord(z.enum(secretNames), z.string().max(4096))
    .optional(),
});

function activeSecrets(encrypted?: string): Record<string, string> {
  if (!encrypted || !encryptionReady()) return {};
  const stored = JSON.parse(decryptSecret(encrypted)) as Record<string, string>;
  return Object.fromEntries(secretNames.flatMap((name) => typeof stored[name] === "string" ? [[name, stored[name]]] : []));
}

function activeSettings(config: Record<string, any>) {
  const { bailianWorkspaceId, bailianVoiceWorkspaceId, bailianVideoCheck, opentalkingBaseUrl, cozyclayBaseUrl, runninghubWorkflowId } = config;
  return {
    bailianWorkspaceId,
    bailianVoiceWorkspaceId,
    bailianVideoCheck,
    opentalkingBaseUrl,
    cozyclayBaseUrl: cozyclayBaseUrl || process.env.COZYCLAY_BASE_URL || "",
    runninghubWorkflowId,
  };
}
export async function storedSettings() {
  return (await one(
    db,
    "SELECT config,secrets_encrypted,revision,updated_at FROM aigc_settings WHERE id=1",
  ))!;
}

export async function clearRetiredAigcCredentials() {
  if (!encryptionReady()) return;
  const row = await storedSettings();
  if (!row?.secrets_encrypted) return;
  const stored = JSON.parse(decryptSecret(row.secrets_encrypted)) as Record<string, string>;
  const retired = (name: string) => name === "VIDEO_RELAY_API_KEY" || name === "XHAI_API_KEY" || name.startsWith("XYLP_");
  if (!Object.keys(stored).some(retired)) return;
  const remaining = Object.fromEntries(Object.entries(stored).filter(([name]) => !retired(name)));
  await db.$executeRawUnsafe(
    "UPDATE aigc_settings SET secrets_encrypted=$1,revision=revision+1,updated_at=now() WHERE id=1 AND secrets_encrypted=$2",
    encryptSecret(JSON.stringify(remaining)), row.secrets_encrypted,
  );
}
async function savedQwenConnection() {
  return one(
    db,
    "SELECT qwen_api_key_encrypted,qwen_workspace_id,updated_at FROM assistant_realtime_settings WHERE id=1",
  );
}

export type BailianVoiceCredentialSource = "configured" | "saved";

export async function readBailianVoiceCredential(
  source: BailianVoiceCredentialSource = "configured",
) {
  if (!encryptionReady()) return;
  try {
    if (source === "saved") {
      const saved = await savedQwenConnection();
      const workspaceId = saved?.qwen_workspace_id;
      const apiKey =
        saved?.qwen_api_key_encrypted &&
        decryptSecret(saved.qwen_api_key_encrypted);
      if (
        typeof workspaceId !== "string" ||
        !bailianVoiceWorkspacePattern.test(workspaceId) ||
        typeof apiKey !== "string" ||
        !bailianVoiceKeyPattern.test(apiKey)
      )
        return;
      return {
        workspaceId,
        apiKey,
        updatedAt: saved?.updated_at
          ? new Date(saved.updated_at).toISOString()
          : undefined,
      };
    }
    const stored = await storedSettings();
    if (!stored?.secrets_encrypted) return;
    const secrets = activeSecrets(stored.secrets_encrypted);
    const dedicated = Boolean(secrets.BAILIAN_VOICE_API_KEY);
    const workspaceId = dedicated
      ? stored.config.bailianVoiceWorkspaceId
      : stored.config.bailianWorkspaceId;
    const apiKey = dedicated
      ? secrets.BAILIAN_VOICE_API_KEY
      : secrets.BAILIAN_VIDEO_API_KEY;
    if (
      typeof workspaceId !== "string" ||
      !bailianVoiceWorkspacePattern.test(workspaceId) ||
      typeof apiKey !== "string" ||
      !bailianVoiceKeyPattern.test(apiKey)
    )
      return;
    return {
      workspaceId,
      apiKey,
      updatedAt: stored.updated_at
        ? new Date(stored.updated_at).toISOString()
        : undefined,
    };
  } catch {
    return;
  }
}
export async function visibleSettings() {
  const setting = await storedSettings();
  const secrets = activeSecrets(setting.secrets_encrypted);
  const qwen = await savedQwenConnection();
  return {
    ...activeSettings(setting.config),
    bailianVoiceWorkspaceId: setting.config.bailianVoiceWorkspaceId || "",
    bailianVoiceSource: secrets.BAILIAN_VOICE_API_KEY ? "voice" : "video",
    bailianReuseAvailable: Boolean(
      encryptionReady() &&
      qwen?.qwen_api_key_encrypted &&
      qwen?.qwen_workspace_id,
    ),
    bailianReuseWorkspaceId: qwen?.qwen_workspace_id || "",
    revision: setting.revision,
    encryptionReady: encryptionReady(),
    secrets: Object.fromEntries(
      secretNames.map((name) => [name, Boolean(secrets[name])]),
    ),
  };
}

export async function saveBailianVoiceConnection(
  userId: string,
  input: unknown,
) {
  const parsed = voiceConnectionInput.parse(input);
  if (!encryptionReady())
    throw Object.assign(new Error("服务器尚未配置凭据加密"), {
      statusCode: 503,
    });
  const old = await storedSettings();
  const secrets = activeSecrets(old.secrets_encrypted);
  const saved = parsed.useSavedQwenVoiceConnection
    ? await readBailianVoiceCredential("saved")
    : undefined;
  if (parsed.useSavedQwenVoiceConnection && !saved)
    throw Object.assign(new Error("还没有可复用的百炼北京语音连接"), {
      statusCode: 400,
    });
  const workspaceId = saved?.workspaceId || parsed.bailianVoiceWorkspaceId;
  const apiKey =
    saved?.apiKey || parsed.apiKey || secrets.BAILIAN_VOICE_API_KEY;
  if (
    !bailianVoiceWorkspacePattern.test(workspaceId) ||
    typeof apiKey !== "string" ||
    !bailianVoiceKeyPattern.test(apiKey)
  )
    throw Object.assign(
      new Error("请填写百炼北京业务空间 ID 和普通百炼 API Key"),
      { statusCode: 400 },
    );
  if (
    !saved &&
    !parsed.apiKey &&
    workspaceId !== old.config.bailianVoiceWorkspaceId
  )
    throw Object.assign(
      new Error("更换音色业务空间时，请同时填写该空间的 API Key"),
      { statusCode: 400 },
    );
  secrets.BAILIAN_VOICE_API_KEY = apiKey;
  const changed = await rows(
    db,
    "UPDATE aigc_settings SET config=jsonb_set(config,'{bailianVoiceWorkspaceId}',to_jsonb($1::text)),secrets_encrypted=$2,revision=revision+1,updated_by=$3::bigint,updated_at=now() WHERE id=1 AND revision=$4 RETURNING revision",
    workspaceId,
    encryptSecret(JSON.stringify(secrets)),
    userId,
    parsed.revision,
  );
  if (!changed.length)
    throw Object.assign(new Error("设置已被修改，请刷新后重试"), {
      statusCode: 409,
    });
  return visibleSettings();
}
export async function saveSettings(userId: string, input: unknown) {
  const parsed = inputSchema.parse(input);
  if (!encryptionReady())
    throw Object.assign(
      new Error("服务器未配置凭据加密，请先完成 AI 模型管理的服务器配置"),
      { statusCode: 503 },
    );
  const old = await storedSettings();
  if (
    ["submitting", "pending", "uncertain"].includes(
      old.config.bailianVideoCheck?.state,
    )
  )
    throw Object.assign(
      new Error("视频连接测试尚未结束，请先查询或核实原任务"),
      { statusCode: 409 },
    );
  const secrets = activeSecrets(old.secrets_encrypted);
  for (const [name, value] of Object.entries(parsed.secrets || {}))
    if (name !== "BAILIAN_VOICE_API_KEY" && value.trim())
      secrets[name] = value.trim();
  if (
    secrets.FAL_LIP_SYNC_API_KEY &&
    !/^[!-~]{1,2048}$/.test(secrets.FAL_LIP_SYNC_API_KEY)
  )
    throw Object.assign(new Error("fal API Key 格式无效"), {
      statusCode: 400,
    });
  if (parsed.useSavedQwenConnection) {
    const qwen = await savedQwenConnection();
    if (!qwen?.qwen_api_key_encrypted || !qwen?.qwen_workspace_id)
      throw Object.assign(new Error("尚无可复用的百炼语音连接"), {
        statusCode: 400,
      });
    secrets.BAILIAN_VIDEO_API_KEY = decryptSecret(qwen.qwen_api_key_encrypted);
    parsed.bailianWorkspaceId = qwen.qwen_workspace_id;
  }
  if (
    secrets.BAILIAN_VIDEO_API_KEY &&
    (!/^sk-(?!or-)[A-Za-z0-9._-]+$/.test(secrets.BAILIAN_VIDEO_API_KEY) ||
      !/^ws-[a-z0-9]{8,64}$/.test(parsed.bailianWorkspaceId))
  )
    throw Object.assign(
      new Error("百炼视频连接需要有效的北京业务空间 ID 和 API Key"),
      { statusCode: 400 },
    );
  const {
    revision,
    secrets: _secrets,
    useSavedQwenConnection: _reuse,
    ...config
  } = parsed;
  const changed = await rows(
    db,
    "UPDATE aigc_settings SET config=$1::jsonb,secrets_encrypted=$2,revision=revision+1,updated_by=$3::bigint,updated_at=now() WHERE id=1 AND revision=$4 AND COALESCE(config->'bailianVideoCheck'->>'state','') NOT IN ('submitting','pending','uncertain') RETURNING revision",
    JSON.stringify({
      ...config,
      ...(old.config.bailianVoiceWorkspaceId
        ? { bailianVoiceWorkspaceId: old.config.bailianVoiceWorkspaceId }
        : {}),
    }),
    encryptSecret(JSON.stringify(secrets)),
    userId,
    revision,
  );
  if (!changed.length)
    throw Object.assign(new Error("设置已被修改，请刷新后重试"), {
      statusCode: 409,
    });
  return visibleSettings();
}
export async function engineConfig() {
  const [compiler, image, video] = await Promise.all([
    featureModelRef("aigc_compile"),
    featureModelRef("aigc_image"),
    featureModelRef("aigc_video"),
  ]);
  const setting = await storedSettings();
  const agentai = await readAgentAiConnection();
  const secrets = activeSecrets(setting.secrets_encrypted);
  const ai = await one(
    db,
    "SELECT enabled,api_key_encrypted,verified_at FROM compass_ai_settings WHERE id=1",
  );
  const openrouterApiKey =
    ai?.enabled && ai.verified_at && ai.api_key_encrypted && encryptionReady()
      ? decryptSecret(ai.api_key_encrypted)
      : "";
  const videoSecrets: Record<string, string> = {
    ...secrets,
    AGENTAI_API_KEY: agentaiReady(agentai)
      ? decryptSecret(agentai!.api_key_encrypted)
      : "",
  };
  return {
    aiFetch,
    recordAiReceipt,
    aiConfigurationUpdatedAt: new Date(
      Math.max(
        ...[setting.updated_at, agentai?.updated_at, agentai?.catalog_at]
          .filter(Boolean)
          .map((value) => new Date(value).getTime()),
      ),
    ),
    useModelManagement: true,
    ...(compiler
      ? {
          managedCompiler: {
            providerId: compiler.split("|")[0],
            model: compiler.split("|")[1],
          },
        }
      : {}),
    ...(image ? { keyframeImageModel: image } : {}),
    defaultVideoSelection: {
      providerId: video?.startsWith("agentai|") ? "agentai" : "bailian",
      modelId:
        video?.startsWith("bailian|") || video?.startsWith("agentai|")
          ? video.split("|")[1]
          : "minimax-h3",
    },
    enabledVideoProviders: ["bailian", "agentai"],
    dataDir: path.join(tmpdir(), `xuti-aigc-${process.pid}`),
    durableStorageConfigured: true,
    sessionSecret: process.env.COMPASS_MAIL_KEY || "",
    publicBaseUrl: process.env.APP_ORIGIN,
    ...activeSettings(setting.config),
    videoSecrets,
    agentaiModels:
      agentai?.catalog_at && Array.isArray(agentai.model_catalog)
        ? agentai.model_catalog.filter(
            (model: { model?: unknown; type?: unknown }) =>
              typeof model.model === "string" &&
              typeof model.type === "string" &&
              isAllowedAgentAiModel(model.model, model.type),
          )
        : [],
    opentalkingApiKey: secrets.OPENTALKING_GATEWAY_KEY || "",
    falLipSyncApiKey: secrets.FAL_LIP_SYNC_API_KEY || "",
    runninghubApiKey: secrets.RUNNINGHUB_API_KEY || "",
    compileProvider: "openrouter",
    openrouterApiKey,
    openrouterModel: "openai/gpt-6.1-sol",
    openrouterBaseUrl: "https://openrouter.ai/api/v1",
    openrouterSiteUrl: process.env.APP_ORIGIN,
    openrouterAppTitle: "XUTI AIGC",
    compileMaxOutputTokens: 10000,
    compileRequestTimeoutMs: 900000,
    openaiApiKey: "",
    xaiApiKey: secrets.XAI_API_KEY || "",
    xaiVideoModel: "grok-imagine-video-1.5",
    videoProviders: [],
    publicVideoProvider: video?.startsWith("agentai|") ? "agentai" : "bailian",
    maxGenerationSegments: 24,
    maxVideoSecondsPerProject: 180,
    maxClipSeconds: 120,
    defaultClipSeconds: 6,
    maxUploadBytes: maxAssetBytes(),
    maxDownloadedVideoBytes: maxAssetBytes(),
    workerPollMs: 2000,
    workerConcurrency: 2,
    compilePollMs: 3000,
    xaiPollMs: 5000,
  };
}

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

export const secretNames = [
  "VIDEO_RELAY_API_KEY",
  "XYLP_IMAGE_TT25_KEY",
  "XYLP_IMAGE_BANANA_PRO_KEY",
  "XHAI_API_KEY",
  "XAI_API_KEY",
  "RUNNINGHUB_API_KEY",
  "OPENTALKING_GATEWAY_KEY",
] as const;
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
const inputSchema = z.object({
  revision: z.number().int().positive(),
  videoRelayBaseUrl: endpoint,
  xhaiBaseUrl: endpoint,
  opentalkingBaseUrl: endpoint,
  runninghubWorkflowId: z
    .string()
    .max(120)
    .regex(/^[\w-]*$/),
  secrets: z
    .partialRecord(z.enum(secretNames), z.string().max(4096))
    .optional(),
});
export async function storedSettings() {
  return (await one(
    db,
    "SELECT config,secrets_encrypted,revision FROM aigc_settings WHERE id=1",
  ))!;
}
export async function visibleSettings() {
  const setting = await storedSettings();
  const secrets =
    setting.secrets_encrypted && encryptionReady()
      ? JSON.parse(decryptSecret(setting.secrets_encrypted))
      : {};
  return {
    ...setting.config,
    revision: setting.revision,
    encryptionReady: encryptionReady(),
    secrets: Object.fromEntries(
      secretNames.map((name) => [name, Boolean(secrets[name])]),
    ),
  };
}
export async function saveSettings(userId: string, input: unknown) {
  const parsed = inputSchema.parse(input);
  if (!encryptionReady())
    throw Object.assign(
      new Error("服务器未配置凭据加密，请先完成 AI 模型设置的服务器配置"),
      { statusCode: 503 },
    );
  const old = await storedSettings();
  const secrets = old.secrets_encrypted
    ? JSON.parse(decryptSecret(old.secrets_encrypted))
    : {};
  for (const [name, value] of Object.entries(parsed.secrets || {}))
    if (value.trim()) secrets[name] = value.trim();
  const { revision, secrets: _secrets, ...config } = parsed;
  const changed = await rows(
    db,
    "UPDATE aigc_settings SET config=$1::jsonb,secrets_encrypted=$2,revision=revision+1,updated_by=$3::bigint,updated_at=now() WHERE id=1 AND revision=$4 RETURNING revision",
    JSON.stringify(config),
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
  const setting = await storedSettings();
  const secrets =
    setting.secrets_encrypted && encryptionReady()
      ? JSON.parse(decryptSecret(setting.secrets_encrypted))
      : {};
  const ai = await one(
    db,
    "SELECT enabled,api_key_encrypted,verified_at FROM compass_ai_settings WHERE id=1",
  );
  const openrouterApiKey =
    ai?.enabled && ai.verified_at && ai.api_key_encrypted && encryptionReady()
      ? decryptSecret(ai.api_key_encrypted)
      : "";
  return {
    dataDir: path.join(tmpdir(), `xuti-aigc-${process.pid}`),
    durableStorageConfigured: true,
    sessionSecret: process.env.COMPASS_MAIL_KEY || "",
    publicBaseUrl: process.env.APP_ORIGIN,
    ...setting.config,
    videoSecrets: secrets,
    opentalkingApiKey: secrets.OPENTALKING_GATEWAY_KEY || "",
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
    publicVideoProvider: "xylp",
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

import {
  bailianCommerceVoiceModelSchema,
  type BailianCommerceVoiceModel,
} from "../../../../../packages/contracts/src/bailian-commerce-voice.js";
import { aiFetch } from "../../ai-metering.js";
import { decryptSecret, encryptionReady } from "../analytics/secrets.js";
import { inspectAudio } from "../workspace/agent-media.js";
import { qwenAudioBase } from "../workspace/qwen-audio.js";
import { storedSettings } from "./config.js";

const customization = "/api/v1/services/audio/tts/customization";
const synthesis = "/api/v1/services/audio/tts/SpeechSynthesizer";
const resultHost = "dashscope-result-bj.oss-cn-beijing.aliyuncs.com";
const workspacePattern = /^ws-[a-z0-9]{8,60}$/;
const keyPattern = /^sk-(?!or-)[A-Za-z0-9._-]+$/;
const prefixPattern = /^[a-zA-Z0-9]{1,10}$/;
const voiceIdPattern = /^[A-Za-z0-9_.-]{1,128}$/;
const maxSampleBytes = 10_000_000;
const maxResultBytes = 8 * 1024 * 1024;

export type BailianVoiceConnection = {
  workspaceId: string;
  apiKey: string;
  updatedAt?: string;
};

type BailianVoiceStatus = "pending" | "ready" | "failed";
type SampleMime = "audio/wav" | "audio/mpeg" | "audio/mp4";
type ProviderObject = Record<string, unknown>;
type VoiceMeter =
  "commerce_bailian_voice_enrollment" | "commerce_bailian_speech";

export class BailianVoiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly uncertain: boolean = true,
    public readonly statusCode: number = 502,
  ) {
    super(message);
    this.name = "BailianVoiceError";
  }
}

export async function getBailianVoiceConnection(): Promise<
  BailianVoiceConnection | undefined
> {
  if (!encryptionReady()) return;
  const setting = await storedSettings();
  const workspaceId = setting?.config?.bailianWorkspaceId;
  if (
    typeof workspaceId !== "string" ||
    !workspacePattern.test(workspaceId) ||
    !setting.secrets_encrypted
  )
    return;
  try {
    const apiKey = JSON.parse(
      decryptSecret(setting.secrets_encrypted),
    ).BAILIAN_VIDEO_API_KEY;
    if (typeof apiKey !== "string" || !keyPattern.test(apiKey)) return;
    return {
      workspaceId,
      apiKey,
      updatedAt: setting.updated_at
        ? new Date(setting.updated_at).toISOString()
        : undefined,
    };
  } catch {
    // A saved but unreadable credential does not establish a configured connection.
  }
}

const plainObject = (value: unknown): ProviderObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ProviderObject)
    : undefined;

function invalidResponse() {
  return new BailianVoiceError(
    "BAILIAN_VOICE_RESPONSE_UNKNOWN",
    "百炼语音返回的结果无法确认，请核对原任务后再继续。",
  );
}

function invalidInput() {
  return new BailianVoiceError(
    "BAILIAN_VOICE_INPUT_INVALID",
    "百炼语音输入、音色或目标模型无效。",
    false,
    400,
  );
}

function rejected(status: number, code: unknown) {
  if (
    status === 401 ||
    status === 403 ||
    code === "InvalidApiKey" ||
    code === "AccessDenied"
  )
    return new BailianVoiceError(
      "BAILIAN_VOICE_AUTH",
      "百炼语音连接未通过校验，请核对北京业务空间、API Key 与模型授权。",
      false,
      503,
    );
  if (
    status === 402 ||
    status === 429 ||
    code === "AllocationQuota.FreeTierOnly" ||
    code === "Throttling.RateQuota"
  )
    return new BailianVoiceError(
      "BAILIAN_VOICE_QUOTA",
      "百炼语音额度不足或请求频率受限，请核对业务空间额度。",
      false,
      429,
    );
  if (
    (status >= 400 && status < 500 && ![408, 409, 425, 499].includes(status)) ||
    code === "InvalidParameter" ||
    code === "DataInspectionFailed"
  )
    return new BailianVoiceError(
      "BAILIAN_VOICE_REJECTED",
      "百炼未接受语音请求，请检查录音、音色状态或模型授权。",
      false,
    );
  return invalidResponse();
}

async function boundedBody(response: Response, limit: number) {
  if (!response.body) throw invalidResponse();
  const size = response.headers.get("content-length");
  if (size && Number(size) > limit) {
    await response.body.cancel().catch(() => {});
    throw invalidResponse();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw invalidResponse();
      chunks.push(value);
    }
    if (!length) throw invalidResponse();
    return Buffer.concat(chunks, length);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function providerRequest(
  connection: BailianVoiceConnection,
  endpoint: typeof customization | typeof synthesis,
  model: BailianCommerceVoiceModel | "voice-enrollment",
  input: ProviderObject,
  meter?: VoiceMeter,
) {
  if (
    !workspacePattern.test(connection.workspaceId) ||
    !keyPattern.test(connection.apiKey)
  )
    throw invalidInput();
  const address = qwenAudioBase(connection.workspaceId) + endpoint;
  const init: RequestInit = {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(meter ? 45_000 : 12_000),
    headers: {
      Authorization: `Bearer ${connection.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input }),
  };
  let response: Response;
  try {
    response = await (meter
      ? aiFetch(meter, address, init)
      : fetch(address, init));
  } catch {
    throw invalidResponse();
  }
  let payload: ProviderObject | undefined;
  try {
    payload = plainObject(
      JSON.parse((await boundedBody(response, 64 * 1024)).toString("utf8")),
    );
  } catch {
    if (!response.ok) throw rejected(response.status, undefined);
    throw invalidResponse();
  }
  const code = payload?.code ?? plainObject(payload?.error)?.code;
  const status = Number(payload?.status_code);
  if (!response.ok || code || status >= 400 || payload?.error)
    throw rejected(response.ok ? status : response.status, code);
  const output = plainObject(payload?.output);
  if (
    !payload ||
    !output ||
    (payload.model !== undefined && payload.model !== model)
  )
    throw invalidResponse();
  return { payload, output };
}

function validVoiceId(value: unknown): value is string {
  return typeof value === "string" && voiceIdPattern.test(value);
}

function voiceStatus(value: unknown): BailianVoiceStatus {
  switch (value) {
    case "DEPLOYING":
      return "pending";
    case "OK":
      return "ready";
    case "UNDEPLOYED":
      return "failed";
    default:
      throw invalidResponse();
  }
}

export async function enrollBailianVoice(
  connection: BailianVoiceConnection,
  input: {
    model: BailianCommerceVoiceModel;
    prefix: string;
    audio: Buffer;
    mime: SampleMime;
  },
): Promise<{ voiceId: string; status: BailianVoiceStatus }> {
  const { model, prefix, audio, mime } = input;
  if (
    !bailianCommerceVoiceModelSchema.safeParse(model).success ||
    !prefixPattern.test(prefix) ||
    !["audio/wav", "audio/mpeg", "audio/mp4"].includes(mime) ||
    !audio.length ||
    audio.length > maxSampleBytes
  )
    throw invalidInput();
  const { output } = await providerRequest(
    connection,
    customization,
    "voice-enrollment",
    {
      action: "create_voice",
      target_model: model,
      prefix,
      audio: `data:${mime};base64,${audio.toString("base64")}`,
      language_hints: ["zh"],
      max_prompt_audio_length: 20,
    },
    "commerce_bailian_voice_enrollment",
  );
  if (
    !validVoiceId(output.voice_id) ||
    !output.voice_id.startsWith(`${model}-${prefix}-`)
  )
    throw invalidResponse();
  // Creation returns an ID before review. Only query_voice confirms readiness.
  return { voiceId: output.voice_id, status: "pending" };
}

export async function queryBailianVoice(
  connection: BailianVoiceConnection,
  voiceId: string,
  expectedModel: BailianCommerceVoiceModel,
) {
  if (!validVoiceId(voiceId)) throw invalidInput();
  const { output } = await providerRequest(
    connection,
    customization,
    "voice-enrollment",
    {
      action: "query_voice",
      voice_id: voiceId,
    },
  );
  if (output.target_model !== expectedModel)
    throw new BailianVoiceError(
      "BAILIAN_VOICE_MODEL_MISMATCH",
      "百炼返回的音色所属模型与当前设置不一致。",
      false,
      409,
    );
  return { status: voiceStatus(output.status) };
}

export async function findBailianVoice(
  connection: BailianVoiceConnection,
  prefix: string,
  expectedModel: BailianCommerceVoiceModel,
): Promise<{ voiceId: string; status: BailianVoiceStatus } | undefined> {
  if (!prefixPattern.test(prefix)) throw invalidInput();
  const { output } = await providerRequest(
    connection,
    customization,
    "voice-enrollment",
    {
      action: "list_voice",
      prefix,
      page_index: 0,
      page_size: 10,
    },
  );
  if (!Array.isArray(output.voice_list)) throw invalidResponse();
  // A populated full page can hide more matches. Never link on ambiguity.
  if (output.voice_list.length >= 10) return;
  const matches = output.voice_list.filter((item) => {
    const voice = plainObject(item);
    return (
      voice?.target_model === expectedModel &&
      validVoiceId(voice.voice_id) &&
      voice.voice_id.startsWith(`${expectedModel}-${prefix}-`)
    );
  });
  if (matches.length !== 1) return;
  return {
    voiceId: matches[0].voice_id,
    status: voiceStatus(matches[0].status),
  };
}

export async function deleteBailianVoice(
  connection: BailianVoiceConnection,
  voiceId: string,
) {
  if (!validVoiceId(voiceId)) throw invalidInput();
  await providerRequest(connection, customization, "voice-enrollment", {
    action: "delete_voice",
    voice_id: voiceId,
  });
}

function mediaUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 8192) throw invalidResponse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidResponse();
  }
  if (
    url.hostname !== resultHost ||
    !["http:", "https:"].includes(url.protocol) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname === "/"
  )
    throw invalidResponse();
  // Both official APIs document signed HTTP URLs for this OSS result bucket.
  // Preserve the signature and path while fetching through the bucket's TLS endpoint.
  url.protocol = "https:";
  return url;
}

async function fetchMp3(url: URL) {
  let bytes: Buffer;
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(18_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw invalidResponse();
    }
    bytes = await boundedBody(response, maxResultBytes);
    await inspectAudio(bytes, ".mp3");
  } catch {
    // Synthesis may already be billed even when delivery/validation fails.
    throw invalidResponse();
  }
  return bytes;
}

export async function synthesizeBailianVoice(
  connection: BailianVoiceConnection,
  input: { model: BailianCommerceVoiceModel; voiceId: string; text: string },
) {
  const { model, voiceId, text } = input;
  if (
    !bailianCommerceVoiceModelSchema.safeParse(model).success ||
    !validVoiceId(voiceId) ||
    !voiceId.startsWith(model + "-") ||
    !text.trim()
  )
    throw invalidInput();
  const { payload, output } = await providerRequest(
    connection,
    synthesis,
    model,
    {
      text,
      voice: voiceId,
      format: "mp3",
      sample_rate: 24000,
    },
    "commerce_bailian_speech",
  );
  if (output.finish_reason !== "stop") throw invalidResponse();
  const bytes = await fetchMp3(mediaUrl(plainObject(output.audio)?.url));
  const providerRequestId =
    typeof payload.request_id === "string" &&
    /^[a-zA-Z0-9_.:-]{1,128}$/.test(payload.request_id)
      ? payload.request_id
      : undefined;
  const characters = plainObject(payload.usage)?.characters;
  return {
    bytes,
    providerRequestId,
    characters:
      typeof characters === "number" &&
      Number.isSafeInteger(characters) &&
      characters >= 0
        ? characters
        : null,
  };
}

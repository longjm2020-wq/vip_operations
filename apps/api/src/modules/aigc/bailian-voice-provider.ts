import {
  bailianCommerceVoiceModels,
  bailianCommerceVoiceModelSchema,
  bailianProviderCode,
  bailianProviderRequestId,
  type BailianCommerceVoiceModel,
} from "../../../../../packages/contracts/src/bailian-commerce-voice.js";
import { aiFetch } from "../../ai-metering.js";
import { inspectAudio } from "../workspace/agent-media.js";
import {
  bailianVoiceKeyPattern,
  bailianVoiceWorkspacePattern,
  readBailianVoiceCredential,
  type BailianVoiceCredentialSource,
} from "./config.js";

const customization = "/api/v1/services/audio/tts/customization";
const synthesis = "/api/v1/services/audio/tts/SpeechSynthesizer";
const resultHost = "dashscope-result-bj.oss-cn-beijing.aliyuncs.com";
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

export type BailianVoiceDiagnostic = {
  action: string;
  providerStatus?: number;
  providerCode?: string;
  providerRequestId?: string;
};

type AccessCheck = {
  checkedAt: string;
  enrollment: {
    status: "reachable" | "unauthorized" | "unavailable";
    diagnostic?: BailianVoiceDiagnostic;
    note?: string;
  };
  models: Array<{
    id: BailianCommerceVoiceModel;
    status: "authorized" | "denied" | "unknown";
    diagnostic?: BailianVoiceDiagnostic;
    note?: string;
  }>;
};

export class BailianVoiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly uncertain: boolean = true,
    public readonly statusCode: number = 502,
    public readonly diagnostic?: BailianVoiceDiagnostic,
  ) {
    super(message);
    this.name = "BailianVoiceError";
  }

  get providerCode() {
    return this.diagnostic?.providerCode;
  }

  get providerRequestId() {
    return this.diagnostic?.providerRequestId;
  }
}

export async function getBailianVoiceConnection(
  source: BailianVoiceCredentialSource = "configured",
): Promise<BailianVoiceConnection | undefined> {
  return (await readBailianVoiceCredential(source)) ?? undefined;
}

const plainObject = (value: unknown): ProviderObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ProviderObject)
    : undefined;

function invalidResponse(diagnostic?: BailianVoiceDiagnostic) {
  return new BailianVoiceError(
    "BAILIAN_VOICE_RESPONSE_UNKNOWN",
    "百炼语音返回的结果无法确认，请核对原任务后再继续。",
    true,
    502,
    diagnostic,
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

function rejected(status: number, diagnostic: BailianVoiceDiagnostic) {
  const code = diagnostic.providerCode?.toLowerCase();
  const enrollment =
    diagnostic.action === "create_voice" || diagnostic.action === "list_voice";
  if (code === "arrearage" || code === "isv.out_of_service")
    return new BailianVoiceError(
      "BAILIAN_VOICE_BILLING",
      "百炼账号已暂停调用，请在阿里云费用与成本中心核对欠费或余额。",
      false,
      503,
      diagnostic,
    );
  if (code === "accessdenied.unpurchased")
    return new BailianVoiceError(
      "BAILIAN_VOICE_NOT_OPEN",
      "百炼语音服务尚未开通，请用有权限的阿里云账号检查百炼开通状态。",
      false,
      503,
      diagnostic,
    );
  if (
    code === "workspace.accessdenied" ||
    code === "endpoint.accessdenied" ||
    code === "bailiangateway.workspace.notauthorised" ||
    code === "bailiangateway.team.notauthorised"
  )
    return new BailianVoiceError(
      "BAILIAN_VOICE_WORKSPACE",
      "百炼拒绝访问此业务空间，请核对北京业务空间 API Host 和同一空间的 API Key。",
      false,
      503,
      diagnostic,
    );
  if (status === 401 || code === "invalidapikey" || code === "invalid_api_key")
    return new BailianVoiceError(
      "BAILIAN_VOICE_AUTH",
      "百炼未接受 API Key。请核对华北 2（北京）的按量付费 API Key、业务空间 API Host 和 Key 状态。",
      false,
      503,
      diagnostic,
    );
  if (
    status === 402 ||
    status === 429 ||
    code === "allocationquota.freetieronly" ||
    code === "throttling.ratequota" ||
    code === "throttling.allocationquota" ||
    code === "insufficient_quota"
  )
    return new BailianVoiceError(
      "BAILIAN_VOICE_QUOTA",
      "百炼语音额度不足或请求频率受限，请核对业务空间额度。",
      false,
      429,
      diagnostic,
    );
  if (
    status === 403 ||
    code === "accessdenied" ||
    code === "access_denied" ||
    code === "model.accessdenied"
  )
    return new BailianVoiceError(
      "BAILIAN_VOICE_PERMISSION",
      enrollment
        ? "百炼拒绝音色复刻请求。请为北京业务空间和该 API Key 开通 voice-enrollment 与所选合成模型的调用权限，并核对 Key 的 IP 访问设置。"
        : "百炼拒绝语音请求。请核对北京业务空间、API Key 的模型调用权限和 IP 访问设置。",
      false,
      503,
      diagnostic,
    );
  if (
    (status >= 400 && status < 500 && ![408, 409, 425, 499].includes(status)) ||
    code === "invalidparameter" ||
    code === "datainspectionfailed" ||
    code === "data_inspection_failed" ||
    code === "modelnotfound"
  )
    return new BailianVoiceError(
      "BAILIAN_VOICE_REJECTED",
      "百炼未接受语音请求，请检查录音、音色状态或模型授权。",
      false,
      502,
      diagnostic,
    );
  return invalidResponse(diagnostic);
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

function voiceBase(connection: BailianVoiceConnection) {
  if (connection.apiKey.startsWith("sk-sp-"))
    throw new BailianVoiceError(
      "BAILIAN_VOICE_KEY_TYPE",
      "此处需要北京地域的按量付费 API Key，Token Plan 专用 Key 无法调用音色复刻。",
      false,
      503,
    );
  if (
    connection.workspaceId.length > 63 ||
    !bailianVoiceWorkspacePattern.test(connection.workspaceId) ||
    !bailianVoiceKeyPattern.test(connection.apiKey)
  )
    throw invalidInput();
  return `https://${connection.workspaceId}.cn-beijing.maas.aliyuncs.com`;
}

function accessDiagnostic(
  action: string,
  response: Response,
  payload?: ProviderObject,
): BailianVoiceDiagnostic {
  return {
    action,
    providerStatus: response.status,
    providerCode: bailianProviderCode(
      payload?.code ?? plainObject(payload?.error)?.code,
    ),
    providerRequestId:
      bailianProviderRequestId(payload?.request_id) ??
      bailianProviderRequestId(response.headers.get("x-request-id")) ??
      bailianProviderRequestId(response.headers.get("x-dashscope-requestid")) ??
      bailianProviderRequestId(
        response.headers.get("x-dashscope-request-id"),
      ) ??
      bailianProviderRequestId(response.headers.get("request-id")),
  };
}

async function readProviderResult(response: Response, action: string) {
  let payload: ProviderObject | undefined;
  try {
    payload = plainObject(
      JSON.parse((await boundedBody(response, 64 * 1024)).toString("utf8")),
    );
  } catch {
    const diagnostic = accessDiagnostic(action, response);
    if (!response.ok) throw rejected(response.status, diagnostic);
    throw invalidResponse(diagnostic);
  }
  const diagnostic = accessDiagnostic(action, response, payload);
  const status = Number(payload?.status_code);
  if (!response.ok || payload?.code || status >= 400 || payload?.error)
    throw rejected(response.ok ? status : response.status, diagnostic);
  const output = plainObject(payload?.output);
  if (!payload || !output) throw invalidResponse(diagnostic);
  return { payload, output, diagnostic };
}

async function providerRequest(
  connection: BailianVoiceConnection,
  endpoint: typeof customization | typeof synthesis,
  model: BailianCommerceVoiceModel | "voice-enrollment",
  input: ProviderObject,
  meter?: VoiceMeter,
) {
  const action = typeof input.action === "string" ? input.action : "synthesize";
  const address = voiceBase(connection) + endpoint;
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
    throw invalidResponse({ action });
  }
  const result = await readProviderResult(response, action);
  if (result.payload.model !== undefined && result.payload.model !== model)
    throw invalidResponse(result.diagnostic);
  return result;
}

async function checkModelPermission(
  connection: BailianVoiceConnection,
  id: BailianCommerceVoiceModel,
): Promise<AccessCheck["models"][number]> {
  const action = "model_permissions";
  try {
    const url = new URL("/api/v1/models/permissions", voiceBase(connection));
    url.search = new URLSearchParams({
      model: id,
      authorization_scope: "AUTHORIZED",
      action: "INFERENCE",
      page_no: "1",
      page_size: "10",
    }).toString();
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
      headers: { Authorization: `Bearer ${connection.apiKey}` },
    });
    const { payload, output, diagnostic } = await readProviderResult(
      response,
      action,
    );
    if (payload.success !== true || !Array.isArray(output.permissions))
      throw invalidResponse(diagnostic);
    const results: boolean[] = [];
    for (const record of output.permissions) {
      const item = plainObject(record);
      if (item?.model !== id) continue;
      const inference = plainObject(item.permissions)?.inference;
      if (typeof inference === "boolean") results.push(inference);
    }
    const status =
      results.length === 1 ? (results[0] ? "authorized" : "denied") : "unknown";
    return {
      id,
      status,
      diagnostic,
      ...(status === "unknown"
        ? { note: "百炼未明确返回此模型的推理权限。" }
        : {}),
    };
  } catch (error) {
    return {
      id,
      status: "unknown",
      diagnostic:
        error instanceof BailianVoiceError ? error.diagnostic : { action },
      note: "当前连接无法查询此模型的业务空间授权。",
    };
  }
}

export async function checkBailianVoiceAccess(
  connection: BailianVoiceConnection,
): Promise<AccessCheck> {
  let enrollment: AccessCheck["enrollment"];
  try {
    const { output, diagnostic } = await providerRequest(
      connection,
      customization,
      "voice-enrollment",
      {
        action: "list_voice",
        prefix: "xuticheck",
        page_index: 0,
        page_size: 1,
      },
    );
    if (!Array.isArray(output.voice_list)) throw invalidResponse(diagnostic);
    enrollment = { status: "reachable", diagnostic };
  } catch (error) {
    const details =
      error instanceof BailianVoiceError
        ? error
        : invalidResponse({ action: "list_voice" });
    const permissionDenied = [
      "BAILIAN_VOICE_AUTH",
      "BAILIAN_VOICE_KEY_TYPE",
      "BAILIAN_VOICE_PERMISSION",
      "BAILIAN_VOICE_WORKSPACE",
    ].includes(details.code);
    enrollment = {
      status: permissionDenied ? "unauthorized" : "unavailable",
      note: details.message,
      diagnostic: details.diagnostic,
    };
  }
  // Workspace read access observes authorization metadata. This does not
  // create an enrolled voice or verify a paid synthesis under this key.
  const models =
    enrollment.status === "reachable"
      ? await Promise.all(
          bailianCommerceVoiceModels.map(({ id }) =>
            checkModelPermission(connection, id),
          ),
        )
      : bailianCommerceVoiceModels.map(({ id }) => ({
          id,
          status: "unknown" as const,
        }));
  return { checkedAt: new Date().toISOString(), enrollment, models };
}

function validVoiceId(value: unknown): value is string {
  return typeof value === "string" && voiceIdPattern.test(value);
}

function voiceStatus(
  value: unknown,
  diagnostic?: BailianVoiceDiagnostic,
): BailianVoiceStatus {
  switch (value) {
    case "DEPLOYING":
      return "pending";
    case "OK":
      return "ready";
    case "UNDEPLOYED":
      return "failed";
    default:
      throw invalidResponse(diagnostic);
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
  const { output, diagnostic } = await providerRequest(
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
    throw invalidResponse(diagnostic);
  // Creation returns an ID before review. Only query_voice confirms readiness.
  return { voiceId: output.voice_id, status: "pending" };
}

export async function queryBailianVoice(
  connection: BailianVoiceConnection,
  voiceId: string,
  expectedModel: BailianCommerceVoiceModel,
) {
  if (!validVoiceId(voiceId)) throw invalidInput();
  const { output, diagnostic } = await providerRequest(
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
      diagnostic,
    );
  return { status: voiceStatus(output.status, diagnostic) };
}

export async function findBailianVoice(
  connection: BailianVoiceConnection,
  prefix: string,
  expectedModel: BailianCommerceVoiceModel,
): Promise<{ voiceId: string; status: BailianVoiceStatus } | undefined> {
  if (!prefixPattern.test(prefix)) throw invalidInput();
  const { output, diagnostic } = await providerRequest(
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
  if (!Array.isArray(output.voice_list)) throw invalidResponse(diagnostic);
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
    status: voiceStatus(matches[0].status, diagnostic),
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
  const { payload, output, diagnostic } = await providerRequest(
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
  if (output.finish_reason !== "stop") throw invalidResponse(diagnostic);
  let bytes: Buffer;
  try {
    bytes = await fetchMp3(mediaUrl(plainObject(output.audio)?.url));
  } catch {
    throw invalidResponse(diagnostic);
  }
  const characters = plainObject(payload.usage)?.characters;
  return {
    bytes,
    providerRequestId: diagnostic.providerRequestId,
    characters:
      typeof characters === "number" &&
      Number.isSafeInteger(characters) &&
      characters >= 0
        ? characters
        : null,
  };
}

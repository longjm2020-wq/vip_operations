import { aiFetch } from "../../ai-metering.js";
import { fail } from "../../core.js";
import type { Row } from "../../../../../packages/database/src/index.js";
import { qwenWorkspaceIdSchema } from "../../../../../packages/contracts/src/assistant-realtime.js";
import {
  qwenSpeechModel,
  type VoiceEvent,
} from "../../../../../packages/contracts/src/assistant-voice.js";
import { decryptSecret } from "../analytics/secrets.js";

export function qwenAudioBase(workspaceId: string) {
  return `https://${qwenWorkspaceIdSchema.parse(workspaceId)}.cn-beijing.maas.aliyuncs.com`;
}

export function qwenAudioError(status: number, code?: unknown) {
  if (code === "AllocationQuota.FreeTierOnly")
    return "千问当前模型的免费额度不可用或已用完，请在百炼核对；费用保护保持不变";
  if (status === 401) return "千问密钥校验失败，请核对北京地域的密钥与业务空间";
  if ([402, 429].includes(status))
    return "千问额度不足或请求受限，请核对当前模型的用量";
  if ([400, 403, 404].includes(status))
    return "千问模型、声音或业务空间不可用，请检查当前服务配置";
  return "千问音频服务暂不可用，请稍后手动重试";
}

export async function checkQwenAudioResponse(response: Response) {
  if (response.ok) return;
  // Only recognize the public error code. Never expose provider messages or URLs.
  let code: unknown;
  try {
    const body = await response.json();
    code = body.code || body.error?.code;
  } catch {
    /* use the HTTP status */
  }
  fail("VOICE_PROVIDER", qwenAudioError(response.status, code), 502);
}

/** Qwen-TTS streams mono 24 kHz signed 16-bit PCM, matching the existing player. */
export async function streamQwenSpeech(
  s: Row,
  text: string,
  signal: AbortSignal,
  emit: (event: VoiceEvent) => void,
) {
  signal.throwIfAborted();
  const response = await aiFetch(
    "voice_audio",
    `${qwenAudioBase(s.qwen_workspace_id)}/api/v1/services/aigc/multimodal-generation/generation`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
      headers: {
        Authorization: `Bearer ${decryptSecret(s.api_key_encrypted)}`,
        "Content-Type": "application/json",
        "X-DashScope-SSE": "enable",
      },
      body: JSON.stringify({
        model: qwenSpeechModel,
        input: {
          text: text.slice(0, 600),
          voice: s.voice,
          language_type: "Auto",
        },
      }),
    },
  );
  await checkQwenAudioResponse(response);
  if (!response.body) fail("VOICE_STREAM", "千问语音响应为空", 502);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    audioBytes = 0,
    completed = false;
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") return;
    const part = JSON.parse(raw) as Row;
    if (part.error || part.code || Number(part.status_code || 200) >= 400)
      fail(
        "VOICE_PROVIDER",
        qwenAudioError(
          Number(part.status_code || 502),
          part.code || part.error?.code,
        ),
        502,
      );
    if (
      part.model &&
      part.model !== qwenSpeechModel &&
      !part.model.startsWith(qwenSpeechModel + "-20")
    )
      fail("VOICE_MODEL", "千问返回的朗读模型与配置不一致", 502);
    const data = part.output?.audio?.data;
    if (data) {
      if (
        completed ||
        typeof data !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
      )
        fail("VOICE_STREAM", "千问语音流校验失败", 502);
      const bytes = Buffer.from(data, "base64");
      if (!bytes.length || bytes.length % 2)
        fail("VOICE_STREAM", "千问音频格式异常", 502);
      if (!audioBytes) emit({ type: "model", model: "小序语音" });
      audioBytes += bytes.length;
      if (audioBytes > 5760000)
        fail("VOICE_STREAM", "语音回复过长，已停止播放", 502);
      emit({ type: "audio", data });
    }
    if (part.output?.finish_reason === "stop") completed = true;
    else if (part.output?.finish_reason && part.output.finish_reason !== "null")
      fail("VOICE_STREAM", "千问语音回复未完整生成，请查看文字结果", 502);
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 2000000)
        fail("VOICE_STREAM", "千问语音流格式异常", 502);
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) consume(line);
    }
    consume(pending + decoder.decode());
    signal.throwIfAborted();
    if (!completed || !audioBytes)
      fail("VOICE_STREAM", "未收到完整千问语音，请检查服务状态", 502);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function pcmToVoiceWav(pcm: Buffer) {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav.toString("base64");
}

import WebSocket from "ws";
import { decryptSecret } from "../analytics/secrets.js";
import { fail } from "../../core.js";
import {
  qwenRealtimeModel,
  qwenWorkspaceIdSchema,
} from "../../../../../packages/contracts/src/assistant-realtime.js";

type Event = Record<string, unknown>;
type Base = { instructions: string; tools: unknown[] };

/** Beijing only: free quotas are regional. Never accept an arbitrary host or URL. */
export function qwenRealtimeEndpoint(workspaceId: string) {
  const workspace = qwenWorkspaceIdSchema.parse(workspaceId);
  return `wss://${workspace}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=${qwenRealtimeModel}`;
}
export function qwenConfiguration(voice: string, base: Base) {
  return {
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      instructions: base.instructions,
      audio: {
        input: {
          format: {
            type: "pcm",
            sample_rate: 16000,
            sample_format: "s16le",
            channels: 1,
            packing: "interleaved",
            channel_layout: "mono",
          },
        },
        output: { voice, format: { type: "pcm", sample_rate: 24000 } },
      },
      input_audio_transcription: { model: "qwen3-asr-flash-realtime" },
      turn_detection: {
        type: "semantic_vad_ec",
        threshold: 0.5,
        silence_duration_ms: 800,
      },
      tools: base.tools.map((tool) => {
        const t = tool as Event;
        return {
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        };
      }),
      // Qwen Realtime does not support tool_choice or parallel_tool_calls.
    },
  };
}
export function qwenProviderSocket(encryptedKey: string, workspaceId: string) {
  return new WebSocket(qwenRealtimeEndpoint(workspaceId), {
    headers: {
      Authorization: `Bearer ${decryptSecret(encryptedKey)}`,
      "X-DashScope-OmniRealtime": "true",
    },
    handshakeTimeout: 15000,
    maxPayload: 2 * 1024 * 1024,
    perMessageDeflate: false,
    followRedirects: false,
  });
}
export function closeQwenSocket(socket: WebSocket) {
  if (socket.readyState === WebSocket.CONNECTING) return socket.terminate();
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.close();
  const timer = setTimeout(() => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }, 1000);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
}
export function qwenErrorMessage(code: unknown, diagnostic?: unknown) {
  const value = `${String(code ?? "")} ${typeof diagnostic === "string" ? diagnostic : ""}`;
  if (/FreeTierOnly/i.test(value))
    return "免费额度已用完或不适用于当前服务，实时通话已停止；不会自动切换其他通道";
  if (/Quota|Balance|Arrearage|\b402\b|\b429\b|RateLimit/i.test(value))
    return "实时语音额度不足或请求受限，请检查免费额度及停用设置";
  if (/InvalidApiKey|Unauthorized|AccessDenied|\b401\b|\b403\b/i.test(value))
    return "实时语音授权失败，请检查北京地域的密钥、业务空间及服务权限";
  if (/InvalidParameter|InvalidVoice|\b400\b|\b404\b/i.test(value))
    return "实时语音配置不可用，请检查业务空间、服务权限和声音";
  return "实时语音连接暂不可用，请稍后重试";
}
export function qwenEventError(event: Event) {
  const error =
    event.error && typeof event.error === "object"
      ? (event.error as Event)
      : event;
  return qwenErrorMessage(error.code, error.message);
}
export function qwenBenignError(event: Event) {
  const error =
    event.error && typeof event.error === "object"
      ? (event.error as Event)
      : event;
  return [
    "input_audio_buffer_commit_empty",
    "response_cancel_not_active",
  ].includes(String(error.code));
}
export function qwenSessionMatches(event: Event, voice: string) {
  const session = event.session as
    | {
        id?: string;
        model?: string;
        voice?: string;
        audio?: { output?: { voice?: string } };
      }
    | undefined;
  return (
    !!session?.id &&
    (!session.model || session.model === qwenRealtimeModel) &&
    (session.audio?.output?.voice ?? session.voice) === voice
  );
}
/** Configuration acknowledgement only; no generated audio or microphone data. */
export async function verifyQwenRealtime(
  encryptedKey: string,
  workspaceId: string,
  voice: string,
  base: Base,
) {
  await new Promise<void>((resolve, reject) => {
    const socket = qwenProviderSocket(encryptedKey, workspaceId);
    let finished = false,
      configured = false;
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      closeQwenSocket(socket);
      if (!error) return resolve();
      try {
        fail("REALTIME_PROVIDER", error, 502);
      } catch (e) {
        reject(e);
      }
    };
    const timer = setTimeout(
      () => finish("实时语音连接超时，请稍后重试"),
      20000,
    );
    socket.on("message", (raw, binary) => {
      if (finished) return;
      try {
        if (binary) return finish("实时语音服务返回格式异常");
        const event = JSON.parse(raw.toString());
        if (event.type === "session.created" && !configured) {
          configured = true;
          socket.send(JSON.stringify(qwenConfiguration(voice, base)));
        } else if (event.type === "session.updated" && configured) {
          finish(
            qwenSessionMatches(event, voice)
              ? undefined
              : "实时语音服务返回与配置不一致，验证未通过",
          );
        } else if (event.type === "error") finish(qwenEventError(event));
      } catch {
        finish("实时语音服务返回格式异常");
      }
    });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      finish(qwenErrorMessage(response.statusCode));
    });
    socket.on("error", () => finish(qwenErrorMessage(undefined)));
    socket.on("close", () => finish("实时语音连接提前结束，请检查配置"));
  });
}

/** Adapt vendor events to the existing browser audio protocol. Keep turn identity
 * even when transcription/tool output arrives after an interruption. */
export class QwenRealtimeProtocol {
  private turn = 0;
  private itemId: unknown;
  private activeResponse = "";
  private responses = new Map<
    string,
    { turn: number; itemId: unknown; canceled: boolean }
  >();
  private tools = new Map<string, Event[]>();
  private muted = false;
  private bufferedFrames = 0;
  private manualCommit = false;
  constructor(private send: (event: Event) => void) {}
  current(responseId: unknown) {
    const response = this.responses.get(String(responseId));
    return !!response && response.turn === this.turn && !response.canceled;
  }
  command(event: Event) {
    if (
      event.type === "input_audio_mute.commit" ||
      event.type === "input_audio_unmute.commit"
    ) {
      this.muted = event.type === "input_audio_mute.commit";
      this.bufferedFrames = 0;
      this.manualCommit = false;
      this.send({ type: "input_audio_buffer.clear" });
      return;
    }
    if (event.type === "response.cancel") {
      if (this.activeResponse) {
        const response = this.responses.get(this.activeResponse);
        if (response) response.canceled = true;
        this.send({ type: "response.cancel" });
        this.activeResponse = "";
      }
      return;
    }
    if (event.type === "input_audio_buffer.append") {
      if (this.muted) return;
      this.bufferedFrames++;
    }
    if (event.type === "input_audio_buffer.commit") {
      if (this.muted || this.bufferedFrames < 5 || this.manualCommit) return;
      this.manualCommit = true;
      this.bufferedFrames = 0;
    }
    this.send(event);
  }
  events(event: Event): Event[] {
    if (event.type === "input_audio_buffer.speech_started") {
      this.command({ type: "response.cancel" });
      this.turn++;
      this.itemId = event.item_id;
      for (const [id, response] of this.responses)
        if (response.turn < this.turn - 40) this.responses.delete(id);
      this.tools.clear();
      return [
        {
          ...event,
          type: "conversation.item.input_audio_transcription.started",
        },
      ];
    }
    if (event.type === "input_audio_buffer.committed") {
      this.bufferedFrames = 0;
      this.itemId = event.item_id;
      if (this.manualCommit) {
        this.manualCommit = false;
        if (!this.activeResponse) this.send({ type: "response.create" });
      }
    }
    if (event.type === "response.created") {
      const response = event.response as Event | undefined;
      if (typeof response?.id !== "string") return [];
      this.activeResponse = response.id;
      this.responses.set(response.id, {
        turn: this.turn,
        itemId: this.itemId,
        canceled: false,
      });
      return [
        {
          type: "response.output_audio.started",
          response_id: response.id,
          question_id: this.itemId,
        },
      ];
    }
    const responseId = String(
      event.response_id ?? (event.response as Event | undefined)?.id ?? "",
    );
    const questionId = this.responses.get(responseId)?.itemId;
    if (String(event.type).startsWith("response.") && !this.current(responseId))
      return [];
    if (event.type === "response.function_call_arguments.done") {
      const calls = this.tools.get(responseId) ?? [];
      if (!calls.some((call) => call.call_id === event.call_id))
        calls.push(event);
      if (calls.length > 8) throw Error("too many tools");
      this.tools.set(responseId, calls);
      return [];
    }
    if (event.type === "response.done") {
      if (this.activeResponse === responseId) this.activeResponse = "";
      const calls = this.tools.get(responseId);
      this.tools.delete(responseId);
      const response = event.response as Event | undefined;
      if (response?.status === "failed") throw Error("response failed");
      return [
        ...(calls?.length
          ? [
              {
                type: "response.function_call_arguments.done",
                items: calls,
                response_id: responseId,
                question_id: questionId,
              },
            ]
          : []),
        ...(calls?.length
          ? []
          : [
              {
                type: "response.output_audio.done",
                response_id: responseId,
                question_id: questionId,
              },
            ]),
        { ...event, response_id: responseId, question_id: questionId },
      ];
    }
    const aliases: Record<string, string> = {
      "response.audio.delta": "response.output_audio.delta",
      "response.audio.done": "response.output_audio.done",
      "response.audio_transcript.delta": "response.output_text.delta",
      "response.audio_transcript.done": "response.output_text.done",
      "response.text.delta": "response.output_text.delta",
      "response.text.done": "response.output_text.done",
      "input_audio_buffer.speech_stopped": "input_audio_buffer.speech_stopped",
    };
    return [
      {
        ...event,
        type: aliases[String(event.type)] ?? event.type,
        ...(responseId
          ? { response_id: responseId, question_id: questionId }
          : {}),
      },
    ];
  }
  toolResults(
    responseId: unknown,
    results: { call_id: string; output: string }[],
  ) {
    if (!this.current(responseId)) return;
    for (const result of results)
      this.send({
        type: "conversation.item.create",
        item: { type: "function_call_output", ...result },
      });
    this.send({ type: "response.create" });
  }
}

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { decryptSecret } from "../analytics/secrets.js";
import { fail } from "../../core.js";

export const doubaoRealtimeEndpoint =
  "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue";
export function doubaoConfiguration(
  voice: string,
  base: { instructions: string; tools: unknown[] },
) {
  return {
    type: "session.create",
    session: {
      model: "1.2.6.1",
      instructions: base.instructions,
      audio: {
        input: { format: { type: "pcm", rate: 16000 } },
        output: { format: { type: "pcm_s16le", rate: 24000 }, voice },
      },
      tools: base.tools,
    },
    extension: { asr: {}, tts: {}, dialog: {} },
  };
}
export function doubaoProviderSocket(encryptedKey: string) {
  return new WebSocket(doubaoRealtimeEndpoint, {
    headers: {
      "X-Api-Key": decryptSecret(encryptedKey),
      "X-Api-Request-Id": randomUUID(),
    },
    handshakeTimeout: 15000,
    maxPayload: 2 * 1024 * 1024,
    perMessageDeflate: false,
    followRedirects: false,
  });
}
/** Let the provider finalize the session before tearing down its transport. */
export function closeDoubaoSocket(socket: WebSocket) {
  if (socket.readyState !== WebSocket.OPEN) {
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    return;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    socket.off("message", onMessage);
    socket.off("close", finish);
    socket.close();
    const terminate = setTimeout(() => {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }, 1000);
    terminate.unref();
    socket.once("close", () => clearTimeout(terminate));
  };
  const onMessage = (data: WebSocket.RawData) => {
    try {
      if (JSON.parse(data.toString()).type === "session.closed") finish();
    } catch {
      /* Ignore pending audio while closing. */
    }
  };
  const timer = setTimeout(finish, 1500);
  timer.unref();
  socket.on("message", onMessage);
  socket.once("close", finish);
  socket.send(JSON.stringify({ type: "session.close" }));
}
export function doubaoErrorMessage(
  code: unknown,
  diagnostic?: unknown,
): string {
  const status = String(code ?? "");
  if (/^(401|403|45000000)$/.test(status))
    return "实时语音授权失败，请检查密钥和服务权限";
  if (/^(402|429)/.test(status))
    return "实时语音额度不足或请求受限，请检查服务额度";
  if (status === "45000003") return "长时间未收到音频，实时通话已结束";
  if (
    status === "55000001" &&
    typeof diagnostic === "string" &&
    diagnostic.includes("InvalidSpeaker")
  )
    return "实时语音声音配置不可用，请重新选择并验证";
  if (status.startsWith("4"))
    return "实时语音请求未被接受，请检查服务权限与配置";
  return "实时语音连接暂不可用，请稍后重试";
}
export function doubaoEventError(event: Record<string, unknown>) {
  const error =
    event.error && typeof event.error === "object"
      ? (event.error as Record<string, unknown>)
      : {};
  return doubaoErrorMessage(
    event.status_code ?? error.code ?? event.code,
    error.message ?? event.message,
  );
}
/** Verification opens only a session; no microphone, recording or test utterance. */
export async function verifyDoubaoRealtime(
  encryptedKey: string,
  voice: string,
  base: { instructions: string; tools: unknown[] },
) {
  await new Promise<void>((resolve, reject) => {
    const socket = doubaoProviderSocket(encryptedKey);
    let finished = false;
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      closeDoubaoSocket(socket);
      if (error) {
        try {
          fail("REALTIME_PROVIDER", error, 502);
        } catch (e) {
          reject(e);
        }
      } else resolve();
    };
    const timer = setTimeout(
      () => finish("实时语音连接超时，请稍后重试"),
      20000,
    );
    socket.on("open", () =>
      socket.send(JSON.stringify(doubaoConfiguration(voice, base))),
    );
    socket.on("message", (raw, binary) => {
      try {
        if (binary) return finish("实时语音服务返回格式异常");
        const event = JSON.parse(raw.toString());
        if (
          event.type === "session.created" &&
          typeof event.session?.id === "string"
        )
          finish();
        else if (event.type === "error") finish(doubaoEventError(event));
      } catch {
        finish("实时语音服务返回格式异常");
      }
    });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      finish(doubaoErrorMessage(response.statusCode));
    });
    socket.on("error", () => finish(doubaoErrorMessage(undefined)));
    socket.on("close", () => finish("实时语音连接提前结束，请检查配置"));
  });
}

import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { HttpException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { actorForSessionHash } from "../auth/service.js";
import type { Context } from "../../core.js";
import { requireAssistant } from "./assistant-memory.js";
import { isRealtimeToolName } from "../../../../../packages/contracts/src/assistant-realtime.js";
import {
  activateRealtimeSocket,
  claimRealtimeSocket,
  checkRealtime,
  closeRealtime,
  realtimeConfiguration,
  runRealtimeTool,
} from "./assistant-realtime.js";
import {
  closeDoubaoSocket,
  doubaoConfiguration,
  doubaoErrorMessage,
  doubaoEventError,
  doubaoProviderSocket,
} from "./doubao-realtime.js";
import {
  closeQwenSocket,
  qwenProviderSocket,
  qwenConfiguration,
  qwenSessionMatches,
  qwenErrorMessage,
  qwenEventError,
  qwenBenignError,
  QwenRealtimeProtocol,
} from "./qwen-realtime.js";
import {
  registerRealtimeRelay,
  closeAllRealtimeRelays,
} from "./realtime-relay-registry.js";
import { assistantPublicText } from "../../../../../packages/contracts/src/ai-presentation.js";

const route =
  /^\/api\/v1\/my-workspace\/assistant\/realtime\/sessions\/([\da-f-]{36})\/socket$/i;
const simpleCommands = new Set([
  "input_audio_buffer.commit",
  "input_audio_mute.commit",
  "input_audio_unmute.commit",
  "response.cancel",
  "session.close",
]);
/** 50 PCM frames/sec plus controls, allowing up to three seconds of network
 * coalescing. A monotonic token budget avoids rejecting a healthy stream merely
 * because packets arrive together at a wall-clock second boundary. */
export class RealtimeFrameBudget {
  private credit = 150;
  private last: number;
  constructor(private clock = () => performance.now()) {
    this.last = clock();
  }
  take() {
    const now = this.clock();
    this.credit = Math.min(
      150,
      this.credit + Math.max(0, now - this.last) * 0.06,
    );
    this.last = now;
    if (this.credit < 1) return false;
    this.credit--;
    return true;
  }
}
/** Preserve a short interruption in provider writes without dropping or replaying
 * speech. Once queued, audio and control/tool events share one ordered drain. */
export class RealtimeUpstreamBuffer {
  private queue: {
    payload: string;
    bytes: number;
    at: number;
    valid?: () => boolean;
  }[] = [];
  private queuedBytes = 0;
  private closed = false;
  constructor(
    private bufferedAmount: () => number,
    private write: (payload: string) => void,
    private failed: (metrics: {
      bufferedBytes: number;
      queuedBytes: number;
      queuedMessages: number;
      waitMs: number;
    }) => void,
    private clock = () => performance.now(),
  ) {}
  send(event: Record<string, unknown>, valid?: () => boolean) {
    if (this.closed || (valid && !valid())) return;
    this.prune();
    const payload = JSON.stringify(event);
    const bytes = Buffer.byteLength(payload);
    const pending = this.bufferedAmount();
    if (!this.queue.length && pending + bytes <= 256 * 1024) {
      this.write(payload);
      return;
    }
    this.queue.push({ payload, bytes, at: this.clock(), valid });
    this.queuedBytes += bytes;
    this.check();
  }
  private prune() {
    // Only obsolete response continuations carry this predicate. Audio and user
    // controls never do, so interruption cannot truncate retained speech.
    this.queue = this.queue.filter((entry) => {
      if (!entry.valid || entry.valid()) return true;
      this.queuedBytes -= entry.bytes;
      return false;
    });
  }
  private check() {
    if (this.closed) return false;
    this.prune();
    const bufferedBytes = this.bufferedAmount();
    const waitMs = this.queue.length ? this.clock() - this.queue[0].at : 0;
    if (
      bufferedBytes > 512 * 1024 ||
      this.queuedBytes > 128 * 1024 ||
      this.queue.length > 100 ||
      waitMs >= 2000
    ) {
      const metrics = {
        bufferedBytes,
        queuedBytes: this.queuedBytes,
        queuedMessages: this.queue.length,
        waitMs,
      };
      this.close();
      this.failed(metrics);
      return false;
    }
    return true;
  }
  flush() {
    if (!this.queue.length || !this.check()) return;
    // At most 40 ms of PCM per tick: catch up gradually after a brief stall.
    for (let sent = 0; sent < 2 && this.queue.length; sent++) {
      this.prune();
      if (!this.queue.length) return;
      const next = this.queue[0];
      if (this.bufferedAmount() + next.bytes > 256 * 1024) return;
      this.queue.shift();
      this.queuedBytes -= next.bytes;
      this.write(next.payload);
      if (this.closed) return;
    }
  }
  close() {
    this.closed = true;
    this.queue = [];
    this.queuedBytes = 0;
  }
}
function relayFailure(error: unknown) {
  if (error instanceof HttpException) {
    const response = error.getResponse() as {
      error?: { code?: string; message?: string };
    };
    if (typeof response.error?.message === "string")
      return assistantPublicText(response.error.message);
  }
  // Never log raw provider errors, credentials, request bodies or SQL arguments.
  const safe = error as {
    name?: string;
    code?: string;
    meta?: { code?: string };
  };
  const code = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9_]{1,48}$/.test(value)
      ? value
      : "unknown";
  console.error("Realtime relay failure", {
    name: code(safe?.name),
    code: code(safe?.code),
    databaseCode: code(safe?.meta?.code),
  });
  return "实时语音连接失败，请重新开始";
}
/** Only the audio protocol is client-controlled; prompts, tools and tool results stay server-owned. */
export function allowedRealtimeClientEvent(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string") return null;
  if (simpleCommands.has(event.type))
    return Object.keys(event).length === 1 ? { type: event.type } : null;
  if (
    event.type !== "input_audio_buffer.append" ||
    Object.keys(event).some((k) => !["type", "audio"].includes(k)) ||
    typeof event.audio !== "string"
  )
    return null;
  // 20 ms of mono PCM16 at 16 kHz. Reject malformed or oversized base64 before forwarding.
  if (!/^[A-Za-z0-9+/]{854}==$/.test(event.audio)) return null;
  const bytes = Buffer.from(event.audio, "base64");
  if (bytes.length !== 640 || bytes.toString("base64") !== event.audio)
    return null;
  return { type: event.type, audio: event.audio };
}
const forwarded = new Set([
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "conversation.item.input_audio_transcription.started",
  "conversation.item.input_audio_transcription.delta",
  "conversation.item.input_audio_transcription.completed",
  "conversation.item.input_audio_transcription.failed",
  "response.output_text.delta",
  "response.output_text.done",
  "response.output_audio.started",
  "response.output_audio.delta",
  "response.output_audio.done",
  "response.done",
  "response.canceled",
]);
// No raw session configuration, provider trace, usage metadata or errors reaches ordinary clients.
export function publicRealtimeEvent(event: Record<string, unknown>) {
  if (!forwarded.has(String(event.type))) return null;
  const out: Record<string, unknown> = { type: event.type };
  for (const key of [
    "event_id",
    "item_id",
    "question_id",
    "response_id",
    "output_index",
    "content_index",
    "delta",
    "text",
    "transcript",
    "asr_info",
    "response",
  ])
    if (event[key] !== undefined && key !== "response" && key !== "asr_info")
      out[key] = event[key];
  if (event.response && typeof event.response === "object") {
    const r = event.response as Record<string, unknown>;
    out.response = { id: r.id, status: r.status };
  }
  // The protocol sends asr_info.is_interim on completed transcripts in some versions.
  if (event.asr_info && typeof event.asr_info === "object")
    out.asr_info = {
      is_interim: (event.asr_info as Record<string, unknown>).is_interim,
    };
  if (String(event.type).startsWith("response.output_text")) {
    for (const key of ["delta", "text"])
      if (typeof out[key] === "string")
        out[key] = assistantPublicText(out[key] as string);
  }
  return out;
}
function sessionHash(request: IncomingMessage) {
  const token = /(?:^|;\s*)session=([^;]+)/.exec(
    request.headers.cookie || "",
  )?.[1];
  if (!token || token.length > 512) throw Error("unauthenticated");
  return createHash("sha256").update(decodeURIComponent(token)).digest("hex");
}
function rejectUpgrade(socket: Duplex, status = 403) {
  socket.end(
    `HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}
export function attachRealtimeRelay(server: Server) {
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 8192,
    perMessageDeflate: false,
  });
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => {});
    const matched = route.exec(request.url || "");
    if (!matched || request.headers.origin !== process.env.APP_ORIGIN)
      return rejectUpgrade(socket);
    void (async () => {
      const hash = sessionHash(request);
      const c: Context = {
        actor: await actorForSessionHash(hash),
        requestId: randomUUID(),
      };
      requireAssistant(c);
      if (socket.destroyed) return;
      websocketServer.handleUpgrade(request, socket, head, (client) => {
        runRelay(client, c, matched[1], hash);
      });
    })().catch(() => rejectUpgrade(socket));
  };
  server.on("upgrade", upgrade);
  return () => {
    server.off("upgrade", upgrade);
    closeAllRealtimeRelays();
    websocketServer.close();
  };
}
function runRelay(
  client: WebSocket,
  context: Context,
  id: string,
  authHash: string,
) {
  let upstream: WebSocket | undefined;
  let qwen: QwenRealtimeProtocol | undefined;
  let configuring = false;
  let closed = false,
    authenticating = false,
    ready = false,
    healthBusy = false,
    pong = true;
  let unregister: (() => void) | undefined;
  let health: ReturnType<typeof setInterval> | undefined;
  let upstreamDrain: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let toolQueue = Promise.resolve();
  const frameBudget = new RealtimeFrameBudget();
  const upstreamBuffer = new RealtimeUpstreamBuffer(
    () => upstream?.bufferedAmount ?? 0,
    (payload) => {
      if (!closed && upstream?.readyState === WebSocket.OPEN)
        upstream.send(payload);
    },
    (metrics) => {
      console.warn("Realtime provider write congestion", {
        provider: qwen ? "qwen" : "doubao",
        ...metrics,
      });
      stop("语音服务连接持续拥塞，本次通话已停止，请稍后重新开始");
    },
  );
  let c = context;
  const send = (data: unknown) => {
    if (closed || client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > 1024 * 1024) return stop();
    client.send(JSON.stringify(data));
  };
  const stop = (message?: string) => {
    if (closed) return;
    if (message) send({ type: "xuti.error", message });
    closed = true;
    clearTimeout(connectTimer);
    clearTimeout(lifetime);
    clearInterval(health);
    clearInterval(upstreamDrain);
    upstreamBuffer.close();
    unregister?.();
    if (upstream) (qwen ? closeQwenSocket : closeDoubaoSocket)(upstream);
    client.close(1000);
    // The close API may run on another replica; periodic ownership checks also observe its state.
    void closeRealtime(c, id).catch(() => {});
  };
  const connectTimer = setTimeout(
    () => stop("语音连接超时，请重新开始"),
    20000,
  );
  const refreshActor = async () => {
    const actor = await actorForSessionHash(authHash);
    if (actor.id !== context.actor.id) throw Error("owner changed");
    requireAssistant({ actor, requestId: c.requestId });
    c = { ...c, actor };
  };
  client.on("error", () => stop());
  client.on("pong", () => {
    pong = true;
  });
  client.on("close", () => stop());
  client.on("message", (raw, binary) => {
    void (async () => {
      if (closed) return;
      if (binary) return stop("语音数据格式无效");
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return stop("语音数据格式无效");
      }
      if (!authenticating) {
        authenticating = true;
        if (
          event.type !== "authenticate" ||
          typeof event.ticket !== "string" ||
          !/^[\w-]{43}$/.test(event.ticket) ||
          Object.keys(event).length !== 2
        )
          return stop("语音连接凭证无效，请重新开始");
        const config = await claimRealtimeSocket(c, id, event.ticket);
        if (closed) return;
        unregister = registerRealtimeRelay(id, () => stop());
        if (config.provider === "qwen")
          qwen = new QwenRealtimeProtocol((e, valid) =>
            upstreamBuffer.send(e, valid),
          );
        upstream = qwen
          ? qwenProviderSocket(config.key, config.workspaceId!)
          : doubaoProviderSocket(config.key);
        upstream.on("open", () => {
          if (closed || qwen) return;
          upstream!.send(
            JSON.stringify(
              doubaoConfiguration(
                config.voice,
                realtimeConfiguration(config.voice, config.desktopEnabled),
              ),
            ),
          );
        });
        upstream.on("error", () =>
          stop((qwen ? qwenErrorMessage : doubaoErrorMessage)(undefined)),
        );
        upstream.on("unexpected-response", (_req, res) => {
          res.resume();
          stop((qwen ? qwenErrorMessage : doubaoErrorMessage)(res.statusCode));
        });
        upstream.on("close", () =>
          stop(ready ? "实时语音连接已结束" : "实时语音连接未建立，请检查配置"),
        );
        upstream.on("message", (data, isBinary) => {
          void (async () => {
            if (closed) return;
            if (isBinary) return stop("实时语音服务返回格式异常");
            const rawEvent = JSON.parse(data.toString()) as Record<
              string,
              unknown
            >;
            if (rawEvent.type === "error") {
              if (qwen && qwenBenignError(rawEvent)) return;
              return stop((qwen ? qwenEventError : doubaoEventError)(rawEvent));
            }
            if (rawEvent.type === "session.closed") return stop();
            if (qwen && rawEvent.type === "session.created") {
              if (!configuring) {
                configuring = true;
                upstream!.send(
                  JSON.stringify(
                    qwenConfiguration(
                      config.voice,
                      realtimeConfiguration(
                        config.voice,
                        config.desktopEnabled,
                      ),
                    ),
                  ),
                );
              }
              return;
            }
            if (
              rawEvent.type === (qwen ? "session.updated" : "session.created")
            ) {
              if (ready) return;
              if (
                qwen
                  ? !configuring || !qwenSessionMatches(rawEvent, config.voice)
                  : !rawEvent.session ||
                    typeof (rawEvent.session as Record<string, unknown>).id !==
                      "string"
              )
                return stop("实时语音服务返回格式异常");
              await refreshActor();
              const expiresAt = await activateRealtimeSocket(c, id);
              if (closed) return;
              ready = true;
              upstreamDrain = setInterval(() => {
                try {
                  upstreamBuffer.flush();
                } catch {
                  stop("语音服务连接已中断，请重新开始");
                }
              }, 20);
              clearTimeout(connectTimer);
              lifetime = setTimeout(
                () => stop("本次实时通话已结束，可再次开始"),
                3600000,
              );
              health = setInterval(() => {
                if (healthBusy || closed) return;
                if (!pong) return stop();
                pong = false;
                client.ping();
                healthBusy = true;
                void refreshActor()
                  .then(() => checkRealtime(c, id))
                  .catch(() => stop("登录或语音配置已变化，实时通话已结束"))
                  .finally(() => {
                    healthBusy = false;
                  });
              }, 15000);
              send({ type: "xuti.ready", expiresAt });
              return;
            }
            if (!ready) return;
            for (const e of qwen ? qwen.events(rawEvent) : [rawEvent]) {
              if (e.type === "response.function_call_arguments.done") {
                if (!Array.isArray(e.items) || e.items.length > 8)
                  return stop("语音指令格式无效");
                const items = e.items;
                const turn = {
                  question_id: e.question_id,
                  response_id: e.response_id,
                };
                send({ type: "xuti.tool_started", ...turn });
                toolQueue = toolQueue
                  .then(async () => {
                    if (closed || (qwen && !qwen.current(e.response_id)))
                      return;
                    const results = [];
                    const qwenResults: { call_id: string; output: string }[] =
                      [];
                    for (const item of items) {
                      if (closed) return;
                      if (qwen && !qwen.current(e.response_id)) return;
                      await refreshActor();
                      if (closed || (qwen && !qwen.current(e.response_id)))
                        return;
                      if (
                        !item ||
                        !isRealtimeToolName(item.name) ||
                        typeof item.call_id !== "string" ||
                        typeof item.arguments !== "string" ||
                        item.arguments.length > 16000
                      )
                        throw Error("invalid tool");
                      const args = JSON.parse(item.arguments);
                      const result = await runRealtimeTool(c, id, {
                        tool: item.name,
                        callId: item.call_id,
                        request: args.request,
                      });
                      if (closed) return;
                      qwenResults.push({
                        call_id: item.call_id,
                        output: JSON.stringify(result),
                      });
                      results.push({
                        type: "message",
                        call_id: item.call_id,
                        role: "tool",
                        content: [
                          { type: "input_text", text: JSON.stringify(result) },
                        ],
                      });
                      send({
                        type: "xuti.tool_result",
                        call_id: item.call_id,
                        result,
                        ...turn,
                      });
                    }
                    if (
                      upstream?.readyState === WebSocket.OPEN &&
                      !closed &&
                      qwen
                    )
                      qwen.toolResults(e.response_id, qwenResults);
                    else if (upstream?.readyState === WebSocket.OPEN && !closed)
                      upstreamBuffer.send({
                        type: "conversation.item.create",
                        items: results,
                      });
                  })
                  .catch(() => stop("语音操作未完成，请查看完整对话后再试"));
                continue;
              }
              const safe = publicRealtimeEvent(e);
              if (safe) send(safe);
            }
          })().catch(() => stop("实时语音服务返回异常，请重新开始"));
        });
        return;
      }
      const allowed = allowedRealtimeClientEvent(event);
      if (!allowed) return stop("语音数据格式无效");
      if (allowed.type === "session.close") return stop();
      if (!ready || upstream?.readyState !== WebSocket.OPEN)
        return stop("实时语音尚未连接，请重新开始");
      if (!frameBudget.take()) return stop("音频持续发送过快，请重新开始");
      if (qwen) qwen.command(allowed);
      else upstreamBuffer.send(allowed);
    })().catch((error) => stop(relayFailure(error)));
  });
}

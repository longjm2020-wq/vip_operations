vi.mock("../../apps/api/src/ai-metering.js", () => ({ aiFetch: (_feature: string, url: string | URL, options: RequestInit) => fetch(url, options), recordAiReceipt: async () => {} }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
type FakeSocket = EventEmitter & {
  sent: Record<string, any>[];
  readyState: number;
};
const f = vi.hoisted(() => ({
  sockets: [] as FakeSocket[],
  connections: [] as { url: string; options: any }[],
}));
vi.mock("../../apps/api/src/modules/analytics/secrets.js", () => ({
  decryptSecret: () => "test-secret",
}));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: class extends EventEmitter {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 1;
      sent: Record<string, any>[] = [];
      constructor(url: string, options: unknown) {
        super();
        f.connections.push({ url, options });
        f.sockets.push(this);
      }
      send(s: string) {
        this.sent.push(JSON.parse(s));
      }
      close() {
        this.readyState = 3;
        this.emit("close");
      }
      terminate() {
        this.close();
      }
    },
  };
});
import {
  QwenRealtimeProtocol,
  qwenConfiguration,
  qwenErrorMessage,
  qwenRealtimeEndpoint,
  qwenRealtimeWebRtcEndpoint,
  qwenWebRtcConfiguration,
  createQwenWebRtcSession,
  verifyQwenRealtime,
} from "../../apps/api/src/modules/workspace/qwen-realtime.js";
import { qwenRealtimeModel } from "../../packages/contracts/src/assistant-realtime.js";
const base = {
  instructions: "trusted",
  tools: [
    {
      name: "workspace_request",
      description: "work",
      parameters: { type: "object" },
    },
  ],
};
const emit = (socket: FakeSocket, event: unknown) =>
  socket.emit("message", Buffer.from(JSON.stringify(event)), false);
beforeEach(() => {
  f.sockets.length = 0;
  f.connections.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Qwen WebRTC safe handshake errors", () => {
  const connect = (signal = new AbortController().signal) =>
    createQwenWebRtcSession(
      "encrypted",
      "workspace-1",
      "v=0\r\nm=audio 9\r\n",
      signal,
    );
  async function failure(body: BodyInit | null, status = 403) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status })),
    );
    const error = await connect().catch((error: unknown) => error);
    expect(error).toMatchObject({
      response: {
        error: {
          code: "REALTIME_PROVIDER",
          message: expect.stringContaining(`HTTP ${status}`),
        },
      },
      status: 502,
    });
    expect(JSON.stringify(error)).not.toMatch(
      /provider-private|test-secret|workspace-1|request-private/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    return (error as { response: { error: { message: string } } }).response
      .error.message;
  }
  it.each([
    [403, { code: "AllocationQuota.FreeTierOnly" }, "按费用保护停止"],
    [
      403,
      {
        error: {
          code: "AllocationQuota.FreeTierOnly",
          message: "provider-private",
        },
      },
      "按费用保护停止",
    ],
    [429, { code: "Throttling.AllocationQuota" }, "额度或限流限制"],
    [429, { error: { code: "insufficient_quota" } }, "额度或限流限制"],
    [401, { code: "InvalidApiKey" }, "密钥校验失败"],
    [401, { error: { code: "invalid_api_key" } }, "密钥校验失败"],
    [403, { code: "Workspace.AccessDenied" }, "访问被拒绝"],
    [403, { code: "Arrearage" }, "账户或预算状态受限"],
    [429, { code: "BudgetLimitExceeded" }, "账户或预算状态受限"],
  ])(
    "classifies only a known error code for HTTP %s without exposing diagnostic content",
    async (status, code, expected) => {
      const message = await failure(
        JSON.stringify({
          ...code,
          message: "provider-private test-secret workspace-1",
          request_id: "request-private",
        }),
        status,
      );
      expect(message).toContain(expected);
    },
  );
  it.each([
    '{"message":"AllocationQuota.FreeTierOnly provider-private"}',
    '{"code":"prefix-InvalidApiKey-provider-private"}',
    '{"error":{"code":"UnknownQuotaProviderCode","message":"InvalidApiKey"}}',
    '{"code":"InvalidApiKey","error":{"code":"AllocationQuota.FreeTierOnly"}}',
    '[{"code":"AllocationQuota.FreeTierOnly"}]',
    '"AllocationQuota.FreeTierOnly"',
    "<html>AllocationQuota.FreeTierOnly provider-private</html>",
    '{"code":"AllocationQuota.FreeTierOnly",',
    "null",
  ])(
    "keeps unknown, conflicting or malformed responses generic",
    async (body) => {
      const message = await failure(body);
      expect(message).toContain("未识别的错误");
      expect(message).not.toMatch(/密钥校验失败|按费用保护停止|额度或限流限制/);
    },
  );
  it("reads a small chunked JSON error and ignores its private message", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        error: {
          code: "AllocationQuota.FreeTierOnly",
          message: "provider-private 私密",
        },
      }),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 25));
        controller.enqueue(bytes.slice(25));
        controller.close();
      },
    });
    expect(await failure(stream)).toContain("按费用保护停止");
  });
  it("cancels an oversized body without trusting a valid code hidden in it", async () => {
    const canceled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              code: "InvalidApiKey",
              message: "provider-private".repeat(1000),
            }),
          ),
        );
      },
      cancel: canceled,
    });
    expect(await failure(stream)).toContain("未识别的错误");
    expect(canceled).toHaveBeenCalledOnce();
  });
  it("bounds a stalled body read and does not wait for stalled cancellation", async () => {
    vi.useFakeTimers();
    const canceled = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ cancel: canceled });
    const pending = failure(stream);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toContain("未识别的错误");
    expect(canceled).toHaveBeenCalledOnce();
  });
  it("stops reading promptly when the caller closes the pending session", async () => {
    const canceled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel: canceled });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 403 })),
    );
    const controller = new AbortController();
    const pending = connect(controller.signal).catch((error: unknown) => error);
    await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({
      response: { error: { message: expect.stringContaining("未识别的错误") } },
    });
    expect(canceled).toHaveBeenCalledOnce();
  });
  it("discards read failures instead of returning their provider content", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(Error("provider-private test-secret workspace-1"));
      },
    });
    expect(await failure(stream, 500)).toContain("未识别的错误");
  });
});

describe("Qwen native realtime protocol", () => {
  it("pins Beijing and translates the exact audio/tool schema without allowing arbitrary hosts", () => {
    expect(qwenRealtimeEndpoint("workspace-1")).toBe(
      `wss://workspace-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=${qwenRealtimeModel}`,
    );
    expect(qwenRealtimeWebRtcEndpoint("workspace-1")).toBe(
      `https://workspace-1.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=${qwenRealtimeModel}`,
    );
    for (const input of [
      "",
      "../evil",
      "https://evil.test",
      "x.evil",
      "x?model=other",
      "-bad",
    ]) {
      expect(() => qwenRealtimeEndpoint(input)).toThrow();
      expect(() => qwenRealtimeWebRtcEndpoint(input)).toThrow();
    }
    const config = qwenConfiguration("Tina", base).session;
    expect(config.audio.input.format).toMatchObject({
      type: "pcm",
      sample_rate: 16000,
      channels: 1,
      sample_format: "s16le",
    });
    expect(config.audio.output).toEqual({
      voice: "Tina",
      format: { type: "pcm", sample_rate: 24000 },
    });
    expect(config.tools).toEqual([
      { type: "function", function: base.tools[0] },
    ]);
    expect(config).not.toHaveProperty("tool_choice");
    expect(config).not.toHaveProperty("parallel_tool_calls");
    const rtc = qwenWebRtcConfiguration("Tina", base).session;
    expect(rtc.audio).toEqual({ output: { voice: "Tina" } });
    expect(rtc.tools).toEqual(config.tools);
    expect(rtc.turn_detection).toEqual(config.turn_detection);
  });
  it("verifies configuration acknowledgement, not merely an open socket, without generating audio", async () => {
    const promise = verifyQwenRealtime(
      "encrypted",
      "workspace-1",
      "Tina",
      base,
    );
    const socket = f.sockets[0];
    expect(socket.sent).toEqual([]);
    expect(f.connections[0].options).toMatchObject({
      followRedirects: false,
      headers: { Authorization: "Bearer test-secret" },
    });
    emit(socket, { type: "session.created", session: { id: "s" } });
    expect(socket.sent).toEqual([qwenConfiguration("Tina", base)]);
    emit(socket, {
      type: "session.updated",
      session: {
        id: "s",
        model: qwenRealtimeModel,
        audio: { output: { voice: "Tina" } },
      },
    });
    await expect(promise).resolves.toBeUndefined();
    expect(socket.readyState).toBe(3);
    expect(socket.sent).toHaveLength(1);
  });
  it("rejects a voice mismatch and sanitizes quota errors", async () => {
    const verification = verifyQwenRealtime(
      "encrypted",
      "workspace-1",
      "Tina",
      base,
    );
    emit(f.sockets[0], { type: "session.created" });
    emit(f.sockets[0], {
      type: "session.updated",
      session: { id: "s", voice: "other" },
    });
    await expect(verification).rejects.toMatchObject({
      response: { error: { message: expect.stringContaining("与配置不一致") } },
    });
    expect(
      qwenErrorMessage("AllocationQuota.FreeTierOnly", "sk-secret"),
    ).toContain("免费额度");
    expect(qwenErrorMessage(401, "Bearer sk-secret")).not.toContain("secret");
  });
  it("maps transcription, audio and captions while discarding interrupted reply and tool results", () => {
    const send = vi.fn(),
      protocol = new QwenRealtimeProtocol(send);
    expect(
      protocol.events({
        type: "input_audio_buffer.speech_started",
        item_id: "q1",
      })[0].type,
    ).toBe("conversation.item.input_audio_transcription.started");
    protocol.events({ type: "response.created", response: { id: "r1" } });
    expect(
      protocol.events({
        type: "response.audio.delta",
        response_id: "r1",
        delta: "pcm",
      })[0],
    ).toMatchObject({
      type: "response.output_audio.delta",
      question_id: "q1",
      delta: "pcm",
    });
    protocol.events({
      type: "input_audio_buffer.speech_started",
      item_id: "q2",
    });
    expect(send).toHaveBeenCalledWith({ type: "response.cancel" });
    expect(
      protocol.events({
        type: "response.audio.delta",
        response_id: "r1",
        delta: "old",
      }),
    ).toEqual([]);
    protocol.toolResults("r1", [{ call_id: "old", output: "stale" }]);
    expect(send).toHaveBeenCalledTimes(1);
    protocol.events({ type: "response.created", response: { id: "r2" } });
    expect(
      protocol.events({
        type: "response.audio_transcript.done",
        response_id: "r2",
        transcript: "你好",
      })[0],
    ).toMatchObject({
      type: "response.output_text.done",
      question_id: "q2",
      transcript: "你好",
    });
  });
  it("waits for all tool arguments and response completion then returns individual tool outputs before resuming", () => {
    const send = vi.fn(),
      protocol = new QwenRealtimeProtocol(send);
    protocol.events({ type: "response.created", response: { id: "r" } });
    const call = {
      type: "response.function_call_arguments.done",
      response_id: "r",
      call_id: "call1",
      name: "workspace_request",
      arguments: '{"request":"打开经营分析"}',
    };
    expect(protocol.events(call)).toEqual([]);
    protocol.events(call);
    protocol.events({ ...call, call_id: "call2" });
    const completion = protocol.events({
      type: "response.done",
      response: { id: "r", status: "completed" },
    });
    expect(completion[0]).toMatchObject({
      type: "response.function_call_arguments.done",
      items: [call, { ...call, call_id: "call2" }],
    });
    expect(
      completion.some((e) => e.type === "response.output_audio.done"),
    ).toBe(false);
    protocol.toolResults("r", [
      { call_id: "call1", output: "done" },
      { call_id: "call2", output: "done2" },
    ]);
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call1",
          output: "done",
        },
      },
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call2",
          output: "done2",
        },
      },
      { type: "response.create" },
    ]);
  });
  it("clears muted input and ignores empty/duplicate commits and idle cancellation", () => {
    const send = vi.fn(),
      protocol = new QwenRealtimeProtocol(send);
    protocol.command({ type: "response.cancel" });
    protocol.command({ type: "input_audio_buffer.commit" });
    expect(send).not.toHaveBeenCalled();
    protocol.command({ type: "input_audio_mute.commit" });
    protocol.command({ type: "input_audio_buffer.append", audio: "discard" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ type: "input_audio_buffer.clear" });
    protocol.command({ type: "input_audio_unmute.commit" });
    for (let i = 0; i < 5; i++)
      protocol.command({ type: "input_audio_buffer.append", audio: "pcm" });
    protocol.command({ type: "input_audio_buffer.commit" });
    protocol.command({ type: "input_audio_buffer.commit" });
    expect(
      send.mock.calls.filter((c) => c[0].type === "input_audio_buffer.commit"),
    ).toHaveLength(1);
    protocol.events({ type: "input_audio_buffer.committed", item_id: "q" });
    expect(send).toHaveBeenLastCalledWith(
      { type: "response.create" },
      expect.any(Function),
    );
  });
  it("coalesces five browser frames into exactly 100 ms of identical PCM", () => {
    const send = vi.fn(),
      protocol = new QwenRealtimeProtocol(send);
    const pcm = Array.from({ length: 5 }, (_, i) => Buffer.alloc(640, i + 1));
    pcm.slice(0, 4).forEach((frame) =>
      protocol.command({
        type: "input_audio_buffer.append",
        audio: frame.toString("base64"),
      }),
    );
    expect(send).not.toHaveBeenCalled();
    protocol.command({
      type: "input_audio_buffer.append",
      audio: pcm[4].toString("base64"),
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(Buffer.from(send.mock.calls[0][0].audio, "base64")).toEqual(
      Buffer.concat(pcm),
    );
    expect(Buffer.from(send.mock.calls[0][0].audio, "base64")).toHaveLength(
      3200,
    );
  });
  it("flushes a short final chunk by 100 ms without repeating it", () => {
    let now = 0;
    const send = vi.fn(),
      protocol = new QwenRealtimeProtocol(send, () => now);
    const audio = Buffer.alloc(640, 7).toString("base64");
    protocol.command({ type: "input_audio_buffer.append", audio });
    now = 99;
    protocol.drainAudio();
    expect(send).not.toHaveBeenCalled();
    now = 100;
    protocol.drainAudio();
    protocol.drainAudio();
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: "input_audio_buffer.append",
      audio,
    });
  });
  it.each(["commit", "mute", "cancel", "tool"])(
    "flushes partial PCM before %s in the original event order",
    (control) => {
      const send = vi.fn(),
        protocol = new QwenRealtimeProtocol(send);
      protocol.events({ type: "response.created", response: { id: "r1" } });
      const audio = Buffer.alloc(640, 4).toString("base64");
      for (let i = 0; i < 5; i++)
        protocol.command({ type: "input_audio_buffer.append", audio });
      send.mockClear();
      protocol.command({ type: "input_audio_buffer.append", audio });
      if (control === "tool")
        protocol.toolResults("r1", [{ call_id: "call", output: "done" }]);
      else
        protocol.command({
          type:
            control === "commit"
              ? "input_audio_buffer.commit"
              : control === "mute"
                ? "input_audio_mute.commit"
                : "response.cancel",
        });
      expect(send.mock.calls[0][0]).toEqual({
        type: "input_audio_buffer.append",
        audio,
      });
      expect(send.mock.calls[1][0].type).toBe(
        control === "commit"
          ? "input_audio_buffer.commit"
          : control === "mute"
            ? "input_audio_buffer.clear"
            : control === "cancel"
              ? "response.cancel"
              : "conversation.item.create",
      );
    },
  );
  it("discards partial PCM on close and never sends it through a later timer", () => {
    let now = 0;
    const send = vi.fn(),
      protocol = new QwenRealtimeProtocol(send, () => now);
    protocol.command({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(640).toString("base64"),
    });
    protocol.close();
    now = 200;
    protocol.drainAudio();
    protocol.command({ type: "input_audio_mute.commit" });
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["speech", "cancel"])(
    "invalidates queued tool continuations on %s, even after response.done",
    (interrupt) => {
      const send = vi.fn(),
        protocol = new QwenRealtimeProtocol(send);
      protocol.events({ type: "response.created", response: { id: "r1" } });
      protocol.events({
        type: "response.done",
        response: { id: "r1", status: "completed" },
      });
      protocol.toolResults("r1", [{ call_id: "call", output: "done" }]);
      const pending = send.mock.calls.map((call) => call[1] as () => boolean);
      expect(pending).toHaveLength(2);
      expect(pending.every((valid) => valid())).toBe(true);
      if (interrupt === "speech")
        protocol.events({
          type: "input_audio_buffer.speech_started",
          item_id: "q2",
        });
      else protocol.command({ type: "response.cancel" });
      expect(pending.every((valid) => !valid())).toBe(true);
    },
  );
  it("does not resume a canceled tool response when its business result arrives later", () => {
    const send = vi.fn(),
      protocol = new QwenRealtimeProtocol(send);
    protocol.events({ type: "response.created", response: { id: "r1" } });
    protocol.events({
      type: "response.done",
      response: { id: "r1", status: "completed" },
    });
    protocol.command({ type: "response.cancel" });
    protocol.toolResults("r1", [{ call_id: "call", output: "late result" }]);
    expect(send).not.toHaveBeenCalled();
  });
  it("keeps a queued tool reply valid when only the microphone is muted", () => {
    const send = vi.fn(),
      protocol = new QwenRealtimeProtocol(send);
    protocol.events({ type: "response.created", response: { id: "r1" } });
    protocol.events({
      type: "response.done",
      response: { id: "r1", status: "completed" },
    });
    protocol.toolResults("r1", [{ call_id: "call", output: "done" }]);
    const pending = send.mock.calls.map((call) => call[1] as () => boolean);
    protocol.command({ type: "input_audio_mute.commit" });
    expect(pending.every((valid) => valid())).toBe(true);
    protocol.command({ type: "input_audio_unmute.commit" });
    expect(pending.every((valid) => valid())).toBe(true);
  });
  it.each(["speech", "cancel", "mute", "response"])(
    "invalidates a queued manual response.create on %s",
    (interrupt) => {
      const send = vi.fn(),
        protocol = new QwenRealtimeProtocol(send);
      for (let i = 0; i < 5; i++)
        protocol.command({ type: "input_audio_buffer.append", audio: "pcm" });
      protocol.command({ type: "input_audio_buffer.commit" });
      protocol.events({ type: "input_audio_buffer.committed", item_id: "q1" });
      const valid = send.mock.calls.at(-1)![1] as () => boolean;
      expect(valid()).toBe(true);
      if (interrupt === "speech")
        protocol.events({
          type: "input_audio_buffer.speech_started",
          item_id: "q2",
        });
      else if (interrupt === "response")
        protocol.events({ type: "response.created", response: { id: "r2" } });
      else
        protocol.command({
          type:
            interrupt === "cancel"
              ? "response.cancel"
              : "input_audio_mute.commit",
        });
      expect(valid()).toBe(false);
    },
  );
});

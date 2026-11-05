import { beforeEach, describe, expect, it, vi } from "vitest";
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
describe("Qwen native realtime protocol", () => {
  it("pins Beijing and translates the exact audio/tool schema without allowing arbitrary hosts", () => {
    expect(qwenRealtimeEndpoint("workspace-1")).toBe(
      `wss://workspace-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=${qwenRealtimeModel}`,
    );
    for (const input of [
      "",
      "../evil",
      "https://evil.test",
      "x.evil",
      "x?model=other",
      "-bad",
    ])
      expect(() => qwenRealtimeEndpoint(input)).toThrow();
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
    expect(send).toHaveBeenLastCalledWith({ type: "response.create" });
  });
});

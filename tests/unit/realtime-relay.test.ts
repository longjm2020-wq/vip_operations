vi.mock("../../apps/api/src/ai-metering.js", () => ({ aiFetch: (_feature: string, url: string | URL, options: RequestInit) => fetch(url, options), recordAiReceipt: async () => {} }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { once, EventEmitter } from "node:events";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";

type MockUpstream = EventEmitter & {
  readyState: number;
  bufferedAmount: number;
  sent: Record<string, unknown>[];
  send: (s: string, callback?: (error?: Error) => void) => void;
  close: () => void;
  terminate: () => void;
};
const f = vi.hoisted(() => ({
  sockets: [] as MockUpstream[],
  claim: vi.fn(),
  activate: vi.fn(),
  check: vi.fn(),
  close: vi.fn(),
  tool: vi.fn(),
  actor: vi.fn(),
  provider: vi.fn(),
}));
vi.mock("../../apps/api/src/modules/auth/service.js", () => ({
  actorForSessionHash: f.actor,
}));
vi.mock("../../apps/api/src/modules/workspace/assistant-memory.js", () => ({
  requireAssistant: (c: { actor: { permissions: string[] } }) => {
    if (!c.actor.permissions.includes("analytics.read"))
      throw Error("forbidden");
  },
}));
vi.mock("../../apps/api/src/modules/workspace/assistant-realtime.js", () => ({
  claimRealtimeSocket: f.claim,
  activateRealtimeSocket: f.activate,
  checkRealtime: f.check,
  closeRealtime: f.close,
  runRealtimeTool: f.tool,
  realtimeConfiguration: (_voice: string, desktopEnabled = false) => ({
    instructions: "server-owned",
    tools: [
      { name: "workspace_request" },
      ...(desktopEnabled ? [{ name: "desktop_request" }] : []),
    ],
  }),
}));
vi.mock(
  "../../apps/api/src/modules/workspace/doubao-realtime.js",
  async (original) => ({
    ...(await original<
      typeof import("../../apps/api/src/modules/workspace/doubao-realtime.js")
    >()),
    doubaoProviderSocket: f.provider,
  }),
);
vi.mock(
  "../../apps/api/src/modules/workspace/qwen-realtime.js",
  async (original) => ({
    ...(await original<
      typeof import("../../apps/api/src/modules/workspace/qwen-realtime.js")
    >()),
    qwenProviderSocket: f.provider,
  }),
);
import {
  allowedRealtimeClientEvent,
  attachRealtimeRelay,
  publicRealtimeEvent,
  RealtimeFrameBudget,
  RealtimeUpstreamBuffer,
} from "../../apps/api/src/modules/workspace/realtime-relay.js";
import { doubaoConfiguration } from "../../apps/api/src/modules/workspace/doubao-realtime.js";

describe("realtime network jitter allowance", () => {
  it("accepts normal PCM cadence and coalesced packets but rejects sustained flooding", () => {
    let now = 0;
    const budget = new RealtimeFrameBudget(() => now);
    for (let second = 0; second < 30; second++) {
      now += 1000;
      for (let frame = 0; frame < 50; frame++) expect(budget.take()).toBe(true);
    }
    now += 2400;
    for (let frame = 0; frame < 120; frame++) expect(budget.take()).toBe(true);
    for (let frame = 0; frame < 30; frame++) expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    now += 1000;
    for (let frame = 0; frame < 60; frame++) expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
  });
  it("retains audio, mute and tool results in order through a brief provider stall", () => {
    let now = 0,
      buffered = 300 * 1024;
    const writes: Record<string, unknown>[] = [];
    const failed = vi.fn();
    const queue = new RealtimeUpstreamBuffer(
      () => buffered,
      (p) => writes.push(JSON.parse(p)),
      failed,
      () => now,
    );
    const events = [
      { type: "input_audio_buffer.append", audio: "first" },
      { type: "input_audio_buffer.append", audio: "second" },
      { type: "input_audio_buffer.clear" },
      { type: "conversation.item.create", item: { output: "result" } },
    ];
    events.forEach((e) => queue.send(e));
    now = 800;
    queue.flush();
    expect(writes).toEqual([]);
    expect(failed).not.toHaveBeenCalled();
    buffered = 0;
    queue.flush();
    expect(writes).toEqual(events.slice(0, 2));
    now += 20;
    queue.flush();
    expect(writes).toEqual(events);
    queue.flush();
    expect(writes).toEqual(events);
  });
  it("stops once after two seconds of retained speech and never replays it later", () => {
    let now = 0,
      buffered = 300 * 1024;
    const write = vi.fn(),
      failed = vi.fn();
    const queue = new RealtimeUpstreamBuffer(
      () => buffered,
      write,
      failed,
      () => now,
    );
    queue.send({ type: "input_audio_buffer.append", audio: "private-speech" });
    now = 1999;
    queue.flush();
    expect(failed).not.toHaveBeenCalled();
    now = 2000;
    queue.flush();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith({
      bufferedBytes: buffered,
      queuedBytes: expect.any(Number),
      queuedMessages: 1,
      waitMs: 2000,
    });
    expect(JSON.stringify(failed.mock.calls)).not.toContain("private-speech");
    buffered = 0;
    queue.flush();
    queue.send({ type: "input_audio_buffer.commit" });
    expect(write).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
  });
  it("caps both queued audio duration and total bytes, including tool results", () => {
    const failed = vi.fn(),
      write = vi.fn();
    const queue = new RealtimeUpstreamBuffer(() => 300 * 1024, write, failed);
    for (let i = 0; i < 100; i++)
      queue.send({
        type: "input_audio_buffer.append",
        audio: Buffer.alloc(640).toString("base64"),
      });
    expect(failed).not.toHaveBeenCalled();
    queue.send({ type: "input_audio_buffer.commit" });
    expect(failed).toHaveBeenCalledTimes(1);
    const oversized = new RealtimeUpstreamBuffer(
      () => 300 * 1024,
      write,
      failed,
    );
    oversized.send({
      type: "conversation.item.create",
      output: "x".repeat(128 * 1024),
    });
    expect(failed).toHaveBeenCalledTimes(2);
    const fullSocket = new RealtimeUpstreamBuffer(
      () => 513 * 1024,
      write,
      failed,
    );
    fullSocket.send({ type: "input_audio_buffer.commit" });
    expect(failed).toHaveBeenCalledTimes(3);
    expect(write).not.toHaveBeenCalled();
  });
  it("abandons queued input immediately when a session closes", () => {
    let buffered = 300 * 1024;
    const write = vi.fn(),
      failed = vi.fn();
    const queue = new RealtimeUpstreamBuffer(() => buffered, write, failed);
    queue.send({ type: "input_audio_buffer.append", audio: "pending" });
    queue.close();
    buffered = 0;
    queue.flush();
    expect(write).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
  it("prunes invalidated continuations before timeout while preserving fresh audio FIFO", () => {
    let now = 0,
      buffered = 300 * 1024,
      current = true;
    const writes: Record<string, unknown>[] = [],
      failed = vi.fn();
    const queue = new RealtimeUpstreamBuffer(
      () => buffered,
      (p) => writes.push(JSON.parse(p)),
      failed,
      () => now,
    );
    queue.send(
      { type: "conversation.item.create", output: "old tool" },
      () => current,
    );
    queue.send({ type: "response.create" }, () => current);
    now = 1900;
    queue.send({
      type: "input_audio_buffer.append",
      audio: "new speech first",
    });
    queue.send({
      type: "input_audio_buffer.append",
      audio: "new speech second",
    });
    current = false;
    now = 2100;
    buffered = 0;
    queue.flush();
    expect(failed).not.toHaveBeenCalled();
    expect(writes).toEqual([
      { type: "input_audio_buffer.append", audio: "new speech first" },
      { type: "input_audio_buffer.append", audio: "new speech second" },
    ]);
  });
});

let server: Server, detach: () => void, base: string;
const clients: WebSocket[] = [];
const authHash = createHash("sha256").update("test-cookie").digest("hex");
beforeEach(async () => {
  vi.stubEnv("APP_ORIGIN", "https://workspace.test");
  f.sockets.length = 0;
  f.actor.mockReset().mockImplementation(async (hash: string) => {
    if (hash !== authHash) throw Error("unauthenticated");
    return { id: "7", permissions: ["analytics.read"] };
  });
  f.claim.mockReset().mockResolvedValue({
    key: "encrypted-server-only",
    voice: "zh_female_vv_uranus_bigtts",
  });
  f.activate
    .mockReset()
    .mockResolvedValue(new Date(Date.now() + 3600000).toISOString());
  f.check.mockReset().mockResolvedValue({ active: true });
  f.close.mockReset().mockResolvedValue({ closed: true });
  f.tool
    .mockReset()
    .mockResolvedValue({ text: "已打开经营分析", navigation: "analytics" });
  f.provider.mockReset().mockImplementation(() => {
    const s = new EventEmitter() as MockUpstream;
    s.readyState = WebSocket.CONNECTING;
    s.bufferedAmount = 0;
    s.sent = [];
    s.send = (text: string, callback?: (error?: Error) => void) => {
      const event = JSON.parse(text);
      s.sent.push(event);
      queueMicrotask(() => callback?.());
      if (event.type === "session.close")
        queueMicrotask(() =>
          s.emit("message", Buffer.from('{"type":"session.closed"}'), false),
        );
    };
    s.close = () => {
      s.readyState = WebSocket.CLOSED;
      s.emit("close");
    };
    s.terminate = s.close;
    f.sockets.push(s);
    queueMicrotask(() => {
      s.readyState = WebSocket.OPEN;
      s.emit("open");
    });
    return s;
  });
  server = createServer();
  detach = attachRealtimeRelay(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/my-workspace/assistant/realtime/sessions/${randomUUID()}/socket`;
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  detach();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});
async function client(headers: Record<string, string> = {}) {
  const socket = new WebSocket(base, {
    headers: {
      Origin: "https://workspace.test",
      Cookie: "session=test-cookie",
      ...headers,
    },
  });
  clients.push(socket);
  await once(socket, "open");
  const events: Record<string, unknown>[] = [];
  socket.on("message", (d) => events.push(JSON.parse(d.toString())));
  return { socket, events };
}
async function ready(provider = "doubao") {
  if (provider === "qwen")
    f.claim.mockResolvedValue({
      provider,
      key: "encrypted-server-only",
      workspaceId: "workspace-1",
      voice: "Tina",
    });
  const connection = await client();
  connection.socket.send(
    JSON.stringify({ type: "authenticate", ticket: "a".repeat(43) }),
  );
  await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
  const upstream = f.sockets[0];
  upstream.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "session.created",
        session: { id: "provider-private-id" },
      }),
    ),
    false,
  );
  if (provider === "qwen")
    upstream.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "session.updated",
          session: { id: "provider-private-id", voice: "Tina" },
        }),
      ),
      false,
    );
  await vi.waitFor(() =>
    expect(connection.events.some((e) => e.type === "xuti.ready")).toBe(true),
  );
  return { ...connection, upstream };
}

describe("full-duplex relay", () => {
  it("does not execute an interrupted Qwen tool while its permission refresh is pending", async () => {
    const { upstream } = await ready("qwen");
    const emit = (event: unknown) =>
      upstream.emit("message", Buffer.from(JSON.stringify(event)), false);
    emit({ type: "input_audio_buffer.speech_started", item_id: "q1" });
    emit({ type: "response.created", response: { id: "r1" } });
    let resolveActor!: (actor: unknown) => void;
    f.actor.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveActor = resolve;
        }),
    );
    emit({
      type: "response.function_call_arguments.done",
      response_id: "r1",
      name: "workspace_request",
      call_id: "call",
      arguments: '{"request":"更新罗盘数据"}',
    });
    emit({
      type: "response.done",
      response: { id: "r1", status: "completed" },
    });
    await vi.waitFor(() => expect(resolveActor).toBeTypeOf("function"));
    emit({ type: "input_audio_buffer.speech_started", item_id: "q2" });
    resolveActor({ id: "7", permissions: ["analytics.read"] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(f.tool).not.toHaveBeenCalled();
    expect(
      upstream.sent.some((e) => e.type === "conversation.item.create"),
    ).toBe(false);
  });
  it("forwards validated presentation calls to the browser without running business tools", async () => {
    const { events, upstream } = await ready("qwen");
    const emit = (event: unknown) =>
      upstream.emit("message", Buffer.from(JSON.stringify(event)), false);
    emit({ type: "input_audio_buffer.speech_started", item_id: "q1" });
    emit({ type: "response.created", response: { id: "r1" } });
    emit({
      type: "response.function_call_arguments.done",
      response_id: "r1",
      name: "present_slides",
      call_id: "deck",
      arguments: JSON.stringify({ slides: [{ title: "销售额" }] }),
    });
    emit({
      type: "response.function_call_arguments.done",
      response_id: "r1",
      name: "present_slides",
      call_id: "bad",
      arguments: JSON.stringify({
        slides: [{ title: "图", visual: { type: "video", url: "https://evil.example/x.mp4" } }],
      }),
    });
    emit({
      type: "response.done",
      response: { id: "r1", status: "completed" },
    });
    await vi.waitFor(() =>
      expect(
        upstream.sent.some((e) => e.type === "conversation.item.create"),
      ).toBe(true),
    );
    expect(f.tool).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "xuti.tool_started")).toBe(false);
    const forwarded = events.filter((e) => e.type === "xuti.presentation");
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ call_id: "deck", name: "present_slides" });
    const outputs = JSON.stringify(
      upstream.sent.filter((e) => e.type === "conversation.item.create"),
    );
    expect(outputs).toContain("演示面板已打开");
    expect(outputs).toContain("视频地址不在允许范围");
  });
  it("does not resume interrupted Qwen tool replies after provider backpressure recovers", async () => {
    const { socket, events, upstream } = await ready("qwen");
    const emit = (event: unknown) =>
      upstream.emit("message", Buffer.from(JSON.stringify(event)), false);
    emit({ type: "input_audio_buffer.speech_started", item_id: "q1" });
    emit({ type: "response.created", response: { id: "r1" } });
    upstream.bufferedAmount = 300 * 1024;
    emit({
      type: "response.function_call_arguments.done",
      response_id: "r1",
      name: "workspace_request",
      call_id: "call",
      arguments: '{"request":"查询库存"}',
    });
    emit({
      type: "response.done",
      response: { id: "r1", status: "completed" },
    });
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "xuti.tool_result")).toBe(true),
    );
    emit({ type: "input_audio_buffer.speech_started", item_id: "q2" });
    const audio = Buffer.alloc(640, 3).toString("base64");
    socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
    upstream.bufferedAmount = 0;
    await vi.waitFor(() =>
      expect(
        upstream.sent.some((e) => e.type === "input_audio_buffer.append"),
      ).toBe(true),
    );
    expect(
      upstream.sent.filter((e) => e.type === "input_audio_buffer.append"),
    ).toEqual([{ type: "input_audio_buffer.append", audio }]);
    expect(
      upstream.sent.some((e) =>
        ["conversation.item.create", "response.create"].includes(
          String(e.type),
        ),
      ),
    ).toBe(false);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
  it.each(["doubao", "qwen"])(
    "recovers %s provider backpressure without dropping audio or reordering mute",
    async (provider) => {
      const { socket, events, upstream } = await ready(provider);
      const before = upstream.sent.length;
      const frames = [
        Buffer.alloc(640, 1).toString("base64"),
        Buffer.alloc(640, 2).toString("base64"),
      ];
      upstream.bufferedAmount = 300 * 1024;
      for (const audio of frames)
        socket.send(
          JSON.stringify({ type: "input_audio_buffer.append", audio }),
        );
      socket.send(JSON.stringify({ type: "input_audio_mute.commit" }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(upstream.sent).toHaveLength(before);
      expect(events.some((e) => e.type === "xuti.error")).toBe(false);
      upstream.bufferedAmount = 0;
      await vi.waitFor(() =>
        expect(upstream.sent).toHaveLength(
          before + (provider === "qwen" ? 2 : 3),
        ),
      );
      expect(upstream.sent.slice(before)).toEqual([
        ...(provider === "qwen"
          ? [
              Buffer.concat(
                frames.map((audio) => Buffer.from(audio, "base64")),
              ).toString("base64"),
            ]
          : frames
        ).map((audio) => ({
          type: "input_audio_buffer.append",
          audio,
        })),
        {
          type:
            provider === "qwen"
              ? "input_audio_buffer.clear"
              : "input_audio_mute.commit",
        },
      ]);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(f.provider).toHaveBeenCalledTimes(1);
    },
  );
  it("closes a persistently congested upstream without sending retained speech", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { socket, events, upstream } = await ready();
      upstream.bufferedAmount = 300 * 1024;
      socket.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: Buffer.alloc(640).toString("base64"),
        }),
      );
      await once(socket, "close");
      expect(events.at(-1)).toMatchObject({
        type: "xuti.error",
        message: "语音服务连接持续拥塞，本次通话已停止，请稍后重新开始",
      });
      expect(
        upstream.sent.some((e) => e.type === "input_audio_buffer.append"),
      ).toBe(false);
      expect(f.provider).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "Realtime provider write congestion",
        expect.objectContaining({
          provider: "doubao",
          bufferedBytes: 300 * 1024,
          queuedMessages: 1,
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });
  it.each(["workspace_request", "desktop_request"])(
    "adapts Qwen readiness, scoped %s execution and resumed PCM output through the authenticated relay",
    async (tool) => {
      const request =
        tool === "desktop_request" ? "点击编辑菜单" : "打开经营分析";
      f.claim.mockResolvedValue({
        provider: "qwen",
        key: "encrypted-server-only",
        workspaceId: "workspace-1",
        voice: "Tina",
        desktopEnabled: tool === "desktop_request",
      });
      const { socket, events } = await client();
      socket.send(
        JSON.stringify({ type: "authenticate", ticket: "a".repeat(43) }),
      );
      await vi.waitFor(() => expect(f.sockets).toHaveLength(1));
      const upstream = f.sockets[0];
      const emit = (e: unknown) =>
        upstream.emit("message", Buffer.from(JSON.stringify(e)), false);
      emit({ type: "session.created", session: { id: "private-session" } });
      expect(f.provider).toHaveBeenCalledWith(
        "encrypted-server-only",
        "workspace-1",
      );
      expect(f.activate).not.toHaveBeenCalled();
      expect(upstream.sent[0]).toMatchObject({
        type: "session.update",
        session: { audio: { output: { voice: "Tina" } } },
      });
      expect(JSON.stringify(upstream.sent[0])).toContain(tool);
      emit({
        type: "session.updated",
        session: {
          id: "private-session",
          audio: { output: { voice: "Tina" } },
        },
      });
      await vi.waitFor(() =>
        expect(events.some((e) => e.type === "xuti.ready")).toBe(true),
      );
      emit({ type: "input_audio_buffer.speech_started", item_id: "q" });
      emit({ type: "input_audio_buffer.committed", item_id: "q" });
      emit({ type: "response.created", response: { id: "r" } });
      emit({
        type: "response.function_call_arguments.done",
        response_id: "r",
        name: tool,
        call_id: "call",
        arguments: JSON.stringify({ request }),
      });
      expect(f.tool).not.toHaveBeenCalled();
      emit({
        type: "response.done",
        response: { id: "r", status: "completed" },
      });
      await vi.waitFor(() =>
        expect(upstream.sent.some((e) => e.type === "response.create")).toBe(
          true,
        ),
      );
      expect(f.tool).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: expect.objectContaining({ id: "7" }),
        }),
        expect.any(String),
        { callId: "call", request, tool },
      );
      expect(upstream.sent.at(-2)).toMatchObject({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: "call" },
      });
      emit({ type: "response.created", response: { id: "r2" } });
      emit({
        type: "response.audio.delta",
        response_id: "r2",
        delta: "pcm",
        private: "secret",
      });
      await vi.waitFor(() =>
        expect(
          events.some((e) => e.type === "response.output_audio.delta"),
        ).toBe(true),
      );
      expect(
        events.find((e) => e.type === "response.output_audio.delta"),
      ).toMatchObject({ question_id: "q", response_id: "r2", delta: "pcm" });
      expect(JSON.stringify(events)).not.toMatch(
        /private-session|encrypted|secret/,
      );
      emit({
        type: "error",
        error: { code: "AllocationQuota.FreeTierOnly", message: "raw-secret" },
      });
      await once(socket, "close");
      expect(String(events.at(-1)?.message)).toContain("免费额度");
      expect(f.provider).toHaveBeenCalledTimes(1);
      expect(upstream.readyState).toBe(WebSocket.CLOSED);
    },
  );
  it("rejects cross-origin and missing-cookie upgrades before opening a provider connection", async () => {
    await expect(
      client({ Origin: "https://untrusted.test" }),
    ).rejects.toThrow();
    await expect(client({ Cookie: "" })).rejects.toThrow();
    expect(f.provider).not.toHaveBeenCalled();
  });
  it("uses server-owned session config, forwards exact PCM frames and closes provider on disconnect", async () => {
    const { socket, events, upstream } = await ready();
    expect(f.claim.mock.calls[0][0].actor.id).toBe("7");
    expect(f.provider).toHaveBeenCalledWith("encrypted-server-only");
    expect(upstream.sent[0]).toEqual(
      doubaoConfiguration("zh_female_vv_uranus_bigtts", {
        instructions: "server-owned",
        tools: [{ name: "workspace_request" }],
      }),
    );
    const audio = Buffer.alloc(640).toString("base64");
    socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
    socket.send(JSON.stringify({ type: "input_audio_mute.commit" }));
    await vi.waitFor(() => expect(upstream.sent).toHaveLength(3));
    expect(upstream.sent[1]).toEqual({
      type: "input_audio_buffer.append",
      audio,
    });
    upstream.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "response.output_audio.delta",
          response_id: "r1",
          question_id: "q1",
          delta: "audio-only",
          secret_debug: "secret",
        }),
      ),
      false,
    );
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "response.output_audio.delta")).toBe(
        true,
      ),
    );
    expect(events.at(-1)).toMatchObject({
      response_id: "r1",
      question_id: "q1",
    });
    expect(JSON.stringify(events)).not.toMatch(
      /encrypted-server|provider-private|secret_debug/,
    );
    socket.close();
    await vi.waitFor(() =>
      expect(upstream.sent.at(-1)?.type).toBe("session.close"),
    );
    expect(f.close).toHaveBeenCalled();
  });
  it("rejects client prompt/tool injection and malformed audio instead of forwarding it", async () => {
    expect(
      allowedRealtimeClientEvent({
        type: "session.update",
        session: { instructions: "bad" },
      }),
    ).toBeNull();
    expect(
      allowedRealtimeClientEvent({
        type: "conversation.item.create",
        items: [],
      }),
    ).toBeNull();
    expect(
      allowedRealtimeClientEvent({ type: "response.cancel", extra: "bad" }),
    ).toBeNull();
    expect(
      allowedRealtimeClientEvent({
        type: "input_audio_buffer.append",
        audio: Buffer.alloc(642).toString("base64"),
      }),
    ).toBeNull();
    const { socket, upstream } = await ready();
    socket.send(JSON.stringify({ type: "session.update", session: {} }));
    await once(socket, "close");
    expect(upstream.sent.some((e) => e.type === "session.update")).toBe(false);
    expect(upstream.sent.at(-1)?.type).toBe("session.close");
  });
  it("runs scoped business tools on the server, aggregates their results and retains turn identity", async () => {
    const { upstream, events } = await ready();
    const event = {
      type: "response.function_call_arguments.done",
      question_id: "q2",
      response_id: "r2",
      items: [
        {
          call_id: "one",
          name: "workspace_request",
          arguments: JSON.stringify({ request: "打开经营分析" }),
        },
        {
          call_id: "two",
          name: "workspace_request",
          arguments: JSON.stringify({ request: "查询库存" }),
        },
      ],
    };
    upstream.emit("message", Buffer.from(JSON.stringify(event)), false);
    await vi.waitFor(() =>
      expect(
        upstream.sent.some((e) => e.type === "conversation.item.create"),
      ).toBe(true),
    );
    expect(f.tool).toHaveBeenCalledTimes(2);
    expect(f.tool.mock.calls[0][2]).toEqual({
      tool: "workspace_request",
      callId: "one",
      request: "打开经营分析",
    });
    const returned = upstream.sent.find(
      (e) => e.type === "conversation.item.create",
    )!;
    expect(returned.items).toHaveLength(2);
    await vi.waitFor(() =>
      expect(events.filter((e) => e.type === "xuti.tool_result")).toHaveLength(
        2,
      ),
    );
    expect(
      events.filter((e) => e.type === "xuti.tool_result").map((e) => e.call_id),
    ).toEqual(["one", "two"]);
    expect(events.find((e) => e.type === "xuti.tool_started")).toMatchObject({
      question_id: "q2",
      response_id: "r2",
    });
    expect(upstream.sent.some((e) => e.type === "response.create")).toBe(false);
    expect(
      events.some((e) => e.type === "response.function_call_arguments.done"),
    ).toBe(false);
  });
  it("never forwards provider credentials/errors/configuration, and ends on fatal error", async () => {
    expect(
      publicRealtimeEvent({
        type: "session.created",
        session: { key: "private" },
      }),
    ).toBeNull();
    const { upstream, socket, events } = await ready();
    upstream.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "error",
          status_code: 401,
          message: "secret-provider-authorization-body",
        }),
      ),
      false,
    );
    await once(socket, "close");
    expect(events.at(-1)).toMatchObject({
      type: "xuti.error",
      message: "实时语音授权失败，请检查密钥和服务权限",
    });
    expect(JSON.stringify(events)).not.toContain("secret-provider");
  });
});

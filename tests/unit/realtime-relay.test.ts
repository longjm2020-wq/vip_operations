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
  send: (s: string) => void;
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
  realtimeConfiguration: () => ({
    instructions: "server-owned",
    tools: [{ name: "workspace_request" }],
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
import {
  allowedRealtimeClientEvent,
  attachRealtimeRelay,
  publicRealtimeEvent,
} from "../../apps/api/src/modules/workspace/realtime-relay.js";
import { doubaoConfiguration } from "../../apps/api/src/modules/workspace/doubao-realtime.js";

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
    s.send = (text: string) => {
      const event = JSON.parse(text);
      s.sent.push(event);
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
async function ready() {
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
  await vi.waitFor(() =>
    expect(connection.events.some((e) => e.type === "xuti.ready")).toBe(true),
  );
  return { ...connection, upstream };
}

describe("full-duplex relay", () => {
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

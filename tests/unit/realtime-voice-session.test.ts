import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realtimeModel } from "../../packages/contracts/src/assistant-realtime.js";
const f = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../apps/web/src/api.js", () => ({ api: f.api }));
import { RealtimeVoiceSession } from "../../apps/web/src/realtime-voice-session.js";
class Channel {
  readyState = "open";
  onmessage?: (e: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  sent: Record<string, unknown>[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
  emit(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}
class Peer {
  static last: Peer;
  dc = new Channel();
  connectionState = "connected";
  onconnectionstatechange?: () => void;
  ontrack?: (e: unknown) => void;
  addTrack = vi.fn();
  close = vi.fn(() => {
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  });
  createOffer = vi.fn(async () => ({
    type: "offer",
    sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111",
  }));
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async () => {});
  constructor() {
    Peer.last = this;
  }
  createDataChannel() {
    return this.dc;
  }
}
class Player {
  autoplay = false;
  srcObject: unknown;
  pause = vi.fn();
  play = vi.fn(async () => {});
}
let track: {
  enabled: boolean;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
};
const options = { includePersonalContext: false, includeMemory: false };
const callbacks = () => ({
  state: vi.fn(),
  captions: vi.fn(),
  note: vi.fn(),
  error: vi.fn(),
  blocked: vi.fn(),
  result: vi.fn(),
  navigate: vi.fn(),
  business: vi.fn(),
});
const stream = () => ({
  getTracks: () => [track],
  getAudioTracks: () => [track],
});
const ready = () =>
  Peer.last.dc.emit({
    type: "session.created",
    session: { model: realtimeModel },
  });
let session: RealtimeVoiceSession;
beforeEach(() => {
  track = { enabled: true, stop: vi.fn(), onended: null };
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(async () => stream()) },
  });
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("Audio", Player);
  f.api.mockReset().mockImplementation(async (path: string) =>
    path.endsWith("/sessions")
      ? {
          data: {
            sdp: "v=0\r\nm=audio 9",
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        }
      : path.endsWith("/tool")
        ? { data: { text: "正在打开经营分析", navigation: "analytics" } }
        : { data: { saved: true, closed: true, active: true } },
  );
});
afterEach(() => {
  session?.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("realtime media ownership and event handling", () => {
  it("passes the selected computer at start and sends a named desktop tool only once", async () => {
    const cb = callbacks();
    session = new RealtimeVoiceSession(cb);
    const selected = {
      ...options,
      desktopDeviceId: "11111111-1111-4111-8111-111111111111",
      model: "engine/111111111111111111111111",
    };
    await session.start(selected);
    expect(f.api.mock.calls[0][2]).toMatchObject(selected);
    ready();
    const normal = f.api.getMockImplementation()!;
    f.api.mockImplementation((...args) =>
      args[0].endsWith("/tool")
        ? Promise.resolve({
            data: { text: "电脑任务已创建", desktopTaskId: "task" },
          })
        : normal(...args),
    );
    Peer.last.dc.emit({
      type: "response.created",
      response: { id: "desktop-response" },
    });
    const event = {
      type: "response.function_call_arguments.done",
      name: "desktop_request",
      call_id: "desktop-call",
      response_id: "desktop-response",
      arguments: JSON.stringify({ request: "点击编辑菜单" }),
    };
    Peer.last.dc.emit(event);
    Peer.last.dc.emit(event);
    await vi.waitFor(() => expect(cb.result).toHaveBeenCalledOnce());
    expect(
      f.api.mock.calls.find((call) => call[0].endsWith("/tool"))?.[2],
    ).toEqual({
      tool: "desktop_request",
      callId: "desktop-call",
      request: "点击编辑菜单",
    });
    expect(cb.navigate).not.toHaveBeenCalled();
    expect(JSON.stringify(Peer.last.dc.sent)).toContain("desktopTaskId");
  });
  it("does not submit a computer action whose response was interrupted before execution", async () => {
    session = new RealtimeVoiceSession(callbacks());
    await session.start(options);
    ready();
    Peer.last.dc.emit({ type: "response.created", response: { id: "old" } });
    Peer.last.dc.emit({
      type: "response.function_call_arguments.done",
      name: "desktop_request",
      call_id: "queued",
      response_id: "old",
      arguments: '{"request":"点击编辑菜单"}',
    });
    Peer.last.dc.emit({
      type: "input_audio_buffer.speech_started",
      item_id: "new",
    });
    Peer.last.dc.emit({
      type: "response.function_call_arguments.done",
      name: "desktop_request",
      call_id: "late",
      response_id: "old",
      arguments: '{"request":"点击编辑菜单"}',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      f.api.mock.calls.filter((call) => call[0].endsWith("/tool")),
    ).toHaveLength(0);
  });
  it("sends an SDP offer, keeps mic alive during speech, and supports natural interruption", async () => {
    const cb = callbacks();
    session = new RealtimeVoiceSession(cb);
    await session.start(options);
    expect(track.enabled).toBe(false);
    expect(f.api.mock.calls[0][2]).toMatchObject({
      sdp: expect.stringContaining("m=audio"),
      ...options,
    });
    expect(f.api.mock.calls[0][2]).not.toHaveProperty("audio");
    ready();
    expect(track.enabled).toBe(true);
    Peer.last.dc.emit({ type: "response.created", response: { id: "r1" } });
    Peer.last.dc.emit({ type: "output_audio_buffer.started" });
    expect(cb.state).toHaveBeenLastCalledWith("speaking");
    expect(track.enabled).toBe(true);
    Peer.last.dc.emit({
      type: "input_audio_buffer.speech_started",
      item_id: "u2",
    });
    expect(cb.state).toHaveBeenLastCalledWith("listening");
    expect(track.enabled).toBe(true);
    session.toggleMute();
    expect(track.enabled).toBe(false);
    session.toggleMute();
    expect(track.enabled).toBe(true);
    session.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(Peer.last.close).toHaveBeenCalledOnce();
  });
  it("releases a microphone that arrives after the user already ended the call", async () => {
    let resolve!: (s: MediaStream) => void;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    session = new RealtimeVoiceSession(callbacks());
    const pending = session.start(options);
    session.stop();
    resolve(stream() as unknown as MediaStream);
    await pending;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(f.api.mock.calls.some((c) => c[0].endsWith("/sessions"))).toBe(
      false,
    );
  });
  it("closes a late server session and never installs its SDP", async () => {
    let resolve!: (v: unknown) => void;
    f.api.mockImplementation(async (path: string) =>
      path.endsWith("/sessions")
        ? new Promise((r) => {
            resolve = r;
          })
        : { data: {} },
    );
    session = new RealtimeVoiceSession(callbacks());
    const pending = session.start(options);
    await vi.waitFor(() =>
      expect(f.api.mock.calls.some((c) => c[0].endsWith("/sessions"))).toBe(
        true,
      ),
    );
    session.stop();
    resolve({ data: { sdp: "late", expiresAt: new Date().toISOString() } });
    await pending;
    expect(Peer.last.setRemoteDescription).not.toHaveBeenCalled();
    expect(f.api.mock.calls.at(-1)![0]).toContain("/close");
    expect(track.stop).toHaveBeenCalledOnce();
  });
  it("does not interrupt direct audio when a caption is empty or transcription failed", async () => {
    const cb = callbacks();
    session = new RealtimeVoiceSession(cb);
    await session.start(options);
    ready();
    Peer.last.dc.emit({
      type: "conversation.item.input_audio_transcription.failed",
    });
    Peer.last.dc.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "silent",
      transcript: "",
    });
    expect(cb.error).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
    expect(cb.state).toHaveBeenLastCalledWith("listening");
  });
  it("runs a function once and waits for response.done before requesting spoken results", async () => {
    const cb = callbacks();
    session = new RealtimeVoiceSession(cb);
    await session.start(options);
    ready();
    Peer.last.dc.emit({
      type: "input_audio_buffer.speech_started",
      item_id: "u1",
    });
    Peer.last.dc.emit({ type: "input_audio_buffer.speech_stopped" });
    Peer.last.dc.emit({ type: "response.created", response: { id: "r1" } });
    const event = {
      type: "response.function_call_arguments.done",
      name: "workspace_request",
      call_id: "c1",
      response_id: "r1",
      arguments: JSON.stringify({ request: "打开经营分析" }),
    };
    Peer.last.dc.emit(event);
    Peer.last.dc.emit(event);
    await vi.waitFor(() =>
      expect(cb.navigate).toHaveBeenCalledWith("analytics"),
    );
    expect(f.api.mock.calls.filter((c) => c[0].endsWith("/tool"))).toHaveLength(
      1,
    );
    expect(Peer.last.dc.sent.some((e) => e.type === "response.create")).toBe(
      false,
    );
    Peer.last.dc.emit({
      type: "response.done",
      response: { id: "r1", status: "completed" },
    });
    expect(
      Peer.last.dc.sent.filter((e) => e.type === "response.create"),
    ).toHaveLength(1);
  });
  it("suppresses late navigation and speech after a call is closed", async () => {
    let resolve!: (v: unknown) => void;
    const normal = f.api.getMockImplementation()!;
    f.api.mockImplementation((...args) =>
      args[0].endsWith("/tool")
        ? new Promise((r) => {
            resolve = r;
          })
        : normal(...args),
    );
    const cb = callbacks();
    session = new RealtimeVoiceSession(cb);
    await session.start(options);
    ready();
    Peer.last.dc.emit({
      type: "response.function_call_arguments.done",
      name: "workspace_request",
      call_id: "c1",
      arguments: '{"request":"打开经营分析"}',
    });
    await vi.waitFor(() => expect(resolve).toBeDefined());
    session.stop();
    resolve({ data: { text: "正在打开", navigation: "analytics" } });
    await vi.waitFor(() => expect(cb.result).toHaveBeenCalled());
    expect(cb.navigate).not.toHaveBeenCalled();
    expect(Peer.last.dc.sent).toHaveLength(0);
  });
  it("stops the mic on unexpected service model or data channel failure", async () => {
    const cb = callbacks();
    session = new RealtimeVoiceSession(cb);
    await session.start(options);
    Peer.last.dc.emit({
      type: "session.created",
      session: { model: "unexpected" },
    });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(cb.error).toHaveBeenCalledWith(expect.stringContaining("不一致"));
  });
  it("expires rather than running an unbounded background microphone", async () => {
    vi.useFakeTimers();
    const cb = callbacks();
    session = new RealtimeVoiceSession(cb);
    await session.start(options);
    ready();
    await vi.advanceTimersByTimeAsync(3600001);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(cb.note).toHaveBeenLastCalledWith(
      expect.stringContaining("服务时限"),
    );
  });
  it("does not save the unheard tail when interrupted after generation finishes", async () => {
    session = new RealtimeVoiceSession(callbacks());
    await session.start(options);
    ready();
    const dc = Peer.last.dc;
    dc.emit({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    dc.emit({ type: "input_audio_buffer.speech_stopped" });
    dc.emit({ type: "response.created", response: { id: "r1" } });
    dc.emit({ type: "output_audio_buffer.started", response_id: "r1" });
    dc.emit({
      type: "response.output_audio_transcript.done",
      item_id: "a1",
      response_id: "r1",
      transcript: "这是一段还没播放完的长回复",
    });
    dc.emit({
      type: "response.done",
      response: { id: "r1", status: "completed" },
    });
    dc.emit({ type: "input_audio_buffer.speech_started", item_id: "u2" });
    dc.emit({ type: "output_audio_buffer.cleared", response_id: "r1" });
    await Promise.resolve();
    expect(
      f.api.mock.calls.filter((c) => c[0].endsWith("/captions")),
    ).toHaveLength(0);
    expect(track.enabled).toBe(true);
  });
  it("saves finished captions in batches within the browser keepalive size budget", async () => {
    session = new RealtimeVoiceSession(callbacks());
    await session.start(options);
    ready();
    const dc = Peer.last.dc;
    dc.emit({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    dc.emit({ type: "input_audio_buffer.speech_stopped" });
    dc.emit({ type: "response.created", response: { id: "r1" } });
    dc.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "中".repeat(12000),
    });
    dc.emit({
      type: "response.output_audio_transcript.done",
      item_id: "a1",
      response_id: "r1",
      transcript: "文".repeat(12000),
    });
    dc.emit({
      type: "response.done",
      response: { id: "r1", status: "completed" },
    });
    await vi.waitFor(() =>
      expect(
        f.api.mock.calls.filter((c) => c[0].endsWith("/captions")),
      ).toHaveLength(2),
    );
    for (const call of f.api.mock.calls.filter((c) =>
      c[0].endsWith("/captions"),
    )) {
      expect(
        new TextEncoder().encode(JSON.stringify(call[2])).length,
      ).toBeLessThan(48000);
    }
  });
});

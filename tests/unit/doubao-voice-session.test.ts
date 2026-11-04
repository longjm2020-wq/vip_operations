import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const f = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../apps/web/src/api.js", () => ({ api: f.api }));
import { DoubaoVoiceSession } from "../../apps/web/src/doubao-voice-session.js";

class Socket {
  static OPEN = 1;
  static last: Socket;
  readyState = 0;
  bufferedAmount = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  sent: Record<string, unknown>[] = [];
  constructor(readonly url: URL) {
    Socket.last = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}
class Node {
  connect = vi.fn();
  disconnect = vi.fn();
}
class Output extends Node {
  buffer?: { duration: number };
  onended?: (() => void) | null;
  start = vi.fn();
  stop = vi.fn();
  finish() {
    this.onended?.();
  }
}
class Context {
  static last: Context;
  currentTime = 0;
  state = "running";
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  outputs: Output[] = [];
  constructor() {
    Context.last = this;
  }
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createGain() {
    return Object.assign(new Node(), { gain: { value: 1 } });
  }
  createMediaStreamSource() {
    return new Node();
  }
  createBuffer(_channels: number, samples: number, rate: number) {
    return {
      duration: samples / rate,
      getChannelData: () => new Float32Array(samples),
    };
  }
  createBufferSource() {
    const source = new Output();
    this.outputs.push(source);
    return source;
  }
}
class Capture extends Node {
  static last: Capture;
  port = {
    postMessage: vi.fn(),
    close: vi.fn(),
    onmessage: null as ((event: { data: ArrayBuffer }) => void) | null,
  };
  constructor() {
    super();
    Capture.last = this;
  }
  frame() {
    this.port.onmessage?.({ data: new ArrayBuffer(640) });
  }
}
let track: {
  enabled: boolean;
  onended: (() => void) | null;
  stop: ReturnType<typeof vi.fn>;
};
let session: DoubaoVoiceSession;
const stream = () => ({
  getTracks: () => [track],
  getAudioTracks: () => [track],
});
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
const options = { includePersonalContext: false, includeMemory: false };
const ready = () => {
  Socket.last.open();
  Socket.last.emit({
    type: "xuti.ready",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
};
beforeEach(() => {
  vi.useFakeTimers();
  track = { enabled: true, onended: null, stop: vi.fn() };
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(async () => stream()) },
  });
  vi.stubGlobal("window", {
    location: { href: "https://example.test/my-workspace" },
  });
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Capture);
  vi.stubGlobal("WebSocket", Socket);
  f.api.mockReset().mockImplementation(async (path: string) => ({
    data: path.endsWith("/sessions")
      ? {
          transport: "websocket",
          ticket: "one-use-ticket",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }
      : { active: true, saved: true },
  }));
});
afterEach(() => {
  session?.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("full duplex PCM session", () => {
  it("authenticates without URL secrets and sends paced audio only after ready", async () => {
    const cb = callbacks();
    session = new DoubaoVoiceSession(cb);
    await session.start(options);
    expect(Socket.last.url.toString()).toMatch(
      /^wss:\/\/example.test\/api\/v1\/my-workspace\/assistant\/realtime\/sessions\/.+\/socket$/,
    );
    expect(Socket.last.url.search).toBe("");
    Capture.last.frame();
    expect(track.enabled).toBe(false);
    ready();
    expect(Socket.last.sent[0]).toEqual({
      type: "authenticate",
      ticket: "one-use-ticket",
    });
    expect(track.enabled).toBe(true);
    Capture.last.frame();
    Capture.last.frame();
    Capture.last.frame();
    expect(
      Socket.last.sent.filter(
        (event) => event.type === "input_audio_buffer.append",
      ),
    ).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(
      Socket.last.sent.filter(
        (event) => event.type === "input_audio_buffer.append",
      ),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40);
    const frames = Socket.last.sent.filter(
      (event) => event.type === "input_audio_buffer.append",
    );
    expect(frames).toHaveLength(3);
    expect(Buffer.from(String(frames[0].audio), "base64")).toHaveLength(640);
    session.toggleMute();
    expect(track.enabled).toBe(false);
    expect(Socket.last.sent.at(-1)?.type).toBe("input_audio_mute.commit");
    Capture.last.frame();
    session.toggleMute();
    expect(Socket.last.sent.at(-1)?.type).toBe("input_audio_unmute.commit");
    expect(track.enabled).toBe(true);
    session.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(Context.last.close).toHaveBeenCalledOnce();
    expect(Capture.last.port.close).toHaveBeenCalledOnce();
    expect(Socket.last.close).toHaveBeenCalledOnce();
  });

  it("keeps microphone live during speech, clears playback on barge in and ignores old response frames", async () => {
    const cb = callbacks();
    session = new DoubaoVoiceSession(cb);
    await session.start(options);
    ready();
    Socket.last.emit({
      type: "response.output_audio.started",
      question_id: "q0",
      response_id: "r0",
    });
    Socket.last.emit({
      type: "response.output_audio.delta",
      question_id: "q0",
      response_id: "r0",
      delta: Buffer.alloc(480).toString("base64"),
    });
    expect(cb.state).toHaveBeenLastCalledWith("speaking");
    expect(track.enabled).toBe(true);
    const output = Context.last.outputs[0];
    Socket.last.emit({
      type: "conversation.item.input_audio_transcription.started",
      item_id: "user1",
    });
    expect(output.stop).toHaveBeenCalledOnce();
    expect(cb.state).toHaveBeenLastCalledWith("listening");
    expect(track.enabled).toBe(true);
    Socket.last.emit({
      type: "response.output_audio.delta",
      question_id: "q0",
      response_id: "r0",
      delta: Buffer.alloc(480).toString("base64"),
    });
    expect(Context.last.outputs).toHaveLength(1);
    Socket.last.emit({
      type: "conversation.item.input_audio_transcription.failed",
    });
    expect(cb.error).not.toHaveBeenCalled();
    expect(cb.state).toHaveBeenLastCalledWith("listening");
  });

  it("ignores a delayed first response whose question matches an earlier input item", async () => {
    const cb = callbacks();
    session = new DoubaoVoiceSession(cb);
    await session.start(options);
    ready();
    Socket.last.emit({
      type: "conversation.item.input_audio_transcription.started",
      item_id: "older-question",
    });
    Socket.last.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "older-question",
      transcript: "先说一句",
    });
    Socket.last.emit({
      type: "conversation.item.input_audio_transcription.started",
      item_id: "current-question",
    });
    Socket.last.emit({
      type: "response.output_audio.started",
      question_id: "older-question",
      response_id: "late-first-response",
    });
    Socket.last.emit({
      type: "response.output_audio.delta",
      question_id: "older-question",
      response_id: "late-first-response",
      delta: Buffer.alloc(480).toString("base64"),
    });
    expect(Context.last.outputs).toHaveLength(0);
    expect(cb.state).toHaveBeenLastCalledWith("listening");
  });

  it("uses final captions, saves ordinary dialogue and delegates business results without executing them twice", async () => {
    const cb = callbacks();
    session = new DoubaoVoiceSession(cb);
    await session.start(options);
    ready();
    Socket.last.emit({
      type: "conversation.item.input_audio_transcription.started",
      item_id: "u1",
    });
    Socket.last.emit({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "u1",
      delta: "你好",
    });
    Socket.last.emit({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "u1",
      delta: "你好呀",
    });
    Socket.last.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "你好呀。",
    });
    Socket.last.emit({
      type: "response.output_text.delta",
      question_id: "q1",
      response_id: "r1",
      delta: "我在",
    });
    Socket.last.emit({
      type: "response.output_text.done",
      question_id: "q1",
      response_id: "r1",
      text: "我在。",
    });
    Socket.last.emit({ type: "response.done" });
    Socket.last.emit({
      type: "response.output_audio.done",
      question_id: "q1",
      response_id: "r1",
    });
    await Promise.resolve();
    expect(
      f.api.mock.calls.find((call) => call[0].endsWith("/captions"))?.[2],
    ).toMatchObject({
      messages: [
        { role: "user", text: "你好呀。" },
        { role: "assistant", text: "我在。" },
      ],
    });
    Socket.last.emit({
      type: "conversation.item.input_audio_transcription.started",
      item_id: "u2",
    });
    Socket.last.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u2",
      transcript: "打开经营分析",
    });
    Socket.last.emit({ type: "xuti.tool_started" });
    Socket.last.emit({
      type: "xuti.tool_result",
      result: { text: "正在打开", navigation: "analytics" },
    });
    Socket.last.emit({ type: "response.output_text.done", text: "已打开。" });
    Socket.last.emit({ type: "response.done" });
    Socket.last.emit({ type: "response.output_audio.done" });
    expect(cb.navigate).toHaveBeenCalledWith("analytics");
    expect(f.api.mock.calls.some((call) => call[0].endsWith("/tool"))).toBe(
      false,
    );
    expect(
      f.api.mock.calls.filter((call) => call[0].endsWith("/captions")),
    ).toHaveLength(1);
  });

  it("releases a late microphone and never registers a stopped call", async () => {
    let resolve!: (value: MediaStream) => void;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    session = new DoubaoVoiceSession(callbacks());
    const pending = session.start(options);
    await Promise.resolve();
    session.stop();
    resolve(stream() as unknown as MediaStream);
    await pending;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(f.api.mock.calls.some((call) => call[0].endsWith("/sessions"))).toBe(
      false,
    );
  });

  it("deduplicates repeated tool notifications by call ID with message ID fallback", async () => {
    const cb = callbacks();
    session = new DoubaoVoiceSession(cb);
    await session.start(options);
    ready();
    const first = {
      type: "xuti.tool_result",
      call_id: "call-1",
      result: {
        text: "已打开",
        messageId: "message-1",
        navigation: "analytics",
      },
    };
    Socket.last.emit(first);
    Socket.last.emit(first);
    expect(cb.navigate).toHaveBeenCalledTimes(1);
    expect(cb.result).toHaveBeenCalledTimes(1);
    expect(cb.business).toHaveBeenCalledTimes(1);
    const fallback = {
      type: "xuti.tool_result",
      result: {
        text: "已打开",
        messageId: "message-2",
        navigation: "inventory",
      },
    };
    Socket.last.emit(fallback);
    Socket.last.emit(fallback);
    expect(cb.navigate).toHaveBeenCalledTimes(2);
    expect(cb.result).toHaveBeenCalledTimes(2);
    expect(cb.business).toHaveBeenCalledTimes(2);
  });

  it("does not let delayed cancellation or completion stop a newer reply", async () => {
    const cb = callbacks();
    session = new DoubaoVoiceSession(cb);
    await session.start(options);
    ready();
    Socket.last.emit({
      type: "response.output_audio.started",
      question_id: "q0",
      response_id: "r0",
    });
    Socket.last.emit({
      type: "response.output_audio.delta",
      question_id: "q0",
      response_id: "r0",
      delta: Buffer.alloc(480).toString("base64"),
    });
    session.interrupt();
    Socket.last.emit({
      type: "conversation.item.input_audio_transcription.started",
      item_id: "u1",
    });
    Socket.last.emit({
      type: "response.output_audio.started",
      question_id: "q1",
      response_id: "r1",
    });
    Socket.last.emit({
      type: "response.output_audio.delta",
      question_id: "q1",
      response_id: "r1",
      delta: Buffer.alloc(480).toString("base64"),
    });
    const newest = Context.last.outputs.at(-1)!;
    Socket.last.emit({
      type: "response.canceled",
      question_id: "q0",
      response_id: "r0",
    });
    Socket.last.emit({ type: "response.canceled" });
    Socket.last.emit({ type: "response.done" });
    expect(newest.stop).not.toHaveBeenCalled();
    expect(cb.state).toHaveBeenLastCalledWith("speaking");
    expect(track.enabled).toBe(true);
  });

  it("uses the active call expiry from ready rather than the one-minute ticket expiry", async () => {
    const cb = callbacks();
    session = new DoubaoVoiceSession(cb);
    await session.start(options);
    ready();
    await vi.advanceTimersByTimeAsync(61000);
    expect(track.stop).not.toHaveBeenCalled();
    expect(cb.error).not.toHaveBeenCalled();
  });
});

describe("PCM worklet resampling", () => {
  it.each([16000, 44100, 48000])(
    "produces exactly 20 ms little-endian frames at input rate %s",
    (sampleRate) => {
      const frames: ArrayBuffer[] = [];
      let Processor: new () => {
        port: { onmessage: (event: object) => void };
        process: (inputs: Float32Array[][]) => boolean;
      };
      class Base {
        port = {
          onmessage: () => {},
          postMessage: (frame: ArrayBuffer) => frames.push(frame),
        };
      }
      vm.runInNewContext(
        readFileSync(
          new URL(
            "../../apps/web/public/realtime-pcm-capture.js",
            import.meta.url,
          ),
          "utf8",
        ),
        {
          AudioWorkletProcessor: Base,
          sampleRate,
          registerProcessor: (_name: string, value: typeof Processor) => {
            Processor = value;
          },
          ArrayBuffer,
          DataView,
          Math,
        },
      );
      const processor = new Processor!();
      processor.port.onmessage({ data: { active: true } });
      let remaining = sampleRate / 5;
      while (remaining) {
        const count = Math.min(128, remaining);
        processor.process([[new Float32Array(count).fill(0.5)]]);
        remaining -= count;
      }
      expect(frames).toHaveLength(10);
      expect(frames.every((frame) => frame.byteLength === 640)).toBe(true);
      expect(new DataView(frames[0]).getInt16(0, true)).toBe(16384);
      processor.port.onmessage({ data: { active: false } });
      processor.process([[new Float32Array(sampleRate)]]);
      expect(frames).toHaveLength(10);
    },
  );
});

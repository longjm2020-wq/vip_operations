import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qwenRealtimeModel } from "../../packages/contracts/src/assistant-realtime.js";
const f = vi.hoisted(() => ({
  api: vi.fn(),
  pageCreated: vi.fn(),
  observe: vi.fn(),
  action: vi.fn(),
  closePage: vi.fn(),
}));
vi.mock("../../apps/web/src/api.js", () => ({ api: f.api }));
vi.mock("../../apps/web/src/realtime-page-controller.js", () => ({
  RealtimePageController: class {
    constructor(options: unknown) {
      f.pageCreated(options);
    }
    observe = f.observe;
    action = f.action;
    close = f.closePage;
  },
}));
import { QwenRealtimeVoiceSession } from "../../apps/web/src/qwen-realtime-voice-session.js";

class Channel {
  readyState = "open";
  bufferedAmount = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
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
class Peer extends EventTarget {
  static last: Peer;
  static ice = "complete";
  dc = new Channel();
  connectionState = "connected";
  iceGatheringState = Peer.ice;
  localDescription = { sdp: "v=0\r\nm=audio 9\r\na=candidate:complete" };
  onconnectionstatechange?: () => void;
  ondatachannel?: (event: { channel: Channel }) => void;
  ontrack?: (event: unknown) => void;
  sender = { replaceTrack: vi.fn(async () => {}) };
  addTransceiver = vi.fn(() => ({ sender: this.sender }));
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "v=0\r\nm=audio 9" }));
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async () => {});
  close = vi.fn(() => {
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  });
  constructor() {
    super();
    Peer.last = this;
  }
  createDataChannel() {
    return this.dc;
  }
}
class Player {
  static last: Player;
  autoplay = false;
  muted = false;
  srcObject: unknown;
  play = vi.fn(async () => {});
  pause = vi.fn();
  constructor() {
    Player.last = this;
  }
}
const options = { includePersonalContext: false, includeMemory: false };
const configuration = {
  type: "session.update",
  session: { audio: { output: { voice: "Tina" } }, tools: [] },
};
const callbacks = () => ({
  state: vi.fn(),
  captions: vi.fn(),
  note: vi.fn(),
  error: vi.fn(),
  blocked: vi.fn(),
  result: vi.fn(),
  navigate: vi.fn(),
  business: vi.fn(),
  preparePage: vi.fn(),
  navigatePage: vi.fn(),
});
let track: {
  enabled: boolean;
  onended: (() => void) | null;
  stop: ReturnType<typeof vi.fn>;
};
let session: QwenRealtimeVoiceSession;
const stream = () => ({
  getTracks: () => [track],
  getAudioTracks: () => [track],
});
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function created(channel = Peer.last.dc) {
  channel.emit({
    type: "session.created",
    session: { id: "provider-session", model: qwenRealtimeModel },
  });
}
async function ready(channel = Peer.last.dc) {
  created(channel);
  channel.emit({
    type: "session.updated",
    session: {
      id: "provider-session",
      model: qwenRealtimeModel,
      audio: { output: { voice: "Tina" } },
    },
  });
  await settle();
}
function toolResponse(id = "r1", callId = "c1", channel = Peer.last.dc) {
  channel.emit({ type: "response.created", response: { id } });
  channel.emit({
    type: "response.function_call_arguments.done",
    response_id: id,
    name: "desktop_request",
    call_id: callId,
    arguments: '{"request":"点击编辑菜单"}',
  });
}
function done(id = "r1", channel = Peer.last.dc) {
  channel.emit({
    type: "response.done",
    response: { id, status: "completed" },
  });
}
beforeEach(() => {
  for (const mock of [f.pageCreated, f.observe, f.action, f.closePage])
    mock.mockReset();
  Peer.ice = "complete";
  track = { enabled: true, onended: null, stop: vi.fn() };
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(async () => stream()) },
  });
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("Audio", Player);
  f.api.mockReset().mockImplementation(async (path: string) =>
    path.endsWith("/sessions")
      ? {
          data: {
            provider: "qwen",
            sdp: "v=0\nm=audio 9",
            configuration,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        }
      : path.endsWith("/tool")
        ? { data: { text: "已完成", navigation: "analytics" } }
        : { data: { saved: true, closed: true, active: true } },
  );
});

const observation = {
  snapshotId: "snapshot-1",
  path: "/operations?platform=vip",
  title: "工作区",
  headings: ["工作区"],
  text: "更新数据",
  controls: [
    {
      ref: "control-1",
      role: "button",
      name: "更新数据",
      disabled: false,
      inViewport: true,
    },
  ],
  truncated: false,
};
function allowPage() {
  const normal = f.api.getMockImplementation()!;
  f.api.mockImplementation(async (...args) => {
    const result = await normal(...args);
    return args[0].endsWith("/sessions")
      ? { ...result, data: { ...result.data, pageControl: true } }
      : result;
  });
  f.observe.mockReturnValue(observation);
  f.action.mockResolvedValue({
    text: "已派发点击，请根据页面反馈确认结果",
    dispatched: true,
    observation: { ...observation, snapshotId: "snapshot-2", text: "正在更新" },
  });
}
function pageResponse(
  name: string,
  args: object,
  id = "page-response",
  callId = "page-call",
) {
  Peer.last.dc.emit({ type: "response.created", response: { id } });
  Peer.last.dc.emit({
    type: "response.function_call_arguments.done",
    response_id: id,
    name,
    call_id: callId,
    arguments: JSON.stringify(args),
  });
  done(id);
}
function pageOutput(callId = "page-call") {
  const item = Peer.last.dc.sent.find(
    (event) =>
      event.type === "conversation.item.create" &&
      (event.item as { call_id?: string })?.call_id === callId,
  )?.item as { output: string } | undefined;
  return item ? JSON.parse(item.output) : undefined;
}

describe("Qwen local website tools", () => {
  it("observes the current page without a server business call and still saves normal conversation captions", async () => {
    allowPage();
    const cb = callbacks();
    session = new QwenRealtimeVoiceSession(cb);
    await session.start(options);
    await ready();
    Peer.last.dc.emit({
      type: "input_audio_buffer.speech_started",
      item_id: "user",
    });
    Peer.last.dc.emit({
      type: "input_audio_buffer.speech_stopped",
      item_id: "user",
    });
    Peer.last.dc.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "user",
      transcript: "看看当前页面",
    });
    pageResponse("page_observe", { query: "更新数据" });
    await vi.waitFor(() => expect(pageOutput()).toEqual(observation));
    expect(f.observe).toHaveBeenCalledExactlyOnceWith("更新数据");
    expect(cb.preparePage).toHaveBeenCalledOnce();
    expect(cb.business).not.toHaveBeenCalled();
    expect(
      f.api.mock.calls.filter(([path]) => path.endsWith("/tool")),
    ).toHaveLength(0);
    Peer.last.dc.emit({ type: "response.created", response: { id: "answer" } });
    Peer.last.dc.emit({
      type: "response.audio_transcript.done",
      response_id: "answer",
      transcript: "当前页面有更新数据按钮",
    });
    done("answer");
    await vi.waitFor(() =>
      expect(
        f.api.mock.calls.some(([path]) => path.endsWith("/captions")),
      ).toBe(true),
    );
  });
  it("executes one referenced action and returns its actual observation while navigation stays in the same call", async () => {
    allowPage();
    const cb = callbacks();
    session = new QwenRealtimeVoiceSession(cb);
    await session.start(options);
    await ready();
    const args = {
      snapshotId: "snapshot-1",
      ref: "control-1",
      action: "click",
    };
    pageResponse("page_action", args);
    await vi.waitFor(() => expect(f.action).toHaveBeenCalledOnce());
    const context = f.action.mock.calls[0][1];
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(context.isCurrent()).toBe(true);
    expect(f.action.mock.calls[0][0]).toEqual(args);
    await vi.waitFor(() =>
      expect(pageOutput()).toMatchObject({
        dispatched: true,
        observation: { text: "正在更新" },
      }),
    );
    f.pageCreated.mock.calls[0][0].navigate("/operations?platform=vip");
    expect(cb.navigatePage).toHaveBeenCalledExactlyOnceWith(
      "/operations?platform=vip",
    );
    expect(Peer.last.dc.readyState).toBe("open");
    expect(
      f.api.mock.calls.filter(([path]) => path.endsWith("/sessions")),
    ).toHaveLength(1);
    expect(cb.business).not.toHaveBeenCalled();
  });
  it.each(["no-capability", "desktop"])(
    "does not run local page tools for %s sessions",
    async (kind) => {
      if (kind === "desktop") allowPage();
      session = new QwenRealtimeVoiceSession(callbacks());
      await session.start({
        ...options,
        ...(kind === "desktop" ? { desktopDeviceId: "selected-device" } : {}),
      });
      await ready();
      pageResponse("page_action", {
        snapshotId: "s",
        ref: "r",
        action: "click",
      });
      await vi.waitFor(() =>
        expect(pageOutput()).toMatchObject({
          dispatched: false,
          text: expect.stringContaining("未启用"),
        }),
      );
      expect(f.pageCreated).not.toHaveBeenCalled();
      expect(f.action).not.toHaveBeenCalled();
      expect(
        f.api.mock.calls.filter(([path]) => path.endsWith("/tool")),
      ).toHaveLength(0);
    },
  );
  it("rejects unknown action fields before preparing or touching the page", async () => {
    allowPage();
    const cb = callbacks();
    session = new QwenRealtimeVoiceSession(cb);
    await session.start(options);
    await ready();
    pageResponse("page_action", {
      snapshotId: "s",
      ref: "r",
      action: "click",
      javascript: "anything",
    });
    await vi.waitFor(() =>
      expect(pageOutput()).toMatchObject({
        dispatched: false,
        text: expect.stringContaining("参数"),
      }),
    );
    expect(cb.preparePage).not.toHaveBeenCalled();
    expect(f.action).not.toHaveBeenCalled();
  });
  it("returns stale-reference feedback without claiming a click succeeded", async () => {
    allowPage();
    const blocked = {
      text: "页面已变化，请重新观察",
      dispatched: false,
      observation,
    };
    f.action.mockResolvedValue(blocked);
    session = new QwenRealtimeVoiceSession(callbacks());
    await session.start(options);
    await ready();
    pageResponse("page_action", {
      snapshotId: "old",
      ref: "r",
      action: "click",
    });
    await vi.waitFor(() => expect(pageOutput()).toEqual(blocked));
  });
  it("cancels during drawer settling before an action can start", async () => {
    allowPage();
    const cb = callbacks();
    session = new QwenRealtimeVoiceSession(cb);
    await session.start(options);
    await ready();
    pageResponse("page_action", { snapshotId: "s", ref: "r", action: "click" });
    await settle();
    expect(cb.preparePage).toHaveBeenCalledOnce();
    session.interrupt();
    await settle();
    expect(f.action).not.toHaveBeenCalled();
    expect(pageOutput()).toBeUndefined();
  });
  it.each(["interrupt", "close"])(
    "aborts an in-flight local action on %s and suppresses its late continuation",
    async (kind) => {
      allowPage();
      let resolve!: (value: unknown) => void;
      f.action.mockImplementation(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      session = new QwenRealtimeVoiceSession(callbacks());
      await session.start(options);
      await ready();
      pageResponse("page_action", {
        snapshotId: "s",
        ref: "r",
        action: "click",
      });
      await vi.waitFor(() => expect(f.action).toHaveBeenCalledOnce());
      const context = f.action.mock.calls[0][1];
      if (kind === "interrupt") session.interrupt();
      else session.stop();
      expect(context.signal.aborted).toBe(true);
      expect(context.isCurrent()).toBe(false);
      resolve({ text: "点击已派发", dispatched: true, observation });
      await settle();
      expect(pageOutput()).toBeUndefined();
      if (kind === "close") expect(f.closePage).toHaveBeenCalledOnce();
    },
  );
  it("reports an uncertain action exception without asserting failure or success that could invite duplicate submission", async () => {
    allowPage();
    f.action.mockRejectedValue(Error("unexpected error after dispatch"));
    session = new QwenRealtimeVoiceSession(callbacks());
    await session.start(options);
    await ready();
    pageResponse("page_action", { snapshotId: "s", ref: "r", action: "click" });
    await vi.waitFor(() =>
      expect(pageOutput()).toMatchObject({
        dispatched: null,
        text: expect.stringContaining("避免重复"),
      }),
    );
  });
});
afterEach(() => {
  session?.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Qwen WebRTC initialization and media ownership", () => {
  it("sends the complete ICE SDP and waits for the server channel and configuration acknowledgement before attaching the microphone", async () => {
    const cb = callbacks();
    session = new QwenRealtimeVoiceSession(cb);
    await session.start({
      ...options,
      desktopDeviceId: "device",
      model: "engine/model",
    });
    expect(f.api.mock.calls[0][2]).toMatchObject({
      sdp: Peer.last.localDescription.sdp,
      desktopDeviceId: "device",
      model: "engine/model",
    });
    expect(Peer.last.sender.replaceTrack).not.toHaveBeenCalled();
    expect(track.enabled).toBe(false);
    const remote = new Channel();
    remote.readyState = "connecting";
    Peer.last.ondatachannel?.({ channel: remote });
    created(remote);
    expect(remote.sent).toHaveLength(0);
    remote.readyState = "open";
    remote.onopen?.();
    expect(remote.sent).toEqual([configuration]);
    expect(Peer.last.dc.sent).toHaveLength(0);
    expect(track.enabled).toBe(false);
    await ready(remote);
    expect(Peer.last.sender.replaceTrack).toHaveBeenCalledExactlyOnceWith(
      track,
    );
    expect(track.enabled).toBe(true);
    expect(cb.state).toHaveBeenLastCalledWith("listening");
    expect(Peer.last.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "v=0\r\nm=audio 9\r\n",
    });
  });
  it("does not submit SDP until ICE gathering completes, and stop cancels the wait", async () => {
    Peer.ice = "gathering";
    session = new QwenRealtimeVoiceSession(callbacks());
    const starting = session.start(options);
    await settle();
    expect(f.api).not.toHaveBeenCalled();
    session.stop();
    await starting;
    Peer.last.iceGatheringState = "complete";
    Peer.last.dispatchEvent(new Event("icegatheringstatechange"));
    expect(
      f.api.mock.calls.filter(([path]) => path.endsWith("/sessions")),
    ).toHaveLength(0);
    expect(track.stop).toHaveBeenCalled();
  });
  it("closes every channel and the microphone when configuration does not match", async () => {
    const cb = callbacks();
    session = new QwenRealtimeVoiceSession(cb);
    await session.start(options);
    const remote = new Channel();
    Peer.last.ondatachannel?.({ channel: remote });
    created(remote);
    remote.emit({
      type: "session.updated",
      session: { id: "s", model: qwenRealtimeModel, voice: "wrong" },
    });
    await settle();
    expect(cb.error).toHaveBeenCalledWith(
      expect.stringContaining("配置不一致"),
    );
    expect(remote.readyState).toBe("closed");
    expect(Peer.last.dc.readyState).toBe("closed");
    expect(Peer.last.close).toHaveBeenCalledOnce();
    expect(Peer.last.sender.replaceTrack).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });
  it("closes a late successful SDP session even when the first close raced before reservation", async () => {
    const normal = f.api.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    let closes = 0;
    f.api.mockImplementation((...args) => {
      if (args[0].endsWith("/sessions"))
        return new Promise((r) => {
          resolve = r;
        });
      if (args[0].endsWith("/close") && ++closes === 1)
        return Promise.reject(Error("not found"));
      return normal(...args);
    });
    session = new QwenRealtimeVoiceSession(callbacks());
    const starting = session.start(options);
    await settle();
    session.stop();
    expect(closes).toBe(1);
    resolve(await normal("/sessions"));
    await starting;
    expect(closes).toBe(2);
    expect(Peer.last.setRemoteDescription).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });
  it("waits for the connected state even when created and the channel arrived first", async () => {
    session = new QwenRealtimeVoiceSession(callbacks());
    await session.start(options);
    Peer.last.connectionState = "connecting";
    created();
    expect(Peer.last.dc.sent).toHaveLength(0);
    Peer.last.connectionState = "connected";
    Peer.last.onconnectionstatechange?.();
    Peer.last.onconnectionstatechange?.();
    expect(Peer.last.dc.sent).toEqual([configuration]);
  });
  it("uses the latest microphone mute state after asynchronous track attachment", async () => {
    session = new QwenRealtimeVoiceSession(callbacks());
    await session.start(options);
    let attached!: () => void;
    Peer.last.sender.replaceTrack.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          attached = resolve;
        }),
    );
    created();
    Peer.last.dc.emit({
      type: "session.updated",
      session: { id: "s", voice: "Tina" },
    });
    session.toggleMute();
    session.toggleMute();
    expect(track.enabled).toBe(false);
    attached();
    await settle();
    expect(track.enabled).toBe(true);
  });
  it("releases a microphone returned after stop and never creates a connection", async () => {
    let resolve!: (value: ReturnType<typeof stream>) => void;
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise((r) => {
              resolve = r;
            }),
        ),
      },
    });
    session = new QwenRealtimeVoiceSession(callbacks());
    const starting = session.start(options);
    session.stop();
    resolve(stream());
    await starting;
    expect(track.stop).toHaveBeenCalled();
    expect(
      f.api.mock.calls.filter(([path]) => path.endsWith("/sessions")),
    ).toHaveLength(0);
  });
});

describe("Qwen WebRTC tools and interruption", () => {
  it("waits for response.done, executes a desktop tool once, and returns a Qwen-compatible continuation", async () => {
    const cb = callbacks();
    session = new QwenRealtimeVoiceSession(cb);
    await session.start(options);
    await ready();
    toolResponse();
    await settle();
    expect(
      f.api.mock.calls.filter(([path]) => path.endsWith("/tool")),
    ).toHaveLength(0);
    done();
    done();
    await settle();
    expect(
      f.api.mock.calls.filter(([path]) => path.endsWith("/tool")),
    ).toHaveLength(1);
    expect(
      f.api.mock.calls.find(([path]) => path.endsWith("/tool"))?.[2],
    ).toEqual({
      callId: "c1",
      request: "点击编辑菜单",
      tool: "desktop_request",
    });
    expect(Peer.last.dc.sent.at(-2)).toMatchObject({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "c1" },
    });
    expect(Peer.last.dc.sent.at(-1)).toEqual({ type: "response.create" });
    expect(cb.navigate).toHaveBeenCalledExactlyOnceWith("analytics");
  });
  it.each(["speech", "cancel", "close"])(
    "never resumes an in-flight tool after %s",
    async (kind) => {
      let resolve!: (value: {
        data: { text: string; navigation: string };
      }) => void;
      const normal = f.api.getMockImplementation()!;
      f.api.mockImplementation((...args) =>
        args[0].endsWith("/tool")
          ? new Promise((r) => {
              resolve = r;
            })
          : normal(...args),
      );
      const cb = callbacks();
      session = new QwenRealtimeVoiceSession(cb);
      await session.start(options);
      await ready();
      toolResponse();
      done();
      await settle();
      if (kind === "speech")
        Peer.last.dc.emit({
          type: "input_audio_buffer.speech_started",
          item_id: "new-user",
        });
      else if (kind === "cancel") session.interrupt();
      else session.stop();
      const before = Peer.last.dc.sent.length;
      resolve({ data: { text: "旧操作完成", navigation: "analytics" } });
      await settle();
      expect(Peer.last.dc.sent).toHaveLength(before);
      expect(cb.navigate).not.toHaveBeenCalled();
      expect(cb.result).toHaveBeenCalledOnce();
    },
  );
  it("skips a tool interrupted before its queued execution begins", async () => {
    session = new QwenRealtimeVoiceSession(callbacks());
    await session.start(options);
    await ready();
    toolResponse();
    done();
    session.interrupt();
    await settle();
    expect(
      f.api.mock.calls.filter(([path]) => path.endsWith("/tool")),
    ).toHaveLength(0);
  });
  it("mutes capture without canceling a legitimate tool reply, and never sends manual commits", async () => {
    session = new QwenRealtimeVoiceSession(callbacks());
    await session.start(options);
    await ready();
    toolResponse();
    done();
    session.toggleMute();
    expect(track.enabled).toBe(false);
    await settle();
    expect(Peer.last.dc.sent.at(-1)).toEqual({ type: "response.create" });
    session.toggleMute();
    expect(track.enabled).toBe(true);
    session.send();
    expect(
      Peer.last.dc.sent.some(
        (event) => event.type === "input_audio_buffer.commit",
      ),
    ).toBe(false);
    expect(
      Peer.last.dc.sent.some(
        (event) => event.type === "input_audio_buffer.append",
      ),
    ).toBe(false);
  });
  it("silences RTP playback on interruption and restores it only for a new accepted response", async () => {
    session = new QwenRealtimeVoiceSession(callbacks());
    await session.start(options);
    await ready();
    Peer.last.dc.emit({ type: "response.created", response: { id: "old" } });
    session.interrupt();
    expect(Player.last.muted).toBe(true);
    Peer.last.dc.emit({ type: "response.created", response: { id: "late" } });
    expect(Player.last.muted).toBe(true);
    Peer.last.dc.emit({
      type: "input_audio_buffer.speech_started",
      item_id: "new",
    });
    Peer.last.dc.emit({
      type: "input_audio_buffer.speech_stopped",
      item_id: "new",
    });
    Peer.last.dc.emit({ type: "response.created", response: { id: "new" } });
    expect(Player.last.muted).toBe(false);
  });
  it("handles selected-channel closure during a response without recursive cleanup", async () => {
    const cb = callbacks();
    session = new QwenRealtimeVoiceSession(cb);
    await session.start(options);
    await ready();
    Peer.last.dc.emit({ type: "response.created", response: { id: "r" } });
    Peer.last.dc.close();
    expect(cb.error).toHaveBeenCalledOnce();
    expect(Peer.last.close).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
  });
});

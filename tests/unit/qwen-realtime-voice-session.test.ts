import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qwenRealtimeModel } from "../../packages/contracts/src/assistant-realtime.js";
const f = vi.hoisted(() => ({
  api: vi.fn(),
  pageCreated: vi.fn(),
  observe: vi.fn(),
  action: vi.fn(),
  closePage: vi.fn(),
  currentSnapshot: vi.fn(),
  currentEvidence: vi.fn(),
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
    currentSnapshot = f.currentSnapshot;
    currentEvidence = f.currentEvidence;
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
  for (const mock of [
    f.pageCreated,
    f.observe,
    f.action,
    f.closePage,
    f.currentSnapshot,
    f.currentEvidence,
  ])
    mock.mockReset();
  f.currentSnapshot.mockReturnValue(true);
  f.currentEvidence.mockReturnValue(true);
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
function allowWorkflow() {
  allowPage();
  const normal = f.api.getMockImplementation()!;
  f.api.mockImplementation(async (...args) => {
    const result = await normal(...args);
    return args[0].endsWith("/sessions")
      ? { ...result, data: { ...result.data, pageTaskControl: true } }
      : result;
  });
}
function pageResponse(
  name: string,
  args: object,
  id = "page-response",
  callId = "page-call",
) {
  rawPageResponse(name, JSON.stringify(args), id, callId);
}
function rawPageResponse(
  name: string,
  args: unknown,
  id = "page-response",
  callId = "page-call",
) {
  Peer.last.dc.emit({ type: "response.created", response: { id } });
  Peer.last.dc.emit({
    type: "response.function_call_arguments.done",
    response_id: id,
    name,
    call_id: callId,
    arguments: args,
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

describe("Qwen goal-driven page workflow", () => {
  async function startWorkflow(cb = callbacks()) {
    allowWorkflow();
    session = new QwenRealtimeVoiceSession(cb);
    await session.start(options);
    await ready();
    return cb;
  }
  async function beginTask() {
    pageResponse(
      "page_task_start",
      { goal: "返回更新面板并检查更新结果" },
      "start",
      "start-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("start-call")).toMatchObject({
        task: { status: "active" },
        observation,
      }),
    );
  }
  it("requires a complete task goal before writes when enabled without treating the missing task as bad parameters", async () => {
    await startWorkflow();
    for (let i = 0; i < 3; i++) {
      pageResponse(
        "page_click",
        { snapshotId: "snapshot-1", ref: "control-1" },
        `required-${i}`,
        `required-call-${i}`,
      );
      await vi.waitFor(() =>
        expect(pageOutput(`required-call-${i}`)).toMatchObject({
          code: "PAGE_TASK_REQUIRED",
          dispatched: false,
        }),
      );
    }
    expect(f.action).not.toHaveBeenCalled();
    await beginTask();
    expect(pageOutput("start-call").task).toEqual({
      goal: "返回更新面板并检查更新结果",
      status: "active",
      actionCount: 0,
      toolCount: 1,
    });
    pageResponse(
      "page_click",
      { snapshotId: "snapshot-1", ref: "control-1" },
      "click",
      "click-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("click-call")).toMatchObject({
        dispatched: true,
        task: { actionCount: 1 },
      }),
    );
  });
  it("executes separate steps using their fresh observations and finishes only with current visible evidence", async () => {
    const cb = await startWorkflow();
    await beginTask();
    for (let step = 1; step <= 2; step++) {
      f.action.mockResolvedValueOnce({
        dispatched: true,
        text: "已派发操作",
        observation: {
          ...observation,
          snapshotId: `snapshot-${step + 1}`,
          text: step === 2 ? "更新完成，共20条" : "更新面板",
        },
      });
      pageResponse(
        "page_click",
        { snapshotId: `snapshot-${step}`, ref: "control-1" },
        `step-${step}`,
        `step-call-${step}`,
      );
      await vi.waitFor(() =>
        expect(pageOutput(`step-call-${step}`)).toMatchObject({
          task: { status: "active", actionCount: step },
        }),
      );
      expect(cb.state).toHaveBeenLastCalledWith("thinking");
    }
    pageResponse(
      "page_task_finish",
      {
        outcome: "completed",
        summary: "更新已完成",
        snapshotId: "snapshot-3",
        evidence: "更新完成，共20条",
      },
      "finish",
      "finish-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("finish-call")).toMatchObject({
        task: { status: "completed", actionCount: 2, toolCount: 4 },
      }),
    );
    expect(f.currentSnapshot).toHaveBeenCalledExactlyOnceWith("snapshot-3");
    expect(f.currentEvidence).toHaveBeenCalledExactlyOnceWith(
      "snapshot-3",
      "更新完成，共20条",
    );
    expect(f.action.mock.calls.map(([input]) => input.snapshotId)).toEqual([
      "snapshot-1",
      "snapshot-2",
    ]);
    expect(cb.state).toHaveBeenLastCalledWith("listening");
  });
  it.each(["stale-id", "changed-dom", "invented-evidence", "changed-evidence"])(
    "does not finish with %s or replace the model's submitted snapshot",
    async (kind) => {
      await startWorkflow();
      await beginTask();
      if (kind === "changed-dom") f.currentSnapshot.mockReturnValue(false);
      if (kind === "changed-evidence") f.currentEvidence.mockReturnValue(false);
      const id = kind === "stale-id" ? "old-snapshot" : observation.snapshotId;
      pageResponse(
        "page_task_finish",
        {
          outcome: "completed",
          summary: "成功",
          snapshotId: id,
          evidence:
            kind === "invented-evidence" ? "实际不存在的完成结果" : "更新数据",
        },
        "finish",
        "finish-call",
      );
      await vi.waitFor(() =>
        expect(pageOutput("finish-call")).toMatchObject({
          code:
            kind === "stale-id" || kind === "changed-dom"
              ? "PAGE_TASK_SNAPSHOT"
              : "PAGE_TASK_EVIDENCE",
          dispatched: false,
          task: { status: "active" },
        }),
      );
      expect(f.observe).toHaveBeenCalledOnce();
      if (kind === "stale-id") expect(f.currentSnapshot).not.toHaveBeenCalled();
      else expect(f.currentSnapshot).toHaveBeenCalledExactlyOnceWith(id);
      if (kind === "changed-evidence")
        expect(f.currentEvidence).toHaveBeenCalledExactlyOnceWith(
          id,
          "更新数据",
        );
      if (kind !== "invented-evidence")
        expect(pageOutput("finish-call")).not.toHaveProperty(
          "evidenceCandidates",
        );
      if (kind === "changed-evidence")
        expect(pageOutput("finish-call")).toMatchObject({
          reason: "changed",
          text: expect.stringContaining("不能改用其他页名或控件代替"),
        });
    },
  );
  it("offers only live verified contiguous evidence candidates for joined text and accepts one correction without re-observing", async () => {
    await startWorkflow();
    const view = {
      ...observation,
      pageName: "经营分析",
      text: "统计日期\n近 15 天\n按货号分析\n现场已失效的文字",
    };
    f.observe.mockReturnValue(view);
    const actual = ["经营分析", "近 15 天", "按货号分析"];
    f.currentEvidence.mockImplementation(
      (id, evidence) => id === view.snapshotId && actual.includes(evidence),
    );
    pageResponse(
      "page_task_start",
      { goal: "查看指定报表视图" },
      "start",
      "start-call",
    );
    await vi.waitFor(() => expect(pageOutput("start-call")).toBeDefined());
    pageResponse(
      "page_task_finish",
      {
        outcome: "completed",
        summary: "已切换视图",
        snapshotId: view.snapshotId,
        evidence: "统计日期 近 15 天 按货号分析",
      },
      "joined",
      "joined-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("joined-call")).toMatchObject({
        code: "PAGE_TASK_EVIDENCE",
        reason: "format",
        dispatched: false,
        retryable: true,
        finishAttemptsRemaining: 2,
        evidenceCandidates: actual,
        task: { status: "active" },
      }),
    );
    expect(pageOutput("joined-call").text).toContain("不必反复 page_observe");
    expect(pageOutput("joined-call").text).toContain("整个目标已达到");
    for (const candidate of pageOutput("joined-call").evidenceCandidates)
      expect(f.currentEvidence).toHaveBeenCalledWith(
        view.snapshotId,
        candidate,
      );
    expect(f.observe).toHaveBeenCalledOnce();
    pageResponse(
      "page_task_finish",
      {
        outcome: "completed",
        summary: "目标视图已显示",
        snapshotId: view.snapshotId,
        evidence: "按货号分析",
      },
      "fixed",
      "fixed-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("fixed-call")).toMatchObject({
        task: { status: "completed" },
      }),
    );
    expect(f.observe).toHaveBeenCalledOnce();
    expect(f.action).not.toHaveBeenCalled();
  });
  it("bounds live evidence candidate scans and never constructs a combined quotation", async () => {
    await startWorkflow();
    f.observe.mockReturnValue({
      ...observation,
      text: Array.from({ length: 100 }, (_, i) => `原文片段${i}`).join("\n"),
    });
    f.currentEvidence.mockReturnValue(false);
    pageResponse(
      "page_task_start",
      { goal: "核对页面" },
      "start",
      "start-call",
    );
    await vi.waitFor(() => expect(pageOutput("start-call")).toBeDefined());
    pageResponse(
      "page_task_finish",
      {
        outcome: "completed",
        summary: "核对结束",
        snapshotId: observation.snapshotId,
        evidence: "拼接的无效证据",
      },
      "invalid",
      "invalid-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("invalid-call")).toMatchObject({
        reason: "format",
        evidenceCandidates: [],
      }),
    );
    expect(f.currentEvidence.mock.calls.length).toBeLessThanOrEqual(30);
    expect(
      f.currentEvidence.mock.calls.every(
        ([, value]) => !String(value).includes("\n"),
      ),
    ).toBe(true);
  });
  it("requires a fresh observation after live evidence changed instead of accepting a substitute page name", async () => {
    await startWorkflow();
    await beginTask();
    f.currentEvidence.mockReturnValue(false);
    pageResponse(
      "page_task_finish",
      {
        outcome: "completed",
        summary: "旧结论",
        snapshotId: observation.snapshotId,
        evidence: "更新数据",
      },
      "changed",
      "changed-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("changed-call")).toMatchObject({ reason: "changed" }),
    );
    f.currentEvidence.mockReturnValue(true);
    pageResponse(
      "page_task_finish",
      {
        outcome: "completed",
        summary: "不能替换证明",
        snapshotId: observation.snapshotId,
        evidence: observation.path,
      },
      "substitute",
      "substitute-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("substitute-call")).toMatchObject({
        code: "PAGE_TASK_SNAPSHOT",
        finishAttemptsRemaining: 1,
      }),
    );
    expect(f.currentEvidence).toHaveBeenCalledOnce();
    f.observe.mockReturnValue({
      ...observation,
      snapshotId: "fresh-failure",
      text: "更新失败，请检查登录",
    });
    pageResponse("page_observe", {}, "fresh", "fresh-call");
    await vi.waitFor(() =>
      expect(pageOutput("fresh-call")).toMatchObject({
        snapshotId: "fresh-failure",
      }),
    );
    pageResponse(
      "page_task_finish",
      {
        outcome: "needs_user",
        summary: "需要检查登录",
        snapshotId: "fresh-failure",
        evidence: "更新失败，请检查登录",
      },
      "actual",
      "actual-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("actual-call")).toMatchObject({
        task: { status: "needs_user" },
      }),
    );
    expect(f.observe).toHaveBeenCalledTimes(2);
  });
  it("stops after three finish verification failures even when observe and repeated start occur between them", async () => {
    const cb = await startWorkflow();
    await beginTask();
    for (let attempt = 1; attempt <= 3; attempt++) {
      pageResponse(
        "page_task_finish",
        {
          outcome: "completed",
          summary: "没有核验",
          snapshotId: observation.snapshotId,
          evidence: "观察中不存在的结论",
        },
        `finish-${attempt}`,
        `finish-call-${attempt}`,
      );
      await vi.waitFor(() =>
        expect(pageOutput(`finish-call-${attempt}`)).toMatchObject({
          retryable: attempt < 3,
          finishAttemptsRemaining: 3 - attempt,
          task: { status: attempt < 3 ? "active" : "needs_user" },
        }),
      );
      if (attempt < 3) {
        pageResponse(
          attempt === 1 ? "page_task_start" : "page_observe",
          attempt === 1 ? { goal: "不能清除核验次数" } : {},
          `refresh-${attempt}`,
          `refresh-call-${attempt}`,
        );
        await vi.waitFor(() =>
          expect(pageOutput(`refresh-call-${attempt}`)).toBeDefined(),
        );
      }
    }
    expect(pageOutput("finish-call-3")).toMatchObject({
      code: "PAGE_TASK_VERIFICATION_LIMIT",
    });
    expect(cb.note).toHaveBeenLastCalledWith(
      expect.stringContaining("连续三次未能核验"),
    );
    expect(Peer.last.dc.readyState).toBe("open");
    expect(cb.state).toHaveBeenLastCalledWith("listening");
    expect(f.action).not.toHaveBeenCalled();
  });
  it("resets finish verification failures only after a dispatched page action", async () => {
    await startWorkflow();
    await beginTask();
    const failFinish = async (
      number: number,
      snapshotId = observation.snapshotId,
    ) => {
      pageResponse(
        "page_task_finish",
        {
          outcome: "completed",
          summary: "尚未核验",
          snapshotId,
          evidence: "没有这段原文",
        },
        `finish-${number}`,
        `finish-call-${number}`,
      );
      await vi.waitFor(() =>
        expect(pageOutput(`finish-call-${number}`)).toBeDefined(),
      );
    };
    await failFinish(1);
    f.action.mockResolvedValueOnce({
      dispatched: false,
      text: "页面操作被阻止",
      observation,
    });
    pageResponse(
      "page_click",
      { snapshotId: observation.snapshotId, ref: "control-1" },
      "blocked",
      "blocked-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("blocked-call")).toMatchObject({ dispatched: false }),
    );
    await failFinish(2);
    expect(pageOutput("finish-call-2")).toMatchObject({
      finishAttemptsRemaining: 1,
    });
    pageResponse(
      "page_click",
      { snapshotId: observation.snapshotId, ref: "control-1" },
      "actual",
      "actual-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("actual-call")).toMatchObject({ dispatched: true }),
    );
    await failFinish(3, "snapshot-2");
    expect(pageOutput("finish-call-3")).toMatchObject({
      finishAttemptsRemaining: 2,
      retryable: true,
      task: { status: "active", actionCount: 1 },
    });
  });
  it("defers every precomputed tool after the first and keeps deferred calls out of action and parameter budgets", async () => {
    const cb = await startWorkflow();
    const dc = Peer.last.dc;
    dc.emit({
      type: "input_audio_buffer.speech_started",
      item_id: "workflow-user",
    });
    dc.emit({
      type: "input_audio_buffer.speech_stopped",
      item_id: "workflow-user",
    });
    dc.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "workflow-user",
      transcript: "返回面板",
    });
    dc.emit({ type: "response.created", response: { id: "batch" } });
    for (const [call_id, name, args] of [
      ["start-call", "page_task_start", { goal: "返回面板" }],
      ["deferred-a", "page_click", { snapshotId: "old", ref: "old" }],
      ["deferred-b", "workspace_request", { request: "更新数据" }],
    ] as const)
      dc.emit({
        type: "response.function_call_arguments.done",
        response_id: "batch",
        call_id,
        name,
        arguments: JSON.stringify(args),
      });
    done("batch");
    await vi.waitFor(() =>
      expect(pageOutput("deferred-b")).toMatchObject({
        code: "PAGE_STEP_DEFERRED",
        dispatched: false,
        task: { toolCount: 1 },
      }),
    );
    expect(pageOutput("deferred-a")).toMatchObject({
      code: "PAGE_STEP_DEFERRED",
      dispatched: false,
    });
    expect(f.observe).toHaveBeenCalledOnce();
    expect(f.action).not.toHaveBeenCalled();
    expect(cb.business).not.toHaveBeenCalled();
    expect(
      f.api.mock.calls.filter(([path]) => path.endsWith("/tool")),
    ).toHaveLength(0);
    expect(
      dc.sent.filter((event) => event.type === "response.create"),
    ).toHaveLength(1);
    pageResponse(
      "page_click",
      { snapshotId: "snapshot-1", ref: "control-1" },
      "next",
      "next-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("next-call")).toMatchObject({
        dispatched: true,
        task: { actionCount: 1, toolCount: 2 },
      }),
    );
    expect(f.action).toHaveBeenCalledOnce();
    dc.emit({ type: "response.created", response: { id: "step-comment" } });
    dc.emit({
      type: "response.audio_transcript.done",
      response_id: "step-comment",
      transcript: "正在核对页面结果",
    });
    done("step-comment");
    await vi.waitFor(() =>
      expect(
        f.api.mock.calls.some(([path]) => path.endsWith("/captions")),
      ).toBe(true),
    );
    expect(
      f.api.mock.calls.find(([path]) => path.endsWith("/captions"))?.[2],
    ).toMatchObject({
      messages: expect.arrayContaining([
        { id: expect.any(String), role: "user", text: "返回面板" },
      ]),
    });
  });
  it.each([true, false])(
    "serializes business-only batches only while a page task is active (%s)",
    async (active) => {
      const cb = await startWorkflow();
      if (active) await beginTask();
      const dc = Peer.last.dc;
      dc.emit({ type: "response.created", response: { id: "business-batch" } });
      for (const call of ["first", "second"])
        dc.emit({
          type: "response.function_call_arguments.done",
          response_id: "business-batch",
          call_id: `business-${call}`,
          name: "workspace_request",
          arguments: JSON.stringify({ request: `查询${call}` }),
        });
      done("business-batch");
      await vi.waitFor(() =>
        expect(pageOutput("business-second")).toBeDefined(),
      );
      const calls = f.api.mock.calls.filter(([path]) => path.endsWith("/tool"));
      expect(calls).toHaveLength(active ? 1 : 2);
      expect(calls[0][2]).toMatchObject({ callId: "business-first" });
      expect(cb.business).toHaveBeenCalledOnce();
      if (active)
        expect(pageOutput("business-second")).toMatchObject({
          code: "PAGE_STEP_DEFERRED",
          dispatched: false,
          task: { toolCount: 2 },
        });
      else
        expect(pageOutput("business-second")).toMatchObject({ text: "已完成" });
    },
  );
  it("uses at most two bare continuations for idle task replies and stops without fabricating user confirmation", async () => {
    const cb = await startWorkflow();
    await beginTask();
    const dc = Peer.last.dc;
    for (let n = 1; n <= 3; n++) {
      dc.emit({ type: "response.created", response: { id: `idle-${n}` } });
      dc.emit({
        type: "response.audio_transcript.done",
        response_id: `idle-${n}`,
        transcript: "我来帮你完成",
      });
      done(`idle-${n}`);
    }
    expect(dc.sent.filter((event) => event.type === "response.create")).toEqual(
      [
        { type: "response.create" },
        { type: "response.create" },
        { type: "response.create" },
      ],
    );
    expect(
      dc.sent
        .filter((event) => event.type === "conversation.item.create")
        .every(
          (event) =>
            (event.item as { type: string }).type === "function_call_output",
        ),
    ).toBe(true);
    expect(cb.note).toHaveBeenLastCalledWith(
      expect.stringContaining("停止重复口头续答"),
    );
    expect(cb.state).toHaveBeenLastCalledWith("listening");
    pageResponse(
      "page_task_start",
      { goal: "不能重置保护门限" },
      "restart",
      "restart-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("restart-call")).toMatchObject({
        code: "PAGE_TASK_STOPPED",
        task: { status: "needs_user" },
      }),
    );
    expect(
      dc.sent.filter((event) => event.type === "response.create"),
    ).toHaveLength(3);
  });
  it("releases the task when a real user step is required and refuses further same-turn writes", async () => {
    const cb = await startWorkflow();
    f.observe.mockReturnValue({ ...observation, text: "请扫码登录" });
    pageResponse(
      "page_task_start",
      { goal: "更新数据" },
      "start",
      "start-call",
    );
    await vi.waitFor(() => expect(pageOutput("start-call")).toBeDefined());
    pageResponse(
      "page_task_finish",
      {
        outcome: "needs_user",
        summary: "请完成扫码登录",
        snapshotId: observation.snapshotId,
        evidence: "请扫码登录",
      },
      "finish",
      "finish-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("finish-call")).toMatchObject({
        task: { status: "needs_user" },
      }),
    );
    expect(cb.note).toHaveBeenLastCalledWith("任务需要你操作：请完成扫码登录");
    pageResponse(
      "page_click",
      { snapshotId: observation.snapshotId, ref: "control-1" },
      "late",
      "late-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("late-call")).toMatchObject({
        code: "PAGE_TASK_REQUIRED",
        dispatched: false,
      }),
    );
    expect(f.action).not.toHaveBeenCalled();
    pageResponse(
      "workspace_request",
      { request: "继续更新数据" },
      "late-business",
      "late-business-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("late-business-call")).toMatchObject({
        code: "PAGE_TASK_STOPPED",
        dispatched: false,
      }),
    );
    expect(
      f.api.mock.calls.filter(([path]) => path.endsWith("/tool")),
    ).toHaveLength(0);
    Peer.last.dc.emit({
      type: "input_audio_buffer.speech_started",
      item_id: "new-business",
    });
    Peer.last.dc.emit({
      type: "input_audio_buffer.speech_stopped",
      item_id: "new-business",
    });
    pageResponse(
      "workspace_request",
      { request: "查询库存" },
      "new-business",
      "new-business-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("new-business-call")).toMatchObject({ text: "已完成" }),
    );
    expect(
      f.api.mock.calls.filter(([path]) => path.endsWith("/tool")),
    ).toHaveLength(1);
  });
  it.each(["speech", "interrupt", "stop"])(
    "aborts page_wait on %s and never resumes its task automatically",
    async (kind) => {
      await startWorkflow();
      await beginTask();
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "performance"],
      });
      pageResponse("page_wait", { seconds: 10 }, "wait", "wait-call");
      await vi.advanceTimersByTimeAsync(1000);
      const continuations = Peer.last.dc.sent.filter(
        (event) => event.type === "response.create",
      ).length;
      Peer.last.dc.emit({
        type: "response.created",
        response: { id: "while-waiting" },
      });
      done("while-waiting");
      expect(
        Peer.last.dc.sent.filter((event) => event.type === "response.create"),
      ).toHaveLength(continuations);
      if (kind === "speech")
        Peer.last.dc.emit({
          type: "input_audio_buffer.speech_started",
          item_id: "new",
        });
      else if (kind === "interrupt") session.interrupt();
      else session.stop();
      const sent = Peer.last.dc.sent.length;
      await vi.advanceTimersByTimeAsync(12000);
      expect(pageOutput("wait-call")).toBeUndefined();
      expect(Peer.last.dc.sent).toHaveLength(sent);
      expect(f.observe).toHaveBeenCalledOnce();
      if (kind === "speech") {
        Peer.last.dc.emit({
          type: "input_audio_buffer.speech_stopped",
          item_id: "new",
        });
        pageResponse(
          "page_click",
          { snapshotId: "snapshot-1", ref: "control-1" },
          "old-action",
          "old-action-call",
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(pageOutput("old-action-call")).toMatchObject({
          code: "PAGE_TASK_REQUIRED",
        });
        pageResponse(
          "page_task_start",
          { goal: "用户明确要求的新目标" },
          "new-task",
          "new-task-call",
        );
        await vi.advanceTimersByTimeAsync(120);
        expect(pageOutput("new-task-call")).toMatchObject({
          task: {
            status: "active",
            goal: "用户明确要求的新目标",
            toolCount: 1,
            actionCount: 0,
          },
        });
      }
    },
  );
  it("waits without clicking and returns a new observation when asynchronous work advances", async () => {
    await startWorkflow();
    await beginTask();
    const completed = {
      ...observation,
      snapshotId: "wait-result",
      text: "后台更新完成",
    };
    f.observe.mockReturnValue(completed);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    pageResponse("page_wait", { seconds: 1 }, "wait", "wait-call");
    await vi.advanceTimersByTimeAsync(999);
    expect(pageOutput("wait-call")).toBeUndefined();
    expect(f.observe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(121);
    expect(pageOutput("wait-call")).toMatchObject({
      observation: completed,
      task: { status: "active", toolCount: 2, actionCount: 0 },
    });
    expect(f.action).not.toHaveBeenCalled();
  });
  it("bounds the total task tool budget even when observations keep returning valid results", async () => {
    const cb = await startWorkflow();
    await beginTask();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    for (let i = 2; i <= 60; i++) {
      pageResponse("page_observe", {}, `observe-${i}`, `observe-call-${i}`);
      await vi.advanceTimersByTimeAsync(120);
      expect(pageOutput(`observe-call-${i}`)).toMatchObject({
        task: { status: "active", toolCount: i },
      });
    }
    const before = Peer.last.dc.sent.filter(
      (event) => event.type === "response.create",
    ).length;
    pageResponse("page_observe", {}, "limit", "limit-call");
    await vi.advanceTimersByTimeAsync(1);
    expect(pageOutput("limit-call")).toMatchObject({
      code: "PAGE_TASK_LIMIT",
      dispatched: false,
      task: { status: "needs_user", toolCount: 60 },
    });
    expect(f.observe).toHaveBeenCalledTimes(60);
    expect(cb.note).toHaveBeenLastCalledWith(
      expect.stringContaining("保护上限"),
    );
    expect(
      Peer.last.dc.sent.filter((event) => event.type === "response.create"),
    ).toHaveLength(before);
  });
});

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
    };
    pageResponse("page_click", args);
    await vi.waitFor(() => expect(f.action).toHaveBeenCalledOnce());
    const context = f.action.mock.calls[0][1];
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(context.isCurrent()).toBe(true);
    expect(f.action.mock.calls[0][0]).toEqual({ ...args, action: "click" });
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
  it("waits for a loading route and returns only the ready observation from the same tool call", async () => {
    allowPage();
    const loaded = { ...observation, ready: true };
    f.observe
      .mockReturnValueOnce({
        ...observation,
        ready: false,
        snapshotId: "",
        controls: [],
      })
      .mockReturnValue(loaded);
    session = new QwenRealtimeVoiceSession(callbacks());
    await session.start(options);
    await ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    pageResponse("page_observe", { query: "经营分析" });
    await vi.advanceTimersByTimeAsync(120);
    expect(f.observe).toHaveBeenCalledExactlyOnceWith("经营分析");
    expect(pageOutput()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(25);
    expect(pageOutput()).toEqual(loaded);
    expect(f.observe.mock.calls).toEqual([["经营分析"], ["经营分析"]]);
    expect(f.action).not.toHaveBeenCalled();
    expect(
      Peer.last.dc.sent.filter(
        (event) =>
          (event.item as { call_id?: string })?.call_id === "page-call",
      ),
    ).toHaveLength(1);
  });
  it.each(["interrupt", "stop"])(
    "cancels the loading-route observation wait on %s without a stale result or continuation",
    async (kind) => {
      allowPage();
      f.observe.mockReturnValue({
        ...observation,
        ready: false,
        snapshotId: "",
        controls: [],
      });
      session = new QwenRealtimeVoiceSession(callbacks());
      await session.start(options);
      await ready();
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "performance"],
      });
      pageResponse("page_observe", {});
      await vi.advanceTimersByTimeAsync(120);
      expect(f.observe).toHaveBeenCalledOnce();
      if (kind === "interrupt") session.interrupt();
      else session.stop();
      f.observe.mockReturnValue({ ...observation, ready: true });
      await vi.advanceTimersByTimeAsync(4000);
      expect(f.observe).toHaveBeenCalledOnce();
      expect(pageOutput()).toBeUndefined();
      expect(
        Peer.last.dc.sent.some((event) => event.type === "response.create"),
      ).toBe(false);
    },
  );
  it("returns the truthful loading observation after a bounded three-second wait", async () => {
    allowPage();
    const loading = {
      ...observation,
      ready: false,
      snapshotId: "",
      headings: [],
      controls: [],
      text: "新页面正在加载，请稍后重新观察",
    };
    f.observe.mockReturnValue(loading);
    session = new QwenRealtimeVoiceSession(callbacks());
    await session.start(options);
    await ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    pageResponse("page_observe", {});
    await vi.advanceTimersByTimeAsync(120);
    expect(f.observe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2999);
    expect(pageOutput()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(pageOutput()).toEqual(loading);
    const observed = f.observe.mock.calls.length;
    expect(observed).toBeGreaterThan(1);
    expect(observed).toBeLessThanOrEqual(122);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.observe).toHaveBeenCalledTimes(observed);
    expect(f.action).not.toHaveBeenCalled();
    expect(Peer.last.dc.readyState).toBe("open");
  });
  it.each([
    [
      "page_fill",
      { ref: "r", value: "  保留输入空格  " },
      { action: "fill", ref: "r", value: "  保留输入空格  " },
    ],
    [
      "page_fill",
      { ref: "r", value: "" },
      { action: "fill", ref: "r", value: "" },
    ],
    [
      "page_select",
      { ref: "r", value: "observed-option" },
      { action: "select", ref: "r", value: "observed-option" },
    ],
    [
      "page_scroll",
      { direction: "down" },
      { action: "scroll", direction: "down" },
    ],
  ])(
    "maps %s to the canonical action without changing its values",
    async (name, args, canonical) => {
      allowPage();
      session = new QwenRealtimeVoiceSession(callbacks());
      await session.start(options);
      await ready();
      pageResponse(name, { snapshotId: "s", ...args });
      await vi.waitFor(() =>
        expect(pageOutput()).toMatchObject({ dispatched: true }),
      );
      expect(f.action).toHaveBeenCalledExactlyOnceWith(
        { snapshotId: "s", ...canonical },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    },
  );
  it("accepts only known empty legacy placeholders and trims references without guessing targets", async () => {
    allowPage();
    session = new QwenRealtimeVoiceSession(callbacks());
    await session.start(options);
    await ready();
    pageResponse("page_action", {
      snapshotId: " snapshot-1 ",
      ref: " control-1 ",
      action: "click",
      value: "",
      direction: null,
    });
    await vi.waitFor(() =>
      expect(pageOutput()).toMatchObject({ dispatched: true }),
    );
    expect(f.action.mock.calls[0][0]).toEqual({
      snapshotId: "snapshot-1",
      ref: "control-1",
      action: "click",
    });
    expect(f.action).toHaveBeenCalledOnce();
  });
  it("returns a correctable missing-field result and executes one corrected new call without replaying the failed call", async () => {
    allowPage();
    const cb = callbacks();
    session = new QwenRealtimeVoiceSession(cb);
    await session.start(options);
    await ready();
    pageResponse(
      "page_click",
      { snapshotId: "snapshot-1" },
      "invalid",
      "invalid-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("invalid-call")).toMatchObject({
        dispatched: false,
        code: "PAGE_TOOL_ARGUMENTS",
        retryable: true,
        text: expect.stringContaining("ref"),
      }),
    );
    expect(cb.preparePage).not.toHaveBeenCalled();
    expect(f.action).not.toHaveBeenCalled();
    pageResponse(
      "page_click",
      { snapshotId: "snapshot-1", ref: "control-1" },
      "corrected",
      "corrected-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("corrected-call")).toMatchObject({ dispatched: true }),
    );
    pageResponse(
      "page_click",
      { snapshotId: "snapshot-1", ref: "control-1" },
      "duplicate",
      "corrected-call",
    );
    await settle();
    expect(f.action).toHaveBeenCalledOnce();
    expect(
      Peer.last.dc.sent.filter(
        (event) =>
          (event.item as { call_id?: string })?.call_id === "corrected-call",
      ),
    ).toHaveLength(1);
    expect(
      f.api.mock.calls.filter(([path]) => path.endsWith("/tool")),
    ).toHaveLength(0);
  });
  it("stops repeated argument corrections within a user turn and restores actions only for a new user turn", async () => {
    allowPage();
    session = new QwenRealtimeVoiceSession(callbacks());
    await session.start(options);
    await ready();
    for (let attempt = 1; attempt <= 2; attempt++) {
      pageResponse(
        "page_click",
        { snapshotId: "s" },
        `bad-${attempt}`,
        `bad-call-${attempt}`,
      );
      await vi.waitFor(() =>
        expect(pageOutput(`bad-call-${attempt}`)).toMatchObject({
          dispatched: false,
          code: "PAGE_TOOL_ARGUMENTS",
          retryable: attempt === 1,
        }),
      );
    }
    const stopped = {
      dispatched: false,
      code: "PAGE_TOOL_ARGUMENTS",
      retryable: false,
      text: "本轮参数修正仍未成功，停止重复尝试，等待用户新的指令",
    };
    expect(pageOutput("bad-call-2")).toEqual(stopped);
    pageResponse("page_observe", {}, "observe", "observe-call");
    await vi.waitFor(() =>
      expect(pageOutput("observe-call")).toEqual(observation),
    );
    pageResponse(
      "page_click",
      { snapshotId: "s", ref: "r" },
      "blocked",
      "blocked-call",
    );
    await vi.waitFor(() => expect(pageOutput("blocked-call")).toEqual(stopped));
    expect(f.action).not.toHaveBeenCalled();
    expect(Peer.last.dc.readyState).toBe("open");
    toolResponse("business", "business-call");
    done("business");
    await vi.waitFor(() =>
      expect(pageOutput("business-call")).toMatchObject({ text: "已完成" }),
    );
    Peer.last.dc.emit({
      type: "input_audio_buffer.speech_started",
      item_id: "new-user",
    });
    Peer.last.dc.emit({
      type: "input_audio_buffer.speech_stopped",
      item_id: "new-user",
    });
    pageResponse(
      "page_click",
      { snapshotId: "s", ref: "r" },
      "new-turn",
      "new-turn-call",
    );
    await vi.waitFor(() =>
      expect(pageOutput("new-turn-call")).toMatchObject({ dispatched: true }),
    );
    expect(f.action).toHaveBeenCalledOnce();
  });
  it.each([
    ["malformed JSON", '{"ref":"PRIVATE_INPUT",', "合法 JSON"],
    [
      "non-string arguments",
      { snapshotId: "s", ref: "PRIVATE_INPUT" },
      "arguments 必须",
    ],
    [
      "double-encoded JSON",
      JSON.stringify(JSON.stringify({ snapshotId: "s", ref: "PRIVATE_INPUT" })),
      "单层 JSON 对象",
    ],
    ["array", JSON.stringify(["PRIVATE_INPUT"]), "JSON 对象"],
    ["null", "null", "JSON 对象"],
  ])(
    "rejects %s safely before any page mutation",
    async (_kind, args, message) => {
      allowPage();
      const cb = callbacks();
      session = new QwenRealtimeVoiceSession(cb);
      await session.start(options);
      await ready();
      rawPageResponse("page_click", args);
      await vi.waitFor(() =>
        expect(pageOutput()).toMatchObject({
          dispatched: false,
          code: "PAGE_TOOL_ARGUMENTS",
          retryable: true,
          text: expect.stringContaining(message),
        }),
      );
      expect(pageOutput().text).not.toContain("PRIVATE_INPUT");
      expect(cb.preparePage).not.toHaveBeenCalled();
      expect(f.action).not.toHaveBeenCalled();
      expect(Peer.last.dc.readyState).toBe("open");
    },
  );
  it("uses complete done arguments once despite deltas, duplicate done events and duplicate response completion", async () => {
    allowPage();
    session = new QwenRealtimeVoiceSession(callbacks());
    await session.start(options);
    await ready();
    const dc = Peer.last.dc;
    dc.emit({ type: "response.created", response: { id: "r" } });
    for (const delta of ['{"snapshotId":"wrong",', '"ref":"wrong"}'])
      dc.emit({
        type: "response.function_call_arguments.delta",
        response_id: "r",
        call_id: "c",
        name: "page_click",
        delta,
      });
    const completed = {
      type: "response.function_call_arguments.done",
      response_id: "r",
      call_id: "c",
      name: "page_click",
      arguments: JSON.stringify({ snapshotId: "snapshot-1", ref: "control-1" }),
    };
    dc.emit({ ...completed, event_id: "done-a" });
    dc.emit({
      ...completed,
      event_id: "done-b",
      arguments: JSON.stringify({ snapshotId: "different", ref: "different" }),
    });
    await settle();
    expect(f.action).not.toHaveBeenCalled();
    done("r");
    done("r");
    dc.emit({ ...completed, event_id: "late-done" });
    await vi.waitFor(() =>
      expect(pageOutput("c")).toMatchObject({ dispatched: true }),
    );
    expect(f.action).toHaveBeenCalledExactlyOnceWith(
      { snapshotId: "snapshot-1", ref: "control-1", action: "click" },
      expect.any(Object),
    );
    expect(
      dc.sent.filter(
        (event) => (event.item as { call_id?: string })?.call_id === "c",
      ),
    ).toHaveLength(1);
    expect(
      dc.sent.filter((event) => event.type === "response.create"),
    ).toHaveLength(1);
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
        code: "PAGE_TOOL_ARGUMENTS",
        retryable: true,
        text: expect.stringContaining("不接受的字段"),
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
      pageResponse("page_click", {
        snapshotId: "s",
        ref: "r",
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

import { api } from "./api.js";
import {
  qwenRealtimeModel,
  isRealtimeToolName,
  type RealtimeToolName,
  type RealtimeToolResult,
} from "../../../packages/contracts/src/assistant-realtime.js";
import { assistantPublicText } from "../../../packages/contracts/src/ai-presentation.js";
import {
  isPageToolName,
  isPageTaskToolName,
  pageTaskStartSchema,
  pageTaskFinishSchema,
  pageWaitSchema,
  parsePageToolArguments,
  pageToolArgumentError,
  type PageObserveInput,
  type PageActionInput,
  type PageToolName,
  type PageTaskToolName,
  type PageObservation,
} from "../../../packages/contracts/src/assistant-page.js";
import { RealtimePageController } from "./realtime-page-controller.js";
import type {
  RealtimeCallbacks,
  RealtimeCaption,
  RealtimeOptions,
} from "./realtime-voice-session.js";

type Configuration = {
  type: "session.update";
  session: { audio: { output: { voice: string } } };
};
type Event = {
  type?: string;
  event_id?: string;
  session?: {
    id?: string;
    model?: string;
    voice?: string;
    audio?: { output?: { voice?: string } };
  };
  response?: { id?: string; status?: string };
  response_id?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  arguments?: unknown;
  delta?: string;
  transcript?: string;
  text?: string;
  error?: { code?: string; message?: string };
};
type Tool = {
  callId: string;
  name: RealtimeToolName | PageToolName | PageTaskToolName;
  args: unknown;
};
type Response = {
  turn: number;
  epoch: number;
  user: string;
  canceled: boolean;
  done: boolean;
  tools: Tool[];
  cancel: AbortController;
};
type Caption = RealtimeCaption & {
  key: string;
  user: string;
  response?: string;
  final: boolean;
  saved: boolean;
};
type PageTask = {
  goal: string;
  turn: number;
  epoch: number;
  status: "active" | "paused" | "completed" | "needs_user";
  actionCount: number;
  toolCount: number;
  idleNudges: number;
  finishFailures: number;
};
const isLocalPageTool = (name: unknown) =>
  isPageToolName(name) || isPageTaskToolName(name);
const pageArgumentRetryStopped =
  "本轮参数修正仍未成功，停止重复尝试，等待用户新的指令";

/** Qwen media travels directly over RTP. Only SDP and authenticated business
 * operations use the application server; no provider credential enters this class. */
export class QwenRealtimeVoiceSession {
  readonly id = crypto.randomUUID();
  private pc?: RTCPeerConnection;
  private sender?: RTCRtpSender;
  private stream?: MediaStream;
  private audio?: HTMLAudioElement;
  private channels = new Set<RTCDataChannel>();
  private dc?: RTCDataChannel;
  private configuration?: Configuration;
  private page?: RealtimePageController;
  private pageTaskControl = false;
  private pageTask?: PageTask;
  private latestObservation?: PageObservation;
  private created = false;
  private updateSent = false;
  private attaching = false;
  private ready = false;
  private closed = false;
  private registered = false;
  private muted = false;
  private talking = false;
  private speaking = false;
  private allowResponse = true;
  private turn = 0;
  private epoch = 0;
  private user = "";
  private activeResponse = "";
  private responses = new Map<string, Response>();
  private toolIds = new Set<string>();
  private eventIds = new Set<string>();
  private businessUsers = new Set<string>();
  private captions: Caption[] = [];
  private pendingTools = 0;
  private pageArgumentFailures = 0;
  private toolQueue: Promise<void> = Promise.resolve();
  private saving = false;
  private healthBusy = false;
  private request = new AbortController();
  private connectTimer?: ReturnType<typeof setTimeout>;
  private disconnectTimer?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(private cb: RealtimeCallbacks) {}
  private path(suffix = "") {
    return `/my-workspace/assistant/realtime/sessions/${this.id}${suffix}`;
  }
  private phase() {
    if (this.closed || !this.ready) return;
    this.cb.state(
      this.talking
        ? "listening"
        : this.speaking
          ? "speaking"
          : this.activeResponse || this.pendingTools || this.activePageTask()
            ? "thinking"
            : "listening",
    );
  }
  private sendEvent(event: object) {
    if (this.closed) return false;
    if (this.dc?.readyState !== "open") {
      this.fail("实时通话连接已中断，请重新开始");
      return false;
    }
    try {
      if (this.dc.bufferedAmount > 256 * 1024)
        throw Error("data channel congestion");
      this.dc.send(JSON.stringify(event));
      return true;
    } catch {
      this.fail("实时通话指令发送失败，请重新开始");
      return false;
    }
  }
  private initialize() {
    if (
      this.closed ||
      this.updateSent ||
      !this.created ||
      !this.configuration ||
      this.pc?.connectionState !== "connected" ||
      this.dc?.readyState !== "open"
    )
      return;
    this.updateSent = true;
    this.sendEvent(this.configuration);
  }
  private bind(channel: RTCDataChannel) {
    if (this.closed) {
      channel.close();
      return;
    }
    this.channels.add(channel);
    channel.onopen = () => this.initialize();
    channel.onmessage = (event) => {
      void this.event(String(event.data), channel).catch(() => {
        this.fail("实时通话处理异常，请重新开始");
      });
    };
    channel.onerror = () => {
      if (channel === this.dc) this.fail("实时通话连接发生错误，请重新开始");
    };
    channel.onclose = () => {
      this.channels.delete(channel);
      if (!this.closed && channel === this.dc)
        this.fail("实时通话已断开，请重新开始");
    };
    if (channel.readyState === "open") this.initialize();
  }
  private waitForIce(pc: RTCPeerConnection) {
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", check);
        this.request.signal.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === "complete") finish();
      };
      const cancel = () => finish(Error("通话已结束"));
      const timer = setTimeout(
        () => finish(Error("实时音频连接准备超时，请重新开始")),
        15000,
      );
      pc.addEventListener("icegatheringstatechange", check);
      this.request.signal.addEventListener("abort", cancel, { once: true });
      if (this.closed) cancel();
      else check();
    });
  }
  private current(id: string) {
    const response = this.responses.get(id);
    return (
      !this.closed &&
      !!response &&
      !response.canceled &&
      response.turn === this.turn &&
      response.epoch === this.epoch
    );
  }
  private activePageTask() {
    const task = this.pageTask;
    return task?.status === "active" &&
      task.turn === this.turn &&
      task.epoch === this.epoch
      ? task
      : undefined;
  }
  private taskSummary() {
    const task = this.pageTask;
    return task
      ? {
          goal: task.goal,
          status: task.status,
          actionCount: task.actionCount,
          toolCount: task.toolCount,
        }
      : undefined;
  }
  private pausePageTask(message: string) {
    const task = this.activePageTask();
    if (!task) return;
    task.status = "needs_user";
    this.cb.note(message);
  }
  private taskResult(result: unknown) {
    return this.pageTask && result && typeof result === "object"
      ? { ...result, task: this.taskSummary() }
      : result;
  }
  private invalidate(cancel = true) {
    if (this.activePageTask()) {
      this.pageTask!.status = "paused";
      this.cb.note("网页任务已暂停，等待你的新指令。");
    }
    this.latestObservation = undefined;
    this.epoch++;
    for (const [id, response] of this.responses) {
      if (response.turn !== this.turn) continue;
      response.canceled = true;
      response.cancel.abort();
      this.captions
        .filter((item) => item.response === id)
        .forEach((item) => {
          item.saved = true;
        });
    }
    this.allowResponse = false;
    if (cancel && this.activeResponse && this.ready)
      this.sendEvent({ type: "response.cancel" });
    this.activeResponse = "";
    this.speaking = false;
    // Muting the remote element immediately silences any RTP playback tail.
    // It is restored only when a new, accepted response arrives.
    if (this.audio) this.audio.muted = true;
  }
  private caption(
    key: string,
    role: "user" | "assistant",
    text: string,
    final: boolean,
    user: string,
    response?: string,
    append = false,
  ) {
    let item = this.captions.find((value) => value.key === key);
    if (!item) {
      item = {
        id: crypto.randomUUID(),
        key,
        role,
        text: "",
        user,
        response,
        final: false,
        saved: false,
      };
      this.captions.push(item);
      this.captions = this.captions.slice(-40);
    }
    item.text = (append ? item.text + text : text || item.text).slice(0, 12000);
    item.final = final;
    this.cb.captions(
      this.captions
        .filter((value) => value.text)
        .map(({ id, role: r, text: t }) => ({
          id,
          role: r,
          text: r === "assistant" ? assistantPublicText(t) : t,
        })),
    );
  }
  private async flush() {
    if (
      !this.registered ||
      this.saving ||
      this.activeResponse ||
      this.pendingTools
    )
      return;
    const completed = new Set(
      this.captions
        .filter((item) => item.role === "assistant" && item.final)
        .map((item) => item.user),
    );
    const eligible = this.captions.filter(
      (item) =>
        item.final &&
        !item.saved &&
        item.text &&
        !this.businessUsers.has(item.user) &&
        completed.has(item.user),
    );
    const batch: Caption[] = [];
    let bytes = 32;
    for (const item of eligible) {
      const size =
        new TextEncoder().encode(
          JSON.stringify({ id: item.id, role: item.role, text: item.text }),
        ).length + 1;
      if (bytes + size > 48000) break;
      bytes += size;
      batch.push(item);
    }
    if (!batch.length) return;
    this.saving = true;
    try {
      await api(
        this.path("/captions"),
        "POST",
        { messages: batch.map(({ id, role, text }) => ({ id, role, text })) },
        undefined,
        { keepalive: this.closed },
      );
      batch.forEach((item) => {
        item.saved = true;
      });
      this.cb.result();
    } catch {
      if (!this.closed)
        this.cb.note(
          "通话字幕暂未保存，可在本轮字幕中查看；业务结果以任务记录为准",
        );
    } finally {
      this.saving = false;
    }
    if (batch.every((item) => item.saved) && eligible.length > batch.length)
      void this.flush();
  }
  private waitForPage(signal: AbortSignal, frame = false, delay = 25) {
    return new Promise<void>((resolve, reject) => {
      let raf: number | undefined;
      const finish = () => {
        clearTimeout(timer);
        if (raf !== undefined) cancelAnimationFrame(raf);
        signal.removeEventListener("abort", abort);
        if (signal.aborted)
          reject(new DOMException("操作已取消", "AbortError"));
        else resolve();
      };
      const abort = () => finish();
      const timer = setTimeout(finish, frame ? 60 : delay);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) finish();
      else if (frame && typeof requestAnimationFrame === "function")
        raf = requestAnimationFrame(finish);
    });
  }
  private async preparePage(id: string, response: Response) {
    this.cb.preparePage?.();
    // React must commit the collapsed assistant drawer before the DOM snapshot.
    // Its exit animation must not turn covered controls into click targets.
    await this.waitForPage(response.cancel.signal, true);
    await this.waitForPage(response.cancel.signal, true);
    const deadline = performance.now() + 350;
    while (
      this.current(id) &&
      typeof document !== "undefined" &&
      performance.now() < deadline
    ) {
      const covered = [
        ...document.querySelectorAll<HTMLElement>(
          ".personal-assistant-drawer .ant-drawer-mask, .personal-assistant-drawer .ant-drawer-content-wrapper",
        ),
      ].some((element) => {
        const style = getComputedStyle(element),
          rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) > 0 &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left < innerWidth &&
          rect.right > 0 &&
          rect.top < innerHeight &&
          rect.bottom > 0
        );
      });
      if (!covered) break;
      await this.waitForPage(response.cancel.signal);
    }
    if (!this.current(id)) throw new DOMException("操作已取消", "AbortError");
  }
  private async observeReady(id: string, response: Response, query?: string) {
    const deadline = performance.now() + 3000;
    let observation = this.page!.observe(query);
    while (observation.ready === false && performance.now() < deadline) {
      if (!this.current(id)) throw new DOMException("操作已取消", "AbortError");
      await this.waitForPage(response.cancel.signal);
      if (!this.current(id)) throw new DOMException("操作已取消", "AbortError");
      observation = this.page!.observe(query);
    }
    if (!this.current(id)) throw new DOMException("操作已取消", "AbortError");
    this.latestObservation = observation;
    return observation;
  }
  private async executeTools(id: string, response: Response) {
    const outputs: { callId: string; result: unknown }[] = [];
    const pageBatch =
      !!this.activePageTask() ||
      response.tools.some((tool) => isLocalPageTool(tool.name));
    let resume = true;
    let businessMarked = false;
    try {
      for (const [index, tool] of response.tools.entries()) {
        if (!this.current(id)) return;
        if (pageBatch && index > 0) {
          outputs.push({
            callId: tool.callId,
            result: this.taskResult({
              dispatched: false,
              code: "PAGE_STEP_DEFERRED",
              text: "本步骤尚未执行。请先读取前一步的实际结果，再使用最新观察为下一步单独调用工具；不要重放旧快照或猜测引用。",
            }),
          });
          continue;
        }
        const task = this.activePageTask();
        if (task && task.toolCount >= 60) {
          this.pausePageTask(
            "本次连续操作已达到保护上限，未确认全部完成。请给出新的指令后继续。",
          );
          outputs.push({
            callId: tool.callId,
            result: this.taskResult({
              dispatched: false,
              code: "PAGE_TASK_LIMIT",
              text: "本次连续操作已达到保护上限，停止自动执行，等待用户新的指令。",
            }),
          });
          resume = false;
          continue;
        }
        if (task) {
          task.toolCount++;
          task.idleNudges = 0;
        }
        const stoppedThisTurn =
          this.pageTask &&
          this.pageTask.turn === this.turn &&
          this.pageTask.status !== "active";
        if (stoppedThisTurn) resume = false;
        if (stoppedThisTurn && !isLocalPageTool(tool.name)) {
          outputs.push({
            callId: tool.callId,
            result: this.taskResult({
              dispatched: false,
              code: "PAGE_TASK_STOPPED",
              text: "本轮网页任务已停止，不再执行后续步骤，等待用户新的指令。",
            }),
          });
          continue;
        }
        let result: unknown;
        let navigation: string | undefined;
        let pageActionAttempted = false;
        let pageArgumentsInvalid = false;
        try {
          if (isLocalPageTool(tool.name)) {
            if (!this.page)
              throw Error(
                "本次通话未启用网站内操作，请在网站内模式重新开始通话",
              );
            if (isPageTaskToolName(tool.name) && !this.pageTaskControl)
              throw Error("本次通话未启用连续网页任务，请重新开始通话");
            if (
              this.pageTaskControl &&
              tool.name !== "page_observe" &&
              tool.name !== "page_task_start" &&
              !task
            ) {
              outputs.push({
                callId: tool.callId,
                result: this.taskResult({
                  dispatched: false,
                  code: "PAGE_TASK_REQUIRED",
                  text: stoppedThisTurn
                    ? "本轮任务已停止，等待用户新的指令；不要继续执行或重放动作。"
                    : "尚未建立本轮网页任务。请先用 page_task_start 理解并记录用户本轮完整目标，再根据真实页面逐步执行；不要从零散语音或控件名称猜测目标。",
                }),
              });
              continue;
            }
            pageArgumentsInvalid = true;
            if (tool.name !== "page_observe" && this.pageArgumentFailures >= 2)
              throw Error(pageArgumentRetryStopped);
            // The provider's done.arguments is the sole complete payload. Do
            // not concatenate deltas, coerce objects, or recursively decode JSON.
            if (typeof tool.args !== "string")
              throw Error(
                "工具调用的 arguments 必须是 JSON 字符串，请自行按工具字段修正后重新调用，未执行页面操作。",
              );
            let args: unknown;
            try {
              args = JSON.parse(tool.args);
            } catch {
              throw Error(
                "工具参数不是合法 JSON，请重新生成完整参数对象，未执行页面操作。",
              );
            }
            if (!args || typeof args !== "object" || Array.isArray(args))
              throw Error(
                typeof args === "string"
                  ? "工具参数必须是单层 JSON 对象，不能将对象再次编码为字符串；请自行修正后重新调用，未执行页面操作。"
                  : "工具参数必须是 JSON 对象，不接受数组或空值；请自行修正后重新调用，未执行页面操作。",
              );
            if (isPageTaskToolName(tool.name)) {
              if (tool.name === "page_task_start") {
                const parsed = pageTaskStartSchema.safeParse(args);
                if (!parsed.success)
                  throw Error(
                    "page_task_start 只接受必填的完整目标 goal 字符串，请按工具字段修正，不猜测或扩大用户意图。",
                  );
                pageArgumentsInvalid = false;
                if (stoppedThisTurn) {
                  result = {
                    dispatched: false,
                    code: "PAGE_TASK_STOPPED",
                    text: "本轮任务已停止，等待用户新的指令后才能建立任务。",
                  };
                } else {
                  if (!task)
                    this.pageTask = {
                      goal: parsed.data.goal,
                      turn: this.turn,
                      epoch: this.epoch,
                      status: "active",
                      actionCount: 0,
                      toolCount: 1,
                      idleNudges: 0,
                      finishFailures: 0,
                    };
                  await this.preparePage(id, response);
                  const observation = await this.observeReady(id, response);
                  result = {
                    observation,
                    text: "已记录本轮目标。请依据当前真实页面逐步执行，每次只调用一个下一步；完成或确需用户操作时，用最新快照和可见证据调用 page_task_finish。",
                  };
                }
              } else if (tool.name === "page_wait") {
                const parsed = pageWaitSchema.safeParse(args);
                if (!parsed.success)
                  throw Error(
                    "page_wait 只接受必填 seconds 整数，范围1至10秒；不要传其他字段。",
                  );
                pageArgumentsInvalid = false;
                await this.waitForPage(
                  response.cancel.signal,
                  false,
                  parsed.data.seconds * 1000,
                );
                if (!this.current(id)) return;
                await this.preparePage(id, response);
                result = {
                  observation: await this.observeReady(id, response),
                  text: "等待结束，已重新观察当前页面。请根据实际进展继续原目标，不重复点击来猜进度。",
                };
              } else {
                const parsed = pageTaskFinishSchema.safeParse(args);
                if (!parsed.success)
                  throw Error(
                    "page_task_finish 必须提供 outcome（completed或needs_user）、summary、最新 snapshotId 和页面原文 evidence；不要猜测证据或传其他字段。",
                  );
                pageArgumentsInvalid = false;
                const input = parsed.data;
                const observed = this.latestObservation;
                const normalized = (value: string) =>
                  value.replace(/\s+/g, "").toLowerCase();
                const evidence = normalized(input.evidence);
                const sources = observed
                  ? [
                      observed.path,
                      observed.pageName || "",
                      ...observed.text.split("\n"),
                      ...observed.controls.map((control) => control.name),
                    ]
                  : [];
                const snapshotValid = !!(
                  observed &&
                  observed.ready !== false &&
                  observed.snapshotId === input.snapshotId &&
                  this.page.currentSnapshot(input.snapshotId)
                );
                const matchesObserved =
                  evidence.length >= 2 &&
                  sources.some((source) =>
                    normalized(source).includes(evidence),
                  );
                if (
                  !snapshotValid ||
                  !matchesObserved ||
                  !this.page.currentEvidence(input.snapshotId, input.evidence)
                ) {
                  task!.finishFailures++;
                  if (task!.finishFailures >= 3) {
                    const text =
                      "任务结果连续三次未能核验，已暂停自动重试。请确认当前页面后给出新的指令。";
                    this.pausePageTask(text);
                    result = {
                      dispatched: false,
                      code: "PAGE_TASK_VERIFICATION_LIMIT",
                      retryable: false,
                      finishAttemptsRemaining: 0,
                      text,
                    };
                  } else if (!snapshotValid) {
                    result = {
                      dispatched: false,
                      code: "PAGE_TASK_SNAPSHOT",
                      retryable: true,
                      finishAttemptsRemaining: 3 - task!.finishFailures,
                      text: "提交的 snapshotId 已失效、页面尚未就绪或不是最近一次观察。请重新调用 page_observe 获取当前快照，再依据其真实结果核验；不要猜测或替换快照引用。",
                    };
                  } else if (matchesObserved) {
                    this.latestObservation = undefined;
                    result = {
                      dispatched: false,
                      code: "PAGE_TASK_EVIDENCE",
                      reason: "changed",
                      retryable: true,
                      finishAttemptsRemaining: 3 - task!.finishFailures,
                      text: "提交的证据曾出现在观察中，但现场内容已经变化，不能沿用旧结论，也不能改用其他页名或控件代替。请重新调用 page_observe 核对当前结果，再按新观察决定继续操作或结束任务。",
                    };
                  } else {
                    const evidenceCandidates: string[] = [];
                    const seen = new Set<string>();
                    for (const source of [
                      observed!.pageName || "",
                      ...observed!.text.split("\n"),
                      ...observed!.controls.map((control) => control.name),
                      observed!.path,
                    ].slice(0, 30)) {
                      const candidate = source.trim().slice(0, 180);
                      const key = normalized(candidate);
                      if (key.length < 2 || seen.has(key)) continue;
                      seen.add(key);
                      if (
                        this.page.currentEvidence(input.snapshotId, candidate)
                      )
                        evidenceCandidates.push(candidate);
                      if (evidenceCandidates.length >= 5) break;
                    }
                    result = {
                      dispatched: false,
                      code: "PAGE_TASK_EVIDENCE",
                      reason: "format",
                      retryable: true,
                      finishAttemptsRemaining: 3 - task!.finishFailures,
                      evidenceCandidates,
                      text: evidenceCandidates.length
                        ? "当前快照引用有效。evidence 只能复制一处连续原文，不要拼接多个标题、日期或控件。可从 evidenceCandidates 原样选一条，页面未变化时不必反复 page_observe。候选仅说明原文仍可引用；必须先根据完整观察确认整个目标已达到，否则继续操作，不能只凭候选宣称完成。"
                        : "当前快照引用有效，但提交的证据不再是现场可核验的连续原文，也没有仍有效的原文候选。页面内容可能已变化，请重新观察一次；之后只复制一处连续原文，不拼接多个标题或控件。",
                    };
                  }
                } else {
                  task!.status = input.outcome;
                  result = {
                    observation: observed,
                    text: assistantPublicText(input.summary),
                  };
                  if (input.outcome === "needs_user")
                    this.cb.note(
                      `任务需要你操作：${assistantPublicText(input.summary)}`,
                    );
                }
              }
            } else {
              const parsed = parsePageToolArguments(
                tool.name as PageToolName,
                args,
              );
              if (!parsed.success)
                throw Error(
                  pageToolArgumentError(
                    tool.name as PageToolName,
                    parsed.error,
                  ),
                );
              pageArgumentsInvalid = false;
              await this.preparePage(id, response);
              if (tool.name === "page_observe") {
                const query = (parsed.data as PageObserveInput).query;
                result = await this.observeReady(id, response, query);
              } else {
                pageActionAttempted = true;
                const action = await this.page.action(
                  parsed.data as PageActionInput,
                  {
                    signal: response.cancel.signal,
                    isCurrent: () => this.current(id),
                  },
                );
                if (!this.current(id)) return;
                this.latestObservation = action.observation;
                if (task && action.dispatched) {
                  task.actionCount++;
                  task.finishFailures = 0;
                }
                result = action;
              }
            }
          } else {
            const args: unknown = JSON.parse(String(tool.args));
            const request =
              args && typeof args === "object"
                ? (args as { request?: unknown }).request
                : undefined;
            if (typeof request !== "string")
              throw Error("语音操作参数不完整，请重新描述");
            if (!businessMarked) {
              this.businessUsers.add(response.user);
              this.cb.business();
              businessMarked = true;
            }
            const business = (
              await api(
                this.path("/tool"),
                "POST",
                {
                  callId: tool.callId,
                  request,
                  tool: tool.name,
                },
                undefined,
                { signal: AbortSignal.timeout(180000) },
              )
            ).data as RealtimeToolResult;
            result = business;
            navigation = business.navigation;
            this.cb.result();
          }
        } catch (error) {
          if (pageArgumentsInvalid)
            this.pageArgumentFailures = Math.min(
              2,
              this.pageArgumentFailures + 1,
            );
          result = {
            ...(isLocalPageTool(tool.name)
              ? { dispatched: pageActionAttempted ? null : false }
              : {}),
            ...(pageArgumentsInvalid
              ? {
                  code: "PAGE_TOOL_ARGUMENTS",
                  retryable: this.pageArgumentFailures < 2,
                }
              : {}),
            text:
              pageArgumentsInvalid && this.pageArgumentFailures >= 2
                ? pageArgumentRetryStopped
                : pageActionAttempted
                  ? "页面操作结果暂未确认，请先重新观察页面，避免重复提交。"
                  : (error as Error).name === "TimeoutError"
                    ? "等待操作结果超时，请在任务或完整对话中核验，不要重复提交"
                    : assistantPublicText((error as Error).message),
          };
          if (pageArgumentsInvalid && this.pageArgumentFailures >= 2)
            this.pausePageTask(pageArgumentRetryStopped);
        }
        // An already submitted action remains in the task record, but its old
        // speech/navigation must never resume after interruption or closure.
        if (!this.current(id)) return;
        if (navigation) this.cb.navigate(navigation);
        outputs.push({ callId: tool.callId, result: this.taskResult(result) });
      }
      for (const output of outputs) {
        if (!this.current(id)) return;
        if (
          !this.sendEvent({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: output.callId,
              output: JSON.stringify(output.result),
            },
          })
        )
          return;
      }
      if (resume && outputs.length && this.current(id)) {
        this.allowResponse = true;
        this.sendEvent({ type: "response.create" });
      }
    } finally {
      this.pendingTools -= response.tools.length;
      this.phase();
    }
  }
  private async event(raw: string, channel: RTCDataChannel) {
    if (this.closed || raw.length > 1000000) return;
    let event: Event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    if (event.event_id) {
      if (this.eventIds.has(event.event_id)) return;
      this.eventIds.add(event.event_id);
      if (this.eventIds.size > 1024)
        this.eventIds.delete(this.eventIds.values().next().value!);
    }
    if (event.type === "session.created") {
      if (!this.created) {
        this.created = true;
        this.dc = channel;
      }
      this.initialize();
      return;
    }
    if (event.type === "session.updated") {
      if (!this.updateSent || this.ready || this.attaching) return;
      const session = event.session;
      if (
        !session?.id ||
        (session.model && session.model !== qwenRealtimeModel) ||
        (session.audio?.output?.voice ?? session.voice) !==
          this.configuration?.session.audio.output.voice
      ) {
        this.fail("实时语音返回与配置不一致，通话已停止");
        return;
      }
      this.attaching = true;
      const track = this.stream?.getAudioTracks()[0];
      if (!track || !this.sender) throw Error("missing microphone");
      track.enabled = !this.muted;
      await this.sender.replaceTrack(track);
      if (this.closed) {
        track.stop();
        return;
      }
      this.ready = true;
      track.enabled = !this.muted;
      clearTimeout(this.connectTimer);
      this.cb.note("实时通话中，可以随时开口打断小序");
      this.phase();
      return;
    }
    if (event.type === "error") {
      const code = String(event.error?.code || "");
      if (
        [
          "response_cancel_not_active",
          "input_audio_buffer_commit_empty",
          "conversation_already_has_active_response",
        ].includes(code)
      )
        return;
      this.fail(
        /FreeTierOnly|Quota|Balance|Arrearage|RateLimit|rate_limit/i.test(
          `${code} ${event.error?.message || ""}`,
        )
          ? "实时语音额度不足或请求受限，请检查免费额度及停用设置"
          : "实时语音服务返回错误，请结束后重试或检查设置",
      );
      return;
    }
    if (event.type === "session.closed") {
      this.stop();
      return;
    }
    if (!this.ready) return;
    if (event.type === "input_audio_buffer.speech_started") {
      this.invalidate();
      this.turn++;
      this.pageArgumentFailures = 0;
      this.user = String(event.item_id || crypto.randomUUID());
      this.talking = true;
      for (const [id, response] of this.responses)
        if (response.turn < this.turn - 40) this.responses.delete(id);
      this.phase();
      return;
    }
    if (event.type === "input_audio_buffer.speech_stopped") {
      this.talking = false;
      this.allowResponse = true;
      this.phase();
      return;
    }
    if (
      event.type === "conversation.item.input_audio_transcription.completed"
    ) {
      if (typeof event.transcript === "string") {
        const user = String(event.item_id || this.user);
        this.caption(
          `user:${user}`,
          "user",
          event.transcript.trim(),
          true,
          user,
        );
        void this.flush();
      }
      return;
    }
    if (event.type === "response.created") {
      const id = event.response?.id;
      if (!id || this.responses.has(id)) return;
      this.responses.set(id, {
        turn: this.turn,
        epoch: this.epoch,
        user: this.user,
        canceled: !this.allowResponse,
        done: false,
        tools: [],
        cancel: new AbortController(),
      });
      if (!this.allowResponse) {
        this.sendEvent({ type: "response.cancel" });
        return;
      }
      this.activeResponse = id;
      if (this.audio) this.audio.muted = false;
      this.phase();
      return;
    }
    const id = event.response_id || event.response?.id || "";
    if (!this.current(id)) return;
    const response = this.responses.get(id)!;
    switch (event.type) {
      case "response.audio_transcript.delta":
      case "response.text.delta":
        if (typeof event.delta === "string") {
          this.speaking = event.type === "response.audio_transcript.delta";
          this.caption(
            `assistant:${id}`,
            "assistant",
            event.delta,
            false,
            response.user,
            id,
            true,
          );
          this.phase();
        }
        break;
      case "response.audio_transcript.done":
      case "response.text.done":
        this.caption(
          `assistant:${id}`,
          "assistant",
          event.transcript || event.text || "",
          true,
          response.user,
          id,
        );
        break;
      case "response.function_call_arguments.done":
        if (
          (!isRealtimeToolName(event.name) &&
            !isPageToolName(event.name) &&
            !isPageTaskToolName(event.name)) ||
          typeof event.call_id !== "string" ||
          this.toolIds.has(event.call_id) ||
          response.done
        )
          return;
        if (response.tools.length >= 8) {
          this.fail("本轮语音操作过多，请重新开始");
          return;
        }
        this.toolIds.add(event.call_id);
        response.tools.push({
          callId: event.call_id,
          name: event.name,
          args: event.arguments,
        });
        break;
      case "response.done":
        if (response.done) return;
        response.done = true;
        if (this.activeResponse === id) this.activeResponse = "";
        this.speaking = false;
        if (event.response?.status === "failed") {
          this.fail("实时回复未完成，请检查语音服务后重新开始");
          return;
        }
        if (
          ["cancelled", "canceled"].includes(String(event.response?.status))
        ) {
          response.canceled = true;
          this.phase();
          return;
        }
        if (response.tools.length) {
          this.pendingTools += response.tools.length;
          this.toolQueue = this.toolQueue
            .then(() => this.executeTools(id, response))
            .catch(() =>
              this.fail("语音操作处理异常，请查看任务记录后重新开始"),
            );
        } else {
          const task = this.activePageTask();
          if (task && this.current(id) && !this.pendingTools) {
            if (task.idleNudges >= 2) {
              this.pausePageTask(
                "网页任务尚未确认完成，已停止重复口头续答。请给出新的指令后继续。",
              );
            } else {
              task.idleNudges++;
              this.allowResponse = true;
              // Qwen supports bare response.create; its persistent task rules
              // guide this continuation without fabricating a user message.
              this.sendEvent({ type: "response.create" });
            }
          }
        }
        this.phase();
        void this.flush();
        break;
    }
  }
  async start(options: RealtimeOptions) {
    this.cb.state("connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      if (this.closed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
        track.onended = () => this.fail("麦克风已断开，请重新连接后开始");
      });
      this.connectTimer = setTimeout(
        () => this.fail("实时语音连接超时，请检查网络后重试"),
        45000,
      );
      const pc = new RTCPeerConnection({ iceServers: [] });
      this.pc = pc;
      this.sender = pc.addTransceiver("audio", {
        direction: "sendrecv",
      }).sender;
      const audio = new Audio();
      audio.autoplay = true;
      this.audio = audio;
      pc.ontrack = ({ track, streams }) => {
        if (this.closed) return;
        audio.srcObject = streams[0] || new MediaStream([track]);
        void this.play();
      };
      pc.ondatachannel = ({ channel }) => this.bind(channel);
      pc.onconnectionstatechange = () => {
        if (this.closed) return;
        clearTimeout(this.disconnectTimer);
        if (pc.connectionState === "connected") this.initialize();
        else if (["failed", "closed"].includes(pc.connectionState))
          this.fail("实时音频连接已断开，请重新开始");
        else if (pc.connectionState === "disconnected")
          this.disconnectTimer = setTimeout(
            () => this.fail("实时音频网络连接已中断，请重新开始"),
            5000,
          );
      };
      this.bind(pc.createDataChannel("oai-events"));
      await pc.setLocalDescription(await pc.createOffer());
      if (this.closed) return;
      await this.waitForIce(pc);
      if (this.closed) return;
      const result = (
        await api(
          "/my-workspace/assistant/realtime/sessions",
          "POST",
          {
            id: this.id,
            sdp: pc.localDescription?.sdp,
            ...options,
          },
          undefined,
          { signal: AbortSignal.timeout(30000) },
        )
      ).data as {
        provider: string;
        sdp: string;
        configuration: Configuration;
        pageControl?: boolean;
        pageTaskControl?: boolean;
        expiresAt: string;
      };
      this.registered = true;
      if (this.closed) {
        await api(this.path("/close"), "POST", {}).catch(() => {});
        return;
      }
      if (
        result.provider !== "qwen" ||
        result.configuration?.type !== "session.update" ||
        !result.configuration.session?.audio?.output?.voice
      )
        throw Error("实时语音连接配置不完整，请重新开始");
      this.configuration = result.configuration;
      if (result.pageControl === true && !options.desktopDeviceId) {
        this.page = new RealtimePageController({
          navigate: this.cb.navigatePage,
        });
        this.pageTaskControl = result.pageTaskControl === true;
      }
      await pc.setRemoteDescription({
        type: "answer",
        sdp: String(result.sdp).trim().replace(/\r?\n/g, "\r\n") + "\r\n",
      });
      if (this.closed) return;
      this.initialize();
      const expiresIn = new Date(result.expiresAt).getTime() - Date.now();
      if (!Number.isFinite(expiresIn) || expiresIn <= 0)
        throw Error("实时通话已过期，请重新开始");
      this.expiry = setTimeout(
        () => this.stop("本次通话已到服务时限，点击即可重新开始"),
        expiresIn,
      );
      this.heartbeat = setInterval(() => {
        if (this.closed || this.healthBusy) return;
        this.healthBusy = true;
        void api(this.path(), "GET", undefined, undefined, {
          signal: AbortSignal.timeout(8000),
        })
          .then(() => this.flush())
          .catch(() => {
            if (!this.closed)
              this.fail("登录、通话设置或网络连接已变化，请重新开始");
          })
          .finally(() => {
            this.healthBusy = false;
          });
      }, 15000);
    } catch (error) {
      if (this.closed) return;
      const name = (error as Error).name;
      this.fail(
        name === "NotAllowedError"
          ? "麦克风权限被拒绝，请在浏览器或桌面客户端中允许后重试"
          : name === "NotFoundError"
            ? "未检测到麦克风，请连接后重试"
            : name === "NotReadableError"
              ? "麦克风被其他程序占用，请释放后重试"
              : name === "TimeoutError"
                ? "实时语音连接超时，请检查网络后重试"
                : assistantPublicText(
                    (error as Error).message || "实时语音连接失败",
                  ),
      );
    }
  }
  stop(reason = "语音已结束，麦克风已关闭") {
    if (this.closed) return;
    if (this.activeResponse) this.invalidate(false);
    this.closed = true;
    this.ready = false;
    this.epoch++;
    this.responses.forEach((response) => response.cancel.abort());
    this.page?.close();
    if (this.pageTask?.status === "active") this.pageTask.status = "paused";
    this.latestObservation = undefined;
    this.request.abort();
    clearTimeout(this.connectTimer);
    clearTimeout(this.disconnectTimer);
    clearTimeout(this.expiry);
    clearInterval(this.heartbeat);
    this.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.channels.forEach((channel) => channel.close());
    this.channels.clear();
    this.pc?.close();
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
    }
    this.activeResponse = "";
    void this.flush();
    void api(this.path("/close"), "POST", {}, undefined, {
      keepalive: true,
    }).catch(() => {});
    this.cb.state("idle");
    this.cb.blocked(false);
    this.cb.note(reason);
  }
  private fail(message: string) {
    if (this.closed) return;
    this.stop("");
    this.cb.error(message);
  }
  toggleMute() {
    this.muted = !this.muted;
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = this.ready && !this.muted;
    });
    if (this.ready && this.muted) {
      this.sendEvent({ type: "input_audio_buffer.clear" });
      this.talking = false;
    }
    this.phase();
    return this.muted;
  }
  interrupt() {
    this.invalidate();
    this.phase();
  }
  send() {
    if (this.ready) this.cb.note("说完后稍作停顿，小序会自动回应");
  }
  async play() {
    try {
      await this.audio?.play();
      if (!this.closed) this.cb.blocked(false);
    } catch {
      if (!this.closed) this.cb.blocked(true);
    }
  }
}

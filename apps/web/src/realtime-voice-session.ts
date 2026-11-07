import { api } from "./api.js";
import {
  realtimeModel,
  isRealtimeToolName,
  type RealtimeToolName,
  type RealtimeToolResult,
} from "../../../packages/contracts/src/assistant-realtime.js";
import { assistantPublicText } from "../../../packages/contracts/src/ai-presentation.js";

type VoiceState = "idle" | "connecting" | "listening" | "thinking" | "speaking";

export type RealtimeCaption = {
  id: string;
  role: "user" | "assistant";
  text: string;
};
export type RealtimeOptions = {
  includePersonalContext: boolean;
  includeMemory: boolean;
  desktopDeviceId?: string;
  model?: string;
};
export type RealtimeCallbacks = {
  state: (state: VoiceState) => void;
  captions: (captions: RealtimeCaption[]) => void;
  note: (text: string) => void;
  error: (text: string) => void;
  blocked: (blocked: boolean) => void;
  result: () => void;
  navigate: (id: string) => void;
  business: () => void;
  preparePage?: () => void;
  navigatePage?: (path: string) => void;
};
type CaptionItem = RealtimeCaption & {
  key: string;
  user?: string;
  response?: string;
  final?: boolean;
  saved?: boolean;
};
type RealtimeEvent = {
  type?: string;
  session?: { model?: string };
  response?: { id?: string; status?: string };
  item_id?: string;
  response_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  transcript?: string;
  delta?: string;
  error?: { code?: string };
};

// One owner for every media resource, even when getUserMedia/SDP returns after stop.
// Business execution stays behind the authenticated website API, never in a data channel.
export class RealtimeVoiceSession {
  readonly id = crypto.randomUUID();
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private audio?: HTMLAudioElement;
  private stream?: MediaStream;
  private closed = false;
  private ready = false;
  private registered = false;
  private muted = false;
  private talking = false;
  private responding = false;
  private playing = false;
  private heard = false;
  private lastUser = "";
  private items: CaptionItem[] = [];
  private handledUsers = new Set<string>();
  private responseUsers = new Map<string, string>();
  private interruptedResponses = new Set<string>();
  private currentResponse = "";
  private playingResponse = "";
  private toolIds = new Set<string>();
  private pendingTools = 0;
  private followup = false;
  private saving = false;
  private healthBusy = false;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private disconnectTimer?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private toolQueue: Promise<void> = Promise.resolve();

  constructor(private cb: RealtimeCallbacks) {}
  private path(suffix = "") {
    return `/my-workspace/assistant/realtime/sessions/${this.id}${suffix}`;
  }
  private sendEvent(event: object) {
    if (!this.closed && this.dc?.readyState === "open")
      this.dc.send(JSON.stringify(event));
  }
  private phase() {
    if (!this.closed)
      this.cb.state(
        this.talking
          ? "listening"
          : this.playing
            ? "speaking"
            : this.responding || this.pendingTools
              ? "thinking"
              : "listening",
      );
  }
  private addCaption(
    key: string,
    role: "user" | "assistant",
    text: string,
    final: boolean,
    user?: string,
    response?: string,
  ) {
    let item = this.items.find((v) => v.key === key);
    if (!item) {
      item = { id: crypto.randomUUID(), key, role, text: "", user };
      this.items.push(item);
      this.items = this.items.slice(-40);
    }
    item.text = (final ? text : item.text + text).slice(0, 12000);
    item.final = final;
    if (user) item.user = user;
    if (response) item.response = response;
    if (response && this.interruptedResponses.has(response)) item.saved = true;
    this.cb.captions(
      this.items
        .filter((i) => i.text)
        .map(({ id, role, text }) => ({
          id,
          role,
          text: role === "assistant" ? assistantPublicText(text) : text,
        })),
    );
  }
  private async flush() {
    if (
      !this.registered ||
      this.saving ||
      this.pendingTools ||
      this.responding ||
      this.playing
    )
      return;
    const completedUsers = new Set(
      this.items
        .filter((i) => i.role === "assistant" && i.final)
        .map((i) => i.user),
    );
    const eligible = this.items.filter(
      (i) =>
        i.final &&
        !i.saved &&
        i.text &&
        !this.handledUsers.has(i.role === "user" ? i.key : i.user || "") &&
        (i.role !== "user" || completedUsers.has(i.key)),
    );
    // Keep each final unload request below the browser's 64 KiB keepalive budget.
    const items: CaptionItem[] = [];
    let bytes = 32;
    for (const item of eligible) {
      const size =
        new TextEncoder().encode(
          JSON.stringify({ id: item.id, role: item.role, text: item.text }),
        ).length + 1;
      if (bytes + size > 48000) break;
      items.push(item);
      bytes += size;
    }
    if (!items.length) return;
    this.saving = true;
    try {
      await api(
        this.path("/captions"),
        "POST",
        {
          messages: items.map(({ id, role, text }) => ({ id, role, text })),
        },
        undefined,
        { keepalive: this.closed },
      );
      items.forEach((i) => {
        i.saved = true;
      });
      this.cb.result();
    } catch {
      this.cb.note(
        "通话字幕暂未保存，可在本轮字幕中查看；业务结果以任务记录为准",
      );
    } finally {
      this.saving = false;
    }
    if (items.every((i) => i.saved) && eligible.length > items.length)
      void this.flush();
  }
  private discardUnheard(response: string) {
    if (!response) return;
    this.interruptedResponses.add(response);
    this.items
      .filter((i) => i.response === response)
      .forEach((i) => {
        i.saved = true;
      });
  }
  private async executeTool(
    callId: string,
    args: string,
    user: string,
    tool: RealtimeToolName,
    response?: string,
  ) {
    if (this.closed) return;
    if (response && this.interruptedResponses.has(response)) {
      this.pendingTools--;
      this.phase();
      this.resumeToolResponse();
      return;
    }
    let result: RealtimeToolResult;
    try {
      const value = JSON.parse(args) as { request?: unknown };
      if (typeof value.request !== "string")
        throw Error("语音操作参数不完整，请重新描述");
      result = (
        await api(
          this.path("/tool"),
          "POST",
          { callId, request: value.request, tool },
          undefined,
          { signal: AbortSignal.timeout(180000) },
        )
      ).data as RealtimeToolResult;
      this.cb.result();
      if (result.navigation && !this.closed)
        this.cb.navigate(result.navigation);
    } catch (e) {
      result = {
        text:
          (e as Error).name === "TimeoutError"
            ? "等待操作结果超时，请在任务或完整对话中核验，不要重复提交"
            : assistantPublicText((e as Error).message),
      };
    }
    if (this.closed) return;
    this.handledUsers.add(user);
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    this.pendingTools--;
    this.followup = true;
    this.resumeToolResponse();
  }
  private resumeToolResponse() {
    if (
      this.closed ||
      !this.followup ||
      this.pendingTools ||
      this.responding ||
      this.talking
    )
      return;
    this.followup = false;
    this.responding = true;
    this.sendEvent({
      type: "response.create",
      response: { tool_choice: "none" },
    });
    this.phase();
  }
  private event(raw: string) {
    if (this.closed) return;
    let e: RealtimeEvent;
    try {
      e = JSON.parse(raw);
    } catch {
      return;
    }
    if (!e || typeof e !== "object") return;
    switch (e.type) {
      case "session.created":
      case "session.updated": {
        if (
          e.session?.model !== realtimeModel &&
          !String(e.session?.model || "").startsWith(realtimeModel + "-20")
        ) {
          this.fail("实时语音返回与配置不一致，通话已停止");
          return;
        }
        this.ready = true;
        clearTimeout(this.connectTimer);
        this.stream?.getAudioTracks().forEach((t) => {
          t.enabled = !this.muted;
        });
        this.cb.note("实时通话中，可以随时开口打断小序");
        this.phase();
        break;
      }
      case "input_audio_buffer.speech_started":
        if (this.playing) this.discardUnheard(this.playingResponse);
        if (this.responding) this.discardUnheard(this.currentResponse);
        this.talking = true;
        this.heard = true;
        this.playing = false;
        this.lastUser = String(e.item_id || crypto.randomUUID());
        this.addCaption(this.lastUser, "user", "", false);
        this.phase();
        break;
      case "input_audio_buffer.speech_stopped":
        this.talking = false;
        this.heard = false;
        this.phase();
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof e.transcript === "string" && e.transcript.trim())
          this.addCaption(String(e.item_id), "user", e.transcript.trim(), true);
        void this.flush();
        break;
      case "conversation.item.input_audio_transcription.failed":
        // Audio is still heard natively. Missing captions must not end a call.
        break;
      case "response.created":
        this.responding = true;
        this.currentResponse = String(e.response?.id || "");
        this.responseUsers.set(String(e.response?.id), this.lastUser);
        this.phase();
        break;
      case "response.output_audio_buffer.started":
      case "output_audio_buffer.started":
        this.playing = true;
        this.playingResponse = e.response_id || this.currentResponse;
        this.phase();
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.playing = false;
        this.phase();
        void this.flush();
        break;
      case "response.output_audio_transcript.delta":
        if (typeof e.delta === "string")
          this.addCaption(
            String(e.item_id),
            "assistant",
            e.delta,
            false,
            this.responseUsers.get(String(e.response_id)),
            e.response_id,
          );
        break;
      case "response.output_audio_transcript.done":
        if (typeof e.transcript === "string")
          this.addCaption(
            String(e.item_id),
            "assistant",
            e.transcript,
            true,
            this.responseUsers.get(String(e.response_id)),
            e.response_id,
          );
        break;
      case "response.function_call_arguments.done": {
        if (
          !isRealtimeToolName(e.name) ||
          (e.response_id && this.interruptedResponses.has(e.response_id)) ||
          typeof e.call_id !== "string" ||
          this.toolIds.has(e.call_id)
        )
          return;
        this.toolIds.add(e.call_id);
        const user =
          this.responseUsers.get(String(e.response_id)) || this.lastUser;
        this.handledUsers.add(user);
        this.pendingTools++;
        this.cb.business();
        this.phase();
        const callId = e.call_id;
        const tool = e.name;
        this.toolQueue = this.toolQueue.then(() =>
          this.executeTool(
            callId,
            String(e.arguments),
            user,
            tool,
            e.response_id,
          ),
        );
        break;
      }
      case "response.done":
        this.responding = false;
        if (e.response?.status === "failed") {
          this.fail("实时回复未完成，请检查语音服务后重新开始");
          return;
        }
        if (e.response?.status === "cancelled") {
          this.discardUnheard(String(e.response.id || ""));
        }
        this.phase();
        this.resumeToolResponse();
        void this.flush();
        break;
      case "error": {
        const code = String(e.error?.code || "");
        if (
          [
            "response_cancel_not_active",
            "input_audio_buffer_commit_empty",
            "conversation_already_has_active_response",
          ].includes(code)
        ) {
          this.phase();
          return;
        }
        this.fail(
          code.includes("rate_limit")
            ? "实时语音额度不足或请求受限，请检查服务额度"
            : "实时语音服务返回错误，请结束后重试或检查设置",
        );
        break;
      }
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
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      stream.getAudioTracks().forEach((t) => {
        t.enabled = false;
        t.onended = () => this.fail("麦克风已断开，请重新连接后开始");
      });
      this.connectTimer = setTimeout(
        () => this.fail("实时语音连接超时，请检查网络后重试"),
        40000,
      );
      const pc = new RTCPeerConnection();
      this.pc = pc;
      const audio = new Audio();
      audio.autoplay = true;
      this.audio = audio;
      pc.ontrack = (e) => {
        if (this.closed) return;
        audio.srcObject = e.streams[0] || new MediaStream([e.track]);
        void this.play();
      };
      pc.onconnectionstatechange = () => {
        if (this.closed) return;
        clearTimeout(this.disconnectTimer);
        if (["failed", "closed"].includes(pc.connectionState))
          this.fail("实时音频连接已断开，请重新开始");
        else if (pc.connectionState === "disconnected")
          this.disconnectTimer = setTimeout(
            () => this.fail("实时音频网络连接已中断，请重新开始"),
            5000,
          );
      };
      stream.getAudioTracks().forEach((t) => pc.addTrack(t, stream));
      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onmessage = (e) => this.event(String(e.data));
      dc.onerror = () => this.fail("实时通话连接发生错误，请重新开始");
      dc.onclose = () => {
        if (!this.closed) this.fail("实时通话已断开，请重新开始");
      };
      const offer = await pc.createOffer();
      if (this.closed) return;
      await pc.setLocalDescription(offer);
      const result = (
        await api(
          "/my-workspace/assistant/realtime/sessions",
          "POST",
          {
            id: this.id,
            sdp: offer.sdp,
            ...options,
          },
          undefined,
          { signal: AbortSignal.timeout(35000) },
        )
      ).data as { sdp: string; expiresAt: string };
      this.registered = true;
      if (this.closed) {
        await api(this.path("/close"), "POST", {}).catch(() => {});
        return;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: result.sdp });
      if (this.closed) return;
      this.expiry = setTimeout(
        () => this.stop("本次通话已到服务时限，点击即可重新开始"),
        Math.max(0, new Date(result.expiresAt).getTime() - Date.now()),
      );
      this.heartbeat = setInterval(() => {
        if (this.healthBusy || this.closed) return;
        this.healthBusy = true;
        void api(this.path(), "GET", undefined, undefined, {
          signal: AbortSignal.timeout(8000),
        })
          .then(() => {
            void this.flush();
          })
          .catch(() => {
            if (!this.closed)
              this.fail("登录、通话设置或网络连接已变化，请重新开始");
          })
          .finally(() => {
            this.healthBusy = false;
          });
      }, 15000);
    } catch (e) {
      if (this.closed) return;
      const name = (e as Error).name;
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
                    (e as Error).message || "实时语音连接失败",
                  ),
      );
    }
  }
  stop(reason = "语音已结束，麦克风已关闭") {
    if (this.closed) return;
    if (this.playing) this.discardUnheard(this.playingResponse);
    if (this.responding) this.discardUnheard(this.currentResponse);
    this.closed = true;
    clearTimeout(this.connectTimer);
    clearTimeout(this.disconnectTimer);
    clearTimeout(this.expiry);
    clearInterval(this.heartbeat);
    this.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    this.dc?.close();
    this.pc?.close();
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
    }
    this.responding = false;
    this.playing = false;
    void this.flush();
    // Also close a CREATING reservation when SDP initialization is still pending.
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
    this.stream?.getAudioTracks().forEach((t) => {
      t.enabled = this.ready && !this.muted;
    });
    if (this.muted) {
      this.sendEvent({ type: "input_audio_buffer.clear" });
      this.heard = false;
      this.talking = false;
    }
    this.phase();
    return this.muted;
  }
  interrupt() {
    if (this.playing) this.discardUnheard(this.playingResponse);
    if (this.responding) this.discardUnheard(this.currentResponse);
    if (this.responding) this.sendEvent({ type: "response.cancel" });
    if (this.playing) this.sendEvent({ type: "output_audio_buffer.clear" });
    this.playing = false;
    this.responding = false;
    this.phase();
  }
  send() {
    if (this.heard && !this.muted) {
      this.sendEvent({ type: "input_audio_buffer.commit" });
      this.sendEvent({ type: "response.create" });
      this.heard = false;
    }
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

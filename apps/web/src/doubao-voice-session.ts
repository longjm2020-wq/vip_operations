import { api } from "./api.js";
import { assistantPublicText } from "../../../packages/contracts/src/ai-presentation.js";
import type { RealtimeToolResult } from "../../../packages/contracts/src/assistant-realtime.js";
import type {
  RealtimeCallbacks,
  RealtimeCaption,
  RealtimeOptions,
} from "./realtime-voice-session.js";
import { bytesBase64, pcmBuffer, pcmBytes } from "./voice-pcm.js";

type Caption = RealtimeCaption & {
  key: string;
  turn: number;
  final: boolean;
  saved: boolean;
};
type VoiceEvent = {
  type?: string;
  text?: string;
  delta?: string;
  transcript?: string;
  content?: string;
  audio?: string;
  message?: string;
  result?: RealtimeToolResult;
  item_id?: string;
  question_id?: string;
  response_id?: string;
  call_id?: string;
  expiresAt?: string;
};

// The application server owns provider credentials, session configuration and tools.
// This client owns microphone, paced PCM frames, audio playback and visible captions.
export class DoubaoVoiceSession {
  readonly id = crypto.randomUUID();
  private socket?: WebSocket;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private capture?: AudioWorkletNode;
  private silence?: GainNode;
  private stream?: MediaStream;
  private closed = false;
  private registered = false;
  private ready = false;
  private muted = false;
  private talking = false;
  private responding = false;
  private acceptAudio = true;
  private healthBusy = false;
  private saving = false;
  private turn = 0;
  private captions: Caption[] = [];
  private businessTurns = new Set<number>();
  private deliveredTools = new Set<string>();
  private questionTurns = new Map<string, number>();
  private responseTurns = new Map<string, number>();
  private userTurns = new Map<string, number>();
  private output = new Set<AudioBufferSourceNode>();
  private outputUntil = 0;
  private frames: ArrayBuffer[] = [];
  private connectTimer?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private frameTimer?: ReturnType<typeof setTimeout>;

  constructor(private cb: RealtimeCallbacks) {}

  private path(suffix = "") {
    return `/my-workspace/assistant/realtime/sessions/${this.id}${suffix}`;
  }
  private sendEvent(value: object) {
    if (!this.closed && this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(value));
  }
  private phase() {
    if (!this.closed)
      this.cb.state(
        !this.ready
          ? "connecting"
          : this.talking
            ? "listening"
            : this.output.size
              ? "speaking"
              : this.responding
                ? "thinking"
                : "listening",
      );
  }
  private publishCaptions() {
    this.cb.captions(
      this.captions
        .filter((item) => item.text)
        .map(({ id, role, text }) => ({
          id,
          role,
          text: role === "assistant" ? assistantPublicText(text) : text,
        })),
    );
  }
  private caption(
    role: "user" | "assistant",
    text: string,
    final: boolean,
    append = false,
  ) {
    const key = `${role}:${this.turn}`;
    let item = this.captions.find((value) => value.key === key);
    if (!item) {
      item = {
        id: crypto.randomUUID(),
        key,
        turn: this.turn,
        role,
        text: "",
        final: false,
        saved: false,
      };
      this.captions.push(item);
      this.captions = this.captions.slice(-40);
    }
    item.text = (append ? item.text + text : text || item.text).slice(0, 12000);
    item.final = final;
    this.publishCaptions();
  }
  private async flush() {
    if (!this.registered || this.saving || this.responding || this.output.size)
      return;
    const completedTurns = new Set(
      this.captions
        .filter(
          (item) => item.role === "assistant" && item.final && !item.saved,
        )
        .map((item) => item.turn),
    );
    const eligible = this.captions.filter(
      (item) =>
        item.final &&
        !item.saved &&
        item.text &&
        !this.businessTurns.has(item.turn) &&
        completedTurns.has(item.turn),
    );
    const batch: Caption[] = [];
    let bytes = 32;
    for (const item of eligible) {
      const size =
        new TextEncoder().encode(
          JSON.stringify({ id: item.id, role: item.role, text: item.text }),
        ).length + 1;
      if (bytes + size > 48000) break;
      batch.push(item);
      bytes += size;
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
      this.cb.note(
        "通话字幕暂未保存，可在本轮字幕中查看；业务结果以任务记录为准",
      );
    } finally {
      this.saving = false;
    }
    if (batch.every((item) => item.saved) && eligible.length > batch.length)
      void this.flush();
  }
  private clearPlayback(discard = true) {
    if (discard) {
      // Text may precede audio; never persist an interrupted, partly unheard reply.
      this.captions
        .filter((item) => item.turn === this.turn && item.role === "assistant")
        .forEach((item) => {
          item.saved = true;
        });
    }
    this.output.forEach((source) => {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* already ended */
      }
      source.disconnect();
    });
    this.output.clear();
    this.outputUntil = 0;
  }
  private audio(value: string) {
    const context = this.context;
    if (!context || this.closed || !this.acceptAudio) return;
    try {
      const bytes = pcmBytes(value);
      if (!bytes.length || bytes.length % 2 || bytes.length > 512000)
        throw Error("invalid audio");
      const buffer = pcmBuffer(context, bytes);
      const start = Math.max(context.currentTime + 0.015, this.outputUntil);
      if (start + buffer.duration - context.currentTime > 60)
        throw Error("audio backlog");
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      this.output.add(source);
      this.outputUntil = start + buffer.duration;
      source.onended = () => {
        this.output.delete(source);
        source.disconnect();
        this.phase();
        void this.flush();
      };
      source.start(start);
      this.cb.blocked(context.state !== "running");
      this.phase();
    } catch {
      this.fail("实时音频播放异常，请重新开始通话");
    }
  }
  private event(raw: string) {
    if (this.closed || raw.length > 1000000) return;
    let event: VoiceEvent;
    try {
      event = JSON.parse(raw) as VoiceEvent;
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    const text =
      [event.text, event.delta, event.transcript, event.content].find(
        (value) => typeof value === "string" && value.length,
      ) || "";
    let eventTurn = this.turn;
    if (
      event.type?.startsWith("response.") ||
      event.type?.startsWith("xuti.tool_")
    ) {
      eventTurn =
        (event.response_id
          ? this.responseTurns.get(event.response_id)
          : undefined) ??
        (event.question_id
          ? (this.questionTurns.get(event.question_id) ??
            this.userTurns.get(event.question_id))
          : undefined) ??
        this.turn;
      if (event.question_id)
        this.questionTurns.set(event.question_id, eventTurn);
      if (event.response_id)
        this.responseTurns.set(event.response_id, eventTurn);
      if (event.type?.startsWith("response.") && eventTurn !== this.turn)
        return;
    }
    if (
      event.type?.startsWith("conversation.item.input_audio_transcription.") &&
      event.type !== "conversation.item.input_audio_transcription.started" &&
      event.item_id
    ) {
      const turn = this.userTurns.get(event.item_id);
      if (turn !== undefined && turn !== this.turn) return;
      this.userTurns.set(event.item_id, this.turn);
    }
    switch (event.type) {
      case "xuti.ready":
        this.ready = true;
        clearTimeout(this.connectTimer);
        if (event.expiresAt) this.setExpiry(event.expiresAt);
        if (this.closed) return;
        this.setCapture(!this.muted);
        if (this.muted) this.sendEvent({ type: "input_audio_mute.commit" });
        this.cb.note("实时通话中，可以随时开口打断小序");
        this.phase();
        break;
      case "conversation.item.input_audio_transcription.started":
        this.clearPlayback();
        this.acceptAudio = false;
        this.turn++;
        if (event.item_id) this.userTurns.set(event.item_id, this.turn);
        for (const map of [
          this.questionTurns,
          this.responseTurns,
          this.userTurns,
        ]) {
          for (const [key, turn] of map)
            if (turn < this.turn - 40) map.delete(key);
        }
        for (const turn of this.businessTurns)
          if (turn < this.turn - 40) this.businessTurns.delete(turn);
        this.talking = true;
        this.responding = false;
        this.phase();
        break;
      case "conversation.item.input_audio_transcription.delta":
        // Support cumulative hypotheses and incremental deltas; completed is authoritative.
        {
          const previous =
            this.captions.find((item) => item.key === `user:${this.turn}`)
              ?.text || "";
          this.caption(
            "user",
            text.startsWith(previous) ? text : previous + text,
            false,
          );
        }
        break;
      case "input_audio_buffer.speech_stopped":
        this.talking = false;
        this.responding = true;
        this.phase();
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (text.trim()) this.caption("user", text.trim(), true);
        this.talking = false;
        this.responding = !!text.trim();
        this.phase();
        break;
      case "conversation.item.input_audio_transcription.failed":
        this.talking = false;
        this.responding = false;
        this.phase();
        break;
      case "response.output_text.delta":
        this.responding = true;
        this.caption("assistant", text, false, true);
        this.phase();
        break;
      case "response.output_text.done":
        this.caption("assistant", text, true);
        break;
      case "response.output_audio.started":
        this.acceptAudio = true;
        this.talking = false;
        this.responding = true;
        break;
      case "response.output_audio.delta":
        if (typeof event.audio === "string" || typeof event.delta === "string")
          this.audio(event.audio || event.delta || "");
        break;
      case "response.output_audio.done":
        this.responding = false;
        this.phase();
        void this.flush();
        break;
      case "response.done":
        // Usage completion can arrive after the next user turn. Playback completion
        // owns the visible state; this notification must never stop a new response.
        void this.flush();
        break;
      case "response.canceled":
        // An acknowledgement may lag behind a new reply. Interruption is already
        // handled synchronously by interrupt() or the ASR-started event.
        break;
      case "xuti.tool_start":
      case "xuti.tool_started":
        this.businessTurns.add(eventTurn);
        if (eventTurn === this.turn) this.responding = true;
        this.cb.business();
        this.phase();
        break;
      case "xuti.tool_result":
        {
          const resultId = event.call_id || event.result?.messageId;
          if (resultId) {
            if (this.deliveredTools.has(resultId)) return;
            this.deliveredTools.add(resultId);
            if (this.deliveredTools.size > 2048) {
              const oldest = this.deliveredTools.values().next().value;
              if (oldest) this.deliveredTools.delete(oldest);
            }
          }
        }
        this.businessTurns.add(eventTurn);
        this.cb.business();
        this.cb.result();
        if (event.result?.navigation) this.cb.navigate(event.result.navigation);
        break;
      case "xuti.error":
        this.fail(
          assistantPublicText(
            event.message || "实时语音通道异常，请检查设置后重试",
          ),
        );
        break;
      case "session.closed":
        this.stop("实时通话已结束");
        break;
    }
  }
  private setCapture(active: boolean) {
    this.frames = [];
    this.capture?.port.postMessage({ active });
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = active;
    });
  }
  private setExpiry(expiresAt: string) {
    clearTimeout(this.expiry);
    const deadline = new Date(expiresAt).getTime();
    if (!Number.isFinite(deadline)) {
      this.fail("实时通话有效期异常，请重新开始");
      return;
    }
    this.expiry = setTimeout(
      () => this.stop("本次通话已到服务时限，点击即可重新开始"),
      Math.max(0, deadline - Date.now()),
    );
  }
  async start(options: RealtimeOptions) {
    this.cb.state("connecting");
    this.cb.blocked(false);
    try {
      // Resume synchronously from the user's gesture before microphone/network awaits.
      const context = new AudioContext({ latencyHint: "interactive" });
      this.context = context;
      await context.resume();
      if (this.closed) return;
      this.connectTimer = setTimeout(
        () => this.fail("实时语音连接超时，请检查网络后重试"),
        40000,
      );
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
      await context.audioWorklet.addModule("/realtime-pcm-capture.js");
      if (this.closed) return;
      const capture = new AudioWorkletNode(context, "xuti-realtime-pcm", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.capture = capture;
      capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (this.closed || !this.ready || this.muted) return;
        if (
          !(event.data instanceof ArrayBuffer) ||
          event.data.byteLength !== 640
        )
          return;
        this.frames.push(event.data);
        if (this.frames.length > 25)
          this.fail("音频传输延迟过大，请检查网络或设备后重试");
      };
      capture.onprocessorerror = () =>
        this.fail("麦克风处理已中断，请重新开始通话");
      this.source = context.createMediaStreamSource(stream);
      this.silence = context.createGain();
      this.silence.gain.value = 0;
      this.source.connect(capture);
      capture.connect(this.silence);
      this.silence.connect(context.destination);
      const result = (
        await api(
          "/my-workspace/assistant/realtime/sessions",
          "POST",
          { id: this.id, ...options },
          undefined,
          { signal: AbortSignal.timeout(35000) },
        )
      ).data as { transport: string; ticket: string; expiresAt: string };
      this.registered = true;
      if (this.closed) {
        await api(this.path("/close"), "POST", {}).catch(() => {});
        return;
      }
      if (result.transport !== "websocket" || !result.ticket)
        throw Error("实时通话配置已变化，请重新开始");
      const url = new URL(
        `/api/v1${this.path("/socket")}`,
        window.location.href,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onopen = () =>
        this.sendEvent({ type: "authenticate", ticket: result.ticket });
      socket.onmessage = (event) => {
        if (typeof event.data === "string") this.event(event.data);
      };
      socket.onerror = () =>
        this.fail("实时音频连接发生错误，请检查网络后重新开始");
      socket.onclose = () => {
        if (!this.closed) this.fail("实时通话已断开，请重新开始");
      };
      let nextFrameAt = performance.now() + 20;
      const pump = () => {
        if (this.closed) return;
        if (this.ready && !this.muted && this.frames.length) {
          if (socket.bufferedAmount > 64000) {
            this.fail("音频传输延迟过大，请检查网络后重试");
            return;
          }
          const frame = this.frames.shift();
          if (frame)
            this.sendEvent({
              type: "input_audio_buffer.append",
              audio: bytesBase64(new Uint8Array(frame)),
            });
        }
        // Compensate normal timer drift without bursting an old backlog after a stall.
        nextFrameAt += 20;
        const now = performance.now();
        if (nextFrameAt < now) nextFrameAt = now + 20;
        this.frameTimer = setTimeout(pump, Math.max(1, nextFrameAt - now));
      };
      this.frameTimer = setTimeout(pump, 20);
      this.setExpiry(result.expiresAt);
      this.heartbeat = setInterval(() => {
        if (this.closed || this.healthBusy || !this.ready) return;
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
    if (this.output.size || this.responding) this.clearPlayback();
    this.sendEvent({ type: "session.close" });
    this.closed = true;
    clearTimeout(this.connectTimer);
    clearTimeout(this.expiry);
    clearInterval(this.heartbeat);
    clearTimeout(this.frameTimer);
    this.frames = [];
    this.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.capture?.port.postMessage({ active: false });
    if (this.capture) {
      this.capture.port.onmessage = null;
      this.capture.port.close();
      this.capture.disconnect();
    }
    this.source?.disconnect();
    this.silence?.disconnect();
    this.clearPlayback(false);
    void this.context?.close().catch(() => {});
    this.socket?.close();
    this.responding = false;
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
    if (this.ready) {
      this.sendEvent({
        type: this.muted
          ? "input_audio_mute.commit"
          : "input_audio_unmute.commit",
      });
      this.setCapture(!this.muted);
    }
    if (this.muted) this.talking = false;
    this.phase();
    return this.muted;
  }
  interrupt() {
    this.clearPlayback();
    this.acceptAudio = false;
    this.responding = false;
    this.sendEvent({ type: "response.cancel" });
    this.phase();
  }
  send() {
    if (this.ready && !this.muted && this.talking)
      this.sendEvent({ type: "input_audio_buffer.commit" });
  }
  async play() {
    try {
      await this.context?.resume();
      if (!this.closed) this.cb.blocked(this.context?.state !== "running");
    } catch {
      if (!this.closed) this.cb.blocked(true);
    }
  }
}

import { useCallback, useEffect, useRef, useState } from "react";
import { csrf, queryClient } from "./api";
import { pcmBuffer, pcmBytes, wavFromFrames } from "./voice-pcm";
import type { VoiceEvent } from "../../../packages/contracts/src/assistant-voice";
export type VoiceState =
  "idle" | "connecting" | "listening" | "thinking" | "speaking";
type Options = { includePersonalContext: boolean; includeMemory: boolean };
type Connection = {
  context: AudioContext;
  stream: MediaStream;
  recorder: AudioWorkletNode;
  source: MediaStreamAudioSourceNode;
  phase: VoiceState;
  muted: boolean;
  frames: Float32Array[];
  preRoll: Float32Array[];
  samples: number;
  heard: boolean;
  silence: number;
  quiet: number;
  request?: AbortController;
  sources: Set<AudioBufferSourceNode>;
  nextAudio: number;
  remainder: Uint8Array;
  done: boolean;
  expiry?: ReturnType<typeof setTimeout>;
  options: Options;
};
export function useGptVoice(
  onResult: () => void,
  onNavigate: (toolId: string) => void,
) {
  const [state, setState] = useState<VoiceState>("idle"),
    [muted, setMuted] = useState(false);
  const [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [model, setModel] = useState("");
  const [captions, setCaptions] = useState<
    { id: string; role: "user" | "assistant"; text: string }[]
  >([]);
  const [hasBusiness, setHasBusiness] = useState(false),
    [playbackBlocked, setPlaybackBlocked] = useState(false);
  const connection = useRef<Connection | null>(null),
    epoch = useRef(0),
    starting = useRef(false),
    callback = useRef(onResult),
    navigate = useRef(onNavigate);
  callback.current = onResult;
  navigate.current = onNavigate;
  const supported =
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window.AudioContext !== "undefined" &&
    typeof window.AudioWorkletNode !== "undefined";
  const stop = useCallback((reason = "语音已结束，麦克风已关闭") => {
    epoch.current++;
    starting.current = false;
    const c = connection.current;
    connection.current = null;
    if (c) {
      clearTimeout(c.expiry);
      c.request?.abort();
      c.stream.getTracks().forEach((t) => t.stop());
      c.sources.forEach((s) => {
        try {
          s.stop();
        } catch {
          /* Already finished. */
        }
      });
      c.recorder.disconnect();
      c.source.disconnect();
      void c.context.close().catch(() => {});
      c.frames = [];
      c.preRoll = [];
    }
    setState("idle");
    setMuted(false);
    setPlaybackBlocked(false);
    setNote(reason);
  }, []);
  const listen = (c: Connection) => {
    if (connection.current !== c) return;
    c.phase = "listening";
    c.frames = [];
    c.preRoll = [];
    c.samples = 0;
    c.silence = 0;
    c.quiet = 0;
    c.heard = false;
    c.stream.getAudioTracks().forEach((t) => {
      t.enabled = !c.muted;
    });
    setState("listening");
    setNote(
      c.muted
        ? "麦克风已静音"
        : "说完停顿约1.3秒会自动发送，也可点击「发送这段」",
    );
  };
  const sendTurn = async (c: Connection) => {
    if (
      connection.current !== c ||
      c.phase !== "listening" ||
      !c.heard ||
      c.samples < 4800
    )
      return;
    c.phase = "thinking";
    setState("thinking");
    setNote("正在识别语音…");
    c.stream.getAudioTracks().forEach((t) => {
      t.enabled = false;
    });
    const audio = wavFromFrames(c.frames);
    c.frames = [];
    c.done = false;
    c.remainder = new Uint8Array();
    const id = crypto.randomUUID(),
      request = new AbortController();
    c.request = request;
    const current = () => connection.current === c && c.request === request;
    const addCaption = (role: "user" | "assistant", text: string) =>
      setCaptions((old) => [...old, { id: id + role, role, text }].slice(-40));
    try {
      const response = await fetch(
        "/api/v1/my-workspace/assistant/voice/turn",
        {
          method: "POST",
          credentials: "include",
          signal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(240000),
          ]),
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
            "Idempotency-Key": id,
          },
          body: JSON.stringify({ id, audio, ...c.options }),
        },
      );
      if (!response.ok) {
        if (response.status === 401) queryClient.setQueryData(["me"], null);
        const value = await response.json();
        throw Error(value.error?.message || "语音请求失败");
      }
      if (!response.body) throw Error("语音服务没有返回数据");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let pending = "",
        completed = false;
      try {
        while (current()) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          if (pending.length > 2000000) throw Error("语音数据异常");
          const lines = pending.split("\n");
          pending = lines.pop()!;
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as VoiceEvent;
            if (event.type === "error") throw Error(event.message);
            if (event.type === "retry-listening") {
              // Discard this segment; keep the device/session and await fresh speech.
              completed = true;
              setError("");
            }
            if (event.type === "transcript") addCaption("user", event.text);
            if (event.type === "reply") {
              addCaption("assistant", event.text);
              setHasBusiness(true);
              callback.current();
            }
            if (event.type === "model") setModel(event.model);
            if (event.type === "navigate") navigate.current(event.toolId);
            if (event.type === "stage")
              setNote(
                event.stage === "transcribing"
                  ? "正在识别语音…"
                  : event.stage === "thinking"
                    ? "小序正在处理…"
                    : "正在生成 GPT 声音…",
              );
            if (event.type === "audio") {
              const fresh = pcmBytes(event.data),
                bytes = new Uint8Array(c.remainder.length + fresh.length);
              bytes.set(c.remainder);
              bytes.set(fresh, c.remainder.length);
              c.remainder = bytes.slice(bytes.length - (bytes.length % 2));
              const even = bytes.subarray(0, bytes.length - (bytes.length % 2));
              if (!even.length) continue;
              const source = c.context.createBufferSource();
              source.buffer = pcmBuffer(c.context, even);
              source.connect(c.context.destination);
              const at = Math.max(c.context.currentTime + 0.05, c.nextAudio);
              c.nextAudio = at + source.buffer.duration;
              c.sources.add(source);
              c.phase = "speaking";
              setState("speaking");
              setNote("");
              source.onended = () => {
                c.sources.delete(source);
                if (current() && c.done && !c.sources.size) listen(c);
              };
              source.start(at);
              if (c.context.state === "suspended") setPlaybackBlocked(true);
            }
            if (event.type === "done") completed = true;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (!current()) return;
      if (!completed || c.remainder.length)
        throw Error("语音回复未完整接收，请查看文字对话");
      c.done = true;
      if (!c.sources.size) listen(c);
    } catch (e) {
      if (!current()) return;
      stop("");
      setError((e as Error).message || "语音连接失败，请重新开始");
      callback.current();
    }
  };
  const start = async (options: Options) => {
    if (starting.current || connection.current) return;
    starting.current = true;
    const token = ++epoch.current;
    setError("");
    setNote("");
    setCaptions([]);
    setHasBusiness(false);
    setModel("");
    setState("connecting");
    let stream: MediaStream | undefined, context: AudioContext | undefined;
    try {
      context = new AudioContext({ sampleRate: 24000 });
      await context.resume();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      if (token !== epoch.current) {
        stream.getTracks().forEach((t) => t.stop());
        await context.close();
        return;
      }
      if (context.sampleRate !== 24000)
        throw Error("当前设备不支持24kHz语音采样，请更换浏览器");
      await context.audioWorklet.addModule("/voice-capture.js");
      if (token !== epoch.current) {
        stream.getTracks().forEach((t) => t.stop());
        await context.close();
        return;
      }
      const source = context.createMediaStreamSource(stream),
        recorder = new AudioWorkletNode(context, "xuti-voice-capture");
      const c: Connection = {
        context,
        stream,
        source,
        recorder,
        phase: "listening",
        muted: false,
        frames: [],
        preRoll: [],
        samples: 0,
        heard: false,
        silence: 0,
        quiet: 0,
        sources: new Set(),
        nextAudio: 0,
        remainder: new Uint8Array(),
        done: false,
        options,
      };
      connection.current = c;
      stream.getTracks().forEach((track) => {
        track.onended = () => {
          if (connection.current === c) {
            stop("");
            setError("麦克风已断开，请重新连接");
          }
        };
      });
      recorder.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
        if (connection.current !== c || c.phase !== "listening" || c.muted)
          return;
        const rms = Math.sqrt(
            data.reduce((sum, value) => sum + value * value, 0) / data.length,
          ),
          speaking = rms > 0.012;
        if (!c.heard) {
          c.preRoll.push(data);
          if (c.preRoll.length > 4) c.preRoll.shift();
          if (!speaking) {
            c.quiet += data.length;
            if (c.quiet > 24000 * 45) stop("45秒未检测到语音，麦克风已关闭");
            return;
          }
          c.heard = true;
          c.frames = [...c.preRoll];
          c.samples = c.frames.reduce((n, f) => n + f.length, 0);
          c.preRoll = [];
        } else {
          c.frames.push(data);
          c.samples += data.length;
        }
        c.silence = speaking ? 0 : c.silence + data.length;
        if (c.samples >= 600000 || c.silence >= 31200) void sendTurn(c);
      };
      source.connect(recorder);
      recorder.connect(context.destination);
      c.expiry = setTimeout(
        () => stop("本次语音已达到10分钟，可重新开始继续"),
        600000,
      );
      listen(c);
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      if (context?.state !== "closed") await context?.close();
      if (token !== epoch.current) return;
      stop("");
      const name = (e as Error).name;
      setError(
        name === "NotAllowedError"
          ? "麦克风权限未获允许，请在浏览器网站设置中允许后重试"
          : name === "NotFoundError"
            ? "未检测到麦克风，请连接后重试"
            : name === "NotReadableError"
              ? "麦克风被占用，请释放后重试"
              : (e as Error).message,
      );
    } finally {
      if (token === epoch.current) starting.current = false;
    }
  };
  const interrupt = () => {
    const c = connection.current;
    if (!c || c.phase !== "speaking") return;
    c.request?.abort();
    c.request = undefined;
    c.sources.forEach((s) => {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* Finished. */
      }
    });
    c.sources.clear();
    c.nextAudio = 0;
    listen(c);
  };
  const toggleMute = () => {
    const c = connection.current;
    if (!c) return;
    c.muted = !c.muted;
    setMuted(c.muted);
    c.frames = [];
    c.preRoll = [];
    c.heard = false;
    c.samples = 0;
    c.silence = 0;
    c.stream.getAudioTracks().forEach((t) => {
      t.enabled = !c.muted && c.phase === "listening";
    });
  };
  const send = () => {
    const c = connection.current;
    if (c) {
      if (!c.heard) setNote("还没有听到语音");
      else void sendTurn(c);
    }
  };
  const play = () =>
    void connection.current?.context
      .resume()
      .then(() => setPlaybackBlocked(false));
  useEffect(() => {
    const hidden = () => {
      if (document.hidden && (connection.current || starting.current))
        stop("网页已隐藏，语音已结束");
    };
    const unload = () => stop("");
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", unload);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", unload);
      stop("");
    };
  }, [stop]);
  return {
    state,
    active: state !== "idle",
    supported,
    error,
    note,
    captions,
    model,
    muted,
    playbackBlocked,
    hasBusiness,
    start,
    stop,
    interrupt,
    toggleMute,
    play,
    send,
  };
}

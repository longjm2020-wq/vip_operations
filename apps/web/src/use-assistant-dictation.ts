import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantDictationStatus } from "../../../packages/contracts/src/assistant-voice";
import { api } from "./api";
import { wavFromFrames } from "./voice-pcm";

type Phase = "idle" | "connecting" | "recording" | "transcribing";
type Recording = {
  phase: Phase;
  request: AbortController;
  context?: AudioContext;
  stream?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  recorder?: AudioWorkletNode;
  timer?: ReturnType<typeof setTimeout>;
  frames: Float32Array[];
  samples: number;
  heard: boolean;
  silence: number;
  existing: string;
  maxLength: number;
};
function release(recording: Recording) {
  if (recording.timer) clearTimeout(recording.timer);
  if (recording.recorder) {
    recording.recorder.port.onmessage = null;
    recording.recorder.disconnect();
  }
  recording.source?.disconnect();
  recording.stream?.getTracks().forEach((track) => {
    track.onended = null;
    track.stop();
  });
  if (recording.context && recording.context.state !== "closed")
    void recording.context.close().catch(() => {});
}

/** A deliberate click records one segment; the result remains an unsent draft. */
export function useAssistantDictation(onText: (text: string) => void) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const active = useRef<Recording | null>(null);
  const callback = useRef(onText);
  callback.current = onText;
  const supported = Boolean(
    window.isSecureContext &&
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      typeof window.AudioContext === "function" &&
      typeof window.AudioWorkletNode === "function",
  );
  const clearError = useCallback(() => setError(""), []);
  const stopListening = useCallback(() => {
    const recording = active.current;
    active.current = null;
    if (recording) {
      recording.request.abort();
      release(recording);
      recording.frames = [];
    }
    setPhase("idle");
  }, []);
  const finish = async (recording: Recording) => {
    if (active.current !== recording || recording.phase !== "recording") return;
    recording.phase = "transcribing";
    setPhase("transcribing");
    release(recording);
    try {
      if (!recording.heard || recording.samples < 4800)
        throw Error("没有听到清晰语音，点击麦克风可再试一次。");
      const audio = wavFromFrames(recording.frames);
      recording.frames = [];
      const id = crypto.randomUUID();
      const result = await api(
        "/my-workspace/assistant/dictation",
        "POST",
        { id, audio },
        id,
        {
          signal: AbortSignal.any([
            recording.request.signal,
            AbortSignal.timeout(100000),
          ]),
        },
      );
      if (active.current !== recording) return;
      const text: unknown = result.data?.text;
      if (typeof text !== "string" || !text.trim())
        throw Error("未获得可用的语音文字，请重新听写。");
      callback.current(
        (
          recording.existing +
          (recording.existing ? " " : "") +
          text.trim()
        ).slice(0, recording.maxLength),
      );
    } catch (cause) {
      if (active.current === recording)
        setError(
          cause instanceof TypeError
            ? "听写服务连接失败，请稍后重试或继续键入。"
            : (cause as Error).message || "听写失败，请重新录音。",
        );
    } finally {
      if (active.current === recording) stopListening();
    }
  };
  const start = async (existing: string, maxLength = 4000) => {
    const current = active.current;
    if (current) {
      if (current.phase === "recording") await finish(current);
      else stopListening();
      return;
    }
    setError("");
    if (!supported) {
      setError(
        "此浏览器不支持录音，请使用 HTTPS 下的 Chrome / Edge 或继续键入。",
      );
      return;
    }
    const recording: Recording = {
      phase: "connecting",
      request: new AbortController(),
      frames: [],
      samples: 0,
      heard: false,
      silence: 0,
      existing,
      maxLength,
    };
    active.current = recording;
    setPhase("connecting");
    try {
      recording.context = new AudioContext({ sampleRate: 24000 });
      await recording.context.resume();
      const result = await api(
        "/my-workspace/assistant/dictation",
        "GET",
        undefined,
        undefined,
        {
          signal: AbortSignal.any([
            recording.request.signal,
            AbortSignal.timeout(15000),
          ]),
        },
      );
      if (active.current !== recording) return;
      const status = result.data as AssistantDictationStatus;
      if (!status?.ready)
        throw Error(status?.message || "听写服务尚未就绪，请检查语音设置。");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      recording.stream = stream;
      if (active.current !== recording) {
        release(recording);
        return;
      }
      const context = recording.context;
      if (context.sampleRate !== 24000)
        throw Error("当前设备不支持24kHz录音，请更换浏览器。");
      await context.audioWorklet.addModule("/voice-capture.js");
      if (active.current !== recording) {
        release(recording);
        return;
      }
      const recorder = new AudioWorkletNode(context, "xuti-voice-capture");
      recording.recorder = recorder;
      recording.source = context.createMediaStreamSource(stream);
      recording.phase = "recording";
      setPhase("recording");
      stream.getTracks().forEach((track) => {
        track.onended = () => {
          if (active.current !== recording) return;
          stopListening();
          setError("麦克风已断开，请重新连接后听写。");
        };
      });
      recorder.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
        if (
          active.current !== recording ||
          recording.phase !== "recording" ||
          !data.length
        )
          return;
        const frame = data.slice(0, 600000 - recording.samples);
        recording.frames.push(frame);
        recording.samples += frame.length;
        const audible =
          Math.sqrt(
            data.reduce((sum, value) => sum + value * value, 0) / data.length,
          ) > 0.012;
        recording.heard ||= audible;
        recording.silence = audible ? 0 : recording.silence + frame.length;
        if (
          recording.samples >= 600000 ||
          (recording.heard && recording.silence >= 31200)
        )
          void finish(recording);
      };
      recording.source.connect(recorder);
      recorder.connect(context.destination);
      recording.timer = setTimeout(() => void finish(recording), 25000);
    } catch (cause) {
      if (active.current !== recording) return;
      stopListening();
      const e = cause as Error;
      setError(
        e.name === "NotAllowedError"
          ? "麦克风权限未开启，请在浏览器地址栏允许使用麦克风。"
          : e.name === "NotFoundError"
            ? "未检测到可用麦克风。"
            : e.name === "NotReadableError"
              ? "麦克风被其他程序占用，请关闭占用后重试。"
              : e.message || "无法启动听写，请检查语音设置。",
      );
    }
  };
  useEffect(() => stopListening, [stopListening]);
  return {
    supported,
    listening: phase !== "idle",
    phase,
    error,
    clearError,
    start,
    stopListening,
    note:
      phase === "connecting"
        ? "正在打开麦克风…"
        : phase === "transcribing"
          ? "正在转成文字，再次点击麦克风可取消…"
          : "正在听写，说完停顿或再次点击麦克风，核对文字后发送（最多25秒）",
  };
}

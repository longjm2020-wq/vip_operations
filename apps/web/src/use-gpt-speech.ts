import { useCallback, useEffect, useRef, useState } from "react";
import { pcmBuffer, pcmBytes } from "./voice-pcm";
import { requestVoiceStream } from "./voice-stream";

type Playback = {
  context: AudioContext;
  request: AbortController;
  sources: Set<AudioBufferSourceNode>;
  nextAudio: number;
  remainder: Uint8Array;
  bytes: number;
  done: boolean;
};

// Text playback deliberately has no microphone, recognition or business-action path.
export function useGptSpeech() {
  const [state, setState] = useState<"idle" | "thinking" | "speaking">("idle");
  const [messageId, setMessageId] = useState("");
  const [error, setError] = useState("");
  const [model, setModel] = useState("");
  const [blocked, setBlocked] = useState(false);
  const playback = useRef<Playback | null>(null);
  const prepared = useRef<AudioContext | null>(null);
  const supported = typeof window.AudioContext !== "undefined";
  const stop = useCallback(() => {
    const p = playback.current;
    playback.current = null;
    p?.request.abort();
    p?.sources.forEach((source) => {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* Already finished. */
      }
    });
    if (p) void p.context.close().catch(() => {});
    if (prepared.current) void prepared.current.close().catch(() => {});
    prepared.current = null;
    setState("idle");
    setMessageId("");
    setBlocked(false);
  }, []);
  // Called during the send gesture, before waiting for the text response.
  const prepare = () => {
    if (!supported || prepared.current) return;
    try {
      prepared.current = new AudioContext();
      void prepared.current.resume().catch(() => {});
    } catch {
      setError("无法启用声音播放，请检查浏览器音频设备");
    }
  };
  const read = async (id: string) => {
    let context: AudioContext;
    try {
      context = prepared.current || new AudioContext();
    } catch {
      setError("无法启用声音播放，请检查浏览器音频设备");
      return;
    }
    prepared.current = null;
    stop();
    const p: Playback = {
      context,
      request: new AbortController(),
      sources: new Set(),
      nextAudio: 0,
      remainder: new Uint8Array(),
      bytes: 0,
      done: false,
    };
    playback.current = p;
    setMessageId(id);
    setError("");
    setModel("");
    setState("thinking");
    const current = () => playback.current === p;
    void context.resume().catch(() => {
      if (current()) setBlocked(true);
    });
    const finish = () => {
      if (current() && p.done && !p.sources.size) stop();
    };
    try {
      await requestVoiceStream(
        "speech",
        { id: crypto.randomUUID(), messageId: id },
        AbortSignal.any([p.request.signal, AbortSignal.timeout(120000)]),
        (event) => {
          if (!current()) return;
          if (event.type === "model") setModel(event.model);
          if (event.type !== "audio") return;
          const fresh = pcmBytes(event.data);
          p.bytes += fresh.length;
          if (p.bytes > 5760000) throw Error("语音回复过长，已停止播放");
          const bytes = new Uint8Array(p.remainder.length + fresh.length);
          bytes.set(p.remainder);
          bytes.set(fresh, p.remainder.length);
          p.remainder = bytes.slice(bytes.length - (bytes.length % 2));
          const even = bytes.subarray(0, bytes.length - (bytes.length % 2));
          if (!even.length) return;
          const source = context.createBufferSource();
          source.buffer = pcmBuffer(context, even);
          source.connect(context.destination);
          const at = Math.max(context.currentTime + 0.05, p.nextAudio);
          p.nextAudio = at + source.buffer.duration;
          p.sources.add(source);
          source.onended = () => {
            p.sources.delete(source);
            finish();
          };
          source.start(at);
          setState("speaking");
          setBlocked(context.state === "suspended");
        },
      );
      if (!current()) return;
      if (!p.bytes || p.remainder.length)
        throw Error("未收到完整声音，请重新朗读");
      p.done = true;
      finish();
    } catch (cause) {
      if (!current()) return;
      stop();
      setError((cause as Error).message || "语音播放失败，请重试");
    }
  };
  const play = () =>
    void playback.current?.context
      .resume()
      .then(() => setBlocked(false))
      .catch(() => setError("浏览器未能播放声音，请检查音频设备"));
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) stop();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", stop);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", stop);
      stop();
    };
  }, [stop]);
  return {
    state,
    active: state !== "idle",
    messageId,
    error,
    model,
    blocked,
    supported,
    prepare,
    read,
    stop,
    play,
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RealtimeVoiceSession,
  type RealtimeCaption,
} from "./realtime-voice-session";
import { DoubaoVoiceSession } from "./doubao-voice-session";
import type { VoiceState } from "./use-gpt-voice";

export function useRealtimeVoice(
  onResult: () => void,
  onNavigate: (id: string) => void,
  transport: "webrtc" | "websocket" = "webrtc",
) {
  const [state, setState] = useState<VoiceState>("idle"),
    [muted, setMuted] = useState(false);
  const [error, setError] = useState(""),
    [note, setNote] = useState("");
  const [captions, setCaptions] = useState<RealtimeCaption[]>([]);
  const [playbackBlocked, setPlaybackBlocked] = useState(false),
    [hasBusiness, setHasBusiness] = useState(false);
  const current = useRef<RealtimeVoiceSession | DoubaoVoiceSession | null>(
    null,
  );
  const generation = useRef(0);
  const callbacks = useRef({ onResult, onNavigate });
  callbacks.current = { onResult, onNavigate };
  const supported =
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    (transport === "websocket"
      ? typeof WebSocket !== "undefined" &&
        typeof AudioContext !== "undefined" &&
        typeof AudioWorkletNode !== "undefined"
      : typeof RTCPeerConnection !== "undefined");
  const stop = useCallback((reason?: string) => {
    const call = current.current;
    current.current = null;
    call?.stop(reason);
    setMuted(false);
  }, []);
  const start = async (options: {
    includePersonalContext: boolean;
    includeMemory: boolean;
  }) => {
    if (current.current) return;
    const turn = ++generation.current;
    setError("");
    setNote("");
    setCaptions([]);
    setHasBusiness(false);
    setMuted(false);
    if (!supported) {
      setError("请使用支持实时语音的桌面客户端或 HTTPS 下的 Chrome / Edge");
      return;
    }
    const Session =
      transport === "websocket" ? DoubaoVoiceSession : RealtimeVoiceSession;
    const call = new Session({
      state: (value) => {
        if (turn !== generation.current) return;
        if (value === "idle" && current.current === call)
          current.current = null;
        setState(value);
      },
      captions: (value) => {
        if (turn === generation.current) setCaptions(value);
      },
      note: (value) => {
        if (turn === generation.current) setNote(value);
      },
      error: (value) => {
        if (turn === generation.current) setError(value);
      },
      blocked: (value) => {
        if (turn === generation.current) setPlaybackBlocked(value);
      },
      result: () => callbacks.current.onResult(),
      navigate: (id) => callbacks.current.onNavigate(id),
      business: () => setHasBusiness(true),
    });
    current.current = call;
    await call.start(options);
  };
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) stop("页面已隐藏，实时语音已结束");
    };
    const leave = () => stop("");
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
      stop("");
      generation.current++;
    };
  }, [stop]);
  return {
    state,
    active: state !== "idle",
    supported,
    error,
    note,
    captions,
    model: "",
    muted,
    playbackBlocked,
    hasBusiness,
    realtime: true,
    start,
    stop,
    interrupt: () => current.current?.interrupt(),
    toggleMute: () => setMuted(current.current?.toggleMute() || false),
    play: () => {
      void current.current?.play();
    },
    send: () => current.current?.send(),
  };
}

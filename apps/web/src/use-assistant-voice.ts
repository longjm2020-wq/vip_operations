import { useCallback, useEffect, useRef, useState } from "react";

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type VoiceWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

/** Click-to-talk only: recognition is never started by a render, reminder or model. */
export function useAssistantVoice(onText: (value: string) => void) {
  const [listening, setListening] = useState(false),
    [speaking, setSpeaking] = useState(false),
    [error, setError] = useState("");
  const recognition = useRef<Recognition | null>(null),
    timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callback = useRef(onText),
    playback = useRef(0);
  callback.current = onText;
  const browser = window as VoiceWindow;
  const supported =
    !!(browser.SpeechRecognition || browser.webkitSpeechRecognition) &&
    window.isSecureContext;
  const canSpeak =
    "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  const stopSpeaking = useCallback(() => {
    playback.current++;
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);
  const stopListening = useCallback(() => {
    const current = recognition.current;
    recognition.current = null;
    if (current) {
      current.onresult = null;
      current.onerror = null;
      current.onend = null;
      try {
        current.abort();
      } catch {
        /* An ended recognizer needs no further cancellation. */
      }
    }
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = null;
    setListening(false);
  }, []);
  const stop = useCallback(() => {
    stopListening();
    stopSpeaking();
  }, [stopListening, stopSpeaking]);
  const start = (existing: string, maxLength = 4000) => {
    if (recognition.current) {
      stopListening();
      return;
    }
    stopSpeaking();
    setError("");
    const Constructor =
      browser.SpeechRecognition || browser.webkitSpeechRecognition;
    if (!Constructor || !window.isSecureContext) {
      setError("此浏览器不支持语音输入，请使用 Chrome / Edge 或继续键入。");
      return;
    }
    const current = new Constructor();
    current.lang = "zh-CN";
    current.continuous = false;
    current.interimResults = true;
    recognition.current = current;
    current.onresult = (event) => {
      if (recognition.current !== current) return;
      const words = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join("");
      callback.current(
        (existing + (existing && words ? " " : "") + words).slice(0, maxLength),
      );
    };
    current.onerror = (event) => {
      if (recognition.current !== current) return;
      const messages: Record<string, string> = {
        "not-allowed": "麦克风权限未开启，请在浏览器地址栏允许使用麦克风。",
        "service-not-allowed": "浏览器语音服务不可用，请继续键入。",
        "audio-capture": "未检测到可用麦克风。",
        network: "语音识别服务连接失败，请检查网络或继续键入。",
        "no-speech": "没有听到声音，点击麦克风可再试一次。",
      };
      if (event.error !== "aborted")
        setError(messages[event.error] || "语音识别未完成，请继续键入。");
      stopListening();
    };
    current.onend = () => {
      if (recognition.current === current) stopListening();
    };
    try {
      current.start();
      setListening(true);
      timeout.current = setTimeout(stopListening, 60000);
    } catch {
      stopListening();
      setError("无法启动麦克风，请检查浏览器权限。");
    }
  };
  const speak = useCallback(
    (value: string) => {
      stopSpeaking();
      if (
        !value.trim() ||
        !window.speechSynthesis ||
        !window.SpeechSynthesisUtterance ||
        document.hidden
      )
        return;
      stopListening();
      setError("");
      const generation = playback.current;
      // Keep a single, short utterance rather than queueing a whole report.
      const utterance = new SpeechSynthesisUtterance(
        value.replace(/[#*`]/g, "").slice(0, 600),
      );
      utterance.lang = "zh-CN";
      utterance.rate = 1;
      const voices = window.speechSynthesis
        .getVoices()
        .filter((voice) => /^zh/i.test(voice.lang));
      utterance.voice =
        voices.find((voice) => voice.localService) || voices[0] || null;
      utterance.onstart = () => {
        if (generation === playback.current) setSpeaking(true);
      };
      utterance.onend = () => {
        if (generation === playback.current) setSpeaking(false);
      };
      utterance.onerror = (event) => {
        if (generation !== playback.current) return;
        setSpeaking(false);
        if (!["canceled", "interrupted"].includes(event.error))
          setError("语音播放不可用，请阅读文字回复。");
      };
      window.speechSynthesis.speak(utterance);
    },
    [stopListening, stopSpeaking],
  );
  useEffect(() => {
    const hide = () => {
      if (document.hidden) stop();
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      stop();
    };
  }, [stop]);
  return {
    supported,
    canSpeak,
    listening,
    speaking,
    error,
    start,
    stop,
    speak,
    stopSpeaking,
    stopListening,
  };
}

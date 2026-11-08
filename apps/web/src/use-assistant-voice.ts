import { useCallback, useEffect, useRef, useState } from "react";
import { useAssistantDictation } from "./use-assistant-dictation";

/** Click-to-talk only: recognition is never started by a render, reminder or model. */
export function useAssistantVoice(onText: (value: string) => void) {
  const [speaking, setSpeaking] = useState(false),
    [error, setError] = useState("");
  const dictation = useAssistantDictation(onText);
  const { stopListening, clearError } = dictation;
  const playback = useRef(0);
  const canSpeak =
    "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  const stopSpeaking = useCallback(() => {
    playback.current++;
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);
  const stop = useCallback(() => {
    stopListening();
    stopSpeaking();
  }, [stopListening, stopSpeaking]);
  const start = (existing: string, maxLength = 4000) => {
    stopSpeaking();
    setError("");
    void dictation.start(existing, maxLength);
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
      clearError();
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
    [stopListening, stopSpeaking, clearError],
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
    ...dictation,
    canSpeak,
    speaking,
    error: dictation.error || error,
    start,
    stop,
    speak,
    stopSpeaking,
    stopListening,
  };
}

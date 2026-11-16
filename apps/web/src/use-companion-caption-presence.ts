import { useLayoutEffect, useState } from "react";

type CaptionPhase = "hidden" | "entering" | "open" | "exiting";

/** Keep only the outgoing presentation alive; microphone ownership never moves here. */
export function useCompanionCaptionPresence(visible: boolean) {
  const [phase, setPhase] = useState<CaptionPhase>(
    visible ? "entering" : "hidden",
  );
  useLayoutEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (visible) {
      setPhase("entering");
      timer = setTimeout(() => setPhase("open"), 340);
    } else {
      setPhase((current) => (current === "hidden" ? "hidden" : "exiting"));
      timer = setTimeout(() => setPhase("hidden"), 320);
    }
    return () => clearTimeout(timer);
  }, [visible]);
  return { phase, rendered: visible || phase !== "hidden" };
}

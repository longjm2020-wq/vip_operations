import { useLayoutEffect, useState } from "react";

type CaptionPhase = "hidden" | "entering" | "open" | "exiting";

/** Keep only the outgoing presentation alive; microphone ownership never moves here. */
export function useCompanionCaptionPresence(visible: boolean) {
  const [phase, setPhase] = useState<CaptionPhase>(
    visible ? "entering" : "hidden",
  );
  useLayoutEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (visible) {
      setPhase(reduced.matches ? "open" : "entering");
      if (!reduced.matches) timer = setTimeout(() => setPhase("open"), 340);
    } else {
      setPhase((current) =>
        current === "hidden" || reduced.matches ? "hidden" : "exiting",
      );
      if (!reduced.matches) timer = setTimeout(() => setPhase("hidden"), 320);
    }
    const stopMotion = () => {
      if (!reduced.matches) return;
      clearTimeout(timer);
      setPhase(visible ? "open" : "hidden");
    };
    reduced.addEventListener("change", stopMotion);
    return () => {
      clearTimeout(timer);
      reduced.removeEventListener("change", stopMotion);
    };
  }, [visible]);
  return { phase, rendered: visible || phase !== "hidden" };
}

import { useLayoutEffect, useState, useSyncExternalStore } from "react";

export type WorkspacePresence = "closed" | "entering" | "open" | "leaving";
const covers = new Set<symbol>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => covers.size > 0;
const notify = () => listeners.forEach((listener) => listener());

/** Independent overlays release only their own cover, including on navigation. */
export function useWorkspaceSceneCover(active: boolean) {
  useLayoutEffect(() => {
    if (!active) return;
    const token = Symbol();
    covers.add(token);
    notify();
    return () => {
      covers.delete(token);
      notify();
    };
  }, [active]);
}

export function useWorkspacePresence(active: boolean): WorkspacePresence {
  const [phase, setPhase] = useState<WorkspacePresence>("closed");
  useLayoutEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => setPhase(active ? "open" : "closed");
    const change = () => {
      if (reduced.matches) {
        clearTimeout(timer);
        settle();
      }
    };
    if (reduced.matches) settle();
    else {
      setPhase((previous) =>
        active ? "entering" : previous === "closed" ? "closed" : "leaving",
      );
      timer = setTimeout(settle, 520);
    }
    reduced.addEventListener("change", change);
    return () => {
      clearTimeout(timer);
      reduced.removeEventListener("change", change);
    };
  }, [active]);
  return phase;
}

export function useWorkspaceScenePresence() {
  return useWorkspacePresence(
    useSyncExternalStore(subscribe, snapshot, () => false),
  );
}

import { useLayoutEffect, useState } from "react";
import { applyWorkspaceHubMetrics } from "./workspace-hub-layout.js";

/** Measure the stage box and scale nest, mascot and orbit together to fill it. */
export function useWorkspaceHubStage() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    const apply = () => {
      applyWorkspaceHubMetrics(element);
      window.dispatchEvent(new Event("xuti-workspace-layout"));
    };
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    apply();
    return () => observer.disconnect();
  }, [element]);
  return setElement;
}

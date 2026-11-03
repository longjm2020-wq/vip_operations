import { useEffect, useRef } from "react";
import "./workspace-three.css";

/** Load the GPU renderer separately; the existing accessible controls stay mounted. */
function ThreeVisual({ mode }: { mode: "nest" | "robot" }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let disposed = false;
    let release: (() => void) | undefined;
    element.dataset.rendererState = "loading";
    void import("./workspace-three-runtime")
      .then(({ mountWorkspaceThree }) => {
        if (!disposed) release = mountWorkspaceThree(element, mode);
      })
      .catch(() => {
        if (!disposed) element.dataset.rendererState = "fallback";
      });
    return () => {
      disposed = true;
      release?.();
    };
  }, [mode]);
  return (
    <canvas
      ref={canvas}
      className={
        mode === "nest" ? "workspace-three-canvas" : "companion-three-canvas"
      }
      aria-hidden="true"
    />
  );
}

export function WorkspaceThreeScene() {
  return <ThreeVisual mode="nest" />;
}

export function CompanionThreeVisual() {
  return <ThreeVisual mode="robot" />;
}

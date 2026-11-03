import { useLayoutEffect, useRef, type PointerEvent } from "react";

/** A ring-only gesture surface; the robot and blank 3D scene retain their own controls. */
export function WorkspaceNestHandle({
  branchLayout,
  onToggleBranches,
}: {
  branchLayout: boolean;
  onToggleBranches: () => void;
}) {
  const handle = useRef<HTMLButtonElement>(null);
  const latest = useRef({ branchLayout, onToggleBranches });
  latest.current = { branchLayout, onToggleBranches };
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    dx: number;
    dy: number;
    moved: boolean;
    branch: boolean;
    surface: HTMLElement | null;
  } | null>(null);
  const suppressed = useRef(false);
  const clearClick = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const previousLayout = useRef(branchLayout);
  const ready = () => {
    const current = drag.current;
    return (
      !!current &&
      (current.branch ? current.dx >= 56 : current.dx <= -56) &&
      Math.abs(current.dx) >= Math.abs(current.dy) * 1.3
    );
  };
  const finish = (commit: boolean, event?: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || (event && current.id !== event.pointerId)) return;
    if (commit && event) {
      current.dx = event.clientX - current.x;
      current.dy = event.clientY - current.y;
      current.moved ||= Math.hypot(current.dx, current.dy) > 6;
    }
    const shouldToggle =
      commit && ready() && current.branch === latest.current.branchLayout;
    drag.current = null;
    const button = handle.current;
    if (current.surface) delete current.surface.dataset.nestDragging;
    if (button) {
      delete button.dataset.ready;
      if (button.hasPointerCapture(current.id))
        button.releasePointerCapture(current.id);
    }
    suppressed.current = current.moved;
    clearTimeout(clearClick.current);
    clearClick.current = setTimeout(() => {
      suppressed.current = false;
    }, 0);
    if (shouldToggle) latest.current.onToggleBranches();
  };
  const cancel = useRef(() => finish(false));
  cancel.current = () => finish(false);
  useLayoutEffect(() => {
    const blur = () => cancel.current();
    const visibility = () => {
      if (document.hidden) cancel.current();
    };
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancel.current();
      clearTimeout(clearClick.current);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useLayoutEffect(() => {
    const changed = previousLayout.current !== branchLayout;
    previousLayout.current = branchLayout;
    if (changed) cancel.current();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    const started = performance.now();
    const track = (now: number) => {
      // The body's stable companion mirrors the moving nest without remounting.
      window.dispatchEvent(new Event("xuti-workspace-layout"));
      if (changed && !reduced.matches && now - started < 440)
        frame = requestAnimationFrame(track);
    };
    frame = requestAnimationFrame(track);
    return () => cancelAnimationFrame(frame);
  }, [branchLayout]);
  return (
    <button
      ref={handle}
      className="workspace-nest-handle"
      type="button"
      data-world-ui
      aria-label={branchLayout ? "拖动巢穴收起工作台" : "拖动巢穴展开工作台"}
      aria-expanded={branchLayout}
      title={
        branchLayout
          ? "向右拖动收起；Enter 或空格切换"
          : "向左拖动展开；Enter 或空格切换"
      }
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        suppressed.current = false;
        const surface = event.currentTarget.closest<HTMLElement>(
          ".personal-workspace",
        );
        drag.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          dx: 0,
          dy: 0,
          moved: false,
          branch: branchLayout,
          surface,
        };
        if (surface) surface.dataset.nestDragging = "true";
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        current.dx = event.clientX - current.x;
        current.dy = event.clientY - current.y;
        current.moved ||= Math.hypot(current.dx, current.dy) > 6;
        event.currentTarget.dataset.ready = String(ready());
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerUp={(event) => finish(true, event)}
      onPointerCancel={(event) => finish(false, event)}
      onLostPointerCapture={(event) => finish(false, event)}
      onKeyDown={(event) => {
        if (
          (event.key === "Enter" || event.key === " ") &&
          (event.repeat || drag.current)
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (suppressed.current) {
          event.preventDefault();
          suppressed.current = false;
        } else if (event.detail === 0) latest.current.onToggleBranches();
      }}
    >
      <svg viewBox="0 0 320 320" aria-hidden="true" focusable="false">
        <circle cx="160" cy="160" r="143" />
      </svg>
    </button>
  );
}

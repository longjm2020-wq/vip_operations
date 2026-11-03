import { useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";

/** Screen-space connector follows the existing draggable card without owning its position. */
export function WorkspacePanelLink({
  active,
  anchor,
  panel,
}: {
  active: boolean;
  anchor: HTMLElement | null;
  panel: RefObject<HTMLDivElement | null>;
}) {
  const path = useRef<SVGPathElement>(null);
  useLayoutEffect(() => {
    const target = panel.current;
    if (!active || !anchor || !target) return;
    let frame = 0;
    const paint = () => {
      frame = 0;
      if (!path.current) return;
      const source = (
        anchor.querySelector(".workspace-dock-label") || anchor
      ).getBoundingClientRect();
      const card = target.getBoundingClientRect();
      const gap = card.left - source.right;
      if (target.hidden || gap < 12 || innerWidth < 768) {
        path.current.setAttribute("d", "");
        return;
      }
      const y = source.top + source.height / 2;
      const endY = Math.max(card.top + 32, Math.min(card.bottom - 24, y));
      const mid = source.right + gap / 2;
      path.current.setAttribute(
        "d",
        `M ${source.right + 4} ${y} C ${mid} ${y} ${mid} ${endY} ${card.left - 2} ${endY}`,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(target, {
      attributes: true,
      attributeFilter: ["style", "hidden"],
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(target);
    for (const event of [
      "xuti-workspace-layout",
      "xuti-workspace-view",
      "resize",
      "scroll",
    ])
      window.addEventListener(event, schedule);
    paint();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      for (const event of [
        "xuti-workspace-layout",
        "xuti-workspace-view",
        "resize",
        "scroll",
      ])
        window.removeEventListener(event, schedule);
    };
  }, [active, anchor, panel]);
  return active
    ? createPortal(
        <svg className="workspace-branch-panel-link" aria-hidden="true">
          <path ref={path} />
        </svg>,
        document.body,
      )
    : null;
}

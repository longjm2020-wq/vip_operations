import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const DockStage = createContext<Element | null>(null);

/** Keep text and icons in screen space instead of magnifying a composited 3D bitmap. */
export function WorkspaceDockRendering({
  stage,
  children,
}: {
  stage: Element | null;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    if (!stage) return;
    const root = stage.closest<HTMLElement>(".personal-workspace");
    const orbit = stage.querySelector<HTMLElement>(".workspace-dock-orbit");
    const nav = stage.querySelector<HTMLElement>(".workspace-dock");
    if (!root || !orbit || !nav) return;
    let frame = 0,
      visible = true,
      settleUntil = 0;
    const styles = new WeakMap<HTMLElement, string>();
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const paint = () => {
      frame = 0;
      if (document.hidden || !visible) return;
      const origin = stage.getBoundingClientRect();
      const copies = [
        ...stage.querySelectorAll<HTMLElement>(".workspace-dock-copy"),
      ];
      // Read every projected rectangle before writing, so one paint never thrashes layout.
      const measurements = [
        ...nav.querySelectorAll<HTMLElement>(".workspace-dock-item"),
      ].map((item) => ({
        item,
        box: item
          .querySelector(".workspace-dock-label")!
          .getBoundingClientRect(),
        copy: copies.find(
          (copy) => copy.dataset.dockCopy === item.dataset.panel,
        ),
      }));
      const moving =
        !motion.matches &&
        (performance.now() < settleUntil ||
          orbit
            .getAnimations()
            .some((animation) => animation.playState === "running") ||
          measurements.some(({ item }) =>
            item
              .getAnimations()
              .some((animation) => animation.playState === "running"),
          ));
      const snap = (value: number) =>
        Math.round(value * devicePixelRatio) / devicePixelRatio;
      for (const { box, copy } of measurements) {
        if (!copy) continue;
        const style = `left:${snap(box.left - origin.left)}px;top:${snap(box.top - origin.top)}px;width:${snap(box.width)}px;height:${snap(box.height)}px;font-size:${Math.max(10, Math.min(20, (box.width * 12) / 74))}px;visibility:${box.width > 0 && box.height > 0 ? "visible" : "hidden"}`;
        if (styles.get(copy) !== style) {
          copy.style.cssText = style;
          styles.set(copy, style);
        }
      }
      if (moving) frame = requestAnimationFrame(paint);
    };
    const schedule = () => {
      // Layout transitions may not be registered by getAnimations() until the
      // next frame. Follow the entire 360 ms transition, including its last paint.
      settleUntil = performance.now() + 450;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(stage);
    const changes = new MutationObserver(schedule);
    changes.observe(root, {
      attributes: true,
      attributeFilter: [
        "style",
        "data-workspace-layout",
        "data-world-dragging",
        "data-nest-dragging",
      ],
    });
    changes.observe(nav, {
      attributes: true,
      attributeFilter: ["data-paused"],
    });
    const visibility = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      schedule();
    });
    visibility.observe(stage);
    for (const event of [
      "pointerenter",
      "pointerleave",
      "focusin",
      "focusout",
      "transitionrun",
    ])
      stage.addEventListener(event, schedule);
    for (const event of [
      "resize",
      "xuti-workspace-layout",
      "xuti-workspace-view",
    ])
      window.addEventListener(event, schedule);
    document.addEventListener("visibilitychange", schedule);
    motion.addEventListener("change", schedule);
    paint();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      changes.disconnect();
      visibility.disconnect();
      for (const event of [
        "pointerenter",
        "pointerleave",
        "focusin",
        "focusout",
        "transitionrun",
      ])
        stage.removeEventListener(event, schedule);
      for (const event of [
        "resize",
        "xuti-workspace-layout",
        "xuti-workspace-view",
      ])
        window.removeEventListener(event, schedule);
      document.removeEventListener("visibilitychange", schedule);
      motion.removeEventListener("change", schedule);
    };
  }, [stage]);
  return <DockStage.Provider value={stage}>{children}</DockStage.Provider>;
}

export function WorkspaceDockCopy({
  panel,
  icon,
  label,
}: {
  panel: string;
  icon: ReactNode;
  label: string;
}) {
  const stage = useContext(DockStage);
  const content = (
    <>
      <span className="workspace-dock-icon" aria-hidden>
        {icon}
      </span>
      <strong>{label}</strong>
    </>
  );
  return stage
    ? createPortal(
        <span
          className="workspace-dock-copy"
          data-dock-copy={panel}
          aria-hidden="true"
        >
          {content}
        </span>,
        stage,
      )
    : content;
}

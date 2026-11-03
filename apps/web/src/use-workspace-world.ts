import { useEffect, useRef } from "react";

type View = { pitch: number; yaw: number; x: number; y: number; zoom: number };
const initialView = (): View => ({ pitch: 0, yaw: 0, x: 0, y: 0, zoom: 1 });
const controls = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "label",
  "summary",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="dialog"]',
  "[data-world-ui]",
  ".workspace-ai-companion-slot",
  ".workspace-companion",
  ".workspace-dock",
  ".assistant-compose",
  ".personal-workspace-panel",
  ".companion-voice-bubble",
  ".ant-select",
  ".ant-picker",
  ".ant-popover",
  ".ant-dropdown",
].join(",");

/** The camera moves DOM/CSS and the decorative canvas, never the React workbench. */
export function useWorkspaceWorld() {
  const surface = useRef<HTMLDivElement>(null);
  const actions = useRef({
    reset: () => {},
    zoom: (_factor: number) => {},
    mode: (_mode: "rotate" | "pan") => {},
  });
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    let view = initialView(),
      mode: "rotate" | "pan" = "rotate";
    let frame = 0;
    let drag: {
      id: number;
      x: number;
      y: number;
      origin: View;
      pan: boolean;
      moved: boolean;
    } | null = null;
    const paint = () => {
      frame = 0;
      for (const [key, value] of Object.entries(view)) {
        element.dataset[`world${key[0].toUpperCase()}${key.slice(1)}`] =
          String(value);
      }
      element.style.setProperty("--world-pitch", `${view.pitch}deg`);
      element.style.setProperty("--world-yaw", `${view.yaw}deg`);
      element.style.setProperty("--world-pan-x", `${view.x}px`);
      element.style.setProperty("--world-pan-y", `${view.y}px`);
      element.style.setProperty("--world-zoom", String(view.zoom));
      const output = element.querySelector("[data-world-scale]");
      if (output) output.textContent = `${Math.round(view.zoom * 100)}%`;
      window.dispatchEvent(
        new CustomEvent("xuti-workspace-view", { detail: { ...view } }),
      );
    };
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const setMode = (next: "rotate" | "pan") => {
      mode = next;
      element.dataset.worldMode = next;
      for (const button of element.querySelectorAll(
        "[data-world-mode-button]",
      )) {
        button.setAttribute(
          "aria-pressed",
          String(button.getAttribute("data-world-mode-button") === next),
        );
      }
    };
    const finish = (event?: PointerEvent) => {
      if (event && drag?.id !== event.pointerId) return;
      const current = drag;
      drag = null;
      delete element.dataset.worldDragging;
      if (frame) cancelAnimationFrame(frame);
      paint();
      if (current && element.hasPointerCapture(current.id))
        element.releasePointerCapture(current.id);
    };
    const reset = () => {
      finish();
      view = initialView();
      setMode("rotate");
      // Synchronous: a companion returning from off-screen can remeasure its nest now.
      paint();
      window.dispatchEvent(new Event("xuti-workspace-layout-reset"));
    };
    const zoom = (factor: number) => {
      view.zoom =
        Math.round(Math.max(0.55, Math.min(1.65, view.zoom * factor)) * 10000) /
        10000;
      queue();
    };
    const isControl = (event: Event) =>
      !(event.target instanceof Element) ||
      !element.contains(event.target) ||
      !!event.target.closest(controls);
    const start = (event: PointerEvent) => {
      if (
        event.defaultPrevented ||
        isControl(event) ||
        !event.isPrimary ||
        drag ||
        (event.button !== 0 && event.button !== 1)
      )
        return;
      event.preventDefault();
      element.focus({ preventScroll: true });
      element.setPointerCapture(event.pointerId);
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        origin: { ...view },
        pan: mode === "pan" || event.shiftKey || event.button === 1,
        moved: false,
      };
      element.dataset.worldDragging = "true";
    };
    const move = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x,
        dy = event.clientY - drag.y;
      drag.moved ||= Math.hypot(dx, dy) > 3;
      if (drag.pan) {
        view.x = drag.origin.x + dx;
        view.y = drag.origin.y + dy;
      } else {
        view.pitch =
          Math.round(
            Math.max(-75, Math.min(75, drag.origin.pitch - dy * 0.3)) * 100,
          ) / 100;
        view.yaw = Math.round((drag.origin.yaw + dx * 0.3) * 100) / 100;
      }
      event.preventDefault();
      queue();
    };
    const wheel = (event: WheelEvent) => {
      // Browser zoom, native fields and panel scrolling retain their usual behavior.
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        isControl(event)
      )
        return;
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
      zoom(Math.exp(-Math.max(-1000, Math.min(1000, delta)) * 0.0015));
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.target !== element ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      const direction: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      if (event.key === "Home") {
        event.preventDefault();
        reset();
      } else if (["+", "=", "-", "_"].includes(event.key)) {
        event.preventDefault();
        zoom(["-", "_"].includes(event.key) ? 1 / 1.15 : 1.15);
      } else if (direction[event.key]) {
        event.preventDefault();
        const [x, y] = direction[event.key];
        if (event.shiftKey || mode === "pan") {
          view.x += x * 40;
          view.y += y * 40;
        } else {
          view.yaw += x * 4;
          view.pitch = Math.max(-75, Math.min(75, view.pitch + y * 4));
        }
        queue();
      } else if (event.key === "Escape") finish();
    };
    const doubleClick = (event: MouseEvent) => {
      if (!isControl(event)) {
        event.preventDefault();
        reset();
      }
    };
    const visibility = () => {
      if (document.hidden) finish();
    };
    const blur = () => finish();
    const auxClick = (event: MouseEvent) => {
      if (event.button === 1 && !isControl(event)) event.preventDefault();
    };
    actions.current = { reset, zoom, mode: setMode };
    setMode("rotate");
    paint();
    // Sidebar transitions resize the scene without a window resize event.
    let layoutFrame = 0;
    const layoutObserver = new ResizeObserver(() => {
      if (!layoutFrame)
        layoutFrame = requestAnimationFrame(() => {
          layoutFrame = 0;
          window.dispatchEvent(new Event("xuti-workspace-layout"));
        });
    });
    layoutObserver.observe(element);
    element.addEventListener("pointerdown", start);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", finish);
    element.addEventListener("pointercancel", finish);
    element.addEventListener("lostpointercapture", finish);
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("keydown", key);
    element.addEventListener("dblclick", doubleClick);
    element.addEventListener("auxclick", auxClick);
    window.addEventListener("blur", blur);
    window.addEventListener("xuti-workspace-center", reset);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      cancelAnimationFrame(layoutFrame);
      layoutObserver.disconnect();
      const current = drag;
      drag = null;
      if (current && element.hasPointerCapture(current.id))
        element.releasePointerCapture(current.id);
      element.removeEventListener("pointerdown", start);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", finish);
      element.removeEventListener("pointercancel", finish);
      element.removeEventListener("lostpointercapture", finish);
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("keydown", key);
      element.removeEventListener("dblclick", doubleClick);
      element.removeEventListener("auxclick", auxClick);
      window.removeEventListener("blur", blur);
      window.removeEventListener("xuti-workspace-center", reset);
      document.removeEventListener("visibilitychange", visibility);
      actions.current = { reset: () => {}, zoom: () => {}, mode: () => {} };
    };
  }, []);
  return {
    surface,
    reset: () => actions.current.reset(),
    zoom: (factor: number) => actions.current.zoom(factor),
    mode: (next: "rotate" | "pan") => actions.current.mode(next),
  };
}

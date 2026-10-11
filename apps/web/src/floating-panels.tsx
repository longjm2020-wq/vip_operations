import { useEffect } from "react";
import "./floating-panels.css";

const panelSelector = ".ant-modal";
const ownedSelector = ".table-find-replace-modal, [data-floating-panel-fixed], [data-floating-panel-owned]";
const interactiveSelector = "button, input, textarea, select, a, label, [contenteditable], [role='button'], [role='textbox'], [role='combobox'], [role='checkbox'], [role='switch']";
const margin = 8;
type PanelState = {
  panel: HTMLElement;
  wrapper: HTMLElement;
  handle: HTMLElement | null;
  fallback: HTMLButtonElement | null;
  active: boolean;
  moved: boolean;
  x: number;
  y: number;
  sizeObserver: ResizeObserver;
  visibilityObserver: MutationObserver;
};
type Drag = { state: PanelState; handle: HTMLElement; pointerId: number; startX: number; startY: number; offsetX: number; offsetY: number; clientX: number; clientY: number };

/** Adapt portal dialogs, including imperative confirmations, without replacing business Modal APIs. */
export function FloatingPanels() {
  useEffect(() => {
    const states = new Map<HTMLElement, PanelState>();
    let drag: Drag | null = null, dragFrame = 0, layoutFrame = 0;
    const pending = new Set<PanelState>();
    const viewport = () => {
      const view = window.visualViewport;
      return { left: view?.offsetLeft || 0, top: view?.offsetTop || 0, width: view?.width || window.innerWidth, height: view?.height || window.innerHeight };
    };
    const writeOffset = (state: PanelState, x: number, y: number) => {
      if (state.x === x && state.y === y) return;
      state.x = x; state.y = y;
      // Individual translate composes with rc-motion's opening/closing transform.
      state.panel.style.setProperty("--floating-panel-x", `${x}px`);
      state.panel.style.setProperty("--floating-panel-y", `${y}px`);
    };
    const constrain = (state: PanelState, x: number, y: number) => {
      const rect = state.panel.getBoundingClientRect(), view = viewport();
      const left = rect.left + x - state.x, top = rect.top + y - state.y;
      const maxLeft = view.left + Math.max(margin, view.width - rect.width - margin);
      // Tall dialogs remain scrollable; retain the title/handle above their content.
      const maxTop = view.top + Math.max(margin, view.height - Math.min(rect.height, view.height - margin * 2) - margin);
      writeOffset(state,
        x + Math.max(view.left + margin, Math.min(left, maxLeft)) - left,
        y + Math.max(view.top + margin, Math.min(top, maxTop)) - top);
    };
    const finishDrag = () => {
      if (dragFrame) cancelAnimationFrame(dragFrame);
      dragFrame = 0;
      const current = drag; drag = null;
      if (!current) return;
      current.state.panel.classList.remove("floating-panel-dragging");
      if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    };
    const detachHandle = (state: PanelState) => {
      state.handle?.removeAttribute("data-floating-panel-handle");
      state.fallback?.remove();
      state.handle = null; state.fallback = null;
    };
    const reset = (state: PanelState) => {
      if (drag?.state === state) finishDrag();
      state.moved = false; state.x = 0; state.y = 0;
      state.panel.style.removeProperty("--floating-panel-x");
      state.panel.style.removeProperty("--floating-panel-y");
      state.panel.classList.remove("floating-panel-movable", "floating-panel-dragging");
      detachHandle(state);
    };
    const refresh = (state: PanelState) => {
      if (!state.panel.isConnected) return;
      const active = !state.panel.matches(ownedSelector) && !state.panel.closest("[data-floating-panel-fixed]") && getComputedStyle(state.wrapper).display !== "none" && state.wrapper.getAttribute("aria-hidden") !== "true";
      if (!active) { if (state.active) reset(state); state.active = false; return; }
      state.active = true;
      const header = state.panel.querySelector<HTMLElement>(".ant-modal-header");
      const confirmTitle = state.panel.querySelector<HTMLElement>(".ant-modal-confirm-title");
      const visibleTitle = [header, confirmTitle].find(element => element && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().height > 0);
      if (visibleTitle && state.handle !== visibleTitle) {
        detachHandle(state);
        state.handle = visibleTitle;
        visibleTitle.setAttribute("data-floating-panel-handle", "title");
      } else if (!visibleTitle && !state.fallback?.isConnected) {
        detachHandle(state);
        const grip = document.createElement("button");
        grip.type = "button";
        grip.className = "floating-panel-grip";
        grip.setAttribute("aria-label", "移动窗口");
        grip.title = "拖动此处移动窗口；方向键微调位置";
        grip.setAttribute("data-floating-panel-handle", "grip");
        grip.textContent = "⠿";
        (state.panel.querySelector(".ant-modal-container, .ant-modal-content") || state.panel).append(grip);
        state.handle = grip; state.fallback = grip;
      }
      if (!state.panel.classList.contains("floating-panel-movable")) state.panel.classList.add("floating-panel-movable");
      if (state.moved) constrain(state, state.x, state.y);
    };
    const scheduleLayout = (state: PanelState) => {
      pending.add(state);
      if (!layoutFrame) layoutFrame = requestAnimationFrame(() => {
        layoutFrame = 0;
        for (const item of pending) refresh(item);
        pending.clear();
      });
    };
    const remove = (state: PanelState) => {
      state.sizeObserver.disconnect(); state.visibilityObserver.disconnect();
      pending.delete(state); reset(state); states.delete(state.panel);
    };
    const register = (panel: HTMLElement) => {
      if (states.has(panel) || panel.matches(ownedSelector)) return;
      const wrapper = panel.closest<HTMLElement>(".ant-modal-wrap");
      if (!wrapper) return;
      const state: PanelState = { panel, wrapper, active: false, moved: false, x: 0, y: 0, handle: null, fallback: null,
        sizeObserver: new ResizeObserver(() => scheduleLayout(state)),
        visibilityObserver: new MutationObserver(() => scheduleLayout(state)) };
      states.set(panel, state);
      state.sizeObserver.observe(panel);
      // Observe visibility only on these two small nodes, not table attributes.
      state.visibilityObserver.observe(wrapper, { attributes: true, attributeFilter: ["style", "class", "aria-hidden"] });
      state.visibilityObserver.observe(panel, { attributes: true, attributeFilter: ["class", "aria-hidden"] });
      refresh(state);
    };
    const discover = (node: Node) => {
      if (!(node instanceof HTMLElement)) return;
      if (node.matches(panelSelector)) register(node);
      // Portals enter through div branches. Table row/cell mutations do not scan the sheet.
      if (["DIV", "SECTION", "MAIN"].includes(node.tagName)) node.querySelectorAll<HTMLElement>(panelSelector).forEach(register);
      const panel = node.closest<HTMLElement>(panelSelector), state = panel && states.get(panel);
      if (state) scheduleLayout(state);
    };
    document.querySelectorAll<HTMLElement>(panelSelector).forEach(register);
    const portals = new MutationObserver(records => {
      let removed = false;
      for (const record of records) {
        record.addedNodes.forEach(discover);
        removed ||= record.removedNodes.length > 0;
        const panel = record.target instanceof Element ? record.target.closest<HTMLElement>(panelSelector) : null;
        const state = panel && states.get(panel);
        if (state) scheduleLayout(state);
      }
      if (removed) for (const state of states.values()) if (!state.panel.isConnected) remove(state);
    });
    portals.observe(document.body, { childList: true, subtree: true });
    const move = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      drag.clientX = event.clientX; drag.clientY = event.clientY;
      if (!dragFrame) dragFrame = requestAnimationFrame(() => {
        dragFrame = 0;
        if (drag) constrain(drag.state, drag.offsetX + drag.clientX - drag.startX, drag.offsetY + drag.clientY - drag.startY);
      });
    };
    const start = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return;
      const handle = event.target.closest<HTMLElement>("[data-floating-panel-handle]");
      const panel = handle?.closest<HTMLElement>(panelSelector), state = panel && states.get(panel);
      if (!handle || !state?.active || state.handle !== handle || event.target !== state.fallback && event.target.closest(interactiveSelector)) return;
      finishDrag();
      event.preventDefault(); event.stopPropagation();
      handle.setPointerCapture(event.pointerId);
      state.moved = true;
      state.panel.classList.add("floating-panel-dragging");
      drag = { state, handle, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        offsetX: state.x, offsetY: state.y, clientX: event.clientX, clientY: event.clientY };
    };
    const end = (event: PointerEvent) => { if (drag?.pointerId === event.pointerId) { if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = 0; constrain(drag.state, drag.offsetX + drag.clientX - drag.startX, drag.offsetY + drag.clientY - drag.startY); } finishDrag(); } };
    const key = (event: KeyboardEvent) => {
      if (!(event.target instanceof HTMLButtonElement) || !event.target.matches(".floating-panel-grip") || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      const panel = event.target.closest<HTMLElement>(panelSelector), state = panel && states.get(panel);
      if (!state?.active) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 40 : 16;
      state.moved = true;
      constrain(state, state.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), state.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0));
    };
    const resize = () => { for (const state of states.values()) if (state.active && state.moved) scheduleLayout(state); };
    document.addEventListener("pointerdown", start);
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
    document.addEventListener("lostpointercapture", end);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", resize);
    window.addEventListener("blur", finishDrag);
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);
    return () => {
      portals.disconnect(); finishDrag();
      if (layoutFrame) cancelAnimationFrame(layoutFrame);
      for (const state of states.values()) remove(state);
      document.removeEventListener("pointerdown", start);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      document.removeEventListener("lostpointercapture", end);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", finishDrag);
      window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", resize);
    };
  }, []);
  return null;
}

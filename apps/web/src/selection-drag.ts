import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";

export function selectionScrollSpeed(position: number, start: number, end: number) {
  const zone = Math.min(48, (end - start) / 3);
  if (zone <= 0) return 0;
  if (position < start + zone) return -900 * Math.min(1, (start + zone - position) / zone) ** 2;
  if (position > end - zone) return 900 * Math.min(1, (position - end + zone) / zone) ** 2;
  return 0;
}

// Keep hit testing active while the pointer is stationary at a scrolling edge.
export function useSelectionDrag(
  sheetRef: RefObject<HTMLDivElement | null>,
  onHover: (element: HTMLElement) => void,
  onStop: () => void,
) {
  const callbacks = useRef({ onHover, onStop });
  callbacks.current = { onHover, onStop };
  const cleanup = useRef<(() => void) | null>(null);
  const stop = () => cleanup.current?.();
  useEffect(() => () => cleanup.current?.(), []);

  const start = (event: Pick<ReactMouseEvent, "clientX" | "clientY">, axis: "both" | "row" | "column" = "both", immediate = false) => {
    stop();
    const sheet = sheetRef.current;
    if (!sheet) return;
    const startX = event.clientX, startY = event.clientY;
    let x = startX, y = startY, frame = 0, previousTime = performance.now(), active = immediate;
    let previousTarget: HTMLElement | null = null;
    window.getSelection()?.removeAllRanges();
    sheet.classList.add("selection-dragging");
    const move = (event: MouseEvent) => {
      if (!(event.buttons & 1)) { stop(); return; }
      event.preventDefault();
      x = event.clientX; y = event.clientY;
      if (Math.hypot(x - startX, y - startY) >= 4) active = true;
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") stop(); };
    const preventSelection = (event: Event) => event.preventDefault();
    const hover = (scroll = 0) => {
      if (!active) return;
      const rect = sheet.getBoundingClientRect();
      const left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.left + sheet.clientWidth);
      const top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.top + sheet.clientHeight);
      if (right > left && bottom > top) {
        if (axis !== "row") sheet.scrollLeft += selectionScrollSpeed(x, left, right) * scroll;
        if (axis !== "column") sheet.scrollTop += selectionScrollSpeed(y, top, bottom) * scroll;
        const header = sheet.querySelector("thead th")?.getBoundingClientRect();
        const bodyTop = Math.max(top, header?.bottom || top);
        const hitX = Math.max(left + 2, Math.min(right - 2, x));
        const hitY = axis === "column" ? top + 12 : Math.max(Math.min(bodyTop + 2, bottom - 2), Math.min(bottom - 2, y));
        const target = document.elementFromPoint(hitX, hitY)?.closest<HTMLElement>("td, th") || null;
        if (target && sheet.contains(target) && target !== previousTarget) {
          callbacks.current.onHover(target);
          previousTarget = target;
        }
      }
    };
    const release = (event: MouseEvent) => {
      x = event.clientX; y = event.clientY;
      hover(); stop();
    };
    const tick = (time: number) => {
      hover(Math.max(0, Math.min(32, time - previousTime)) / 1000);
      previousTime = time;
      frame = requestAnimationFrame(tick);
    };
    cleanup.current = () => {
      cleanup.current = null;
      cancelAnimationFrame(frame);
      sheet.classList.remove("selection-dragging");
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", release);
      window.removeEventListener("blur", stop);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("selectstart", preventSelection);
      callbacks.current.onStop();
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", release);
    window.addEventListener("blur", stop);
    window.addEventListener("keydown", escape);
    document.addEventListener("selectstart", preventSelection);
    frame = requestAnimationFrame(tick);
  };
  return { start, stop };
}

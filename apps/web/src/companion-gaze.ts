const IDLE_MS = 2400;
const LERP = 0.18;

export type CompanionGazeLimits = {
  range: number;
  maxX: number;
  maxYUp: number;
  maxYDown: number;
};

export function companionGazeOffset(
  pointerX: number,
  pointerY: number,
  originX: number,
  originY: number,
  limits: CompanionGazeLimits,
): { x: number; y: number } {
  const dx = pointerX - originX;
  const dy = pointerY - originY;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.5 || limits.range <= 0) return { x: 0, y: 0 };
  const reach = Math.min(1, dist / limits.range);
  const amount = reach * (2 - reach);
  const x = clamp(
    (dx / dist) * amount * limits.maxX,
    -limits.maxX,
    limits.maxX,
  );
  const yLimit = dy < 0 ? limits.maxYUp : limits.maxYDown;
  const y = clamp(
    (dy / dist) * amount * yLimit,
    -limits.maxYUp,
    limits.maxYDown,
  );
  return { x, y };
}

export function lerpGaze(current: number, target: number, factor: number) {
  return current + (target - current) * factor;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const figures = new Set<HTMLElement>();
const current = new WeakMap<HTMLElement, { x: number; y: number }>();
const pointer = { x: 0, y: 0, active: false, movedAt: 0 };
let raf = 0;
let unbind: (() => void) | null = null;
let reduced = false;

function canTrack(event: PointerEvent) {
  return event.pointerType === "mouse" || event.pointerType === "pen";
}

function start() {
  if (unbind || typeof window === "undefined") return;
  const onMove = (event: PointerEvent) => {
    if (reduced || !canTrack(event)) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active = true;
    pointer.movedAt = performance.now();
    schedule();
  };
  const rest = () => {
    pointer.active = false;
    schedule();
  };
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const onMotion = () => {
    reduced = motion.matches;
    if (reduced) pointer.active = false;
    schedule();
  };
  onMotion();
  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("pointerleave", rest);
  document.addEventListener("mouseleave", rest);
  window.addEventListener("blur", rest);
  motion.addEventListener("change", onMotion);
  unbind = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerleave", rest);
    document.removeEventListener("mouseleave", rest);
    window.removeEventListener("blur", rest);
    motion.removeEventListener("change", onMotion);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    unbind = null;
  };
  schedule();
}

function schedule() {
  if (!raf) raf = requestAnimationFrame(tick);
}

function tick() {
  raf = 0;
  const now = performance.now();
  const idle = !pointer.active || now - pointer.movedAt > IDLE_MS;
  let keepGoing = false;
  for (const el of figures) {
    const rect = el.getBoundingClientRect();
    const width = rect.width;
    const target =
      reduced || idle || width < 8
        ? { x: 0, y: 0 }
        : companionGazeOffset(
            pointer.x,
            pointer.y,
            rect.left + width / 2,
            rect.top + rect.height * 0.4867,
            {
              range: width * 1.85,
              maxX: width * 0.042,
              maxYUp: width * 0.034,
              maxYDown: width * 0.012,
            },
          );
    const prev = current.get(el) || { x: 0, y: 0 };
    const next = {
      x: lerpGaze(prev.x, target.x, LERP),
      y: lerpGaze(prev.y, target.y, LERP),
    };
    if (target.x === 0 && Math.abs(next.x) < 0.02) next.x = 0;
    if (target.y === 0 && Math.abs(next.y) < 0.02) next.y = 0;
    current.set(el, next);
    el.style.setProperty("--companion-gaze-x", `${next.x.toFixed(2)}px`);
    el.style.setProperty("--companion-gaze-y", `${next.y.toFixed(2)}px`);
    if (
      Math.abs(next.x - target.x) > 0.04 ||
      Math.abs(next.y - target.y) > 0.04
    ) {
      keepGoing = true;
    }
  }
  if (keepGoing || (!idle && !reduced && figures.size)) schedule();
}

export function subscribeCompanionGaze(el: HTMLElement) {
  figures.add(el);
  current.set(el, { x: 0, y: 0 });
  start();
  return () => {
    figures.delete(el);
    current.delete(el);
    el.style.removeProperty("--companion-gaze-x");
    el.style.removeProperty("--companion-gaze-y");
    if (!figures.size) unbind?.();
  };
}

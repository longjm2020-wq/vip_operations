const IDLE_MS = 2400;
const LERP = 0.18;
const FRAME_MS = 1000 / 60;
const SETTLED = 0.04;

/** Keep the same gentle response on 60 Hz and high-refresh screens. */
export function companionGazeFactor(elapsedMs: number) {
  return 1 - Math.pow(1 - LERP, clamp(elapsedMs, 0, 64) / FRAME_MS);
}

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

/** Mouth follows the eyes in the same direction, with slightly less travel for parallax. */
export const COMPANION_MOUTH_GAZE = 0.8;

export function companionMouthOffset(gaze: { x: number; y: number }) {
  return {
    x: gaze.x * COMPANION_MOUTH_GAZE,
    y: gaze.y * COMPANION_MOUTH_GAZE,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const figures = new Set<HTMLElement>();
const current = new WeakMap<HTMLElement, { x: number; y: number }>();
const pointer = { x: 0, y: 0, active: false, movedAt: 0 };
let raf = 0;
let unbind: (() => void) | null = null;
let frameAt = 0;

function canTrack(event: PointerEvent) {
  return event.pointerType === "mouse" || event.pointerType === "pen";
}

function start() {
  if (unbind || typeof window === "undefined") return;
  const onMove = (event: PointerEvent) => {
    if (!canTrack(event) || document.hidden) return;
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
  const visibility = () => {
    if (document.hidden) rest();
  };
  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("pointerleave", rest);
  document.addEventListener("mouseleave", rest);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("blur", rest);
  unbind = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerleave", rest);
    document.removeEventListener("mouseleave", rest);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("blur", rest);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    frameAt = 0;
    pointer.active = false;
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
  const elapsed = frameAt ? now - frameAt : FRAME_MS;
  frameAt = now;
  const idle = !pointer.active || now - pointer.movedAt > IDLE_MS;
  let keepGoing = false;
  for (const el of figures) {
    const rect = el.getBoundingClientRect();
    const width = rect.width;
    const target =
      idle || document.hidden || width < 8
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
              maxYDown: width * 0.016,
            },
          );
    const prev = current.get(el) || { x: 0, y: 0 };
    // Five facial features keep their explicit local interaction preference;
    // leaving the window eases home, while a hidden page does no visible work.
    const factor = document.hidden ? 1 : companionGazeFactor(elapsed);
    const next = {
      x: lerpGaze(prev.x, target.x, factor),
      y: lerpGaze(prev.y, target.y, factor),
    };
    if (target.x === 0 && Math.abs(next.x) <= SETTLED) next.x = 0;
    if (target.y === 0 && Math.abs(next.y) <= SETTLED) next.y = 0;
    current.set(el, next);
    const mouth = companionMouthOffset(next);
    el.style.setProperty("--companion-gaze-x", `${next.x.toFixed(2)}px`);
    el.style.setProperty("--companion-gaze-y", `${next.y.toFixed(2)}px`);
    el.style.setProperty("--companion-mouth-x", `${mouth.x.toFixed(2)}px`);
    el.style.setProperty("--companion-mouth-y", `${mouth.y.toFixed(2)}px`);
    if (
      Math.abs(next.x - target.x) > SETTLED ||
      Math.abs(next.y - target.y) > SETTLED
    ) {
      keepGoing = true;
    }
  }
  if (keepGoing || (!idle && !document.hidden && figures.size)) schedule();
  else frameAt = 0;
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
    el.style.removeProperty("--companion-mouth-x");
    el.style.removeProperty("--companion-mouth-y");
    if (!figures.size) unbind?.();
  };
}

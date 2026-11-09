import { useEffect, useRef } from "react";

type Trace = {
  x: number;
  y: number;
  radius: number;
  angle: number;
  born: number;
  brush: number;
};
const lifetime = 1800;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};
function noise(x: number, y: number, seed: number) {
  const hash = (a: number, b: number) => {
    let n = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ seed;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const ix = Math.floor(x),
    iy = Math.floor(y),
    fx = smooth(x - ix),
    fy = smooth(y - iy);
  const a = hash(ix, iy) * (1 - fx) + hash(ix + 1, iy) * fx;
  const b = hash(ix, iy + 1) * (1 - fx) + hash(ix + 1, iy + 1) * fx;
  return a * (1 - fy) + b * fy;
}

/** A small reusable alpha brush; the supplied photograph itself is unchanged. */
function cloudBrush(seed: number) {
  const brush = document.createElement("canvas");
  brush.width = brush.height = 192;
  const context = brush.getContext("2d")!;
  const pixels = context.createImageData(192, 192);
  for (let y = 0; y < 192; y++) {
    for (let x = 0; x < 192; x++) {
      const nx = (x - 96) / 96,
        ny = (y - 96) / 96;
      const angle = Math.atan2(ny, nx),
        radius = Math.hypot(nx, ny);
      const clouds =
        noise(x / 43, y / 43, seed) * 0.65 +
        noise(x / 18, y / 18, seed + 9) * 0.35;
      const edge =
        0.76 +
        Math.sin(angle * 3 + seed) * 0.09 +
        Math.sin(angle * 7 - seed) * 0.045 +
        (clouds - 0.5) * 0.18;
      const alpha = smooth((edge - radius) / 0.38) * (0.62 + clouds * 0.38);
      const offset = (y * 192 + x) * 4;
      pixels.data[offset] =
        pixels.data[offset + 1] =
        pixels.data[offset + 2] =
          255;
      pixels.data[offset + 3] = Math.round(alpha * 255);
    }
  }
  context.putImageData(pixels, 0, 0);
  return brush;
}

/** A stationary image is revealed only through short-lived, organic mouse masks. */
export function WorkspaceImageReveal() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const root = element?.closest<HTMLElement>(".personal-workspace");
    const context = element?.getContext("2d");
    if (!element || !root || !context) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const pointer = matchMedia("(any-hover: hover) and (any-pointer: fine)");
    const photo = new Image();
    photo.decoding = "async";
    let brushes: HTMLCanvasElement[] = [];
    let traces: Trace[] = [];
    let frame = 0,
      paintedAt = 0,
      width = 0,
      height = 0,
      dpr = 1;
    let ready = false,
      requested = false,
      failed = false,
      disposed = false,
      visible = true;
    let last: { x: number; y: number; time: number } | undefined;
    const blocked =
      "button,a,input,textarea,select,summary,[contenteditable=true],[role=dialog],.assistant-compose,.team-execution-rail,.personal-workspace-panel,.workspace-world-controls";
    const allowed = () =>
      !motion.matches &&
      pointer.matches &&
      !document.hidden &&
      visible &&
      (!root.dataset.scenePresence ||
        root.dataset.scenePresence === "closed") &&
      (!root.dataset.hologramPresence ||
        root.dataset.hologramPresence === "closed") &&
      root.dataset.worldDragging !== "true" &&
      root.dataset.nestDragging !== "true";
    const clear = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      traces = [];
      last = undefined;
      context.clearRect(0, 0, element.width, element.height);
      element.dataset.state = allowed() ? "idle" : "hidden";
    };
    const paint = (now: number) => {
      frame = 0;
      if (!allowed()) {
        clear();
        return;
      }
      if (!ready || !width || !height) return;
      if (now - paintedAt < 1000 / 30) {
        schedule();
        return;
      }
      paintedAt = now;
      traces = traces.filter((trace) => now - trace.born < lifetime);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      if (!traces.length) {
        element.dataset.state = "idle";
        return;
      }
      element.dataset.state = "revealing";
      context.globalCompositeOperation = "source-over";
      traces.forEach((trace) => {
        const age = now - trace.born;
        const fade =
          smooth(age / 150) * (1 - smooth((age - 380) / (lifetime - 380)));
        context.save();
        context.translate(trace.x, trace.y);
        context.rotate(trace.angle);
        context.globalAlpha = fade * 0.82;
        context.drawImage(
          brushes[trace.brush],
          -trace.radius,
          -trace.radius * 0.78,
          trace.radius * 2,
          trace.radius * 1.56,
        );
        context.restore();
      });
      // The mask moves; the image stays anchored to the entire workbench.
      const scale = Math.max(
        width / photo.naturalWidth,
        height / photo.naturalHeight,
      );
      const imageWidth = photo.naturalWidth * scale,
        imageHeight = photo.naturalHeight * scale;
      context.globalCompositeOperation = "source-in";
      context.globalAlpha = 0.76;
      context.drawImage(
        photo,
        (width - imageWidth) / 2,
        (height - imageHeight) / 2,
        imageWidth,
        imageHeight,
      );
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = 1;
      schedule();
    };
    const schedule = () => {
      if (!frame && !disposed && ready && allowed())
        frame = requestAnimationFrame(paint);
    };
    photo.onload = () => {
      if (disposed) return;
      ready = true;
      brushes = [cloudBrush(11), cloudBrush(37), cloudBrush(79)];
      if (allowed()) schedule();
    };
    photo.onerror = () => {
      failed = true;
      clear();
      element.dataset.state = "error";
    };
    const leave = () => {
      last = undefined;
      const now = performance.now();
      traces.forEach((trace) => {
        trace.born = Math.min(trace.born, now - lifetime + 350);
      });
      schedule();
    };
    const move = (event: PointerEvent) => {
      if (
        !allowed() ||
        event.pointerType === "touch" ||
        event.buttons ||
        failed
      )
        return;
      if (event.target instanceof Element && event.target.closest(blocked)) {
        leave();
        return;
      }
      const bounds = root.getBoundingClientRect();
      const x = event.clientX - bounds.left,
        y = event.clientY - bounds.top,
        now = performance.now();
      if (x < 0 || y < 0 || x > width || y > height) {
        leave();
        return;
      }
      if (!requested) {
        requested = true;
        element.dataset.state = "loading";
        photo.src = "/brand/workspace-space-reveal.png";
      }
      const distance = last ? Math.hypot(x - last.x, y - last.y) : 0;
      if (last && distance < 16 && now - last.time < 85) return;
      const radius = Math.max(150, Math.min(245, width * 0.15));
      traces.push({
        x,
        y,
        radius: radius * (0.94 + Math.min(0.15, distance / 500)),
        angle: last ? Math.atan2(y - last.y, x - last.x) * 0.18 : -0.18,
        born: now,
        brush: Math.floor(now / 95) % 3,
      });
      traces = traces.slice(-4);
      last = { x, y, time: now };
      schedule();
    };
    const measure = () => {
      width = root.clientWidth;
      height = root.clientHeight;
      dpr = Math.min(1.5, devicePixelRatio || 1);
      element.width = Math.max(1, Math.round(width * dpr));
      element.height = Math.max(1, Math.round(height * dpr));
      clear();
    };
    const resize = new ResizeObserver(measure);
    resize.observe(root);
    const presence = new MutationObserver(() => {
      if (!allowed()) clear();
    });
    presence.observe(root, {
      attributes: true,
      attributeFilter: [
        "data-scene-presence",
        "data-hologram-presence",
        "data-world-dragging",
        "data-nest-dragging",
      ],
    });
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (!visible) clear();
    });
    intersection.observe(root);
    const focus = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.closest(blocked))
        clear();
    };
    root.addEventListener("pointermove", move, { passive: true });
    root.addEventListener("pointerleave", leave, { passive: true });
    root.addEventListener("pointercancel", clear, { passive: true });
    root.addEventListener("focusin", focus);
    document.addEventListener("visibilitychange", clear);
    motion.addEventListener("change", clear);
    pointer.addEventListener("change", clear);
    measure();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      photo.onload = photo.onerror = null;
      resize.disconnect();
      presence.disconnect();
      intersection.disconnect();
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerleave", leave);
      root.removeEventListener("pointercancel", clear);
      root.removeEventListener("focusin", focus);
      document.removeEventListener("visibilitychange", clear);
      motion.removeEventListener("change", clear);
      pointer.removeEventListener("change", clear);
    };
  }, []);
  return (
    <canvas
      ref={canvas}
      className="workspace-image-reveal"
      data-state="idle"
      aria-hidden="true"
    />
  );
}

import type { TeamEnergyTone } from "./workspace-team-state";

type Point = { x: number; y: number };
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => {
  v = clamp(v);
  return v * v * (3 - 2 * v);
};
const random = (n: number) => {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};
const textures = new Map<TeamEnergyTone, HTMLImageElement>();
function textureFor(tone: TeamEnergyTone) {
  let image = textures.get(tone);
  if (!image) {
    image = new Image();
    image.src = `/team-orbit/energy-${tone}.webp`;
    textures.set(tone, image);
  }
  return image;
}

/** Visual time only; it never changes or estimates the server's task progress. */
export function paintTeamEnergy({
  canvas,
  layer,
  tone,
  active,
  collecting,
  elapsed,
  onCollected,
}: {
  canvas: HTMLCanvasElement;
  layer: HTMLElement;
  tone: TeamEnergyTone;
  active: boolean;
  collecting: boolean;
  elapsed: { current: number };
  onCollected: () => void;
}) {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    if (collecting) onCollected();
    return () => {};
  }
  const context = ctx;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const image = collecting ? textureFor(tone) : null;
  const color = tone === "rose" ? [244, 147, 218] : [140, 217, 246];
  let width = 0,
    height = 0,
    dpr = 1,
    frame = 0,
    previous = 0,
    lastPaint = 0,
    visible = true,
    disposed = false,
    complete = false;
  const members = [...layer.querySelectorAll<HTMLElement>(".team-orbit-node")];
  const sources = members.filter((node) =>
    collecting
      ? node.dataset.source === "true"
      : node.dataset.active === "true",
  );
  const core =
    layer.parentElement?.querySelector<HTMLElement>(".workspace-ai-core");
  const ink = (a: number) => `rgba(${color.join(",")},${clamp(a)})`;
  const center = (): Point => ({
    x: core?.offsetLeft ?? width / 2,
    y: core?.offsetTop ?? height / 2,
  });
  const glow = (point: Point, radius: number, alpha: number) => {
    const g = context.createRadialGradient(
      point.x,
      point.y,
      0,
      point.x,
      point.y,
      radius,
    );
    g.addColorStop(0, ink(alpha));
    g.addColorStop(0.22, ink(alpha * 0.4));
    g.addColorStop(0.6, ink(alpha * 0.08));
    g.addColorStop(1, ink(0));
    context.fillStyle = g;
    context.fillRect(
      point.x - radius,
      point.y - radius,
      radius * 2,
      radius * 2,
    );
  };
  const path = (source: Point, target: Point, p: number): Point => {
    const dx = source.x - target.x,
      dy = source.y - target.y,
      bend = Math.sin(p * Math.PI) * 0.25;
    return {
      x: target.x + dx * (1 - p) - dy * bend,
      y: target.y + dy * (1 - p) + dx * bend,
    };
  };
  function draw(now: number) {
    const target = center(),
      small = width < 540;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    if (motion.matches) return;
    const time = collecting ? elapsed.current : now / 1000;
    if (collecting) canvas.dataset.energyTime = time.toFixed(2);
    if (collecting) {
      const envelope = smooth(time / 1.2) * (1 - smooth((time - 3.9) / 1.4));
      context.save();
      context.globalCompositeOperation = "lighter";
      glow(target, small ? 150 : 240, envelope * 0.18);
      context.restore();
    }
    sources.forEach((node, i) => {
      const disc = node.querySelector<HTMLElement>(".team-orbit-disc");
      const source = {
        x: node.offsetLeft,
        y:
          node.offsetTop -
          node.offsetHeight / 2 +
          (disc?.offsetTop || 0) +
          (disc?.offsetHeight || 60) / 2,
      };
      if (!collecting) {
        const p = (time / 4 + i * 0.3) % 1;
        context.beginPath();
        for (let j = 0; j <= 30; j++) {
          const point = path(source, target, j / 30);
          if (!j) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        }
        context.strokeStyle = ink(0.09);
        context.lineWidth = 0.7;
        context.stroke();
        for (let j = 0; j < 6; j++) {
          const point = path(source, target, clamp(p - j * 0.014));
          context.fillStyle = ink((1 - j / 6) * 0.36 * Math.sin(p * Math.PI));
          context.beginPath();
          context.arc(point.x, point.y, j ? 0.6 : 1.2, 0, Math.PI * 2);
          context.fill();
        }
        return;
      }
      const p = (time - i * 0.13) / 3.05;
      if (p <= 0 || p >= 1) return;
      const q = smooth(p),
        point = path(source, target, q),
        before = path(source, target, Math.max(0, q - 0.008));
      const angle =
        Math.atan2(point.y - before.y, point.x - before.x) + Math.PI;
      const alpha = Math.pow(Math.sin(p * Math.PI), 0.75),
        scale = (small ? 0.25 : 0.46) * (0.48 + 0.53 * Math.sin(p * Math.PI));
      context.save();
      context.globalCompositeOperation = "lighter";
      context.globalAlpha = alpha;
      glow(point, small ? 34 : 51, 0.23);
      if (image?.complete && image.naturalWidth) {
        const cell = (Math.floor(time * 18) + i * 3) % 16;
        context.save();
        context.translate(point.x, point.y);
        context.rotate(angle);
        context.scale(scale, scale);
        context.drawImage(
          image,
          (cell % 4) * 512,
          Math.floor(cell / 4) * 224,
          512,
          224,
          -74,
          -108,
          512,
          224,
        );
        context.restore();
      } else {
        // Loading/unsupported image decoding still has a soft, inexpensive fallback.
        glow(point, 14, 0.8);
        for (let k = 0; k < 18; k++) {
          const a = random(i * 23 + k) * Math.PI * 2,
            len = 3 + random(k + 18) * 12;
          context.strokeStyle = k % 3 ? ink(0.6) : "rgba(255,248,255,.9)";
          context.lineWidth = 0.7;
          context.beginPath();
          context.moveTo(point.x, point.y);
          context.lineTo(
            point.x + Math.cos(a) * len,
            point.y + Math.sin(a) * len,
          );
          context.stroke();
        }
      }
      for (let k = 0; k < 13; k++) {
        const point2 = path(
            source,
            target,
            clamp(q - random(i * 23 + k) * 0.15),
          ),
          spread = (1 - p) * 8;
        const x = point2.x + (random(k + i) - 0.5) * spread,
          y = point2.y + (random(k + 19) - 0.5) * spread;
        context.strokeStyle = ink(0.2 + random(k + 31) * 0.5);
        context.lineWidth = 0.6;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + Math.cos(angle) * 3, y + Math.sin(angle) * 3);
        context.stroke();
      }
      context.restore();
    });
    if (collecting) {
      const seal =
        smooth((time - 2.9) / 0.7) * (1 - smooth((time - 3.9) / 1.4));
      if (seal > 0) {
        context.save();
        context.globalCompositeOperation = "lighter";
        glow(target, small ? 100 : 174, seal * 0.22);
        const r =
          (small ? 73 : 123) +
          smooth((time - 3.55) / 1.65) * (small ? 55 : 100);
        context.beginPath();
        context.ellipse(target.x, target.y, r, r * 0.72, -0.3, 0, Math.PI * 2);
        context.strokeStyle = ink(seal * 0.4);
        context.lineWidth = 0.8;
        context.stroke();
        for (let i = 0; i < 32; i++) {
          const p = clamp((time - 2.8 - random(i) * 0.7) / 1.4);
          if (!p || p === 1) continue;
          const a = random(i + 71) * Math.PI * 2,
            radius = (1 - smooth(p)) * (small ? 95 : 165);
          context.fillStyle = ink(Math.sin(p * Math.PI) * 0.65);
          context.fillRect(
            target.x + Math.cos(a) * radius,
            target.y + Math.sin(a) * radius,
            i % 5 ? 0.8 : 1.5,
            i % 5 ? 0.8 : 1.5,
          );
        }
        context.restore();
      }
    }
  }
  const finish = () => {
    if (!complete && !disposed) {
      complete = true;
      onCollected();
    }
  };
  const tick = (now: number) => {
    frame = 0;
    if (disposed || !visible || document.hidden) {
      previous = 0;
      return;
    }
    if (motion.matches) {
      draw(now);
      if (collecting) finish();
      return;
    }
    if (collecting && previous)
      elapsed.current += Math.max(0, (now - previous) / 1000);
    previous = now;
    if (now - lastPaint >= 1000 / 30) {
      lastPaint = now;
      draw(now);
    }
    if (collecting && elapsed.current >= 5.4) {
      context.clearRect(0, 0, width, height);
      finish();
      return;
    }
    if (collecting || (active && sources.length))
      frame = requestAnimationFrame(tick);
  };
  const schedule = () => {
    if (!frame && !disposed && !complete) frame = requestAnimationFrame(tick);
  };
  const resize = new ResizeObserver(() => {
    width = layer.clientWidth;
    height = layer.clientHeight;
    dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.ceil(width * dpr);
    canvas.height = Math.ceil(height * dpr);
    draw(performance.now());
    schedule();
  });
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    previous = 0;
    if (visible) schedule();
    else {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  });
  const visibility = () => {
    previous = 0;
    schedule();
  };
  resize.observe(layer);
  intersection.observe(layer);
  motion.addEventListener("change", visibility);
  document.addEventListener("visibilitychange", visibility);
  image?.addEventListener("load", schedule);
  image?.addEventListener("error", schedule);
  schedule();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    resize.disconnect();
    intersection.disconnect();
    motion.removeEventListener("change", visibility);
    document.removeEventListener("visibilitychange", visibility);
    image?.removeEventListener("load", schedule);
    image?.removeEventListener("error", schedule);
  };
}

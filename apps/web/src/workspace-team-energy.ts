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
  const color = tone === "rose" ? [255, 128, 211] : [140, 217, 246];
  const white = tone === "rose" ? [255, 243, 253] : [233, 252, 255];
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
  const ink = (a: number, hot = false) =>
    `rgba(${(hot ? white : color).join(",")},${clamp(a)})`;
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
  const path = (source: Point, target: Point, p: number, seed = 0): Point => {
    const dx = source.x - target.x,
      dy = (source.y - target.y) / 0.88,
      angle =
        Math.atan2(dy, dx) + p * 1.75 + Math.sin(p * Math.PI) * seed * 0.1,
      radius = Math.hypot(dx, dy) * Math.pow(1 - clamp(p), 1.06);
    return {
      x: target.x + Math.cos(angle) * radius,
      y: target.y + Math.sin(angle) * radius * 0.88,
    };
  };
  const dot = (point: Point, radius: number, alpha: number) => {
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fillStyle = ink(alpha, true);
    context.fill();
  };
  // Fine, curved filaments and small needle sparks follow the selected reference.
  // Everything is drawn at the display resolution; no smoke or video texture.
  const sparkCluster = (
    source: Point,
    target: Point,
    i: number,
    time: number,
    small: boolean,
  ) => {
    const p = (time - i * 0.095) / 3.35;
    if (p <= 0 || p >= 1) return;
    const head = path(source, target, p),
      prev = path(source, target, clamp(p - 0.012)),
      angle = Math.atan2(head.y - prev.y, head.x - prev.x),
      life = smooth(p / 0.09) * (1 - smooth((p - 0.85) / 0.15));
    context.save();
    context.translate(head.x, head.y);
    context.rotate(angle);
    if (small) context.scale(0.75, 0.75);
    const glint = context.createRadialGradient(0, 0, 0, 0, 0, 22);
    glint.addColorStop(0, ink(life * 0.65, true));
    glint.addColorStop(0.12, ink(life * 0.52, true));
    glint.addColorStop(0.38, ink(life * 0.27));
    glint.addColorStop(1, ink(0));
    context.fillStyle = glint;
    context.fillRect(-22, -22, 44, 44);
    for (let k = 0; k < (small ? 16 : 23); k++) {
      const s = Math.sin((k + 1) * 12.17 + i * 6.91),
        v = Math.cos((k + 1) * 7.61 + i * 9.21),
        age = (time * (0.58 + (s + 1) * 0.17) + k * 0.167) % 1,
        spread = (1 - age) * (6 + Math.abs(v) * 15),
        x = -age * (13 + Math.abs(s) * 38),
        y = v * spread + Math.sin(age * 6 + i) * 2,
        endX = x + (1 - age) * (3 + Math.abs(v) * 12),
        endY = y + s * (1 - age) * (4 + Math.abs(s) * 10);
      const tint = context.createLinearGradient(x - 8, y, endX, endY);
      tint.addColorStop(0, ink(life * 0.025));
      tint.addColorStop(0.45, ink(life * 0.35));
      tint.addColorStop(1, ink((0.4 + 0.45 * (1 - age)) * life, true));
      context.beginPath();
      context.moveTo(x - 7, y - s * 3);
      context.quadraticCurveTo(x, y, endX, endY);
      context.strokeStyle = tint;
      context.lineWidth = 0.55 + (1 - age) * 0.55;
      context.stroke();
      if (k % 6 === 0) dot({ x: endX, y: endY }, 0.85, life * 0.8);
    }
    context.restore();
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
      glow(target, small ? 130 : 200, envelope * 0.1);
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
      context.save();
      context.globalCompositeOperation = "lighter";
      const envelope = smooth(time / 0.5) * (1 - smooth((time - 3.25) / 0.7));
      // A few translucent threads form a ribbon, with clear space between them.
      for (let strand = 0; strand < 3; strand++) {
        context.beginPath();
        for (let k = 0; k <= 48; k++) {
          const point = path(source, target, k / 48, (strand - 1) * 1.4);
          if (!k) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        }
        context.strokeStyle = ink(envelope * (strand === 1 ? 0.11 : 0.045));
        context.lineWidth = strand === 1 ? 0.75 : 0.55;
        context.stroke();
      }
      const count = small ? 14 : 20;
      for (let k = 0; k < count; k++) {
        const seed = Math.sin((i + 1) * 17.9 + (k + 1) * 3.72),
          delay = (k / count) * 1.15 + i * 0.045,
          travel = 3.7 * (0.56 + (seed + 1) * 0.05),
          p = (time - delay) / travel;
        if (p <= 0 || p >= 1) continue;
        const alpha = smooth(p / 0.08) * (1 - smooth((p - 0.88) / 0.12)) * 0.82,
          tail = 0.055 + Math.abs(seed) * 0.024;
        for (let segment = 0; segment < 5; segment++) {
          const s = segment / 5,
            a = path(source, target, clamp(p - tail * (1 - s)), seed),
            b = path(
              source,
              target,
              clamp(p - tail * (1 - (segment + 1) / 5)),
              seed,
            );
          context.beginPath();
          context.moveTo(a.x, a.y);
          context.lineTo(b.x, b.y);
          context.strokeStyle = ink(alpha * (0.1 + 0.52 * s), segment > 3);
          context.lineWidth = 0.7 + (seed + 1) * 0.22;
          context.stroke();
        }
        dot(path(source, target, p, seed), 0.75 + (seed + 1) * 0.26, alpha);
      }
      sparkCluster(source, target, i, time, small);
      context.restore();
    });
    if (collecting) {
      const seal =
        smooth((time - 2.9) / 0.7) * (1 - smooth((time - 3.9) / 1.4));
      if (seal > 0) {
        context.save();
        context.globalCompositeOperation = "lighter";
        glow(target, small ? 100 : 174, seal * 0.13);
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
  schedule();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    resize.disconnect();
    intersection.disconnect();
    motion.removeEventListener("change", visibility);
    document.removeEventListener("visibilitychange", visibility);
  };
}

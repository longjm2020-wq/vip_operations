import { useEffect, useRef } from "react";
import "./workspace-world.css";

type WorldView = {
  pitch: number;
  yaw: number;
  x: number;
  y: number;
  zoom: number;
};
type Point = { x: number; y: number; z: number };
type DriftParticle = {
  x: number;
  y: number;
  size: number;
  phase: number;
  speed: number;
  dx: number;
  dy: number;
};
const initialView: WorldView = { pitch: 0, yaw: 0, x: 0, y: 0, zoom: 1 };
const perspective = 1000;

// Stable world coordinates make stars return to the same place when the view is reset.
function noise(x: number, y: number, z: number, salt = 0) {
  let seed =
    Math.imul(x | 0, 374761393) ^
    Math.imul(y | 0, 668265263) ^
    Math.imul(z | 0, 2147483647) ^
    salt;
  seed = Math.imul(seed ^ (seed >>> 13), 1274126177);
  return ((seed ^ (seed >>> 16)) >>> 0) / 4294967295;
}

/** Static world geometry is cached; only a small low-resolution particle layer animates. */
export function WorkspaceWorldBackdrop() {
  const canvas = useRef<HTMLCanvasElement>(null),
    particlesCanvas = useRef<HTMLCanvasElement>(null),
    atmosphere = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = canvas.current,
      root = element?.closest<HTMLElement>(".personal-workspace");
    if (!element || !root) return;
    const context = element.getContext("2d");
    if (!context) return;
    const particleElement = particlesCanvas.current,
      particleContext = particleElement?.getContext("2d"),
      reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let view = { ...initialView },
      width = 0,
      height = 0,
      dpr = 1,
      centerX = 0,
      centerY = 0,
      frame = 0,
      visible = true,
      accent = "#667bfa",
      secondary = "#a3afcc",
      light = false,
      particleRatio = 1,
      particleFrame = 0,
      particleTimer = 0,
      particleTime = 0,
      particlePrevious = 0,
      particleCount = 0,
      disposed = false;
    let particles: DriftParticle[] = [];

    const drawParticles = () => {
      if (!particleContext || !particleElement || !width || !height) return;
      particleContext.setTransform(particleRatio, 0, 0, particleRatio, 0, 0);
      particleContext.clearRect(0, 0, width, height);
      particleContext.fillStyle = accent;
      particleContext.strokeStyle = accent;
      particleContext.lineWidth = 0.7;
      for (const particle of particles) {
        const progress = (particleTime * particle.speed + particle.phase) % 1,
          fade = Math.sin(progress * Math.PI) ** 2,
          x = particle.x + (progress - 0.5) * particle.dx,
          y = particle.y + (progress - 0.5) * particle.dy;
        particleContext.globalAlpha = fade * (light ? 0.26 : 0.38);
        particleContext.beginPath();
        particleContext.arc(x, y, particle.size, 0, Math.PI * 2);
        particleContext.fill();
        if (particle.size > 0.9) {
          particleContext.globalAlpha *= 0.4;
          particleContext.beginPath();
          particleContext.moveTo(
            x - particle.dx * 0.075,
            y - particle.dy * 0.075,
          );
          particleContext.lineTo(x, y);
          particleContext.stroke();
        }
      }
      particleContext.globalAlpha = 1;
      particleElement.dataset.motionFrame = String(++particleCount);
      particleElement.dataset.particleCount = String(particles.length);
    };
    const canAnimate = () =>
      !disposed && !document.hidden && visible && !reduced.matches;
    const cancelParticles = () => {
      cancelAnimationFrame(particleFrame);
      clearTimeout(particleTimer);
      particleFrame = 0;
      particleTimer = 0;
      particlePrevious = 0;
    };
    const animateParticles = (now: number) => {
      particleFrame = 0;
      if (!canAnimate()) return;
      if (particlePrevious)
        particleTime += Math.min(0.12, (now - particlePrevious) / 1000);
      particlePrevious = now;
      drawParticles();
      // Wait before requesting the next paint: at most 20fps, without a 60fps polling loop.
      particleTimer = window.setTimeout(() => {
        particleTimer = 0;
        if (canAnimate())
          particleFrame = requestAnimationFrame(animateParticles);
      }, 50);
    };
    const syncAnimation = () => {
      const animated = canAnimate();
      atmosphere.current?.setAttribute("data-animated", String(animated));
      if (!animated) {
        cancelParticles();
        if (!document.hidden && visible) drawParticles();
      } else if (!particleFrame && !particleTimer && particleContext)
        particleFrame = requestAnimationFrame(animateParticles);
    };

    const draw = () => {
      frame = 0;
      if (document.hidden || !visible || !width || !height) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      const pitch = ((view.pitch % 360) * Math.PI) / 180,
        yaw = ((view.yaw % 360) * Math.PI) / 180,
        cp = Math.cos(pitch),
        sp = Math.sin(pitch),
        cy = Math.cos(yaw),
        sy = Math.sin(yaw);
      const rotate = (p: Point): Point => {
        const x = p.x * cy + p.z * sy,
          z = -p.x * sy + p.z * cy;
        return { x, y: p.y * cp - z * sp, z: p.y * sp + z * cp };
      };
      const inverse = (p: Point): Point => {
        const y = p.y * cp + p.z * sp,
          z = -p.y * sp + p.z * cp;
        return { x: p.x * cy - z * sy, y, z: p.x * sy + z * cy };
      };
      const camera = inverse({
        x: -view.x / view.zoom,
        y: -view.y / view.zoom,
        z: 0,
      });
      const project = (p: Point) => {
        const r = rotate(p),
          depth = perspective - r.z * view.zoom;
        if (depth < 100) return null;
        const scale = perspective / depth;
        return {
          x: centerX + (r.x * view.zoom + view.x) * scale,
          y: centerY + (r.y * view.zoom + view.y) * scale,
          scale,
        };
      };
      const line = (a: Point, b: Point) => {
        const from = project(a),
          to = project(b);
        if (!from || !to) return;
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
      };

      // Neighbouring lattice planes extend indefinitely; edge-on planes fade naturally.
      const spacing = 110,
        extent = spacing * 24,
        origin = {
          x: Math.round(camera.x / spacing) * spacing,
          y: Math.round(camera.y / spacing) * spacing,
          z: Math.round(camera.z / spacing) * spacing,
        };
      context.strokeStyle = accent;
      context.lineWidth = 0.65;
      for (const axis of ["x", "y", "z"] as const) {
        const normal = rotate({
          x: axis === "x" ? 1 : 0,
          y: axis === "y" ? 1 : 0,
          z: axis === "z" ? 1 : 0,
        });
        const alpha = Math.abs(normal.z) ** 3 * (light ? 0.1 : 0.085);
        if (alpha < 0.008) continue;
        const [u, v] =
          axis === "x"
            ? (["y", "z"] as const)
            : axis === "y"
              ? (["x", "z"] as const)
              : (["x", "y"] as const);
        const plane = {
          ...origin,
          [axis]: origin[axis] - Math.sign(normal.z || 1) * spacing * 3,
        };
        context.globalAlpha = alpha;
        context.beginPath();
        for (let index = -24; index <= 24; index++) {
          const offset = index * spacing;
          line(
            { ...plane, [u]: origin[u] + offset, [v]: origin[v] - extent },
            { ...plane, [u]: origin[u] + offset, [v]: origin[v] + extent },
          );
          line(
            { ...plane, [u]: origin[u] - extent, [v]: origin[v] + offset },
            { ...plane, [u]: origin[u] + extent, [v]: origin[v] + offset },
          );
        }
        context.stroke();
      }

      const cell = 260,
        grid = {
          x: Math.floor(camera.x / cell),
          y: Math.floor(camera.y / cell),
          z: Math.floor(camera.z / cell),
        };
      context.fillStyle = secondary;
      const nextParticles: DriftParticle[] = [];
      let particleCandidates = 0;
      for (let x = grid.x - 6; x <= grid.x + 6; x++) {
        for (let y = grid.y - 5; y <= grid.y + 5; y++) {
          for (let z = grid.z - 5; z <= grid.z + 4; z++) {
            const seed = noise(x, y, z);
            if (seed < 0.33) continue;
            const point = project({
              x: (x + noise(x, y, z, 731)) * cell,
              y: (y + noise(x, y, z, 1193)) * cell,
              z: (z + noise(x, y, z, 2017)) * cell,
            });
            if (
              !point ||
              point.x < -3 ||
              point.x > width + 3 ||
              point.y < -3 ||
              point.y > height + 3
            )
              continue;
            const size = Math.min(
              1.8,
              Math.max(0.45, point.scale * (0.45 + seed * 0.45)),
            );
            context.globalAlpha =
              (light ? 0.18 : 0.24) * Math.min(1.7, point.scale) * seed;
            context.beginPath();
            context.arc(point.x, point.y, size, 0, Math.PI * 2);
            context.fill();
            if (seed > 0.64) {
              const direction = noise(x, y, z, 3529) * Math.PI * 2;
              const particle: DriftParticle = {
                x: point.x,
                y: point.y,
                size: Math.max(0.55, Math.min(1.3, size)),
                phase: noise(x, y, z, 4283),
                speed: 0.025 + seed * 0.02,
                dx: Math.cos(direction) * (55 + seed * 45),
                dy: Math.sin(direction) * (25 + seed * 35),
              };
              // Bounded deterministic sampling distributes motion across the entire view.
              particleCandidates++;
              if (nextParticles.length < 72) nextParticles.push(particle);
              else {
                const index = Math.floor(
                  noise(x, y, z, 5561) * particleCandidates,
                );
                if (index < 72) nextParticles[index] = particle;
              }
            }
          }
        }
      }
      context.globalAlpha = 1;
      particles = nextParticles;
      if (reduced.matches) drawParticles();
    };
    const schedule = () => {
      if (!frame && visible && !document.hidden)
        frame = requestAnimationFrame(draw);
    };
    const measure = () => {
      width = root.clientWidth;
      height = root.clientHeight;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      element.width = Math.max(1, Math.round(width * dpr));
      element.height = Math.max(1, Math.round(height * dpr));
      // The animated layer stays below one megapixel, even on high-DPI displays.
      particleRatio = Math.min(
        1,
        Math.sqrt(900_000 / Math.max(1, width * height)),
      );
      if (particleElement) {
        particleElement.width = Math.max(1, Math.round(width * particleRatio));
        particleElement.height = Math.max(
          1,
          Math.round(height * particleRatio),
        );
      }
      const stage = root.querySelector<HTMLElement>(
        ".workspace-ai-core-stage, .workspace-quiet",
      );
      centerX = width / 2;
      centerY = height * 0.45;
      if (stage) {
        centerX = stage.offsetWidth / 2;
        centerY = stage.offsetHeight / 2;
        let parent: HTMLElement | null = stage;
        while (parent && parent !== root) {
          centerX += parent.offsetLeft;
          centerY += parent.offsetTop;
          parent = parent.offsetParent as HTMLElement | null;
        }
      }
      schedule();
      syncAnimation();
    };
    const theme = () => {
      const style = getComputedStyle(root);
      accent = style.getPropertyValue("--app-accent").trim() || "#667bfa";
      secondary = style.getPropertyValue("--app-secondary").trim() || "#a3afcc";
      light = document.documentElement.dataset.theme === "light";
      schedule();
    };
    const update = (event: Event) => {
      const detail = (event as CustomEvent<WorldView>).detail;
      if (!detail || !Object.values(detail).every(Number.isFinite)) return;
      if (
        ![detail.pitch, detail.yaw, detail.x, detail.y, detail.zoom].every(
          Number.isFinite,
        )
      )
        return;
      view = { ...detail, zoom: Math.min(2, Math.max(0.4, detail.zoom)) };
      schedule();
    };
    const resized = new ResizeObserver(measure);
    resized.observe(root);
    let observedStage: Element | null = null;
    const trackStage = () => {
      const stage = root.querySelector(
        ".workspace-ai-core-stage, .workspace-quiet",
      );
      if (stage === observedStage) return;
      if (observedStage) resized.unobserve(observedStage);
      observedStage = stage;
      if (stage) resized.observe(stage);
      measure();
    };
    // The work area arrives after its permission-filtered data, and can switch on permission changes.
    const content = new MutationObserver(trackStage);
    content.observe(root, { childList: true, subtree: true });
    trackStage();
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      syncAnimation();
      if (visible) schedule();
      else if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    });
    intersection.observe(root);
    const themes = new MutationObserver(theme);
    themes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    window.addEventListener("xuti-workspace-view", update);
    window.addEventListener("resize", measure);
    const visibility = () => {
      syncAnimation();
      if (document.hidden && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else schedule();
    };
    document.addEventListener("visibilitychange", visibility);
    reduced.addEventListener("change", syncAnimation);
    theme();
    measure();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      cancelParticles();
      resized.disconnect();
      content.disconnect();
      intersection.disconnect();
      themes.disconnect();
      window.removeEventListener("xuti-workspace-view", update);
      window.removeEventListener("resize", measure);
      document.removeEventListener("visibilitychange", visibility);
      reduced.removeEventListener("change", syncAnimation);
    };
  }, []);
  return (
    <>
      <canvas
        ref={canvas}
        className="workspace-world-backdrop"
        aria-hidden="true"
      />
      <div
        ref={atmosphere}
        className="workspace-world-atmosphere"
        aria-hidden="true"
        data-animated="false"
      >
        <span className="workspace-world-glow" />
        <span className="workspace-world-scan" />
        <canvas ref={particlesCanvas} className="workspace-world-particles" />
      </div>
    </>
  );
}

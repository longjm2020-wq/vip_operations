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

/** A decorative, local canvas: redraw only on view changes, resize, or theme changes. */
export function WorkspaceWorldBackdrop() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current,
      root = element?.closest<HTMLElement>(".personal-workspace");
    if (!element || !root) return;
    const context = element.getContext("2d");
    if (!context) return;
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
      light = false;

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
          }
        }
      }
      context.globalAlpha = 1;
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
    document.addEventListener("visibilitychange", schedule);
    theme();
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      content.disconnect();
      intersection.disconnect();
      themes.disconnect();
      window.removeEventListener("xuti-workspace-view", update);
      window.removeEventListener("resize", measure);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, []);
  return (
    <canvas
      ref={canvas}
      className="workspace-world-backdrop"
      aria-hidden="true"
    />
  );
}

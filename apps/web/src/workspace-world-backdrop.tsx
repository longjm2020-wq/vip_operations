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

// Seeded columns keep the scenery coherent while panning and rotating.
function noise(x: number, y: number, z: number, salt = 0) {
  let seed =
    Math.imul(x | 0, 374761393) ^
    Math.imul(y | 0, 668265263) ^
    Math.imul(z | 0, 2147483647) ^
    salt;
  seed = Math.imul(seed ^ (seed >>> 13), 1274126177);
  return ((seed ^ (seed >>> 16)) >>> 0) / 4294967295;
}

/** Local binary rain, independent of React rendering and business data. */
export function WorkspaceWorldBackdrop() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current,
      root = element?.closest<HTMLElement>(".personal-workspace");
    if (!element || !root) return;
    const context = element.getContext("2d");
    if (!context) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let view = { ...initialView },
      width = 0,
      height = 0,
      dpr = 1,
      centerX = 0,
      centerY = 0,
      frame = 0,
      visible = true,
      elapsed = 0,
      lastTime = 0,
      paintedAt = 0,
      dirty = true,
      light = false;

    const draw = (now: number) => {
      frame = 0;
      if (document.hidden || !visible || !width || !height) return;
      if (!motion.matches) {
        if (lastTime) elapsed += Math.min(80, now - lastTime) / 1000;
        lastTime = now;
      }
      if (!dirty && now - paintedAt < 1000 / 30) {
        schedule();
        return;
      }
      dirty = false;
      paintedAt = now;
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
      // Three neighbouring planes prevent the rain disappearing at side-on views.
      // Their sparse streams extend with the camera instead of creating DOM nodes.
      const columnGap = 68,
        rowGap = 24,
        reach = Math.min(4600, Math.max(width, height) / view.zoom + 600),
        columns = Math.ceil(reach / columnGap),
        rows = Math.ceil(reach / rowGap);
      let glyphs = 0,
        fontSize = 0;
      const ink = light
        ? { tail: "#3979b9", near: "#356fa3", head: "#326595" }
        : { tail: "#659df0", near: "#a9d4ff", head: "#e4f3ff" };
      context.shadowColor = "#90caff";
      context.textAlign = "center";
      context.textBaseline = "middle";
      planes: for (const axis of ["x", "y", "z"] as const) {
        const normal = rotate({
          x: axis === "x" ? 1 : 0,
          y: axis === "y" ? 1 : 0,
          z: axis === "z" ? 1 : 0,
        });
        const planeAlpha = Math.abs(normal.z) ** 3;
        if (planeAlpha < 0.04) continue;
        const [u, v] =
          axis === "x"
            ? (["y", "z"] as const)
            : axis === "y"
              ? (["x", "z"] as const)
              : (["x", "y"] as const);
        const columnOrigin = Math.floor(camera[u] / columnGap),
          rowOrigin = Math.floor(camera[v] / rowGap),
          axisSeed = axis.charCodeAt(0),
          plane = {
            x: 0,
            y: 0,
            z: 0,
            [axis]:
              Math.round(camera[axis] / 110) * 110 -
              Math.sign(normal.z || 1) * 330,
          };
        for (
          let column = columnOrigin - columns;
          column <= columnOrigin + columns;
          column++
        ) {
          const seed = noise(column, axisSeed, 13);
          if (seed < 0.18) continue;
          const travel = elapsed * (0.65 + seed * 1.15),
            fraction = travel % 1,
            head = Math.floor(travel) + Math.floor(seed * 44),
            length = 9 + Math.floor(noise(column, axisSeed, 83) * 12);
          for (let row = rowOrigin - rows; row <= rowOrigin + rows; row++) {
            const tail = (((head - row) % 44) + 44) % 44;
            if (tail >= length) continue;
            const point = project({
              ...plane,
              [u]: (column + noise(column, axisSeed, 29) * 0.4) * columnGap,
              [v]: (row + fraction) * rowGap,
            });
            if (
              !point ||
              point.x < -14 ||
              point.x > width + 14 ||
              point.y < -14 ||
              point.y > height + 14
            )
              continue;
            if (++glyphs > 1800) break planes;
            const distance = Math.hypot(
                (point.x - centerX) / 360,
                (point.y - centerY) / 300,
              ),
              quietCenter = 0.22 + Math.min(1, distance / 1.4) * 0.78,
              edge = Math.min(1, point.y / 100, (height - point.y) / 160),
              fade = (1 - tail / length) ** 1.15;
            context.globalAlpha = Math.max(
              0,
              planeAlpha * quietCenter * edge * fade * (light ? 0.32 : 0.68),
            );
            context.fillStyle =
              tail === 0 ? ink.head : tail < 3 ? ink.near : ink.tail;
            // Only stream tips glow; the long blue trails stay crisp and inexpensive.
            context.shadowBlur = tail === 0 && !light ? 5 : 0;
            const size = Math.round(
              Math.max(10, Math.min(17, 15 * point.scale * view.zoom)),
            );
            if (size !== fontSize) {
              fontSize = size;
              context.font = `${size}px ui-monospace, SFMono-Regular, Consolas, monospace`;
            }
            context.fillText(
              noise(column, row, axisSeed, Math.floor(elapsed * 0.65)) > 0.5
                ? "1"
                : "0",
              point.x,
              point.y,
            );
          }
        }
      }
      context.globalAlpha = 1;
      context.shadowBlur = 0;
      if (!motion.matches) schedule();
    };
    const schedule = () => {
      if (!frame && visible && !document.hidden)
        frame = requestAnimationFrame(draw);
    };
    const invalidate = () => {
      dirty = true;
      schedule();
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
      invalidate();
    };
    const theme = () => {
      light = document.documentElement.dataset.theme === "light";
      invalidate();
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
      invalidate();
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
      lastTime = 0;
      if (visible) invalidate();
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
    const playback = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      lastTime = 0;
      invalidate();
    };
    document.addEventListener("visibilitychange", playback);
    motion.addEventListener("change", playback);
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
      document.removeEventListener("visibilitychange", playback);
      motion.removeEventListener("change", playback);
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

import * as THREE from "three";
import { createNestModel, createRobotModel } from "./workspace-three-models";

type WorldView = {
  pitch: number;
  yaw: number;
  x: number;
  y: number;
  zoom: number;
};
const initialView = (): WorldView => ({
  pitch: 0,
  yaw: 0,
  x: 0,
  y: 0,
  zoom: 1,
});

/** One depth buffer for the sphere and its resident: far arcs pass behind the robot. */
export function mountWorkspaceThree(
  canvas: HTMLCanvasElement,
  mode: "nest" | "robot",
) {
  const stage = canvas.parentElement!;
  const root = stage.closest<HTMLElement>(".personal-workspace");
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
  } catch {
    canvas.dataset.rendererState = "fallback";
    return () => {};
  }
  renderer.setClearColor(0, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 4000);
  camera.position.z = 1000;
  const world = new THREE.Group();
  const robotPose = new THREE.Group();
  const robot = createRobotModel();
  const nest = mode === "nest" ? createNestModel() : null;
  robotPose.add(robot.group);
  world.add(robotPose);
  if (nest) world.add(nest.group);
  scene.add(world);
  const ambient = new THREE.HemisphereLight(0xdde9ff, 0x29305d, 2.1);
  const key = new THREE.DirectionalLight(0xe6eeff, 3.1);
  key.position.set(-180, 240, 300);
  const rim = new THREE.DirectionalLight(0x71dfff, 2.2);
  rim.position.set(150, 60, -180);
  const fill = new THREE.DirectionalLight(0xa0abff, 1.4);
  fill.position.set(0, -100, -300);
  scene.add(ambient, key, rim, fill);

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const view = initialView();
  let frame = 0,
    width = 0,
    height = 0;
  let elapsed = 0,
    robotElapsed = 0,
    previous = 0,
    lastDraw = 0,
    rendered = 0;
  let visible = true,
    lost = false,
    disposed = false,
    motion = "idle",
    motionStart = 0;
  let state = "idle",
    nestState = "idle",
    docked = false,
    theme = "";
  const geometry = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  scene.traverse((object) => {
    const drawable = object as THREE.Mesh;
    if (drawable.geometry) geometry.add(drawable.geometry);
    if (drawable.material)
      for (const m of [drawable.material].flat()) materials.add(m);
  });
  const readView = () => {
    if (!root || mode !== "nest") return;
    for (const property of Object.keys(view) as (keyof WorldView)[]) {
      const value = Number(root.getAttribute(`data-world-${property}`));
      if (Number.isFinite(value)) view[property] = value;
    }
    if (!view.zoom) view.zoom = 1;
  };
  readView();
  const paused = () =>
    mode === "nest" &&
    !!(
      root?.dataset.worldDragging === "true" ||
      stage.matches(":hover, :focus-within") ||
      root?.querySelector(
        ".assistant-compose:focus-within, .workspace-dock[data-paused=true]",
      )
    );
  const status = (next: string) => {
    if (canvas.dataset.rendererState !== next)
      canvas.dataset.rendererState = next;
  };
  const updateState = () => {
    const companion =
      stage.querySelector<HTMLElement>(".workspace-companion") ||
      stage.closest<HTMLElement>(".workspace-companion");
    const assistant =
      companion?.querySelector<HTMLElement>(".sidebar-assistant");
    state = assistant?.dataset.state || "idle";
    if (assistant?.dataset.muted === "true" && state === "listening")
      state = "muted";
    nestState =
      stage.closest<HTMLElement>(".workspace-ai")?.dataset.coreState || state;
    docked = companion?.dataset.docked === "true";
    const nextMotion = companion?.dataset.motion || "idle";
    if (motion !== nextMotion) {
      motion = nextMotion;
      motionStart = performance.now();
    }
    const nextTheme =
      document.documentElement.dataset.theme === "light" ? "light" : "dark";
    if (nextTheme !== theme) {
      theme = nextTheme;
      nest?.setTheme(nextTheme);
      robot.setTheme(nextTheme);
    }
    queue();
  };
  const animate = (time: number) => {
    frame = 0;
    if (disposed || lost || !visible || document.hidden || !width || !height) {
      previous = 0;
      return;
    }
    const moving = !reduced.matches && !paused();
    const robotMoving =
      !reduced.matches &&
      (moving ||
        ["listening", "speaking", "thinking", "working", "connecting"].includes(
          state,
        ));
    const transition =
      mode === "nest" &&
      !reduced.matches &&
      ["arriving", "departing", "jumping"].includes(motion) &&
      time - motionStart < 540;
    const continuous = moving || robotMoving || transition;
    canvas.dataset.renderAnimated = String(continuous);
    if (continuous && time - lastDraw < 1000 / 30) {
      frame = requestAnimationFrame(animate);
      return;
    }
    if (previous) {
      const delta = Math.min((time - previous) / 1000, 0.1);
      if (moving) elapsed += delta;
      if (robotMoving) robotElapsed += delta;
    }
    previous = time;
    lastDraw = time;
    const core = stage.querySelector<HTMLElement>(".workspace-ai-core");
    const scale =
      mode === "nest"
        ? (core?.offsetWidth || 286) / 286
        : Math.min(width / 160, height / 170);
    // CSS uses downward Y. Reflection across Y negates X rotation, not Y rotation.
    world.rotation.set(
      -THREE.MathUtils.degToRad(view.pitch),
      THREE.MathUtils.degToRad(view.yaw),
      0,
      "XYZ",
    );
    world.position.set(view.x, -view.y, 0);
    world.scale.setScalar(scale * view.zoom);
    nest?.update(elapsed, nestState, reduced.matches);
    robot.update(robotElapsed, state, reduced.matches);
    robotPose.visible = mode === "robot" || docked;
    robotPose.position.set(0, 0, 0);
    robotPose.scale.setScalar(1);
    if (mode === "nest" && !reduced.matches) {
      if (motion === "peek") {
        robotPose.position.set(0, 20, -42);
        robotPose.scale.setScalar(0.83);
      } else if (motion === "arriving")
        robotPose.scale.setScalar(
          Math.min(1, Math.max(0.01, (time - motionStart) / 420)),
        );
      else if (motion === "departing")
        robotPose.scale.setScalar(
          Math.max(0.01, 1 - (time - motionStart) / 420),
        );
      else if (motion === "jumping") {
        const progress = Math.min(1, (time - motionStart) / 520);
        robotPose.position.y = Math.sin(progress * Math.PI) * 46;
        robotPose.scale.setScalar(1 - progress * 0.85);
      }
    }
    try {
      renderer.render(scene, camera);
      if (renderer.getContext().isContextLost()) return;
      status("ready");
      canvas.dataset.robotQuaternion = world.quaternion
        .toArray()
        .map((v) => v.toFixed(6))
        .join(",");
      canvas.dataset.robotVisible = String(robotPose.visible);
      canvas.dataset.renderFrame = String(++rendered);
    } catch {
      lost = true;
      status("fallback");
      return;
    }
    if (continuous) frame = requestAnimationFrame(animate);
    else previous = 0;
  };
  function queue() {
    if (!disposed && !lost && !frame && visible && !document.hidden)
      frame = requestAnimationFrame(animate);
  }
  const resize = () => {
    width = stage.clientWidth;
    height = stage.clientHeight;
    if (!width || !height) return;
    renderer.setPixelRatio(
      Math.min(devicePixelRatio || 1, mode === "nest" ? 1.75 : 2),
    );
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(height / 2000));
    camera.updateProjectionMatrix();
    canvas.dataset.renderWidth = String(width);
    canvas.dataset.renderHeight = String(height);
    queue();
  };
  const onView = () => {
    readView();
    queue();
  };
  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
      previous = 0;
    } else queue();
  };
  const onLost = (event: Event) => {
    event.preventDefault();
    lost = true;
    cancelAnimationFrame(frame);
    frame = 0;
    status("fallback");
  };
  const onRestored = () => {
    lost = false;
    previous = 0;
    resize();
    updateState();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) queue();
    else {
      cancelAnimationFrame(frame);
      frame = 0;
      previous = 0;
    }
  });
  intersection.observe(canvas);
  const observer = new MutationObserver(updateState);
  observer.observe(
    mode === "nest"
      ? stage.closest(".workspace-ai") || stage
      : stage.closest(".workspace-companion") || stage,
    {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "data-state",
        "data-muted",
        "data-core-state",
        "data-paused",
        "data-docked",
        "data-motion",
        "data-nest-state",
      ],
    },
  );
  const themeObserver = new MutationObserver(updateState);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  const dragObserver = new MutationObserver(queue);
  if (root && mode === "nest")
    dragObserver.observe(root, {
      attributes: true,
      attributeFilter: ["data-world-dragging"],
    });
  for (const event of ["pointerenter", "pointerleave"])
    stage.addEventListener(event, queue);
  const focusRoot = root || stage;
  for (const event of ["focusin", "focusout"])
    focusRoot.addEventListener(event, queue);
  window.addEventListener("xuti-workspace-view", onView);
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibility);
  reduced.addEventListener("change", updateState);
  resize();
  updateState();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    intersection.disconnect();
    observer.disconnect();
    themeObserver.disconnect();
    dragObserver.disconnect();
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    for (const event of ["pointerenter", "pointerleave"])
      stage.removeEventListener(event, queue);
    for (const event of ["focusin", "focusout"])
      focusRoot.removeEventListener(event, queue);
    window.removeEventListener("xuti-workspace-view", onView);
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onVisibility);
    reduced.removeEventListener("change", updateState);
    for (const resource of geometry) resource.dispose();
    for (const material of materials) material.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    status("fallback");
  };
}

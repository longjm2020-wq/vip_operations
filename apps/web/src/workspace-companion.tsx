import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { App } from "antd";
import { SidebarAssistant } from "./sidebar-assistant";
import { useAssistantHub } from "./assistant-hub-context";
import { useUser } from "./shared";
import {
  findClimbTarget,
  climbRestPosition,
  type ClimbTarget,
} from "./companion-climbing";
import { beginCompanionReverie, findReverieSpace } from "./companion-reverie";

type Position = { x: number; y: number };
function overlayControlAreas() {
  return [
    ...document.querySelectorAll<HTMLElement>(
      "button, a, input, textarea, select, [contenteditable=true], [role=button], [role=slider]",
    ),
  ]
    .filter(
      (node) =>
        !node.closest(".workspace-companion-host") &&
        node.closest(
          ".ant-drawer-open, .ant-modal-wrap, .personal-workspace-panel:not([hidden]):not([inert])",
        ) &&
        getComputedStyle(node).visibility !== "hidden",
    )
    .map((node) => node.getBoundingClientRect())
    .filter(
      (r) =>
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.top < innerHeight &&
        r.right > 0 &&
        r.left < innerWidth,
    );
}
// Use visible text/control bounds, not whole cards, so every part of the page can be visited.
function occupiedAreas() {
  const root = document.querySelector(".workspace");
  if (!root) return [];
  const visible = (r: DOMRect) =>
    r.width > 0 &&
    r.height > 0 &&
    r.bottom > 0 &&
    r.top < innerHeight &&
    r.right > 0 &&
    r.left < innerWidth;
  const areas: DOMRect[] = [];
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (node instanceof Element) {
          if (
            node.matches(
              "[hidden], [inert], [aria-hidden=true], script, style",
            ) &&
            !node.matches(".workspace-ai-core")
          )
            return NodeFilter.FILTER_REJECT;
          const rect = node.getBoundingClientRect();
          if (rect.width && rect.height && !visible(rect))
            return NodeFilter.FILTER_REJECT;
          if (
            node.matches(
              "button, a, input, textarea, select, [contenteditable=true], [role=button], table, [role=grid], canvas, .workspace-hologram, .workspace-ai-core, .workspace-dock, .brand",
            )
          ) {
            if (visible(rect)) areas.push(rect);
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_SKIP;
        }
        return node.textContent?.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    },
  );
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const range = document.createRange();
    range.selectNodeContents(node);
    areas.push(...[...range.getClientRects()].filter(visible));
  }
  // Drawers and dialogs are body portals, outside the business-page subtree.
  // The foreground companion must also leave their controls usable.
  for (const control of document.querySelectorAll<HTMLElement>(
    "button, a, input, textarea, select, [contenteditable=true], [role=button], [role=slider]",
  )) {
    if (root.contains(control) || control.closest(".workspace-companion-host"))
      continue;
    const rect = control.getBoundingClientRect();
    if (visible(rect) && getComputedStyle(control).visibility !== "hidden")
      areas.push(rect);
  }
  return areas;
}
function isClear(p: Position, width: number, height: number, areas: DOMRect[]) {
  return !areas.some(
    (r) =>
      p.x < r.right + 6 &&
      p.x + width > r.left - 6 &&
      p.y < r.bottom + 6 &&
      p.y + height > r.top - 6,
  );
}

function findSpace(
  width: number,
  height: number,
  areas: DOMRect[],
  preferred?: Position,
) {
  const maxX = document.documentElement.clientWidth - width - 8,
    maxY = innerHeight - height - 8;
  if (
    preferred &&
    preferred.x >= 8 &&
    preferred.x <= maxX &&
    preferred.y >= 8 &&
    preferred.y <= maxY &&
    isClear(preferred, width, height, areas)
  )
    return preferred;
  const candidates: Position[] = [];
  for (let y = 8; y <= maxY; y += 36)
    for (let x = 8; x <= maxX; x += 36)
      if (isClear({ x, y }, width, height, areas)) candidates.push({ x, y });
  if (preferred)
    candidates.sort(
      (a, b) =>
        Math.hypot(a.x - preferred.x, a.y - preferred.y) -
        Math.hypot(b.x - preferred.x, b.y - preferred.y),
    );
  return preferred
    ? candidates[0]
    : candidates[Math.floor(Math.random() * candidates.length)];
}

type Motion =
  "idle" | "peek" | "departing" | "arriving" | "jumping" | "climbing";
type CompanionView = {
  docked: boolean;
  hasNest: boolean;
  position: Position | null;
  compact: boolean;
  dragging: boolean;
  motion: Motion;
  perched: boolean;
  climbSide?: "left" | "right";
};

export function WorkspaceCompanion() {
  const user = useUser();
  const hub = useAssistantHub();
  const { message } = App.useApp();
  const feedback = useRef(message);
  feedback.current = message;
  const storageKey = `xuti-companion-position:${user.id}`;
  // A permanent body-level host escapes transformed scene/card stacking contexts.
  // The same portal and assistant instance preserve voice, drafts and reminders.
  const [host] = useState(() => {
    const node = document.createElement("div");
    node.className = "workspace-companion-host";
    return node;
  });
  const panel = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const suppressClick = useRef(false);
  const controls = useRef({
    active: () => {},
    command: (_command: "home" | "explore" | "climb") => {},
    interact: () => {},
    start: (_event: PointerEvent<HTMLDivElement>) => {},
    key: (_event: React.KeyboardEvent<HTMLDivElement>) => {},
  });
  const [view, setView] = useState<CompanionView>({
    docked: false,
    hasNest: false,
    position: null,
    compact: false,
    dragging: false,
    motion: "idle",
    perched: false,
  });
  const working = !!(
    hub.voiceVisible ||
    hub.busy ||
    hub.voiceState ||
    hub.feed?.items?.some(
      (item) => item.kind === "task" && item.status === "running",
    )
  );
  useLayoutEffect(() => {
    busy.current = working;
    if (working) controls.current.active();
  }, [working]);

  useLayoutEffect(() => {
    const state: CompanionView = {
      docked: false,
      hasNest: false,
      position: null,
      compact: false,
      dragging: false,
      motion: "idle",
      perched: false,
    };
    let nest: HTMLElement | null = null;
    let lastActive = Date.now();
    let lastTravel = Date.now() - 4000;
    let awayHops = 0;
    let pointer: Position | null = null;
    let transition: {
      automatic: boolean;
      timers: ReturnType<typeof setTimeout>[];
    } | null = null;
    let drag: {
      id: number;
      start: Position;
      origin: Position;
      moved: boolean;
    } | null = null;
    let reflowTimer: ReturnType<typeof setTimeout> | undefined;
    let clickResetTimer: ReturnType<typeof setTimeout> | undefined;
    let dragFrame = 0;
    let anchorFrame = 0;
    let climbFrame = 0;
    let perch: ClimbTarget | null = null;
    let parked: Position | undefined;
    let reverie: ReturnType<typeof beginCompanionReverie> | null = null;
    let nextReverieAt = Date.now() + 45000;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y))
        parked = { x: saved.x * innerWidth, y: saved.y * innerHeight };
    } catch {
      /* Ignore an invalid local position. */
    }

    const publish = () => {
      const core = nest?.closest<HTMLElement>(".workspace-ai-core");
      if (core)
        core.dataset.nestState = state.docked
          ? state.motion === "departing" || state.motion === "jumping"
            ? "departing"
            : state.motion === "arriving"
              ? "arriving"
              : "home"
          : "away";
      setView({ ...state });
    };
    const size = (compact = state.compact) => {
      const width = compact ? 64 : 132;
      const reminder = panel.current?.querySelector<HTMLElement>(
        ".companion-reminder",
      );
      // The reminder moves with the character. Reserve its wrapped height even
      // before the wider docked reminder has been reparented into a floating slot.
      const reminderHeight = reminder
        ? Math.max(
            reminder.getBoundingClientRect().height,
            Math.ceil(
              (Array.from(reminder.textContent || "").length * 11) /
                (width - 6),
            ) *
              17.6 +
              10,
          )
        : 0;
      return { width, height: (compact ? 58 : 118) + reminderHeight };
    };
    const constrain = (point: Position) => {
      const { width, height } = size();
      return {
        x: Math.max(
          8,
          Math.min(point.x, document.documentElement.clientWidth - width - 8),
        ),
        y: Math.max(8, Math.min(point.y, innerHeight - height - 8)),
      };
    };
    const position = (point: Position, commit = true) => {
      state.position = constrain(point);
      if (panel.current)
        panel.current.style.transform = `translate3d(${state.position.x}px, ${state.position.y}px, 0)`;
      if (commit) publish();
    };
    const persist = () => {
      if (!state.position) return;
      parked = { ...state.position };
      try {
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            x: parked.x / innerWidth,
            y: parked.y / innerHeight,
          }),
        );
      } catch {
        /* Placement also works without storage. */
      }
    };
    const alignNest = () => {
      if (!state.docked || !nest || !panel.current) return;
      const r = nest.getBoundingClientRect();
      state.position = { x: r.left, y: r.top };
      panel.current.style.setProperty("--companion-dock-width", `${r.width}px`);
      panel.current.style.setProperty(
        "--companion-dock-height",
        `${r.height}px`,
      );
      const hub = nest.closest<HTMLElement>(
        ".workspace-ai-core-stage, .workspace-quiet",
      );
      if (hub) {
        const styles = getComputedStyle(hub);
        for (const name of [
          "--hub-scale",
          "--orbit-radius",
          "--dock-node-size",
          "--hub-toast-gap",
        ]) {
          const value = styles.getPropertyValue(name).trim();
          if (value) panel.current.style.setProperty(name, value);
        }
      }
      panel.current.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
    };
    const attach = (home: boolean) => {
      state.docked = !!(home && nest);
      if (host.parentElement !== document.body) document.body.appendChild(host);
      if (state.docked) state.compact = false;
      if (panel.current) {
        panel.current.dataset.docked = String(state.docked);
        panel.current.style.transform = `translate3d(${state.position?.x || 0}px, ${state.position?.y || 0}px, 0)`;
      }
      alignNest();
    };
    const stopReverie = () => {
      reverie?.cancel();
      reverie = null;
      panel.current?.removeAttribute("data-reverie");
    };
    const cancelTransition = () => {
      stopReverie();
      cancelAnimationFrame(climbFrame);
      climbFrame = 0;
      transition?.timers.forEach(clearTimeout);
      transition = null;
      if (state.motion !== "idle") {
        state.motion = "idle";
        publish();
      }
    };
    const active = () => {
      stopReverie();
      lastActive = Date.now();
      if (transition?.automatic) cancelTransition();
      if (state.motion === "peek") {
        state.motion = "idle";
        publish();
      }
    };
    const obstacles = () => {
      const result = occupiedAreas();
      if (pointer)
        result.push(new DOMRect(pointer.x - 60, pointer.y - 45, 120, 90));
      return result;
    };
    const destination = (preferred?: Position, random = false) => {
      const areas = random ? obstacles() : occupiedAreas();
      const { width, height } = size();
      if (random) {
        const origin = panel.current?.getBoundingClientRect();
        for (let i = 0; i < 90; i++) {
          const next = constrain({
            x: Math.random() * innerWidth,
            y: Math.random() * innerHeight,
          });
          if (
            (!origin ||
              Math.hypot(next.x - origin.x, next.y - origin.y) > 130) &&
            isClear(next, width, height, areas)
          )
            return next;
        }
        if (!state.compact) {
          const compactSize = size(true);
          const small = findSpace(compactSize.width, compactSize.height, areas);
          if (
            small &&
            (!origin ||
              Math.hypot(small.x - origin.x, small.y - origin.y) > 100)
          ) {
            state.compact = true;
            return small;
          }
        }
        // No distinct safe destination: stay put rather than teleport onto content.
        return undefined;
      }
      const normalSize = size(false),
        compactSize = size(true);
      const regular = findSpace(
        normalSize.width,
        normalSize.height,
        areas,
        preferred,
      );
      const small =
        regular ||
        findSpace(compactSize.width, compactSize.height, areas, preferred);
      state.compact = !regular;
      return small;
    };
    const clearRest = (preferred?: Position) => {
      const next = destination(preferred);
      position(
        next ||
          constrain(preferred || { x: innerWidth - 72, y: innerHeight - 66 }),
      );
    };
    const leavePerch = () => {
      if (perch) targetObserver.unobserve(perch.element);
      perchObserver.disconnect();
      perch = null;
      state.perched = false;
      state.climbSide = undefined;
    };
    const followAnchor = () => {
      anchorFrame = 0;
      if (state.docked) {
        alignNest();
        // Delivery lifts the nest using a short CSS transition. Follow that
        // geometry until it settles, without turning idle anchoring into a loop.
        if (nest?.closest(".workspace-ai-core")?.getAnimations().some(
          (animation) => animation.playState === "running",
        )) anchorFrame = requestAnimationFrame(followAnchor);
      }
      else if (perch && !climbFrame && !drag) {
        const next = climbRestPosition(perch);
        if (next) position(next, false);
        else {
          leavePerch();
          clearRest(state.position || undefined);
        }
      }
    };
    const scheduleAnchor = () => {
      if (!anchorFrame) anchorFrame = requestAnimationFrame(followAnchor);
    };
    const targetObserver = new ResizeObserver(scheduleAnchor);
    const perchObserver = new MutationObserver(scheduleAnchor);
    const climb = (nearOnly = false) => {
      const r = panel.current?.getBoundingClientRect();
      const origin = { x: r?.left || 8, y: r?.top || 8 };
      const target = findClimbTarget(origin, nearOnly);
      if (!target) {
        if (!nearOnly)
          void feedback.current.info(
            "附近暂无合适的攀爬位置，可先打开卡片或移动小序。",
          );
        return false;
      }
      cancelTransition();
      leavePerch();
      state.compact = target.compact;
      attach(false);
      perch = target;
      targetObserver.observe(target.element);
      for (
        let element: HTMLElement | null = target.element;
        element && element !== document.body;
        element = element.parentElement
      )
        perchObserver.observe(element, {
          attributes: true,
          attributeFilter: ["style", "class", "hidden", "aria-hidden"],
        });
      state.climbSide = target.side;
      state.motion = "climbing";
      state.dragging = false;
      lastActive = Date.now();
      const finish = () => {
        climbFrame = 0;
        const next = climbRestPosition(target);
        state.motion = "idle";
        if (next) {
          state.perched = true;
          position(next);
          persist();
        } else {
          leavePerch();
          clearRest();
        }
      };
      publish();
      if (reduced.matches) finish();
      else {
        const started = performance.now();
        const animate = (now: number) => {
          if (!target.element.isConnected || document.hidden) {
            finish();
            return;
          }
          const elapsed = now - started;
          if (elapsed >= 900) {
            finish();
            return;
          }
          if (elapsed < 260) {
            const t = 1 - Math.pow(1 - elapsed / 260, 3);
            position(
              {
                x: origin.x + (target.x - origin.x) * t,
                y: origin.y + (target.fromY - origin.y) * t,
              },
              false,
            );
          } else {
            const t = (elapsed - 260) / 640;
            position(
              { x: target.x, y: target.fromY + (target.y - target.fromY) * t },
              false,
            );
          }
          climbFrame = requestAnimationFrame(animate);
        };
        climbFrame = requestAnimationFrame(animate);
      }
      return true;
    };
    const nestAvailable = () =>
      !!nest &&
      !nest.closest("[hidden], [inert], [aria-hidden=true]") &&
      getComputedStyle(nest).visibility !== "hidden";
    const nestVisible = () => {
      if (!nestAvailable()) return false;
      const box = nest?.getBoundingClientRect();
      if (!box || box.width <= 0 || box.height <= 0) return false;
      const clip = nest
        ?.closest<HTMLElement>(".personal-workspace")
        ?.getBoundingClientRect();
      const left = Math.max(0, clip?.left ?? 0);
      const top = Math.max(0, clip?.top ?? 0);
      const right = Math.min(
        document.documentElement.clientWidth,
        clip?.right ?? document.documentElement.clientWidth,
      );
      const bottom = Math.min(innerHeight, clip?.bottom ?? innerHeight);
      return (
        right > left &&
        bottom > top &&
        box.top >= top - 2 &&
        box.bottom <= bottom + 2 &&
        box.left >= left - 2 &&
        box.right <= right + 2
      );
    };
    const travel = (
      target: "home" | Position,
      automatic = false,
      jump = false,
    ) => {
      if (target === "home" && !nestAvailable()) return;
      cancelTransition();
      leavePerch();
      if (!automatic) active();
      lastTravel = Date.now();
      const finish = () => {
        transition = null;
        state.motion = "idle";
        lastTravel = Date.now();
        publish();
        if (!automatic && !state.docked) persist();
      };
      const arrive = () => {
        if (target === "home") {
          if (!nestAvailable()) {
            finish();
            return;
          }
          attach(true);
          awayHops = 0;
        } else {
          // Re-check after the departure animation in case page content changed.
          const { width, height } = size();
          if (!isClear(target, width, height, obstacles())) {
            finish();
            return;
          }
          attach(false);
          position(target, false);
        }
        state.motion = reduced.matches ? "idle" : "arriving";
        publish();
        if (reduced.matches) finish();
        else transition!.timers.push(setTimeout(finish, 420));
      };
      transition = { automatic, timers: [] };
      if (reduced.matches) {
        arrive();
        return;
      }
      state.motion = jump && state.docked ? "jumping" : "departing";
      publish();
      transition.timers.push(
        setTimeout(arrive, state.motion === "jumping" ? 520 : 420),
      );
    };
    const command = (value: "home" | "explore" | "climb") => {
      active();
      if (value === "climb") {
        climb();
        return;
      }
      if (value === "home" && nest) {
        // An overlay keeps the core mounted but inert. Do not reset or enter
        // that hidden scene; use the same content-aware placement as roaming.
        if (!nestAvailable()) {
          cancelTransition();
          leavePerch();
          attach(false);
          clearRest(state.position || undefined);
          return;
        }
        if (!nestVisible()) {
          window.dispatchEvent(new CustomEvent("xuti-workspace-center"));
          nest.scrollIntoView({ block: "center", behavior: "instant" });
        }
        if (state.docked) {
          cancelTransition();
          return;
        }
        travel("home");
      } else {
        const next = destination(undefined, true);
        if (next) travel(next, false, state.docked);
      }
    };
    const discoverNest = () => {
      const next = document.querySelector<HTMLElement>(
        ".workspace-ai-companion-slot",
      );
      if (next === nest && host.isConnected) return;
      cancelTransition();
      leavePerch();
      nestObserver.disconnect();
      if (nest) targetObserver.unobserve(nest);
      nest = next;
      if (nest) {
        targetObserver.observe(nest);
        for (
          let element: HTMLElement | null = nest;
          element && element !== document.body;
          element = element.parentElement
        )
          nestObserver.observe(element, {
            attributes: true,
            attributeFilter: [
              "hidden",
              "inert",
              "aria-hidden",
              "data-scene-presence",
              "data-team-phase",
            ],
          });
      }
      state.hasNest = !!nest;
      state.dragging = false;
      drag = null;
      active();
      lastTravel = Date.now() - 4000;
      if (nestAvailable()) {
        attach(true);
        publish();
      } else {
        attach(false);
        clearRest(parked);
      }
    };
    const reflow = () => {
      if (reverie) {
        const bounds = reverie.frame.getBoundingClientRect();
        const scene = reverie.frame.closest<HTMLElement>(".personal-workspace");
        if (
          !reverie.frame.isConnected ||
          scene?.dataset.scenePresence !== "closed" ||
          !!document.querySelector(
            ".ant-drawer-open, .ant-modal-wrap:not([style*='display: none']), .workspace-hologram:not([inert])",
          ) ||
          !isClear(
            { x: bounds.x, y: bounds.y },
            bounds.width,
            bounds.height,
            occupiedAreas(),
          )
        )
          stopReverie();
      }
      scheduleAnchor();
      clearTimeout(reflowTimer);
      reflowTimer = setTimeout(() => {
        if (drag || transition || perch || reverie) return;
        if (state.docked) {
          const rect = panel.current?.getBoundingClientRect();
          if (
            !nestAvailable() ||
            (rect &&
              !isClear(
                { x: rect.x, y: rect.y },
                rect.width,
                rect.height,
                overlayControlAreas(),
              ))
          ) {
            // Hidden cores are not resting places. Also leave a visible nest
            // when it blocks controls; closing never teleports the robot back.
            attach(false);
            state.motion = "idle";
            lastActive = Date.now() + 10000;
            clearRest(rect ? { x: rect.x, y: rect.y } : undefined);
          }
          return;
        }
        const { width, height } = size();
        if (
          !state.position ||
          state.position.y + height > innerHeight - 8 ||
          state.position.x + width > document.documentElement.clientWidth - 8 ||
          !isClear(state.position, width, height, occupiedAreas())
        )
          clearRest(state.position || undefined);
      }, 250);
    };
    const release = (event?: globalThis.PointerEvent) => {
      if (!drag || (event && event.pointerId !== drag.id)) return;
      if (drag.moved) {
        if (!climb(true)) {
          clearRest(state.position || undefined);
          persist();
        }
        clearTimeout(clickResetTimer);
        clickResetTimer = setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      }
      drag = null;
      state.dragging = false;
      lastActive = Date.now() + 10000;
      publish();
    };
    const onPointerMove = (event: globalThis.PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (reverie) {
        const bounds = reverie.frame.getBoundingClientRect();
        if (
          pointer.x > bounds.left - 24 &&
          pointer.x < bounds.right + 24 &&
          pointer.y > bounds.top - 24 &&
          pointer.y < bounds.bottom + 24
        )
          active();
      }
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.start.x,
        dy = event.clientY - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      if (!drag.moved) {
        drag.moved = true;
        suppressClick.current = true;
        cancelTransition();
        leavePerch();
        state.dragging = true;
        attach(false);
        publish();
      }
      position({ x: drag.origin.x + dx, y: drag.origin.y + dy }, false);
      if (!dragFrame)
        dragFrame = requestAnimationFrame(() => {
          dragFrame = 0;
          publish();
        });
      event.preventDefault();
    };
    const start = (event: PointerEvent<HTMLDivElement>) => {
      if (
        event.button !== 0 ||
        !event.isPrimary ||
        drag ||
        !(event.target as Element).closest(".companion-launch")
      )
        return;
      cancelTransition();
      active();
      suppressClick.current = false;
      const box = panel.current
        ?.querySelector<HTMLButtonElement>(".companion-launch")
        ?.getBoundingClientRect();
      if (!box?.width || !box.height) return;
      const width = state.compact ? 64 : 132;
      const height = state.compact ? 58 : 118;
      // Keep the grabbed point under the pointer when leaving the transformed
      // nest. Reminder height affects collision bounds, never the grab origin.
      const u = Math.max(
        0,
        Math.min(1, (event.clientX - box.left) / box.width),
      );
      const v = Math.max(
        0,
        Math.min(1, (event.clientY - box.top) / box.height),
      );
      drag = {
        id: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        origin: {
          x: event.clientX - u * width,
          y: event.clientY - v * height,
        },
        moved: false,
      };
    };
    const key = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!(event.target as Element).matches(".companion-launch")) return;
      if (event.key === "Home") {
        event.preventDefault();
        if (nest) command("home");
        else {
          cancelTransition();
          leavePerch();
          active();
          clearRest();
          persist();
        }
        return;
      }
      const direction = {
        ArrowLeft: [-12, 0],
        ArrowRight: [12, 0],
        ArrowUp: [0, -12],
        ArrowDown: [0, 12],
      }[event.key];
      if (!direction) return;
      event.preventDefault();
      cancelTransition();
      leavePerch();
      active();
      const box = panel.current
        ?.querySelector<HTMLButtonElement>(".companion-launch")
        ?.getBoundingClientRect();
      if (!box) return;
      const origin = state.docked
        ? {
            x: box.x + (box.width - 132) / 2,
            y: box.y + (box.height - 118) / 2,
          }
        : state.position!;
      attach(false);
      position({ x: origin.x + direction[0], y: origin.y + direction[1] });
      persist();
    };
    controls.current = {
      active,
      command,
      start,
      key,
      interact: () => {
        if (state.docked) command("explore");
        else active();
      },
    };
    const onCommand = (event: Event) => {
      const value = (event as CustomEvent).detail;
      if (value === "home" || value === "explore" || value === "climb")
        command(value);
    };
    const onResize = () => {
      cancelTransition();
      active();
      if (perch) {
        state.perched = true;
        publish();
      }
      if (state.docked || perch) scheduleAnchor();
      else clearRest(state.position || undefined);
    };
    const onScroll = () => {
      active();
      reflow();
    };
    const onVisibility = () => {
      cancelTransition();
      active();
      release();
      if (perch) {
        state.perched = true;
        followAnchor();
        publish();
      }
    };
    const onReducedMotion = () => {
      cancelTransition();
      active();
      if (perch) {
        state.perched = true;
        followAnchor();
        publish();
      }
    };
    // Workspace cards retain their DOM when closed. Observe only that portal's
    // geometry/visibility so reopening or moving a card also runs avoidance.
    let workspaceCard: HTMLElement | null = null;
    const cardObserver = new MutationObserver(reflow);
    const nestObserver = new MutationObserver(reflow);
    const discoverCard = () => {
      const next = document.querySelector<HTMLElement>(
        ".personal-workspace-panel",
      );
      if (next === workspaceCard) return;
      cardObserver.disconnect();
      workspaceCard = next;
      if (workspaceCard)
        cardObserver.observe(workspaceCard, {
          attributes: true,
          attributeFilter: ["hidden", "inert", "style"],
        });
    };
    const observer = new MutationObserver(() => {
      discoverNest();
      discoverCard();
      reflow();
    });
    discoverNest();
    discoverCard();
    observer.observe(document.body, { childList: true, subtree: true });
    const resizeObserver = new ResizeObserver(reflow);
    if (panel.current) resizeObserver.observe(panel.current);
    const events = ["pointerdown", "keydown", "input", "focusin", "wheel"];
    for (const event of events)
      window.addEventListener(event, active, { capture: true, passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("blur", onVisibility);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("xuti-workspace-view", onScroll);
    window.addEventListener("xuti-workspace-layout", scheduleAnchor);
    window.addEventListener("xuti-companion-command", onCommand);
    document.addEventListener("visibilitychange", onVisibility);
    reduced.addEventListener("change", onReducedMotion);
    const timer = setInterval(() => {
      const blocked =
        busy.current ||
        nest?.closest('[data-team-active="true"]') ||
        perch ||
        drag ||
        document.hidden ||
        innerWidth < 768 ||
        reduced.matches ||
        panel.current?.matches(":hover, :focus-within") ||
        document.activeElement?.matches(
          "input, textarea, select, [contenteditable=true]",
        ) ||
        document.querySelector(
          ".ant-drawer-open, .ant-modal-wrap:not([style*='display: none']), .workspace-nav-scrim, .companion-details-popover:not(.ant-popover-hidden), .personal-workspace-panel:not([hidden])",
        );
      if (blocked) {
        stopReverie();
        if (transition?.automatic) cancelTransition();
        return;
      }
      if (reverie) return;
      if (transition) return;
      const idleFor = Date.now() - lastActive;
      if (idleFor >= 45000 && Date.now() >= nextReverieAt && nestAvailable()) {
        // Keep this occasional and local to genuinely empty workspace space.
        // The original interactive assistant stays mounted throughout the projection.
        nextReverieAt = Date.now() + 90000;
        const workspace = nest?.closest<HTMLElement>(".personal-workspace");
        const robot =
          panel.current?.querySelector<HTMLElement>(".companion-robot");
        const area = workspace && findReverieSpace(workspace, obstacles());
        if (workspace && robot && area) {
          state.compact = false;
          state.motion = "idle";
          leavePerch();
          reverie = beginCompanionReverie(workspace, robot, area, () => {
            reverie = null;
            panel.current?.removeAttribute("data-reverie");
            lastTravel = Date.now();
          });
          panel.current?.setAttribute("data-reverie", "true");
          attach(false);
          position({
            x: area.x + (area.width - 132) / 2,
            y: area.y + (area.height - 118) / 2,
          });
          awayHops++;
          lastTravel = Date.now();
          return;
        }
      }
      if (state.docked && idleFor >= 6000 && state.motion === "idle") {
        state.motion = "peek";
        publish();
      }
      if (idleFor < 20000 || Date.now() - lastTravel < 24000) return;
      if (!state.docked && nest && nestVisible() && awayHops >= 1)
        travel("home", true);
      else {
        const next = destination(undefined, true);
        if (next) {
          if (!state.docked) awayHops++;
          travel(next, true, state.docked);
        } else lastTravel = Date.now();
      }
    }, 1000);
    return () => {
      stopReverie();
      clearInterval(timer);
      clearTimeout(reflowTimer);
      clearTimeout(clickResetTimer);
      cancelAnimationFrame(dragFrame);
      cancelAnimationFrame(anchorFrame);
      cancelAnimationFrame(climbFrame);
      transition?.timers.forEach(clearTimeout);
      observer.disconnect();
      cardObserver.disconnect();
      nestObserver.disconnect();
      resizeObserver.disconnect();
      targetObserver.disconnect();
      perchObserver.disconnect();
      for (const event of events)
        window.removeEventListener(event, active, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", onVisibility);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("xuti-workspace-view", onScroll);
      window.removeEventListener("xuti-workspace-layout", scheduleAnchor);
      window.removeEventListener("xuti-companion-command", onCommand);
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", onReducedMotion);
      host.remove();
    };
  }, [host, storageKey]);

  return createPortal(
    <div
      ref={panel}
      data-docked={view.docked}
      data-motion={view.motion}
      data-perched={view.perched}
      data-climb-side={view.climbSide}
      className={`workspace-companion${hub.voiceState ? " is-voicing" : ""}${view.dragging ? " is-dragging" : ""}${view.compact ? " is-compact" : ""}`}
      style={{
        transform: `translate3d(${view.position?.x || 0}px, ${view.position?.y || 0}px, 0)`,
        visibility: view.docked || view.position ? "visible" : "hidden",
      }}
      onPointerDown={(event) => controls.current.start(event)}
      onPointerEnter={() => controls.current.active()}
      onClickCapture={(event) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          if ((event.target as Element).closest(".companion-launch")) {
            event.preventDefault();
            event.stopPropagation();
          }
        }
      }}
      onKeyDown={(event) => controls.current.key(event)}
    >
      <SidebarAssistant
        floating
        docked={view.docked}
        onInteract={() => controls.current.interact()}
      />
    </div>,
    host,
  );
}

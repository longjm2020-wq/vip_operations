import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { SidebarAssistant } from "./sidebar-assistant";
import { useAssistantHub } from "./assistant-hub-context";
import { useUser } from "./shared";

type Position = { x: number; y: number };
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
            node.matches("[aria-hidden=true], script, style") &&
            !node.matches(".workspace-ai-core")
          )
            return NodeFilter.FILTER_REJECT;
          const rect = node.getBoundingClientRect();
          if (rect.width && rect.height && !visible(rect))
            return NodeFilter.FILTER_REJECT;
          if (
            node.matches(
              "button, a, input, textarea, select, [contenteditable=true], [role=button], table, [role=grid], canvas, .workspace-ai-core, .workspace-dock, .brand",
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

type Motion = "idle" | "peek" | "departing" | "arriving" | "jumping";
type CompanionView = {
  docked: boolean;
  hasNest: boolean;
  position: Position | null;
  compact: boolean;
  dragging: boolean;
  motion: Motion;
};

export function WorkspaceCompanion() {
  const user = useUser();
  const hub = useAssistantHub();
  const storageKey = `xuti-companion-position:${user.id}`;
  // The portal container never changes: moving between nest and page preserves voice and reminders.
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
    command: (_command: "home" | "explore") => {},
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
    let parked: Position | undefined;
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
      if (panel.current && !state.docked)
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
    const attach = (home: boolean) => {
      state.docked = !!(home && nest);
      const parent = state.docked ? nest! : document.body;
      if (host.parentElement !== parent) {
        const focused = document.activeElement;
        parent.appendChild(host);
        if (focused instanceof HTMLElement && host.contains(focused))
          focused.focus({ preventScroll: true });
      }
      if (state.docked) state.compact = false;
      // Apply the layout immediately when reparenting, before the next React render.
      if (panel.current) {
        panel.current.dataset.docked = String(state.docked);
        panel.current.style.transform = state.docked
          ? ""
          : `translate3d(${state.position?.x || 0}px, ${state.position?.y || 0}px, 0)`;
      }
    };
    const cancelTransition = () => {
      transition?.timers.forEach(clearTimeout);
      transition = null;
      if (state.motion !== "idle") {
        state.motion = "idle";
        publish();
      }
    };
    const active = () => {
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
    const nestVisible = () => {
      const box = nest?.getBoundingClientRect();
      return (
        !!box &&
        box.top >= 0 &&
        box.bottom <= innerHeight &&
        box.left >= 0 &&
        box.right <= innerWidth
      );
    };
    const travel = (
      target: "home" | Position,
      automatic = false,
      jump = false,
    ) => {
      if (target === "home" && !nest) return;
      cancelTransition();
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
          if (!nest) {
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
    const command = (value: "home" | "explore") => {
      active();
      if (value === "home" && nest) {
        if (state.docked) {
          cancelTransition();
          return;
        }
        if (!nestVisible())
          nest.scrollIntoView({ block: "center", behavior: "instant" });
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
      nest = next;
      state.hasNest = !!nest;
      state.dragging = false;
      drag = null;
      active();
      lastTravel = Date.now() - 4000;
      if (nest) {
        attach(true);
        publish();
      } else {
        attach(false);
        clearRest(parked);
      }
    };
    const reflow = () => {
      clearTimeout(reflowTimer);
      reflowTimer = setTimeout(() => {
        if (state.docked || drag || transition) return;
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
        clearRest(state.position || undefined);
        persist();
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
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.start.x,
        dy = event.clientY - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      if (!drag.moved) {
        drag.moved = true;
        suppressClick.current = true;
        cancelTransition();
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
      const box = panel.current?.getBoundingClientRect();
      if (!box) return;
      const { width, height } = size();
      drag = {
        id: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        origin: {
          x: box.x + (box.width - width) / 2,
          y: box.y + (box.height - height) / 2,
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
      active();
      const box = panel.current?.getBoundingClientRect();
      if (!box) return;
      const { width, height } = size();
      const origin = state.docked
        ? {
            x: box.x + (box.width - width) / 2,
            y: box.y + (box.height - height) / 2,
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
      if (value === "home" || value === "explore") command(value);
    };
    const onResize = () => {
      cancelTransition();
      active();
      if (!state.docked) clearRest(state.position || undefined);
    };
    const onScroll = () => {
      active();
      reflow();
    };
    const onVisibility = () => {
      cancelTransition();
      active();
      release();
    };
    const onReducedMotion = () => {
      cancelTransition();
      active();
    };
    const observer = new MutationObserver(() => {
      discoverNest();
      reflow();
    });
    discoverNest();
    const workspace = document.querySelector(".workspace");
    if (workspace)
      observer.observe(workspace, { childList: true, subtree: true });
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
    window.addEventListener("xuti-companion-command", onCommand);
    document.addEventListener("visibilitychange", onVisibility);
    reduced.addEventListener("change", onReducedMotion);
    const timer = setInterval(() => {
      const blocked =
        busy.current ||
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
        if (transition?.automatic) cancelTransition();
        return;
      }
      if (transition) return;
      const idleFor = Date.now() - lastActive;
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
      clearInterval(timer);
      clearTimeout(reflowTimer);
      clearTimeout(clickResetTimer);
      cancelAnimationFrame(dragFrame);
      transition?.timers.forEach(clearTimeout);
      observer.disconnect();
      resizeObserver.disconnect();
      for (const event of events)
        window.removeEventListener(event, active, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", onVisibility);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
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
      className={`workspace-companion${hub.voiceState ? " is-voicing" : ""}${view.dragging ? " is-dragging" : ""}${view.compact ? " is-compact" : ""}`}
      style={{
        transform: view.docked
          ? undefined
          : `translate3d(${view.position?.x || 0}px, ${view.position?.y || 0}px, 0)`,
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
        hasNest={view.hasNest}
        onExplore={() => controls.current.command("explore")}
        onHome={() => controls.current.command("home")}
        onInteract={() => controls.current.interact()}
      />
    </div>,
    host,
  );
}

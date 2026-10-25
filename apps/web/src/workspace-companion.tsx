import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
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
            !node.matches(".workspace-matrix")
          )
            return NodeFilter.FILTER_REJECT;
          const rect = node.getBoundingClientRect();
          if (rect.width && rect.height && !visible(rect))
            return NodeFilter.FILTER_REJECT;
          if (
            node.matches(
              "button, a, input, textarea, select, [contenteditable=true], [role=button], table, [role=grid], canvas, .workspace-matrix, .brand",
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

export function WorkspaceCompanion() {
  const user = useUser();
  const location = useLocation();
  const hub = useAssistantHub();
  const storageKey = `xuti-companion-position:${user.id}`;
  const panel = useRef<HTMLDivElement>(null);
  const point = useRef<Position>({ x: 0, y: 0 });
  const lastClear = useRef<Position>({ x: 0, y: 0 });
  const pointer = useRef<Position | null>(null);
  const flight = useRef<number | null>(null);
  const lastActive = useRef(Date.now());
  const lastWalk = useRef(Date.now());
  const drag = useRef<{
    id: number;
    start: Position;
    origin: Position;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [position, setPosition] = useState<Position | null>(null);
  const [moving, setMoving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [compact, setCompact] = useState(false);
  const working =
    hub.busy ||
    hub.feed?.items?.some(
      (item) => item.kind === "task" && item.status === "running",
    );

  const place = useCallback((next: Position) => {
    point.current = next;
    lastClear.current = next;
    setPosition(next);
  }, []);
  const stopWalking = useCallback(() => {
    if (flight.current !== null) {
      cancelAnimationFrame(flight.current);
      flight.current = null;
      point.current = { ...lastClear.current };
      setPosition({ ...lastClear.current });
      if (panel.current) panel.current.dataset.passing = "false";
      setMoving(false);
    }
  }, []);
  const constrain = useCallback((next: Position) => {
    const box = panel.current?.getBoundingClientRect();
    const maxX = Math.max(
      8,
      document.documentElement.clientWidth - (box?.width || 132) - 8,
    );
    const maxY = Math.max(8, innerHeight - (box?.height || 154) - 8);
    return {
      x: Math.max(8, Math.min(next.x, maxX)),
      y: Math.max(8, Math.min(next.y, maxY)),
    };
  }, []);
  const findRest = useCallback(
    (preferred?: Position) => {
      const areas = occupiedAreas();
      const reminderHeight =
        panel.current
          ?.querySelector(".companion-reminder")
          ?.getBoundingClientRect().height || 0;
      const regular = findSpace(132, 118 + reminderHeight, areas, preferred);
      const small =
        regular || findSpace(64, 58 + reminderHeight, areas, preferred);
      setCompact(!regular);
      const next =
        small || constrain({ x: innerWidth - 72, y: innerHeight - 66 });
      place(next);
      return next;
    },
    [constrain, place],
  );
  const save = (next: Position | null) => {
    try {
      if (next)
        localStorage.setItem(
          storageKey,
          JSON.stringify({ x: next.x / innerWidth, y: next.y / innerHeight }),
        );
      else localStorage.removeItem(storageKey);
    } catch {
      /* Movement also works without local storage. */
    }
  };
  const reset = () => {
    stopWalking();
    findRest();
    save(null);
    lastActive.current = Date.now();
  };

  useEffect(() => {
    let initial: Position | undefined;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y))
        initial = constrain({
          x: saved.x * innerWidth,
          y: saved.y * innerHeight,
        });
    } catch {
      /* Ignore invalid saved positions. */
    }
    findRest(initial);
    const active = () => {
      lastActive.current = Date.now();
      stopWalking();
    };
    const resize = () => {
      active();
      findRest(constrain(point.current));
    };
    const events = [
      "pointerdown",
      "keydown",
      "input",
      "focusin",
      "scroll",
      "wheel",
    ];
    for (const event of events)
      window.addEventListener(event, active, { capture: true, passive: true });
    const pointerMove = (event: globalThis.PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      if (
        flight.current !== null &&
        Math.hypot(
          event.clientX - point.current.x - 66,
          event.clientY - point.current.y - 59,
        ) < 100
      )
        active();
    };
    window.addEventListener("pointermove", pointerMove, { passive: true });
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", active);
    return () => {
      for (const event of events)
        window.removeEventListener(event, active, true);
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", active);
      if (flight.current !== null) cancelAnimationFrame(flight.current);
    };
  }, [storageKey, constrain, findRest, stopWalking]);

  useEffect(() => {
    stopWalking();
    lastActive.current = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const ensureClear = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (drag.current || flight.current !== null) return;
        const box = panel.current?.getBoundingClientRect();
        if (
          box &&
          !isClear(point.current, box.width, box.height, occupiedAreas())
        )
          findRest(point.current);
      }, 250);
    };
    ensureClear();
    const root = document.querySelector(".workspace");
    const observer = new MutationObserver(ensureClear);
    if (root) observer.observe(root, { childList: true, subtree: true });
    const resize = new ResizeObserver(ensureClear);
    if (panel.current) resize.observe(panel.current);
    window.addEventListener("scroll", ensureClear, true);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener("scroll", ensureClear, true);
    };
  }, [location.pathname, findRest, stopWalking]);

  useEffect(() => {
    if (working) stopWalking();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const paused = () =>
      working ||
      drag.current ||
      document.hidden ||
      innerWidth < 768 ||
      reduced.matches ||
      Date.now() - lastActive.current < 20000 ||
      panel.current?.matches(":hover, :focus-within") ||
      document.activeElement?.matches(
        "input, textarea, select, [contenteditable=true]",
      ) ||
      document.querySelector(
        ".ant-drawer-open, .ant-modal-wrap:not([style*='display: none']), .workspace-nav-scrim, .companion-details-popover:not(.ant-popover-hidden)",
      );
    const timer = window.setInterval(() => {
      if (
        paused() ||
        flight.current !== null ||
        Date.now() - lastWalk.current < 24000
      )
        return;
      const box = panel.current?.getBoundingClientRect();
      if (!box) return;
      const obstacles = occupiedAreas();
      if (pointer.current)
        obstacles.push(
          new DOMRect(pointer.current.x - 55, pointer.current.y - 45, 110, 90),
        );
      const clear = (p: Position) =>
        isClear(p, box.width, box.height, obstacles);
      const origin = { ...point.current };
      let destination: Position | null = null;
      // Pick across the entire viewport, including sidebar whitespace and spaces within panels.
      for (let attempt = 0; attempt < 90; attempt++) {
        const candidate = constrain({
          x: Math.random() * innerWidth,
          y: Math.random() * innerHeight,
        });
        if (
          Math.hypot(candidate.x - origin.x, candidate.y - origin.y) > 100 &&
          clear(candidate)
        ) {
          destination = candidate;
          break;
        }
      }
      lastWalk.current = Date.now();
      if (!destination) return;
      const target = destination;
      const started = performance.now();
      const duration = Math.min(
        9000,
        Math.max(
          2600,
          Math.hypot(target.x - origin.x, target.y - origin.y) * 7,
        ),
      );
      setMoving(true);
      const step = (now: number) => {
        if (paused() || !panel.current) {
          stopWalking();
          return;
        }
        const t = Math.min(1, (now - started) / duration);
        const ease = t * t * (3 - 2 * t);
        const next = {
          x: origin.x + (target.x - origin.x) * ease,
          y: origin.y + (target.y - origin.y) * ease,
        };
        point.current = next;
        const passing = !clear(next);
        panel.current.dataset.passing = String(passing);
        if (!passing) lastClear.current = next;
        panel.current.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`;
        if (t < 1) flight.current = requestAnimationFrame(step);
        else {
          flight.current = null;
          place(target);
          setMoving(false);
        }
      };
      flight.current = requestAnimationFrame(step);
    }, 4000);
    return () => {
      clearInterval(timer);
      stopWalking();
    };
  }, [working, constrain, place, stopWalking]);

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      !(event.target as Element).closest(".companion-launch")
    )
      return;
    stopWalking();
    (event.target as Element)
      .closest<HTMLButtonElement>(".companion-launch")!
      .setPointerCapture(event.pointerId);
    suppressClick.current = false;
    drag.current = {
      id: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: { ...point.current },
      moved: false,
    };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.start.x,
      dy = event.clientY - current.start.y;
    if (!current.moved && Math.hypot(dx, dy) < 6) return;
    current.moved = true;
    suppressClick.current = true;
    setDragging(true);
    place(constrain({ x: current.origin.x + dx, y: current.origin.y + dy }));
  };
  const stop = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    if (drag.current.moved) save(findRest(point.current));
    drag.current = null;
    setDragging(false);
    lastActive.current = Date.now() + 10000;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return createPortal(
    <div
      ref={panel}
      className={`workspace-companion${moving ? " is-roaming" : ""}${dragging ? " is-dragging" : ""}${compact ? " is-compact" : ""}`}
      style={{
        transform: `translate3d(${position?.x || 0}px, ${position?.y || 0}px, 0)`,
        visibility: position ? "visible" : "hidden",
      }}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onPointerEnter={stopWalking}
      onClickCapture={(event) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDown={(event) => {
        if (!(event.target as Element).matches(".companion-launch")) return;
        if (event.key === "Home") {
          event.preventDefault();
          reset();
          return;
        }
        const directions: Record<string, Position> = {
          ArrowLeft: { x: -12, y: 0 },
          ArrowRight: { x: 12, y: 0 },
          ArrowUp: { x: 0, y: -12 },
          ArrowDown: { x: 0, y: 12 },
        };
        const direction = directions[event.key];
        if (!direction) return;
        event.preventDefault();
        const next = constrain({
          x: point.current.x + direction.x,
          y: point.current.y + direction.y,
        });
        place(next);
        save(next);
      }}
    >
      <SidebarAssistant floating onReset={reset} />
    </div>,
    document.body,
  );
}

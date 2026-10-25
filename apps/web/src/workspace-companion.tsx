import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { DragOutlined, UndoOutlined } from "@ant-design/icons";
import { SidebarAssistant } from "./sidebar-assistant";
import { useUser } from "./shared";

type Position = { x: number; y: number };
export function WorkspaceCompanion() {
  const user = useUser();
  const key = `xuti-companion-position:${user.id}`;
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    id: number;
    start: Position;
    position: Position;
  } | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const constrain = useCallback((point: Position) => {
    const box = panel.current?.getBoundingClientRect();
    const content = document
      .querySelector(".workspace .content")
      ?.getBoundingClientRect();
    const header = document.querySelector(".topbar")?.getBoundingClientRect();
    const minX = Math.max(8, (content?.left || 0) + 8),
      minY = Math.max(8, (header?.bottom || 0) + 8);
    return {
      x: Math.max(
        minX,
        Math.min(point.x, innerWidth - (box?.width || 170) - 8),
      ),
      y: Math.max(
        minY,
        Math.min(point.y, innerHeight - (box?.height || 240) - 8),
      ),
    };
  }, []);
  const save = (point: Position | null) => {
    try {
      if (point)
        localStorage.setItem(
          key,
          JSON.stringify({ x: point.x / innerWidth, y: point.y / innerHeight }),
        );
      else localStorage.removeItem(key);
    } catch {
      /* Dragging still works without persistent storage. */
    }
  };
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y))
        setPosition(
          constrain({ x: saved.x * innerWidth, y: saved.y * innerHeight }),
        );
    } catch {
      /* Ignore invalid positions. */
    }
    const resize = () =>
      setPosition((previous) => (previous ? constrain(previous) : null));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [key, constrain]);
  const start = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const box = panel.current!.getBoundingClientRect();
    drag.current = {
      id: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      position: { x: box.left, y: box.top },
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    setPosition(
      constrain({
        x: current.position.x + event.clientX - current.start.x,
        y: current.position.y + event.clientY - current.start.y,
      }),
    );
  };
  const stop = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    save(position);
  };
  return (
    <div
      ref={panel}
      className={`workspace-companion${position ? " is-detached" : ""}`}
      style={
        position
          ? {
              position: "fixed",
              left: position.x,
              top: position.y,
              right: "auto",
            }
          : undefined
      }
    >
      <div className="companion-placement">
        <button
          type="button"
          aria-label="拖动小序"
          title="拖动放置；方向键微调，Home 复位"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={stop}
          onPointerCancel={stop}
          onLostPointerCapture={stop}
          onKeyDown={(event) => {
            if (event.key === "Home") {
              event.preventDefault();
              setPosition(null);
              save(null);
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
            const box = panel.current!.getBoundingClientRect();
            const next = constrain({
              x: box.left + direction.x,
              y: box.top + direction.y,
            });
            setPosition(next);
            save(next);
          }}
        >
          <DragOutlined />
          <span>拖动放置</span>
        </button>
        <button
          type="button"
          aria-label="复位助理位置"
          title="回到默认位置"
          onClick={() => {
            setPosition(null);
            save(null);
          }}
        >
          <UndoOutlined />
        </button>
      </div>
      <SidebarAssistant />
    </div>
  );
}

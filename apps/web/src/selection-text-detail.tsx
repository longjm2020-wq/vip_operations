import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { Button } from "antd";
import { CompressOutlined } from "@ant-design/icons";

/** Modeless details follow the active cell without blocking the sheet. */
export function SelectionTextDetail({
  title,
  value,
  editable,
  onChange,
  onClose,
}: {
  title: string;
  value: string;
  editable: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const [position, setPosition] = useState(() => ({
    left: Math.max(
      8,
      window.innerWidth - Math.min(480, window.innerWidth - 32) - 24,
    ),
    top: Math.max(
      8,
      Math.min(
        176,
        window.innerHeight - Math.min(380, window.innerHeight - 96) - 8,
      ),
    ),
  }));
  const [dragging, setDragging] = useState(false);
  const constrain = (left: number, top: number) => {
    const bounds = panel.current?.getBoundingClientRect();
    return {
      left: Math.max(
        8,
        Math.min(left, window.innerWidth - (bounds?.width || 480) - 8),
      ),
      top: Math.max(
        8,
        Math.min(top, window.innerHeight - (bounds?.height || 380) - 8),
      ),
    };
  };
  useEffect(() => {
    const resize = () =>
      setPosition((current) => constrain(current.left, current.top));
    const escape = (event: KeyboardEvent) => {
      if ((event.target as Element)?.closest?.(".selection-image-preview-layer")) return;
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        close.current();
      }
    };
    window.addEventListener("resize", resize);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", escape);
    };
  }, []);
  const start = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button"))
      return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: position.left,
      top: position.top,
    };
    setDragging(true);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (current?.id !== event.pointerId) return;
    setPosition(
      constrain(
        current.left + event.clientX - current.x,
        current.top + event.clientY - current.y,
      ),
    );
  };
  const stop = () => {
    drag.current = null;
    setDragging(false);
  };
  return createPortal(
    <section
      id="selection-cell-detail"
      ref={panel}
      className={`selection-text-detail${dragging ? " is-dragging" : ""}`}
      role="dialog"
      aria-label="单元格详情"
      aria-modal="false"
      style={position}
    >
      <header
        title="拖动标题栏移动详情窗口"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerCancel={stop}
        onLostPointerCapture={stop}
      >
        <strong>{title}</strong>
        <Button
          type="text"
          size="small"
          aria-label="收起单元格详情"
          title="收起详情"
          icon={<CompressOutlined />}
          onClick={onClose}
        />
      </header>
      <textarea
        aria-label="单元格详情内容"
        value={value}
        readOnly={!editable}
        onChange={(event) => {
          if (editable) onChange(event.target.value);
        }}
      />
      <footer>
        {editable ? "修改后自动保存" : "仅查看"} · 拖动标题栏移动 · Esc 收起
      </footer>
    </section>,
    document.body,
  );
}

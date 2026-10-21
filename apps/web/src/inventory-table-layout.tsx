import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
} from "react";
import { App, type TableProps } from "antd";
import type { Row } from "./shared";

export const inventoryColumnWidth = 120;
const minWidth = 72;
const maxWidth = 600;
const clampWidth = (width: number) =>
  Math.max(minWidth, Math.min(maxWidth, Math.round(width)));
type Columns = NonNullable<TableProps<Row>["columns"]>;

export function useInventoryColumnWidths(storageKey: string, source: Columns) {
  const { message } = App.useApp();
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try {
      const saved: unknown = JSON.parse(
        localStorage.getItem(storageKey) || "{}",
      );
      if (saved && typeof saved === "object" && !Array.isArray(saved))
        return Object.fromEntries(
          Object.entries(saved)
            .filter(
              ([, value]) =>
                typeof value === "number" && Number.isFinite(value),
            )
            .map(([key, value]) => [key, clampWidth(value)]),
        );
    } catch {
      // Missing or blocked browser preferences must not block inventory queries.
    }
    return {};
  });
  const current = useRef(widths);
  const resizeColumn = (key: string, width: number, persist: boolean) => {
    const next = { ...current.current, [key]: clampWidth(width) };
    current.current = next;
    setWidths(next);
    if (persist) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        message.warning("列宽已调整；浏览器无法保存设置，刷新后可能无法保留本次调整");
      }
    }
  };
  return {
    columns: source.map((column) => {
      const key =
        "dataIndex" in column ? String(column.dataIndex) : String(column.key);
      return { ...column, width: widths[key] ?? inventoryColumnWidth };
    }),
    resizeColumn,
  };
}

export function InventoryColumnResizeHandle({
  label,
  width,
  onChange,
}: {
  label: string;
  width: number;
  onChange: (width: number, persist: boolean) => void;
}) {
  const change = useRef(onChange);
  change.current = onChange;
  const drag = useRef<{
    element: HTMLSpanElement;
    pointerId: number;
    startX: number;
    startWidth: number;
    nextWidth: number;
  } | null>(null);
  const finish = (persist: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    document.body.classList.remove("inventory-column-resizing");
    if (active.element.hasPointerCapture(active.pointerId))
      active.element.releasePointerCapture(active.pointerId);
    change.current(persist ? active.nextWidth : active.startWidth, persist);
  };
  useEffect(() => {
    const cancel = () => finish(false);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drag.current) {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("keydown", keydown);
      if (drag.current) {
        const active = drag.current;
        drag.current = null;
        document.body.classList.remove("inventory-column-resizing");
        if (active.element.hasPointerCapture(active.pointerId))
          active.element.releasePointerCapture(active.pointerId);
      }
    };
  }, []);
  return (
    <span
      className="inventory-column-resize-handle"
      role="separator"
      aria-label={`${label}列宽`}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      tabIndex={0}
      title="拖动调整列宽；双击恢复120px；方向键调整，Esc取消拖动"
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          element: event.currentTarget,
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: width,
          nextWidth: width,
        };
        document.body.classList.add("inventory-column-resizing");
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        active.nextWidth = clampWidth(
          active.startWidth + event.clientX - active.startX,
        );
        change.current(active.nextWidth, false);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        event.stopPropagation();
        finish(true);
      }}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(false)}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.stopPropagation();
        change.current(inventoryColumnWidth, true);
      }}
      onKeyDown={(event) => {
        if (
          drag.current ||
          !["ArrowLeft", "ArrowRight", "Home"].includes(event.key)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        change.current(
          event.key === "Home"
            ? inventoryColumnWidth
            : width + (event.key === "ArrowRight" ? 10 : -10),
          true,
        );
      }}
    />
  );
}

function InventoryHeaderCell({
  children,
  inventoryResizeHandle,
  ...props
}: ComponentPropsWithRef<"th"> & { inventoryResizeHandle?: ReactNode }) {
  return (
    <th {...props}>
      <div className="inventory-column-heading">{children}</div>
      {inventoryResizeHandle}
    </th>
  );
}

function InventoryBodyCell({
  children,
  ...props
}: ComponentPropsWithRef<"td"> & { "data-inventory-cell"?: boolean }) {
  return (
    <td {...props}>
      {props["data-inventory-cell"] ? (
        <div className="inventory-cell-viewport">
          <div className="inventory-cell-content">{children}</div>
        </div>
      ) : (
        children
      )}
    </td>
  );
}

// Wrap after the shared table decorates identifiers, preserving copying and exports.
export const inventoryTableComponents = {
  header: { cell: InventoryHeaderCell },
  body: { cell: InventoryBodyCell },
};

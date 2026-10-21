import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { App, Dropdown, type MenuProps, type TableProps } from "antd";
import { PushpinOutlined } from "@ant-design/icons";
import type { InventoryDimension } from "../../../packages/contracts/src/inventory-summary";
import { useUser, type Row } from "./shared";
import { InventoryColumnResizeHandle, inventoryColumnWidth, useInventoryColumnWidths } from "./inventory-table-layout";
import {
  columnClickModifiers,
  columnMenuTargets,
  columnPinMenuEntries,
  dragColumnSelection,
  nextColumnSelection,
  nextPinnedColumns,
  type ColumnPinAction,
  type ColumnSelection,
} from "./table-column-selection";

type Columns = NonNullable<TableProps<Row>["columns"]>;
type Props = {
  dimension: InventoryDimension;
  columns: Columns;
  groupKeys?: string[];
  groupVisit?: number;
  children: (columns: Columns) => ReactNode;
};

const headerHint =
  "拖动右侧边缘调整列宽；单击或按住表头拖动选列，Shift连续选择，Ctrl（Mac 为 ⌘）跳选；右键固定或取消固定";

function columnKey(column: Columns[number]) {
  return "dataIndex" in column ? String(column.dataIndex) : String(column.key);
}

function readPinnedColumns(storageKey: string, columns: Columns): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (Array.isArray(saved))
      return columns.map(columnKey).filter((key) => saved.includes(key));
  } catch {
    // A blocked or outdated browser preference must not prevent viewing stock.
  }
  return [];
}

/** Keep each account and inventory dimension's browser preference independent. */
export function InventoryColumnPinning(props: Props) {
  const user = useUser();
  const storageKey = `inventory-fixed-columns-v1:${user.id}:${props.dimension}`;
  return (
    <InventoryColumnPinningState
      key={storageKey}
      {...props}
      storageKey={storageKey}
      widthStorageKey={`inventory-column-widths-v1:${user.id}:${props.dimension}`}
    />
  );
}

function InventoryColumnPinningState({
  columns: sourceColumns,
  children,
  storageKey,
  widthStorageKey,
  groupKeys = [],
  groupVisit = 0,
}: Props & { storageKey: string; widthStorageKey: string }) {
  const { message } = App.useApp();
  const { columns, resizeColumn } = useInventoryColumnWidths(widthStorageKey, sourceColumns);
  const [pinned, setPinned] = useState(() =>
    readPinnedColumns(storageKey, columns),
  );
  const [selection, setSelection] = useState<ColumnSelection>({
    selected: [],
    anchor: null,
  });
  // Columns the open context menu acts on; null keeps the menu closed.
  const [menuTargets, setMenuTargets] = useState<string[] | null>(null);
  const pendingTargets = useRef<string[] | null>(null);
  // Header press-and-drag selection; `base` is what Ctrl/⌘+drag adds to.
  const drag = useRef<{
    anchor: string;
    base: string[];
    additive: boolean;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const surface = useRef<HTMLDivElement>(null);
  const [viewWidth, setViewWidth] = useState(0);
  useEffect(() => {
    if (!surface.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setViewWidth(entry.contentRect.width),
    );
    observer.observe(surface.current);
    return () => observer.disconnect();
  }, []);
  // A plain click outside the column headers or pressing Esc clears the selection.
  useEffect(() => {
    const clear = () => setSelection({ selected: [], anchor: null });
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      if (
        target?.closest?.(".inventory-column-pinning-menu") ||
        (surface.current?.contains(target) && target?.closest?.("thead th"))
      )
        return;
      clear();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    const onMouseUp = () => {
      // A drag that ended on another header must not be followed by click handling.
      if (drag.current?.moved) suppressClick.current = true;
      drag.current = null;
      setTimeout(() => (suppressClick.current = false));
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", onMouseUp);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onMouseUp);
    };
  }, []);
  const tableOrder = columns.map(columnKey);
  const fixedWidth = columns.reduce(
    (width, column) =>
      width +
      (pinned.includes(columnKey(column)) ? Number(column.width) : 0),
    0,
  );
  // Preserve saved choices on small windows while letting every column scroll into view.
  const tooNarrow =
    viewWidth > 0 &&
    fixedWidth > viewWidth - (pinned.length < columns.length ? inventoryColumnWidth : 0);
  const fixed = columns.filter((column) => pinned.includes(columnKey(column)));
  const movable = columns.filter(
    (column) => !pinned.includes(columnKey(column)),
  );
  const ordered = [
    ...fixed,
    ...(fixed.length && groupKeys.length
      ? [
          ...movable.filter((column) => groupKeys.includes(columnKey(column))),
          ...movable.filter((column) => !groupKeys.includes(columnKey(column))),
        ]
      : movable),
  ];
  const displayOrder = ordered.map(columnKey);
  const viewSignature = JSON.stringify([
    displayOrder,
    fixed.length,
    groupKeys,
    groupVisit,
  ]);
  useEffect(() => {
    const body = surface.current?.querySelector<HTMLElement>(".ant-table-body");
    if (!body) return;
    const first =
      !fixed.length && groupKeys.length
        ? ordered.find((column) => groupKeys.includes(columnKey(column)))
        : undefined;
    const target = first
      ? surface.current?.querySelector<HTMLElement>(
          `th[data-inventory-column="${CSS.escape(columnKey(first))}"]`,
        )
      : undefined;
    body.scrollTo({
      left: target
        ? Math.max(
            0,
            body.scrollLeft +
              target.getBoundingClientRect().left -
              body.getBoundingClientRect().left,
          )
        : 0,
      behavior: "instant",
    });
    setSelection({ selected: [], anchor: null });
    setMenuTargets(null);
    drag.current = null;
  }, [viewSignature]);
  const selected = selection.selected.filter((key) =>
    displayOrder.includes(key),
  );
  const openMenuFor = (key: string) => {
    const targets = columnMenuTargets(displayOrder, selected, key);
    // Right-clicking an unselected column makes it the visible single selection.
    if (!selected.includes(key)) setSelection({ selected: [key], anchor: key });
    pendingTargets.current = targets;
  };
  const arranged = ordered.map((column) => {
    const key = columnKey(column),
      isSelected = selected.includes(key);
    return {
      ...column,
      key,
      // Fixed columns need explicit widths so headers, rows and totals share offsets.
      width: column.width,
      fixed: !tooNarrow && pinned.includes(key) ? ("left" as const) : undefined,
      onHeaderCell: () => ({
        inventoryResizeHandle: <InventoryColumnResizeHandle label={String(column.title)} width={column.width} onChange={(width, persist) => resizeColumn(key, width, persist)} />,
        "aria-label": String(column.title),
        "data-inventory-column": key,
        "data-inventory-group": groupKeys.includes(key) || undefined,
        className: isSelected ? "inventory-column-selected" : undefined,
        "aria-selected": isSelected,
        title: headerHint,
        onMouseDown: (event: MouseEvent) => {
          if (event.button !== 0) return;
          // Keep the browser from selecting header text while clicking or dragging.
          event.preventDefault();
          const { shift, toggle } = columnClickModifiers(event);
          drag.current = shift
            ? null
            : { anchor: key, base: selected, additive: toggle, moved: false };
        },
        onMouseEnter: (event: MouseEvent) => {
          const current = drag.current;
          if (!current || !(event.buttons & 1)) return;
          if (key === current.anchor && !current.moved) return;
          current.moved = true;
          setSelection({
            selected: dragColumnSelection(
              displayOrder,
              current.base,
              current.anchor,
              key,
              current.additive,
            ),
            anchor: current.anchor,
          });
        },
        onClick: (event: MouseEvent) => {
          if (suppressClick.current) return;
          setSelection((current) =>
            nextColumnSelection(
              displayOrder,
              current,
              key,
              columnClickModifiers(event),
            ),
          );
        },
        onContextMenu: () => openMenuFor(key),
      }),
      onCell: () => ({
        "data-inventory-cell": true,
        className: isSelected ? "inventory-column-selected" : undefined,
        onContextMenu: () => openMenuFor(key),
      }),
    };
  });
  const save = (next: string[]) => {
    const fixedWidth = columns.reduce(
      (width, column) =>
        width +
        (next.includes(columnKey(column)) ? Number(column.width) : 0),
      0,
    );
    const viewWidth = surface.current?.clientWidth || 0;
    const remainingWidth = next.length < columns.length ? inventoryColumnWidth : 0;
    if (next.length && viewWidth && fixedWidth > viewWidth - remainingWidth) {
      message.warning("固定列总宽超过当前可视区域，请减少选中列后再固定");
      return;
    }
    setPinned(next);
    setSelection({ selected: [], anchor: null });
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      message.warning("固定列已应用；浏览器无法保存设置，刷新后需重新选择");
    }
  };
  const targets = menuTargets ?? [];
  const items: MenuProps["items"] = [
    ...(tooNarrow
      ? [
          {
            key: "narrow",
            label: "窗口较窄，固定暂时停用",
            disabled: true,
          },
        ]
      : []),
    ...columnPinMenuEntries(targets, pinned).map((entry) => ({
      ...entry,
      icon:
        entry.key === "fix-selected" ||
        (entry.key === "fix-column" && entry.label === "固定此列") ? (
          <PushpinOutlined />
        ) : undefined,
    })),
  ];
  return (
    <Dropdown
      trigger={["contextMenu"]}
      open={!!menuTargets}
      destroyOnHidden
      rootClassName="inventory-column-pinning-menu"
      onOpenChange={(next) => {
        if (next && pendingTargets.current)
          setMenuTargets(pendingTargets.current);
        else if (!next) setMenuTargets(null);
        pendingTargets.current = null;
      }}
      menu={{
        "aria-label": "固定列",
        items,
        onClick: ({ key }) => {
          setMenuTargets(null);
          if (key !== "narrow")
            save(
              nextPinnedColumns(
                tableOrder,
                pinned,
                key as ColumnPinAction,
                targets,
              ),
            );
        },
      }}
    >
      <div ref={surface} className="inventory-column-pinning-surface">
        {children(arranged)}
      </div>
    </Dropdown>
  );
}

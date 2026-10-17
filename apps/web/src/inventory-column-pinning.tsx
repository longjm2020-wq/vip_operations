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
import {
  columnMenuTargets,
  nextColumnSelection,
  nextPinnedColumns,
  type ColumnSelection,
} from "./inventory-column-selection";

type Columns = NonNullable<TableProps<Row>["columns"]>;
type Props = {
  dimension: InventoryDimension;
  columns: Columns;
  children: (columns: Columns) => ReactNode;
};

const headerHint =
  "单击选中列；Shift+单击连续选择，Ctrl（Mac 为 ⌘）+单击跳选；右键固定或取消固定";

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
    />
  );
}

function InventoryColumnPinningState({
  columns,
  children,
  storageKey,
}: Props & { storageKey: string }) {
  const { message } = App.useApp();
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
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  const tableOrder = columns.map(columnKey);
  const fixedWidth = columns.reduce(
    (width, column) =>
      width +
      (pinned.includes(columnKey(column)) ? Number(column.width ?? 140) : 0),
    0,
  );
  // Preserve saved choices on small windows while letting every column scroll into view.
  const tooNarrow =
    viewWidth > 0 &&
    fixedWidth > viewWidth - (pinned.length < columns.length ? 140 : 0);
  const ordered = [
    ...columns.filter((column) => pinned.includes(columnKey(column))),
    ...columns.filter((column) => !pinned.includes(columnKey(column))),
  ];
  const displayOrder = ordered.map(columnKey);
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
      width: column.width ?? 140,
      fixed: !tooNarrow && pinned.includes(key) ? ("left" as const) : undefined,
      onHeaderCell: () => ({
        className: isSelected ? "inventory-column-selected" : undefined,
        "aria-selected": isSelected,
        title: headerHint,
        onMouseDown: (event: MouseEvent) => {
          // Shift+click would otherwise select header text instead of columns.
          if (event.shiftKey || event.ctrlKey || event.metaKey)
            event.preventDefault();
        },
        onClick: (event: MouseEvent) =>
          setSelection((current) =>
            nextColumnSelection(displayOrder, current, key, {
              shift: event.shiftKey,
              toggle: event.ctrlKey || event.metaKey,
            }),
          ),
        onContextMenu: () => openMenuFor(key),
      }),
      onCell: () => ({
        className: isSelected ? "inventory-column-selected" : undefined,
        onContextMenu: () => openMenuFor(key),
      }),
    };
  });
  const save = (next: string[]) => {
    const fixedWidth = columns.reduce(
      (width, column) =>
        width +
        (next.includes(columnKey(column)) ? Number(column.width ?? 140) : 0),
      0,
    );
    const viewWidth = surface.current?.clientWidth || 0;
    const remainingWidth = next.length < columns.length ? 140 : 0;
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
  const many = targets.length > 1;
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
    ...(targets.some((key) => !pinned.includes(key))
      ? [
          {
            key: "pin",
            icon: <PushpinOutlined />,
            label: many ? `固定所选 ${targets.length} 列` : "固定此列",
          },
        ]
      : []),
    ...(targets.some((key) => pinned.includes(key))
      ? [
          {
            key: "unpin",
            label: many ? `取消固定所选 ${targets.length} 列` : "取消固定此列",
          },
        ]
      : []),
    ...(pinned.length
      ? [{ key: "unpin-all", label: "取消所有固定列" }]
      : []),
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
          if (key === "pin" || key === "unpin" || key === "unpin-all")
            save(nextPinnedColumns(tableOrder, pinned, key, targets));
        },
      }}
    >
      <div ref={surface} className="inventory-column-pinning-surface">
        {children(arranged)}
      </div>
    </Dropdown>
  );
}

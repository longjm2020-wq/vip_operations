import { useEffect, useRef, useState, type ReactNode } from "react";
import { App, Button, Checkbox, Dropdown, type TableProps } from "antd";
import { PushpinOutlined } from "@ant-design/icons";
import type { InventoryDimension } from "../../../packages/contracts/src/inventory-summary";
import { useUser, type Row } from "./shared";

type Columns = NonNullable<TableProps<Row>["columns"]>;
type Props = {
  dimension: InventoryDimension;
  columns: Columns;
  children: (columns: Columns) => ReactNode;
};

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
  const [draft, setDraft] = useState(pinned);
  const [open, setOpen] = useState(false);
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
  const arranged = [
    ...columns.filter((column) => pinned.includes(columnKey(column))),
    ...columns.filter((column) => !pinned.includes(columnKey(column))),
  ].map((column) => ({
    ...column,
    key: columnKey(column),
    // Fixed columns need explicit widths so headers, rows and totals share offsets.
    width: column.width ?? 140,
    fixed:
      !tooNarrow && pinned.includes(columnKey(column))
        ? ("left" as const)
        : undefined,
  }));
  const apply = (keys: string[]) => {
    const next = columns.map(columnKey).filter((key) => keys.includes(key));
    const fixedWidth = columns.reduce(
      (width, column) =>
        width +
        (next.includes(columnKey(column)) ? Number(column.width ?? 140) : 0),
      0,
    );
    const viewWidth = surface.current?.clientWidth || 0;
    const remainingWidth = next.length < columns.length ? 140 : 0;
    if (next.length && viewWidth && fixedWidth > viewWidth - remainingWidth) {
      message.warning("固定列总宽超过当前可视区域，请减少勾选列后再应用");
      return;
    }
    setPinned(next);
    setDraft(next);
    setOpen(false);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      message.warning("固定列已应用；浏览器无法保存设置，刷新后需重新选择");
    }
  };
  return (
    <Dropdown
      trigger={["contextMenu"]}
      autoFocus
      open={open}
      destroyOnHidden
      onOpenChange={(next) => {
        if (next) setDraft(pinned);
        setOpen(next);
      }}
      popupRender={() => (
        <div
          className="inventory-column-pinning-menu"
          role="dialog"
          aria-label="固定多列"
          tabIndex={-1}
          onKeyDown={(event) => {
            // Dropdown's menu shortcut would otherwise close this checkbox form on Tab.
            if (event.key === "Tab") event.stopPropagation();
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <div className="inventory-column-pinning-title">
            <PushpinOutlined /> 固定多列
          </div>
          <div className="inventory-column-pinning-hint">
            {tooNarrow
              ? "窗口较窄，固定暂时停用；放大窗口或减少固定列"
              : "勾选需要固定在左侧的列"}
          </div>
          <div className="inventory-column-pinning-options">
            {columns.map((column) => {
              const key = columnKey(column),
                label = String(column.title);
              return (
                <Checkbox
                  key={key}
                  aria-label={`固定${label}`}
                  checked={draft.includes(key)}
                  onChange={(event) =>
                    setDraft((current) =>
                      event.target.checked
                        ? [...current, key]
                        : current.filter((item) => item !== key),
                    )
                  }
                >
                  {label}
                </Checkbox>
              );
            })}
          </div>
          <div className="inventory-column-pinning-actions">
            <Button
              size="small"
              disabled={!pinned.length}
              onClick={() => apply([])}
            >
              取消所有固定列
            </Button>
            <Button size="small" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button size="small" type="primary" onClick={() => apply(draft)}>
              应用固定
            </Button>
          </div>
        </div>
      )}
    >
      <div ref={surface} className="inventory-column-pinning-surface">
        {children(arranged)}
      </div>
    </Dropdown>
  );
}

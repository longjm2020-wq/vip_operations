import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Alert, App, Button, Empty, Input, Modal, Select, Tabs } from "antd";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  FolderOutlined,
  HolderOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import "./selection-column-groups.css";

export type SelectionColumnGroup = {
  id: string;
  name: string;
  columnKeys: string[];
};
export const selectionColumnGroupsKey = "selection-column-groups-v1";

export function storedSelectionColumnGroups(
  key: string,
): SelectionColumnGroup[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(stored)) return [];
    const ids = new Set<string>();
    return stored.flatMap((group) => {
      if (
        !group ||
        typeof group.id !== "string" ||
        !group.id ||
        ids.has(group.id) ||
        typeof group.name !== "string" ||
        !group.name.trim() ||
        !Array.isArray(group.columnKeys)
      )
        return [];
      ids.add(group.id);
      return [
        {
          id: group.id,
          name: group.name.trim(),
          columnKeys: [
            ...new Set<string>(
              group.columnKeys.filter(
                (key: unknown): key is string => typeof key === "string",
              ),
            ),
          ],
        },
      ];
    });
  } catch {
    return [];
  }
}

export function SelectionColumnGroupManager({
  columns,
  visible,
  groups,
  onSave,
  persistenceHint,
}: {
  columns: { key: string; label: string; deleted?: boolean }[];
  visible: string[];
  groups: SelectionColumnGroup[];
  onSave: (groups: SelectionColumnGroup[]) => Promise<boolean | void> | boolean | void;
  persistenceHint?: string;
}) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SelectionColumnGroup[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const pointerDrag = useRef<{ id: number; source: string; x: number; y: number; moved: boolean; target: string | null } | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const clearDrag = () => {
    pointerDrag.current = null;
    setDraggedId(null);
    setDropId(null);
  };
  const move = (id: string, to: number) =>
    setDraft((current) => {
      const from = current.findIndex((group) => group.id === id);
      if (from < 0 || to < 0 || to >= current.length || from === to)
        return current;
      const next = [...current],
        [group] = next.splice(from, 1);
      next.splice(to, 0, group);
      return next;
    });
  useEffect(() => {
    window.addEventListener("blur", clearDrag);
    return () => window.removeEventListener("blur", clearDrag);
  }, []);
  const dragMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = pointerDrag.current;
    if (!current || current.id !== event.pointerId || saving) return;
    if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
    current.moved = true;
    setDraggedId(current.source);
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-column-group]");
    const ownList = event.currentTarget.closest(".selection-column-group-list");
    current.target = target && target.closest(".selection-column-group-list") === ownList ? target.dataset.columnGroup || null : null;
    setDropId(current.target === current.source ? null : current.target);
  };
  const dragEnd = (event: PointerEvent<HTMLButtonElement>) => {
    const current = pointerDrag.current;
    if (!current || current.id !== event.pointerId) return;
    if (!saving && current.moved && current.target) move(current.source, draft.findIndex(group => group.id === current.target));
    clearDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const update = (id: string, patch: Partial<SelectionColumnGroup>) =>
    setDraft((current) =>
      current.map((group) =>
        group.id === id ? { ...group, ...patch } : group,
      ),
    );
  const save = async () => {
    if (saving) return;
    const next = draft.map((group) => ({
      ...group,
      name: group.name.trim(),
      columnKeys: [...new Set(group.columnKeys)],
    }));
    if (next.some((group) => !group.name)) {
      message.warning("请填写每个分组的名称");
      return;
    }
    if (
      next.some((group) => group.name === "全部字段") ||
      new Set(next.map((group) => group.name)).size !== next.length
    ) {
      message.warning("分组名称不能重复或使用「全部字段」");
      return;
    }
    if (next.some((group) => !group.columnKeys.length)) {
      message.warning("请为每个分组选择至少一个字段");
      return;
    }
    setSaving(true);
    setSaveError("");
    clearDrag();
    try {
      const saved = await onSave(next);
      if (saved === false) throw new Error("分组尚未保存，请处理表格设置提示后重试");
      setOpen(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "分组保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Button
        aria-label="字段分组"
        icon={<FolderOutlined />}
        onClick={() => {
          clearDrag();
          setSaveError("");
          setDraft(
            groups.map((group) => ({
              ...group,
              columnKeys: [...group.columnKeys],
            })),
          );
          setOpen(true);
        }}
      >
        字段分组
      </Button>
      <Modal
        title="配置字段分组"
        open={open}
        width={640}
        okText="保存分组"
        cancelText={saveError ? "关闭窗口" : "取消"}
        confirmLoading={saving}
        okButtonProps={{ "aria-label": "保存分组" }}
        maskClosable={!saving}
        keyboard={!saving}
        closable={!saving}
        cancelButtonProps={{ disabled: saving }}
        onCancel={() => {
          if (saving) return;
          clearDrag();
          setOpen(false);
        }}
        onOk={() => void save()}
      >
        <p className="selection-column-group-help">
          将相关字段整理为快捷
          TAB。有固定列时，分组字段移到固定列右侧，其余字段继续显示；没有固定列时，定位到分组首列。
        </p>
        <p className="selection-column-group-help">
          拖动卡片左侧手柄，或用上移、下移调整 TAB
          顺序。手柄聚焦后也可按↑、↓；点击「保存分组」才生效，取消不保存。
        </p>
        <div
          className="selection-column-group-list"
          role="list"
          aria-label="字段分组顺序"
        >
          {!draft.length && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无字段分组"
            />
          )}
          {draft.map((group, index) => (
            <div
              className="selection-column-group-config"
              key={group.id}
              role="listitem"
              data-column-group={group.id}
              data-group-drop={
                dropId === group.id
                  ? draft.findIndex((item) => item.id === draggedId) < index
                    ? "after"
                    : "before"
                  : undefined
              }
            >
              <div className="selection-column-group-name">
                <Button
                  className="selection-column-group-handle"
                  type="text"
                  icon={<HolderOutlined />}
                  aria-label={`拖动分组${group.name || index + 1}`}
                  title="拖动调整分组顺序，或按↑、↓"
                  disabled={saving}
                  style={{ touchAction: "none" }}
                  onPointerDown={event => {
                    if (saving || event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.focus();
                    pointerDrag.current = { id: event.pointerId, source: group.id, x: event.clientX, y: event.clientY, moved: false, target: null };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={dragMove}
                  onPointerUp={dragEnd}
                  onPointerCancel={clearDrag}
                  onLostPointerCapture={clearDrag}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && pointerDrag.current) {
                      event.preventDefault();
                      event.stopPropagation();
                      clearDrag();
                      return;
                    }
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                      event.preventDefault();
                      move(
                        group.id,
                        index + (event.key === "ArrowUp" ? -1 : 1),
                      );
                    }
                  }}
                />
                <Input
                  aria-label={`分组名称${index + 1}`}
                  maxLength={40}
                  value={group.name}
                  disabled={saving}
                  placeholder="分组名称，例如：质检"
                  onChange={(event) =>
                    update(group.id, { name: event.target.value })
                  }
                />
                <Button
                  type="text"
                  icon={<ArrowUpOutlined />}
                  aria-label={`上移分组${group.name || index + 1}`}
                  title="上移分组"
                  disabled={saving || index === 0}
                  onClick={() => move(group.id, index - 1)}
                />
                <Button
                  type="text"
                  icon={<ArrowDownOutlined />}
                  aria-label={`下移分组${group.name || index + 1}`}
                  title="下移分组"
                  disabled={saving || index === draft.length - 1}
                  onClick={() => move(group.id, index + 1)}
                />
                <Button
                  type="text"
                  danger
                  disabled={saving}
                  icon={<DeleteOutlined />}
                  aria-label={`删除分组${index + 1}`}
                  onClick={() =>
                    setDraft((current) =>
                      current.filter((item) => item.id !== group.id),
                    )
                  }
                />
              </div>
              <Select
                aria-label={`分组字段${index + 1}`}
                mode="multiple"
                disabled={saving}
                value={group.columnKeys}
                placeholder="选择本组字段，可包含图片"
                optionFilterProp="label"
                options={columns.map((column) => ({
                  value: column.key,
                  label: `${column.label}${column.deleted ? "（已删除）" : !visible.includes(column.key) ? "（已隐藏）" : ""}`,
                  disabled: column.deleted,
                }))}
                onChange={(columnKeys) => update(group.id, { columnKeys })}
              />
            </div>
          ))}
        </div>
        <Button
          aria-label="添加分组"
          disabled={saving}
          icon={<PlusOutlined />}
          onClick={() =>
            setDraft((current) => [
              ...current,
              { id: crypto.randomUUID(), name: "", columnKeys: [] },
            ])
          }
        >
          添加分组
        </Button>
        {saveError && <Alert type="error" showIcon title={saveError} />}
        <p className="selection-column-group-help">
          {persistenceHint ?? "可为同一字段配置多个分组。隐藏或删除的字段暂不显示，恢复后沿用分组设置。只含公开字段的分组随本表共享，修改需要表格编辑权限；包含私有字段的分组仅本人保存，只读用户也可配置。当前 TAB 选择按账号及表格保存，换设备可恢复。"}
        </p>
      </Modal>
    </>
  );
}

export function SelectionColumnGroupTabs({
  groups,
  visibleKeys,
  activeKey,
  onChange,
}: {
  groups: SelectionColumnGroup[];
  visibleKeys: string[];
  activeKey: string;
  onChange: (key: string) => void;
}) {
  if (!groups.length) return null;
  return (
    <Tabs
      className="selection-column-group-tabs"
      aria-label="字段分组快捷标签"
      activeKey={activeKey}
      onTabClick={onChange}
      items={[
        { key: "", label: "全部字段" },
        ...groups.map((group) => ({
          key: group.id,
          label: group.name,
          disabled: !group.columnKeys.some((key) => visibleKeys.includes(key)),
        })),
      ]}
    />
  );
}

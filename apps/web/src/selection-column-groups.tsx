import { useState } from "react";
import { App, Button, Empty, Input, Modal, Select, Tabs } from "antd";
import { DeleteOutlined, FolderOutlined, PlusOutlined } from "@ant-design/icons";
import type { SelectionField } from "./selection-field-types";

export type SelectionColumnGroup = { id: string; name: string; columnKeys: string[] };
export const selectionColumnGroupsKey = "selection-column-groups-v1";

export function storedSelectionColumnGroups(key: string): SelectionColumnGroup[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(stored)) return [];
    const ids = new Set<string>();
    return stored.flatMap(group => {
      if (!group || typeof group.id !== "string" || !group.id || ids.has(group.id) || typeof group.name !== "string" || !group.name.trim() || !Array.isArray(group.columnKeys)) return [];
      ids.add(group.id);
      return [{ id: group.id, name: group.name.trim(), columnKeys: [...new Set<string>(group.columnKeys.filter((key: unknown): key is string => typeof key === "string"))] }];
    });
  } catch { return []; }
}

export function SelectionColumnGroupManager({ columns, visible, groups, onSave }: {
  columns: SelectionField[]; visible: string[]; groups: SelectionColumnGroup[]; onSave: (groups: SelectionColumnGroup[]) => void;
}) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SelectionColumnGroup[]>([]);
  const update = (id: string, patch: Partial<SelectionColumnGroup>) => setDraft(current => current.map(group => group.id === id ? { ...group, ...patch } : group));
  const save = () => {
    const next = draft.map(group => ({ ...group, name: group.name.trim(), columnKeys: [...new Set(group.columnKeys)] }));
    if (next.some(group => !group.name)) { message.warning("请填写每个分组的名称"); return; }
    if (next.some(group => group.name === "全部字段") || new Set(next.map(group => group.name)).size !== next.length) { message.warning("分组名称不能重复或使用「全部字段」"); return; }
    if (next.some(group => !group.columnKeys.length)) { message.warning("请为每个分组选择至少一个字段"); return; }
    onSave(next); setOpen(false);
  };
  return <>
    <Button aria-label="字段分组" icon={<FolderOutlined />} onClick={() => { setDraft(groups.map(group => ({ ...group, columnKeys: [...group.columnKeys] }))); setOpen(true); }}>字段分组</Button>
    <Modal title="配置字段分组" open={open} width={640} okText="保存分组" onCancel={() => setOpen(false)} onOk={save}>
      <p className="selection-column-group-help">将相关字段整理为快捷 TAB。有固定列时，分组字段移到固定列右侧，其余字段继续显示；没有固定列时，定位到分组首列。</p>
      <div className="selection-column-group-list">{!draft.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无字段分组" />}{draft.map((group, index) => <div className="selection-column-group-config" key={group.id}>
        <div className="selection-column-group-name"><Input aria-label={`分组名称${index + 1}`} maxLength={40} value={group.name} placeholder="分组名称，例如：质检" onChange={event => update(group.id, { name: event.target.value })} /><Button type="text" danger icon={<DeleteOutlined />} aria-label={`删除分组${index + 1}`} onClick={() => setDraft(current => current.filter(item => item.id !== group.id))} /></div>
        <Select aria-label={`分组字段${index + 1}`} mode="multiple" value={group.columnKeys} placeholder="选择本组字段，可包含图片" optionFilterProp="label" options={columns.map(column => ({ value: column.key, label: `${column.label}${column.deleted ? "（已删除）" : !visible.includes(column.key) ? "（已隐藏）" : ""}`, disabled: column.deleted }))} onChange={columnKeys => update(group.id, { columnKeys })} />
      </div>)}</div>
      <Button aria-label="添加分组" icon={<PlusOutlined />} onClick={() => setDraft(current => [...current, { id: crypto.randomUUID(), name: "", columnKeys: [] }])}>添加分组</Button>
      <p className="selection-column-group-help">可为同一字段配置多个分组。隐藏或删除的字段暂不显示，恢复后沿用分组设置。分组只保存在当前浏览器，并按表格分别保存。</p>
    </Modal>
  </>;
}

export function SelectionColumnGroupTabs({ groups, visibleKeys, activeKey, onChange }: {
  groups: SelectionColumnGroup[]; visibleKeys: string[]; activeKey: string; onChange: (key: string) => void;
}) {
  if (!groups.length) return null;
  return <Tabs className="selection-column-group-tabs" aria-label="字段分组快捷标签" activeKey={activeKey} onTabClick={onChange} items={[
    { key: "", label: "全部字段" },
    ...groups.map(group => ({ key: group.id, label: group.name, disabled: !group.columnKeys.some(key => visibleKeys.includes(key)) })),
  ]} />;
}

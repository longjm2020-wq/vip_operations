import { useState } from "react";
import { App, Button, Input, Modal, Select, Switch, Tag } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { fieldTypes, type FieldType } from "./selection-field-types";
import { namedTypeError, typeOptions, type FieldTypeCatalog } from "./selection-type-catalog";

export function SelectionTypeCatalogManager({ open, catalog, canEdit, onChange, onClose }: { open: boolean; catalog: FieldTypeCatalog; canEdit: boolean; onChange: (catalog: FieldTypeCatalog) => void; onClose: () => void }) {
  const { message } = App.useApp();
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<{ name: string; baseType: FieldType; choices: string } | null>(null);
  const types = [
    ...(Object.keys(fieldTypes) as FieldType[]).map(key => ({ key, name: fieldTypes[key], baseType: key, enabled: !catalog.disabled.includes(key), custom: false })),
    ...catalog.custom.map(type => ({ ...type, custom: true })),
  ];
  const addType = () => {
    if (!draft || !canEdit) return;
    const options = ["single", "multiple", "tags"].includes(draft.baseType) ? typeOptions(draft.choices) : [];
    const error = namedTypeError(draft.name, draft.baseType, options, catalog);
    if (error) { message.error(error); return; }
    onChange({ ...catalog, custom: [...catalog.custom, { key: `preset:${crypto.randomUUID()}`, name: draft.name.trim(), baseType: draft.baseType, enabled: true, options }] });
    setDraft(null);
  };
  return <>
    <Modal title="字段类型管理" open={open} onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
      <p className="selection-type-help">启用的类型可在添加或编辑字段时选择。停用只收起选择项，已用字段继续正常使用。</p>
      <div className="selection-type-actions"><Input.Search aria-label="搜索字段类型" placeholder="搜索类型" value={search} onChange={event => setSearch(event.target.value)} /><Button aria-label="新增类型" icon={<PlusOutlined />} disabled={!canEdit} onClick={() => setDraft({ name: "", baseType: "text", choices: "" })}>新增类型</Button></div>
      <div className="selection-type-list">{types.filter(type => type.name.includes(search.trim())).map(type => <div className="selection-type-item" key={type.key}>
        <div><strong>{type.name}</strong><span>{type.custom ? `基于${fieldTypes[type.baseType]}` : "内置类型"}</span></div>
        <Tag color={type.enabled ? "orange" : undefined}>{type.enabled ? "启用" : "停用"}</Tag>
        <Switch size="small" aria-label={`启用类型：${type.name}`} checked={type.enabled} disabled={!canEdit} onChange={enabled => {
          if (type.custom) onChange({ ...catalog, custom: catalog.custom.map(item => item.key === type.key ? { ...item, enabled } : item) });
          else onChange({ ...catalog, disabled: enabled ? catalog.disabled.filter(key => key !== type.key) : [...catalog.disabled, type.key as FieldType] });
        }} />
      </div>)}{!types.some(type => type.name.includes(search.trim())) && <p className="selection-type-help">没有匹配的类型</p>}</div>
      <p className="selection-type-help">类型目录保存在当前浏览器，按表格分别保存。新增类型沿用所选基础类型的输入与校验规则。</p>
    </Modal>
    <Modal title="新增字段类型" open={!!draft} onCancel={() => setDraft(null)} onOk={addType} okText="保存类型" cancelText="取消">{draft && <div className="selection-field-form">
      <label>类型名称<Input aria-label="类型名称" maxLength={40} placeholder="例如：质检结果" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>基础类型<Select aria-label="基础类型" showSearch optionFilterProp="label" value={draft.baseType} options={(Object.keys(fieldTypes) as FieldType[]).map(value => ({ value, label: fieldTypes[value] }))} onChange={baseType => setDraft({ ...draft, baseType })} /></label>
      {["single", "multiple", "tags"].includes(draft.baseType) && <label>默认候选选项<Input.TextArea aria-label="默认候选选项" rows={5} placeholder="每行一个选项" value={draft.choices} onChange={event => setDraft({ ...draft, choices: event.target.value })} /></label>}
      <p className="selection-type-help">选择此类型时带入默认选项，之后可在各字段中单独修改选项及配色。</p>
    </div>}</Modal>
  </>;
}

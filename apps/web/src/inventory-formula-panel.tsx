import { useMemo, useRef, useState } from "react";
import { Alert, App, Button, Drawer, Empty, Input, Modal, Space, Spin, Switch, Table, Tag, Typography } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { CalculatorOutlined, PlusOutlined } from "@ant-design/icons";
import { api, queryClient } from "./api";
import { useUser, type Row } from "./shared";
import {
  evaluateInventoryFormula, inventoryAvailableFormulaExample, inventoryFormulaExample, inventoryFormulaFields,
  inventoryCalculationFieldLimit, inventoryCalculationFieldWriteSchema, parseInventoryFormula, type InventoryCalculationField,
} from "../../../packages/contracts/src/inventory-formula";

type Draft = { id?: string; revision: number; name: string; formula: string; isPublic: boolean };

export function InventoryFormulaPanel({ records, skuView }: { records: Row[]; skuView: boolean }) {
  const { message } = App.useApp(), user = useUser();
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<InventoryCalculationField[]>([]), [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null), [deleting, setDeleting] = useState<InventoryCalculationField | null>(null);
  const input = useRef<TextAreaRef>(null), selection = useRef({ start: 0, end: 0 });
  const formula = draft?.formula ?? "";
  const parsed = useMemo(() => {
    if (!formula.trim()) return { node: null, error: "" };
    try { return { node: parseInventoryFormula(formula), error: "" }; }
    catch (error) { return { node: null, error: (error as Error).message }; }
  }, [formula]);
  const load = async () => {
    setLoading(true); setError("");
    try { setFields((await api("/inventory/calculation-fields")).data); }
    catch (error) { setError((error as Error).message); }
    finally { setLoading(false); }
  };
  const mutate = async (path: string, body: object, notice: string, saved?: () => void) => {
    setBusy(true); setError("");
    try {
      await api(`/inventory/calculation-fields${path}`, "POST", body);
      saved?.(); message.success(notice);
      await Promise.all([load(), queryClient.invalidateQueries({ queryKey: ["/inventory/summary"] })]);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const edit = (value: Draft) => {
    setDraft(value); setError(""); selection.current = { start: value.formula.length, end: value.formula.length };
  };
  const update = (value: Partial<Draft>) => setDraft(current => current ? { ...current, ...value } : null);
  const insert = (token: string) => {
    const { start, end } = selection.current;
    update({ formula: formula.slice(0, start) + token + formula.slice(end) });
    selection.current = { start: start + token.length, end: start + token.length };
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.resizableTextArea?.textArea.setSelectionRange(selection.current.start, selection.current.end);
    });
  };
  const setExample = (value: string) => { update({ formula: value }); selection.current = { start: value.length, end: value.length }; };
  const save = () => {
    const result = inventoryCalculationFieldWriteSchema.safeParse(draft);
    if (!result.success) { setError(result.error.issues[0]?.message ?? "请检查字段设置"); return; }
    void mutate("", result.data, "字段已保存并重算", () => setDraft(null));
  };
  const atLimit = fields.filter(field => field.ownerId === user.id).length >= inventoryCalculationFieldLimit;
  return <>
    <Button icon={<CalculatorOutlined aria-hidden="true" />} onClick={() => { setOpen(true); setDraft(null); void load(); }}>计算字段配置</Button>
    <Drawer title={draft ? draft.id ? "编辑计算字段" : "新增计算字段" : "计算字段配置"} open={open} size={760}
      onClose={() => !busy && setOpen(false)}
      footer={<Space style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button disabled={busy} onClick={() => draft ? (setDraft(null), setError("")) : setOpen(false)}>{draft ? "返回字段列表" : "关闭"}</Button>
        {draft && <Button type="primary" loading={busy} disabled={!!parsed.error || !parsed.node || !draft.name.trim()} onClick={save}>保存并重算</Button>}
      </Space>}>
      <Spin spinning={loading}>
        <Space orientation="vertical" size={20} style={{ width: "100%" }}>
          {error && <Alert type="error" showIcon title={error} description="草稿未被覆盖。可返回列表重新读取最新字段后再编辑。"
            action={<Button disabled={busy} onClick={() => { setDraft(null); void load(); }}>重新读取</Button>} />}
          {!draft ? <>
            <Typography.Text type="secondary">新增字段显示在“实际库存数”前。显示设置仅影响自己；公开后，有库存查看权限的账号可使用该字段。</Typography.Text>
            <Space wrap>
              <Button type="primary" icon={<PlusOutlined aria-hidden="true" />} disabled={busy || loading || atLimit} onClick={() => edit({ revision: 0, name: "", formula: "", isPublic: false })}>新增字段</Button>
              <Button disabled={busy || loading || atLimit} onClick={() => edit({ revision: 0, name: "在仓可用库存", formula: inventoryAvailableFormulaExample, isPublic: false })}>新增在仓可用库存</Button>
              <Typography.Text type="secondary">我的字段 {fields.filter(field => field.ownerId === user.id).length} / {inventoryCalculationFieldLimit}</Typography.Text>
            </Space>
            {!loading && !fields.length && <Empty description="还没有计算字段，点击新增开始配置" />}
            {fields.map(field => <section key={field.id} className="inventory-formula-field" aria-label={`计算字段：${field.name}`}>
              <div className="inventory-formula-field-heading">
                <div><strong>{field.name}</strong> <Tag color={field.isPublic ? "blue" : undefined}>{field.isPublic ? "公开" : "不公开"}</Tag>
                  <div className="secondary">{field.ownerId === user.id ? "我创建的" : `创建者：${field.ownerName}`}</div>
                </div>
                <Switch checked={!field.hidden} checkedChildren="显示" unCheckedChildren="隐藏" aria-label={`显示${field.name}`} disabled={busy}
                  onChange={checked => void mutate("/view", { id: field.id, revision: field.viewRevision, hidden: !checked }, checked ? "已显示字段" : "已隐藏字段")} />
              </div>
              <div className="inventory-formula-expression">{field.formula}</div>
              {field.canManage ? <Space wrap>
                <Button size="small" disabled={busy} onClick={() => edit({ id: field.id, revision: field.revision, name: field.name, formula: field.formula, isPublic: field.isPublic })}>编辑</Button>
                <Button size="small" disabled={busy} onClick={() => void mutate("", { id: field.id, revision: field.revision, name: field.name, formula: field.formula, isPublic: !field.isPublic }, field.isPublic ? "已设为不公开" : "已公开字段")}>{field.isPublic ? "设为不公开" : "公开字段"}</Button>
                <Button size="small" danger disabled={busy} onClick={() => setDeleting(field)}>删除</Button>
              </Space> : <Typography.Text type="secondary">可切换显示状态；编辑和删除由创建者或超级管理员管理。</Typography.Text>}
            </section>)}
          </> : <>
            <div><label htmlFor="inventory-field-name">字段名称</label><Input id="inventory-field-name" aria-label="字段名称" maxLength={40}
              value={draft.name} disabled={busy} onChange={event => update({ name: event.target.value })} placeholder="例如：在仓可用库存" style={{ marginTop: 8 }} /></div>
            <Space><Switch checked={draft.isPublic} aria-label="公开字段" disabled={busy} onChange={isPublic => update({ isPublic })} />
              <span>{draft.isPublic ? "公开：有库存查看权限的账号可使用" : "不公开：仅自己可见"}</span></Space>
            <label htmlFor="inventory-formula">计算公式</label>
            <Input.TextArea id="inventory-formula" aria-label="计算公式" ref={input} value={formula} disabled={busy} rows={4} maxLength={512}
              placeholder="点击下方字段和运算符组合公式，也可直接输入数字和括号"
              onChange={event => { update({ formula: event.target.value }); selection.current = { start: event.target.selectionStart, end: event.target.selectionEnd }; }}
              onSelect={event => { selection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }; }} />
            {parsed.error && <Alert type="error" showIcon title={parsed.error} />}
            <Space wrap>{inventoryFormulaFields.map(field => <Button key={field.key} disabled={busy} onClick={() => insert(`[${field.label}]`)}>{field.label}</Button>)}</Space>
            <Space wrap>{["+", "-", "×", "÷", "(", ")"].map(operator => <Button key={operator} aria-label={`插入 ${operator}`} disabled={busy} onClick={() => insert(` ${operator} `)}>{operator}</Button>)}
              <Button disabled={busy} onClick={() => setExample("")}>清空公式</Button>
            </Space>
            <Space wrap>
              <Button size="small" disabled={busy} onClick={() => setExample(inventoryFormulaExample)}>填入在仓总库存示例</Button>
              <Button size="small" disabled={busy} onClick={() => setExample(inventoryAvailableFormulaExample)}>填入在仓可用库存示例</Button>
            </Space>
            <Alert type="info" showIcon title="先乘除后加减，括号优先"
              description="只引用上方原始字段，先逐商品计算并保留4位小数，再汇总到货号、款号和全部筛选总计。字段缺失、除数为0或结果超出范围时显示无法计算，汇总显示不完整。计算结果不改写原始库存。" />
            {skuView && parsed.node && <div><Typography.Title level={5}>当前页预览</Typography.Title>
              <Table size="small" pagination={false} rowKey="id" dataSource={records.slice(0, 3)} columns={[
                { title: "商品编码", dataIndex: "skuCode" },
                { title: draft.name || "计算结果", render: (_, row) => {
                  const result = evaluateInventoryFormula(parsed.node!, row);
                  return result == null ? "无法计算" : result.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
                } },
              ]} />
            </div>}
            {!skuView && <Typography.Text type="secondary">切换到条码视图可预览具体商品的计算结果。</Typography.Text>}
          </>}
        </Space>
      </Spin>
    </Drawer>
    <Modal title={`删除“${deleting?.name ?? ""}”？`} open={!!deleting} okText="删除字段" cancelText="取消" confirmLoading={busy}
      okButtonProps={{ danger: true }} onCancel={() => !busy && setDeleting(null)}
      onOk={() => deleting && void mutate("/delete", { id: deleting.id, revision: deleting.revision }, "字段已删除", () => setDeleting(null))}>
      <p>删除后，该计算字段及其结果将从页面和导出中移除。{deleting?.isPublic ? "其他账号也将无法再使用此公开字段。" : ""}原始库存数据保留。</p>
      {error && <Alert type="error" title={error} showIcon />}
    </Modal>
  </>;
}

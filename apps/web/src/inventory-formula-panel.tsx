import { useMemo, useRef, useState } from "react";
import { Alert, App, Button, Drawer, Input, Space, Table, Typography } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { CalculatorOutlined } from "@ant-design/icons";
import { api, queryClient } from "./api";
import type { Row } from "./shared";
import { evaluateInventoryFormula, inventoryFormulaExample, inventoryFormulaFields, parseInventoryFormula } from "../../../packages/contracts/src/inventory-formula";

export function InventoryFormulaPanel({ records, skuView }: { records: Row[]; skuView: boolean }) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [formula, setFormula] = useState(""), [revision, setRevision] = useState(0);
  const input = useRef<TextAreaRef>(null), selection = useRef({ start: 0, end: 0 });
  const parsed = useMemo(() => {
    if (!formula.trim()) return { node: null, error: "" };
    try { return { node: parseInventoryFormula(formula), error: "" }; }
    catch (error) { return { node: null, error: (error as Error).message }; }
  }, [formula]);
  const load = async () => {
    setLoading(true);
    try {
      const result = (await api("/inventory/calculation-policy")).data;
      setFormula(result.formula ?? ""); setRevision(result.revision);
      selection.current = { start: 0, end: 0 }; setOpen(true);
    } catch (error) { message.error((error as Error).message); }
    finally { setLoading(false); }
  };
  const insert = (token: string) => {
    const { start, end } = selection.current;
    const value = formula.slice(0, start) + token + formula.slice(end);
    setFormula(value);
    selection.current = { start: start + token.length, end: start + token.length };
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.resizableTextArea?.textArea.setSelectionRange(selection.current.start, selection.current.end);
    });
  };
  const save = async () => {
    if (parsed.error) return;
    setSaving(true);
    try {
      await api("/inventory/calculation-policy", "POST", { revision, formula: formula.trim() || null });
      await queryClient.invalidateQueries({ queryKey: ["/inventory/summary"] });
      setOpen(false); message.success(formula.trim() ? "计算公式已保存并重算" : "已停用在仓总库存公式");
    } catch (error) { message.error((error as Error).message); }
    finally { setSaving(false); }
  };
  return <>
    <Button icon={<CalculatorOutlined aria-hidden="true" />} loading={loading} onClick={load}>计算字段配置</Button>
    <Drawer title="计算字段配置" open={open} size={600} onClose={() => !saving && setOpen(false)}
      footer={<Space style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button disabled={saving} onClick={() => setOpen(false)}>取消</Button>
        <Button type="primary" loading={saving} disabled={!!parsed.error} onClick={save}>保存并重算</Button>
      </Space>}>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <div><Typography.Title level={5}>在仓总库存</Typography.Title><Typography.Text type="secondary">显示在“实际库存数”前。配置按当前账号保存，其他账号不受影响。</Typography.Text></div>
        <label htmlFor="inventory-formula">计算公式</label>
        <Input.TextArea id="inventory-formula" aria-label="在仓总库存计算公式" ref={input} value={formula} disabled={saving} rows={4} maxLength={512}
          placeholder="点击下方字段和运算符组合公式，也可直接输入数字和括号"
          onChange={event => { setFormula(event.target.value); selection.current = { start: event.target.selectionStart, end: event.target.selectionEnd }; }}
          onSelect={event => { selection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }; }} />
        {parsed.error && <Alert type="error" showIcon title={parsed.error} />}
        <Space wrap>{inventoryFormulaFields.map(field => <Button key={field.key} disabled={saving} onClick={() => insert(`[${field.label}]`)}>{field.label}</Button>)}</Space>
        <Space wrap>{["+", "-", "×", "÷", "(", ")"].map(operator => <Button key={operator} aria-label={`插入 ${operator}`} disabled={saving} onClick={() => insert(` ${operator} `)}>{operator}</Button>)}
          <Button disabled={saving} onClick={() => { setFormula(""); selection.current = { start: 0, end: 0 }; }}>清空公式</Button>
        </Space>
        <Button type="link" style={{ paddingInline: 0 }} disabled={saving} onClick={() => { setFormula(inventoryFormulaExample); selection.current = { start: inventoryFormulaExample.length, end: inventoryFormulaExample.length }; }}>填入示例：实际库存＋销退仓＋进货仓</Button>
        <Alert type="info" showIcon title="先乘除后加减，括号优先"
          description="先逐商品计算并保留4位小数，再汇总到货号、款号和全部筛选总计。引用字段缺失、除数为0或结果超出范围时显示无法计算，汇总显示不完整。留空保存可停用公式。" />
        {skuView && parsed.node && <div><Typography.Title level={5}>当前页预览</Typography.Title>
          <Table size="small" pagination={false} rowKey="id" dataSource={records.slice(0, 3)} columns={[
            { title: "商品编码", dataIndex: "skuCode" },
            { title: "在仓总库存", render: (_, row) => {
              const result = evaluateInventoryFormula(parsed.node!, row);
              return result == null ? "无法计算" : result.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
            } },
          ]} />
        </div>}
        {!skuView && <Typography.Text type="secondary">切换到条码视图可预览具体商品的计算结果。</Typography.Text>}
      </Space>
    </Drawer>
  </>;
}

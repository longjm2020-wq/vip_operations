import { useState } from "react";
import { Alert, App, Button, Input, Modal, Space, Typography } from "antd";
import { CloseCircleOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { PageSearch, PageSearchInput } from "./page-search";
import { INVENTORY_SEARCH_CODES_LIMIT, inventorySearchCodesSchema, splitInventorySearchCodes } from "../../../packages/contracts/src/inventory-search";

export function InventorySearch({ codes, onSearch }: { codes: string[]; onSearch: (value: string, codes: string[]) => void }) {
  const [value, setValue] = useState(""), [draft, setDraft] = useState(""), [open, setOpen] = useState(false);
  const { message } = App.useApp();
  const parsed = splitInventorySearchCodes(draft);
  const apply = () => {
    const result = inventorySearchCodesSchema.safeParse(parsed);
    if (!result.success) { void message.error(`一次最多查询${INVENTORY_SEARCH_CODES_LIMIT}个编码，每个编码最多100个字符`); return; }
    setValue(""); onSearch("", result.data); setOpen(false);
  };
  return <>
    <PageSearch><PageSearchInput value={value} onChange={event => setValue(event.target.value)}
      placeholder={codes.length ? `已选择 ${codes.length} 个编码` : "商品编码 / 货号 / 款号 / 条码"}
      aria-label="商品编码 / 货号 / 款号 / 条码" autoSearchDelay={500} allowClear maxLength={100}
      onSearch={text => { if (!codes.length || text.trim()) onSearch(text.trim(), []); }}
      onPaste={event => {
        const text = event.clipboardData.getData("text");
        if (splitInventorySearchCodes(text).length > 1) { event.preventDefault(); setDraft(text); setOpen(true); }
      }} suffix={<Space size={0}>
        {!!codes.length && <Button type="text" size="small" icon={<CloseCircleOutlined />} aria-label="清空批量查询" onClick={() => onSearch("", [])} />}
        <Button type="text" size="small" icon={<UnorderedListOutlined />} aria-label="批量查询" title="批量查询" onClick={() => { setDraft(codes.join("\n")); setOpen(true); }}>{codes.length || null}</Button>
      </Space>} /></PageSearch>
    <Modal title="批量查询库存" open={open} onCancel={() => setOpen(false)} onOk={apply} okText="查询" cancelText="取消" width={580} destroyOnHidden>
      <Typography.Paragraph>粘贴款号、货号、商品编码或条码，每行一个，也支持空格、逗号及分号分隔。完整编码精确匹配，任一编码匹配即显示，保留当前周期和状态筛选。</Typography.Paragraph>
      <Input.TextArea aria-label="批量查询编码" placeholder={`每行粘贴一个编码，最多${INVENTORY_SEARCH_CODES_LIMIT}个`} rows={10} value={draft} maxLength={INVENTORY_SEARCH_CODES_LIMIT * 125} onChange={event => setDraft(event.target.value)} />
      <div style={{ margin: "12px 0" }}>去重后 {parsed.length} 个编码 <Button type="link" size="small" onClick={() => setDraft("")}>清空</Button></div>
      {parsed.length > INVENTORY_SEARCH_CODES_LIMIT && <Alert type="error" showIcon title={`一次最多查询${INVENTORY_SEARCH_CODES_LIMIT}个编码，请减少后重试`} />}
      <Typography.Text type="secondary">前导零及长编码按原文保留；重复编码不会重复统计库存。清空后查询可恢复全部结果。</Typography.Text>
    </Modal>
  </>;
}

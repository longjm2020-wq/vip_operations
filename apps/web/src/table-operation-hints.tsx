import type { ReactNode } from "react";
import { InfoCircleOutlined } from "@ant-design/icons";
import { Button, Popover } from "antd";

export function TableOperationHints({ children }: { children: ReactNode }) {
  return <Popover
    title="表格操作提示"
    trigger={["hover", "click"]}
    placement="top"
    content={<div className="table-operation-hints" role="group" aria-label="表格操作说明">{children}</div>}
  >
    <Button className="table-operation-hints-trigger" type="text" size="small" aria-label="表格操作提示" icon={<InfoCircleOutlined />} />
  </Popover>;
}

export function SelectionOperationHints({ canEdit }: { canEdit: boolean }) {
  return <TableOperationHints>
    <p>空白行自动保存。</p>
    <p>拖动可选择多个单元格后填色；Ctrl/Cmd+C 复制、Ctrl/Cmd+V 粘贴。</p>
    <p>点击或拖动行号、表头选择整行整列；Shift 点选表头可选连续多列，右键固定或设置列宽。</p>
    <p>拖动已选行号或表头可整组调序，Shift 拖动也可调序。</p>
    <p>{canEdit ? "图片支持网址、本地上传和粘贴。" : "当前账号仅可查看。"}</p>
  </TableOperationHints>;
}

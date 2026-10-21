import { useState, type ReactNode } from "react";
import { Button, Popover } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";

export function InventorySummaryInfo({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      title="库存统计与补货说明"
      content={<div className="inventory-summary-info">{children}</div>}
      placement="bottomLeft"
      trigger={["hover", "click"]}
      open={open}
      onOpenChange={setOpen}
    >
      <Button
        type="text"
        aria-label="统计与补货说明"
        aria-expanded={open}
        icon={<InfoCircleOutlined />}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      />
    </Popover>
  );
}

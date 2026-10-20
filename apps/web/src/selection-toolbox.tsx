import { lazy, Suspense, useState } from "react";
import { Button, Drawer, Spin, Tooltip } from "antd";
import { ToolOutlined } from "@ant-design/icons";
import { useCan } from "./shared";
import type { MappingTab } from "./color-size-mappings";
import "./selection-toolbox.css";

const ColorSizeMappings = lazy(() => import("./color-size-mappings").then(module => ({ default: module.ColorSizeMappings })));

export function SelectionToolbox() {
  const canReadMappings = useCan("product.read");
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<MappingTab>("color");
  if (!canReadMappings) return null;
  return <>
    <Tooltip title="工具箱">
      <Button aria-label="工具箱" icon={<ToolOutlined aria-hidden />} onClick={() => setOpen(true)} />
    </Tooltip>
    <Drawer
      title="工具箱"
      open={open}
      onClose={() => setOpen(false)}
      size="min(1080px, 100vw)"
      rootClassName="selection-toolbox"
      destroyOnHidden
    >
      <div className="selection-toolbox-heading">
        <strong>颜色尺码映射</strong>
        <span>维护商品共用的颜色与尺码代码。</span>
      </div>
      {open && <Suspense fallback={<div className="selection-toolbox-loading" role="status"><Spin />正在加载映射资料…</div>}>
        <ColorSizeMappings tab={tab} onTabChange={setTab} />
      </Suspense>}
    </Drawer>
  </>;
}

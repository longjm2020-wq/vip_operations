import { lazy, Suspense, useState } from "react";
import { Button, Drawer, Spin } from "antd";
import { FileExcelOutlined, RightOutlined, TagsOutlined, ToolOutlined } from "@ant-design/icons";
import { useCan } from "./shared";
import type { MappingTab } from "./color-size-mappings";
import "./selection-toolbox.css";

const ColorSizeMappings = lazy(() => import("./color-size-mappings").then(module => ({ default: module.ColorSizeMappings })));
const JushuitanTool = lazy(() => import("./jushuitan-tool").then(module => ({ default: module.JushuitanTool })));
const VipRegistrationTool = lazy(() => import("./vip-registration-tool").then(module => ({ default: module.VipRegistrationTool })));

export function SelectionToolbox({ getSelectedIds }: { getSelectedIds: () => Promise<string[]> }) {
  const canReadMappings = useCan("product.read");
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<MappingTab>("color");
  const [tool, setTool] = useState<"mappings" | "jushuitan" | "vip" | null>(null);
  if (!canReadMappings) return null;
  return <>
    <Button aria-label="工具箱" icon={<ToolOutlined aria-hidden />} onClick={() => { setTool(null); setOpen(true); }}>工具箱</Button>
    <Drawer
      title="工具箱"
      open={open}
      onClose={() => { setTool(null); setOpen(false); }}
      size="min(440px, 100vw)"
      rootClassName="selection-toolbox"
      destroyOnHidden
    >
      <nav aria-label="工具箱功能" className="selection-toolbox-menu">
        <button type="button" onClick={() => setTool("mappings")}>
          <TagsOutlined aria-hidden /><span><strong>颜色尺码映射</strong><small>维护商品共用的颜色与尺码代码</small></span><RightOutlined aria-hidden />
        </button>
        <button type="button" onClick={() => setTool("jushuitan")}>
          <FileExcelOutlined aria-hidden /><span><strong>聚水潭商品建档</strong><small>选中款号生成商品资料，预览并导出 Excel</small></span><RightOutlined aria-hidden />
        </button>
        <button type="button" onClick={() => setTool("vip")}>
          <FileExcelOutlined aria-hidden /><span><strong>唯品会商品建档</strong><small>选中款号生成货号与条形码，导出唯品会模板资料</small></span><RightOutlined aria-hidden />
        </button>
      </nav>
      <Drawer
        title={tool === "vip" ? "唯品会商品建档" : tool === "jushuitan" ? "聚水潭商品建档" : "颜色尺码映射"}
        open={open && tool !== null} onClose={() => setTool(null)}
        size="min(1080px, 100vw)" rootClassName="selection-toolbox" destroyOnHidden
      >
        {open && tool && <Suspense fallback={<div className="selection-toolbox-loading" role="status"><Spin />正在加载工具…</div>}>
          {tool === "mappings" ? <ColorSizeMappings tab={tab} onTabChange={setTab} />
            : tool === "vip" ? <VipRegistrationTool getSelectedIds={getSelectedIds} /> : <JushuitanTool getSelectedIds={getSelectedIds} />}
        </Suspense>}
      </Drawer>
    </Drawer>
  </>;
}

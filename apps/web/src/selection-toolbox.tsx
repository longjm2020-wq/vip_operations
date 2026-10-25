import { lazy, Suspense, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Drawer, Spin } from "antd";
import { BulbOutlined, FileExcelOutlined, RightOutlined, SafetyCertificateOutlined, ShareAltOutlined, TagsOutlined, ToolOutlined } from "@ant-design/icons";
import { useCan } from "./shared";
import type { MappingTab } from "./color-size-mappings";
import "./selection-toolbox.css";

const ColorSizeMappings = lazy(() => import("./color-size-mappings").then(module => ({ default: module.ColorSizeMappings })));
const JushuitanTool = lazy(() => import("./jushuitan-tool").then(module => ({ default: module.JushuitanTool })));
const VipRegistrationTool = lazy(() => import("./vip-registration-tool").then(module => ({ default: module.VipRegistrationTool })));

export function SelectionToolbox({ getSelectedIds, onStandardsAi, onTitleAi, titleAiDisabled, onCollections }: {
  getSelectedIds: () => Promise<string[]>;
  onStandardsAi?: () => void;
  onTitleAi?: () => void;
  titleAiDisabled?: boolean;
  onCollections?: () => void;
}) {
  const canReadMappings = useCan("product.read");
  const [open, setOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const [suggested, setSuggested] = useState<string | null>(null);
  const requested = params.get("toolbox");
  const [tab, setTab] = useState<MappingTab>("color");
  const [tool, setTool] = useState<"mappings" | "jushuitan" | "vip" | null>(null);
  useEffect(() => {
    if (requested !== "ai-title" && requested !== "ai-standards") return;
    setSuggested(requested);
    setTool(null);
    setOpen(true);
    setParams(current => { const next = new URLSearchParams(current); next.delete("toolbox"); return next; }, { replace: true });
  }, [requested, setParams]);
  if (!canReadMappings && !onStandardsAi && !onTitleAi && !onCollections) return null;
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
      {suggested && <p className="selection-toolbox-entry-note">从 AI 工作区进入。请先在表格选择需要处理的款式，再打开对应工具；当前尚未发起生成。</p>}
      <nav aria-label="工具箱功能" className="selection-toolbox-menu">
        {onTitleAi && <button type="button" className={suggested === "ai-title" ? "suggested" : undefined} aria-label="AI 商品标题" disabled={titleAiDisabled} onClick={() => { setOpen(false); onTitleAi(); }}>
          <BulbOutlined aria-hidden /><span><strong>AI 商品标题</strong><small>根据商品资料生成、补全和完善长短标题</small></span><RightOutlined aria-hidden />
        </button>}
        {onCollections && <button type="button" aria-label="产品信息收集表" onClick={() => { setOpen(false); onCollections(); }}>
          <ShareAltOutlined aria-hidden /><span><strong>产品信息收集表</strong><small>将选中款式生成收集表，查看和管理填写结果</small></span><RightOutlined aria-hidden />
        </button>}
        {onStandardsAi && <button type="button" className={suggested === "ai-standards" ? "suggested" : undefined} onClick={() => { setOpen(false); onStandardsAi(); }}>
          <SafetyCertificateOutlined aria-hidden /><span><strong>AI 安全类别与执行标准</strong><small>结合图片、成分、三级类目和长标题批量适配</small></span><RightOutlined aria-hidden />
        </button>}
        {canReadMappings && <>
        <button type="button" onClick={() => setTool("mappings")}>
          <TagsOutlined aria-hidden /><span><strong>颜色尺码映射</strong><small>维护商品共用的颜色与尺码代码</small></span><RightOutlined aria-hidden />
        </button>
        <button type="button" onClick={() => setTool("jushuitan")}>
          <FileExcelOutlined aria-hidden /><span><strong>聚水潭商品建档</strong><small>选中款号生成商品资料，预览并导出 Excel</small></span><RightOutlined aria-hidden />
        </button>
        <button type="button" onClick={() => setTool("vip")}>
          <FileExcelOutlined aria-hidden /><span><strong>唯品会商品建档</strong><small>选中款号生成货号与条形码，导出唯品会模板资料</small></span><RightOutlined aria-hidden />
        </button>
        </>}
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

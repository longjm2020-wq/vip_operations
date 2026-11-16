import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Button, Dropdown } from "antd";
import {
  DesktopOutlined,
  EllipsisOutlined,
  GlobalOutlined,
  LeftOutlined,
  RightOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import {
  useAssistantHub,
  type AssistantToolSection,
} from "./assistant-hub-context";
import { useUser } from "./shared";
import "./workspace-columns.css";

export function WorkspaceColumns({ children }: { children: ReactNode }) {
  const hub = useAssistantHub();
  const user = useUser();
  const dock = hub.workbench;
  const container = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  useLayoutEffect(() => {
    const center = container.current?.querySelector(".workspace-center");
    if (!center) return;
    const resize = new ResizeObserver(() =>
      window.dispatchEvent(new Event("xuti-workspace-layout")),
    );
    resize.observe(center);
    return () => resize.disconnect();
  }, [!!dock]);
  const [width, setWidth] = useState(() => {
    try {
      const value = Number(
        localStorage.getItem(`xuti-workspace-right-width:${user.id}`),
      );
      return value >= 26 && value <= 64 ? value : 42;
    } catch {
      return 42;
    }
  });
  const resize = (value: number) => {
    const total = container.current?.clientWidth || 1200;
    const min = Math.min(42, Math.max(26, (320 / total) * 100));
    const max = Math.max(min, Math.min(64, ((total - 380) / total) * 100));
    const next = Math.max(min, Math.min(max, value));
    setWidth(next);
    try {
      localStorage.setItem(
        `xuti-workspace-right-width:${user.id}`,
        String(next),
      );
    } catch {
      /* Retain the in-page width. */
    }
  };
  if (!dock) return children;
  const extra: { key: AssistantToolSection; label: string }[] = [
    { key: "employees", label: "AI 员工" },
    { key: "tasks", label: "任务与文件" },
    { key: "team", label: "团队设置" },
    { key: "activity", label: "动态反馈" },
    { key: "memory", label: "个人记忆" },
    { key: "voice", label: "语音设置" },
    { key: "settings", label: "对话设置" },
  ];
  return (
    <div
      ref={container}
      className="workspace-columns"
      data-tools-open={dock.toolsOpen}
      data-chat-open={dock.chatOpen}
      style={{ "--workspace-right-width": `${width}%` } as CSSProperties}
    >
      <section className="workspace-center" aria-label="工作台中栏">
        {children}
        <div className="workspace-chat-host" ref={dock.registerChat} />
      </section>
      <div
        className="workspace-column-resizer"
        role="separator"
        aria-label="调整中栏与右栏宽度"
        aria-orientation="vertical"
        aria-valuenow={Math.round(width)}
        aria-valuemin={26}
        aria-valuemax={64}
        tabIndex={dock.toolsOpen ? 0 : -1}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (!dragging.current || !container.current) return;
          const rect = container.current.getBoundingClientRect();
          resize(((rect.right - event.clientX) / rect.width) * 100);
        }}
        onPointerUp={(event) => {
          dragging.current = false;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        onLostPointerCapture={() => {
          dragging.current = false;
        }}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          resize(
            event.key === "Home"
              ? 26
              : event.key === "End"
                ? 64
                : width + (event.key === "ArrowLeft" ? 2 : -2),
          );
        }}
      />
      <aside className="workspace-right" aria-label="右侧工具栏">
        <header className="workspace-tools-header" hidden={!dock.toolsOpen}>
          <nav className="workspace-tools-tabs" aria-label="右栏工具">
            <Button
              type="text"
              icon={<GlobalOutlined />}
              aria-label="独立浏览器"
              aria-pressed={dock.tool === "browser"}
              onClick={() => dock.selectTool("browser")}
            >
              独立浏览器
            </Button>
            <Button
              type="text"
              icon={<DesktopOutlined />}
              aria-label="我的电脑"
              aria-pressed={dock.tool === "desktop"}
              onClick={() => dock.selectTool("desktop")}
            >
              我的电脑
            </Button>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: extra,
                selectedKeys: [dock.tool],
                onClick: ({ key }) =>
                  dock.selectTool(key as AssistantToolSection),
              }}
            >
              <Button
                type="text"
                icon={<EllipsisOutlined />}
                aria-label="更多右栏工具"
                title={
                  extra.find((item) => item.key === dock.tool)?.label ||
                  "更多工具"
                }
              />
            </Dropdown>
          </nav>
          <Button
            type="text"
            icon={<RightOutlined />}
            aria-label="收起右侧工具栏"
            onClick={() => dock.setToolsOpen(false)}
          />
        </header>
        <nav
          className="workspace-tools-rail"
          aria-label="已收起的右栏工具"
          hidden={dock.toolsOpen}
        >
          <Button
            type="text"
            icon={<LeftOutlined />}
            aria-label="展开右侧工具栏"
            title="展开右侧工具栏"
            onClick={() => dock.setToolsOpen(true)}
          />
          <Button
            type="text"
            icon={<TeamOutlined />}
            aria-label="展开 AI 员工"
            title="AI 员工"
            onClick={() => dock.openEmployee()}
          />
          <Button
            type="text"
            icon={<GlobalOutlined />}
            aria-label="展开独立浏览器"
            title="独立浏览器"
            onClick={() => dock.selectTool("browser")}
          />
          <Button
            type="text"
            icon={<DesktopOutlined />}
            aria-label="展开我的电脑"
            title="我的电脑"
            onClick={() => dock.selectTool("desktop")}
          />
        </nav>
        <div
          ref={dock.registerTools}
          className="workspace-tools-host"
          hidden={!dock.toolsOpen}
        />
      </aside>
    </div>
  );
}

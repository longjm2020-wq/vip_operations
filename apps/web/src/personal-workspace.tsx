import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  App,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  Modal,
  Space,
  Spin,
  Tag,
} from "antd";
import {
  ArrowDownOutlined,
  ArrowRightOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  LockOutlined,
  PlusOutlined,
  SettingOutlined,
  AppstoreOutlined,
  BarChartOutlined,
  CalendarOutlined,
  CheckOutlined,
  CloseOutlined,
  FileTextOutlined,
  InboxOutlined,
  SaveOutlined,
  TeamOutlined,
  HolderOutlined,
  DragOutlined,
  RotateRightOutlined,
  AimOutlined,
  MinusOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, queryClient } from "./api";
import { QueryState, Row, useUser } from "./shared";
import type { WorkspaceConfig } from "../../../packages/contracts/src/personal-workspace";
import { canUsePersonalAssistant } from "../../../packages/contracts/src/personal-assistant";
import "./personal-workspace.css";
import { PersonalWorkspaceContent } from "./personal-workspace-content";
import { WorkspaceAI } from "./workspace-ai";
import { PersonalSchedule } from "./personal-schedule";
import { useWorkspaceWorld } from "./use-workspace-world";
import { WorkspaceWorldBackdrop } from "./workspace-world-backdrop";
import "./workspace-world.css";

type WorkspacePanel = "tools" | "schedule" | "todos" | "note" | "content";
const panelTitles: Record<WorkspacePanel, string> = {
  tools: "常用工具",
  schedule: "日程",
  todos: "个人待办",
  note: "私有备忘",
  content: "我创建的内容",
};

function WorkspaceOrbit({
  children,
  paused,
  assistantEnabled,
}: {
  children: ReactNode;
  paused: boolean;
  assistantEnabled: boolean;
}) {
  const [slot, setSlot] = useState<Element | null>(null);
  useLayoutEffect(() => {
    setSlot(
      document.querySelector(
        ".workspace-ai-orbit-slot, .workspace-quiet-orbit-slot",
      ),
    );
  }, [assistantEnabled]);
  return slot
    ? createPortal(
        <nav
          className="workspace-dock"
          aria-label="工作台功能面板"
          data-paused={paused}
        >
          <div className="workspace-dock-orbit">{children}</div>
        </nav>,
        slot,
      )
    : null;
}

/** Non-modal work cards share the app's frame-coalesced transform dragging approach. */
function WorkspaceFloatingPanel({
  open,
  title,
  onClose,
  footer,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null),
    handle = useRef<HTMLButtonElement>(null);
  const position = useRef({ x: 0, y: 0 }),
    lastFocus = useRef<HTMLElement | null>(null);
  const opened = useRef(false),
    frame = useRef(0);
  const drag = useRef<{
    id: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    clientX: number;
    clientY: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  } | null>(null);
  const bounds = () => {
    const view = window.visualViewport,
      margin = innerWidth < 768 ? 12 : 24;
    const width = view?.width || innerWidth,
      height = view?.height || innerHeight;
    const left = view?.offsetLeft || 0,
      top = view?.offsetTop || 0;
    box.current!.style.maxHeight = `${height - margin * 2}px`;
    const rect = box.current!.getBoundingClientRect();
    return {
      minX: left + margin,
      maxX: left + Math.max(margin, width - rect.width - margin),
      minY: top + margin,
      maxY: top + Math.max(margin, height - rect.height - margin),
    };
  };
  const place = (x: number, y: number, limits = bounds()) => {
    position.current = {
      x: Math.min(limits.maxX, Math.max(limits.minX, x)),
      y: Math.min(limits.maxY, Math.max(limits.minY, y)),
    };
    box.current?.style.setProperty(
      "transform",
      `translate3d(${position.current.x}px, ${position.current.y}px, 0)`,
    );
  };
  const reset = () => {
    const core = document
      .querySelector(".workspace-ai-core, .workspace-quiet")
      ?.getBoundingClientRect();
    const limits = bounds();
    const topbar =
      document.querySelector(".topbar")?.getBoundingClientRect().bottom || 68;
    const right = core ? core.right + 24 : limits.maxX;
    const left = core
      ? core.left - 24 - box.current!.getBoundingClientRect().width
      : limits.minX;
    place(
      right <= limits.maxX ? right : left >= limits.minX ? left : limits.maxX,
      Math.max(topbar + 24, core?.top || topbar + 24),
      limits,
    );
  };
  const paint = () => {
    frame.current = 0;
    const current = drag.current;
    if (current)
      place(
        current.x + current.clientX - current.startX,
        current.y + current.clientY - current.startY,
        current,
      );
  };
  const stop = () => {
    if (frame.current) {
      cancelAnimationFrame(frame.current);
      paint();
    }
    const current = drag.current;
    drag.current = null;
    box.current?.removeAttribute("data-dragging");
    if (current && handle.current?.hasPointerCapture(current.id))
      handle.current.releasePointerCapture(current.id);
  };
  useLayoutEffect(() => {
    if (!open) {
      stop();
      if (opened.current && lastFocus.current?.isConnected)
        lastFocus.current.focus({ preventScroll: true });
      opened.current = false;
      return;
    }
    if (!opened.current) {
      lastFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      opened.current = true;
      reset();
      handle.current?.focus({ preventScroll: true });
    } else place(position.current.x, position.current.y);
    const align = () => {
      stop();
      place(position.current.x, position.current.y);
    };
    const observer = new ResizeObserver(align);
    if (box.current) observer.observe(box.current);
    window.addEventListener("resize", align);
    window.addEventListener("blur", stop);
    window.visualViewport?.addEventListener("resize", align);
    window.visualViewport?.addEventListener("scroll", align);
    return () => {
      stop();
      observer.disconnect();
      window.removeEventListener("resize", align);
      window.removeEventListener("blur", stop);
      window.visualViewport?.removeEventListener("resize", align);
      window.visualViewport?.removeEventListener("scroll", align);
    };
    // Position and handlers are intentionally ref-driven, so dragging doesn't render the workbench.
  }, [open, title]);
  const start = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    handle.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      ...position.current,
      ...bounds(),
    };
    box.current?.setAttribute("data-dragging", "true");
  };
  return createPortal(
    <div
      ref={box}
      className="personal-workspace-panel"
      hidden={!open}
      role="dialog"
      aria-modal="false"
      aria-labelledby="workspace-panel-title"
      data-floating-panel-owned
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="workspace-panel-header">
        <button
          ref={handle}
          className="workspace-panel-handle"
          type="button"
          aria-label="移动工作台面板"
          title="拖动标题移动卡片；方向键微调，Home 回到初始位置"
          onPointerDown={start}
          onPointerMove={(event) => {
            if (drag.current?.id !== event.pointerId) return;
            drag.current.clientX = event.clientX;
            drag.current.clientY = event.clientY;
            if (!frame.current) frame.current = requestAnimationFrame(paint);
          }}
          onPointerUp={stop}
          onPointerCancel={stop}
          onLostPointerCapture={stop}
          onKeyDown={(event) => {
            const directions: Record<string, [number, number]> = {
              ArrowLeft: [-16, 0],
              ArrowRight: [16, 0],
              ArrowUp: [0, -16],
              ArrowDown: [0, 16],
            };
            if (event.key === "Home") {
              event.preventDefault();
              reset();
            } else if (directions[event.key]) {
              event.preventDefault();
              const [x, y] = directions[event.key];
              place(position.current.x + x, position.current.y + y);
            }
          }}
        >
          <HolderOutlined aria-hidden />
          <span id="workspace-panel-title">{title}</span>
        </button>
        <Button
          type="text"
          icon={<CloseOutlined aria-hidden />}
          aria-label="收起工作台面板"
          onClick={onClose}
        />
      </header>
      <div className="workspace-panel-body">{children}</div>
      <footer className="workspace-panel-footer">{footer}</footer>
    </div>,
    document.body,
  );
}

export function PersonalWorkspacePage() {
  const world = useWorkspaceWorld();
  const user = useUser(),
    { message } = App.useApp(),
    [draft, setDraft] = useState<WorkspaceConfig | null>(null),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [configure, setConfigure] = useState(false),
    [tools, setTools] = useState<string[]>([]),
    [panel, setPanel] = useState<WorkspacePanel>("schedule"),
    [panelOpen, setPanelOpen] = useState(false),
    [visitedPanels, setVisitedPanels] = useState<Set<WorkspacePanel>>(
      new Set(),
    ),
    [title, setTitle] = useState(""),
    [dueDate, setDueDate] = useState("");
  const q = useQuery({
    queryKey: ["personal-workspace", user.id],
    queryFn: () => api("/my-workspace"),
    refetchOnWindowFocus: false,
  });
  const workspace = q.data?.data,
    available: Row[] = workspace?.available || [];
  useEffect(() => {
    if (workspace)
      setDraft({
        shortcuts: workspace.shortcuts,
        note: workspace.note,
        todos: workspace.todos,
        schedule: workspace.schedule || [],
      });
  }, [workspace]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const change = (next: WorkspaceConfig) => {
    setDraft(next);
    setDirty(true);
  };
  const save = async () => {
    if (!draft || !workspace) return;
    setBusy(true);
    try {
      await api("/my-workspace", "POST", {
        ...draft,
        version: workspace.version,
      });
      setDirty(false);
      await q.refetch();
      void queryClient.invalidateQueries({
        queryKey: ["assistant-activity", user.id],
      });
      message.success("个人工作台已保存");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const addTodo = () => {
    if (!draft || !title.trim()) return;
    change({
      ...draft,
      todos: [
        ...draft.todos,
        { id: crypto.randomUUID(), title: title.trim(), done: false, dueDate },
      ],
    });
    setTitle("");
    setDueDate("");
  };
  const move = (index: number, offset: number) => {
    const next = [...tools];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    setTools(next);
  };
  const openPanel = (next: WorkspacePanel) => {
    setVisitedPanels((visited) => new Set(visited).add(next));
    setPanel(next);
    setPanelOpen(true);
  };
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const incomplete = draft?.todos.filter((t) => !t.done) || [],
    overdue = incomplete.filter((t) => t.dueDate && t.dueDate < today);
  const toolIcons: Record<string, React.ReactNode> = {
    analytics: <BarChartOutlined />,
    competitors: <BarChartOutlined />,
    products: <AppstoreOutlined />,
    selection: <FileTextOutlined />,
    inventory: <InboxOutlined />,
    projects: <TeamOutlined />,
    tables: <AppstoreOutlined />,
  };
  return (
    <div
      ref={world.surface}
      className="personal-workspace"
      role="region"
      aria-label="工作台三维场景"
      aria-description="空白处拖动旋转，Shift 加拖动或中键拖动平移，滚轮缩放；聚焦场景后方向键调整，Home 回到中心。"
      tabIndex={0}
    >
      <WorkspaceWorldBackdrop />
      <header className="personal-welcome" data-world-ui>
        <div
          className="workspace-world-controls"
          role="group"
          aria-label="场景视角"
        >
          <button
            type="button"
            aria-label="旋转场景"
            aria-pressed="true"
            data-world-mode-button="rotate"
            title="拖动旋转场景"
            onClick={() => world.mode("rotate")}
          >
            <RotateRightOutlined />
          </button>
          <button
            type="button"
            aria-label="平移场景"
            aria-pressed="false"
            data-world-mode-button="pan"
            title="拖动平移（或 Shift 加拖动）"
            onClick={() => world.mode("pan")}
          >
            <DragOutlined />
          </button>
          <span className="workspace-world-control-divider" aria-hidden />
          <button
            type="button"
            aria-label="缩小场景"
            title="缩小场景"
            onClick={() => world.zoom(1 / 1.15)}
          >
            <MinusOutlined />
          </button>
          <output data-world-scale aria-label="场景缩放">
            100%
          </output>
          <button
            type="button"
            aria-label="放大场景"
            title="放大场景"
            onClick={() => world.zoom(1.15)}
          >
            <PlusOutlined />
          </button>
          <button
            type="button"
            aria-label="回到中心"
            title="回到中心（Home 或双击空白处）"
            onClick={world.reset}
          >
            <AimOutlined />
          </button>
        </div>
        <span className="workspace-date">
          <CalendarOutlined aria-hidden />{" "}
          {new Intl.DateTimeFormat("zh-CN", {
            timeZone: "Asia/Shanghai",
            month: "long",
            day: "numeric",
            weekday: "long",
          }).format(new Date())}
        </span>
      </header>
      <QueryState error={q.error} reload={() => q.refetch()} />
      {q.isLoading && <Spin />}
      {draft && workspace && (
        <>
          <div className="personal-workspace-body">
            <div className="personal-workspace-main">
              {!canUsePersonalAssistant({ permissions: user.permissions }) && (
                <div className="workspace-quiet">
                  <div className="workspace-world-camera">
                    <div className="workspace-world-plane">
                      <div className="workspace-quiet-center">
                        <AppstoreOutlined aria-hidden />
                        <h2>你的工作，随时展开</h2>
                        <p>打开身边的日程、待办与常用工具。</p>
                      </div>
                      <div className="workspace-quiet-orbit-slot" />
                    </div>
                  </div>
                </div>
              )}
              <WorkspaceAI
                available={available}
                schedule={draft.schedule || []}
                onSchedule={(event) => {
                  if (
                    (draft.schedule || []).some(
                      (existing) => existing.id === event.id,
                    )
                  )
                    return;
                  change({
                    ...draft,
                    schedule: [...(draft.schedule || []), event],
                  });
                  openPanel("schedule");
                }}
              />
            </div>
            <WorkspaceOrbit
              paused={panelOpen}
              assistantEnabled={canUsePersonalAssistant({
                permissions: user.permissions,
              })}
            >
              {(
                [
                  {
                    key: "schedule",
                    label: "日程",
                    aria: "打开日程",
                    icon: <CalendarOutlined />,
                    detail: `${(draft.schedule || []).filter((event) => event.date === today).length} 项今日安排`,
                  },
                  {
                    key: "todos",
                    label: "个人待办",
                    aria: "打开个人待办",
                    icon: <CheckOutlined />,
                    detail: `${incomplete.length} 项待完成${overdue.length ? ` · ${overdue.length} 逾期` : ""}`,
                  },
                  {
                    key: "tools",
                    label: "常用工具",
                    aria: "打开常用工具",
                    icon: <AppstoreOutlined />,
                    detail: `${draft.shortcuts.length} 个快捷入口`,
                  },
                  {
                    key: "note",
                    label: "私有备忘",
                    aria: "打开私有备忘",
                    icon: <LockOutlined />,
                    detail: draft.note ? "继续记录" : "记录你的灵感",
                  },
                  ...(user.permissions.includes("project.read")
                    ? [
                        {
                          key: "content",
                          label: "我的内容",
                          aria: "打开我的内容",
                          icon: <FileTextOutlined />,
                          detail: "项目 · 表格 · SOP",
                        },
                      ]
                    : []),
                ] as {
                  key: WorkspacePanel;
                  label: string;
                  aria: string;
                  icon: React.ReactNode;
                  detail: string;
                }[]
              ).map((item, index, items) => (
                <button
                  key={item.key}
                  type="button"
                  className="workspace-dock-item"
                  style={
                    {
                      "--orbit-angle": `${-90 + (index * 360) / items.length}deg`,
                      "--orbit-counter-angle": `${90 - (index * 360) / items.length}deg`,
                      "--orbit-depth": `${[0, 90, -55, 60, -90][index % 5]}px`,
                    } as CSSProperties
                  }
                  aria-label={item.aria}
                  title={`${item.label} · ${item.detail}`}
                  aria-expanded={panelOpen && panel === item.key}
                  onClick={() => openPanel(item.key)}
                >
                  <span className="workspace-dock-face">
                    <span className="workspace-dock-label">
                      <span className="workspace-dock-icon" aria-hidden>
                        {item.icon}
                      </span>
                      <strong>{item.label}</strong>
                    </span>
                  </span>
                </button>
              ))}
            </WorkspaceOrbit>
          </div>
          <WorkspaceFloatingPanel
            title={panelTitles[panel]}
            open={panelOpen}
            onClose={() => setPanelOpen(false)}
            footer={
              <>
                <span role="status">
                  {dirty
                    ? "有未保存的更改，收起面板后仍保留"
                    : panel === "content"
                      ? "内容沿用已有成员与公开范围"
                      : "仅自己可见 · 随账号保存"}
                </span>
                <Button
                  type="primary"
                  aria-label="保存更改"
                  icon={<SaveOutlined />}
                  disabled={!dirty}
                  loading={busy}
                  onClick={save}
                >
                  保存更改
                </Button>
              </>
            }
          >
            {visitedPanels.has("tools") && (
              <section hidden={panel !== "tools"}>
                <Card
                  className="personal-tools-panel"
                  title={
                    <span>
                      <AppstoreOutlined aria-hidden /> 常用工具{" "}
                      <small>{draft.shortcuts.length}</small>
                    </span>
                  }
                  extra={
                    <Button
                      type="text"
                      size="small"
                      icon={<SettingOutlined />}
                      disabled={busy}
                      onClick={() => {
                        setTools([...draft.shortcuts]);
                        setConfigure(true);
                      }}
                    >
                      自定义工具
                    </Button>
                  }
                >
                  <div className="personal-tools">
                    {draft.shortcuts.map((id) => {
                      const tool = available.find((t) => t.id === id);
                      return (
                        tool && (
                          <Link
                            key={id}
                            to={tool.path}
                            className="personal-tool"
                          >
                            <span
                              className={`personal-tool-icon personal-tool-icon-${tool.group}`}
                            >
                              {toolIcons[id] || <AppstoreOutlined />}
                            </span>
                            <div>
                              <strong>{tool.title}</strong>
                              <p>{tool.description}</p>
                            </div>
                            <ArrowRightOutlined
                              aria-hidden="true"
                              className="personal-tool-arrow"
                            />
                          </Link>
                        )
                      );
                    })}
                  </div>
                  {!draft.shortcuts.length && (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="添加常用工具，快速进入已有功能"
                    />
                  )}
                </Card>
              </section>
            )}
            {visitedPanels.has("content") &&
              user.permissions.includes("project.read") && (
                <section hidden={panel !== "content"}>
                  <PersonalWorkspaceContent
                    active={panelOpen && panel === "content"}
                  />
                </section>
              )}
            {visitedPanels.has("schedule") && (
              <section hidden={panel !== "schedule"}>
                <PersonalSchedule
                  events={draft.schedule || []}
                  today={today}
                  busy={busy}
                  onChange={(schedule) => change({ ...draft, schedule })}
                />
              </section>
            )}
            {visitedPanels.has("todos") && (
              <section hidden={panel !== "todos"}>
                <Card
                  title={
                    <span>
                      <CheckOutlined aria-hidden /> 个人待办
                    </span>
                  }
                  extra={
                    <span className="personal-todo-count">
                      {incomplete.length} 待完成
                      {overdue.length > 0 && <em> · {overdue.length} 逾期</em>}
                    </span>
                  }
                >
                  <div className="personal-todo-add">
                    <Input
                      value={title}
                      aria-label="待办事项"
                      placeholder="添加自己的待办事项"
                      maxLength={160}
                      disabled={busy || draft.todos.length >= 200}
                      onChange={(e) => setTitle(e.target.value)}
                      onPressEnter={addTodo}
                    />
                    <Input
                      type="date"
                      value={dueDate}
                      aria-label="待办截止日期"
                      disabled={busy}
                      onChange={(e) => setDueDate(e.target.value)}
                    />
                    <Button
                      icon={<PlusOutlined aria-hidden />}
                      onClick={addTodo}
                      disabled={
                        busy || !title.trim() || draft.todos.length >= 200
                      }
                    >
                      添加
                    </Button>
                  </div>
                  <div className="personal-todos">
                    {draft.todos.map((todo) => (
                      <div
                        className={"personal-todo" + (todo.done ? " done" : "")}
                        key={todo.id}
                      >
                        <Checkbox
                          checked={todo.done}
                          disabled={busy}
                          onChange={(e) =>
                            change({
                              ...draft,
                              todos: draft.todos.map((t) =>
                                t.id === todo.id
                                  ? { ...t, done: e.target.checked }
                                  : t,
                              ),
                            })
                          }
                        >
                          {todo.title}
                        </Checkbox>
                        {todo.dueDate && (
                          <Tag
                            color={
                              !todo.done && todo.dueDate < today
                                ? "volcano"
                                : undefined
                            }
                          >
                            {todo.dueDate}
                          </Tag>
                        )}
                        <Button
                          type="text"
                          icon={<DeleteOutlined />}
                          aria-label={`删除待办 ${todo.title}`}
                          disabled={busy}
                          onClick={() =>
                            change({
                              ...draft,
                              todos: draft.todos.filter(
                                (t) => t.id !== todo.id,
                              ),
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                  {!draft.todos.length && (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="暂无个人待办"
                    />
                  )}
                  <small className="secondary">
                    个人待办仅自己可见。项目任务请在项目协作中查看。
                  </small>
                </Card>
              </section>
            )}
            {visitedPanels.has("note") && (
              <section hidden={panel !== "note"}>
                <Card
                  title="私有备忘"
                  extra={<LockOutlined aria-label="仅自己可见" />}
                >
                  <Input.TextArea
                    aria-label="私有备忘"
                    value={draft.note}
                    onChange={(e) => change({ ...draft, note: e.target.value })}
                    placeholder="记录工作思路、提醒或备忘…"
                    maxLength={4000}
                    showCount
                    rows={4}
                    disabled={busy}
                  />
                  <p className="secondary">
                    保存后随账号同步，其他用户及管理员的工作台不会显示这份内容。
                  </p>
                </Card>
              </section>
            )}
          </WorkspaceFloatingPanel>
        </>
      )}
      <Modal
        title="自定义常用工具"
        open={configure}
        onCancel={() => setConfigure(false)}
        onOk={() => {
          if (draft) change({ ...draft, shortcuts: tools });
          setConfigure(false);
        }}
        okText="应用"
        cancelText="取消"
      >
        <p className="secondary">选择已有权限的工具，并调整显示顺序。</p>
        <Checkbox.Group
          value={tools}
          onChange={(values) =>
            setTools([
              ...tools.filter((id) => values.includes(id)),
              ...values.map(String).filter((id) => !tools.includes(id)),
            ])
          }
          className="personal-tool-options"
          options={available.map((tool) => ({
            label: tool.title,
            value: tool.id,
          }))}
        />
        <div className="personal-tool-order">
          {tools.map((id, index) => (
            <div key={id}>
              <span>
                {index + 1}. {available.find((tool) => tool.id === id)?.title}
              </span>
              <Space>
                <Button
                  size="small"
                  icon={<ArrowUpOutlined />}
                  aria-label={`上移 ${available.find((t) => t.id === id)?.title}`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                />
                <Button
                  size="small"
                  icon={<ArrowDownOutlined />}
                  aria-label={`下移 ${available.find((t) => t.id === id)?.title}`}
                  disabled={index === tools.length - 1}
                  onClick={() => move(index, 1)}
                />
              </Space>
            </div>
          ))}
        </div>
        <Button type="link" onClick={() => setTools(workspace.defaults.tools)}>
          恢复角色默认工具
        </Button>
      </Modal>
    </div>
  );
}

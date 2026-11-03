import { useEffect, useState } from "react";
import {
  App,
  Button,
  Card,
  Checkbox,
  Drawer,
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

type WorkspacePanel = "tools" | "schedule" | "todos" | "note" | "content";
const panelTitles: Record<WorkspacePanel, string> = {
  tools: "常用工具",
  schedule: "日程",
  todos: "个人待办",
  note: "私有备忘",
  content: "我创建的内容",
};

export function PersonalWorkspacePage() {
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
    <div className="personal-workspace">
      <header className="personal-welcome">
        <div>
          <div className="personal-eyebrow">
            XUTI <span>/</span> PERSONAL WORKSPACE
          </div>
          <h1>
            {user.displayName} 的工作台
            <span className="welcome-star" aria-hidden>
              ✦
            </span>
          </h1>
          <p>把注意力留给当下，让小序连接你的工作。</p>
        </div>
        <div className="personal-welcome-actions">
          <span className="workspace-date">
            <CalendarOutlined aria-hidden />{" "}
            {new Intl.DateTimeFormat("zh-CN", {
              timeZone: "Asia/Shanghai",
              month: "long",
              day: "numeric",
              weekday: "long",
            }).format(new Date())}
          </span>
          <Space wrap>
            {dirty && (
              <span className="personal-unsaved" role="status">
                有未保存的更改
              </span>
            )}
            <Button
              type="primary"
              icon={<SaveOutlined aria-hidden />}
              onClick={save}
              loading={busy}
              disabled={!draft || !dirty}
            >
              保存工作台
            </Button>
          </Space>
        </div>
      </header>
      <QueryState error={q.error} reload={() => q.refetch()} />
      {q.isLoading && <Spin />}
      {draft && workspace && (
        <>
          <div className="personal-workspace-body">
            <div className="personal-workspace-main">
              {!canUsePersonalAssistant({ permissions: user.permissions }) && (
                <div className="workspace-quiet">
                  <AppstoreOutlined aria-hidden />
                  <h2>你的工作，随时展开</h2>
                  <p>从下方入口打开日程、待办和常用工具。</p>
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
            <nav className="workspace-dock" aria-label="工作台功能面板">
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
              ).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="workspace-dock-item"
                  aria-label={item.aria}
                  aria-expanded={panelOpen && panel === item.key}
                  onClick={() => openPanel(item.key)}
                >
                  <span className="workspace-dock-icon" aria-hidden>
                    {item.icon}
                  </span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.detail}</small>
                  </span>
                  <ArrowRightOutlined
                    className="workspace-dock-arrow"
                    aria-hidden
                  />
                </button>
              ))}
            </nav>
          </div>
          <Drawer
            title={panelTitles[panel]}
            open={panelOpen}
            onClose={() => setPanelOpen(false)}
            closable={false}
            width={panel === "content" ? 920 : panel === "tools" ? 740 : 520}
            rootClassName="personal-workspace-drawer"
            extra={
              <Button
                type="text"
                icon={<CloseOutlined />}
                aria-label="收起工作台面板"
                onClick={() => setPanelOpen(false)}
              />
            }
            footer={
              <div className="workspace-panel-footer">
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
              </div>
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
          </Drawer>
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

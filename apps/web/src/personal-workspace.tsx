import { useEffect, useState } from "react";
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
  FileTextOutlined,
  InboxOutlined,
  SaveOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "./api";
import { QueryState, Row, useUser } from "./shared";
import type { WorkspaceConfig } from "../../../packages/contracts/src/personal-workspace";
import "./personal-workspace.css";
import { PersonalWorkspaceContent } from "./personal-workspace-content";
import { WorkspaceAI } from "./workspace-ai";
import { PersonalSchedule } from "./personal-schedule";

export function PersonalWorkspacePage() {
  const user = useUser(),
    { message } = App.useApp(),
    [draft, setDraft] = useState<WorkspaceConfig | null>(null),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [configure, setConfigure] = useState(false),
    [tools, setTools] = useState<string[]>([]),
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
            YOUR WORKSPACE <span>/</span> 我的工作台
          </div>
          <h1>
            {user.displayName}，欢迎回来
            <span className="welcome-star" aria-hidden>
              ✦
            </span>
          </h1>
          <p>聚焦今天的重要事项，余下的交给你的助理。</p>
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
                }}
              />
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
                        <Link key={id} to={tool.path} className="personal-tool">
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
              <PersonalWorkspaceContent />
            </div>
            <div className="personal-lower">
              <PersonalSchedule
                events={draft.schedule || []}
                today={today}
                busy={busy}
                onChange={(schedule) => change({ ...draft, schedule })}
              />
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
                    icon={<PlusOutlined />}
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
                            todos: draft.todos.filter((t) => t.id !== todo.id),
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
            </div>
          </div>
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

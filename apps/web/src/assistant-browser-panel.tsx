import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  Alert,
  App,
  Button,
  Dropdown,
  Empty,
  Input,
  Space,
  Tag,
  Tooltip,
} from "antd";
import {
  ArrowUpOutlined,
  CloseOutlined,
  ExpandOutlined,
  CompressOutlined,
  GlobalOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  browserStatusLabels,
  browserUrlSchema,
  type BrowserFrame,
  type BrowserManualAction,
  type BrowserState,
  type BrowserTask,
} from "../../../packages/contracts/src/assistant-browser";
import { api } from "./api";
import "./assistant-browser.css";

export const isActiveBrowserTask = (task: BrowserTask) =>
  ["QUEUED", "RUNNING", "PAUSED", "NEEDS_USER"].includes(task.status);

export function AssistantBrowserTaskCard({
  task,
  refresh,
  inspect,
  compact = false,
  inline = false,
}: {
  task: BrowserTask;
  refresh: () => Promise<unknown>;
  inspect?: () => void;
  compact?: boolean;
  inline?: boolean;
}) {
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const operation = useRef(false);
  const control = async (action: "pause" | "resume" | "stop") => {
    if (operation.current) return;
    operation.current = true;
    setPending(action);
    setError("");
    try {
      await api(
        `/my-workspace/assistant/browser/tasks/${task.id}/control`,
        "POST",
        { action },
      );
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      operation.current = false;
      setPending("");
    }
  };
  if (inline)
    return (
      <section
        className="assistant-browser-status"
        aria-label={`浏览器任务：${task.instruction}`}
        data-browser-task-id={task.id}
      >
        <div className="assistant-browser-status-text" role="status">
          <span>{browserStatusLabels[task.status]}</span>
          <span title={task.stage}>{task.stage}</span>
          <small>{task.step} 步</small>
        </div>
        {isActiveBrowserTask(task) && (
          <Space size={4}>
            {task.status === "RUNNING" && (
              <Button
                size="small"
                type="text"
                icon={<PauseOutlined />}
                aria-label="暂停浏览器任务"
                disabled={!!pending}
                loading={pending === "pause"}
                onClick={() => void control("pause")}
              >
                暂停
              </Button>
            )}
            {["PAUSED", "NEEDS_USER"].includes(task.status) && (
              <Button
                size="small"
                type="text"
                icon={<PlayCircleOutlined />}
                aria-label="继续浏览器任务"
                disabled={!!pending}
                loading={pending === "resume"}
                onClick={() => void control("resume")}
              >
                继续
              </Button>
            )}
            <Button
              size="small"
              type="text"
              icon={<StopOutlined />}
              aria-label="停止浏览器任务"
              disabled={!!pending}
              loading={pending === "stop"}
              onClick={() => void control("stop")}
            >
              停止
            </Button>
          </Space>
        )}
        {error && <Alert type="error" showIcon title={error} />}
      </section>
    );
  return (
    <section
      className={`assistant-browser-task${compact ? " assistant-browser-task-compact" : ""}`}
      aria-label={`浏览器任务：${task.instruction}`}
      data-browser-task-id={task.id}
    >
      <div className="assistant-browser-task-heading">
        <Tag
          color={
            task.status === "RUNNING"
              ? "processing"
              : ["PAUSED", "NEEDS_USER"].includes(task.status)
                ? "warning"
                : task.status === "DONE"
                  ? "success"
                  : undefined
          }
        >
          {browserStatusLabels[task.status]}
        </Tag>
        <strong>{task.instruction}</strong>
      </div>
      <p role="status">{task.stage}</p>
      <div className="assistant-browser-task-meta">
        小序独立浏览器 · 已执行 {task.step} 步 ·{" "}
        <time dateTime={task.updatedAt}>
          更新于 {new Date(task.updatedAt).toLocaleTimeString("zh-CN")}
        </time>
      </div>
      {task.title && <p className="assistant-browser-location">{task.title}</p>}
      {task.url && <p className="assistant-browser-location">{task.url}</p>}
      <Space wrap>
        {inspect && (
          <Button size="small" onClick={inspect}>
            {task.status === "DONE"
              ? "查看最终画面"
              : isActiveBrowserTask(task)
                ? "查看画面与接管"
                : "查看任务详情"}
          </Button>
        )}
        {isActiveBrowserTask(task) && (
          <>
            {task.status === "RUNNING" && (
              <Button
                size="small"
                disabled={!!pending}
                loading={pending === "pause"}
                onClick={() => void control("pause")}
              >
                暂停浏览器任务
              </Button>
            )}
            {["PAUSED", "NEEDS_USER"].includes(task.status) && (
              <Button
                size="small"
                type="primary"
                disabled={!!pending}
                loading={pending === "resume"}
                onClick={() => void control("resume")}
              >
                继续浏览器任务
              </Button>
            )}
            <Button
              size="small"
              disabled={!!pending}
              loading={pending === "stop"}
              onClick={() => void control("stop")}
            >
              停止浏览器任务
            </Button>
          </>
        )}
      </Space>
      {error && <Alert type="error" showIcon title={error} />}
    </section>
  );
}

function BrowserTakeover({
  task,
  owner,
  refresh,
}: {
  task: BrowserTask;
  owner: string;
  refresh: () => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [submittedFrame, setSubmittedFrame] = useState("");
  const operation = useRef(false);
  const lifecycle = useRef({ mounted: true, epoch: 0 });
  useEffect(() => {
    lifecycle.current.mounted = true;
    return () => {
      lifecycle.current.mounted = false;
      lifecycle.current.epoch++;
    };
  }, []);
  const frame = useQuery({
    queryKey: ["assistant-browser-frame", owner, task.id, task.status],
    queryFn: async ({ signal }) =>
      (
        await api(
          `/my-workspace/assistant/browser/tasks/${task.id}/frame`,
          "GET",
          undefined,
          undefined,
          { signal },
        )
      ).data as BrowserFrame | null,
    refetchInterval: isActiveBrowserTask(task) && !pending ? 1500 : false,
    staleTime: 0,
    gcTime: 0,
  });
  const manual =
    ["PAUSED", "NEEDS_USER"].includes(task.status) &&
    frame.data?.readOnly !== true;
  const usable =
    manual &&
    !!frame.data &&
    !frame.error &&
    frame.data.frameId !== submittedFrame &&
    !pending;
  const readOnlyNote =
    "任务已结束，执行页面已关闭。最终画面仅供查看" +
    (frame.data?.expiresAt
      ? `，保留至 ${new Date(frame.data.expiresAt).toLocaleString("zh-CN")}`
      : "");
  const send = async (action: BrowserManualAction) => {
    const currentFrame = frame.data;
    if (
      !manual ||
      !currentFrame ||
      currentFrame.frameId === submittedFrame ||
      operation.current
    )
      return;
    operation.current = true;
    setPending(true);
    setError("");
    setNote("");
    const epoch = lifecycle.current.epoch;
    const current = () =>
      lifecycle.current.mounted && lifecycle.current.epoch === epoch;
    try {
      await api(
        `/my-workspace/assistant/browser/tasks/${task.id}/actions`,
        "POST",
        {
          requestId: crypto.randomUUID(),
          frameId: currentFrame.frameId,
          epoch: currentFrame.epoch,
          action,
        },
      );
      if (!current()) return;
      setSubmittedFrame(currentFrame.frameId);
      if (action.kind === "type") setText("");
      setNote("操作已提交，等待更新画面。");
      await Promise.all([frame.refetch(), refresh()]);
    } catch (cause) {
      if (!current()) return;
      setError((cause as Error).message);
      // A stale frame is never retried against a different page automatically.
      await frame.refetch();
    } finally {
      if (current()) {
        operation.current = false;
        setPending(false);
      }
    }
  };
  const click = (event: MouseEvent<HTMLButtonElement>) => {
    if (!usable || event.detail === 0) return;
    const image = event.currentTarget.querySelector("img");
    if (!image) return;
    const rect = image.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 1000;
    const y = ((event.clientY - rect.top) / rect.height) * 1000;
    if (x < 0 || y < 0 || x > 1000 || y > 1000) return;
    void send({ kind: "click", x: Math.round(x), y: Math.round(y) });
  };
  return (
    <section
      className="assistant-browser-takeover"
      aria-label="独立浏览器画面与接管"
    >
      <div
        className="assistant-browser-address"
        title={frame.data?.url || task.url}
        aria-label="当前网页地址"
      >
        <GlobalOutlined aria-hidden />
        <span>{frame.data?.url || task.url || "正在打开网页…"}</span>
        {(task.status === "DONE" || frame.data?.readOnly) && (
          <Tooltip title={readOnlyNote} trigger={["hover", "focus"]}>
            <span
              className="assistant-browser-readonly"
              tabIndex={0}
              aria-label="最终画面只读"
              aria-description={readOnlyNote}
              title={readOnlyNote}
            >
              只读
            </span>
          </Tooltip>
        )}
      </div>
      {(isActiveBrowserTask(task) || task.status === "FAILED") && (
        <AssistantBrowserTaskCard task={task} refresh={refresh} inline />
      )}
      <div className="assistant-browser-page">
        {frame.error && <Alert type="warning" title={frame.error.message} />}
        {frame.data ? (
          <button
            type="button"
            className="assistant-browser-screen"
            aria-label="点击独立浏览器画面"
            disabled={!usable}
            onClick={click}
            title={
              manual
                ? "点击画面中的位置；键盘用户可使用下方 Tab 与 Enter 按键"
                : task.status === "DONE" || frame.data.readOnly
                  ? "最终画面仅供查看，不能操作"
                  : "请先暂停任务再操作"
            }
          >
            <img
              src={frame.data.image}
              width={frame.data.width}
              height={frame.data.height}
              alt="小序独立浏览器当前截图"
              draggable={false}
            />
          </button>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              frame.isPending
                ? "正在获取浏览器画面…"
                : task.status === "DONE"
                  ? "没有可查看的最终画面，可能已过期或已清除。"
                  : isActiveBrowserTask(task)
                    ? "暂无画面，等待浏览器打开网页后刷新。"
                    : "任务已结束，没有保留画面。"
            }
          />
        )}
      </div>
      {manual && (
        <div className="assistant-browser-manual">
          <label
            className="assistant-browser-input-label"
            htmlFor={`browser-input-${task.id}`}
          >
            向当前焦点输入文字
          </label>
          <div className="assistant-browser-manual-compose">
            <Input.Password
              id={`browser-input-${task.id}`}
              autoComplete="off"
              value={text}
              maxLength={2000}
              disabled={!usable}
              onChange={(event) => setText(event.target.value)}
              placeholder="先点击网页输入框，再填写内容"
              onPressEnter={() => {
                if (text) void send({ kind: "type", text });
              }}
            />
            <Button
              type="primary"
              size="small"
              icon={<ArrowUpOutlined />}
              aria-label="输入到浏览器"
              disabled={!usable || !text}
              loading={pending}
              onClick={() => void send({ kind: "type", text })}
            >
              输入
            </Button>
          </div>
          <Space wrap>
            {(
              [
                ["TAB", "Tab 下一个"],
                ["SHIFT_TAB", "Shift+Tab 上一个"],
                ["ENTER", "Enter 确认"],
                ["CTRL_A", "全选"],
                ["BACKSPACE", "退格"],
                ["ESC", "Esc 关闭"],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                size="small"
                disabled={!usable}
                onClick={() => void send({ kind: "key", key })}
              >
                {label}
              </Button>
            ))}
            <Button
              size="small"
              disabled={!usable}
              onClick={() =>
                void send({ kind: "scroll", direction: "up", amount: 2 })
              }
            >
              向上滚动
            </Button>
            <Button
              size="small"
              disabled={!usable}
              onClick={() =>
                void send({ kind: "scroll", direction: "down", amount: 2 })
              }
            >
              向下滚动
            </Button>
          </Space>
        </div>
      )}
      {manual && error && <Alert type="error" showIcon title={error} />}
      {manual && note && <p role="status">{note}</p>}
    </section>
  );
}

export function AssistantBrowserPanel({
  open,
  owner,
  data,
  error,
  refresh,
  choose,
  disabled,
  selectedId,
  selectTask,
  returnToChat,
  expanded,
  toggleExpanded,
  onStarted,
  onSubmitting,
  embedded = false,
}: {
  open: boolean;
  owner: string;
  data?: BrowserState;
  error?: string;
  refresh: () => Promise<unknown>;
  choose: () => void;
  disabled: boolean;
  selectedId?: string;
  selectTask: (id: string) => void;
  returnToChat: () => void;
  expanded: boolean;
  toggleExpanded: () => void;
  onStarted: (task: BrowserTask) => void;
  onSubmitting: (value: boolean) => void;
  embedded?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { modal, message } = App.useApp();
  const queryClient = useQueryClient();
  const [clearing, setClearing] = useState(false);
  const [newTab, setNewTab] = useState(false);
  const [address, setAddress] = useState("");
  const [starting, setStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const [startError, setStartError] = useState("");
  const startingRef = useRef(false);
  const request = useRef<{ value: string; id: string } | null>(null);
  useEffect(() => setNewTab(false), [selectedId]);
  const clearDialog = useRef<{ destroy: () => void } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearDialog.current?.destroy();
      onSubmitting(false);
    };
  }, [onSubmitting]);
  useLayoutEffect(() => {
    if (open) {
      const scroller = ref.current?.querySelector<HTMLElement>(
        ".assistant-browser-content",
      );
      if (scroller) scroller.scrollTop = 0;
    }
  }, [open, selectedId, newTab]);
  const tasks = data?.tasks || [];
  const selectedTask =
    tasks.find((entry) => entry.id === selectedId) ||
    tasks.find(isActiveBrowserTask) ||
    tasks[0];
  const task = newTab ? undefined : selectedTask;
  const activeTask = tasks.find(isActiveBrowserTask);
  const refreshAll = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await Promise.all([
        refresh(),
        ...(task
          ? [
              queryClient.invalidateQueries({
                queryKey: ["assistant-browser-frame", owner, task.id],
              }),
            ]
          : []),
      ]);
    } catch (cause) {
      if (mounted.current) message.error((cause as Error).message);
    } finally {
      refreshingRef.current = false;
      if (mounted.current) setRefreshing(false);
    }
  };
  const start = async () => {
    const value = address.trim();
    if (
      value.length < 2 ||
      disabled ||
      !data?.ready ||
      activeTask ||
      startingRef.current
    )
      return;
    setStartError("");
    let url: string | undefined;
    const looksLikeUrl =
      /^[a-z][a-z\d+.-]*:/i.test(value) ||
      /^\S+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value);
    if (looksLikeUrl) {
      const parsed = browserUrlSchema.safeParse(
        /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`,
      );
      if (!parsed.success) {
        setStartError(
          "请填写不含账号密码的公开 HTTP/HTTPS 网址，或描述要完成的网页任务。",
        );
        return;
      }
      url = parsed.data;
    }
    if (request.current?.value !== value)
      request.current = { value, id: crypto.randomUUID() };
    startingRef.current = true;
    setStarting(true);
    onSubmitting(true);
    try {
      const created = (
        await api("/my-workspace/assistant/browser/tasks", "POST", {
          requestId: request.current.id,
          instruction: url ? `打开 ${url}，查看网页标题后完成任务。` : value,
          ...(url ? { url } : {}),
        })
      ).data as BrowserTask;
      if (!mounted.current) return;
      queryClient.setQueryData<BrowserState>(
        ["assistant-browser", owner],
        (previous) =>
          previous
            ? {
                ...previous,
                tasks: [
                  created,
                  ...previous.tasks.filter((entry) => entry.id !== created.id),
                ],
              }
            : previous,
      );
      setAddress("");
      request.current = null;
      setNewTab(false);
      onStarted(created);
      await refresh();
    } catch (cause) {
      if (mounted.current) setStartError((cause as Error).message);
    } finally {
      startingRef.current = false;
      if (mounted.current) {
        setStarting(false);
        onSubmitting(false);
      }
    }
  };
  const clear = () => {
    clearDialog.current = modal.confirm({
      title: "清除独立浏览器登录状态？",
      content:
        "将停止当前浏览器任务，并清除已保存的网站登录状态与任务截图。之后需要重新登录这些网站。",
      okText: "清除并停止",
      cancelText: "保留",
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!mounted.current) return;
        setClearing(true);
        try {
          await api(
            "/my-workspace/assistant/browser/session/clear",
            "POST",
            {},
          );
          if (!mounted.current) return;
          queryClient.setQueriesData(
            { queryKey: ["assistant-browser-frame", owner] },
            null,
          );
          await refresh();
          if (mounted.current) message.success("已清除保存的浏览器登录状态");
        } finally {
          if (mounted.current) setClearing(false);
        }
      },
    });
  };
  return (
    <div className="assistant-browser-panel" ref={ref}>
      <div className="assistant-browser-tabbar">
        <div
          className="assistant-browser-tab"
          title={task?.title || task?.instruction || "新任务"}
        >
          <Dropdown
            trigger={["click"]}
            menu={{
              className: "assistant-browser-menu",
              selectedKeys: task ? [`task:${task.id}`] : [],
              items: [
                {
                  key: "history",
                  type: "group",
                  label: "最近任务",
                  children: tasks.length
                    ? tasks.map((entry) => ({
                        key: `task:${entry.id}`,
                        label: (
                          <span title={entry.instruction}>
                            {browserStatusLabels[entry.status]} ·{" "}
                            {entry.instruction}
                          </span>
                        ),
                      }))
                    : [{ key: "empty", label: "暂无历史任务", disabled: true }],
                },
                { type: "divider" },
                {
                  key: "choose",
                  label: "在对话中使用浏览器",
                  disabled: disabled || !data?.ready,
                },
                ...(!embedded
                  ? [
                      {
                        key: "expand",
                        className: "assistant-browser-menu-expand",
                        icon: expanded ? (
                          <CompressOutlined />
                        ) : (
                          <ExpandOutlined />
                        ),
                        label: expanded ? "恢复分栏" : "展开浏览器",
                      },
                    ]
                  : []),
                { type: "divider" },
                {
                  key: "session",
                  disabled: true,
                  label: data?.profile?.hasSavedSession
                    ? "已保存网页登录状态"
                    : "尚未保存网页登录状态",
                },
                {
                  key: "clear",
                  label: "清除浏览器登录状态",
                  danger: true,
                  disabled: disabled || clearing || !data?.profile,
                },
              ],
              onClick: ({ key }) => {
                if (key.startsWith("task:")) {
                  setNewTab(false);
                  selectTask(key.slice(5));
                } else if (key === "choose") choose();
                else if (key === "expand") toggleExpanded();
                else if (key === "clear") clear();
              },
            }}
          >
            <Button
              type="text"
              size="small"
              className="assistant-browser-tab-label"
              icon={<GlobalOutlined />}
              aria-label="浏览器标签与会话菜单"
              title="查看最近任务和浏览器登录状态"
            >
              {task?.title || (task ? "网页任务" : "新任务")}
            </Button>
          </Dropdown>
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined />}
            aria-label={embedded ? "关闭浏览器面板" : "返回对话"}
            title="收起浏览器，任务继续保留"
            onClick={returnToChat}
          />
        </div>
        <Button
          type="text"
          size="small"
          icon={<PlusOutlined />}
          aria-label="新建浏览器任务"
          title="新建任务"
          onClick={() => setNewTab(true)}
        />
        <div className="assistant-browser-window-actions">
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined />}
            aria-label="刷新浏览器状态"
            title="刷新网页画面与任务状态"
            loading={refreshing}
            onClick={() => void refreshAll()}
          />
        </div>
      </div>
      <div className="assistant-browser-content">
        {task ? (
          <>
            {open && (
              <BrowserTakeover
                key={task.id}
                task={task}
                owner={owner}
                refresh={refresh}
              />
            )}
          </>
        ) : (
          <div className="assistant-browser-start">
            <form
              className="assistant-browser-search"
              onSubmit={(event) => {
                event.preventDefault();
                void start();
              }}
            >
              <GlobalOutlined aria-hidden />
              <Input
                variant="borderless"
                aria-label="网址或网页任务"
                placeholder="输入网址或描述网页任务"
                maxLength={4000}
                value={address}
                disabled={disabled || starting || !data?.ready || !!activeTask}
                onChange={(event) => setAddress(event.target.value)}
              />
              <Button
                type="primary"
                shape="circle"
                htmlType="submit"
                icon={<ArrowUpOutlined />}
                aria-label="开始浏览器任务"
                loading={starting}
                disabled={
                  disabled ||
                  !data?.ready ||
                  !!activeTask ||
                  address.trim().length < 2
                }
              />
            </form>
            {activeTask && (
              <p className="assistant-browser-start-note">
                当前有未结束的任务，请先继续或停止。
                <Button
                  type="link"
                  size="small"
                  onClick={() => {
                    setNewTab(false);
                    selectTask(activeTask.id);
                  }}
                >
                  查看当前任务
                </Button>
              </p>
            )}
            {startError && <Alert type="error" showIcon title={startError} />}
          </div>
        )}
        {(!data?.ready || error) && (
          <Alert
            type="warning"
            showIcon
            title={error || data?.note || "正在核对独立浏览器…"}
          />
        )}
      </div>
    </div>
  );
}

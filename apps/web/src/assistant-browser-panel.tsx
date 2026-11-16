import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { Alert, App, Button, Empty, Input, Select, Space, Tag } from "antd";
import {
  ArrowUpOutlined,
  CloseOutlined,
  ExpandOutlined,
  CompressOutlined,
  GlobalOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
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
}: {
  task: BrowserTask;
  refresh: () => Promise<unknown>;
  inspect?: () => void;
  compact?: boolean;
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
      setNote(
        "操作已提交，请查看更新后的画面。完成接管后点击「继续浏览器任务」。",
      );
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
      <div className="assistant-browser-heading">
        <h4>{task.status === "DONE" ? "完成时画面" : "浏览器画面"}</h4>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={frame.isFetching}
          disabled={pending}
          onClick={() => void frame.refetch()}
        >
          刷新画面
        </Button>
      </div>
      <div
        className="assistant-browser-address"
        title={frame.data?.url || task.url}
      >
        <GlobalOutlined aria-hidden />
        <span>{frame.data?.url || task.url || "正在打开网页…"}</span>
      </div>
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
                  : "暂无画面，等待浏览器打开网页后刷新。"
            }
          />
        )}
      </div>
      <p>
        {manual
          ? "任务已让出控制。点击画面定位后输入文字，或使用下方按键操作；登录、验证码等需要你完成。"
          : isActiveBrowserTask(task)
            ? "小序正在操作。需要登录或手动处理时，先暂停任务，再在这里接管。"
            : "此任务已结束，最终画面仅供查看。"}{" "}
        这里是定期更新的截图。
      </p>
      {frame.data ? (
        <>
          {frame.data.readOnly && (
            <p className="assistant-browser-location">
              最终画面仅供查看
              {frame.data.expiresAt
                ? `，保留至 ${new Date(frame.data.expiresAt).toLocaleString("zh-CN")}`
                : ""}
              。执行页面已关闭，下一条任务可复用已保存的登录状态。
            </p>
          )}
        </>
      ) : null}
      {manual && (
        <div className="assistant-browser-manual">
          <label htmlFor={`browser-input-${task.id}`}>向当前焦点输入文字</label>
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
            aria-label="输入到浏览器"
            disabled={!usable || !text}
            loading={pending}
            onClick={() => void send({ kind: "type", text })}
          >
            输入到浏览器
          </Button>
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
      {error && <Alert type="error" showIcon title={error} />}
      {note && <p role="status">{note}</p>}
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
        "将停止当前浏览器任务，并清除该账号已保存的网站登录状态。之后需要重新登录这些网站。",
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
          <GlobalOutlined aria-hidden />
          <span>{task?.title || (task ? "网页任务" : "新任务")}</span>
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
            title="刷新状态"
            onClick={() => void refresh()}
          />
          <Button
            type="text"
            size="small"
            className="assistant-browser-expand"
            icon={expanded ? <CompressOutlined /> : <ExpandOutlined />}
            aria-label={expanded ? "恢复分栏" : "展开浏览器"}
            title={expanded ? "恢复分栏" : "展开浏览器"}
            onClick={toggleExpanded}
          />
        </div>
      </div>
      <div className="assistant-browser-content">
        <div className="assistant-browser-toolbar">
          <h3>小序独立浏览器</h3>
          {!!tasks.length && (
            <Select
              className="assistant-browser-task-select"
              aria-label="选择浏览器任务"
              value={task?.id}
              placeholder="最近任务"
              onChange={(id) => {
                setNewTab(false);
                selectTask(id);
              }}
              options={tasks.map((entry) => ({
                value: entry.id,
                label: `${browserStatusLabels[entry.status]} · ${entry.instruction}`,
              }))}
            />
          )}
        </div>
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
            <AssistantBrowserTaskCard task={task} refresh={refresh} />
          </>
        ) : (
          <div className="assistant-browser-start">
            <div className="assistant-browser-welcome">
              <GlobalOutlined aria-hidden />
              <h4>从一个网页开始</h4>
              <p>输入网址，或告诉小序要在网页上完成什么</p>
            </div>
            <form
              className="assistant-browser-search"
              onSubmit={(event) => {
                event.preventDefault();
                void start();
              }}
            >
              <SearchOutlined aria-hidden />
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
        <details className="assistant-browser-settings">
          <summary>浏览器设置与登录状态</summary>
          <p>
            网页任务在小序的独立浏览器中执行，不占用你的鼠标和键盘。同一账号换电脑登录后，可继续查看任务和已保存的网页会话。
          </p>
          {error ? (
            <Alert type="error" title={error} />
          ) : !data?.ready ? (
            <Alert
              type="warning"
              showIcon
              title={data ? "独立浏览器暂不可用" : "正在核对独立浏览器"}
              description={
                data?.note ||
                "服务尚未就绪，请稍后刷新。不会切换到我的电脑或网站内执行。"
              }
            />
          ) : (
            <Alert
              type="success"
              showIcon
              title="独立浏览器已就绪"
              description={
                data.note ||
                "描述目标后，小序会连续操作；需要你处理的步骤会暂停并提示接管。"
              }
            />
          )}
          <Space wrap>
            <Button
              type="primary"
              disabled={disabled || !data?.ready}
              onClick={choose}
            >
              使用小序独立浏览器
            </Button>
            <Button
              disabled={disabled || clearing || !data?.profile}
              loading={clearing}
              onClick={clear}
            >
              清除浏览器登录状态
            </Button>
          </Space>
          <p className="assistant-browser-session">
            {data?.profile?.hasSavedSession
              ? "此账号已保存网页会话；登录是否仍有效以目标网站为准。"
              : "尚未保存网页登录状态；需要时可在画面中自行登录。"}
          </p>
        </details>
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

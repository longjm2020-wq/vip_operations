import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { Alert, App, Button, Empty, Input, Select, Space, Tag } from "antd";
import { GlobalOutlined, ReloadOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  browserStatusLabels,
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
      <p>
        {manual
          ? "任务已让出控制。点击画面定位后输入文字，或使用下方按键操作；登录、验证码等需要你完成。"
          : isActiveBrowserTask(task)
            ? "小序正在操作。需要登录或手动处理时，先暂停任务，再在这里接管。"
            : "此任务已结束，最终画面仅供查看。"}{" "}
        这里是定期更新的截图。
      </p>
      {frame.error && <Alert type="warning" title={frame.error.message} />}
      {frame.data ? (
        <>
          <p className="assistant-browser-location">
            {frame.data.title} · {frame.data.url}
          </p>
          {frame.data.readOnly && (
            <p className="assistant-browser-location">
              最终画面仅供查看
              {frame.data.expiresAt
                ? `，保留至 ${new Date(frame.data.expiresAt).toLocaleString("zh-CN")}`
                : ""}
              。执行页面已关闭，下一条任务可复用已保存的登录状态。
            </p>
          )}
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
        </>
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
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { modal, message } = App.useApp();
  const queryClient = useQueryClient();
  const [clearing, setClearing] = useState(false);
  const clearDialog = useRef<{ destroy: () => void } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearDialog.current?.destroy();
    };
  }, []);
  useLayoutEffect(() => {
    if (open) {
      const scroller = ref.current?.closest<HTMLElement>(".ant-drawer-body");
      if (scroller) scroller.scrollTop = 0;
    }
  }, [open]);
  const tasks = data?.tasks || [];
  const task =
    tasks.find((entry) => entry.id === selectedId) ||
    tasks.find(isActiveBrowserTask) ||
    tasks[0];
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
      <div className="assistant-browser-heading">
        <h3>
          <GlobalOutlined /> 小序独立浏览器
        </h3>
        <Button size="small" onClick={returnToChat}>
          返回对话
        </Button>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => void refresh()}
        >
          刷新
        </Button>
      </div>
      <h4>任务与接管</h4>
      {!!tasks.length && (
        <Select
          className="assistant-browser-task-select"
          aria-label="选择浏览器任务"
          value={task?.id}
          onChange={selectTask}
          options={tasks.map((entry) => ({
            value: entry.id,
            label: `${browserStatusLabels[entry.status]} · ${entry.instruction}`,
          }))}
        />
      )}
      {task ? (
        <>
          <AssistantBrowserTaskCard task={task} refresh={refresh} />
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
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有浏览器任务。选择独立浏览器后，在对话中描述要完成的目标。"
        />
      )}
      <details className="assistant-browser-settings" open={!task}>
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
    </div>
  );
}

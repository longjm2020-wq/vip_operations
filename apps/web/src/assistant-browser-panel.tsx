import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
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
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ArrowUpOutlined,
  CloseOutlined,
  ExpandOutlined,
  CompressOutlined,
  DoubleRightOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
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
  type BrowserNavigationAction,
  type BrowserViewport,
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
  const { message } = App.useApp();
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
      if (inline) void message.error((cause as Error).message);
      else setError((cause as Error).message);
    } finally {
      operation.current = false;
      setPending("");
    }
  };
  if (task.mode === "BROWSE" && isActiveBrowserTask(task))
    return (
      <section
        className="assistant-browser-task assistant-browser-task-compact"
        data-browser-task-id={task.id}
      >
        <strong>{task.title || "浏览网页"}</strong>
        <p>
          {task.navigationState === "STARTING"
            ? "正在打开网页"
            : task.navigationState === "ERROR"
              ? task.stage
              : "可直接浏览或让小序操作"}
        </p>
        {inspect && (
          <Button size="small" onClick={inspect}>
            查看网页
          </Button>
        )}
      </section>
    );
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
  start,
  update,
  canBrowse,
  disabled,
  unavailable,
  fullscreen,
}: {
  task?: BrowserTask;
  owner: string;
  refresh: () => Promise<unknown>;
  start: (url: string, viewport: BrowserViewport) => Promise<void>;
  update: (task: BrowserTask) => void;
  canBrowse: boolean;
  disabled: boolean;
  unavailable?: string;
  fullscreen: boolean;
}) {
  const { message } = App.useApp();
  const [address, setAddress] = useState(task?.url || "");
  const [editingAddress, setEditingAddress] = useState(false);
  const [pending, setPending] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [viewport, setViewport] = useState<BrowserViewport>({
    width: 960,
    height: 640,
  });
  const page = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const screen = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const operation = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const queue = useRef<{ action: BrowserManualAction; frame?: BrowserFrame }[]>(
    [],
  );
  const exitKeyboard = useRef(false);
  const consumed = useRef("");
  const textTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const wheelDelta = useRef(0);
  const measuredViewport = useRef<BrowserViewport | null>(null);
  const [resizeIntent, setResizeIntent] = useState(0);
  const handledResize = useRef(0);
  const previousFullscreen = useRef(false);
  const latest = useRef({ task, viewport });
  latest.current = { task, viewport };
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    return () => {
      controller.abort();
      queue.current = [];
      clearTimeout(textTimer.current);
      clearTimeout(wheelTimer.current);
    };
  }, []);
  const frame = useQuery({
    queryKey: ["assistant-browser-frame", owner, task?.id, task?.status],
    enabled: !!task,
    queryFn: async ({ signal }) =>
      (
        await api(
          `/my-workspace/assistant/browser/tasks/${task!.id}/frame`,
          "GET",
          undefined,
          undefined,
          { signal },
        )
      ).data as BrowserFrame | null,
    refetchInterval: task && isActiveBrowserTask(task) ? 900 : false,
    staleTime: 0,
    gcTime: 0,
  });
  const frameRef = useRef(frame.data);
  frameRef.current = frame.data;
  const live = !!task && isActiveBrowserTask(task);
  const readOnly = task?.status === "DONE" || frame.data?.readOnly === true;
  const manual =
    live && ["PAUSED", "NEEDS_USER"].includes(task!.status) && !readOnly;
  const canResize = live && !readOnly && task?.status !== "QUEUED";
  const loading =
    task?.navigationState === "LOADING" ||
    task?.navigationState === "STARTING" ||
    task?.status === "QUEUED";
  const usable =
    manual &&
    !!frame.data &&
    !frame.error &&
    !loading &&
    frame.data.frameId !== consumed.current;
  const currentUrl = frame.data?.url || task?.url || "";
  useEffect(() => {
    if (!editingAddress) setAddress(currentUrl);
  }, [currentUrl, editingAddress]);
  useEffect(() => {
    if (previousFullscreen.current === fullscreen) return;
    previousFullscreen.current = fullscreen;
    setResizeIntent((value) => value + 1);
  }, [fullscreen]);
  useEffect(() => {
    const element = page.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(([entry]) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const width = Math.max(
          320,
          Math.min(2560, Math.round(entry.contentRect.width)),
        );
        const height = Math.max(
          240,
          Math.min(1600, Math.round(entry.contentRect.height)),
        );
        if (entry.contentRect.width < 1 || entry.contentRect.height < 1) return;
        const previous = measuredViewport.current;
        measuredViewport.current = { width, height };
        // Opening an existing session is observation, not ownership of its viewport.
        // Only a subsequent local layout change may request another remote size.
        if (
          previous &&
          (previous.width !== width || previous.height !== height)
        )
          setResizeIntent((value) => value + 1);
        setViewport((old) =>
          old.width === width && old.height === height
            ? old
            : { width, height },
        );
      }, 300);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);
  const report = (cause: unknown) => {
    if (!abort.current?.signal.aborted)
      void message.error({
        content: (cause as Error).message || "浏览器暂时无法操作，请稍后重试",
        key: `browser-${task?.id || "new"}`,
      });
  };
  const waitForFrame = async (
    previous: BrowserFrame,
    requestId: string,
    expectedEpoch = previous.epoch,
  ) => {
    const signal = abort.current!.signal;
    const deadline = Date.now() + 10000;
    while (!signal.aborted && Date.now() < deadline) {
      const result = await frame.refetch();
      if (signal.aborted) throw new Error("操作已取消");
      const next = result.data;
      if (next && next.epoch > expectedEpoch)
        throw new Error("网页已在其他操作中变化，请核对画面后继续");
      if (
        next &&
        !next.readOnly &&
        next.frameId !== previous.frameId &&
        next.epoch === expectedEpoch &&
        next.appliedRequestId === requestId
      ) {
        frameRef.current = next;
        return next;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 180));
    }
    throw new Error("网页画面尚未更新，请核对新画面后再操作");
  };
  const drain = async () => {
    if (
      operation.current ||
      !queue.current.length ||
      !manual ||
      abort.current?.signal.aborted
    )
      return;
    operation.current = true;
    setPending(true);
    try {
      while (queue.current.length && !abort.current?.signal.aborted) {
        const item = queue.current.shift()!;
        const action = item.action;
        const snapshot = item.frame || frameRef.current;
        const currentTask = latest.current.task;
        if (
          !snapshot ||
          snapshot.readOnly ||
          !currentTask ||
          !["PAUSED", "NEEDS_USER"].includes(currentTask.status)
        )
          throw new Error("当前页面不能操作，请先接管并核对画面");
        if (snapshot.frameId === consumed.current)
          throw new Error("请等待新画面后重新操作");
        consumed.current = snapshot.frameId;
        const requestId = crypto.randomUUID();
        await api(
          `/my-workspace/assistant/browser/tasks/${currentTask.id}/actions`,
          "POST",
          {
            requestId,
            frameId: snapshot.frameId,
            epoch: snapshot.epoch,
            action,
          },
          undefined,
          { signal: abort.current!.signal },
        );
        // Never replay rejected input. A subsequent operation needs a confirmed new frame.
        const next = await waitForFrame(snapshot, requestId);
        if (
          next.url !== snapshot.url &&
          (queue.current.length || keyboard.current?.value)
        ) {
          queue.current = [];
          clearTimeout(textTimer.current);
          if (keyboard.current) keyboard.current.value = "";
          report(new Error("网页已跳转，请核对新页面后继续输入"));
        }
      }
      await refresh();
    } catch (cause) {
      queue.current = [];
      clearTimeout(textTimer.current);
      if (keyboard.current) keyboard.current.value = "";
      report(cause);
      if (!abort.current?.signal.aborted) await frame.refetch();
    } finally {
      operation.current = false;
      if (!abort.current?.signal.aborted) setPending(false);
    }
  };
  const enqueue = (action: BrowserManualAction) => {
    if (!manual || abort.current?.signal.aborted || loading || navigating)
      return;
    if (queue.current.length >= 40) {
      report(new Error("输入较快，请等待网页更新后继续"));
      return;
    }
    const last = queue.current.at(-1)?.action;
    if (
      action.kind === "type" &&
      last?.kind === "type" &&
      last.text.length + action.text.length <= 2000
    )
      last.text += action.text;
    else
      queue.current.push({
        action,
        ...(action.kind === "click" && frameRef.current
          ? { frame: frameRef.current }
          : {}),
      });
    void drain();
  };
  const flushText = () => {
    clearTimeout(textTimer.current);
    if (composing.current || !keyboard.current?.value) return;
    const value = keyboard.current.value;
    keyboard.current.value = "";
    if (value.length > 2000) {
      report(new Error("一次最多输入 2000 个字符，请分段粘贴"));
      return;
    }
    enqueue({ kind: "type", text: value });
  };
  const keydown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.nativeEvent.isComposing ||
      composing.current ||
      event.keyCode === 229
    )
      return;
    if (event.key === "Tab" && exitKeyboard.current) {
      exitKeyboard.current = false;
      return;
    }
    exitKeyboard.current = event.key === "Escape";
    const keys: Record<
      string,
      Extract<BrowserManualAction, { kind: "key" }>["key"]
    > = {
      Enter: "ENTER",
      Tab: event.shiftKey ? "SHIFT_TAB" : "TAB",
      Backspace: "BACKSPACE",
      Escape: "ESC",
      ArrowLeft: "ARROW_LEFT",
      ArrowRight: "ARROW_RIGHT",
      ArrowUp: "ARROW_UP",
      ArrowDown: "ARROW_DOWN",
      Delete: "DELETE",
      Home: "HOME",
      End: "END",
      PageUp: "PAGE_UP",
      PageDown: "PAGE_DOWN",
    };
    const key =
      (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a"
        ? "CTRL_A"
        : keys[event.key];
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    flushText();
    enqueue({ kind: "key", key });
  };
  const click = (event: MouseEvent<HTMLButtonElement>) => {
    if (!usable || pending || event.detail === 0) return;
    const image = event.currentTarget.querySelector("img");
    if (!image) return;
    const rect = image.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 1000;
    const y = ((event.clientY - rect.top) / rect.height) * 1000;
    if (x < 0 || y < 0 || x > 1000 || y > 1000) return;
    if (keyboard.current?.value) {
      flushText();
      report(new Error("请等待文字输入完成，再点击新位置"));
      return;
    }
    enqueue({ kind: "click", x: Math.round(x), y: Math.round(y) });
    keyboard.current?.focus({ preventScroll: true });
  };
  const navigation = async (action: BrowserNavigationAction) => {
    if (operation.current || abort.current?.signal.aborted) return;
    if (!manual && action.kind !== "goto" && action.kind !== "resize") return;
    if (live && !manual && action.kind !== "resize") {
      report(new Error("请先暂停小序操作，再浏览网页"));
      return;
    }
    queue.current = [];
    if (keyboard.current) keyboard.current.value = "";
    operation.current = true;
    setNavigating(true);
    setPending(true);
    try {
      if (!live && action.kind === "goto") {
        if (disabled || !canBrowse) return;
        await start(action.url, latest.current.viewport);
      } else if (task) {
        const snapshot = frameRef.current;
        const requestId = crypto.randomUUID();
        const changed = (
          await api(
            `/my-workspace/assistant/browser/tasks/${task.id}/navigation`,
            "POST",
            {
              requestId,
              epoch: task.epoch ?? snapshot?.epoch ?? 0,
              action,
            },
            undefined,
            { signal: abort.current!.signal },
          )
        ).data as BrowserTask;
        if (abort.current?.signal.aborted) return;
        update(changed);
        if (snapshot) {
          consumed.current = snapshot.frameId;
          await waitForFrame(
            snapshot,
            requestId,
            changed.epoch ?? snapshot.epoch,
          );
        }
        await refresh();
      }
      if (action.kind === "goto") setEditingAddress(false);
    } catch (cause) {
      report(cause);
    } finally {
      operation.current = false;
      if (!abort.current?.signal.aborted) {
        setPending(false);
        setNavigating(false);
      }
    }
  };
  useEffect(() => {
    if (
      !canResize ||
      loading ||
      pending ||
      !task ||
      !frame.data ||
      !measuredViewport.current ||
      handledResize.current >= resizeIntent ||
      queue.current.length ||
      composing.current
    )
      return;
    if (
      task.viewport?.width === viewport.width &&
      task.viewport?.height === viewport.height
    ) {
      handledResize.current = resizeIntent;
      return;
    }
    const timer = setTimeout(() => {
      if (
        operation.current ||
        keyboard.current?.value ||
        composing.current ||
        queue.current.length
      )
        return;
      // Consume this local intent even if the request is rejected. Remote polling
      // must never generate a correction loop between two viewers of one session.
      handledResize.current = resizeIntent;
      void navigation({ kind: "resize", viewport });
    }, 500);
    return () => clearTimeout(timer);
    // A fresh frame can release a pending local intent, but cannot create one.
  }, [
    canResize,
    loading,
    pending,
    resizeIntent,
    viewport.width,
    viewport.height,
    task?.epoch,
    frame.data?.frameId,
  ]);
  useEffect(() => {
    const element = page.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!manual || loading) return;
      event.preventDefault();
      wheelDelta.current += event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => {
        const amount = wheelDelta.current;
        wheelDelta.current = 0;
        if (Math.abs(amount) < 1) return;
        flushText();
        enqueue({
          kind: "scroll",
          direction: amount < 0 ? "up" : "down",
          amount: Math.min(6, Math.max(1, Math.ceil(Math.abs(amount) / 160))),
        });
      }, 100);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [manual, loading]);
  const submit = () => {
    const raw = address.trim();
    const parsed = browserUrlSchema.safeParse(
      /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`,
    );
    if (!parsed.success) {
      report(
        new Error(
          "请填写不含账号密码的公开 HTTP/HTTPS 网址；自动操作目标请发给小序",
        ),
      );
      return;
    }
    void navigation({ kind: "goto", url: parsed.data });
  };
  const readOnlyNote =
    "历史任务已结束，此画面只读" +
    (frame.data?.expiresAt
      ? `，保留至 ${new Date(frame.data.expiresAt).toLocaleString("zh-CN")}`
      : "");
  const status =
    unavailable ||
    frame.error?.message ||
    (task?.navigationState === "ERROR"
      ? task.stage
      : loading
        ? "正在打开网页"
        : "");
  return (
    <section
      className="assistant-browser-takeover"
      aria-label="独立浏览器画面与接管"
    >
      <form
        className="assistant-browser-navigation"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Button
          type="text"
          size="small"
          icon={<ArrowLeftOutlined />}
          aria-label="后退"
          disabled={!usable || pending || !frame.data?.canGoBack}
          onClick={() => void navigation({ kind: "back" })}
        />
        <Button
          type="text"
          size="small"
          icon={<ArrowRightOutlined />}
          aria-label="前进"
          disabled={!usable || pending || !frame.data?.canGoForward}
          onClick={() => void navigation({ kind: "forward" })}
        />
        <Button
          type="text"
          size="small"
          icon={<ReloadOutlined />}
          aria-label={readOnly ? "刷新历史画面" : "刷新网页"}
          loading={pending && live}
          disabled={pending || (live ? !manual : !readOnly)}
          onClick={() => {
            if (readOnly) void frame.refetch();
            else void navigation({ kind: "reload" });
          }}
        />
        <div className="assistant-browser-address" title={status || currentUrl}>
          <GlobalOutlined aria-hidden />
          <Input
            variant="borderless"
            aria-label="网页地址"
            placeholder="输入网址，按回车打开"
            value={address}
            maxLength={2048}
            disabled={pending || disabled || !canBrowse}
            onFocus={() => setEditingAddress(true)}
            onBlur={() => {
              if (address === currentUrl) setEditingAddress(false);
            }}
            onChange={(event) => {
              setEditingAddress(true);
              setAddress(event.target.value);
            }}
          />
          {readOnly && (
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
          {status && (
            <span
              className="assistant-browser-address-status"
              role="status"
              title={status}
            >
              {status}
            </span>
          )}
          <Button
            type="text"
            size="small"
            htmlType="submit"
            icon={<ArrowUpOutlined />}
            aria-label="打开网址"
            disabled={pending || disabled || !canBrowse || !address.trim()}
          />
        </div>
      </form>
      {task &&
        task.mode !== "BROWSE" &&
        (isActiveBrowserTask(task) || task.status === "FAILED") && (
          <AssistantBrowserTaskCard task={task} refresh={refresh} inline />
        )}
      <div
        className="assistant-browser-page"
        ref={page}
        onPointerDownCapture={(event) => {
          if (pending && manual && !navigating) {
            event.preventDefault();
            keyboard.current?.focus({ preventScroll: true });
          }
        }}
      >
        {frame.data ? (
          <button
            ref={screen}
            type="button"
            className="assistant-browser-screen"
            aria-label="点击独立浏览器画面"
            aria-busy={pending || loading}
            disabled={!usable || pending}
            onClick={click}
            onFocus={() => {
              if (manual) keyboard.current?.focus({ preventScroll: true });
            }}
            title={
              readOnly
                ? readOnlyNote
                : manual
                  ? "直接点击、输入或滚动网页；按 Esc 后 Tab 可离开画面"
                  : "请先暂停小序操作再接管"
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
              task
                ? readOnly
                  ? "没有可查看的最终画面，可能已过期或已清除"
                  : isActiveBrowserTask(task)
                    ? "正在打开网页…"
                    : "网页已关闭"
                : ""
            }
          />
        )}
        {manual && (
          <textarea
            ref={keyboard}
            className="assistant-browser-keyboard"
            aria-label="网页键盘输入"
            disabled={navigating || loading}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onKeyDown={keydown}
            onCompositionStart={() => {
              composing.current = true;
              clearTimeout(textTimer.current);
            }}
            onCompositionEnd={() => {
              composing.current = false;
              flushText();
            }}
            onInput={() => {
              if (!composing.current) {
                clearTimeout(textTimer.current);
                textTimer.current = setTimeout(flushText, 100);
              }
            }}
            onPaste={(event) => {
              event.preventDefault();
              flushText();
              const text = event.clipboardData.getData("text/plain");
              if (text.length > 2000)
                report(new Error("一次最多粘贴 2000 个字符"));
              else if (text) enqueue({ kind: "type", text });
            }}
          />
        )}
      </div>
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
  const { modal, message } = App.useApp();
  const queryClient = useQueryClient();
  const [clearing, setClearing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [newTab, setNewTab] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [pageFullscreen, setPageFullscreen] = useState(false);
  const request = useRef<{ value: string; id: string } | null>(null);
  const clearDialog = useRef<{ destroy: () => void } | null>(null);
  const mounted = useRef(true);
  useEffect(() => setNewTab(false), [selectedId]);
  useEffect(() => {
    const changed = () =>
      setFullscreen(document.fullscreenElement === panelRef.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    if (!pageFullscreen && !fullscreen) return;
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPageFullscreen(false);
        if (document.fullscreenElement === panelRef.current)
          void document.exitFullscreen();
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [pageFullscreen, fullscreen]);
  const leaveFullscreen = async () => {
    setPageFullscreen(false);
    if (document.fullscreenElement === panelRef.current)
      await document.exitFullscreen();
  };
  const toggleFullscreen = async () => {
    if (fullscreen || pageFullscreen) {
      await leaveFullscreen();
      return;
    }
    try {
      if (!panelRef.current?.requestFullscreen) throw new Error("unsupported");
      await panelRef.current.requestFullscreen();
    } catch {
      if (mounted.current) setPageFullscreen(true);
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearDialog.current?.destroy();
      onSubmitting(false);
    };
  }, [onSubmitting]);
  const tasks = data?.tasks || [];
  const selectedTask =
    tasks.find((entry) => entry.id === selectedId) ||
    tasks.find(isActiveBrowserTask) ||
    tasks[0];
  const task = newTab ? undefined : selectedTask;
  const canBrowse = data?.canBrowse ?? data?.ready ?? false;
  const update = (changed: BrowserTask) => {
    queryClient.setQueryData<BrowserState>(
      ["assistant-browser", owner],
      (previous) =>
        previous
          ? {
              ...previous,
              tasks: [
                changed,
                ...previous.tasks.filter((entry) => entry.id !== changed.id),
              ],
            }
          : previous,
    );
  };
  const start = async (url: string, viewport: BrowserViewport) => {
    const active = tasks.find(isActiveBrowserTask);
    if (
      active &&
      active.mode !== "BROWSE" &&
      !["PAUSED", "NEEDS_USER"].includes(active.status)
    ) {
      setNewTab(false);
      selectTask(active.id);
      throw new Error("请先暂停小序操作，再打开新网址");
    }
    if (request.current?.value !== url)
      request.current = { value: url, id: crypto.randomUUID() };
    onSubmitting(true);
    try {
      const created = (
        await api("/my-workspace/assistant/browser/browse", "POST", {
          requestId: request.current.id,
          url,
          viewport,
        })
      ).data as BrowserTask;
      if (!mounted.current) return;
      update(created);
      request.current = null;
      setNewTab(false);
      onStarted(created);
      await refresh();
    } finally {
      if (mounted.current) onSubmitting(false);
    }
  };
  const clear = async () => {
    await leaveFullscreen();
    if (!mounted.current) return;
    clearDialog.current = modal.confirm({
      title: "清除独立浏览器登录状态？",
      content:
        "将关闭当前浏览器，并清除已保存的网页登录状态与任务截图。之后需要重新登录这些网站。",
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
  const closePage = async () => {
    if (closing) return;
    if (!task || !isActiveBrowserTask(task)) {
      setNewTab(true);
      return;
    }
    setClosing(true);
    try {
      await api(
        `/my-workspace/assistant/browser/tasks/${task.id}/close`,
        "POST",
      );
      if (!mounted.current) return;
      await refresh();
      if (mounted.current) setNewTab(true);
    } catch (cause) {
      if (mounted.current) void message.error((cause as Error).message);
    } finally {
      if (mounted.current) setClosing(false);
    }
  };
  return (
    <div
      ref={panelRef}
      className={`assistant-browser-panel${pageFullscreen ? " assistant-browser-page-fullscreen" : ""}`}
      data-browser-fullscreen={fullscreen || pageFullscreen}
    >
      <div className="assistant-browser-tabbar">
        <div
          className="assistant-browser-tab"
          title={task?.title || task?.instruction || "新网页"}
        >
          <Dropdown
            trigger={["click"]}
            getPopupContainer={() => panelRef.current || document.body}
            menu={{
              className: "assistant-browser-menu",
              selectedKeys: task ? [`task:${task.id}`] : [],
              items: [
                {
                  key: "history",
                  type: "group",
                  label: "最近网页与任务",
                  children: tasks.length
                    ? tasks.map((entry) => ({
                        key: `task:${entry.id}`,
                        label: (
                          <span title={entry.instruction}>
                            {entry.mode === "BROWSE" &&
                            isActiveBrowserTask(entry)
                              ? "浏览中"
                              : browserStatusLabels[entry.status]}{" "}
                            · {entry.instruction}
                          </span>
                        ),
                      }))
                    : [{ key: "empty", label: "暂无历史任务", disabled: true }],
                },
                { type: "divider" },
                {
                  key: "choose",
                  label: "让小序操作当前网页",
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
                else if (key === "clear") void clear();
              },
            }}
          >
            <Button
              type="text"
              size="small"
              className="assistant-browser-tab-label"
              icon={<GlobalOutlined />}
              aria-label="浏览器标签与会话菜单"
              title="查看最近网页、任务和登录状态"
            >
              {task?.title || (task ? "网页" : "新网页")}
            </Button>
          </Dropdown>
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined />}
            aria-label="关闭当前网页"
            title="关闭当前网页并停止操作"
            loading={closing}
            onClick={() => void closePage()}
          />
        </div>
        <Button
          type="text"
          size="small"
          icon={<PlusOutlined />}
          aria-label="打开新网址"
          title="输入新网址，复用当前浏览器"
          onClick={() => setNewTab(true)}
        />
        <div className="assistant-browser-window-actions">
          <Button
            type="text"
            size="small"
            icon={
              fullscreen || pageFullscreen ? (
                <FullscreenExitOutlined />
              ) : (
                <FullscreenOutlined />
              )
            }
            aria-label={fullscreen || pageFullscreen ? "退出全屏" : "全屏查看"}
            title={
              fullscreen || pageFullscreen
                ? "退出全屏（Esc）"
                : "全屏查看浏览器"
            }
            onClick={() => void toggleFullscreen()}
          />
          <Button
            type="text"
            size="small"
            icon={<DoubleRightOutlined />}
            aria-label={embedded ? "关闭浏览器面板" : "返回对话"}
            title="收起面板，保留当前网页"
            onClick={() => {
              void leaveFullscreen().finally(returnToChat);
            }}
          />
        </div>
      </div>
      <div className="assistant-browser-content">
        {open && (
          <BrowserTakeover
            key={task?.id || "new"}
            task={task}
            fullscreen={fullscreen || pageFullscreen}
            owner={owner}
            refresh={refresh}
            start={start}
            update={update}
            canBrowse={canBrowse}
            disabled={disabled}
            unavailable={
              !canBrowse || error
                ? error || data?.note || "正在连接浏览器"
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

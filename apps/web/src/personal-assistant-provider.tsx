import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Bubble, Sender } from "@ant-design/x";
import {
  App,
  Alert,
  Button,
  Checkbox,
  Drawer,
  Popconfirm,
  Spin,
  Tag,
  Tabs,
  Tooltip,
} from "antd";
import {
  ArrowRightOutlined,
  CalendarOutlined,
  CommentOutlined,
  DeleteOutlined,
  ReloadOutlined,
  AudioOutlined,
  SoundOutlined,
  StopOutlined,
  CustomerServiceOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api } from "./api";
import { useUser } from "./shared";
import {
  canUsePersonalAssistant,
  type AssistantConversation,
  type AssistantAction,
  type AssistantMemory,
  type AssistantMemoryEntry,
} from "../../../packages/contracts/src/personal-assistant";
import { availableWorkspaceTools } from "../../../packages/contracts/src/personal-workspace";
import { AssistantHubContext } from "./assistant-hub-context";
import { AssistantActivityPanel } from "./assistant-activity-panel";
import type { AssistantActivityFeed } from "../../../packages/contracts/src/assistant-activity";
import type { WorkspaceSchedule } from "../../../packages/contracts/src/personal-workspace";
import "./personal-assistant.css";
import { useAssistantVoice } from "./use-assistant-voice";
import { AssistantMemoryPanel } from "./assistant-memory-panel";
import { AssistantBusinessResults } from "./assistant-business-results";
import { AssistantRealtimePanel } from "./assistant-realtime-panel";
import type { VoiceState } from "./use-gpt-voice";

export function PersonalAssistantProvider({
  children,
}: {
  children: ReactNode;
}) {
  const user = useUser(),
    { message } = App.useApp();
  const navigate = useNavigate();
  const available = availableWorkspaceTools({
    permissions: user.permissions,
    roleCodes: user.roleCodes,
  });
  const [section, setSection] = useState<
    "chat" | "activity" | "memory" | "voice"
  >("chat");
  const [pendingSchedules, setPendingSchedules] = useState<WorkspaceSchedule[]>(
    [],
  );
  const [draftSchedule, setDraftSchedule] = useState<
    WorkspaceSchedule[] | null
  >(null);
  const schedule = draftSchedule || [];
  const [seen, setSeen] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("xuti-assistant-seen:" + user.id) || "[]",
      );
      return Array.isArray(saved)
        ? saved.filter((key) => typeof key === "string").slice(-300)
        : [];
    } catch {
      return [];
    }
  });
  const activity = useQuery({
    queryKey: ["assistant-activity", user.id],
    queryFn: async () =>
      (await api("/my-workspace/activity")).data as AssistantActivityFeed,
    refetchInterval: 30000,
    staleTime: 15000,
  });
  const markSeen = (keys: string[]) =>
    setSeen((previous) => {
      const next = [...new Set([...previous, ...keys])].slice(-300);
      try {
        localStorage.setItem(
          "xuti-assistant-seen:" + user.id,
          JSON.stringify(next),
        );
      } catch {
        /* Read marks remain available for this session. */
      }
      return next;
    });
  const onSchedule = (event: WorkspaceSchedule) => {
    setPendingSchedules((previous) =>
      previous.some((item) => item.id === event.id)
        ? previous
        : [...previous, event],
    );
    navigate("/my-workspace");
  };
  const allowed = canUsePersonalAssistant({ permissions: user.permissions });
  const [open, setOpen] = useState(false),
    [text, setText] = useState("");
  const [includeContext, setIncludeContext] = useState(false),
    [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [includeMemory, setIncludeMemory] = useState(false);
  const [voiceReply, setVoiceReply] = useState(false),
    [voiceReminders, setVoiceReminders] = useState(false);
  const [executing, setExecuting] = useState<string | null>(null);
  const [memorySuggestion, setMemorySuggestion] =
    useState<AssistantMemoryEntry | null>(null);
  const voice = useAssistantVoice(setText);
  const [realtimeState, setRealtimeState] = useState<VoiceState>("idle");
  const playbackAllowed = useRef(false);
  playbackAllowed.current = open && section === "chat" && voiceReply;
  const memory = useQuery({
    queryKey: ["assistant-memory", user.id],
    enabled: allowed && (section === "memory" || includeMemory),
    queryFn: async () =>
      (await api("/my-workspace/assistant/memory")).data as AssistantMemory,
    staleTime: 15000,
  });
  const saveMemory = async (entries: AssistantMemoryEntry[]) => {
    if (!memory.data) throw Error("请先刷新个人记忆");
    await api("/my-workspace/assistant/memory", "POST", {
      version: memory.data.version,
      entries,
    });
    await memory.refetch();
    message.success("个人记忆已保存");
  };
  const bottom = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ["personal-assistant", user.id],
    queryFn: () => api("/my-workspace/assistant"),
    enabled: allowed,
    staleTime: 15000,
    refetchInterval: (query) =>
      sending ||
      query.state.data?.data?.state === "PENDING" ||
      query.state.data?.data?.messages?.some(
        (item: { actions?: AssistantAction[] }) =>
          item.actions?.some((action) => action.status === "SUBMITTING"),
      )
        ? 3000
        : false,
  });
  const data = q.data?.data as AssistantConversation | undefined;
  const busy =
    sending ||
    data?.state === "PENDING" ||
    !!executing ||
    realtimeState !== "idle";
  const announce = useCallback(
    (value: string) => {
      if (voiceReminders && !voice.listening && !voice.speaking && !busy)
        voice.speak(value);
    },
    [voiceReminders, voice.listening, voice.speaking, busy, voice.speak],
  );
  const messages = data?.messages || [];
  useEffect(() => {
    if (open) bottom.current?.scrollIntoView({ block: "end" });
  }, [open, messages.length, busy]);
  const send = async (value: string) => {
    if (!value.trim() || !data?.ready || busy) return;
    setSection("chat");
    setOpen(true);
    setSending(true);
    setError("");
    voice.stop();
    try {
      const response = await api("/my-workspace/assistant", "POST", {
        message: value.trim(),
        version: data.version,
        requestId: crypto.randomUUID(),
        includePersonalContext: includeContext,
        includeMemory,
      });
      setText("");
      const latest = (response.data as AssistantConversation).messages?.at(-1);
      if (
        playbackAllowed.current &&
        latest?.role === "assistant" &&
        response.data.state === "IDLE"
      )
        voice.speak(latest.text);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
      await q.refetch();
    }
  };
  const execute = async (action: AssistantAction) => {
    if (executing) return;
    setExecuting(action.id);
    setError("");
    voice.stop();
    try {
      const result = (
        await api("/my-workspace/assistant/actions", "POST", { id: action.id })
      ).data as AssistantAction;
      if (result.status === "FAILED") message.error(result.note);
      else if (result.status === "SUBMITTED") message.success("任务状态已更新");
      await Promise.all([q.refetch(), activity.refetch()]);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setExecuting(null);
    }
  };
  const openPanel = (tab: "chat" | "activity" | "voice" = "chat") => {
    voice.stop();
    setSection(allowed ? tab : "activity");
    setOpen(true);
  };
  const sender = (inDrawer = false) => (
    <div className="assistant-compose">
      <Sender
        value={text}
        onChange={(value) => setText(value.slice(0, 4000))}
        onSubmit={(value) => void send(value)}
        loading={busy}
        readOnly={busy || voice.listening}
        disabled={!data?.ready || busy}
        submitType="enter"
        suffix={(_, { components }) => (
          <div className="assistant-send-actions">
            <Tooltip
              title={
                voice.supported
                  ? "点击说话，识别后核对发送。语音由浏览器识别，可能使用其在线服务。"
                  : "此浏览器不支持语音识别，可继续键入。"
              }
            >
              <Button
                type={voice.listening ? "primary" : "text"}
                shape="circle"
                icon={voice.listening ? <StopOutlined /> : <AudioOutlined />}
                aria-label={voice.listening ? "停止语音输入" : "语音输入"}
                disabled={!voice.supported || busy || !data?.ready}
                onClick={() => voice.start(text)}
              />
            </Tooltip>
            {voice.speaking && (
              <Button
                type="text"
                shape="circle"
                icon={<StopOutlined />}
                aria-label="停止朗读"
                onClick={voice.stopSpeaking}
              />
            )}
            {busy ? (
              <Button
                loading
                disabled
                shape="circle"
                aria-label="助理正在回复"
              />
            ) : (
              <components.SendButton aria-label="发送给个人助理" />
            )}
          </div>
        )}
        placeholder={
          data?.ready
            ? "告诉我你想完成什么，例如：安排明天下午3点选款会…"
            : q.isLoading
              ? "正在连接个人助理…"
              : "AI 尚未就绪，点击打开助理查看原因"
        }
        autoSize={{ minRows: inDrawer ? 2 : 1, maxRows: 5 }}
      />
      <div className="assistant-compose-meta">
        <Button
          type="text"
          size="small"
          icon={<CustomerServiceOutlined />}
          aria-label="GPT 语音"
          disabled={sending || !!executing}
          onClick={() => openPanel("voice")}
        >
          GPT 语音
        </Button>
        <Checkbox
          checked={includeContext}
          onChange={(e) => setIncludeContext(e.target.checked)}
          disabled={busy}
        >
          附带已保存日程与待办
        </Checkbox>
        <Checkbox
          checked={includeMemory}
          onChange={(e) => setIncludeMemory(e.target.checked)}
          disabled={busy}
        >
          使用个人记忆
        </Checkbox>
        {!inDrawer && (
          <Button
            type="text"
            size="small"
            icon={<CommentOutlined />}
            aria-label="打开个人助理"
            onClick={() => openPanel("chat")}
          >
            打开个人助理
          </Button>
        )}
      </div>
      {voice.listening && (
        <div className="assistant-voice-status" role="status">
          <i />
          <i />
          <i />
          正在聆听…识别结果可编辑后发送
        </div>
      )}
      {voice.error && (
        <div className="assistant-voice-error" role="status">
          {voice.error}
        </div>
      )}
    </div>
  );
  return (
    <AssistantHubContext.Provider
      value={{
        allowed,
        conversation: data,
        busy,
        voiceState:
          realtimeState === "speaking"
            ? "speaking"
            : realtimeState !== "idle"
              ? "listening"
              : voice.listening
                ? "listening"
                : voice.speaking
                  ? "speaking"
                  : undefined,
        announce,
        compose: () => sender(),
        openPanel,
        feed: activity.data,
        feedLoading: activity.isLoading,
        feedError: activity.error,
        seen,
        pendingSchedules,
        consumeSchedule: (id) =>
          setPendingSchedules((previous) =>
            previous.filter((event) => event.id !== id),
          ),
        setDraftSchedule,
      }}
    >
      {children}
      <Drawer
        open={open}
        onClose={() => {
          setOpen(false);
          voice.stop();
        }}
        title={
          <span>
            <CommentOutlined /> AI 个人助理
          </span>
        }
        size={620}
        rootClassName="personal-assistant-drawer"
        extra={
          section === "chat" &&
          allowed && (
            <Popconfirm
              title="清空当前账号的助理对话？"
              description="日程、待办、备忘和个人记忆不受影响，未执行的操作卡片将取消。"
              okText="清空"
              cancelText="取消"
              onConfirm={async () => {
                try {
                  await api("/my-workspace/assistant/clear", "POST", {
                    version: data?.version || 0,
                  });
                  await q.refetch();
                  setError("");
                } catch (e) {
                  message.error((e as Error).message);
                }
              }}
            >
              <Button
                type="text"
                icon={<DeleteOutlined />}
                aria-label="清空助理对话"
                disabled={busy || !messages.length}
              />
            </Popconfirm>
          )
        }
        footer={
          section === "chat" && allowed ? (
            <>
              {sender(true)}
              <p className="assistant-privacy">
                发送内容及最近对话将交给已配置的 AI
                服务。按提问查询有权查看的业务数据；勾选后附带日程或个人记忆，私有备忘不发送。Enter
                发送 · Shift+Enter 换行
              </p>
            </>
          ) : null
        }
      >
        <Tabs
          activeKey={section}
          onChange={(key) => {
            setSection(key as "chat" | "activity" | "memory" | "voice");
            voice.stop();
          }}
          items={[
            ...(allowed ? [{ key: "chat", label: "互动对话" }] : []),
            ...(allowed
              ? [
                  {
                    key: "voice",
                    label: "GPT 语音",
                    disabled: sending || !!executing,
                  },
                ]
              : []),
            { key: "activity", label: "动态反馈" },
            ...(allowed ? [{ key: "memory", label: "个人记忆" }] : []),
          ]}
        />
        {allowed && section !== "voice" && (
          <div className="assistant-voice-options">
            <Checkbox
              checked={voiceReply}
              disabled={!voice.canSpeak}
              onChange={(e) => {
                setVoiceReply(e.target.checked);
                if (!e.target.checked) voice.stopSpeaking();
              }}
            >
              语音回复
            </Checkbox>
            <Checkbox
              checked={voiceReminders}
              disabled={!voice.canSpeak}
              onChange={(e) => {
                setVoiceReminders(e.target.checked);
                if (!e.target.checked) voice.stopSpeaking();
              }}
            >
              播报新提醒
            </Checkbox>
            {voice.speaking && (
              <Button
                size="small"
                icon={<StopOutlined />}
                onClick={voice.stopSpeaking}
              >
                打断朗读
              </Button>
            )}
          </div>
        )}
        {open && section === "voice" && allowed && (
          <AssistantRealtimePanel
            userId={user.id}
            onState={setRealtimeState}
            onBusinessResult={() => {
              void q.refetch();
            }}
            openChat={() => openPanel("chat")}
          />
        )}
        {section === "memory" && allowed && (
          <AssistantMemoryPanel
            data={memory.data}
            loading={memory.isFetching}
            error={memory.error}
            save={saveMemory}
            refresh={() => void memory.refetch()}
            suggestion={memorySuggestion}
            clearSuggestion={() => setMemorySuggestion(null)}
          />
        )}
        {section === "activity" && (
          <AssistantActivityPanel
            feed={activity.data}
            loading={activity.isFetching}
            error={activity.error}
            seen={seen}
            markSeen={markSeen}
            refresh={() => void activity.refetch()}
            onNavigate={() => setOpen(false)}
          />
        )}
        <div hidden={section !== "chat" || !allowed}>
          <div className="assistant-status">
            <Tag>{data?.ready ? "已连接" : "未就绪"}</Tag>
            <span>{data?.model || "读取模型状态"}</span>
            <Button
              type="text"
              size="small"
              icon={<ReloadOutlined />}
              aria-label="刷新助理状态"
              onClick={() => void q.refetch()}
              loading={q.isFetching}
            />
          </div>
          {q.isLoading && <Spin />}
          {q.error && <Alert type="error" title={(q.error as Error).message} />}
          {!q.isLoading && data && !data.ready && (
            <Alert
              type="warning"
              title={
                data.availabilityMessage || "请管理员启用并验证 AI 模型连接"
              }
            />
          )}
          {!messages.length && (
            <div className="assistant-empty">
              <span className="assistant-spark" aria-hidden>
                ✦
              </span>
              <h3>你的工作，从一句话开始。</h3>
              <p>说出问题，查库存、跟项目、看任务，也能记住你的工作偏好。</p>
              {[
                "帮我安排明天下午3点的选款会",
                "查看我参与的项目进度",
                "查看最近的同步任务结果",
              ].map((prompt) => (
                <button
                  type="button"
                  key={prompt}
                  onClick={() => setText(prompt)}
                  disabled={busy}
                >
                  {prompt}
                  <ArrowRightOutlined />
                </button>
              ))}
            </div>
          )}
          <div className="assistant-messages" aria-label="助理对话记录">
            {messages.map((item) => (
              <div
                key={item.id}
                className={`assistant-message assistant-message-${item.role}`}
              >
                <Bubble
                  placement={item.role === "user" ? "end" : "start"}
                  variant={item.role === "user" ? "filled" : "borderless"}
                  header={item.role === "user" ? "你" : "AI 个人助理"}
                  content={
                    <div className="assistant-message-text">{item.text}</div>
                  }
                />
                {item.role === "assistant" && voice.canSpeak && (
                  <Button
                    size="small"
                    type="text"
                    icon={<SoundOutlined />}
                    aria-label="朗读这条回复"
                    onClick={() => voice.speak(item.text)}
                  >
                    朗读
                  </Button>
                )}
                <AssistantBusinessResults
                  item={item}
                  feed={activity.data}
                  executing={executing}
                  execute={(action) => void execute(action)}
                  remember={(entry) => {
                    setMemorySuggestion({ ...entry, id: crypto.randomUUID() });
                    setSection("memory");
                  }}
                />
                {!!item.schedules?.length && (
                  <div className="assistant-schedule-proposals">
                    {item.schedules.map((event) => {
                      const added = [...schedule, ...pendingSchedules].some(
                        (existing) => existing.id === event.id,
                      );
                      return (
                        <div
                          key={event.id}
                          className="assistant-schedule-proposal"
                        >
                          <span>
                            <CalendarOutlined /> 待确认日程
                          </span>
                          <strong>{event.title}</strong>
                          <p>
                            {event.date} · {event.startTime || "全天"}
                            {event.endTime ? `–${event.endTime}` : ""}
                          </p>
                          {event.note && <p>{event.note}</p>}
                          <Button
                            size="small"
                            disabled={added || schedule.length >= 500}
                            onClick={() => onSchedule(event)}
                          >
                            {added ? "已加入日程草稿" : "加入日程草稿"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {!!item.tools?.length && (
                  <div className="assistant-tool-links">
                    {item.tools.map((id) => {
                      const tool = available.find((entry) => entry.id === id);
                      return tool ? (
                        <Link key={id} to={tool.path}>
                          {tool.title}
                          <ArrowRightOutlined />
                        </Link>
                      ) : null;
                    })}
                  </div>
                )}
                {item.responseModel && (
                  <small className="assistant-response-model">
                    实际返回：{item.responseModel}
                  </small>
                )}
              </div>
            ))}
            {busy && (
              <Bubble
                loading
                content=""
                header="助理正在回复…"
                variant="borderless"
              />
            )}
            {(error || data?.error) && (
              <Alert type="error" title={error || data?.error} showIcon />
            )}
            <div ref={bottom} />
          </div>
        </div>
      </Drawer>
    </AssistantHubContext.Provider>
  );
}

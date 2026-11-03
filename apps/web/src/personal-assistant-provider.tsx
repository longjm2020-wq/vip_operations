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
  Dropdown,
  Popconfirm,
  Spin,
  Tag,
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
  DownOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useLocation } from "react-router-dom";
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
import {
  AgentComposer,
  AgentMessageResults,
  AgentTasksPanel,
  type AgentOptions,
} from "./assistant-agent-panel";
import type { AgentJob } from "../../../packages/contracts/src/assistant-agent";
import { assistantPublicText } from "../../../packages/contracts/src/ai-presentation";
import { AssistantBusinessResults } from "./assistant-business-results";
import { AssistantVoiceSettingsPanel } from "./assistant-realtime-panel";
import { useGptVoice } from "./use-gpt-voice";
import { useGptSpeech } from "./use-gpt-speech";
import type { AssistantVoiceStatus } from "../../../packages/contracts/src/assistant-voice";

type AssistantSection = "chat" | "activity" | "memory" | "voice" | "tasks";

export function PersonalAssistantProvider({
  children,
}: {
  children: ReactNode;
}) {
  const user = useUser(),
    { message } = App.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const inWorkspace = location.pathname === "/my-workspace";
  const available = availableWorkspaceTools({
    permissions: user.permissions,
    roleCodes: user.roleCodes,
  });
  const [section, setSection] = useState<AssistantSection>("chat");
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
    // Continue in the workspace schedule panel without stacking two drawers.
    playbackAllowed.current = false;
    setOpen(false);
    voice.stop();
    speech.stop();
    navigate("/my-workspace");
  };
  const allowed = canUsePersonalAssistant({ permissions: user.permissions });
  const [open, setOpen] = useState(false),
    [text, setText] = useState("");
  const [includeContext, setIncludeContext] = useState(false),
    [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [agent, setAgent] = useState<AgentOptions>({
    webSearch: false,
    attachments: [],
  });
  const [uploading, setUploading] = useState(false);
  useEffect(() => {
    if (
      allowed &&
      new URLSearchParams(location.search).get("assistant") === "tasks"
    ) {
      setSection("tasks");
      setOpen(true);
      navigate(location.pathname, { replace: true });
    }
  }, [allowed, location.search, location.pathname, navigate]);
  const jobs = useQuery({
    queryKey: ["assistant-jobs", user.id],
    enabled: allowed,
    queryFn: async () =>
      (await api("/my-workspace/assistant/jobs")).data as AgentJob[],
    refetchInterval: (query) =>
      query.state.data?.some(
        (j) => j.status === "QUEUED" || j.status === "RUNNING",
      )
        ? 3000
        : 30000,
  });
  const [includeMemory, setIncludeMemory] = useState(false);
  const [voiceReply, setVoiceReply] = useState(false),
    [voiceReminders, setVoiceReminders] = useState(false);
  const [executing, setExecuting] = useState<string | null>(null);
  const [memorySuggestion, setMemorySuggestion] =
    useState<AssistantMemoryEntry | null>(null);
  const voice = useAssistantVoice(setText);
  const speech = useGptSpeech();
  const [voiceVisible, setVoiceVisible] = useState(false);
  const voiceStatus = useQuery({
    queryKey: ["assistant-voice", user.id],
    enabled: allowed,
    queryFn: async () =>
      (await api("/my-workspace/assistant/voice")).data as AssistantVoiceStatus,
    staleTime: 30000,
  });
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
  const gptVoice = useGptVoice(
    () => {
      void q.refetch();
      void activity.refetch();
    },
    (toolId) => {
      const tool = available.find((item) => item.id === toolId);
      if (tool) navigate(tool.path);
    },
  );
  const busy =
    sending ||
    uploading ||
    data?.state === "PENDING" ||
    !!executing ||
    gptVoice.active;
  const announce = useCallback(
    (value: string) => {
      if (
        voiceReminders &&
        !voice.listening &&
        !voice.speaking &&
        !speech.active &&
        !busy
      )
        voice.speak(value);
    },
    [
      voiceReminders,
      voice.listening,
      voice.speaking,
      speech.active,
      busy,
      voice.speak,
    ],
  );
  const messages = data?.messages || [];
  useEffect(() => {
    if (!open || section !== "chat") speech.stop();
  }, [open, section, speech.stop]);
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
    speech.stop();
    if (voiceReply && voiceStatus.data?.ready) speech.prepare();
    try {
      const response = await api("/my-workspace/assistant", "POST", {
        message: value.trim(),
        version: data.version,
        requestId: crypto.randomUUID(),
        includePersonalContext: includeContext,
        includeMemory,
        model: agent.model,
        imageModel: agent.imageModel,
        webSearch: agent.webSearch,
        attachmentIds: agent.attachments.map((f) => f.id),
      });
      setText("");
      setAgent((previous) => ({ ...previous, attachments: [] }));
      void jobs.refetch();
      const latest = (response.data as AssistantConversation).messages?.at(-1);
      if (
        playbackAllowed.current &&
        !document.hidden &&
        voiceStatus.data?.ready &&
        latest?.role === "assistant" &&
        response.data.state === "IDLE"
      )
        void speech.read(latest.id);
      else speech.stop();
    } catch (e) {
      speech.stop();
      setError((e as Error).message);
    } finally {
      if (!playbackAllowed.current) speech.stop();
      setSending(false);
      await q.refetch();
    }
  };
  const execute = async (action: AssistantAction) => {
    if (executing) return;
    setExecuting(action.id);
    setError("");
    voice.stop();
    speech.stop();
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
  const closeVoice = () => {
    gptVoice.stop();
    setVoiceVisible(false);
  };
  const startVoice = () => {
    if (!allowed) return;
    voice.stop();
    speech.stop();
    setOpen(false);
    setVoiceVisible(true);
    if (gptVoice.state === "speaking") gptVoice.interrupt();
    else if (
      !gptVoice.active &&
      voiceStatus.data?.ready &&
      !sending &&
      !executing &&
      data?.state !== "PENDING"
    )
      void gptVoice.start({
        includePersonalContext: includeContext,
        includeMemory,
      });
    else if (!voiceStatus.data?.ready) void voiceStatus.refetch();
  };
  const openVoiceSettings = () => {
    closeVoice();
    voice.stop();
    speech.stop();
    setSection("voice");
    setOpen(true);
  };
  const openPanel = (tab: "chat" | "activity" | "voice" = "chat") => {
    if (tab === "voice") {
      startVoice();
      return;
    }
    closeVoice();
    voice.stop();
    speech.stop();
    setSection(allowed ? tab : "activity");
    setOpen(true);
  };
  const selectSection = (next: AssistantSection) => {
    playbackAllowed.current = false;
    closeVoice();
    voice.stop();
    speech.stop();
    setSection(allowed ? next : "activity");
    setOpen(true);
  };
  const sectionItems = [
    ...(allowed ? [{ key: "chat", label: "互动对话" }] : []),
    ...(allowed ? [{ key: "tasks", label: "任务与文件" }] : []),
    ...(allowed
      ? [{ key: "voice", label: "语音设置", disabled: sending || !!executing }]
      : []),
    { key: "activity", label: "动态反馈" },
    ...(allowed ? [{ key: "memory", label: "个人记忆" }] : []),
  ];
  const composerSettings = (inDrawer: boolean) => (
    <>
      <div className="assistant-settings-preferences">
        <strong>发送内容</strong>
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
        <p>
          仅勾选后随本次文字或语音提问附带；未保存草稿和私有备忘不发送。已发送内容仍在对话历史中。
        </p>
        <strong>声音</strong>
        <Checkbox
          checked={voiceReply}
          disabled={!speech.supported || !voiceStatus.data?.ready}
          onChange={(e) => {
            setVoiceReply(e.target.checked);
            playbackAllowed.current =
              open && section === "chat" && e.target.checked;
            if (!e.target.checked) speech.stop();
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
        <p>
          小序的声音 · AI 生成
          {voiceStatus.data?.ready
            ? ` · ${voiceStatus.data.voice}`
            : " · 尚未就绪"}
        </p>
      </div>
      <div className="assistant-settings-actions">
        <Button
          size="small"
          icon={<CustomerServiceOutlined />}
          aria-label="智能语音"
          disabled={sending || !!executing}
          data-settings-action
          onClick={() => openPanel("voice")}
        >
          智能语音
        </Button>
        <Button
          size="small"
          data-settings-action
          disabled={sending || !!executing}
          onClick={openVoiceSettings}
        >
          语音设置
        </Button>
        {!inDrawer && (
          <Button
            size="small"
            icon={<CommentOutlined />}
            aria-label="打开个人助理"
            data-settings-action
            onClick={() => openPanel("chat")}
          >
            打开个人助理
          </Button>
        )}
        <Button
          size="small"
          data-settings-action
          onClick={() => selectSection("tasks")}
        >
          任务与文件
        </Button>
        <Button
          size="small"
          data-settings-action
          onClick={() => selectSection("memory")}
        >
          个人记忆
        </Button>
        {(voice.speaking || speech.active) && (
          <Button
            size="small"
            icon={<StopOutlined />}
            onClick={() => {
              voice.stopSpeaking();
              speech.stop();
            }}
          >
            打断朗读
          </Button>
        )}
      </div>
    </>
  );
  const sender = (inDrawer = false) => (
    <div
      className="assistant-compose"
      data-suppressed={!inDrawer && inWorkspace && open ? "true" : undefined}
      inert={!inDrawer && inWorkspace && open}
      aria-hidden={!inDrawer && inWorkspace && open ? true : undefined}
    >
      <AgentComposer
        value={agent}
        change={setAgent}
        disabled={busy}
        onUploading={setUploading}
        settingsContent={composerSettings(inDrawer)}
        active={inDrawer ? open && section === "chat" : !inWorkspace || !open}
      />
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
                onClick={() => {
                  speech.stop();
                  voice.start(text);
                }}
              />
            </Tooltip>
            {(voice.speaking || speech.active) && (
              <Button
                type="text"
                shape="circle"
                icon={<StopOutlined />}
                aria-label="停止朗读"
                onClick={() => {
                  voice.stopSpeaking();
                  speech.stop();
                }}
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
              : "AI 尚未就绪，可从助理设置打开对话查看原因"
        }
        autoSize={{ minRows: inDrawer ? 2 : 1, maxRows: 5 }}
      />
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
        gptVoice,
        voiceStatus: voiceStatus.data,
        voiceStatusError: voiceStatus.error?.message || "",
        voiceVisible,
        startVoice,
        closeVoice,
        openVoiceSettings,
        voiceState: gptVoice.active
          ? (gptVoice.state as Exclude<typeof gptVoice.state, "idle">)
          : speech.active
            ? (speech.state as "thinking" | "speaking")
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
          playbackAllowed.current = false;
          setOpen(false);
          voice.stop();
          speech.stop();
        }}
        title={
          <div className="assistant-panel-heading">
            <span>
              <CommentOutlined /> AI 个人助理
            </span>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: sectionItems,
                selectedKeys: [section],
                onClick: ({ key }) => selectSection(key as AssistantSection),
              }}
            >
              <Button type="text" size="small" aria-label="切换助理面板">
                {sectionItems.find((item) => item.key === section)?.label ||
                  "动态反馈"}
                <DownOutlined />
              </Button>
            </Dropdown>
          </div>
        }
        size={620}
        rootClassName={`personal-assistant-drawer${inWorkspace ? " workspace-assistant-screen" : ""}`}
        classNames={{
          body:
            section === "chat"
              ? "assistant-chat-body"
              : "assistant-secondary-body",
        }}
        extra={
          section === "chat" &&
          allowed && (
            <Popconfirm
              title="清空当前账号的助理对话？"
              description="日程、待办、备忘和个人记忆不受影响，未执行的操作卡片将取消。"
              okText="清空"
              cancelText="取消"
              onConfirm={async () => {
                speech.stop();
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
        {allowed &&
          section === "chat" &&
          (speech.active || speech.blocked || speech.error) && (
            <div className="assistant-speech-status">
              <span>
                小序的声音 · AI 生成
                {voiceStatus.data?.ready
                  ? ` · ${voiceStatus.data.voice}`
                  : " · 尚未就绪"}
              </span>
              {!voiceStatus.data?.ready && (
                <Button size="small" type="link" onClick={openVoiceSettings}>
                  语音设置
                </Button>
              )}
              {speech.active && (
                <span role="status">
                  {speech.state === "thinking"
                    ? "小序正在准备声音…"
                    : "小序正在说话"}
                </span>
              )}
              {speech.blocked && (
                <Button size="small" onClick={speech.play}>
                  播放小序声音
                </Button>
              )}
              {speech.error && <div role="alert">{speech.error}</div>}
            </div>
          )}
        {open && section === "voice" && allowed && (
          <AssistantVoiceSettingsPanel
            status={voiceStatus}
            context={includeContext}
            setContext={setIncludeContext}
            memory={includeMemory}
            setMemory={setIncludeMemory}
            startVoice={startVoice}
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
        {section === "tasks" && allowed && (
          <AgentTasksPanel
            jobs={jobs.data || []}
            refresh={() => void jobs.refetch()}
            onAttach={(file) => {
              if (agent.attachments.length >= 6) {
                message.warning("每次最多附加6个文件");
                return;
              }
              setAgent((previous) => ({
                ...previous,
                attachments: [
                  ...previous.attachments.filter((f) => f.id !== file.id),
                  file,
                ],
              }));
              setSection("chat");
            }}
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
            <span>小序智能体</span>
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
                    <div className="assistant-message-text">
                      {item.role === "assistant"
                        ? assistantPublicText(item.text)
                        : item.text}
                    </div>
                  }
                />
                {item.role === "assistant" && (
                  <Button
                    size="small"
                    type="text"
                    icon={
                      speech.messageId === item.id ? (
                        <StopOutlined />
                      ) : (
                        <SoundOutlined />
                      )
                    }
                    aria-label={
                      speech.messageId === item.id
                        ? "停止小序朗读"
                        : "小序朗读这条回复"
                    }
                    disabled={
                      !speech.supported || !voiceStatus.data?.ready || busy
                    }
                    onClick={() => {
                      if (speech.messageId === item.id) speech.stop();
                      else {
                        voice.stop();
                        void speech.read(item.id);
                      }
                    }}
                  >
                    {speech.messageId === item.id ? "停止朗读" : "小序朗读"}
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
                  <>
                    <AgentMessageResults item={item} jobs={jobs.data || []} />
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
                  </>
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
                {!item.schedules?.length && (
                  <AgentMessageResults item={item} jobs={jobs.data || []} />
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

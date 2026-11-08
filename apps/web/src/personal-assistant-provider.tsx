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
  Select,
  Spin,
} from "antd";
import {
  ArrowRightOutlined,
  CalendarOutlined,
  DeleteOutlined,
  ReloadOutlined,
  SoundOutlined,
  StopOutlined,
  EllipsisOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { assistantNavigationTools } from "../../../packages/contracts/src/assistant-voice-commands";
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
import { useRealtimeVoice } from "./use-realtime-voice";
import type { RealtimeStatus } from "../../../packages/contracts/src/assistant-realtime";
import { useGptSpeech } from "./use-gpt-speech";
import type { AssistantVoiceStatus } from "../../../packages/contracts/src/assistant-voice";
import { workspaceHologramEvent } from "./workspace-hologram";
import { AssistantDesktopPanel } from "./assistant-desktop-panel";
import {
  AssistantTeamPanel,
  teamRunsKey,
  useTeamConfiguration,
} from "./assistant-team-panel";
import type {
  TeamRun,
  TeamRunCreate,
} from "../../../packages/contracts/src/assistant-team";
import type { DesktopState } from "../../../packages/contracts/src/assistant-desktop";
import { useWorkspaceSceneCover } from "./workspace-scene-presence";
import {
  openAssistantWebsite,
  prepareAssistantWebsite,
} from "./assistant-open-website";
import {
  assistantWebsiteUrl,
  parseAssistantWebsiteRequest,
} from "../../../packages/contracts/src/assistant-web-command";

type AssistantSection =
  | "chat"
  | "activity"
  | "memory"
  | "voice"
  | "tasks"
  | "desktop"
  | "team"
  | "settings";

export function PersonalAssistantProvider({
  children,
}: {
  children: ReactNode;
}) {
  const user = useUser(),
    { message, modal } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();
  const inWorkspace = location.pathname === "/my-workspace";
  const available = assistantNavigationTools({
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
  useWorkspaceSceneCover(open);
  const [includeContext, setIncludeContext] = useState(false),
    [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [agent, setAgent] = useState<AgentOptions>({
    attachments: [],
  });
  const [uploading, setUploading] = useState(false);
  const [desktopDeviceId, setDesktopDeviceId] = useState<string>();
  const [teamMode, setTeamMode] = useState(false);
  const [teamModel, setTeamModel] = useState<string>();
  const [useKnowledge, setUseKnowledge] = useState(true);
  const [selectedTeamRunId, setSelectedTeamRunId] = useState<string>();
  const [teamSubmitError, setTeamSubmitError] = useState("");
  const teamConfig = useTeamConfiguration(
    allowed && (teamMode || section === "team"),
  );
  const desktop = useQuery({
    queryKey: ["assistant-desktop", user.id],
    enabled: allowed,
    queryFn: async () =>
      (await api("/my-workspace/assistant/desktop")).data as DesktopState,
    refetchInterval: open || desktopDeviceId ? 4000 : false,
  });
  useEffect(() => {
    if (
      allowed &&
      ["tasks", "desktop", "team"].includes(
        new URLSearchParams(location.search).get("assistant") || "",
      )
    ) {
      setSection(
        new URLSearchParams(location.search).get("assistant") === "desktop"
          ? "desktop"
          : new URLSearchParams(location.search).get("assistant") === "team"
            ? "team"
            : "tasks",
      );
      if (new URLSearchParams(location.search).get("assistant") === "team")
        setTeamMode(true);
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
  useEffect(() => {
    const showMedia = () => {
      document
        .querySelectorAll<HTMLVideoElement>(".personal-assistant-drawer video")
        .forEach((element) => element.pause());
      setOpen(false);
      voice.stop();
      speech.stop();
    };
    window.addEventListener(workspaceHologramEvent, showMedia);
    return () => window.removeEventListener(workspaceHologramEvent, showMedia);
  }, [voice.stop, speech.stop]);
  const [voiceVisible, setVoiceVisible] = useState(false);
  const voiceStatus = useQuery({
    queryKey: ["assistant-voice", user.id],
    enabled: allowed,
    queryFn: async () =>
      (await api("/my-workspace/assistant/voice")).data as AssistantVoiceStatus,
    staleTime: 30000,
  });
  const playbackAllowed = useRef(false);
  const realtimeStatus = useQuery({
    queryKey: ["assistant-realtime", user.id],
    enabled: allowed,
    queryFn: async () =>
      (await api("/my-workspace/assistant/realtime")).data as RealtimeStatus,
    staleTime: 30000,
  });
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
  const composerReady = teamMode ? teamConfig.data?.ready : data?.ready;
  const legacyVoice = useGptVoice(
    () => {
      void q.refetch();
      void activity.refetch();
    },
    (toolId) => {
      const tool = available.find((item) => item.id === toolId);
      if (tool) navigate(tool.path);
    },
  );
  const realtimeVoice = useRealtimeVoice(
    () => {
      void q.refetch();
      void activity.refetch();
      void desktop.refetch();
    },
    (toolId) => {
      const tool = available.find((item) => item.id === toolId);
      if (tool) navigate(tool.path);
    },
    realtimeStatus.data?.transport,
    realtimeStatus.data?.provider,
    { prepare: () => setOpen(false), navigate: (path) => navigate(path) },
  );
  // A live call owns its transport until it ends, including configuration refetches.
  const useRealtime =
    realtimeVoice.active ||
    (!legacyVoice.active && !!realtimeStatus.data?.enabled);
  const gptVoice = useRealtime ? realtimeVoice : legacyVoice;
  const voiceExecutionLabel =
    useRealtime && desktopDeviceId
      ? `电脑操作 · ${desktop.data?.devices?.find((device) => device.id === desktopDeviceId)?.name || "所选电脑"}`
      : "网站内";
  const selectedVoiceStatus =
    useRealtime && realtimeStatus.data
      ? {
          ...realtimeStatus.data,
          model: "小序实时语音",
          maxSeconds: 3600,
          assistantReady: true,
        }
      : voiceStatus.data;
  const activeVoiceStatus = selectedVoiceStatus
    ? {
        ...selectedVoiceStatus,
        ready:
          !realtimeStatus.isLoading &&
          !realtimeStatus.error &&
          selectedVoiceStatus.ready,
      }
    : undefined;
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
    if (!value.trim() || !composerReady || busy) return;
    const requestId = crypto.randomUUID();
    if (teamMode) {
      setSection("team");
      setOpen(true);
      setSending(true);
      setTeamSubmitError("");
      voice.stop();
      speech.stop();
      try {
        const input: TeamRunCreate = {
          id: requestId,
          goal: value.trim(),
          attachmentIds: agent.attachments.map((file) => file.id),
          ...(teamModel ? { model: teamModel } : {}),
          useKnowledge,
        };
        const run = (
          await api("/my-workspace/assistant/team/runs", "POST", input)
        ).data as TeamRun;
        queryClient.setQueryData(["assistant-team-run", user.id, run.id], run);
        setSelectedTeamRunId(run.id);
        void queryClient.invalidateQueries({ queryKey: teamRunsKey(user.id) });
        setText("");
        setAgent((previous) => ({ ...previous, attachments: [] }));
      } catch (cause) {
        setTeamSubmitError((cause as Error).message);
      } finally {
        setSending(false);
      }
      return;
    }
    if (!data) return;
    const websiteRequest =
      !desktopDeviceId && !agent.attachments.length
        ? parseAssistantWebsiteRequest(value)
        : undefined;
    const webOpenResult = websiteRequest
      ? websiteRequest.destination
        ? openAssistantWebsite(websiteRequest.destination.url)
        : prepareAssistantWebsite(requestId)
      : undefined;
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
        requestId,
        includePersonalContext: includeContext,
        includeMemory,
        attachmentIds: agent.attachments.map((f) => f.id),
        desktopDeviceId,
        webOpenResult,
      });
      setText("");
      setAgent((previous) => ({ ...previous, attachments: [] }));
      void jobs.refetch();
      const latest = (response.data as AssistantConversation).messages?.at(-1);
      if (response.data.state === "IDLE" && latest?.role === "assistant") {
        const tool = available.find((entry) => entry.id === latest.navigation);
        if (tool) {
          navigate(tool.path);
          setOpen(false);
        }
        if (latest.desktopTaskId) {
          void desktop.refetch();
          setSection("desktop");
          setOpen(true);
        }
      }
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
      setError(
        (webOpenResult === "opened"
          ? "网页已打开，但对话保存失败："
          : webOpenResult === "requested"
            ? "已发出打开网页请求，但对话保存失败："
            : webOpenResult === "pending"
              ? "网站查询未完成，请关闭等待页后重试："
              : "") + (e as Error).message,
      );
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
      activeVoiceStatus?.ready &&
      !sending &&
      !executing &&
      data?.state !== "PENDING"
    )
      void gptVoice.start({
        includePersonalContext: includeContext,
        includeMemory,
        ...(useRealtime && desktopDeviceId ? { desktopDeviceId } : {}),
      });
    else if (!activeVoiceStatus?.ready) {
      void voiceStatus.refetch();
      void realtimeStatus.refetch();
    }
  };
  const openVoiceSettings = () => {
    closeVoice();
    voice.stop();
    speech.stop();
    setSection("voice");
    setOpen(true);
  };
  const openPanel = (tab: "chat" | "activity" | "voice" | "team" = "chat") => {
    if (tab === "voice") {
      startVoice();
      return;
    }
    closeVoice();
    voice.stop();
    speech.stop();
    if (tab === "team") {
      setTeamMode(true);
      setDesktopDeviceId(undefined);
    }
    if (tab === "chat") setTeamMode(false);
    setSection(allowed ? tab : "activity");
    setOpen(true);
  };
  const selectSection = (next: AssistantSection) => {
    playbackAllowed.current = false;
    closeVoice();
    voice.stop();
    speech.stop();
    setSection(allowed ? next : "activity");
    if (next === "team") {
      setTeamMode(true);
      setDesktopDeviceId(undefined);
    }
    if (next === "chat") setTeamMode(false);
    setOpen(true);
  };
  const sectionItems = [
    ...(allowed ? [{ key: "chat", label: "互动对话" }] : []),
    ...(allowed ? [{ key: "team", label: "智能体团队" }] : []),
    ...(allowed ? [{ key: "tasks", label: "任务与文件" }] : []),
    ...(allowed ? [{ key: "desktop", label: "电脑操作" }] : []),
    ...(allowed
      ? [{ key: "voice", label: "语音设置", disabled: sending || !!executing }]
      : []),
    { key: "activity", label: "动态反馈" },
    ...(allowed ? [{ key: "memory", label: "个人记忆" }] : []),
    ...(allowed ? [{ key: "settings", label: "对话设置" }] : []),
  ];
  const conversationSettings = (
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
      <Button style={{ marginTop: 20 }} onClick={() => selectSection("chat")}>
        返回对话
      </Button>
    </>
  );
  const sender = (inDrawer = false) => (
    <div
      className="assistant-compose"
      data-suppressed={!inDrawer && inWorkspace && open ? "true" : undefined}
      inert={!inDrawer && inWorkspace && open}
      aria-hidden={!inDrawer && inWorkspace && open ? true : undefined}
    >
      {teamMode && (
        <div className="assistant-compose-mode">
          <span>团队协作</span>
          <Button
            size="small"
            type="link"
            onClick={() => selectSection("team")}
          >
            管理团队
          </Button>
          <Button
            size="small"
            type="link"
            disabled={busy}
            onClick={() => {
              setTeamMode(false);
              setError("");
              if (inDrawer) setSection("chat");
            }}
          >
            返回个人助理
          </Button>
        </div>
      )}
      <Sender
        value={text}
        onChange={(value) => setText(value.slice(0, teamMode ? 8000 : 4000))}
        onSubmit={(value) => void send(value)}
        loading={busy}
        readOnly={busy}
        disabled={!composerReady || busy}
        submitType="enter"
        suffix={false}
        footer={(_, { components }) => (
          <AgentComposer
            value={agent}
            change={setAgent}
            disabled={busy}
            onUploading={setUploading}
            actions={
              <div className="assistant-send-actions">
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
                  <components.SendButton
                    aria-label={teamMode ? "提交团队任务" : "发送给个人助理"}
                    disabled={!text.trim() || !composerReady}
                  />
                )}
              </div>
            }
          />
        )}
        placeholder={
          teamMode
            ? composerReady
              ? "描述团队目标、交付要求和验收标准…"
              : teamConfig.isLoading
                ? "正在连接智能体团队…"
                : "团队智能服务尚未就绪，请检查团队配置"
            : data?.ready
              ? desktopDeviceId
                ? desktop.data?.devices?.find((d) => d.id === desktopDeviceId)
                    ?.crossWindowAuthorized
                  ? "描述电脑任务，小序将按设备授权执行…"
                  : "描述电脑任务，发送后在本机选择窗口…"
                : "告诉我你想完成什么，例如：打开经营分析…"
              : q.isLoading
                ? "正在连接个人助理…"
                : "AI 尚未就绪，可打开小序的文字对话查看原因"
        }
        autoSize={{ minRows: 2, maxRows: 5 }}
      />
      {teamMode && teamSubmitError && (
        <Alert type="error" showIcon title={teamSubmitError} />
      )}
      {desktopDeviceId && (
        <div className="assistant-desktop-note">
          <span>
            电脑操作 ·{" "}
            {desktop.data?.devices?.find(
              (device) => device.id === desktopDeviceId,
            )?.name || "所选电脑"}
            。仅发送本条指令，请移除附件。
          </span>
          <Button
            size="small"
            type="link"
            disabled={busy}
            onClick={() => setDesktopDeviceId(undefined)}
          >
            返回网站对话
          </Button>
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
        voiceStatus: activeVoiceStatus,
        voiceStatusError:
          realtimeStatus.error?.message ||
          (!useRealtime && voiceStatus.error?.message) ||
          "",
        voiceVisible,
        voiceExecutionLabel,
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
        aria-label="AI 个人助理"
        aria-labelledby=""
        closable={{ placement: "end" }}
        onClose={() => {
          playbackAllowed.current = false;
          setOpen(false);
          voice.stop();
          speech.stop();
        }}
        title={
          <span className="assistant-panel-heading">
            {section === "chat"
              ? "小序"
              : sectionItems.find((item) => item.key === section)?.label}
          </span>
        }
        size={1120}
        rootClassName={`personal-assistant-drawer assistant-screen${section === "team" ? " assistant-team-screen" : ""}`}
        classNames={{
          body:
            section === "chat"
              ? "assistant-chat-body"
              : "assistant-secondary-body",
        }}
        extra={
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                ...sectionItems,
                ...(section === "chat" && allowed
                  ? [
                      { type: "divider" as const },
                      {
                        key: "clear",
                        label: "清空对话",
                        icon: <DeleteOutlined aria-hidden />,
                        danger: true,
                        disabled: busy || !messages.length,
                      },
                    ]
                  : []),
              ],
              selectedKeys: [section],
              onClick: ({ key }) => {
                if (key !== "clear") {
                  selectSection(key as AssistantSection);
                  return;
                }
                if (busy || !messages.length || !allowed) return;
                modal.confirm({
                  title: "清空当前账号的助理对话？",
                  content:
                    "日程、待办、备忘和个人记忆不受影响，未执行的操作卡片将取消。",
                  okText: "清空",
                  cancelText: "取消",
                  okButtonProps: { danger: true },
                  onOk: async () => {
                    speech.stop();
                    try {
                      await api("/my-workspace/assistant/clear", "POST", {
                        version: data?.version || 0,
                      });
                      await q.refetch();
                      setError("");
                    } catch (e) {
                      message.error((e as Error).message);
                      throw e;
                    }
                  },
                });
              },
            }}
          >
            <Button
              type="text"
              className="assistant-panel-more"
              icon={<EllipsisOutlined />}
              aria-label="更多助理操作"
              title="更多"
            />
          </Dropdown>
        }
        footer={
          (section === "chat" || section === "team") && allowed
            ? sender(true)
            : null
        }
      >
        {allowed && section === "settings" && conversationSettings}
        {allowed && section === "team" && (
          <>
            <AssistantTeamPanel
              selectedRunId={selectedTeamRunId}
              selectRun={setSelectedTeamRunId}
            />
            <details className="assistant-team-task-settings">
              <summary>本次任务设置</summary>
              <Select
                size="small"
                aria-label="团队任务模型"
                allowClear
                value={teamModel}
                disabled={busy}
                loading={teamConfig.isLoading}
                popupMatchSelectWidth={false}
                placeholder="按成员配置"
                options={teamConfig.data?.models.map((model) => ({
                  value: model.id,
                  label: model.name + " · " + model.model,
                }))}
                onChange={setTeamModel}
              />
              <Checkbox
                checked={useKnowledge}
                disabled={busy}
                onChange={(event) => setUseKnowledge(event.target.checked)}
              >
                使用知识档案
              </Checkbox>
            </details>
          </>
        )}
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
            executionLabel={voiceExecutionLabel}
            realtime={realtimeStatus}
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
        {section === "desktop" && allowed && (
          <AssistantDesktopPanel
            data={desktop.data}
            error={desktop.error?.message || ""}
            refresh={() => void desktop.refetch()}
            choose={(id) => {
              setDesktopDeviceId(id);
              setSection("chat");
              setOpen(true);
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
            <span>{data?.ready ? "小序已就绪" : "小序暂未就绪"}</span>
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
                {item.role === "assistant" &&
                  item.webNavigation &&
                  assistantWebsiteUrl(item.webNavigation.url) && (
                    <div className="assistant-tool-links">
                      <a
                        href={assistantWebsiteUrl(item.webNavigation.url)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        打开{item.webNavigation.title}
                        <ArrowRightOutlined />
                      </a>
                    </div>
                  )}
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
                {item.desktopTaskId && (
                  <Button size="small" onClick={() => setSection("desktop")}>
                    查看电脑任务进度
                  </Button>
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

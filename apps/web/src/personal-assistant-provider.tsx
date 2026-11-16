import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
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
  AudioOutlined,
  DesktopOutlined,
  GlobalOutlined,
  CloseOutlined,
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
import {
  AssistantHubContext,
  type AssistantSection,
  type AssistantToolSection,
} from "./assistant-hub-context";
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
import type {
  AgentCatalog,
  AgentJob,
} from "../../../packages/contracts/src/assistant-agent";
import { AssistantModelPicker } from "./assistant-model-picker";
import { resolveAssistantModelPickerState } from "../../../packages/contracts/src/assistant-model-picker";
import { AssistantTeamMessage } from "./assistant-team-message";
import {
  AssistantEmployeesPanel,
  type EmployeeDraft,
} from "./assistant-employees";
import { assistantPublicText } from "../../../packages/contracts/src/ai-presentation";
import { AssistantBusinessResults } from "./assistant-business-results";
import { AssistantVoiceSettingsPanel } from "./assistant-realtime-panel";
import { useGptVoice } from "./use-gpt-voice";
import { useRealtimeVoice } from "./use-realtime-voice";
import { VoicePresentationPanel } from "./voice-presentation-panel";
import type { RealtimeStatus } from "../../../packages/contracts/src/assistant-realtime";
import { useGptSpeech } from "./use-gpt-speech";
import type { AssistantVoiceStatus } from "../../../packages/contracts/src/assistant-voice";
import { workspaceHologramEvent } from "./workspace-hologram";
import { workspaceTeamEvent } from "./workspace-team-navigation";
import { AssistantDesktopPanel } from "./assistant-desktop-panel";
import {
  AssistantBrowserPanel,
  AssistantBrowserTaskCard,
  isActiveBrowserTask,
} from "./assistant-browser-panel";
import type { BrowserState } from "../../../packages/contracts/src/assistant-browser";
import { desktopClientRequest, isDesktopClient } from "./desktop-client";
import {
  AssistantDesktopTaskCard,
  isActiveDesktopTask,
} from "./assistant-desktop-task-card";
import {
  connectAndAuthorizeDesktop,
  desktopSetupMessage,
} from "./desktop-setup";
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
import { useAssistantChatScroll } from "./assistant-chat-scroll";
import { SidebarAssistant } from "./sidebar-assistant";

const desktopSelectionKey = (userId: string) =>
  `xuti-assistant-desktop:${userId}`;
type DesktopChoice =
  { mode: "site" } | { mode: "browser" } | { mode: "device"; deviceId: string };
const desktopIdPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
function readDesktopSelection(userId: string): DesktopChoice {
  try {
    const stored = localStorage.getItem(desktopSelectionKey(userId));
    if (stored && desktopIdPattern.test(stored))
      return { mode: "device", deviceId: stored };
    const choice = stored ? JSON.parse(stored) : null;
    if (choice?.mode === "browser") return { mode: "browser" };
    if (choice?.mode === "dedicated")
      localStorage.removeItem(desktopSelectionKey(userId));
  } catch {
    /* A missing or invalid stored choice starts in the website. */
  }
  return { mode: "site" };
}

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
  const allowed = canUsePersonalAssistant({ permissions: user.permissions });
  const docked = inWorkspace && allowed;
  const [section, setSectionState] = useState<AssistantSection>("chat");
  const [workspaceTool, setWorkspaceTool] =
    useState<AssistantToolSection>("browser");
  const [workspaceChatOpen, setWorkspaceChatOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<string>();
  const [employeeDrafts, setEmployeeDrafts] = useState<
    Record<string, EmployeeDraft>
  >({});
  useEffect(() => {
    setSelectedEmployee(undefined);
    setEmployeeDrafts({});
  }, [user.id]);
  const [workspaceToolsOpen, setWorkspaceToolsOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(
        `xuti-workspace-tools-open:${user.id}`,
      );
      return saved === null
        ? window.matchMedia("(min-width: 1051px)").matches
        : saved !== "false";
    } catch {
      return window.matchMedia("(min-width: 1051px)").matches;
    }
  });
  const [workspaceToolsHost, setWorkspaceToolsHost] =
    useState<HTMLDivElement | null>(null);
  const [workspaceChatHost, setWorkspaceChatHost] =
    useState<HTMLDivElement | null>(null);
  const setToolsOpen = useCallback(
    (value: boolean) => {
      setWorkspaceToolsOpen(value);
      try {
        localStorage.setItem(
          `xuti-workspace-tools-open:${user.id}`,
          String(value),
        );
      } catch {
        /* Keep the current layout when storage is unavailable. */
      }
    },
    [user.id],
  );
  const setSection = useCallback(
    (next: AssistantSection) => {
      setSectionState(next);
      if (!docked) return;
      if (next === "chat") {
        setWorkspaceChatOpen(true);
        if (window.matchMedia("(max-width: 1050px)").matches)
          setToolsOpen(false);
      } else {
        setWorkspaceTool(next);
        setToolsOpen(true);
      }
    },
    [docked, setToolsOpen],
  );
  const panelSection = docked ? workspaceTool : section;
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
    setWorkspaceChatOpen(false);
    voice.stop();
    speech.stop();
    navigate("/my-workspace");
  };
  const [open, setOpen] = useState(false),
    [text, setText] = useState("");
  const previousWorkspace = useRef(inWorkspace);
  useEffect(() => {
    if (previousWorkspace.current && !inWorkspace) setOpen(false);
    previousWorkspace.current = inWorkspace;
  }, [inWorkspace]);
  const chatVisible = docked ? workspaceChatOpen : open && section === "chat";
  const sceneCovered = docked ? workspaceChatOpen : open;
  const toolsVisible = docked ? workspaceToolsOpen : open;
  useWorkspaceSceneCover(sceneCovered);
  const [includeContext, setIncludeContext] = useState(false),
    [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [agent, setAgent] = useState<AgentOptions>({
    attachments: [],
  });
  const [uploading, setUploading] = useState(false);
  const [chatModel, setChatModel] = useState<string>();
  const modelCatalog = useQuery({
    queryKey: ["assistant-capabilities", user.id],
    enabled: allowed,
    queryFn: async () =>
      (await api("/my-workspace/assistant/capabilities")).data as AgentCatalog,
    staleTime: 30000,
  });
  const [desktopSelection, setDesktopSelection] = useState(() => ({
    owner: user.id,
    choice: readDesktopSelection(user.id),
  }));
  const desktopChoice =
    desktopSelection.owner === user.id
      ? desktopSelection.choice
      : readDesktopSelection(user.id);
  const browserMode = desktopChoice.mode === "browser";
  const desktopMode = desktopChoice.mode === "device";
  const externalMode = desktopMode || browserMode;
  const desktopTargetId =
    desktopChoice.mode === "device" ? desktopChoice.deviceId : undefined;
  const nativeDesktop = isDesktopClient();
  const [localDesktopId, setLocalDesktopId] = useState<string>();
  useEffect(() => {
    if (!nativeDesktop) return;
    let current = true;
    void desktopClientRequest("status")
      .then((result) => {
        if (current)
          setLocalDesktopId(result.connected ? result.deviceId : undefined);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [nativeDesktop]);
  const [desktopConnecting, setDesktopConnecting] = useState(false);
  const [checkingVoiceTarget, setCheckingVoiceTarget] = useState(false);
  const voiceStartAttempt = useRef(0);
  const voiceStartPending = useRef(false);
  const [desktopSetupNote, setDesktopSetupNote] = useState("");
  const desktopSetupRunning = useRef(false);
  const desktopSetupLifecycle = useRef({ mounted: true, epoch: 0 });
  const currentOwner = useRef(user.id);
  currentOwner.current = user.id;
  useEffect(() => {
    desktopSetupLifecycle.current.mounted = true;
    return () => {
      desktopSetupLifecycle.current.mounted = false;
      desktopSetupLifecycle.current.epoch++;
    };
  }, []);
  const rememberDesktopChoice = (choice: DesktopChoice) => {
    setDesktopSelection({ owner: user.id, choice });
    try {
      if (choice.mode === "site")
        localStorage.removeItem(desktopSelectionKey(user.id));
      else
        localStorage.setItem(
          desktopSelectionKey(user.id),
          choice.mode === "device" ? choice.deviceId : JSON.stringify(choice),
        );
    } catch {
      /* The choice remains available for this page. */
    }
  };
  const rememberDesktop = (id?: string) =>
    rememberDesktopChoice(
      id ? { mode: "device", deviceId: id } : { mode: "site" },
    );
  const [teamMode, setTeamMode] = useState(false);
  useEffect(() => {
    if (teamMode) return;
    const next = resolveAssistantModelPickerState({
      catalog: modelCatalog.data,
      value: chatModel,
    });
    if (next.autoSwitched && next.selectedId && next.selectedId !== chatModel)
      setChatModel(next.selectedId);
  }, [teamMode, modelCatalog.data, chatModel]);
  const [teamModel, setTeamModel] = useState<string>();
  const [useKnowledge, setUseKnowledge] = useState(true);
  const [selectedTeamRunId, setSelectedTeamRunId] = useState<string>();
  const [teamSubmitError, setTeamSubmitError] = useState("");
  const teamConfig = useTeamConfiguration(
    allowed && (teamMode || panelSection === "team"),
  );
  const desktop = useQuery({
    queryKey: ["assistant-desktop", user.id],
    enabled: allowed,
    queryFn: async () =>
      (await api("/my-workspace/assistant/desktop")).data as DesktopState,
    refetchInterval: (query) =>
      (toolsVisible && panelSection === "desktop") ||
      desktopMode ||
      query.state.data?.tasks.some(isActiveDesktopTask)
        ? 4000
        : false,
    // Native execution moves focus away from this WebView; task progress must continue.
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
  const revealBrowserAfter = useRef<Set<string> | null>(null);
  const [selectedBrowserTaskId, setSelectedBrowserTaskId] = useState<string>();
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const [browserStarting, setBrowserStarting] = useState(false);
  const browser = useQuery({
    queryKey: ["assistant-browser", user.id],
    enabled: allowed,
    queryFn: async ({ signal }) => {
      const state = (
        await api(
          "/my-workspace/assistant/browser",
          "GET",
          undefined,
          undefined,
          { signal },
        )
      ).data as BrowserState;
      if (
        !state ||
        !Array.isArray(state.tasks) ||
        typeof state.ready !== "boolean"
      )
        throw new Error("暂时无法核对独立浏览器，请刷新后重试。");
      return state;
    },
    refetchInterval: (query) =>
      browserMode ||
      (toolsVisible && panelSection === "browser") ||
      query.state.data?.tasks.some(isActiveBrowserTask)
        ? 3000
        : false,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
  useEffect(() => {
    if (!browserMode || !browser.data || !revealBrowserAfter.current) return;
    const created = browser.data.tasks.find(
      (task) => !revealBrowserAfter.current!.has(task.id),
    );
    if (!created) return;
    revealBrowserAfter.current = new Set(
      browser.data.tasks.map((task) => task.id),
    );
    setSelectedBrowserTaskId(created.id);
    setSection("browser");
    setOpen(true);
  }, [browser.data, browserMode]);
  const activeBrowserTask = browser.data?.tasks.find(
    (task) => isActiveBrowserTask(task) && task.mode !== "BROWSE",
  );
  const browserProblem = !browserMode
    ? ""
    : browser.isPending
      ? "正在核对小序独立浏览器…"
      : browser.error
        ? "暂时无法核对独立浏览器，请刷新后重试；未切换执行位置。"
        : !browser.data?.ready
          ? browser.data?.note ||
            "小序独立浏览器尚未就绪；不会改到我的电脑或网站内执行。"
          : "";
  const desktopTarget = desktop.data?.devices.find(
    (device) => device.id === desktopTargetId,
  );
  const activeDesktopTask = desktop.data?.tasks.find(
    (task) => task.deviceId === desktopTargetId && isActiveDesktopTask(task),
  );
  // A remembered ID is only routed after the current account's server list confirms ownership.
  const desktopDeviceId = desktopTarget?.id;
  const desktopProblem = !desktopMode
    ? ""
    : desktop.isPending
      ? "正在核对已记住的电脑…"
      : desktop.error
        ? "暂时无法核对电脑连接，请刷新后重试。"
        : !desktopTarget
          ? "上次选择的电脑连接已失效，请重新连接或主动返回网站对话。"
          : !desktopTarget.online
            ? "所选电脑离线，请打开该电脑的小序桌面端。"
            : "";
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
  useEffect(() => {
    voice.stopListening();
  }, [location.pathname, voice.stopListening]);
  const speech = useGptSpeech();
  useEffect(() => {
    const showMedia = () => {
      document
        .querySelectorAll<HTMLVideoElement>(
          ".personal-assistant-drawer video, .workspace-inline-chat video",
        )
        .forEach((element) => element.pause());
      setOpen(false);
      setWorkspaceChatOpen(false);
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
  playbackAllowed.current = chatVisible && voiceReply;
  const memory = useQuery({
    queryKey: ["assistant-memory", user.id],
    enabled: allowed && (panelSection === "memory" || includeMemory),
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
  const pickerState = resolveAssistantModelPickerState({
    catalog: modelCatalog.data,
    value: chatModel,
    teamSelected: teamMode,
  });
  const modelHint = !teamMode && !externalMode ? pickerState.hint : "";
  const modelProblem =
    !teamMode && !externalMode && modelCatalog.data && !pickerState.selected
      ? pickerState.models.length
        ? "所选模型当前不可用，请重新选择或验证连接。"
        : "暂无已接通的聊天模型，请管理员检查连接。"
      : "";
  const composerReady = teamMode
    ? teamConfig.data?.ready
    : browserMode
      ? !!data && browser.data?.ready && !browserProblem
      : data?.ready && !modelProblem && !desktopProblem;
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
      void browser.refetch();
    },
    (toolId) => {
      const tool = available.find((item) => item.id === toolId);
      if (tool) navigate(tool.path);
    },
    realtimeStatus.data?.transport,
    realtimeStatus.data?.provider,
    {
      prepare: () => {
        setOpen(false);
        setWorkspaceChatOpen(false);
      },
      navigate: (path) => navigate(path),
    },
  );
  // A live call owns its transport until it ends, including configuration refetches.
  const useRealtime =
    realtimeVoice.active ||
    (!legacyVoice.active && !!realtimeStatus.data?.enabled);
  const gptVoice = useRealtime ? realtimeVoice : legacyVoice;
  useEffect(() => {
    const showTeam = () => {
      playbackAllowed.current = false;
      setOpen(false);
      setWorkspaceChatOpen(false);
      setVoiceVisible(false);
      voice.stopListening();
      speech.stop();
      gptVoice.stop();
    };
    window.addEventListener(workspaceTeamEvent, showTeam);
    return () => window.removeEventListener(workspaceTeamEvent, showTeam);
  }, [voice.stopListening, speech.stop, gptVoice.stop]);
  const activeVoiceDesktopLabel = useRef<string | undefined>(undefined);
  const selectedVoiceExecutionLabel =
    useRealtime && browserMode
      ? "小序独立浏览器"
      : useRealtime && desktopMode
        ? `我的电脑 · ${desktopTarget?.name || "尚未选择设备"}`
        : "网站内";
  const voiceExecutionLabel = gptVoice.active
    ? activeVoiceDesktopLabel.current || selectedVoiceExecutionLabel
    : selectedVoiceExecutionLabel;
  const selectedVoiceStatus =
    useRealtime && realtimeStatus.data
      ? {
          ...realtimeStatus.data,
          // The shared voice display does not carry provider-specific settings.
          provider: undefined,
          profiles: undefined,
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
    browserStarting ||
    desktopConnecting ||
    checkingVoiceTarget ||
    sending ||
    uploading ||
    data?.state === "PENDING" ||
    !!executing ||
    gptVoice.active;
  const executionBusy = useRef(false);
  executionBusy.current =
    browserStarting ||
    checkingVoiceTarget ||
    sending ||
    uploading ||
    data?.state === "PENDING" ||
    !!executing ||
    gptVoice.active ||
    voice.listening;
  const chooseDesktop = (id: string) => {
    if (executionBusy.current || desktopSetupRunning.current) return;
    const device = desktop.data?.devices.find((entry) => entry.id === id);
    if (!device?.online) return;
    rememberDesktopChoice({ mode: "device", deviceId: id });
    setTeamMode(false);
    setSection(docked ? "desktop" : "chat");
    setOpen(true);
  };
  const chooseBrowser = () => {
    if (executionBusy.current || desktopSetupRunning.current) return;
    rememberDesktopChoice({ mode: "browser" });
    setTeamMode(false);
    setSection(docked || !browser.data?.ready ? "browser" : "chat");
    setOpen(true);
  };
  const inspectBrowser = (id?: string) => {
    setSelectedBrowserTaskId(id);
    setSection("browser");
    setOpen(true);
  };
  const setupDesktop = async () => {
    if (!desktopSetupLifecycle.current.mounted || desktopSetupRunning.current)
      return;
    if (executionBusy.current) {
      setDesktopSetupNote("请先结束当前语音或等待发送完成，再选择操作电脑。");
      setSection("desktop");
      setOpen(true);
      return;
    }
    const owner = user.id;
    const epoch = desktopSetupLifecycle.current.epoch;
    const isCurrent = () =>
      desktopSetupLifecycle.current.mounted &&
      desktopSetupLifecycle.current.epoch === epoch &&
      currentOwner.current === owner;
    desktopSetupRunning.current = true;
    setDesktopConnecting(true);
    setDesktopSetupNote("");
    try {
      const latest = await desktop.refetch();
      if (!isCurrent()) return;
      if (latest.error || !latest.data)
        throw new Error("无法核对当前账号的电脑连接，请稍后重试。");
      if (executionBusy.current) {
        setDesktopSetupNote("请先结束当前语音或等待发送完成，再选择操作电脑。");
        return;
      }
      const result = await connectAndAuthorizeDesktop(
        latest.data.devices.map((device) => device.id),
        isCurrent,
      );
      if (!isCurrent()) return;
      const refreshed = await desktop.refetch();
      if (!isCurrent() || executionBusy.current) return;
      if (result.authorized === true) {
        if (
          refreshed.error ||
          !refreshed.data?.devices.some(
            (device) => device.id === result.deviceId,
          )
        )
          throw new Error("本机连接尚未同步，请稍后重试。");
        rememberDesktop(result.deviceId);
        setLocalDesktopId(result.deviceId);
        setTeamMode(false);
        setSection(docked ? "desktop" : "chat");
        setOpen(true);
        message.success("已选择本机，可以直接下达电脑操作指令");
      } else {
        setDesktopSetupNote(desktopSetupMessage(result.authorized));
        setSection("desktop");
        setOpen(true);
      }
    } catch (cause) {
      if (isCurrent()) {
        setDesktopSetupNote((cause as Error).message);
        setSection("desktop");
        setOpen(true);
      }
    } finally {
      if (isCurrent()) {
        desktopSetupRunning.current = false;
        setDesktopConnecting(false);
      }
    }
  };
  const setupDesktopRef = useRef(setupDesktop);
  setupDesktopRef.current = setupDesktop;
  useEffect(() => {
    if (!allowed || !nativeDesktop) return;
    const requestSetup = (event: Event) => {
      event.preventDefault();
      setSection("desktop");
      setOpen(true);
      void setupDesktopRef.current();
    };
    window.addEventListener("xuti-desktop-setup", requestSetup);
    return () => window.removeEventListener("xuti-desktop-setup", requestSetup);
  }, [allowed, nativeDesktop]);
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
  const liveCaptions = (voiceVisible ? gptVoice.captions : []).filter(
    (caption) =>
      !messages.some(
        (item) =>
          item.id === caption.id ||
          (!useRealtime &&
            item.role === caption.role &&
            item.text === caption.text),
      ),
  );
  useEffect(() => {
    if (!chatVisible) speech.stop();
  }, [chatVisible, speech.stop]);
  const [drawerSettled, setDrawerSettled] = useState(false);
  const [workspaceChatSettled, setWorkspaceChatSettled] = useState(false);
  // Pin history after the portal body has mounted and received its column height.
  useEffect(() => {
    setWorkspaceChatSettled(false);
    if (!docked || !workspaceChatOpen || !workspaceChatHost) return;
    const frame = requestAnimationFrame(() => setWorkspaceChatSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [docked, workspaceChatOpen, workspaceChatHost]);
  useAssistantChatScroll(
    chatVisible || (!docked && open && section === "browser"),
    docked ? workspaceChatSettled : drawerSettled,
    bottom,
    `${section}:${messages.length}:${Number(busy)}:${liveCaptions.at(-1)?.text || ""}:${Number(voiceVisible)}:${Number(q.isLoading)}`,
  );
  const send = async (value: string) => {
    if (!value.trim() || !composerReady || busy || voice.listening) return;
    const requestId = crypto.randomUUID();
    if (teamMode) {
      if (docked && !workspaceChatOpen) setSectionState("chat");
      else setSection("chat");
      // A task submitted from the workspace composer stays in its live scene.
      setOpen(open || location.pathname !== "/my-workspace");
      setSending(true);
      setTeamSubmitError("");
      voice.stop();
      speech.stop();
      try {
        const input: TeamRunCreate = {
          id: requestId,
          goal: value.trim(),
          attachmentIds: agent.attachments.map((file) => file.id),
          ...(teamModel && teamConfig.data?.engine !== "deerflow"
            ? { model: teamModel }
            : {}),
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
        await q.refetch();
      } catch (cause) {
        setTeamSubmitError((cause as Error).message);
      } finally {
        setSending(false);
      }
      return;
    }
    if (!data) return;
    const websiteRequest =
      !externalMode && !agent.attachments.length
        ? parseAssistantWebsiteRequest(value)
        : undefined;
    const webOpenResult = websiteRequest
      ? websiteRequest.destination
        ? openAssistantWebsite(websiteRequest.destination.url)
        : prepareAssistantWebsite(requestId)
      : undefined;
    if (docked || section !== "browser" || !browserMode) setSection("chat");
    setOpen(true);
    setSending(true);
    setError("");
    voice.stop();
    speech.stop();
    if (voiceReply && voiceStatus.data?.ready) speech.prepare();
    try {
      if (externalMode && agent.attachments.length)
        throw new Error("外部操作仅接收本条指令，请先移除附件后发送。");
      if (browserMode) {
        const epoch = desktopSetupLifecycle.current.epoch;
        const current = await browser.refetch();
        if (
          !desktopSetupLifecycle.current.mounted ||
          desktopSetupLifecycle.current.epoch !== epoch ||
          currentOwner.current !== user.id
        )
          return;
        if (current.error || !current.data?.ready)
          throw new Error(
            current.data?.note || "独立浏览器暂不可用，未切换到其他执行位置。",
          );
        if (
          current.data.tasks.some(
            (task) => isActiveBrowserTask(task) && task.mode !== "BROWSE",
          )
        ) {
          message.info(
            "已显示当前浏览器任务。指令已保留，请先继续或停止当前任务，无需重复发送。",
          );
          return;
        }
      }
      if (desktopDeviceId) {
        const current = await desktop.refetch();
        if (
          !desktopSetupLifecycle.current.mounted ||
          currentOwner.current !== user.id
        )
          return;
        if (current.error || !current.data)
          throw new Error("暂时无法核对电脑任务，请刷新后重试。");
        const currentDevice = current.data.devices.find(
          (device) => device.id === desktopDeviceId,
        );
        if (!currentDevice?.online)
          throw new Error(
            "所选电脑的连接已变化，请重新选择后发送；未切换到其他电脑。",
          );
        if (
          current.data.tasks.some(
            (task) =>
              task.deviceId === desktopDeviceId && isActiveDesktopTask(task),
          )
        ) {
          message.info(
            "已显示当前电脑任务。指令已保留，请继续或停止当前任务，无需重复发送。",
          );
          return;
        }
      }
      if (browserMode)
        revealBrowserAfter.current = new Set(
          (
            queryClient.getQueryData<BrowserState>([
              "assistant-browser",
              user.id,
            ])?.tasks || []
          ).map((task) => task.id),
        );
      const response = await api("/my-workspace/assistant", "POST", {
        message: value.trim(),
        version: data.version,
        requestId,
        includePersonalContext: externalMode ? false : includeContext,
        includeMemory: externalMode ? false : includeMemory,
        attachmentIds: agent.attachments.map((f) => f.id),
        ...(!externalMode && chatModel ? { model: chatModel } : {}),
        desktopDeviceId,
        ...(browserMode ? { browserExecution: true } : {}),
        webOpenResult,
      });
      if (!externalMode || response.data.state !== "FAILED") {
        setText("");
        setAgent((previous) => ({ ...previous, attachments: [] }));
      }
      void jobs.refetch();
      if (desktopDeviceId) await desktop.refetch();
      if (browserMode) await browser.refetch();
      const latest = (response.data as AssistantConversation).messages?.at(-1);
      if (browserMode && latest?.browserTaskId) {
        setSelectedBrowserTaskId(latest.browserTaskId);
        revealBrowserAfter.current = null;
        setSection("browser");
      }
      if (response.data.state === "IDLE" && latest?.role === "assistant") {
        const tool = available.find((entry) => entry.id === latest.navigation);
        if (tool) {
          navigate(tool.path);
          setOpen(false);
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
    voiceStartAttempt.current++;
    voiceStartPending.current = false;
    setCheckingVoiceTarget(false);
    gptVoice.stop();
    setVoiceVisible(false);
  };
  const startVoice = async () => {
    if (!allowed) return;
    // An existing call keeps its bound target and can always be interrupted.
    if (gptVoice.active) {
      if (gptVoice.state === "speaking") gptVoice.interrupt();
      setVoiceVisible(true);
      return;
    }
    if (voiceStartPending.current) return;
    if (desktopConnecting || desktopProblem || browserProblem) {
      message.info(desktopProblem || browserProblem || "请先完成本机连接");
      return;
    }
    if (!activeVoiceStatus?.ready) {
      void voiceStatus.refetch();
      void realtimeStatus.refetch();
      return;
    }
    if (sending || executing || uploading || data?.state === "PENDING") return;
    if (externalMode && !useRealtime) {
      message.info("外部操作请使用实时语音或文字输入。");
      return;
    }
    const attempt = ++voiceStartAttempt.current;
    const owner = user.id;
    const epoch = desktopSetupLifecycle.current.epoch;
    const capturedDeviceId = desktopDeviceId;
    const capturedMode = desktopChoice.mode;
    const isCurrent = () =>
      desktopSetupLifecycle.current.mounted &&
      desktopSetupLifecycle.current.epoch === epoch &&
      currentOwner.current === owner &&
      voiceStartAttempt.current === attempt;
    voiceStartPending.current = true;
    try {
      if (browserMode) {
        setCheckingVoiceTarget(true);
        const current = await browser.refetch();
        if (!isCurrent()) return;
        if (current.error || !current.data?.ready)
          throw new Error(
            current.data?.note || "独立浏览器暂不可用，未切换到其他执行位置。",
          );
      }
      if (desktopMode) {
        setCheckingVoiceTarget(true);
        const current = await desktop.refetch();
        if (!isCurrent()) return;
        const device = current.data?.devices.find(
          (entry) => entry.id === capturedDeviceId,
        );
        if (current.error || !device?.online)
          throw new Error(
            "所选电脑的连接已变化，请重新选择后开始语音；未切换到其他电脑。",
          );
      }
      if (!isCurrent()) return;
      if (browserMode)
        revealBrowserAfter.current = new Set(
          (
            queryClient.getQueryData<BrowserState>([
              "assistant-browser",
              user.id,
            ])?.tasks || []
          ).map((task) => task.id),
        );
      activeVoiceDesktopLabel.current = selectedVoiceExecutionLabel;
      voice.stop();
      speech.stop();
      // Starting or stopping a call never opens or closes the text chat panel.
      setVoiceVisible(true);
      await gptVoice.start({
        includePersonalContext: externalMode ? false : includeContext,
        includeMemory: externalMode ? false : includeMemory,
        ...(useRealtime && capturedMode === "browser"
          ? {
              browserExecution: true,
            }
          : {}),
        ...(useRealtime && capturedDeviceId
          ? { desktopDeviceId: capturedDeviceId }
          : {}),
      });
    } catch (cause) {
      if (isCurrent()) message.info((cause as Error).message);
    } finally {
      if (isCurrent()) {
        voiceStartPending.current = false;
        setCheckingVoiceTarget(false);
      }
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
    if (tab === "team" && busy) return;
    if (tab === "voice") {
      startVoice();
      return;
    }
    if (tab !== "chat" || !gptVoice.active) closeVoice();
    voice.stop();
    speech.stop();
    if (tab === "team") {
      setTeamMode(true);
      rememberDesktop();
    }
    setSection(allowed ? (tab === "team" ? "chat" : tab) : "activity");
    setOpen(true);
  };
  const selectSection = (next: AssistantSection) => {
    if ((next === "team" || next === "desktop") && busy) return;
    playbackAllowed.current = false;
    closeVoice();
    voice.stop();
    speech.stop();
    setSection(allowed ? next : "activity");
    if (next === "team") {
      setTeamMode(true);
      rememberDesktop();
    }
    setOpen(true);
  };
  const consumedAssistantLink = useRef("");
  useEffect(() => {
    if (!allowed || location.pathname !== "/my-workspace") return;
    const params = new URLSearchParams(location.search);
    const target = params.get("assistant");
    if (
      ![
        "chat",
        "team",
        "desktop",
        "browser",
        "voice",
        "tasks",
        "employees",
      ].includes(target || "") ||
      consumedAssistantLink.current === location.key
    )
      return;
    consumedAssistantLink.current = location.key;
    const connect = target === "desktop" && params.get("connect") === "1";
    params.delete("assistant");
    params.delete("connect");
    navigate(
      {
        pathname: location.pathname,
        search: params.toString() ? `?${params}` : "",
        hash: location.hash,
      },
      { replace: true },
    );
    // A settings deep link never starts recording or opens a voice session.
    if (target === "voice") openVoiceSettings();
    else if (target === "desktop") {
      if (connect && nativeDesktop) {
        setSection("desktop");
        setOpen(true);
        // Start after StrictMode's mount cleanup, while the link is consumed once.
        const owner = user.id;
        queueMicrotask(() => {
          if (
            desktopSetupLifecycle.current.mounted &&
            currentOwner.current === owner
          )
            void setupDesktopRef.current();
        });
      } else selectSection("desktop");
    } else if (target === "browser") selectSection("browser");
    else if (target === "employees") selectSection("employees");
    else if (target === "tasks") selectSection("tasks");
    else openPanel(target === "team" ? "team" : "chat");
    // React to navigation, not to changing voice/session state.
  }, [location.key, location.pathname, location.search, allowed]);
  const sectionItems = [
    ...(allowed ? [{ key: "chat", label: "聊天" }] : []),
    ...(allowed ? [{ key: "team", label: "团队设置" }] : []),
    ...(allowed ? [{ key: "employees", label: "AI 员工" }] : []),
    ...(allowed ? [{ key: "tasks", label: "任务与文件" }] : []),
    ...(allowed ? [{ key: "desktop", label: "我的电脑" }] : []),
    ...(allowed ? [{ key: "browser", label: "独立浏览器" }] : []),
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
  const executionLabel = teamMode
    ? "智能体团队"
    : browserMode
      ? "小序独立浏览器"
      : desktopMode
        ? `我的电脑 · ${desktopTarget?.name || "尚未选择设备"}`
        : "网站内";
  const changeExecution = (value: string) => {
    if (busy || voice.listening) return;
    if (value === "site") {
      rememberDesktop();
      setTeamMode(false);
    } else if (value === "browser") chooseBrowser();
    else if (value === "computer") {
      if (nativeDesktop) void setupDesktop();
      else if (desktopTarget?.online) chooseDesktop(desktopTarget.id);
      else selectSection("desktop");
    }
  };
  const executionOptions = [
    { value: "site", label: "网站内" },
    { value: "browser", label: "小序独立浏览器" },
    { value: "computer", label: "我的电脑" },
  ];
  const executionSelector = (
    <Select
      size="small"
      variant={docked ? "borderless" : "outlined"}
      aria-label="执行位置"
      value={
        teamMode ? undefined : desktopMode ? "computer" : desktopChoice.mode
      }
      placeholder={teamMode ? "智能体团队" : undefined}
      disabled={busy || voice.listening}
      loading={desktopConnecting}
      options={executionOptions}
      onChange={changeExecution}
    />
  );
  const sender = (inDrawer = false) => (
    <div
      className="assistant-compose"
      data-suppressed={
        !inDrawer && inWorkspace && sceneCovered ? "true" : undefined
      }
      inert={!inDrawer && inWorkspace && sceneCovered}
      aria-hidden={!inDrawer && inWorkspace && sceneCovered ? true : undefined}
    >
      {!teamMode && activeDesktopTask && (
        <AssistantDesktopTaskCard
          task={activeDesktopTask}
          device={desktopTarget}
          localDeviceId={localDesktopId}
          compact
          refresh={() => desktop.refetch()}
        />
      )}
      {!teamMode &&
        browserMode &&
        activeBrowserTask &&
        !(toolsVisible && panelSection === "browser") && (
          <AssistantBrowserTaskCard
            task={activeBrowserTask}
            compact
            refresh={() => browser.refetch()}
            inspect={() => inspectBrowser(activeBrowserTask.id)}
          />
        )}
      {!docked && (
        <div className="assistant-desktop-entry">
          {executionSelector}
          <Button
            size="small"
            icon={<GlobalOutlined aria-hidden />}
            disabled={busy || voice.listening}
            onClick={() => (browserMode ? inspectBrowser() : chooseBrowser())}
          >
            独立浏览器
          </Button>
          <Button
            size="small"
            icon={<DesktopOutlined aria-hidden />}
            loading={desktopConnecting}
            disabled={busy || voice.listening}
            onClick={() => {
              if (nativeDesktop) void setupDesktop();
              else if (desktopTarget?.online) chooseDesktop(desktopTarget.id);
              else selectSection("desktop");
            }}
          >
            我的电脑
          </Button>
        </div>
      )}
      <Sender
        value={text}
        onChange={(value) => setText(value.slice(0, teamMode ? 8000 : 4000))}
        onSubmit={(value) => void send(value)}
        loading={busy}
        readOnly={busy || voice.listening}
        disabled={!composerReady || busy}
        submitType="enter"
        suffix={false}
        footer={(_, { components }) => (
          <AgentComposer
            value={agent}
            change={setAgent}
            disabled={busy || voice.listening}
            onUploading={setUploading}
            menuCurrent={docked ? executionLabel : undefined}
            menu={
              docked
                ? {
                    className: "assistant-compose-menu",
                    selectable: true,
                    selectedKeys: teamMode
                      ? []
                      : [desktopMode ? "computer" : desktopChoice.mode],
                    items: [
                      {
                        key: "execution",
                        type: "group",
                        label: `执行位置 · 当前：${executionLabel}`,
                        children: executionOptions.map((option) => ({
                          key: option.value,
                          label: option.label,
                        })),
                      },
                    ],
                    onClick: ({ key }) => changeExecution(key),
                  }
                : undefined
            }
            actions={
              <div className="assistant-send-actions">
                {!externalMode && (
                  <AssistantModelPicker
                    catalog={modelCatalog.data}
                    value={chatModel}
                    onChange={(value) => {
                      setChatModel(value);
                      setTeamMode(false);
                    }}
                    teamSelected={teamMode}
                    selectTeam={() => {
                      setTeamMode(true);
                      rememberDesktop();
                    }}
                    disabled={busy || voice.listening}
                    loading={modelCatalog.isFetching}
                    failed={!!modelCatalog.error}
                    refresh={() => void modelCatalog.refetch()}
                  />
                )}
                <Button
                  type="text"
                  shape="circle"
                  className="assistant-dictation-button"
                  icon={voice.listening ? <StopOutlined /> : <AudioOutlined />}
                  aria-label={
                    voice.listening
                      ? voice.phase === "recording"
                        ? "停止听写"
                        : "取消听写"
                      : "语音输入"
                  }
                  aria-pressed={voice.listening}
                  title={
                    voice.listening
                      ? "结束或取消听写"
                      : "语音输入 · 转成文字后发送"
                  }
                  disabled={busy}
                  onClick={() => {
                    speech.stop();
                    voice.start(text, teamMode ? 8000 : 4000);
                  }}
                />
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
                {gptVoice.active ? (
                  <Button
                    type="primary"
                    shape="circle"
                    className="assistant-voice-button"
                    aria-label="结束语音对话"
                    title="结束语音对话"
                    onClick={closeVoice}
                  >
                    <StopOutlined />
                  </Button>
                ) : busy ? (
                  <Button
                    loading
                    disabled
                    shape="circle"
                    aria-label="助理正在回复"
                  />
                ) : text.trim() ? (
                  <components.SendButton
                    aria-label={teamMode ? "提交团队任务" : "发送给个人助理"}
                    disabled={!text.trim() || !composerReady || voice.listening}
                  />
                ) : (
                  <Button
                    type="primary"
                    shape="circle"
                    className="assistant-voice-button"
                    aria-label="开始语音对话"
                    title={useRealtime ? "实时语音对话" : "语音对话"}
                    disabled={
                      voice.listening || !!desktopProblem || !!browserProblem
                    }
                    onClick={startVoice}
                  >
                    <svg
                      viewBox="0 0 20 20"
                      width="20"
                      height="20"
                      aria-hidden="true"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                    >
                      <path d="M3 8v4M6.5 5v10M10 3v14M13.5 6v8M17 8v4" />
                    </svg>
                  </Button>
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
                : "团队智能服务尚未就绪，请查看面板提示"
            : data?.ready || (browserMode && browser.data?.ready)
              ? browserMode
                ? "描述网页目标，小序将在独立浏览器中连续操作…"
                : desktopMode
                  ? desktop.data?.devices?.find((d) => d.id === desktopDeviceId)
                      ?.crossWindowAuthorized
                    ? "描述电脑任务，小序将按设备授权执行…"
                    : "描述电脑任务，发送后在所选电脑允许…"
                  : "告诉我你想完成什么，例如：打开经营分析…"
              : q.isLoading
                ? "正在连接个人助理…"
                : "AI 尚未就绪，可打开小序的文字对话查看原因"
        }
        autoSize={{ minRows: 2, maxRows: 5 }}
      />
      {voice.listening && (
        <div className="assistant-voice-status" role="status">
          <i />
          <i />
          <i />
          {voice.note}
        </div>
      )}
      {voice.error && (
        <div className="assistant-voice-error" role="alert">
          {voice.error}
        </div>
      )}
      {modelProblem && (
        <div className="assistant-voice-error" role="alert">
          {modelProblem}
        </div>
      )}
      {!modelProblem && modelHint && (
        <div className="assistant-model-hint" role="status">
          {modelHint}
        </div>
      )}
      {teamMode && teamSubmitError && (
        <Alert type="error" showIcon title={teamSubmitError} />
      )}
      {teamMode && !teamConfig.isLoading && !teamConfig.data?.ready && (
        <Alert
          type="warning"
          title={
            teamConfig.error?.message ||
            teamConfig.data?.notice ||
            "团队服务尚未就绪，请检查团队设置"
          }
        />
      )}
      {!docked && desktopMode && (
        <div className="assistant-desktop-note">
          <span>
            我的电脑 · {desktopTarget?.name || "尚未选择设备"}
            。仅发送本条指令，请移除附件。
            {desktopTarget &&
              !desktopTarget.crossWindowAuthorized &&
              " 设备授权尚未开启，任务需在所选电脑允许。"}
          </span>
          <Button
            size="small"
            type="link"
            disabled={busy}
            onClick={() => rememberDesktop()}
          >
            返回网站对话
          </Button>
        </div>
      )}
      {desktopProblem && <Alert type="warning" title={desktopProblem} />}
      {!docked && browserMode && (
        <div className="assistant-desktop-note">
          <span>
            小序独立浏览器 ·
            仅发送本条指令，请移除附件。需要你处理时可查看画面并接管。
          </span>
          <Button
            size="small"
            type="link"
            disabled={busy}
            onClick={() => rememberDesktop()}
          >
            返回网站对话
          </Button>
        </div>
      )}
      {browserProblem && <Alert type="warning" title={browserProblem} />}
    </div>
  );
  const panelMenu = (
    <Dropdown
      trigger={["click"]}
      menu={{
        items: [
          ...sectionItems,
          ...((docked || section === "chat") && allowed
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
              "清除聊天中的文字、语音和团队卡片。日程、待办、记忆和团队任务档案保留；运行中的团队任务不会因此停止，未执行的操作卡片将取消。",
            okText: "清空",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
              closeVoice();
              speech.stop();
              try {
                await api("/my-workspace/assistant/clear", "POST", {
                  version: data?.version || 0,
                });
                setSelectedTeamRunId(undefined);
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
  );
  const panels = (
    <>
      {allowed && panelSection === "employees" && (
        <AssistantEmployeesPanel
          key={user.id}
          selected={selectedEmployee}
          select={setSelectedEmployee}
          drafts={employeeDrafts}
          setDrafts={setEmployeeDrafts}
        />
      )}
      {allowed && panelSection === "settings" && conversationSettings}
      {allowed && panelSection === "team" && (
        <>
          <AssistantTeamPanel
            selectedRunId={selectedTeamRunId}
            selectRun={setSelectedTeamRunId}
          />
          <details className="assistant-team-task-settings">
            <summary>本次任务设置</summary>
            {teamConfig.data?.engine !== "deerflow" && (
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
            )}
            <Checkbox
              checked={useKnowledge}
              disabled={busy}
              onChange={(event) => setUseKnowledge(event.target.checked)}
            >
              使用知识档案
            </Checkbox>
          </details>
          <Button
            onClick={() => {
              setSection("chat");
              setTeamMode(true);
            }}
          >
            返回聊天并使用团队
          </Button>
        </>
      )}
      {toolsVisible && panelSection === "voice" && allowed && (
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
      {panelSection === "memory" && allowed && (
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
      {panelSection === "tasks" && allowed && (
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
      {panelSection === "desktop" && allowed && (
        <AssistantDesktopPanel
          open={toolsVisible && (docked || drawerSettled)}
          data={desktop.data}
          error={desktop.error?.message || ""}
          refresh={() => desktop.refetch()}
          choose={chooseDesktop}
          connectLocal={() => void setupDesktop()}
          connecting={desktopConnecting}
          disabled={busy || voice.listening}
          setupNote={desktopSetupNote}
          selectedId={desktopTargetId}
        />
      )}
      {panelSection === "browser" && allowed && (
        <AssistantBrowserPanel
          key={user.id}
          open={toolsVisible && (docked || drawerSettled)}
          owner={user.id}
          data={browser.data}
          error={browser.error?.message}
          refresh={() => browser.refetch()}
          choose={chooseBrowser}
          disabled={busy || voice.listening}
          selectedId={selectedBrowserTaskId}
          selectTask={setSelectedBrowserTaskId}
          returnToChat={() =>
            docked ? setToolsOpen(false) : setSection("chat")
          }
          embedded={docked}
          expanded={browserExpanded}
          toggleExpanded={() => setBrowserExpanded((value) => !value)}
          onSubmitting={setBrowserStarting}
          onStarted={(task) => {
            rememberDesktopChoice({ mode: "browser" });
            setTeamMode(false);
            setSelectedBrowserTaskId(task.id);
          }}
        />
      )}
      {panelSection === "activity" && (
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
    </>
  );
  const chatContent = (
    <>
      {allowed &&
        chatVisible &&
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
      <div
        className={
          !docked && section === "browser"
            ? "assistant-browser-chat"
            : undefined
        }
        hidden={(!docked && !["chat", "browser"].includes(section)) || !allowed}
      >
        <div
          className={
            !docked && section === "browser"
              ? "assistant-browser-chat-scroll assistant-chat-body"
              : undefined
          }
        >
          <div className="assistant-status">
            <span>
              {browserMode
                ? browser.data?.ready
                  ? "独立浏览器已就绪"
                  : "独立浏览器暂未就绪"
                : data?.ready
                  ? "小序已就绪"
                  : "小序暂未就绪"}
            </span>
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
          {!browserMode && !q.isLoading && data && !data.ready && (
            <Alert
              type="warning"
              title={
                data.availabilityMessage || "请管理员启用并验证 AI 模型连接"
              }
            />
          )}
          {!messages.length && !liveCaptions.length && !voiceVisible && (
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
            {messages.map((item) =>
              item.teamRunId ? (
                <AssistantTeamMessage key={item.id} id={item.teamRunId} />
              ) : (
                <div
                  key={item.id}
                  className={`assistant-message assistant-message-${item.role}`}
                >
                  <Bubble
                    placement={item.role === "user" ? "end" : "start"}
                    variant={item.role === "user" ? "filled" : "borderless"}
                    header={
                      (item.role === "user" ? "你" : "小序") +
                      (item.source === "voice"
                        ? " · 语音"
                        : item.source === "team"
                          ? " · 团队任务"
                          : "")
                    }
                    content={
                      <div className="assistant-message-text">
                        {item.role === "assistant"
                          ? assistantPublicText(item.text)
                          : item.text}
                        {item.role === "assistant" && item.notice ? (
                          <div className="assistant-model-hint">
                            {item.notice}
                          </div>
                        ) : null}
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
                      setMemorySuggestion({
                        ...entry,
                        id: crypto.randomUUID(),
                      });
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
                  {item.browserTaskId &&
                    item.browserTaskId !==
                      (browserMode ? activeBrowserTask?.id : undefined) &&
                    (() => {
                      const task = browser.data?.tasks.find(
                        (entry) => entry.id === item.browserTaskId,
                      );
                      return task ? (
                        <AssistantBrowserTaskCard
                          task={task}
                          refresh={() => browser.refetch()}
                          inspect={() => inspectBrowser(task.id)}
                        />
                      ) : (
                        <Button
                          size="small"
                          onClick={() => inspectBrowser(item.browserTaskId)}
                        >
                          查看浏览器任务进度
                        </Button>
                      );
                    })()}
                  {item.desktopTaskId &&
                    item.desktopTaskId !== activeDesktopTask?.id &&
                    (() => {
                      const task = desktop.data?.tasks.find(
                        (entry) => entry.id === item.desktopTaskId,
                      );
                      return task ? (
                        <AssistantDesktopTaskCard
                          task={task}
                          localDeviceId={localDesktopId}
                          device={desktop.data?.devices.find(
                            (entry) => entry.id === task.deviceId,
                          )}
                          refresh={() => desktop.refetch()}
                        />
                      ) : (
                        <Button
                          size="small"
                          onClick={() => setSection("desktop")}
                        >
                          查看电脑任务进度
                        </Button>
                      );
                    })()}
                </div>
              ),
            )}
            {liveCaptions.map((caption) => (
              <Bubble
                key={caption.id}
                placement={caption.role === "user" ? "end" : "start"}
                variant={caption.role === "user" ? "filled" : "borderless"}
                header={caption.role === "user" ? "你 · 语音" : "小序 · 语音"}
                content={
                  <div className="assistant-message-text">{caption.text}</div>
                }
              />
            ))}
            {voiceVisible && <div className="assistant-chat-voice-slot" />}
            {busy && !gptVoice.active && (
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
        {!docked && section === "browser" && allowed && (
          <div className="assistant-browser-chat-compose">{sender(true)}</div>
        )}
      </div>
    </>
  );
  return (
    <AssistantHubContext.Provider
      value={{
        allowed,
        conversation: data,
        busy,
        selectedTeamRunId,
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
        workbench: allowed
          ? {
              toolsOpen: workspaceToolsOpen,
              chatOpen: workspaceChatOpen,
              tool: workspaceTool,
              setToolsOpen,
              selectTool: setSection,
              openEmployee: (id) => {
                setSelectedEmployee(id);
                setSection("employees");
              },
              registerTools: setWorkspaceToolsHost,
              registerChat: setWorkspaceChatHost,
            }
          : undefined,
      }}
    >
      {children}
      <VoicePresentationPanel
        voiceActive={realtimeVoice.active}
        speaking={realtimeVoice.state === "speaking"}
        caption={realtimeVoice.captions
          .filter((caption) => caption.role === "assistant")
          .at(-1)}
      />
      {docked &&
        workspaceToolsHost &&
        createPortal(
          <div className="workspace-tool-panels" data-tool={panelSection}>
            {panels}
          </div>,
          workspaceToolsHost,
        )}
      {docked &&
        workspaceChatHost &&
        workspaceChatOpen &&
        createPortal(
          <section
            className="workspace-inline-chat assistant-screen"
            role="dialog"
            aria-modal={false}
            aria-label="AI 个人助理"
          >
            <header className="workspace-inline-chat-header">
              <span className="assistant-panel-heading">
                <SidebarAssistant compact />
                <span>小序</span>
              </span>
              <div>
                {panelMenu}
                <Button
                  type="text"
                  className="ant-drawer-close"
                  aria-label="收起文字对话"
                  title="返回工作台场景"
                  icon={<CloseOutlined />}
                  onClick={() => {
                    setWorkspaceChatOpen(false);
                    setOpen(false);
                    voice.stop();
                    speech.stop();
                  }}
                />
              </div>
            </header>
            <div className="workspace-inline-chat-scroll assistant-chat-body ant-drawer-body">
              {chatContent}
            </div>
            <div className="workspace-inline-chat-footer ant-drawer-footer">
              {sender(true)}
            </div>
          </section>,
          workspaceChatHost,
        )}
      {!docked && (
        <Drawer
          open={open}
          aria-label="AI 个人助理"
          aria-labelledby=""
          closable={{ placement: "end" }}
          afterOpenChange={setDrawerSettled}
          onClose={() => {
            playbackAllowed.current = false;
            setOpen(false);
            voice.stop();
            speech.stop();
          }}
          title={
            <span className="assistant-panel-heading">
              {allowed && <SidebarAssistant compact />}
              <span className="assistant-panel-title">
                {section === "chat"
                  ? "小序"
                  : sectionItems.find((item) => item.key === section)?.label}
              </span>
            </span>
          }
          size={1120}
          rootClassName={`personal-assistant-drawer assistant-screen${section === "team" ? " assistant-team-screen" : ""}${section === "browser" ? ` assistant-browser-workspace${browserExpanded ? " assistant-browser-expanded" : ""}` : ""}`}
          classNames={{
            body:
              section === "browser"
                ? "assistant-browser-body"
                : section === "chat"
                  ? "assistant-chat-body"
                  : "assistant-secondary-body",
          }}
          extra={panelMenu}
          footer={section === "chat" && allowed ? sender(true) : null}
        >
          {panels}
          {chatContent}
        </Drawer>
      )}
    </AssistantHubContext.Provider>
  );
}

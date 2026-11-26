import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentRef,
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
  Tabs,
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
  classifyAssistantExecution,
  isNativeDesktopAppCommand,
  shouldSearchAssistantPublicWeb,
} from "../../../packages/contracts/src/assistant-execution";
import {
  AssistantHubContext,
  assistantToolGroup,
  workspaceMoreTools,
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
  AssistantKnowledgePanel,
  type KnowledgeTarget,
} from "./assistant-knowledge-panel";
import {
  AgentComposer,
  AgentMessageResults,
  AgentTasksPanel,
  type AgentOptions,
} from "./assistant-agent-panel";
import { AssistantArtifactPreview } from "./assistant-artifact-preview";
import {
  canRecoverAssistantSend,
  recoverAssistantSend,
} from "./assistant-send-recovery";
import type {
  AgentCatalog,
  AgentFile,
  AgentJob,
} from "../../../packages/contracts/src/assistant-agent";
import { AssistantModelPicker } from "./assistant-model-picker";
import { resolveAssistantModelPickerState } from "../../../packages/contracts/src/assistant-model-picker";
import { AssistantCollaborationHistory } from "./assistant-team-panel";
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
  desktopReceiverProblem,
  desktopSetupMessage,
  readNativeWorkbenchDevice,
} from "./desktop-setup";
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
const preferredDesktopKey = (userId: string) =>
  `xuti-assistant-preferred-desktop:${userId}`;
const currentBrowserPagePrefix = "在小序独立浏览器中操作当前网页：";
const currentLocalPagePrefix = "在小序本地浏览器中操作当前网页：";
const browserPagePrefixes = [currentBrowserPagePrefix, currentLocalPagePrefix];
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
function readAssistantDesktopChoices(userId: string) {
  const choice = readDesktopSelection(userId);
  let preferredDeviceId =
    choice.mode === "device" ? choice.deviceId : undefined;
  try {
    const stored = localStorage.getItem(preferredDesktopKey(userId));
    if (stored && desktopIdPattern.test(stored)) preferredDeviceId = stored;
  } catch {
    /* Keep the existing device choice when storage is unavailable. */
  }
  return { owner: userId, choice, preferredDeviceId };
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
  const [knowledgeTarget, setKnowledgeTarget] = useState<KnowledgeTarget>();
  const consumeKnowledgeCreate = useCallback((key: string) => {
    setKnowledgeTarget((current) =>
      current?.key === key && current.destination === "new" ? { key } : current,
    );
  }, []);
  const [employeeDrafts, setEmployeeDrafts] = useState<
    Record<string, EmployeeDraft>
  >({});
  const draftOwner = useRef(user.id);
  useEffect(() => {
    if (draftOwner.current === user.id) return;
    draftOwner.current = user.id;
    setSelectedEmployee(undefined);
    setEmployeeDrafts({});
    setWorkspaceToolsOpen(false);
  }, [user.id]);
  // 进入或刷新「我的工作台」时右侧工具栏默认保持收起状态，不再从本地存储自动展开。
  const [workspaceToolsOpen, setWorkspaceToolsOpen] = useState(false);
  const [workspaceToolsHost, setWorkspaceToolsHost] =
    useState<HTMLDivElement | null>(null);
  const [workspaceChatHost, setWorkspaceChatHost] =
    useState<HTMLDivElement | null>(null);
  const setToolsOpen = useCallback((value: boolean) => {
    setWorkspaceToolsOpen(value);
  }, []);
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
  const chatSender = useRef<ComponentRef<typeof Sender>>(null);
  const [artifactPreview, setArtifactPreview] = useState<{
    owner: string;
    file: AgentFile;
    returnTo:
      | { tool: Exclude<AssistantToolSection, "artifact">; open: boolean }
      | { section: Exclude<AssistantSection, "artifact"> };
  }>();
  const openArtifactPreview = useCallback(
    (file: AgentFile) => {
      setArtifactPreview((previous) => {
        if (
          panelSection === "artifact" &&
          previous &&
          previous.owner === user.id
        )
          return { ...previous, file };
        return {
          owner: user.id,
          file,
          returnTo: docked
            ? {
                tool: workspaceTool === "artifact" ? "tasks" : workspaceTool,
                open: workspaceToolsOpen,
              }
            : { section: section === "artifact" ? "chat" : section },
        };
      });
      if (docked) {
        setWorkspaceTool("artifact");
        setToolsOpen(true);
      } else {
        setSectionState("artifact");
        setOpen(true);
      }
    },
    [
      docked,
      panelSection,
      section,
      setToolsOpen,
      user.id,
      workspaceTool,
      workspaceToolsOpen,
    ],
  );
  const closeArtifactPreview = () => {
    const returnTo = artifactPreview?.returnTo;
    setArtifactPreview(undefined);
    if (docked && returnTo && "tool" in returnTo) {
      setWorkspaceTool(returnTo.tool);
      setToolsOpen(returnTo.open);
    } else if (!docked) {
      setSectionState(
        returnTo && "section" in returnTo ? returnTo.section : "chat",
      );
    }
  };
  const previousWorkspace = useRef(inWorkspace);
  useEffect(() => {
    if (previousWorkspace.current && !inWorkspace) {
      setOpen(false);
      setWorkspaceToolsOpen(false);
    }
    previousWorkspace.current = inWorkspace;
  }, [inWorkspace]);
  const chatVisible = docked ? workspaceChatOpen : open && section === "chat";
  const sceneCovered = docked ? workspaceChatOpen : open;
  const toolsVisible = docked ? workspaceToolsOpen : open;
  useWorkspaceSceneCover(sceneCovered);
  const [includeContext, setIncludeContext] = useState(false),
    [sending, setSending] = useState(false);
  const [checkingSend, setCheckingSend] = useState(false);
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
  const [desktopSelection, setDesktopSelection] = useState(() =>
    readAssistantDesktopChoices(user.id),
  );
  const { choice: desktopChoice, preferredDeviceId } =
    desktopSelection.owner === user.id
      ? desktopSelection
      : readAssistantDesktopChoices(user.id);
  const browserMode = !docked && desktopChoice.mode === "browser";
  const desktopMode = !docked && desktopChoice.mode === "device";
  const externalMode = desktopMode || browserMode;
  const nativeDesktop = isDesktopClient();
  const localClient = useQuery({
    queryKey: ["assistant-desktop-local", user.id],
    enabled: allowed && nativeDesktop,
    queryFn: ({ signal }) => desktopClientRequest("status", undefined, signal),
    refetchOnWindowFocus: "always",
    refetchInterval: toolsVisible && panelSection === "desktop" ? 10000 : false,
    retry: false,
  });
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
    if (docked && choice.mode !== "device") return;
    setDesktopSelection({
      owner: user.id,
      choice: docked ? desktopChoice : choice,
      preferredDeviceId:
        choice.mode === "device" ? choice.deviceId : preferredDeviceId,
    });
    try {
      if (choice.mode === "device")
        localStorage.setItem(preferredDesktopKey(user.id), choice.deviceId);
      if (docked) return;
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
  useEffect(() => {
    const next = resolveAssistantModelPickerState({
      catalog: modelCatalog.data,
      value: chatModel,
    });
    if (next.autoSwitched && next.selectedId && next.selectedId !== chatModel)
      setChatModel(next.selectedId);
  }, [modelCatalog.data, chatModel]);
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
  const localDesktopId = localClient.data?.connected
    ? localClient.data.deviceId
    : undefined;
  const localDevice = desktop.data?.devices.find(
    (device) => device.id === localDesktopId,
  );
  const implicitLocalId =
    localClient.data?.authorized && localDevice?.crossWindowAuthorized
      ? localDesktopId
      : undefined;
  const desktopTargetId = docked
    ? (preferredDeviceId ?? implicitLocalId)
    : desktopChoice.mode === "device"
      ? desktopChoice.deviceId
      : undefined;
  const nativePreference = useRef(desktopTargetId);
  nativePreference.current =
    docked && nativeDesktop ? desktopTargetId : undefined;
  const isNativeAppRequest = (value: string) =>
    docked && nativeDesktop && isNativeDesktopAppCommand(value);
  const verifiedNativeDevice = async (selected?: string) => {
    if (!selected || selected !== nativePreference.current) return undefined;
    const verified = await readNativeWorkbenchDevice(selected);
    return selected === nativePreference.current ? verified : undefined;
  };
  const revealBrowserAfter = useRef<Set<string> | null>(null);
  const [browserSelection, setBrowserSelection] = useState<{
    id?: string;
    cloud?: true;
  }>({});
  const setSelectedBrowserTaskId = useCallback(
    (id?: string) => setBrowserSelection({ id }),
    [],
  );
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
    (task) =>
      (docked || task.deviceId === desktopTargetId) &&
      isActiveDesktopTask(task),
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
          : desktopReceiverProblem(desktopTarget, localClient.data);
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
  });
  const modelHint = !externalMode ? pickerState.hint : "";
  const modelProblem =
    !externalMode && modelCatalog.data && !pickerState.selected
      ? pickerState.models.length
        ? "所选模型当前不可用，请重新选择或验证连接。"
        : "暂无已接通的聊天模型，请管理员检查连接。"
      : "";
  const shouldSearch = (value: string) =>
    !externalMode &&
    !agent.attachments.length &&
    shouldSearchAssistantPublicWeb(value);
  const draftIsPublicSearch = shouldSearch(text);
  const draftRoute = docked ? classifyAssistantExecution(text) : undefined;
  const draftUsesNativeApp = isNativeAppRequest(text);
  const draftIsSite =
    !draftIsPublicSearch &&
    (!docked || (!draftUsesNativeApp && draftRoute?.kind === "site"));
  const receiverReady =
    desktopTarget?.engineReady === true &&
    !desktopReceiverProblem(desktopTarget, localClient.data);
  const desktopOnlyPrompt =
    docked &&
    receiverReady &&
    (!data?.ready || !!modelProblem) &&
    (!text.trim() ||
      draftUsesNativeApp ||
      (draftRoute?.kind === "desktop" &&
        (!draftRoute.deviceName ||
          draftRoute.deviceName === desktopTarget?.name)));
  const showChatModel = !externalMode && draftIsSite && !desktopOnlyPrompt;
  const composerReady = draftIsPublicSearch
    ? !!data
    : docked
      ? !!data &&
        !browserPagePrefixes.includes(text.trim()) &&
        (!draftIsSite || (data.ready && !modelProblem))
      : browserMode
        ? !!data && browser.data?.ready && !browserProblem
        : desktopMode
          ? !!data && !desktopProblem
          : data?.ready && !modelProblem;
  const canEditComposer = docked || !externalMode ? !!data : composerReady;
  const showVoiceTask = (result?: {
    browserTaskId?: string;
    desktopTaskId?: string;
  }) => {
    if (!docked) return;
    if (result?.browserTaskId) {
      setSelectedBrowserTaskId(result.browserTaskId);
      setSection("browser");
      setOpen(true);
    } else if (result?.desktopTaskId) {
      setSection("desktop");
      setOpen(true);
    }
  };
  const legacyVoice = useGptVoice(
    (result) => {
      void q.refetch();
      void activity.refetch();
      if (result?.browserTaskId) void browser.refetch();
      if (result?.desktopTaskId) void desktop.refetch();
      showVoiceTask(result);
    },
    (toolId) => {
      const tool = available.find((item) => item.id === toolId);
      if (tool) navigate(tool.path);
    },
  );
  const realtimeVoice = useRealtimeVoice(
    (result) => {
      void q.refetch();
      void activity.refetch();
      void desktop.refetch();
      void browser.refetch();
      showVoiceTask(result);
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
  const activeVoiceDesktopLabel = useRef<string | undefined>(undefined);
  const selectedVoiceExecutionLabel = docked
    ? "自动选择"
    : useRealtime && browserMode
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
  const openDesktopComposer = () => {
    setDesktopSetupNote("");
    setSection("chat");
    setOpen(true);
    requestAnimationFrame(() => chatSender.current?.focus());
  };
  const chooseDesktop = (id: string) => {
    if (executionBusy.current || desktopSetupRunning.current) return;
    const device = desktop.data?.devices.find((entry) => entry.id === id);
    if (!device) return;
    const problem = desktopReceiverProblem(device, localClient.data);
    if (problem) {
      setDesktopSetupNote(problem);
      setSection("desktop");
      setOpen(true);
      return;
    }
    rememberDesktop(id);
    openDesktopComposer();
  };
  const stageBrowserDraft = (prefix: string) => {
    if (executionBusy.current || desktopSetupRunning.current) return;
    const existingPrefix = browserPagePrefixes.find((entry) =>
      text.startsWith(entry),
    );
    const draft = existingPrefix ? text.slice(existingPrefix.length) : text;
    if (draft.length + prefix.length > 4000) {
      message.info("请缩短草稿后再添加当前网页的操作目标");
      return;
    }
    setText(`${prefix}${draft}`);
    setSection("chat");
    setOpen(true);
  };
  const chooseBrowser = () => {
    if (docked) {
      stageBrowserDraft(currentBrowserPagePrefix);
      return;
    }
    if (executionBusy.current || desktopSetupRunning.current) return;
    rememberDesktopChoice({ mode: "browser" });
    if (!browser.data?.ready) setBrowserSelection({ cloud: true });
    setSection(browser.data?.ready ? "chat" : "browser");
    setOpen(true);
  };
  const chooseLocalBrowser = () => {
    if (executionBusy.current || desktopSetupRunning.current) return;
    if (!localDesktopId || localDesktopId !== desktopTargetId) {
      message.info(
        "请在「我的电脑」连接这台电脑并设为常用电脑，再操作本地网页",
      );
      setSection("desktop");
      setOpen(true);
      return;
    }
    stageBrowserDraft(currentLocalPagePrefix);
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
        const device = refreshed.data?.devices.find(
          (d) => d.id === result.deviceId,
        );
        if (refreshed.error || !device)
          throw new Error("本机连接尚未同步，请稍后重试。");
        if (!device.crossWindowAuthorized)
          throw new Error("本机授权尚未同步，请在「电脑任务」核对授权状态。");
        rememberDesktop(result.deviceId);
        queryClient.setQueryData(["assistant-desktop-local", owner], result);
        const problem = desktopReceiverProblem(device, result);
        if (problem) {
          setSection("desktop");
          setOpen(true);
          return;
        }
        openDesktopComposer();
        message.success(
          docked
            ? "已选择本机，可在小序输入框直接下达电脑指令"
            : "已选择本机，可以直接下达电脑操作指令",
        );
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
    if (!data) return;
    const publicSearch = shouldSearch(value);
    const execution =
      docked && !publicSearch ? classifyAssistantExecution(value) : undefined;
    const target = execution?.kind;
    const nativeAppRequest = isNativeAppRequest(value);
    const siteRequest =
      !publicSearch &&
      !externalMode &&
      !nativeAppRequest &&
      (!target || target === "site");
    const externalRequest =
      externalMode ||
      nativeAppRequest ||
      target === "browser" ||
      target === "desktop";
    const websiteRequest =
      siteRequest && !agent.attachments.length
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
    const epoch = desktopSetupLifecycle.current.epoch;
    const isCurrent = () =>
      desktopSetupLifecycle.current.mounted &&
      desktopSetupLifecycle.current.epoch === epoch &&
      currentOwner.current === user.id;
    try {
      if (externalRequest && agent.attachments.length)
        throw new Error("外部操作仅接收本条指令，请先移除附件后发送。");
      if (
        execution?.kind === "desktop" &&
        !execution.deviceName &&
        localDevice &&
        desktopTargetId === localDevice.id &&
        localClient.data?.engineReady === false
      )
        throw new Error(desktopReceiverProblem(localDevice, localClient.data));
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
      if (desktopMode && desktopDeviceId) {
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
        if (!currentDevice)
          throw new Error(
            "所选电脑的连接已变化，请重新选择后发送；未切换到其他电脑。",
          );
        const problem = desktopReceiverProblem(currentDevice, localClient.data);
        if (problem) throw new Error(problem);
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
      const nativeDesktopDeviceId = nativeAppRequest
        ? await verifiedNativeDevice(desktopTargetId)
        : undefined;
      if (!isCurrent()) return;
      if (nativeAppRequest && !nativeDesktopDeviceId)
        throw new Error(
          (localDevice &&
            desktopReceiverProblem(localDevice, localClient.data)) ||
            "请在「我的电脑」检查本机连接和授权。已选择其他常用电脑时，请在指令中写明目标电脑。",
        );
      const input = {
        message: value.trim(),
        version: data.version,
        requestId,
        includePersonalContext: siteRequest && includeContext,
        includeMemory: siteRequest && includeMemory,
        attachmentIds: agent.attachments.map((f) => f.id),
        ...(siteRequest && chatModel ? { model: chatModel } : {}),
        desktopDeviceId: docked ? desktopTargetId : desktopDeviceId,
        ...(nativeDesktopDeviceId ? { nativeDesktopDeviceId } : {}),
        ...(docked ? { autoExecution: true } : {}),
        ...(browserMode ? { browserExecution: true } : {}),
        webOpenResult,
      };
      const submittedAt = Date.now();
      const { conversation, reply } = await api(
        "/my-workspace/assistant",
        "POST",
        input,
      )
        .then(({ data }: { data: AssistantConversation }) => ({
          conversation: data,
          reply: data.messages.at(-1),
        }))
        .catch(async (cause) => {
          if (!isCurrent() || !canRecoverAssistantSend(cause)) throw cause;
          setCheckingSend(true);
          const recovered = await recoverAssistantSend({
            requestId,
            submittedAt,
            isCurrent,
            read: async () => {
              const result = await q.refetch();
              return result.isSuccess ? result.data.data : undefined;
            },
          });
          if (!recovered) throw cause;
          return recovered;
        });
      if (!isCurrent()) return;
      const latest = reply;
      const createdTask = latest?.browserTaskId || latest?.desktopTaskId;
      const latestIsCurrent = conversation.messages.at(-1)?.id === latest?.id;
      if (
        siteRequest &&
        conversation.state === "FAILED" &&
        latest?.role !== "assistant" &&
        (input.model ?? modelCatalog.data?.defaultModel)?.startsWith("agentai/")
      )
        void modelCatalog.refetch();
      if (
        (conversation.state !== "FAILED" ||
          (!latestIsCurrent && latest?.role === "assistant")) &&
        (publicSearch || siteRequest || !docked || createdTask)
      ) {
        setText((current) => (current.trim() === input.message ? "" : current));
        setAgent((previous) => ({
          ...previous,
          attachments: previous.attachments.filter(
            (file) => !input.attachmentIds.includes(file.id),
          ),
        }));
      }
      void jobs.refetch();
      const conversationIdle = conversation.state === "IDLE" && latestIsCurrent;
      if (desktopMode || latest?.desktopTaskId) await desktop.refetch();
      if (browserMode || latest?.browserTaskId) await browser.refetch();
      if (!isCurrent()) return;
      if (conversationIdle && latest?.browserTaskId) {
        setSelectedBrowserTaskId(latest.browserTaskId);
        revealBrowserAfter.current = null;
        setSection("browser");
      } else if (docked && conversationIdle && latest?.desktopTaskId) {
        setSection("desktop");
      }
      if (conversationIdle && latest?.role === "assistant") {
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
        conversationIdle
      )
        void speech.read(latest.id);
      else speech.stop();
    } catch (e) {
      if (!isCurrent()) return;
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
      if (isCurrent()) {
        if (!playbackAllowed.current) speech.stop();
        setCheckingSend(false);
        setSending(false);
        await q.refetch();
      }
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
    const capturedDeviceId = docked ? desktopTargetId : desktopDeviceId;
    const isCurrent = () =>
      desktopSetupLifecycle.current.mounted &&
      desktopSetupLifecycle.current.epoch === epoch &&
      currentOwner.current === owner &&
      voiceStartAttempt.current === attempt;
    voiceStartPending.current = true;
    try {
      const checkNativeTarget = docked && nativeDesktop && !!capturedDeviceId;
      if (checkNativeTarget) setCheckingVoiceTarget(true);
      const nativeDesktopDeviceId = checkNativeTarget
        ? await verifiedNativeDevice(capturedDeviceId)
        : undefined;
      if (!isCurrent()) return;
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
        if (current.error || !device)
          throw new Error(
            "所选电脑的连接已变化，请重新选择后开始语音；未切换到其他电脑。",
          );
        const problem = desktopReceiverProblem(device, localClient.data);
        if (problem) throw new Error(problem);
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
        ...(docked ? { autoExecution: true as const } : {}),
        ...(nativeDesktopDeviceId ? { nativeDesktopDeviceId } : {}),
        ...(useRealtime && browserMode ? { browserExecution: true } : {}),
        ...((docked || useRealtime) && capturedDeviceId
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
  const openPanel = (tab: "chat" | "activity" | "voice" = "chat") => {
    if (tab === "voice") {
      startVoice();
      return;
    }
    if (tab !== "chat" || !gptVoice.active) closeVoice();
    voice.stop();
    speech.stop();
    setSection(allowed ? tab : "activity");
    setOpen(true);
  };
  const selectSection = (next: AssistantSection) => {
    if (next === "desktop" && busy) return;
    if (next === "browser" && !docked) setSelectedBrowserTaskId();
    playbackAllowed.current = false;
    closeVoice();
    voice.stop();
    speech.stop();
    setSection(allowed ? next : "activity");
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
        "knowledge",
      ].includes(target || "") ||
      consumedAssistantLink.current === location.key
    )
      return;
    consumedAssistantLink.current = location.key;
    const connect = target === "desktop" && params.get("connect") === "1";
    if (target === "knowledge") {
      const id = params.get("note");
      const version = Number(params.get("version"));
      setKnowledgeTarget(
        id
          ? {
              destination: {
                id,
                version:
                  Number.isSafeInteger(version) && version > 0
                    ? version
                    : undefined,
              },
              key: location.key,
            }
          : undefined,
      );
      params.delete("note");
      params.delete("version");
    }
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
    else if (target === "team" || target === "employees") {
      setSelectedEmployee(undefined);
      selectSection("employees");
    } else if (target === "knowledge") selectSection("knowledge");
    else if (target === "tasks") selectSection("tasks");
    else openPanel("chat");
    // React to navigation, not to changing voice/session state.
  }, [location.key, location.pathname, location.search, allowed]);
  const sectionItems = !allowed
    ? [{ key: "activity", label: "动态反馈" }]
    : [
        ...(!docked
          ? [
              { key: "chat", label: "聊天" },
              { key: "employees", label: "AI 员工" },
              { key: "desktop", label: "我的电脑" },
              { key: "browser", label: "浏览器" },
            ]
          : []),
        ...workspaceMoreTools,
      ];
  const panelGroup = allowed ? assistantToolGroup(panelSection) : panelSection;
  const switchGroupTab = (key: string) => {
    if (docked) setSection(key as AssistantSection);
    else selectSection(key as AssistantSection);
  };
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
  const changeExecution = (value: string) => {
    if (busy || voice.listening) return;
    if (value === "site") {
      rememberDesktop();
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
      value={desktopMode ? "computer" : desktopChoice.mode}
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
      {activeDesktopTask && (
        <AssistantDesktopTaskCard
          task={activeDesktopTask}
          device={desktop.data?.devices.find(
            (device) => device.id === activeDesktopTask.deviceId,
          )}
          localDeviceId={localDesktopId}
          compact
          refresh={() => desktop.refetch()}
        />
      )}
      {(docked || browserMode) &&
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
            onClick={() => selectSection("browser")}
          >
            浏览器
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
        ref={inDrawer ? chatSender : undefined}
        value={text}
        onChange={(value) => setText(value.slice(0, 4000))}
        onSubmit={(value) => void send(value)}
        loading={busy}
        readOnly={busy || voice.listening}
        disabled={!canEditComposer || busy}
        submitType="enter"
        suffix={false}
        footer={(_, { components }) => (
          <AgentComposer
            value={agent}
            change={setAgent}
            disabled={busy || voice.listening}
            onUploading={setUploading}
            actions={
              <div className="assistant-send-actions">
                {!externalMode && !desktopOnlyPrompt && (
                  <AssistantModelPicker
                    catalog={modelCatalog.data}
                    value={chatModel}
                    onChange={setChatModel}
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
                    voice.start(text, 4000);
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
                    aria-label="发送给个人助理"
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
          desktopOnlyPrompt
            ? "告诉我你想完成什么，例如：在我的电脑上打开记事本…"
            : data?.ready ||
                desktopMode ||
                draftIsPublicSearch ||
                ((docked || browserMode) && browser.data?.ready)
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
      {draftIsPublicSearch && sending && (
        <div className="assistant-model-hint" role="status">
          正在搜索公开网页…
        </div>
      )}
      {showChatModel && modelProblem && (
        <div className="assistant-voice-error" role="alert">
          {modelProblem}
        </div>
      )}
      {showChatModel && !modelProblem && modelHint && (
        <div className="assistant-model-hint" role="status">
          {modelHint}
        </div>
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
        selectedKeys: [panelGroup],
        onClick: ({ key }) => {
          if (key !== "clear") {
            selectSection(key as AssistantSection);
            return;
          }
          if (busy || !messages.length || !allowed) return;
          modal.confirm({
            title: "清空当前账号的助理对话？",
            content:
              "清除聊天中的文字、语音和历史协作卡片。日程、待办、记忆和任务档案保留，未执行的操作卡片将取消。",
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
  const activityPanel = (
    <AssistantActivityPanel
      feed={activity.data}
      loading={activity.isFetching}
      error={activity.error}
      seen={seen}
      markSeen={markSeen}
      refresh={() => void activity.refetch()}
      onNavigate={() => setOpen(false)}
    />
  );
  const panels = (
    <>
      {allowed &&
        toolsVisible &&
        panelSection === "artifact" &&
        artifactPreview &&
        artifactPreview.owner === user.id && (
          <AssistantArtifactPreview
            key={artifactPreview.file.id}
            file={artifactPreview.file}
            onClose={closeArtifactPreview}
          />
        )}
      {allowed && panelSection === "employees" && (
        <AssistantEmployeesPanel
          key={user.id}
          selected={selectedEmployee}
          select={setSelectedEmployee}
          drafts={employeeDrafts}
          setDrafts={setEmployeeDrafts}
        />
      )}
      {allowed && panelSection === "knowledge" && (
        <AssistantKnowledgePanel
          key={`${user.id}:${knowledgeTarget?.key || ""}`}
          target={knowledgeTarget}
          consumeCreate={consumeKnowledgeCreate}
        />
      )}
      {allowed && panelGroup === "settings" && (
        <Tabs
          size="small"
          activeKey={panelSection}
          onChange={switchGroupTab}
          items={[
            {
              key: "settings",
              label: "对话设置",
              children: conversationSettings,
            },
            {
              key: "voice",
              label: "语音设置",
              disabled: !docked && (sending || !!executing),
              children: toolsVisible && (
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
              ),
            },
            {
              key: "memory",
              label: "个人记忆",
              children: (
                <AssistantMemoryPanel
                  data={memory.data}
                  loading={memory.isFetching}
                  error={memory.error}
                  save={saveMemory}
                  refresh={() => void memory.refetch()}
                  suggestion={memorySuggestion}
                  clearSuggestion={() => setMemorySuggestion(null)}
                />
              ),
            },
          ]}
        />
      )}
      {allowed && panelGroup === "tasks" && (
        <Tabs
          size="small"
          activeKey={panelSection}
          onChange={switchGroupTab}
          items={[
            {
              key: "tasks",
              label: "任务与文件",
              children: (
                <>
                  <AssistantCollaborationHistory key={user.id} />
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
                          ...previous.attachments.filter(
                            (f) => f.id !== file.id,
                          ),
                          file,
                        ],
                      }));
                      setSection("chat");
                    }}
                  />
                </>
              ),
            },
            { key: "activity", label: "动态反馈", children: activityPanel },
          ]}
        />
      )}
      {panelSection === "desktop" && allowed && (
        <AssistantDesktopPanel
          open={toolsVisible && (docked || drawerSettled)}
          data={desktop.data}
          client={localClient.data}
          clientError={localClient.error?.message}
          error={desktop.error?.message || ""}
          refresh={() =>
            Promise.all([
              desktop.refetch(),
              ...(nativeDesktop ? [localClient.refetch()] : []),
            ])
          }
          choose={chooseDesktop}
          compose={openDesktopComposer}
          connectLocal={() => void setupDesktop()}
          connecting={desktopConnecting}
          disabled={busy || voice.listening}
          setupNote={desktopSetupNote}
          selectedId={desktopTargetId}
          preferredId={preferredDeviceId}
          automatic={docked}
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
          chooseLocal={docked ? chooseLocalBrowser : undefined}
          disabled={busy || voice.listening}
          selection={browserSelection}
          selectTask={setSelectedBrowserTaskId}
          returnToChat={() =>
            docked ? setToolsOpen(false) : setSection("chat")
          }
          embedded={docked}
          expanded={browserExpanded}
          toggleExpanded={() => setBrowserExpanded((value) => !value)}
          onSubmitting={setBrowserStarting}
          onStarted={(task) => setSelectedBrowserTaskId(task.id)}
        />
      )}
      {!allowed && panelSection === "activity" && activityPanel}
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
                : desktopMode || desktopOnlyPrompt
                  ? receiverReady
                    ? `电脑可接收任务 · ${desktopTarget?.name}`
                    : "我的电脑"
                  : data?.ready
                    ? "小序已就绪"
                    : "普通对话暂未就绪"}
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
          {showChatModel && !q.isLoading && data && !data.ready && (
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
              <p>
                {desktopOnlyPrompt
                  ? "在下方输入框描述要在电脑上执行的任务。"
                  : "说出问题，查库存、跟项目、看任务，也能记住你的工作偏好。"}
              </p>
              {(desktopOnlyPrompt
                ? ["在我的电脑上打开记事本"]
                : [
                    "帮我安排明天下午3点的选款会",
                    "查看我参与的项目进度",
                    "查看最近的同步任务结果",
                  ]
              ).map((prompt) => (
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
                      (docked || browserMode
                        ? activeBrowserTask?.id
                        : undefined) &&
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
            {checkingSend ? (
              <div className="assistant-status" role="status">
                <Spin size="small" />
                <span>正在核对发送结果…</span>
              </div>
            ) : busy && !gptVoice.active ? (
              <Bubble
                loading
                content=""
                header="助理正在回复…"
                variant="borderless"
              />
            ) : null}
            {!checkingSend && (error || data?.error) && (
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
        previewArtifact: allowed ? openArtifactPreview : undefined,
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
              openKnowledge: (destination) => {
                setKnowledgeTarget({ destination, key: crypto.randomUUID() });
                setSection("knowledge");
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
                  : section === "artifact"
                    ? "文件预览"
                    : sectionItems.find((item) => item.key === panelGroup)
                        ?.label}
              </span>
            </span>
          }
          size={1120}
          rootClassName={`personal-assistant-drawer assistant-screen${section === "browser" ? ` assistant-browser-workspace${browserExpanded ? " assistant-browser-expanded" : ""}` : ""}`}
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

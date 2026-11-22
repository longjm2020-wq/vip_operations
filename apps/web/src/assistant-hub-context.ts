import { createContext, useContext, type ReactNode } from "react";
import type { AssistantConversation } from "../../../packages/contracts/src/personal-assistant";
import type { AssistantActivityFeed } from "../../../packages/contracts/src/assistant-activity";
import type { AgentFile } from "../../../packages/contracts/src/assistant-agent";
import type { WorkspaceSchedule } from "../../../packages/contracts/src/personal-workspace";
import type { AssistantVoiceStatus } from "../../../packages/contracts/src/assistant-voice";
import type { useGptVoice, VoiceState } from "./use-gpt-voice";

export type AssistantSection =
  | "chat"
  | "activity"
  | "memory"
  | "voice"
  | "tasks"
  | "artifact"
  | "desktop"
  | "browser"
  | "employees"
  | "knowledge"
  | "settings";
export type AssistantToolSection = Exclude<AssistantSection, "chat">;

export const workspaceMoreTools = [
  { key: "knowledge", label: "公司知识库" },
  { key: "tasks", label: "任务与文件" },
  { key: "settings", label: "助理设置" },
] satisfies { key: AssistantToolSection; label: string }[];

export function assistantToolGroup(section: AssistantSection) {
  if (section === "voice" || section === "memory") return "settings";
  if (section === "activity") return "tasks";
  return section;
}

export type AssistantHubState = {
  allowed: boolean;
  conversation?: AssistantConversation;
  busy: boolean;
  voiceState?: Exclude<VoiceState, "idle">;
  gptVoice: Omit<ReturnType<typeof useGptVoice>, "play"> & {
    play: () => void;
    realtime?: boolean;
  };
  voiceStatus?: AssistantVoiceStatus;
  voiceStatusError: string;
  voiceVisible: boolean;
  voiceExecutionLabel?: string;
  startVoice: () => void;
  closeVoice: () => void;
  openVoiceSettings: () => void;
  announce?: (text: string) => void;
  compose: () => ReactNode;
  openPanel: (tab?: "chat" | "activity" | "voice") => void;
  previewArtifact?: (file: AgentFile) => void;
  feed?: AssistantActivityFeed;
  feedLoading: boolean;
  feedError: Error | null;
  seen: string[];
  pendingSchedules: WorkspaceSchedule[];
  consumeSchedule: (id: string) => void;
  setDraftSchedule: (value: WorkspaceSchedule[] | null) => void;
  workbench?: {
    toolsOpen: boolean;
    chatOpen: boolean;
    tool: AssistantToolSection;
    setToolsOpen: (open: boolean) => void;
    selectTool: (tool: AssistantToolSection) => void;
    openEmployee: (id?: string) => void;
    openKnowledge: (destination?: "new" | { id: string }) => void;
    registerTools: (host: HTMLDivElement | null) => void;
    registerChat: (host: HTMLDivElement | null) => void;
  };
};
export const AssistantHubContext = createContext<AssistantHubState | null>(
  null,
);
export function useAssistantHub() {
  const state = useContext(AssistantHubContext);
  if (!state) throw new Error("Assistant hub provider missing");
  return state;
}

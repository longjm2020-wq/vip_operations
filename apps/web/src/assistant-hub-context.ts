import { createContext, useContext, type ReactNode } from "react";
import type { AssistantConversation } from "../../../packages/contracts/src/personal-assistant";
import type { AssistantActivityFeed } from "../../../packages/contracts/src/assistant-activity";
import type { WorkspaceSchedule } from "../../../packages/contracts/src/personal-workspace";
import type { AssistantVoiceStatus } from "../../../packages/contracts/src/assistant-voice";
import type { useGptVoice, VoiceState } from "./use-gpt-voice";

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
  feed?: AssistantActivityFeed;
  feedLoading: boolean;
  feedError: Error | null;
  seen: string[];
  pendingSchedules: WorkspaceSchedule[];
  consumeSchedule: (id: string) => void;
  setDraftSchedule: (value: WorkspaceSchedule[] | null) => void;
};
export const AssistantHubContext = createContext<AssistantHubState | null>(
  null,
);
export function useAssistantHub() {
  const state = useContext(AssistantHubContext);
  if (!state) throw new Error("Assistant hub provider missing");
  return state;
}

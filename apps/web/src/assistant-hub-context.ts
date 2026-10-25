import { createContext, useContext, type ReactNode } from "react";
import type { AssistantConversation } from "../../../packages/contracts/src/personal-assistant";
import type { AssistantActivityFeed } from "../../../packages/contracts/src/assistant-activity";
import type { WorkspaceSchedule } from "../../../packages/contracts/src/personal-workspace";

export type AssistantHubState = {
  allowed: boolean;
  conversation?: AssistantConversation;
  busy: boolean;
  compose: () => ReactNode;
  openPanel: (tab?: "chat" | "activity") => void;
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

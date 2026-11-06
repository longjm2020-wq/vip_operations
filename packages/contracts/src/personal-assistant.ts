import { z } from "zod";
import { agentModelId, type AgentFile } from "./assistant-agent.js";
import type { AssistantWebCommand } from "./assistant-web-command.js";
import {
  workspaceScheduleSchema,
  type WorkspaceActor,
  type WorkspaceSchedule,
} from "./personal-workspace.js";

export function canUsePersonalAssistant(actor: WorkspaceActor) {
  const p = actor.permissions;
  return (
    (p.includes("analytics.read") && p.includes("analytics.manage")) ||
    (p.includes("product.read") && p.includes("product.update")) ||
    (p.includes("selection.read") && p.includes("selection.manage"))
  );
}
export const assistantSendSchema = z
  .object({
    message: z.string().trim().min(1).max(4000),
    version: z.number().int().min(0),
    requestId: z.string().uuid(),
    includePersonalContext: z.boolean(),
    includeMemory: z.boolean().default(false),
    model: agentModelId.optional(),
    imageModel: agentModelId.optional(),
    attachmentIds: z.array(z.string().uuid()).max(6).default([]),
    webSearch: z.boolean().default(false),
    desktopDeviceId: z.string().uuid().optional(),
    webOpenResult: z.enum(["opened", "requested", "blocked"]).optional(),
  })
  .strict();
const scheduleDraft = z
  .object({
    title: z.string(),
    date: z.string(),
    startTime: z.string(),
    endTime: z.string(),
    note: z.string(),
  })
  .strict()
  .refine(
    (event) =>
      workspaceScheduleSchema.safeParse({
        ...event,
        id: "00000000-0000-4000-8000-000000000000",
      }).success,
    "日程日期或时间无效",
  );
export const assistantAnswerSchema = z
  .object({
    text: z.string().trim().min(1).max(8000),
    schedules: z.array(scheduleDraft).max(8),
    tools: z.array(z.string().max(50)).max(6),
  })
  .strict();
export type AssistantMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  schedules?: WorkspaceSchedule[];
  tools?: string[];
  responseModel?: string;
  attachments?: AgentFile[];
  jobIds?: string[];
  citations?: { title: string; url: string }[];
  navigation?: string;
  webNavigation?: AssistantWebCommand;
  desktopTaskId?: string;
  evidence?: AssistantEvidence[];
  actions?: AssistantAction[];
  memorySuggestions?: { title: string; content: string }[];
};
export const assistantMemoryEntrySchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(40),
    content: z.string().trim().min(1).max(500),
  })
  .strict();
export const assistantMemorySaveSchema = z
  .object({
    version: z.number().int().min(0),
    entries: z.array(assistantMemoryEntrySchema).max(40),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.entries.map((entry) => entry.id)).size ===
      value.entries.length,
    "记忆标识重复",
  );
export type AssistantMemoryEntry = z.infer<typeof assistantMemoryEntrySchema>;
export type AssistantMemory = {
  version: number;
  entries: AssistantMemoryEntry[];
};
export const assistantSyncKinds = ["jushuitan", "compass"] as const;
export type AssistantSyncKind = (typeof assistantSyncKinds)[number];
export const assistantActionLabels: Record<AssistantSyncKind, string> = {
  jushuitan: "同步聚水潭库存",
  compass: "更新罗盘报表",
};
export type AssistantAction = {
  id: string;
  kind: AssistantSyncKind;
  title: string;
  status:
    "PROPOSED" | "SUBMITTING" | "SUBMITTED" | "FAILED" | "EXPIRED" | "CANCELED";
  note: string;
  href: string;
  jobId?: string;
  canExecute?: boolean;
};
export type AssistantEvidence = {
  id: string;
  title: string;
  summary: string;
  ok: boolean;
  at: string;
  href?: string;
  rows?: { label: string; value: string; href?: string }[];
};
export function canRunAssistantSync(
  actor: WorkspaceActor,
  kind: AssistantSyncKind,
) {
  return kind === "compass"
    ? actor.permissions.includes("analytics.manage")
    : actor.permissions.includes("inventory.adjust") &&
        !!actor.roleCodes?.includes("SUPER_ADMIN");
}
export type AssistantConversation = {
  ready: boolean;
  availabilityMessage: string;
  model: string;
  version: number;
  state: "IDLE" | "PENDING" | "FAILED";
  error: string;
  messages: AssistantMessage[];
};

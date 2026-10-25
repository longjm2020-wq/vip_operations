import { z } from "zod";
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
};
export type AssistantConversation = {
  ready: boolean;
  availabilityMessage: string;
  model: string;
  version: number;
  state: "IDLE" | "PENDING" | "FAILED";
  error: string;
  messages: AssistantMessage[];
};

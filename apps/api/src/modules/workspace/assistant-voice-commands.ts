import { randomUUID } from "node:crypto";
import { availableWorkspaceTools } from "../../../../../packages/contracts/src/personal-workspace.js";
import {
  assistantActionLabels,
  canRunAssistantSync,
} from "../../../../../packages/contracts/src/personal-assistant.js";
import type { VoiceCommand } from "../../../../../packages/contracts/src/assistant-voice-commands.js";
import { db, one } from "../../../../../packages/database/src/index.js";
import { fail, type Context } from "../../core.js";
import { executeAssistantAction } from "./assistant-actions.js";
import type { askAssistantModel } from "./assistant-model.js";

export async function runAssistantVoiceCommand(
  c: Context,
  command: VoiceCommand,
  requestId: string,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof askAssistantModel>>> {
  signal.throwIfAborted();
  const base = {
    text: "",
    schedules: [],
    tools: [],
    evidence: [],
    actions: [],
    memorySuggestions: [],
    responseModel: undefined,
    jobIds: [],
    citations: [],
  };
  if (command.kind === "navigate") {
    if (
      !availableWorkspaceTools(c.actor).some(
        (tool) => tool.id === command.toolId,
      )
    )
      fail("FORBIDDEN", "当前账号没有这个页面的访问权限", 403);
    return {
      ...base,
      text: `正在为你打开${command.title}。`,
      tools: [command.toolId],
    };
  }
  if (!canRunAssistantSync(c.actor, command.syncKind))
    fail("FORBIDDEN", "当前账号没有该同步操作权限", 403);
  const id = randomUUID();
  const reserved = await one(
    db,
    `INSERT INTO public.personal_assistant_actions(id,user_id,kind,note)
     SELECT $1::uuid,$2::bigint,$3,'用户已明确发出语音更新指令'
     WHERE EXISTS(SELECT 1 FROM public.personal_assistant_conversations WHERE user_id=$2::bigint AND request_id=$4::uuid AND state='PENDING') RETURNING id`,
    id,
    c.actor.id,
    command.syncKind,
    requestId,
  );
  if (!reserved) fail("VERSION_CONFLICT", "对话已变化，本次指令未执行", 409);
  signal.throwIfAborted();
  const action = await executeAssistantAction(c, { id });
  return {
    ...base,
    text: `${assistantActionLabels[command.syncKind]}：${action.note}。`,
    tools: [command.syncKind === "compass" ? "analytics" : "inventory"],
    actions: [action],
  };
}

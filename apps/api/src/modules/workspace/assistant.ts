import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { z } from "zod";
import {
  db,
  one,
  type Row,
} from "../../../../../packages/database/src/index.js";
import {
  assistantSendSchema,
  type AssistantMessage,
} from "../../../../../packages/contracts/src/personal-assistant.js";
import { type WorkspaceConfig } from "../../../../../packages/contracts/src/personal-workspace.js";
import { fail, hash, parse, type Context } from "../../core.js";
import { COMPASS_AI_MODEL } from "../analytics/ai.js";
import { encryptionReady } from "../analytics/secrets.js";

import { requireAssistant, readAssistantMemory } from "./assistant-memory.js";
import { askAssistantModel } from "./assistant-model.js";
import { assistantActionViews } from "./assistant-actions.js";
import { parseVoiceCommand } from "../../../../../packages/contracts/src/assistant-voice-commands.js";
import { runAssistantVoiceCommand } from "./assistant-voice-commands.js";
export { parseAssistantAnswer } from "./assistant-model.js";

async function settings() {
  return one(
    db,
    "SELECT enabled,api_key_encrypted,verified_at FROM public.compass_ai_settings WHERE id=1",
  );
}
const ready = (s?: Row) =>
  encryptionReady() && !!s?.enabled && !!s.api_key_encrypted && !!s.verified_at;
const expired = (r?: Row) =>
  r?.state === "PENDING" &&
  Date.now() - new Date(r.pending_since).getTime() > 180000;
function publicConversation(row: Row | undefined, s: Row | undefined) {
  return {
    ready: ready(s),
    availabilityMessage: ready(s)
      ? "个人助理已就绪"
      : "请管理员在 AI 模型设置中启用并验证模型连接",
    model: COMPASS_AI_MODEL,
    version: row?.version || 0,
    state: expired(row) ? "FAILED" : row?.state || "IDLE",
    error: expired(row)
      ? "上次请求超时，请重新发送；未自动重试"
      : row?.error_note || "",
    messages: row?.messages || [],
  };
}
export async function readAssistant(c: Context) {
  requireAssistant(c);
  const [row, s] = await Promise.all([
    one(
      db,
      "SELECT * FROM public.personal_assistant_conversations WHERE user_id=$1::bigint",
      c.actor.id,
    ),
    settings(),
  ]);
  const view = publicConversation(row, s);
  const actionIds = view.messages.flatMap(
    (item: AssistantMessage) => item.actions?.map((action) => action.id) || [],
  );
  const actions = await assistantActionViews(c, actionIds);
  view.messages = view.messages.map((item: AssistantMessage) => ({
    ...item,
    ...(item.actions
      ? {
          actions: item.actions.map(
            (action) =>
              actions.find((current) => current.id === action.id) || {
                ...action,
                status: "EXPIRED",
                canExecute: false,
                note: "操作已失效",
              },
          ),
        }
      : {}),
  }));
  return view;
}
export function assistantContext(
  config: WorkspaceConfig | undefined,
  today: string,
) {
  const until = new Date(`${today}T00:00:00Z`);
  until.setUTCDate(until.getUTCDate() + 60);
  return {
    todos: (config?.todos || [])
      .filter((todo) => !todo.done)
      .slice(0, 50)
      .map(({ title, dueDate }) => ({ title, dueDate })),
    schedule: (config?.schedule || [])
      .filter(
        (event) =>
          event.date >= today && event.date <= until.toISOString().slice(0, 10),
      )
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.startTime.localeCompare(b.startTime),
      )
      .slice(0, 50)
      .map(({ title, date, startTime, endTime, note }) => ({
        title,
        date,
        startTime,
        endTime,
        note: note.slice(0, 300),
      })),
  };
}
export async function sendAssistant(
  c: Context,
  input: unknown,
  voice?: { signal: AbortSignal },
) {
  requireAssistant(c);
  const body = parse(assistantSendSchema, input);
  const fingerprint = hash(JSON.stringify(body));
  const s = await settings();
  if (!ready(s)) fail("AI_NOT_READY", "请管理员先启用并验证 AI 模型连接", 503);
  await db.$executeRawUnsafe(
    "INSERT INTO public.personal_assistant_conversations(user_id) VALUES($1::bigint) ON CONFLICT DO NOTHING",
    c.actor.id,
  );
  const existing = (await one(
    db,
    "SELECT * FROM public.personal_assistant_conversations WHERE user_id=$1::bigint",
    c.actor.id,
  ))!;
  if (existing.request_id === body.requestId) {
    if (existing.request_hash !== fingerprint)
      fail("REQUEST_CONFLICT", "请勿重复使用不同内容的请求标识", 409);
    return readAssistant(c);
  }
  if (existing.state === "PENDING" && !expired(existing))
    fail("AI_BUSY", "助理正在回复，请稍候", 409);
  if (existing.version !== body.version)
    fail("VERSION_CONFLICT", "对话已在其他页面更新，请刷新后继续", 409);
  if (
    !voice &&
    Date.now() - new Date(existing.rate_window).getTime() < 3600000 &&
    existing.request_count >= 20
  )
    fail("AI_RATE_LIMIT", "每小时最多发送20条消息，请稍后再试", 429);
  const messages: AssistantMessage[] = [
    ...existing.messages.slice(-38),
    {
      id: body.requestId,
      role: "user",
      text: body.message,
      createdAt: new Date().toISOString(),
    },
  ];
  const reserved = await one(
    db,
    "UPDATE public.personal_assistant_conversations SET messages=$3::jsonb,state='PENDING',request_id=$4::uuid,request_hash=$5,pending_since=now(),error_note='',version=version+1,request_count=CASE WHEN $6 THEN request_count WHEN rate_window<now()-interval '1 hour' THEN 1 ELSE request_count+1 END,rate_window=CASE WHEN NOT $6 AND rate_window<now()-interval '1 hour' THEN now() ELSE rate_window END,updated_at=now() WHERE user_id=$1::bigint AND version=$2 RETURNING *",
    c.actor.id,
    body.version,
    JSON.stringify(messages),
    body.requestId,
    fingerprint,
    !!voice,
  );
  if (!reserved)
    fail("VERSION_CONFLICT", "对话已在其他页面更新，请刷新后继续", 409);
  try {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const stored = body.includePersonalContext
      ? await one(
          db,
          "SELECT config FROM public.personal_workspaces WHERE user_id=$1::bigint",
          c.actor.id,
        )
      : undefined;
    const memory = body.includeMemory ? await readAssistantMemory(c) : null;
    const command = voice && parseVoiceCommand(body.message);
    const answer = command
      ? await runAssistantVoiceCommand(
          c,
          command,
          body.requestId,
          voice!.signal,
        )
      : await askAssistantModel(
          c,
          s!,
          messages,
          body.includePersonalContext
            ? assistantContext(stored?.config, today)
            : null,
          today,
          memory?.entries || null,
          body.includePersonalContext,
        );
    const reply: AssistantMessage = {
      id: randomUUID(),
      role: "assistant",
      text: answer.text,
      schedules: answer.schedules,
      tools: answer.tools,
      evidence: answer.evidence,
      actions: answer.actions,
      memorySuggestions: answer.memorySuggestions,
      responseModel: command ? undefined : COMPASS_AI_MODEL,
      navigation: command?.kind === "navigate" ? command.toolId : undefined,
      createdAt: new Date().toISOString(),
    };
    await db.$transaction(async (tx) => {
      const saved = await one(
        tx,
        "UPDATE public.personal_assistant_conversations SET messages=$3::jsonb,state='IDLE',error_note='',version=version+1,updated_at=now() WHERE user_id=$1::bigint AND request_id=$2::uuid AND state='PENDING' RETURNING user_id",
        c.actor.id,
        body.requestId,
        JSON.stringify([...messages, reply]),
      );
      if (!saved) return;
      for (const action of answer.actions)
        await tx.$executeRawUnsafe(
          "INSERT INTO public.personal_assistant_actions(id,user_id,kind,note) VALUES($1::uuid,$2::bigint,$3,$4) ON CONFLICT(id) DO NOTHING",
          action.id,
          c.actor.id,
          action.kind,
          action.note,
        );
    });
  } catch (e) {
    const reason =
      e instanceof HttpException
        ? (e.getResponse() as { error?: { message?: string } }).error
            ?.message || "AI 服务暂不可用"
        : "AI 请求超时或连接失败，请重新发送；未自动重试";
    await db.$executeRawUnsafe(
      "UPDATE public.personal_assistant_conversations SET state='FAILED',error_note=$3,version=version+1,updated_at=now() WHERE user_id=$1::bigint AND request_id=$2::uuid AND state='PENDING'",
      c.actor.id,
      body.requestId,
      reason,
    );
  }
  return readAssistant(c);
}
export async function clearAssistant(c: Context, input: unknown) {
  requireAssistant(c);
  const { version } = parse(
    z.object({ version: z.number().int().min(0) }).strict(),
    input,
  );
  await db.$transaction(async (tx) => {
    const row = await one(
      tx,
      "UPDATE public.personal_assistant_conversations SET messages='[]'::jsonb,state='IDLE',error_note='',request_id=NULL,request_hash=NULL,version=version+1,updated_at=now() WHERE user_id=$1::bigint AND version=$2 AND (state<>'PENDING' OR pending_since<now()-interval '3 minutes') RETURNING *",
      c.actor.id,
      version,
    );
    if (!row)
      fail("VERSION_CONFLICT", "对话已更新或助理仍在回复，请刷新后重试", 409);
    await tx.$executeRawUnsafe(
      "UPDATE public.personal_assistant_actions SET status='CANCELED',note='对话已清空',updated_at=now() WHERE user_id=$1::bigint AND status IN ('PROPOSED','FAILED')",
      c.actor.id,
    );
  });
  return readAssistant(c);
}

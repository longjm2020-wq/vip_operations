import { db, one } from "../../../../../packages/database/src/index.js";
import {
  assistantMemorySaveSchema,
  canUsePersonalAssistant,
  type AssistantMemory,
} from "../../../../../packages/contracts/src/personal-assistant.js";
import { command, fail, parse, type Context } from "../../core.js";

export function requireAssistant(c: Context) {
  if (!canUsePersonalAssistant(c.actor))
    fail("FORBIDDEN", "当前账号没有 AI 助理使用权限", 403);
}
export async function readAssistantMemory(
  c: Context,
): Promise<AssistantMemory> {
  requireAssistant(c);
  const row = await one(
    db,
    "SELECT entries,version FROM public.personal_assistant_memories WHERE user_id=$1::bigint",
    c.actor.id,
  );
  return { entries: row?.entries || [], version: row?.version || 0 };
}
export async function saveAssistantMemory(c: Context, input: unknown) {
  requireAssistant(c);
  const body = parse(assistantMemorySaveSchema, input);
  // Personal content never enters shared audit logs. Ownership is always session-derived.
  return command(c, "assistant.memory.save", body, async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      `assistant-memory:${c.actor.id}`,
    );
    const old = await one(
      tx,
      "SELECT version FROM public.personal_assistant_memories WHERE user_id=$1::bigint FOR UPDATE",
      c.actor.id,
    );
    if ((old?.version || 0) !== body.version)
      fail("VERSION_CONFLICT", "记忆已在其他页面更新，请刷新后重新编辑", 409);
    await tx.$executeRawUnsafe(
      `INSERT INTO public.personal_assistant_memories(user_id,entries,version) VALUES($1::bigint,$2::jsonb,1)
      ON CONFLICT(user_id) DO UPDATE SET entries=EXCLUDED.entries,version=personal_assistant_memories.version+1,updated_at=now()`,
      c.actor.id,
      JSON.stringify(body.entries),
    );
    return { version: body.version + 1, entries: body.entries };
  });
}

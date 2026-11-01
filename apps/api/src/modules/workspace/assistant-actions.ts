import { HttpException } from "@nestjs/common";
import { z } from "zod";
import {
  db,
  one,
  rows,
  type Row,
} from "../../../../../packages/database/src/index.js";
import {
  assistantActionLabels,
  canRunAssistantSync,
  type AssistantAction,
} from "../../../../../packages/contracts/src/personal-assistant.js";
import { fail, parse, type Context } from "../../core.js";
import { requireAssistant } from "./assistant-memory.js";
import { queueJushuitan } from "../inventory/jushuitan.js";
import { requestCompassUpdate } from "../analytics/browser-update.js";

export const assistantActionHref = (kind: string) =>
  kind === "jushuitan" ? "/operations/vip/inventory" : "/analytics/compass";
export function assistantSafeError(error: unknown) {
  return error instanceof HttpException
    ? (error.getResponse() as { error?: { message?: string } }).error
        ?.message || "操作未完成"
    : "服务暂不可用，请稍后重试";
}
function actionView(c: Context, row: Row): AssistantAction {
  const kind = row.kind as AssistantAction["kind"];
  const expired =
    ["PROPOSED", "FAILED", "SUBMITTING"].includes(row.status) &&
    Date.now() - new Date(row.created_at).getTime() > 86400000;
  return {
    id: row.id,
    kind,
    title: assistantActionLabels[kind],
    status: expired ? "EXPIRED" : row.status,
    note: expired ? "操作已过期，请先在原模块核对任务" : row.note,
    href: assistantActionHref(kind),
    jobId: row.job_id || undefined,
    canExecute: canRunAssistantSync(c.actor, kind),
  };
}
export async function assistantActionViews(c: Context, ids: string[]) {
  if (!ids.length) return [];
  return (
    await rows(
      db,
      "SELECT * FROM public.personal_assistant_actions WHERE user_id=$1::bigint AND id=ANY($2::uuid[])",
      c.actor.id,
      ids,
    )
  ).map((row) => actionView(c, row));
}
export async function executeAssistantAction(c: Context, input: unknown) {
  requireAssistant(c);
  const { id } = parse(z.object({ id: z.string().uuid() }).strict(), input);
  const old = await one(
    db,
    "SELECT * FROM public.personal_assistant_actions WHERE id=$1::uuid AND user_id=$2::bigint",
    id,
    c.actor.id,
  );
  if (!old) fail("NOT_FOUND", "操作不存在或无权访问", 404);
  if (!canRunAssistantSync(c.actor, old.kind))
    fail("FORBIDDEN", "当前账号没有该同步操作权限", 403);
  if (old.status === "SUBMITTED") return actionView(c, old);
  if (
    old.status === "CANCELED" ||
    Date.now() - new Date(old.created_at).getTime() > 86400000
  )
    fail("ACTION_EXPIRED", "操作已过期，请重新提出请求", 409);
  const claimed = await one(
    db,
    `UPDATE public.personal_assistant_actions SET status='SUBMITTING',note='正在提交任务',updated_at=now()
    WHERE id=$1::uuid AND user_id=$2::bigint AND (status IN ('PROPOSED','FAILED') OR (status='SUBMITTING' AND updated_at<now()-interval '2 minutes')) RETURNING *`,
    id,
    c.actor.id,
  );
  if (!claimed) return actionView(c, old);
  try {
    // Reusing a server-owned operation id recovers a lost HTTP response without requeueing.
    const actionContext = { ...c, key: `assistant:${id}` };
    const result =
      old.kind === "jushuitan"
        ? await queueJushuitan(actionContext)
        : await requestCompassUpdate(actionContext, {});
    const job = old.kind === "jushuitan" ? result : result.job;
    const note =
      job?.status === "COMPLETE"
        ? "目标报表已经完整更新，无需重复下载"
        : "已提交后台任务，进度请查看动态反馈";
    await db.$executeRawUnsafe(
      "UPDATE public.personal_assistant_actions SET status='SUBMITTED',job_id=$2,note=$3,updated_at=now() WHERE id=$1::uuid",
      id,
      job?.id == null ? null : String(job.id),
      note,
    );
  } catch (error) {
    await db.$executeRawUnsafe(
      "UPDATE public.personal_assistant_actions SET status='FAILED',note=$2,updated_at=now() WHERE id=$1::uuid",
      id,
      assistantSafeError(error),
    );
  }
  return actionView(
    c,
    (await one(
      db,
      "SELECT * FROM public.personal_assistant_actions WHERE id=$1::uuid AND user_id=$2::bigint",
      id,
      c.actor.id,
    ))!,
  );
}

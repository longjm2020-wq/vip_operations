import { randomUUID } from "node:crypto";
import { db, one, rows } from "../../../packages/database/src/index.js";
import {
  runAgentJob,
  safeAgentError,
} from "../../api/src/modules/workspace/agent-jobs.js";
import type { Context } from "../../api/src/core.js";

export async function pollAssistantJobs(signal: AbortSignal) {
  // Interrupted external work is never automatically retried or charged again.
  await db.$executeRawUnsafe(
    "UPDATE public.personal_assistant_jobs SET status='FAILED',stage='处理中断',error_note='任务心跳中断，结果尚未确认；未自动重试，请检查任务后重新发起',updated_at=now() WHERE status='RUNNING' AND heartbeat_at<now()-interval '3 minutes'",
  );
  const lease = randomUUID();
  const job = await one(
    db,
    "UPDATE public.personal_assistant_jobs SET status='RUNNING',stage='开始处理',lease_id=$1::uuid,heartbeat_at=now(),updated_at=now() WHERE id=(SELECT id FROM public.personal_assistant_jobs WHERE status='QUEUED' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *",
    lease,
  );
  if (!job) return;
  const heartbeat = setInterval(() => {
    void db
      .$executeRawUnsafe(
        "UPDATE public.personal_assistant_jobs SET heartbeat_at=now() WHERE id=$1::uuid AND lease_id=$2::uuid AND status='RUNNING'",
        job.id,
        lease,
      )
      .catch(() => {});
  }, 15000);
  try {
    const user = await one(
      db,
      "SELECT id::text,username,display_name FROM public.users WHERE id=$1::bigint AND status='ACTIVE'",
      String(job.user_id),
    );
    if (!user) throw Error("任务账号不可用");
    const perms = await rows(
      db,
      "SELECT DISTINCT p.code FROM public.permissions p WHERE EXISTS(SELECT 1 FROM public.user_roles ur JOIN public.role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=$1::bigint AND rp.permission_id=p.id) OR EXISTS(SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id WHERE ur.user_id=$1::bigint AND r.code='SUPER_ADMIN')",
      user.id,
    );
    const c: Context = {
      actor: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        permissions: perms.map((p) => p.code),
        roleCodes: [],
      },
      requestId: job.id,
      key: job.id,
    };
    const output = await runAgentJob(
      c,
      job,
      async (n, stage) => {
        const saved = await one(
          db,
          "UPDATE public.personal_assistant_jobs SET progress=$3,stage=$4,heartbeat_at=now(),updated_at=now() WHERE id=$1::uuid AND lease_id=$2::uuid AND status='RUNNING' RETURNING id",
          job.id,
          lease,
          n,
          stage,
        );
        if (!saved) throw Error("任务已中断");
      },
      signal,
    );
    await db.$executeRawUnsafe(
      "UPDATE public.personal_assistant_jobs SET status='DONE',progress=100,stage='已完成',output_ids=$3::jsonb,updated_at=now() WHERE id=$1::uuid AND lease_id=$2::uuid AND status='RUNNING'",
      job.id,
      lease,
      JSON.stringify(output),
    );
  } catch (e) {
    await db.$executeRawUnsafe(
      "UPDATE public.personal_assistant_jobs SET status='FAILED',stage='未完成',error_note=$3,updated_at=now() WHERE id=$1::uuid AND lease_id=$2::uuid AND status='RUNNING'",
      job.id,
      lease,
      safeAgentError(e),
    );
  } finally {
    clearInterval(heartbeat);
  }
}
export function startAssistantJobs() {
  const controller = new AbortController();
  let stopped = false,
    active: Promise<void> | undefined;
  const tick = () => {
    if (stopped || active) return;
    active = pollAssistantJobs(controller.signal)
      .catch(() => console.warn("Assistant task polling unavailable"))
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, 3000);
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    controller.abort();
    await active;
  };
}

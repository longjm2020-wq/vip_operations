import { randomUUID } from "node:crypto";
import {
  db,
  one,
  rows,
  type Row,
} from "../../../packages/database/src/index.js";
import {
  runAgentJob,
  safeAgentError,
} from "../../api/src/modules/workspace/agent-jobs.js";
import type { Context } from "../../api/src/core.js";

const jobKinds = ["document", "image", "video"] as const;
type JobKind = (typeof jobKinds)[number];

async function sweepInterruptedJobs() {
  // Interrupted external work is never automatically retried or charged again.
  await db.$executeRawUnsafe(
    "UPDATE public.personal_assistant_jobs SET status='FAILED',stage='处理中断',error_note='任务心跳中断，结果尚未确认；未自动重试，请检查任务后重新发起',updated_at=now() WHERE status='RUNNING' AND heartbeat_at<now()-interval '3 minutes'",
  );
}

async function claimAssistantJob(lease: string, kind?: JobKind) {
  const kindFilter = kind ? " AND kind=$2" : "";
  return one(
    db,
    `UPDATE public.personal_assistant_jobs SET status='RUNNING',stage='开始处理',lease_id=$1::uuid,heartbeat_at=now(),updated_at=now() WHERE id=(SELECT id FROM public.personal_assistant_jobs WHERE status='QUEUED'${kindFilter} ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
    lease,
    ...(kind ? [kind] : []),
  );
}

async function runAssistantJob(job: Row, lease: string, signal: AbortSignal) {
  const canceled = new AbortController();
  const jobSignal = AbortSignal.any([signal, canceled.signal]);
  const heartbeat = setInterval(() => {
    void db
      .$executeRawUnsafe(
        "UPDATE public.personal_assistant_jobs SET heartbeat_at=now() WHERE id=$1::uuid AND lease_id=$2::uuid AND status='RUNNING'",
        job.id,
        lease,
      )
      .then((updated) => {
        if (!updated) canceled.abort(new Error("任务已取消或租约失效"));
      })
      .catch(() => {});
  }, 15000);
  try {
    jobSignal.throwIfAborted();
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
      jobSignal,
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

async function processQueuedJob(signal: AbortSignal, kind?: JobKind) {
  signal.throwIfAborted();
  const lease = randomUUID();
  const job = await claimAssistantJob(lease, kind);
  if (job) await runAssistantJob(job, lease, signal);
}

export async function pollAssistantJobs(signal: AbortSignal, kind?: JobKind) {
  await sweepInterruptedJobs();
  await processQueuedJob(signal, kind);
}

export function startAssistantJobs() {
  const controller = new AbortController();
  const active = new Map<JobKind, Promise<void>>();
  let filling: Promise<void> | undefined;
  let nextSweepAt = 0;
  const fill = async () => {
    if (Date.now() >= nextSweepAt) {
      await sweepInterruptedJobs();
      nextSweepAt = Date.now() + 30_000;
    }
    if (controller.signal.aborted) return;
    for (const kind of jobKinds) {
      if (active.has(kind)) continue;
      // A long provider video wait leaves the image and document slots free.
      const task = processQueuedJob(controller.signal, kind)
        .catch(() => console.warn("Assistant file job state unavailable"))
        .finally(() => active.delete(kind));
      active.set(kind, task);
    }
  };
  const tick = () => {
    if (controller.signal.aborted || filling) return;
    if (active.size === jobKinds.length && Date.now() < nextSweepAt) return;
    filling = fill()
      .catch(() => console.warn("Assistant task polling unavailable"))
      .finally(() => {
        filling = undefined;
      });
  };
  const timer = setInterval(tick, 3000);
  tick();
  return async () => {
    clearInterval(timer);
    controller.abort();
    await filling;
    await Promise.allSettled(active.values());
  };
}

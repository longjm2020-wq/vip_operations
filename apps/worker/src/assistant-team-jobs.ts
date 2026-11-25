import { randomUUID } from "node:crypto";
import {
  db,
  one,
  rows,
  type Row,
} from "../../../packages/database/src/index.js";
import type { Context } from "../../api/src/core.js";
import {
  runTeamExecution,
  safeTeamError,
} from "../../api/src/modules/workspace/team-executor.js";
import { claimAssistantRuns } from "../../api/src/modules/workspace/employee-runtime.js";

async function sweepInterruptedTeamJobs() {
  await db.$executeRawUnsafe(
    "UPDATE public.personal_assistant_team_runs SET status='NEEDS_USER',stage='执行中断，等待核对',error_note='任务心跳中断，已保留现有结果与请求记录。请核对已有文件和步骤，需要时可在 AI 员工另行交办。',lease_id=NULL,updated_at=now() WHERE status IN ('PLANNING','RUNNING','REVIEWING') AND COALESCE(heartbeat_at,updated_at)<now()-interval '3 minutes'",
  );
  // Stop unstarted child work belonging to an interrupted/canceled parent.
  await db.$executeRawUnsafe(
    "UPDATE public.personal_assistant_jobs j SET status='CANCELED',stage='团队任务已停止',updated_at=now() WHERE j.status IN ('QUEUED','RUNNING') AND EXISTS(SELECT 1 FROM public.personal_assistant_team_runs r WHERE r.id=j.request_id AND r.user_id=j.user_id AND r.status IN ('CANCELED','NEEDS_USER','FAILED'))",
  );
}

/** Separate from the file worker so waiting for a file never consumes a file slot. */
async function runAssistantTeamJob(run: Row, signal: AbortSignal) {
  const lease = String(run.lease_id);
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let checking = false;
  const heartbeat = setInterval(() => {
    if (checking) return;
    checking = true;
    void one(
      db,
      "UPDATE public.personal_assistant_team_runs SET heartbeat_at=now() WHERE id=$1::uuid AND lease_id=$2::uuid AND status IN ('PLANNING','RUNNING','REVIEWING') RETURNING id",
      run.id,
      lease,
    )
      .then((live) => {
        if (!live) controller.abort(new Error("Team lease ended"));
      })
      .catch(() => controller.abort(new Error("Team lease unavailable")))
      .finally(() => {
        checking = false;
      });
  }, 3000);
  try {
    combined.throwIfAborted();
    const user = await one(
      db,
      "SELECT id::text,username,display_name FROM public.users WHERE id=$1::bigint AND status='ACTIVE'",
      String(run.user_id),
    );
    if (!user) throw Error("任务账号不可用");
    const roles = await rows(
      db,
      "SELECT r.code FROM public.roles r JOIN public.user_roles ur ON ur.role_id=r.id WHERE ur.user_id=$1::bigint",
      user.id,
    );
    const c: Context = {
      actor: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        permissions: [],
        roleCodes: roles.map((r) => r.code),
      },
      requestId: run.id,
      key: run.id,
    };
    await runTeamExecution(c, run, lease, combined);
  } catch (error) {
    const note = combined.aborted
      ? "团队执行已中断，已保留实际成果；未自动重试付费调用，请检查结果后重新发起"
      : safeTeamError(error);
    // A late failure from an expired lease cannot cancel a resumed task's children.
    await db.$executeRawUnsafe(
      `WITH stopped AS (
         UPDATE public.personal_assistant_team_runs SET status='NEEDS_USER',stage='等待用户处理',error_note=$3,lease_id=NULL,updated_at=now()
         WHERE id=$1::uuid AND lease_id=$2::uuid AND status IN ('PLANNING','RUNNING','REVIEWING') RETURNING id,user_id
       )
       UPDATE public.personal_assistant_jobs j SET status='CANCELED',stage='所属任务已停止',updated_at=now()
       FROM stopped WHERE j.request_id=stopped.id AND j.user_id=stopped.user_id AND j.status IN ('QUEUED','RUNNING')`,
      run.id,
      lease,
      note,
    );
  } finally {
    clearInterval(heartbeat);
    controller.abort();
  }
}

export async function pollAssistantTeamJobs(signal: AbortSignal) {
  await sweepInterruptedTeamJobs();
  signal.throwIfAborted();
  const [run] = await claimAssistantRuns([randomUUID()]);
  if (run) await runAssistantTeamJob(run, signal);
}

export function employeeWorkerConcurrency(
  value = process.env.ASSISTANT_EMPLOYEE_WORKER_CONCURRENCY,
) {
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 24 ? limit : 6;
}

export function startAssistantTeamJobs() {
  const controller = new AbortController();
  const concurrency = employeeWorkerConcurrency();
  const active = new Set<Promise<void>>();
  let filling: Promise<void> | undefined;
  let nextSweepAt = 0;
  const fill = async () => {
    if (Date.now() >= nextSweepAt) {
      await sweepInterruptedTeamJobs();
      nextSweepAt = Date.now() + 30_000;
    }
    if (controller.signal.aborted) return;
    const leases = Array.from({ length: concurrency - active.size }, () =>
      randomUUID(),
    );
    for (const run of await claimAssistantRuns(leases)) {
      const task = runAssistantTeamJob(run, controller.signal)
        .catch(() => console.warn("Assistant team job state unavailable"))
        .finally(() => active.delete(task));
      active.add(task);
    }
  };
  const tick = () => {
    if (controller.signal.aborted || filling) return;
    if (active.size >= concurrency && Date.now() < nextSweepAt) return;
    filling = fill()
      .catch(() => console.warn("Assistant team polling unavailable"))
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
    await Promise.allSettled(active);
  };
}

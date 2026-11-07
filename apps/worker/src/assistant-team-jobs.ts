import { randomUUID } from "node:crypto";
import { db, one, rows } from "../../../packages/database/src/index.js";
import type { Context } from "../../api/src/core.js";
import {
  runTeamExecution,
  safeTeamError,
} from "../../api/src/modules/workspace/team-executor.js";

/** Separate from the media worker, so waiting for a file never consumes its slot. */
export async function pollAssistantTeamJobs(signal: AbortSignal) {
  await db.$executeRawUnsafe(
    "UPDATE public.personal_assistant_team_runs SET status='NEEDS_USER',stage='执行中断，等待核对',error_note='团队任务心跳中断，已保留现有结果；未自动重试模型或生成服务，请检查文件和步骤后重新发起',lease_id=NULL,updated_at=now() WHERE status IN ('PLANNING','RUNNING','REVIEWING') AND heartbeat_at<now()-interval '3 minutes'",
  );
  // Stop unstarted child work belonging to an interrupted/canceled parent.
  await db.$executeRawUnsafe(
    "UPDATE public.personal_assistant_jobs j SET status='CANCELED',stage='团队任务已停止',updated_at=now() WHERE j.status IN ('QUEUED','RUNNING') AND EXISTS(SELECT 1 FROM public.personal_assistant_team_runs r WHERE r.id=j.request_id AND r.user_id=j.user_id AND r.status IN ('CANCELED','NEEDS_USER','FAILED'))",
  );
  signal.throwIfAborted();
  const lease = randomUUID();
  const run = await one(
    db,
    "UPDATE public.personal_assistant_team_runs SET status='PLANNING',stage='主智能体准备规划',lease_id=$1::uuid,heartbeat_at=now(),updated_at=now() WHERE id=(SELECT id FROM public.personal_assistant_team_runs WHERE status='QUEUED' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *",
    lease,
  );
  if (!run) return;
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
    await db.$executeRawUnsafe(
      "UPDATE public.personal_assistant_team_runs SET status='NEEDS_USER',stage='等待用户处理',error_note=$3,lease_id=NULL,updated_at=now() WHERE id=$1::uuid AND lease_id=$2::uuid AND status IN ('PLANNING','RUNNING','REVIEWING')",
      run.id,
      lease,
      note,
    );
    await db.$executeRawUnsafe(
      "UPDATE public.personal_assistant_jobs SET status='CANCELED',stage='团队任务已停止',updated_at=now() WHERE request_id=$1::uuid AND user_id=$2::bigint AND status IN ('QUEUED','RUNNING')",
      run.id,
      String(run.user_id),
    );
  } finally {
    clearInterval(heartbeat);
    controller.abort();
  }
}

export function startAssistantTeamJobs() {
  const controller = new AbortController();
  let active: Promise<void> | undefined;
  const tick = () => {
    if (controller.signal.aborted || active) return;
    active = pollAssistantTeamJobs(controller.signal)
      .catch(() => console.warn("Assistant team polling unavailable"))
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, 3000);
  tick();
  return async () => {
    clearInterval(timer);
    controller.abort();
    await active;
  };
}

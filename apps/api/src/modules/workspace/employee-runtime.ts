import {
  db,
  one,
  type Row,
} from "../../../../../packages/database/src/index.js";
import type { EmployeeModelPolicy } from "../../../../../packages/contracts/src/assistant-employees.js";

/** A fixed policy cannot be expanded by an LLM-supplied tool argument. */
export function employeeMediaCandidates<T extends { id: string }>(
  catalog: T[],
  policy?: EmployeeModelPolicy,
): T[] {
  if (!policy || policy.mode === "auto") return catalog;
  const candidates = policy.modelIds.flatMap((id) =>
    catalog.filter((m) => m.id === id),
  );
  // Media fallback is preflight only: never resubmit an uncertain paid job.
  return candidates;
}

export async function reserveEmployeeCall(
  runId: string,
  userId: string,
  lease: string,
) {
  return Boolean(
    await one(
      db,
      `UPDATE public.personal_assistant_employee_tasks t SET model_calls=model_calls+1
    WHERE run_id=$1::uuid AND user_id=$2::bigint AND model_calls<max_model_calls
    AND EXISTS(SELECT 1 FROM public.personal_assistant_team_runs r WHERE r.id=t.run_id AND r.user_id=t.user_id
      AND r.lease_id=$3::uuid AND r.status IN ('PLANNING','RUNNING','REVIEWING')) RETURNING run_id`,
      runId,
      userId,
      lease,
    ),
  );
}

// Claiming and capacity inspection share a transaction lock across worker processes.
// A collaborative run reserves every selected employee until its next safe pause/end.
// Retire pending legacy requests in the same trip as the claim. The two updates
// target disjoint rows in the status-indexed queue and never retake a live lease.
export const employeeClaimSql = `WITH retired AS (
  UPDATE public.personal_assistant_team_runs SET status='CANCELED',stage='原团队已停止接单',
    error_note='此任务已停止排队，已有记录和产物可在历史任务中查看。',updated_at=now()
  WHERE status='QUEUED' AND (NOT (input ? 'employeeContext') OR COALESCE(input->>'engine','native')<>'native')
)
UPDATE public.personal_assistant_team_runs SET status='PLANNING',stage='准备执行任务',lease_id=$1::uuid,heartbeat_at=now(),updated_at=now()
  WHERE id=(SELECT r.id FROM public.personal_assistant_team_runs r
    JOIN public.personal_assistant_employee_tasks t ON t.run_id=r.id AND t.user_id=r.user_id
    WHERE r.status='QUEUED' AND r.input ? 'employeeContext' AND COALESCE(r.input->>'engine','native')='native'
      AND NOT t.paused AND NOT EXISTS(
        SELECT 1 FROM unnest(t.employee_ids) AS member(id)
        LEFT JOIN public.personal_assistant_employees e ON e.id=member.id AND e.user_id=t.user_id
        WHERE e.id IS NULL OR e.archived OR NOT (e.profile->>'accepting')::boolean
          OR (SELECT count(*) FROM public.personal_assistant_employee_tasks busy
              JOIN public.personal_assistant_team_runs running ON running.id=busy.run_id
              WHERE busy.user_id=t.user_id AND e.id=ANY(busy.employee_ids)
                AND running.status IN ('PLANNING','RUNNING','REVIEWING')) >= (e.profile->>'concurrency')::int
      )
    ORDER BY t.priority DESC,r.created_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED) RETURNING *`;

export async function claimAssistantRuns(leases: readonly string[]) {
  if (!leases.length) return [];
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended('assistant-run-capacity',0))",
    );
    const claimed: Row[] = [];
    // Each claim sees the reservations made earlier in this transaction.
    for (const lease of leases) {
      const run = await one(tx, employeeClaimSql, lease);
      if (!run) break;
      claimed.push(run);
    }
    return claimed;
  });
}

export async function claimAssistantRun(lease: string) {
  const [run] = await claimAssistantRuns([lease]);
  return run;
}

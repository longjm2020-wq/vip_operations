import { randomUUID } from 'node:crypto';
import { db, one, rows } from '../../../packages/database/src/index.js';
import type { BrowserRun } from '../../api/src/modules/workspace/assistant-browser.js';

export type BrowserEnvironment = { id: string; sandboxId: string; environmentId: string };

/** Reserve before the only create attempt. A failed attempt is never recreated. */
export async function reserveBrowserEnvironment(run: BrowserRun, environmentId: string): Promise<string | null> {
  return db.$transaction(async tx => {
    // Serialize the resource limit across worker replicas and rolling deployments.
    await one(tx, 'SELECT id FROM personal_assistant_browser_runtime WHERE id=1 FOR UPDATE');
    const task = await one(tx, "SELECT id FROM personal_assistant_browser_tasks WHERE id=$1::uuid AND lease_id=$2::uuid AND user_id=$3::bigint AND status IN ('RUNNING','PAUSED','NEEDS_USER') AND expires_at>now()", run.id, run.leaseId, run.userId);
    if (!task) return null;
    const existing = await one(tx, 'SELECT id FROM personal_assistant_browser_environments WHERE task_id=$1::uuid AND lease_id=$2::uuid', run.id, run.leaseId);
    if (existing) return null;
    const count = await one(tx, 'SELECT count(*)::int AS n FROM personal_assistant_browser_environments WHERE destroyed_at IS NULL');
    if (Number(count?.n) >= 2) return null;
    const id = randomUUID();
    await tx.$executeRawUnsafe('INSERT INTO personal_assistant_browser_environments(id,task_id,lease_id,environment_id,expires_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::timestamptz)', id, run.id, run.leaseId, environmentId, run.expiresAt);
    return id;
  });
}

/** A late create response must still be recorded after a user cancels the task. */
export async function recordBrowserEnvironment(id: string, sandboxId: string): Promise<boolean> {
  const changed = await db.$executeRawUnsafe('UPDATE personal_assistant_browser_environments SET sandbox_id=$2::uuid WHERE id=$1::uuid AND destroyed_at IS NULL AND (sandbox_id IS NULL OR sandbox_id=$2::uuid)', id, sandboxId);
  return changed === 1;
}

/** Only call after provider-confirmed destruction (or a proven pre-create failure). */
export async function releaseBrowserEnvironment(id: string, sandboxId: string | null): Promise<void> {
  await db.$executeRawUnsafe('UPDATE personal_assistant_browser_environments SET destroyed_at=coalesce(destroyed_at,now()) WHERE id=$1::uuid AND sandbox_id IS NOT DISTINCT FROM $2::uuid', id, sandboxId);
}

export async function browserEnvironmentsToCleanup(environmentId: string): Promise<BrowserEnvironment[]> {
  const pending = await rows(db, "SELECT e.id,e.sandbox_id,e.environment_id FROM personal_assistant_browser_environments e LEFT JOIN personal_assistant_browser_tasks t ON t.id=e.task_id WHERE e.environment_id=$1::uuid AND e.destroyed_at IS NULL AND e.sandbox_id IS NOT NULL AND (e.expires_at<=now() OR t.id IS NULL OR t.lease_id IS DISTINCT FROM e.lease_id OR t.status NOT IN ('RUNNING','PAUSED','NEEDS_USER') OR t.heartbeat_at<now()-interval '90 seconds') ORDER BY e.created_at LIMIT 20", environmentId);
  return pending.map(row => ({ id: row.id, sandboxId: row.sandbox_id, environmentId: row.environment_id }));
}

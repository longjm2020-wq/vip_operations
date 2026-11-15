import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { BrowserRun } from '../../apps/api/src/modules/workspace/assistant-browser.js';
import type { Tx } from '../../packages/database/src/index.js';
const fixture = vi.hoisted(() => ({ db: null as PGlite | null }));
vi.mock('../../packages/database/src/index.js', async original => {
  const real = await original<typeof import('../../packages/database/src/index.js')>();
  const wrap = (query: Pick<PGlite, 'query'>) => ({
    $queryRawUnsafe: async (sql: string, ...p: unknown[]) => (await query.query(sql, p)).rows,
    $executeRawUnsafe: async (sql: string, ...p: unknown[]) => (await query.query(sql, p)).affectedRows || 0,
  });
  return { ...real, db: {
    $queryRawUnsafe: async (sql: string, ...p: unknown[]) => (await fixture.db!.query(sql, p)).rows,
    $executeRawUnsafe: async (sql: string, ...p: unknown[]) => (await fixture.db!.query(sql, p)).affectedRows || 0,
    $transaction: (fn: (tx: Tx) => Promise<unknown>) => fixture.db!.transaction(tx => fn(wrap(tx) as unknown as Tx)),
  } };
});
import { reserveBrowserEnvironment, recordBrowserEnvironment, releaseBrowserEnvironment, browserEnvironmentsToCleanup } from '../../apps/worker/src/assistant-browser-environments.js';
const environmentId = randomUUID();
beforeAll(async () => {
  fixture.db = new PGlite();
  await fixture.db.exec("CREATE TABLE personal_assistant_browser_runtime(id int PRIMARY KEY);INSERT INTO personal_assistant_browser_runtime VALUES(1);CREATE TABLE personal_assistant_browser_tasks(id uuid PRIMARY KEY,user_id bigint,lease_id uuid,status text,expires_at timestamptz,heartbeat_at timestamptz DEFAULT now());");
  const migration = await readFile('packages/database/migrations/100_assistant_browser_environments.sql', 'utf8');
  await fixture.db.exec(migration);
  await fixture.db.exec(migration);
});
beforeEach(async () => {
  await fixture.db!.exec('TRUNCATE personal_assistant_browser_environments,personal_assistant_browser_tasks');
});
afterAll(async () => { await fixture.db?.close(); });
async function run() {
  const value = { id: randomUUID(), leaseId: randomUUID(), userId: '7', expiresAt: new Date(Date.now() + 1800000).toISOString() } as BrowserRun;
  await fixture.db!.query("INSERT INTO personal_assistant_browser_tasks(id,user_id,lease_id,status,expires_at) VALUES($1,7,$2,'RUNNING',$3)", [value.id, value.leaseId, value.expiresAt]);
  return value;
}
describe('disposable browser cleanup ledger', () => {
  it('reserves once per lease and caps all replicas at two unresolved environments', async () => {
    const first = await run(), second = await run(), third = await run();
    const a = await reserveBrowserEnvironment(first, environmentId);
    expect(a).toBeTruthy();
    expect(await reserveBrowserEnvironment(first, environmentId)).toBeNull();
    expect(await reserveBrowserEnvironment(second, environmentId)).toBeTruthy();
    expect(await reserveBrowserEnvironment(third, environmentId)).toBeNull();
    await releaseBrowserEnvironment(a!, null);
    expect(await reserveBrowserEnvironment(first, environmentId)).toBeNull();
    expect(await reserveBrowserEnvironment(third, environmentId)).toBeTruthy();
  });
  it('refuses stale, wrong owner and canceled task reservations', async () => {
    const task = await run();
    expect(await reserveBrowserEnvironment({ ...task, leaseId: randomUUID() }, environmentId)).toBeNull();
    expect(await reserveBrowserEnvironment({ ...task, userId: '8' }, environmentId)).toBeNull();
    await fixture.db!.query("UPDATE personal_assistant_browser_tasks SET status='CANCELED' WHERE id=$1", [task.id]);
    expect(await reserveBrowserEnvironment(task, environmentId)).toBeNull();
  });
  it('captures a late create result after cancellation and never substitutes its resource id', async () => {
    const task = await run(), sandboxId = randomUUID();
    const id = (await reserveBrowserEnvironment(task, environmentId))!;
    await fixture.db!.query("UPDATE personal_assistant_browser_tasks SET status='CANCELED',lease_id=NULL WHERE id=$1", [task.id]);
    expect(await recordBrowserEnvironment(id, sandboxId)).toBe(true);
    expect(await recordBrowserEnvironment(id, sandboxId)).toBe(true);
    expect(await recordBrowserEnvironment(id, randomUUID())).toBe(false);
    expect(await browserEnvironmentsToCleanup(environmentId)).toEqual([{ id, sandboxId, environmentId }]);
    expect(await browserEnvironmentsToCleanup(randomUUID())).toEqual([]);
    await releaseBrowserEnvironment(id, null);
    expect(await browserEnvironmentsToCleanup(environmentId)).toHaveLength(1);
    await releaseBrowserEnvironment(id, sandboxId);
    expect(await browserEnvironmentsToCleanup(environmentId)).toEqual([]);
  });
  it('preserves cleanup targets when task is deleted and reclaims crashed or expired leases', async () => {
    const task = await run(), sandboxId = randomUUID();
    const id = (await reserveBrowserEnvironment(task, environmentId))!;
    await recordBrowserEnvironment(id, sandboxId);
    expect(await browserEnvironmentsToCleanup(environmentId)).toEqual([]);
    await fixture.db!.query("UPDATE personal_assistant_browser_tasks SET heartbeat_at=now()-interval '91 seconds' WHERE id=$1", [task.id]);
    expect(await browserEnvironmentsToCleanup(environmentId)).toHaveLength(1);
    await fixture.db!.query('UPDATE personal_assistant_browser_tasks SET heartbeat_at=now() WHERE id=$1', [task.id]);
    await fixture.db!.query("UPDATE personal_assistant_browser_environments SET expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    expect(await browserEnvironmentsToCleanup(environmentId)).toHaveLength(1);
    await fixture.db!.query('DELETE FROM personal_assistant_browser_tasks WHERE id=$1', [task.id]);
    expect(await browserEnvironmentsToCleanup(environmentId)).toEqual([{ id, sandboxId, environmentId }]);
  });
});

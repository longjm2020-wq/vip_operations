import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  db: { $transaction: vi.fn(), $executeRawUnsafe: vi.fn() },
  one: vi.fn(), rows: vi.fn(), insert: vi.fn(), update: vi.fn(),
}));
vi.mock("../../packages/database/src/index.js", () => ({
  ...database,
  json: (value: unknown) => JSON.parse(JSON.stringify(value)),
}));
import * as service from "../../apps/api/src/modules/analytics/browser-update.js";
import { compassBrowserActionSchema, isCompassBrowserOrigin } from "../../packages/contracts/src/compass-update.js";
import type { Context } from "../../apps/api/src/core.js";

const context: Context = { actor: { id: "17", username: "fixture", displayName: "Fixture", permissions: ["analytics.read", "analytics.manage"] }, key: "fixture-key", requestId: "fixture-request" };
const loginId = "75e91035-caff-4dca-9249-89dcd585f028";
const frameId = "653be2d8-5b3c-48ab-882c-4ba3fae2e241";
let session: Record<string, unknown>;
let activeJob: Record<string, unknown> | undefined;
let login: Record<string, unknown>;
let sourceDimensions: string[];
let verifiedBefore: boolean;
let pendingActions: number;
let activeClaim: boolean;
let loginBusy: boolean;
let autoEnabled: boolean;
let lastScheduledDay: string | null;

function job(status: string, extras: Record<string, unknown> = {}) {
  return { id: "41", status, target_start_date: "2026-09-11", target_end_date: "2026-10-10",
    requested_at: "2026-10-11T00:00:00Z", started_at: null, completed_at: null,
    completed_dimensions: [], source_ids: {}, note: "fixture", claim_token: "private-fixture-claim", ...extras };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
  session = { enabled: true, status: "READY", saved_at: "2026-10-10T00:00:00Z", checked_at: null,
    encryption_ready: true, worker_online: true, note: "", encrypted_state: "private-fixture-state" };
  activeJob = undefined;
  sourceDimensions = [];
  verifiedBefore = false;
  pendingActions = 0;
  activeClaim = true;
  loginBusy = false;
  autoEnabled = false;
  lastScheduledDay = null;
  login = { id: loginId, actor_id: "17", status: "WAITING", frame_id: frameId, frame_jpeg: "fixture-image",
    expires_ms: Date.now() + 600000, note: "fixture", encrypted_state: "must-never-return" };
  database.db.$transaction.mockImplementation(fn => fn(database.db));
  const clearDraft = () => {
    session.draft_encrypted_state = null; session.draft_actor_id = null; session.draft_login_id = null; session.draft_expires_at = null;
  };
  database.db.$executeRawUnsafe.mockImplementation(async (sql: string, ...values: unknown[]) => {
    const enabled = Boolean(values[0]);
    if (sql.startsWith("UPDATE compass_session SET auto_update_enabled")) {
      if (enabled && !autoEnabled && (new Date().getUTCHours() + 8) % 24 >= 8) lastScheduledDay = "2026-10-11";
      autoEnabled = enabled;
    }
    if (sql.startsWith("UPDATE compass_session SET draft_login_id=")) {
      if (session.draft_actor_id === values[1] && session.draft_encrypted_state && (session.draft_expires_at as Date)?.getTime() > Date.now()) session.draft_login_id = values[0];
    }
    if (sql.startsWith("UPDATE compass_session SET draft_encrypted_state=NULL")) {
      if (sql.includes("draft_login_id=$1::uuid") ? session.draft_login_id === values[0] : (session.draft_expires_at as Date)?.getTime() <= Date.now()) clearDraft();
    }
    if (sql.startsWith("UPDATE compass_logins SET status='CANCELLED'") && login.id === values[0] && ["QUEUED", "RUNNING", "WAITING", "CHECKING"].includes(String(login.status))) {
      login.status = "CANCELLED"; login.claim_token = null;
    }
    if (sql.startsWith("UPDATE compass_session SET enabled=false")) {
      clearDraft(); session.enabled = false; session.status = "DISCONNECTED"; session.encrypted_state = null;
    }
    return 1;
  });
  database.insert.mockResolvedValue({ id: "audit-fixture" });
  database.rows.mockImplementation(async (_tx, sql: string) => {
    if (sql.includes("FROM compass_active_imports")) return sourceDimensions.map(dimension => ({ dimension, id: dimension + "-source" }));
    if (sql.includes("pg_advisory_xact_lock")) return [];
    throw Error("Unexpected compass fixture row query");
  });
  database.one.mockImplementation(async (_tx, sql: string, ...values: unknown[]) => {
    if (sql.includes("idempotency_records")) return undefined;
    if (sql.includes("EXISTS(SELECT 1 FROM compass_update_jobs"))
      return { auto_update_enabled: autoEnabled, daily_hour: 8, last_scheduled_day: lastScheduledDay, verified_before: verifiedBefore };
    if (sql.includes("FROM compass_session")) return session;
    if (sql.includes("SELECT target_start_date")) return activeClaim ? { target_start_date: "2026-09-11", target_end_date: "2026-10-10" } : undefined;
    if (sql.startsWith("UPDATE compass_update_jobs")) {
      if (sql.includes("status='QUEUED'")) return job("QUEUED", { note: "restored" });
      return job(String(values[2]), { completed_dimensions: JSON.parse(String(values[3])), source_ids: JSON.parse(String(values[4])), note: values[5] });
    }
    if (sql.startsWith("INSERT INTO compass_update_jobs")) return job(sql.includes("'COMPLETE'") ? "COMPLETE" : "QUEUED");
    if (sql.includes("FROM compass_update_jobs")) return sql.includes("status='COMPLETE'") ? undefined : activeJob;
    if (sql.includes("FROM compass_login_actions")) return { n: pendingActions };
    if (sql.startsWith("SELECT 1 FROM compass_logins")) return loginBusy ? { busy: true } : undefined;
    if (sql.startsWith("SELECT id::text,actor_id::text FROM compass_logins")) return loginBusy ? { id: login.id, actor_id: login.actor_id } : undefined;
    if (sql.includes("FROM compass_logins")) return login;
    throw Error("Unexpected compass fixture query");
  });
});
afterEach(() => { vi.useRealTimers(); });

describe("real source gates and update lifecycle", () => {
  it("rejects a viewer before querying or submitting a background task", async () => {
    await expect(service.requestCompassUpdate({ ...context, actor: { ...context.actor, permissions: ["analytics.read"] } }, {})).rejects.toMatchObject({ status: 403 });
    expect(database.one).not.toHaveBeenCalled();
    expect(database.db.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("does not queue while the worker is offline or the independent login is unavailable", async () => {
    session.worker_online = false;
    await expect(service.requestCompassUpdate(context, {})).rejects.toMatchObject({ status: 503, response: { error: { code: "COMPASS_WORKER_OFFLINE" } } });
    session.worker_online = true;
    session.status = "LOGIN_REQUIRED";
    await expect(service.requestCompassUpdate(context, {})).rejects.toMatchObject({ status: 409, response: { error: { code: "COMPASS_LOGIN_REQUIRED" } } });
    expect(database.one.mock.calls.some(([, sql]) => String(sql).startsWith("INSERT INTO compass_update_jobs"))).toBe(false);
  });

  it("keeps an active job for the same day rather than inserting a second task", async () => {
    activeJob = job("RUNNING");
    const result = await service.requestCompassUpdate(context, {});
    expect(result.job).toMatchObject({ id: "41", status: "RUNNING", targetEndDate: "2026-10-10" });
    expect(result.job).not.toHaveProperty("claimToken");
    expect(database.one.mock.calls.some(([, sql]) => String(sql).startsWith("INSERT INTO compass_update_jobs"))).toBe(false);
  });

  it("does not enqueue behind a login window that owns the browser", async () => {
    loginBusy = true;
    await expect(service.requestCompassUpdate(context, {})).rejects.toMatchObject({ response: { error: { code: "COMPASS_LOGIN_BUSY" } } });
    expect(database.one.mock.calls.some(([, sql]) => String(sql).startsWith("INSERT INTO compass_update_jobs"))).toBe(false);
  });

  it.each(["LOGIN_REQUIRED", "VERIFICATION_REQUIRED"])("restores the same %s job only after a saved login", async status => {
    activeJob = job(status);
    const result = await service.requestCompassUpdate(context, {});
    expect(result.job).toMatchObject({ id: "41", status: "QUEUED" });
    const resumed = database.one.mock.calls.find(([, sql]) => String(sql).startsWith("UPDATE compass_update_jobs"));
    expect(resumed?.slice(2)).toEqual(["41", "17"]);
    expect(String(resumed?.[1])).toContain("deadline_at=now()+interval '1 hour'");
  });

  it("does not claim success from fewer than three complete thirty-day sources", async () => {
    sourceDimensions = ["style", "article"];
    const verified = await service.verifyCompassUpdateSources("2026-09-11", "2026-10-10");
    expect(verified).toEqual({ complete: false, completedDimensions: ["style", "article"], sourceIds: { style: "style-source", article: "article-source" } });
    const [, sql, ...params] = database.rows.mock.calls[0];
    expect(sql).toContain("i.status='COMPLETE'");
    expect(sql).toContain("count(DISTINCT r.business_date)=30");
    expect(params).toEqual(["2026-09-11", "2026-10-10"]);
    await expect(service.verifyCompassUpdateSources("2026-09-12", "2026-10-10")).rejects.toMatchObject({ status: 400 });
  });

  it("can verify already current data without pretending that an offline worker ran", async () => {
    sourceDimensions = ["style", "article", "barcode"];
    session.worker_online = false;
    const result = await service.requestCompassUpdate(context, {});
    expect(result.job?.status).toBe("COMPLETE");
    const [, sql] = database.one.mock.calls.find(([, value]) => String(value).startsWith("INSERT INTO compass_update_jobs"))!;
    expect(sql).toContain("无需重复下载");
    expect(result.session.workerOnline).toBe(false);
  });

  it.each([
    { dimensions: [], status: "FAILED" },
    { dimensions: ["style"], status: "PARTIAL" },
    { dimensions: ["style", "article", "barcode"], status: "COMPLETE" },
  ])("worker final status uses verified sources: $status", async ({ dimensions, status }) => {
    sourceDimensions = dimensions;
    const result = await service.finishCompassUpdate("41", frameId);
    expect(result?.status).toBe(status);
    expect(result?.completedDimensions).toEqual(dimensions);
    expect(result).not.toHaveProperty("claim_token");
  });

  it("does not complete a cancelled, timed out or replaced claim", async () => {
    activeClaim = false;
    await expect(service.finishCompassUpdate("41", frameId)).resolves.toBeNull();
    expect(database.rows).not.toHaveBeenCalled();
    expect(database.one.mock.calls).toHaveLength(1);
  });

  it("public status has no encrypted browser state or task claim secrets", async () => {
    activeJob = job("RUNNING");
    const result = await service.compassUpdateStatus();
    expect(JSON.stringify(result)).not.toContain("private-fixture");
    expect(Object.keys(result.session).sort()).toEqual(["checkedAt", "enabled", "encryptionReady", "note", "savedAt", "status", "workerOnline"].sort());
  });

  it("expires unclaimed, stalled and absolute-deadline work rather than leaving it queued forever", async () => {
    await service.expireCompassTasks();
    const statements = database.db.$executeRawUnsafe.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toContain("frame_jpeg=NULL");
    expect(statements[0]).toContain("requested_at<now()-interval '2 minutes'");
    expect(statements[1]).toContain("deadline_at<=now()");
    expect(statements[1]).toContain("heartbeat_at<now()-interval '5 minutes'");
    expect(statements[1]).toContain("'PARTIAL' ELSE 'FAILED'");
  });
});

describe("private login and bounded interactions", () => {
  it("does not expose another administrator's login image", async () => {
    login.actor_id = "other-owner";
    await expect(service.compassLoginView(context, loginId)).rejects.toMatchObject({ status: 403 });
  });

  it("returns only the owner's temporary frame and excludes stored browser state", async () => {
    const result = await service.compassLoginView(context, loginId);
    expect(result.frame).toBe("data:image/jpeg;base64,fixture-image");
    expect(result).not.toHaveProperty("encrypted_state");
    expect(result).not.toHaveProperty("actor_id");
  });

  it("rejects stale clicks and overloaded pending action queues", async () => {
    await expect(service.compassLoginAction(context, loginId, { kind: "CLICK", frameId: loginId, point: { x: 0.5, y: 0.5 } })).rejects.toMatchObject({ response: { error: { code: "STALE_CLOUD_FRAME" } } });
    pendingActions = 3;
    await expect(service.compassLoginAction(context, loginId, { kind: "CHECK" })).rejects.toMatchObject({ response: { error: { code: "COMPASS_ACTION_BUSY" } } });
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).startsWith("INSERT INTO compass_login_actions"))).toBe(false);
  });

  it.each([
    { kind: "TYPE", text: "must-not-accept-credentials" },
    { kind: "GOTO", url: "https://untrusted.example" },
    { kind: "SCROLL", frameId, deltaY: 0 },
    { kind: "SCROLL", frameId, deltaY: 1201 },
    { kind: "CLICK", frameId, point: { x: 1.1, y: 0.2 } },
  ])("rejects unsupported or unbounded action $kind", action => {
    expect(compassBrowserActionSchema.safeParse(action).success).toBe(false);
  });

  it("restricts navigation to the independently verified official compass and login origins", () => {
    for (const url of ["https://compass.vip.com/", "https://vis.vip.com/index.php#/homepage", "https://passport.vip.com/login", "https://vop.vip.com/"])
      expect(isCompassBrowserOrigin(url)).toBe(true);
    for (const url of ["https://www.vip.com/", "https://vis.vip.com.attacker.example/", "https://attacker.vip.com/", "http://vis.vip.com/", "https://user:pass@vis.vip.com/", "https://vis.vip.com:8443/"])
      expect(isCompassBrowserOrigin(url)).toBe(false);
  });
});

describe("short-lived private login drafts", () => {
  function draft(actorId = "17", owner = loginId, expiresAt = new Date(Date.now() + 1800000)) {
    Object.assign(session, { draft_encrypted_state: "private-fixture-draft", draft_actor_id: actorId, draft_login_id: owner, draft_expires_at: expiresAt });
    return expiresAt;
  }

  it("transfers a same-owner draft to a replacement login without extending its absolute expiration", async () => {
    const deadline = draft();
    const first = await service.openCompassLogin(context);
    expect(first.id).not.toBe(loginId);
    expect(session.draft_login_id).toBe(first.id);
    vi.setSystemTime(Date.now() + 600000);
    const second = await service.openCompassLogin({ ...context, key: "second-open" });
    expect(session.draft_login_id).toBe(second.id);
    expect(session.draft_expires_at).toBe(deadline);
    expect(session.draft_encrypted_state).toBe("private-fixture-draft");
    expect(session.status).toBe("READY");
    const transfers = database.db.$executeRawUnsafe.mock.calls.filter(([sql]) => String(sql).startsWith("UPDATE compass_session SET draft_login_id="));
    expect(transfers).toHaveLength(2);
    expect(transfers[0][0]).toContain("draft_actor_id=$2::bigint");
    expect(transfers[0][0]).toContain("draft_expires_at>now()");
    expect(transfers[0][0]).not.toContain("draft_expires_at=");
    expect(transfers[0].slice(1)).toEqual([first.id, "17"]);
    expect(JSON.stringify(first)).not.toContain("draft");
  });

  it("does not transfer another actor's draft even to a managing account", async () => {
    draft("other-owner");
    await service.openCompassLogin(context);
    expect(session.draft_actor_id).toBe("other-owner");
    expect(session.draft_login_id).toBe(loginId);
    expect(session.draft_encrypted_state).toBe("private-fixture-draft");
  });

  it("deletes expired drafts before a new login without altering the verified session", async () => {
    draft("17", loginId, new Date(Date.now()));
    await service.openCompassLogin(context);
    expect(session.draft_encrypted_state).toBeNull();
    expect(session.draft_actor_id).toBeNull();
    expect(session.draft_login_id).toBeNull();
    expect(session.draft_expires_at).toBeNull();
    expect(session.encrypted_state).toBe("private-fixture-state");
    expect(session.status).toBe("READY");
  });

  it("cancels the active claim under its login lock and clears only that window's draft", async () => {
    draft();
    login.claim_token = "private-fixture-claim";
    await service.cancelCompassLogin(context, loginId);
    expect(login.status).toBe("CANCELLED");
    expect(login.claim_token).toBeNull();
    expect(session.draft_encrypted_state).toBeNull();
    expect(session.encrypted_state).toBe("private-fixture-state");
    const locked = database.one.mock.calls.find(([, sql]) => String(sql).includes("FROM compass_logins WHERE id="));
    expect(locked?.[1]).toContain("FOR UPDATE");
    const globalLock = database.rows.mock.calls.findIndex(([, sql], index) => index > 0 && String(sql).includes("pg_advisory_xact_lock($1)"));
    expect(globalLock).toBeGreaterThan(0);
    expect(database.rows.mock.invocationCallOrder[globalLock]).toBeLessThan(database.one.mock.invocationCallOrder[database.one.mock.calls.indexOf(locked!)]);
    const writes = database.db.$executeRawUnsafe.mock.calls;
    const cancel = writes.findIndex(([sql]) => String(sql).startsWith("UPDATE compass_logins SET status='CANCELLED'"));
    const clear = writes.findIndex(([sql]) => String(sql).startsWith("UPDATE compass_session SET draft_encrypted_state=NULL"));
    expect(cancel).toBeLessThan(clear);
    expect(writes[cancel][0]).toContain("claim_token=NULL");
    expect(writes[clear][0]).toContain("draft_login_id=$1::uuid");
  });

  it("does not clear a newer replacement window's draft when an old window is cancelled", async () => {
    const replacement = "fb8c3b6b-85c7-439a-b139-ed445a00ff15";
    draft("17", replacement); login.status = "FAILED";
    await service.cancelCompassLogin(context, loginId);
    expect(session.draft_login_id).toBe(replacement);
    expect(session.draft_encrypted_state).toBe("private-fixture-draft");
  });

  it("disconnects both the verified session and every draft", async () => {
    draft("other-owner");
    await service.disconnectCompassSession(context);
    expect(session.status).toBe("DISCONNECTED");
    expect(session.encrypted_state).toBeNull();
    expect(session.draft_encrypted_state).toBeNull();
    expect(session.draft_login_id).toBeNull();
    expect(session.draft_actor_id).toBeNull();
    expect(session.draft_expires_at).toBeNull();
  });

  it("never exposes a draft or accepts it as a verified update session", async () => {
    draft(); session.status = "LOGIN_REQUIRED";
    const status = await service.compassUpdateStatus();
    const view = await service.compassLoginView(context, loginId);
    expect(JSON.stringify(status)).not.toContain("private-fixture");
    expect(JSON.stringify(view)).not.toContain("draft");
    await expect(service.requestCompassUpdate(context, {})).rejects.toMatchObject({ response: { error: { code: "COMPASS_LOGIN_REQUIRED" } } });
    expect(database.one.mock.calls.some(([, sql]) => String(sql).startsWith("INSERT INTO compass_update_jobs"))).toBe(false);
  });
});

describe("opt-in daily server updates", () => {
  it("requires the independent login and a verified three-dimension manual update to enable", async () => {
    await expect(service.saveCompassAutoUpdate(context, { enabled: true })).rejects.toMatchObject({ response: { error: { code: "COMPASS_AUTO_UPDATE_NOT_READY" } } });
    verifiedBefore = true;
    await expect(service.saveCompassAutoUpdate(context, { enabled: true })).resolves.toMatchObject({ enabled: true, eligible: true, dailyHour: 8 });
    session.status = "LOGIN_REQUIRED";
    await expect(service.saveCompassAutoUpdate(context, { enabled: true })).rejects.toMatchObject({ status: 409 });
  });

  it("allows pausing the daily task when its browser login or worker is unavailable", async () => {
    session.status = "LOGIN_REQUIRED";
    session.worker_online = false;
    await expect(service.saveCompassAutoUpdate(context, { enabled: false })).resolves.toMatchObject({ enabled: false, eligible: false });
    const saved = database.db.$executeRawUnsafe.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE compass_session SET auto_update_enabled"));
    expect(saved?.slice(1)).toEqual([false, "17"]);
  });

  it("starts at the next 08:00 after enabling later in the day, without running immediately", async () => {
    verifiedBefore = true;
    vi.setSystemTime(new Date("2026-10-11T03:00:00Z"));
    await expect(service.saveCompassAutoUpdate(context, { enabled: true })).resolves.toMatchObject({ enabled: true, lastScheduledDay: "2026-10-11" });
    const saved = database.db.$executeRawUnsafe.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE compass_session SET auto_update_enabled"));
    expect(saved?.[0]).toContain("NOT auto_update_enabled");
    expect(saved?.[0]).toContain("AT TIME ZONE 'Asia/Shanghai'");
    expect(database.one.mock.calls.some(([, sql]) => String(sql).startsWith("INSERT INTO compass_update_jobs"))).toBe(false);
  });
});

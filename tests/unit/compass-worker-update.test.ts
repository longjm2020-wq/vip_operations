import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "@playwright/test";
import type { CompassDimension } from "../../packages/contracts/src/compass-analytics.js";

const database = vi.hoisted(() => ({ db: { $transaction: vi.fn(), $executeRawUnsafe: vi.fn() }, one: vi.fn(), rows: vi.fn() }));
const helpers = vi.hoisted(() => ({
  ready: true,
  verify: vi.fn(), finish: vi.fn(), expire: vi.fn(), decrypt: vi.fn(), encrypt: vi.fn(), draftDecrypt: vi.fn(), draftEncrypt: vi.fn(),
  read: vi.fn(), begin: vi.fn(), append: vi.fn(), importFinish: vi.fn(), check: vi.fn(), open: vi.fn(), download: vi.fn(), cleanup: vi.fn(),
  BrowserError: class extends Error { constructor(public code: string, message: string) { super(message); } },
  StaleReportError: class extends Error {
    constructor(public actualStartDate: string, public actualEndDate: string, public expectedStartDate: string, public expectedEndDate: string) { super("报表日期不匹配"); }
  },
}));
vi.mock("../../packages/database/src/index.js", () => database);
vi.mock("../../apps/api/src/modules/analytics/browser-update.js", () => ({
  expireCompassTasks: helpers.expire, finishCompassUpdate: helpers.finish, verifyCompassUpdateSources: helpers.verify,
}));
vi.mock("../../apps/api/src/modules/analytics/service.js", () => ({ beginImport: helpers.begin, appendImport: helpers.append, finishImport: helpers.importFinish }));
vi.mock("../../apps/worker/src/compass-browser-state.js", () => ({ compassEncryptionReady: () => helpers.ready, decryptCompassState: helpers.decrypt, encryptCompassState: helpers.encrypt, decryptCompassLoginDraft: helpers.draftDecrypt, encryptCompassLoginDraft: helpers.draftEncrypt }));
vi.mock("../../apps/worker/src/compass-report-import.js", () => ({ readCompassDownload: helpers.read, StaleCompassReportError: helpers.StaleReportError }));
vi.mock("../../apps/worker/src/compass-report-browser.js", () => ({
  compassSourceUrl: "https://vis.vip.com/index.php#/homepage",
  checkCompassLogin: helpers.check, openCompassReports: helpers.open, downloadCompassReports: helpers.download,
  cleanupCompassDownloads: helpers.cleanup, CompassBrowserError: helpers.BrowserError,
}));
import { processCompassLogin, processCompassUpdate, scheduleCompassUpdate, checkpointCompassLoginDraft, scopedCompassLoginDraft, compassLoginDiagnostic } from "../../apps/worker/src/compass-browser-update.js";

const state = { cookies: [], origins: [{ origin: "https://vis.vip.com", localStorage: [] }] };
let authorized: boolean, jobStatus: string, claim: string, dimensions: CompassDimension[], version: number, enabled: boolean;
let sessionStatus: string, lastScheduled: Date | null, hour: number, today: string, scheduledEnabled: boolean;
let hasQueued: boolean, loginQueued: boolean, loginAlive: boolean, actionPending: boolean, transactionCount: number, revokeOnSave: boolean;
let tasks: Map<string, CompassDimension>;
let draftState: Record<string, any> | undefined;
let loginFrameId: string | null, loginAction: Record<string, any>;

function createBrowser(configure?: (page: Record<string, any>, context: Record<string, any>) => void) {
  const contexts: Record<string, any>[] = [];
  const frameLocators = [{ nested: false }, { nested: true }];
  const frames = frameLocators.map(locator => ({ locator: vi.fn().mockReturnValue(locator) }));
  const browser = {
    close: vi.fn().mockResolvedValue(undefined),
    newContext: vi.fn().mockImplementation(async () => {
      const context: Record<string, any> = { route: vi.fn().mockResolvedValue(undefined), on: vi.fn(), close: vi.fn().mockResolvedValue(undefined), storageState: vi.fn().mockResolvedValue(state) };
      const page = { context: () => context, goto: vi.fn().mockResolvedValue(undefined), url: () => "https://vis.vip.com/index.php#/homepage", isClosed: () => false,
        mouse: { click: vi.fn(), wheel: vi.fn() }, locator: vi.fn(), screenshot: vi.fn().mockResolvedValue(Buffer.from("fixture-frame")), frames: () => frames };
      context.fixturePage = page;
      context.newPage = vi.fn().mockResolvedValue(page);
      context.pages = () => [page];
      configure?.(page, context);
      contexts.push(context);
      return context;
    }),
  };
  return { contexts, browser, frames, frameLocators, launch: vi.fn().mockResolvedValue(browser as unknown as Browser) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
  helpers.ready = true;
  authorized = true; jobStatus = "QUEUED"; claim = ""; dimensions = []; version = 7; enabled = true; sessionStatus = "READY";
  lastScheduled = null; hour = 8; today = "2026-10-11"; scheduledEnabled = true;
  hasQueued = true; loginQueued = false; loginAlive = true; actionPending = true; transactionCount = 0; revokeOnSave = false;
  tasks = new Map();
  draftState = undefined;
  loginFrameId = null; loginAction = { kind: "CHECK" };
  database.db.$transaction.mockImplementation(async fn => {
    transactionCount++;
    return fn(database.db);
  });
  database.rows.mockResolvedValue([]);
  database.one.mockImplementation(async (_tx, sql: string, ...values: unknown[]) => {
    if (sql.includes("SELECT u.id")) return authorized ? { id: "17", username: "fixture", display_name: "Fixture" } : undefined;
    if (sql.includes("FROM compass_logins")) {
      if (revokeOnSave && sql.startsWith("SELECT id FROM") && sql.includes("claim_token=$2")) authorized = false;
      if (sql.startsWith("SELECT id FROM") && sql.includes("status='QUEUED'")) return loginQueued ? { id: "84e1c739-04d9-43f5-a4b3-65c1efb5ce3e" } : undefined;
      if (sql.startsWith("SELECT status,frame_id")) return loginAlive ? { status: "WAITING", frame_id: loginFrameId } : undefined;
      if (sql.includes("claim_token=$2")) return loginAlive ? { id: values[0] } : undefined;
      return sql.includes("'QUEUED'") && loginQueued ? { active: true } : undefined;
    }
    if (sql.startsWith("UPDATE compass_logins")) return { id: values[0], actor_id: "17", expires_ms: Date.now() + 600000 };
    if (sql.includes("FROM compass_login_actions")) return actionPending ? { id: "51", payload: loginAction } : undefined;
    if (sql.includes("FROM compass_session")) {
      if (sql.startsWith("SELECT *")) return { auto_update_enabled: scheduledEnabled, auto_update_by: "17", daily_hour: 8, last_scheduled_day: lastScheduled,
        today, hour, enabled, status: sessionStatus, encrypted_state: "fixture-cipher" };
      return { enabled, status: sessionStatus, encrypted_state: "fixture-cipher", state_version: version, ...draftState };
    }
    if (sql.includes("FROM compass_update_jobs")) {
      if (sql.startsWith("SELECT id FROM")) return hasQueued && jobStatus === "QUEUED" ? { id: "41" } : undefined;
      if (sql.includes("id=$1")) return jobStatus === "RUNNING" && values[1] === claim ? { owned: true } : undefined;
      return ["RUNNING", "LOGIN_REQUIRED", "VERIFICATION_REQUIRED"].includes(jobStatus) ? { active: true } : undefined;
    }
    if (sql.startsWith("UPDATE compass_update_jobs")) {
      jobStatus = "RUNNING"; claim = String(values[1]);
      return { id: "41", requested_by: "17", target_start_date: new Date("2026-09-11T00:00:00Z"), target_end_date: new Date("2026-10-10T00:00:00Z"), deadline_ms: Date.now() + 3600000 };
    }
    throw Error("Unexpected worker fixture query");
  });
  database.db.$executeRawUnsafe.mockImplementation(async (sql: string, ...values: unknown[]) => {
    if (sql.startsWith("UPDATE compass_session SET draft_encrypted_state=$1")) draftState = { draft_encrypted_state: values[0], draft_actor_id: values[1], draft_login_id: values[2], draft_expires_at: values[3] };
    if (sql.startsWith("UPDATE compass_session SET enabled=true")) draftState = undefined;
    if (sql.startsWith("UPDATE compass_logins SET frame_jpeg=NULL")) loginFrameId = null;
    if (sql.startsWith("UPDATE compass_logins SET frame_jpeg=$3")) loginFrameId = String(values[3]);
    if (sql.startsWith("UPDATE compass_login_actions")) actionPending = false;
    if (sql.startsWith("UPDATE compass_update_jobs SET status=$3")) jobStatus = String(values[2]);
    if (sql.startsWith("UPDATE compass_session SET status=")) {
      if (enabled && version === values[2]) sessionStatus = String(values[0]);
    }
    if (sql.startsWith("UPDATE compass_session SET encrypted_state=")) {
      if (enabled && sessionStatus === "READY" && version === values[1]) return 1;
      return 0;
    }
    if (sql.startsWith("UPDATE compass_session SET last_scheduled_day=")) lastScheduled = new Date(String(values[0]) + "T00:00:00Z");
    if (sql.includes("auto_update_enabled=false")) scheduledEnabled = false;
    if (sql.startsWith("INSERT INTO compass_update_jobs")) jobStatus = String(values[3]);
    return 1;
  });
  helpers.verify.mockImplementation(async () => ({ complete: dimensions.length === 3, completedDimensions: dimensions, sourceIds: Object.fromEntries(dimensions.map(dimension => [dimension, dimension + "-source"])) }));
  helpers.finish.mockImplementation(async () => { jobStatus = dimensions.length === 3 ? "COMPLETE" : dimensions.length ? "PARTIAL" : "FAILED"; return { status: jobStatus }; });
  helpers.expire.mockResolvedValue(undefined);
  helpers.decrypt.mockReturnValue(state);
  helpers.encrypt.mockReturnValue("new-fixture-cipher");
  helpers.draftEncrypt.mockReturnValue("new-fixture-draft");
  helpers.draftDecrypt.mockReturnValue(state);
  helpers.check.mockResolvedValue({ verified: true, reason: "READY", note: "fixture" });
  helpers.open.mockImplementation(async page => page);
  helpers.download.mockImplementation(async (_page, missing: CompassDimension[]) => missing.map(dimension => ({ dimension, fileName: dimension + ".xlsx", path: "/fixture/" + dimension + ".xlsx", tempDirectory: "/fixture" })));
  helpers.cleanup.mockResolvedValue(undefined);
  helpers.read.mockImplementation(async file => ({ report: { dimension: file.dimension, startDate: "2026-09-11", endDate: "2026-10-10", records: Array.from({ length: file.dimension === "style" ? 1001 : 1 }, (_, index) => ({ fixture: index })) }, fileHash: "a".repeat(64) }));
  helpers.begin.mockImplementation(async (_context, report) => {
    const id = String(101 + tasks.size); tasks.set(id, report.dimension); return { id, status: "STAGING" };
  });
  helpers.append.mockResolvedValue({ received_rows: 1000 });
  helpers.importFinish.mockImplementation(async (_context, id) => { const dimension = tasks.get(id)!; dimensions = [...dimensions, dimension]; return { status: "COMPLETE" }; });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("private login draft checkpoints", () => {
  const job = { id: "84e1c739-04d9-43f5-a4b3-65c1efb5ce3e", actor_id: "17" };
  const token = "bcc005a1-0d2e-4d73-a174-bd2e497f9fe0";
  const draftWrites = () => database.db.$executeRawUnsafe.mock.calls.filter(([sql]) => String(sql).startsWith("UPDATE compass_session SET draft_encrypted_state=$1"));

  it("rejects a draft for another actor, login window, or expired deadline", () => {
    const now = Date.now();
    const saved = { draft_encrypted_state: "private-draft", draft_actor_id: "17", draft_login_id: job.id, draft_expires_at: new Date(now + 60000) };
    expect(scopedCompassLoginDraft(saved, "17", job.id, now)).toEqual({ encrypted: "private-draft", expiresAtMs: now + 60000 });
    expect(scopedCompassLoginDraft(saved, "18", job.id, now)).toBeNull();
    expect(scopedCompassLoginDraft(saved, "17", "different-login", now)).toBeNull();
    expect(scopedCompassLoginDraft(saved, "17", job.id, now + 60000)).toBeNull();
  });

  it("checks the active claim after collecting storage and cannot revive a cancellation", async () => {
    const browser = createBrowser();
    const context = await browser.browser.newContext();
    context.storageState.mockImplementation(async () => { loginAlive = false; return state; });
    const result = await checkpointCompassLoginDraft(context as any, job, token);
    expect(result.active).toBe(false);
    expect(draftWrites()).toHaveLength(0);
    const activeQuery = database.one.mock.calls.find(([, sql]) => String(sql).includes("FROM compass_logins"))!;
    expect(activeQuery[1]).toContain("actor_id=$3::bigint AND claim_token=$2::uuid");
    expect(activeQuery[1]).toContain("expires_at>now() FOR UPDATE");
    expect(database.one.mock.calls.some(([, sql]) => String(sql).includes("FROM compass_session"))).toBe(false);
  });

  it("locks and checks permission before writing all four draft fields without extending its original TTL", async () => {
    const browser = createBrowser();
    const context = await browser.browser.newContext();
    const first = await checkpointCompassLoginDraft(context as any, job, token);
    expect(first.expiresAtMs).toBe(Date.now() + 30 * 60000);
    const lock = database.rows.mock.invocationCallOrder[0];
    const login = database.one.mock.invocationCallOrder[0], actor = database.one.mock.invocationCallOrder[1], session = database.one.mock.invocationCallOrder[2];
    expect(lock).toBeLessThan(login); expect(login).toBeLessThan(actor); expect(actor).toBeLessThan(session);
    expect(draftWrites()[0][0]).toContain("draft_actor_id=$2::bigint,draft_login_id=$3::uuid,draft_expires_at=$4::timestamptz");
    await vi.advanceTimersByTimeAsync(20 * 60000);
    const second = await checkpointCompassLoginDraft(context as any, job, token, first.expiresAtMs!);
    expect(second.expiresAtMs).toBe(first.expiresAtMs);
    expect(draftWrites()[1][4]).toBe(draftWrites()[0][4]);
    await vi.advanceTimersByTimeAsync(10 * 60000);
    // Expiry maintenance clears the row; a running process must retain its
    // original deadline and cannot create another 30-minute draft.
    draftState = undefined;
    await checkpointCompassLoginDraft(context as any, job, token, first.expiresAtMs!);
    expect(draftWrites()).toHaveLength(2);
  });

  it("cannot write a draft after the actor loses import permission", async () => {
    authorized = false;
    const context = await createBrowser().browser.newContext();
    await expect(checkpointCompassLoginDraft(context as any, job, token)).rejects.toThrow("不再拥有经营分析导入权限");
    expect(draftWrites()).toHaveLength(0);
  });
});

describe("background update orchestration", () => {
  it("does not claim or open a browser without its separate encryption configuration", async () => {
    helpers.ready = false;
    const browser = createBrowser();
    await processCompassUpdate(browser.launch);
    expect(database.one).not.toHaveBeenCalled();
    expect(browser.launch).not.toHaveBeenCalled();
  });

  it("uses a locked claim and skips another running update or active login", async () => {
    const browser = createBrowser();
    jobStatus = "RUNNING";
    await processCompassUpdate(browser.launch);
    expect(browser.launch).not.toHaveBeenCalled();
    jobStatus = "QUEUED"; loginQueued = true;
    await processCompassUpdate(browser.launch);
    expect(browser.launch).not.toHaveBeenCalled();
    loginQueued = false;
    await processCompassUpdate(browser.launch);
    expect(browser.launch).toHaveBeenCalledTimes(1);
    expect(database.rows.mock.calls.some(([, sql]) => String(sql).includes("pg_advisory_xact_lock(2026101140)"))).toBe(true);
    expect(database.one.mock.calls.some(([, sql]) => String(sql).includes("deadline_at>now()") && String(sql).includes("FOR UPDATE SKIP LOCKED"))).toBe(true);
  });

  it("does not execute an already aborted update", async () => {
    const controller = new AbortController(); controller.abort();
    const browser = createBrowser();
    await processCompassUpdate(browser.launch, controller.signal);
    expect(database.one).not.toHaveBeenCalled();
    expect(browser.launch).not.toHaveBeenCalled();
  });

  it("uses the final source gate without downloading when all three sources are already current", async () => {
    dimensions = ["style", "article", "barcode"];
    const browser = createBrowser();
    await processCompassUpdate(browser.launch);
    expect(helpers.finish).toHaveBeenCalledWith("41", expect.any(String));
    expect(jobStatus).toBe("COMPLETE");
    expect(browser.launch).not.toHaveBeenCalled();
    expect(helpers.download).not.toHaveBeenCalled();
  });

  it("reuses the independent saved state, imports in bounded chunks, and completes only after source verification", async () => {
    const browser = createBrowser();
    await processCompassUpdate(browser.launch);
    expect(browser.browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState: state, acceptDownloads: true, timezoneId: "Asia/Shanghai" }));
    expect(helpers.decrypt).toHaveBeenCalledWith("fixture-cipher");
    expect(helpers.append.mock.calls.map(([, , batch]) => batch.records.length)).toEqual([1000, 1, 1, 1]);
    expect(helpers.importFinish).toHaveBeenCalledTimes(3);
    expect(helpers.finish).toHaveBeenCalledTimes(1);
    expect(jobStatus).toBe("COMPLETE");
    expect(browser.browser.close).toHaveBeenCalled();
    expect(helpers.cleanup).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ dimension: "style" })]));
  });

  it("never restores a login draft into a background update", async () => {
    draftState = { draft_encrypted_state: "private-draft", draft_actor_id: "17", draft_login_id: "84e1c739-04d9-43f5-a4b3-65c1efb5ce3e", draft_expires_at: new Date(Date.now() + 60000) };
    await processCompassUpdate(createBrowser().launch);
    expect(helpers.draftDecrypt).not.toHaveBeenCalled();
    expect(helpers.draftEncrypt).not.toHaveBeenCalled();
    expect(helpers.decrypt).toHaveBeenCalledWith("fixture-cipher");
  });

  it("stops before another chunk if import permissions are revoked", async () => {
    dimensions = ["barcode"];
    helpers.append.mockImplementationOnce(async () => { authorized = false; return { received_rows: 1000 }; });
    const browser = createBrowser();
    await processCompassUpdate(browser.launch);
    expect(helpers.append).toHaveBeenCalledTimes(1);
    expect(helpers.importFinish).not.toHaveBeenCalled();
    expect(helpers.finish).not.toHaveBeenCalled();
    expect(jobStatus).toBe("PARTIAL");
    expect(dimensions).toEqual(["barcode"]);
    expect(helpers.cleanup).toHaveBeenCalled();
  });

  it("cannot import or write a result after its update claim is replaced", async () => {
    const download = helpers.download.getMockImplementation()!;
    helpers.download.mockImplementation(async (...args) => {
      const files = await download(...args); claim = "replacement-worker-claim";
      return files;
    });
    await processCompassUpdate(createBrowser().launch);
    expect(helpers.begin).not.toHaveBeenCalled();
    expect(helpers.finish).not.toHaveBeenCalled();
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE compass_update_jobs SET status=$3"))).toBe(false);
    expect(helpers.cleanup).toHaveBeenCalled();
  });

  it("stops before importing if its absolute deadline passes while parsing a download", async () => {
    const read = helpers.read.getMockImplementation()!;
    helpers.read.mockImplementationOnce(async (...args) => {
      const parsed = await read(...args); vi.setSystemTime(Date.now() + 3600000);
      return parsed;
    });
    const browser = createBrowser();
    await processCompassUpdate(browser.launch);
    expect(helpers.begin).not.toHaveBeenCalled();
    expect(helpers.finish).not.toHaveBeenCalled();
    expect(jobStatus).toBe("FAILED");
    expect(browser.browser.close).toHaveBeenCalled();
    expect(helpers.cleanup).toHaveBeenCalled();
  });

  it("closes its browser and stops before parsing or importing after shutdown is requested", async () => {
    const controller = new AbortController();
    const download = helpers.download.getMockImplementation()!;
    helpers.download.mockImplementationOnce(async (...args) => {
      const files = await download(...args); controller.abort();
      return files;
    });
    const browser = createBrowser();
    await processCompassUpdate(browser.launch, controller.signal);
    expect(helpers.read).not.toHaveBeenCalled();
    expect(helpers.begin).not.toHaveBeenCalled();
    expect(helpers.finish).not.toHaveBeenCalled();
    expect(browser.browser.close).toHaveBeenCalled();
    expect(jobStatus).toBe("FAILED");
  });

  it("heartbeats a long download only while holding its running claim", async () => {
    const download = helpers.download.getMockImplementation()!;
    helpers.download.mockImplementationOnce(async (...args) => {
      await vi.advanceTimersByTimeAsync(10001);
      return download(...args);
    });
    await processCompassUpdate(createBrowser().launch);
    const beats = database.db.$executeRawUnsafe.mock.calls.filter(([sql]) => String(sql).startsWith("UPDATE compass_update_jobs SET heartbeat_at="));
    expect(beats).toHaveLength(1);
    expect(beats[0][0]).toContain("claim_token=$2::uuid AND status='RUNNING'");
    expect(jobStatus).toBe("COMPLETE");
  });

  it("regenerates only a stale style report once before importing all dimensions", async () => {
    helpers.read.mockRejectedValueOnce(new helpers.StaleReportError("2026-09-10", "2026-10-09", "2026-09-11", "2026-10-10"));
    await processCompassUpdate(createBrowser().launch);
    expect(helpers.download.mock.calls.map(([, missing]) => missing)).toEqual([["style"], ["style"], ["article"], ["barcode"]]);
    expect(helpers.download.mock.calls[1][6]).toEqual({ forceGenerate: true });
    expect(helpers.download.mock.calls.filter(call => call[6]?.forceGenerate)).toHaveLength(1);
    expect(helpers.read).toHaveBeenCalledTimes(4);
    expect(helpers.cleanup.mock.calls[0][0]).toEqual([expect.objectContaining({ dimension: "style" })]);
    expect(helpers.importFinish).toHaveBeenCalledTimes(3);
    expect(jobStatus).toBe("COMPLETE");
  });

  it("stops after a second stale report without another download or import", async () => {
    const stale = new helpers.StaleReportError("2026-09-10", "2026-10-09", "2026-09-11", "2026-10-10");
    helpers.read.mockRejectedValueOnce(stale).mockRejectedValueOnce(stale);
    await processCompassUpdate(createBrowser().launch);
    expect(helpers.download).toHaveBeenCalledTimes(2);
    expect(helpers.read).toHaveBeenCalledTimes(2);
    expect(helpers.begin).not.toHaveBeenCalled();
    expect(helpers.finish).not.toHaveBeenCalled();
    expect(jobStatus).toBe("FAILED");
    expect(helpers.cleanup.mock.calls.at(-1)?.[0]).toHaveLength(2);
  });

  it("keeps an imported style dimension when the next report has malformed content", async () => {
    const read = helpers.read.getMockImplementation()!;
    helpers.read.mockImplementation(async (...args) => {
      if (args[0].dimension === "article") throw Error("报表缺少必需列");
      return read(...args);
    });
    await processCompassUpdate(createBrowser().launch);
    expect(helpers.download.mock.calls.map(([, missing]) => missing)).toEqual([["style"], ["article"]]);
    expect(helpers.importFinish).toHaveBeenCalledTimes(1);
    expect(helpers.finish).not.toHaveBeenCalled();
    expect(dimensions).toEqual(["style"]);
    expect(jobStatus).toBe("PARTIAL");
    expect(helpers.cleanup).toHaveBeenCalled();
  });

  it("does not overwrite disconnected or replaced state after a late login failure", async () => {
    helpers.download.mockImplementation(async () => {
      jobStatus = "FAILED"; enabled = false; version++; sessionStatus = "DISCONNECTED";
      throw new helpers.BrowserError("LOGIN_REQUIRED", "fixture expired login");
    });
    await processCompassUpdate(createBrowser().launch);
    expect(jobStatus).toBe("FAILED");
    expect(sessionStatus).toBe("DISCONNECTED");
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE compass_session SET status="))).toBe(false);
    expect(helpers.begin).not.toHaveBeenCalled();
  });

  it("checks the saved version before marking an expired login, preserving a newer valid session", async () => {
    helpers.download.mockImplementation(async () => { version++; throw new helpers.BrowserError("LOGIN_REQUIRED", "fixture expired login"); });
    await processCompassUpdate(createBrowser().launch);
    expect(jobStatus).toBe("LOGIN_REQUIRED");
    expect(sessionStatus).toBe("READY");
    const attempted = database.db.$executeRawUnsafe.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE compass_session SET status="));
    expect(attempted?.[0]).toContain("AND enabled AND state_version=$3");
    expect(attempted?.[3]).toBe(7);
    expect(helpers.finish).not.toHaveBeenCalled();
  });

  it("preserves verification-required work for user handling instead of marking it complete", async () => {
    helpers.open.mockRejectedValue(new helpers.BrowserError("HUMAN_VERIFICATION", "fixture requires manual verification"));
    await processCompassUpdate(createBrowser().launch);
    expect(jobStatus).toBe("VERIFICATION_REQUIRED");
    expect(sessionStatus).toBe("VERIFICATION_REQUIRED");
    expect(helpers.begin).not.toHaveBeenCalled();
    expect(helpers.finish).not.toHaveBeenCalled();
  });
});

describe("interactive login completion", () => {
  it("does not claim an interactive login while another update is running", async () => {
    loginQueued = true; jobStatus = "RUNNING";
    const browser = createBrowser();
    await processCompassLogin(browser.launch);
    expect(browser.launch).not.toHaveBeenCalled();
    expect(database.rows.mock.calls[0][1]).toContain("pg_advisory_xact_lock(2026101140)");
  });

  it("verifies a new independent context before saving encrypted login state", async () => {
    loginQueued = true; hasQueued = false;
    const browser = createBrowser();
    await processCompassLogin(browser.launch);
    expect(browser.browser.newContext).toHaveBeenCalledTimes(2);
    expect(browser.contexts[0].fixturePage.goto).toHaveBeenCalledWith("https://vis.vip.com/index.php#/homepage", expect.any(Object));
    expect(helpers.check).toHaveBeenCalledTimes(2);
    expect(helpers.encrypt).toHaveBeenCalledWith(state);
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).includes("status='SAVED'"))).toBe(true);
    expect(browser.browser.close).toHaveBeenCalled();
  });

  it("restores the matching private draft ahead of an older verified session", async () => {
    loginQueued = true; hasQueued = false;
    const restored = { cookies: [], origins: [{ origin: "https://vis.vip.com", localStorage: [{ name: "fixture", value: "resumed-draft" }] }] };
    draftState = { draft_encrypted_state: "private-draft", draft_actor_id: "17", draft_login_id: "84e1c739-04d9-43f5-a4b3-65c1efb5ce3e", draft_expires_at: new Date(Date.now() + 60000) };
    helpers.draftDecrypt.mockReturnValue(restored);
    const browser = createBrowser();
    await processCompassLogin(browser.launch);
    expect(helpers.draftDecrypt).toHaveBeenCalledWith("private-draft", "17");
    expect(browser.browser.newContext.mock.calls[0][0].storageState).toEqual(restored);
    expect(helpers.decrypt).not.toHaveBeenCalledWith("fixture-cipher");
    expect(draftState).toBeUndefined();
    const saved = database.db.$executeRawUnsafe.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE compass_session SET enabled=true"));
    expect(saved?.[0]).toContain("draft_encrypted_state=NULL,draft_actor_id=NULL,draft_login_id=NULL,draft_expires_at=NULL");
  });

  it.each(["actor", "login", "expired"])("does not resume an invalid %s draft", async reason => {
    loginQueued = true; hasQueued = false;
    draftState = { draft_encrypted_state: "private-draft", draft_actor_id: reason === "actor" ? "18" : "17", draft_login_id: reason === "login" ? "different-login" : "84e1c739-04d9-43f5-a4b3-65c1efb5ce3e", draft_expires_at: new Date(Date.now() + (reason === "expired" ? -1 : 60000)) };
    const browser = createBrowser();
    await processCompassLogin(browser.launch);
    expect(helpers.draftDecrypt).not.toHaveBeenCalled();
    expect(browser.browser.newContext.mock.calls[0][0].storageState).toEqual(state);
    expect(helpers.decrypt).toHaveBeenCalledWith("fixture-cipher");
  });

  it("allows repair of an enabled session after an expired-login status while still requiring the reuse probe", async () => {
    loginQueued = true; hasQueued = false; sessionStatus = "LOGIN_REQUIRED";
    const browser = createBrowser();
    await processCompassLogin(browser.launch);
    expect(browser.browser.newContext.mock.calls[0][0].storageState).toEqual(state);
    expect(helpers.check).toHaveBeenCalledTimes(2);
  });

  it("proves reuse with the exact filtered and encrypted snapshot that is saved", async () => {
    loginQueued = true; hasQueued = false;
    vi.stubEnv("COMPASS_BROWSER_KEY", "a".repeat(64));
    const real = await vi.importActual<typeof import("../../apps/worker/src/compass-browser-state.js")>("../../apps/worker/src/compass-browser-state.js");
    const cookie = { name: "fixture", value: "synthetic", domain: ".vip.com", path: "/", expires: 2000000000, httpOnly: true, secure: true, sameSite: "Lax" };
    const raw = { cookies: [cookie, { ...cookie, domain: "www.vip.com", value: "excluded-fixture" }], origins: [
      { origin: "https://vis.vip.com", localStorage: [{ name: "fixture", value: "supplier" }], indexedDB: [{ name: "fixture-db", version: 1, stores: [] }] },
      { origin: "https://www.vip.com", localStorage: [{ name: "excluded", value: "excluded-fixture" }] },
    ] };
    helpers.encrypt.mockImplementation(real.encryptCompassState);
    helpers.decrypt.mockImplementation(value => value === "fixture-cipher" ? state : real.decryptCompassState(value));
    const browser = createBrowser();
    const newContext = browser.browser.newContext.getMockImplementation()!;
    browser.browser.newContext.mockImplementation(async (...args) => {
      const context = await newContext(...args);
      if (browser.contexts.length === 1) context.storageState.mockResolvedValue(raw);
      return context;
    });
    await processCompassLogin(browser.launch);
    const probeState = browser.browser.newContext.mock.calls[1][0].storageState;
    expect(probeState).toEqual(real.compassOnlyState(raw));
    expect(JSON.stringify(probeState)).not.toContain("excluded-fixture");
    const saved = database.db.$executeRawUnsafe.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE compass_session SET enabled=true"));
    expect(saved).toBeDefined();
    expect(real.decryptCompassState(String(saved?.[1]))).toEqual(probeState);
    expect(helpers.encrypt).toHaveBeenCalledTimes(1);
    expect(browser.contexts[1].storageState).not.toHaveBeenCalled();
  });

  it("does not save when the normalized reuse probe fails even though the interactive page works", async () => {
    loginQueued = true; hasQueued = false;
    helpers.check.mockResolvedValueOnce({ verified: true, reason: "READY" }).mockImplementationOnce(async () => {
      loginAlive = false;
      return { verified: false, reason: "LOGIN_REQUIRED", note: "fixture normalized snapshot cannot reuse login" };
    });
    const browser = createBrowser();
    await processCompassLogin(browser.launch);
    expect(helpers.decrypt).toHaveBeenCalledWith("new-fixture-cipher");
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE compass_session SET enabled=true"))).toBe(false);
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).includes("status='SAVED'"))).toBe(false);
    expect(browser.contexts[1].close).toHaveBeenCalled();
  });

  it("rechecks permission inside the save transaction after the reusable login probe", async () => {
    loginQueued = true; hasQueued = false; revokeOnSave = true;
    await processCompassLogin(createBrowser().launch);
    expect(transactionCount).toBe(5);
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).includes("status='SAVED'"))).toBe(false);
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).includes("status='FAILED'"))).toBe(true);
  });

  it("does not save after its login ownership is cancelled or expires during the probe", async () => {
    loginQueued = true; hasQueued = false;
    helpers.encrypt.mockImplementation(() => { loginAlive = false; return "late-fixture-cipher"; });
    await processCompassLogin(createBrowser().launch);
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).includes("status='SAVED'"))).toBe(false);
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE compass_session SET enabled=true"))).toBe(false);
  });

  it("masks editable values in both main and nested SSO frames before publishing a screenshot", async () => {
    loginQueued = true; hasQueued = false; actionPending = false;
    const browser = createBrowser();
    const run = processCompassLogin(browser.launch);
    await vi.advanceTimersByTimeAsync(1);
    const page = browser.contexts[0].fixturePage;
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ mask: browser.frameLocators }));
    for (const frame of browser.frames) expect(frame.locator).toHaveBeenCalledWith('input:not([type="checkbox"]):not([type="radio"]),textarea,[contenteditable="true"]');
    loginAlive = false;
    await vi.advanceTimersByTimeAsync(500);
    await run;
    expect(browser.browser.close).toHaveBeenCalled();
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).includes("status='SAVED'"))).toBe(false);
  });

  it("retains the logged-in context and rebuilds every frame mask after an iframe detaches", async () => {
    loginQueued = true; hasQueued = false; actionPending = false;
    const browser = createBrowser(page => { page.screenshot.mockRejectedValueOnce(Error("Frame was detached during SSO navigation")); });
    const run = processCompassLogin(browser.launch);
    await vi.advanceTimersByTimeAsync(1);
    expect(browser.browser.close).not.toHaveBeenCalled();
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE compass_logins SET frame_jpeg=$3"))).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    const page = browser.contexts[0].fixturePage;
    expect(page.screenshot).toHaveBeenCalledTimes(2);
    expect(page.screenshot.mock.calls[1][0].mask).toEqual(browser.frameLocators);
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE compass_logins SET frame_jpeg=$3"))).toBe(true);
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).includes("status='FAILED'"))).toBe(false);
    loginAlive = false; await vi.advanceTimersByTimeAsync(500); await run;
  });

  it("moves to the latest official tab when SSO closes the previous page", async () => {
    loginQueued = true; hasQueued = false; actionPending = false;
    let popup: Record<string, any> | undefined;
    const browser = createBrowser((page, context) => {
      popup = { ...page, url: () => "https://compass.vip.com/reports", screenshot: vi.fn().mockResolvedValue(Buffer.from("popup-fixture")) };
      let closed = false;
      page.isClosed = () => closed;
      page.screenshot.mockImplementation(async () => {
        closed = true;
        context.pages = () => [page, popup];
        throw Error("Target page has been closed during SSO");
      });
    });
    const run = processCompassLogin(browser.launch);
    await vi.advanceTimersByTimeAsync(501);
    expect(popup?.screenshot).toHaveBeenCalledWith(expect.objectContaining({ mask: browser.frameLocators }));
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE compass_logins SET frame_jpeg=$3"))).toBe(true);
    expect(browser.browser.close).not.toHaveBeenCalled();
    loginAlive = false; await vi.advanceTimersByTimeAsync(500); await run;
  });

  it("does not replay an entry navigation superseded by an official SSO redirect", async () => {
    loginQueued = true; hasQueued = false; actionPending = false;
    const browser = createBrowser(page => { page.goto.mockRejectedValueOnce(Error("net::ERR_ABORTED; navigation interrupted by SSO")); });
    const run = processCompassLogin(browser.launch);
    await vi.advanceTimersByTimeAsync(501);
    const page = browser.contexts[0].fixturePage;
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ mask: browser.frameLocators }));
    expect(browser.browser.close).not.toHaveBeenCalled();
    loginAlive = false; await vi.advanceTimersByTimeAsync(500); await run;
  });

  it.each(["CLICK", "SCROLL", "REFRESH"])("checkpoints before a %s navigation race and resumes without replaying the action", async kind => {
    loginQueued = true; hasQueued = false;
    const frameId = "46b89e6b-cc73-483b-87eb-3b65a07b8c62";
    loginFrameId = frameId;
    loginAction = kind === "CLICK" ? { kind, frameId, point: { x: 0.5, y: 0.5 } } : kind === "SCROLL" ? { kind, frameId, deltaY: 200 } : { kind };
    const browser = createBrowser(page => {
      if (kind === "REFRESH") page.goto.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error("net::ERR_ABORTED during navigation"));
      else page.mouse[kind === "CLICK" ? "click" : "wheel"].mockRejectedValueOnce(Error("Execution context was destroyed by navigation"));
    });
    const run = processCompassLogin(browser.launch);
    await vi.advanceTimersByTimeAsync(1);
    const page = browser.contexts[0].fixturePage;
    const control = kind === "REFRESH" ? page.goto : page.mouse[kind === "CLICK" ? "click" : "wheel"];
    if (kind === "REFRESH") expect(page.goto.mock.calls.map(([url]: [string]) => url)).toEqual(["https://vis.vip.com/index.php#/homepage", "https://vis.vip.com/index.php#/homepage"]);
    const firstDraftWrite = database.db.$executeRawUnsafe.mock.calls.findIndex(([sql]) => String(sql).startsWith("UPDATE compass_session SET draft_encrypted_state=$1"));
    const controlOrder = control.mock.invocationCallOrder[kind === "REFRESH" ? 1 : 0];
    expect(database.db.$executeRawUnsafe.mock.invocationCallOrder[firstDraftWrite]).toBeLessThan(controlOrder);
    expect(browser.browser.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(control).toHaveBeenCalledTimes(kind === "REFRESH" ? 2 : 1);
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ mask: browser.frameLocators }));
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).includes("status='FAILED'"))).toBe(false);
    loginAlive = false; await vi.advanceTimersByTimeAsync(500); await run;
  });

  it("saves one final draft after an automatic SSO transition before reporting a permanent frame failure", async () => {
    loginQueued = true; hasQueued = false; actionPending = false;
    const transitioned = { cookies: [], origins: [{ origin: "https://vis.vip.com", localStorage: [{ name: "fixture", value: "latest-SSO" }] }] };
    const browser = createBrowser((page, context) => {
      page.screenshot.mockImplementation(async () => { context.storageState.mockResolvedValue(transitioned); throw Error("permanent frame read failure with query secret"); });
    });
    await processCompassLogin(browser.launch);
    expect(helpers.draftEncrypt).toHaveBeenLastCalledWith(transitioned, "17");
    expect(draftState?.draft_encrypted_state).toBe("new-fixture-draft");
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).includes("status='FAILED'"))).toBe(true);
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE compass_session SET enabled=true"))).toBe(false);
  });

  it("bounds the final checkpoint and rejects its late result after the login is cancelled", async () => {
    loginQueued = true; hasQueued = false; actionPending = false;
    let resolveSnapshot: ((value: typeof state) => void) | undefined;
    const browser = createBrowser((page, context) => {
      page.screenshot.mockImplementation(async () => {
        context.storageState.mockImplementation(() => new Promise<typeof state>(resolve => { resolveSnapshot = resolve; }));
        throw Error("permanent screenshot failure");
      });
    });
    const run = processCompassLogin(browser.launch);
    await vi.advanceTimersByTimeAsync(1501); await run;
    expect(browser.browser.close).toHaveBeenCalled();
    const writesBeforeCancel = database.db.$executeRawUnsafe.mock.calls.filter(([sql]) => String(sql).startsWith("UPDATE compass_session SET draft_encrypted_state=$1")).length;
    // The API has cancelled/cleared the draft while the old storage read is
    // still completing. The old process must not bring it back.
    loginAlive = false; draftState = undefined;
    resolveSnapshot?.(state);
    await vi.advanceTimersByTimeAsync(1);
    expect(draftState).toBeUndefined();
    expect(database.db.$executeRawUnsafe.mock.calls.filter(([sql]) => String(sql).startsWith("UPDATE compass_session SET draft_encrypted_state=$1"))).toHaveLength(writesBeforeCancel);
  });

  it("bounds repeated navigation failures and emits only safe diagnostic metadata", async () => {
    loginQueued = true; hasQueued = false; actionPending = false;
    const browser = createBrowser(page => {
      page.url = () => "https://vis.vip.com/index.php?token=SECRET&password=SECRET#/homepage";
      page.screenshot.mockRejectedValue(Error("Frame was detached SECRET during SSO"));
    });
    const run = processCompassLogin(browser.launch);
    await vi.advanceTimersByTimeAsync(4500); await run;
    expect(browser.contexts[0].fixturePage.screenshot).toHaveBeenCalledTimes(9);
    expect(console.warn).toHaveBeenCalledWith(JSON.stringify({ event: "compass_login_stopped", stage: "CAPTURE_FRAME", category: "NAVIGATION_CHANGED", hostname: "vis.vip.com" }));
    const failed = database.db.$executeRawUnsafe.mock.calls.find(([sql]) => String(sql).includes("status='FAILED'"));
    expect(failed?.[3]).toContain("页面跳转中断");
    expect(failed?.[3]).not.toMatch(/SECRET|CAPTURE_FRAME|NAVIGATION_CHANGED|index.php/);
    expect(browser.browser.close).toHaveBeenCalled();
  });

  it("reduces unsupported destinations to a hostname and never returns an error body or URL credentials", () => {
    const diagnostic = compassLoginDiagnostic(Error("password=SECRET token=SECRET full stack"), "VERIFY_LOGIN", "https://name:SECRET@vis.vip.com/?token=SECRET", "unrecognized.vip.com");
    expect(diagnostic).toEqual({ stage: "VERIFY_LOGIN", category: "ORIGIN_REJECTED", hostname: "unrecognized.vip.com" });
    expect(JSON.stringify(diagnostic)).not.toContain("SECRET");
  });

  it("identifies the platform error redirect without allowing its hostname or logging its query", () => {
    expect(compassLoginDiagnostic(Error("Target page has been closed SECRET"), "WAITING_ACTION", "https://err.vip.com/?token=SECRET")).toEqual({ stage: "WAITING_ACTION", category: "PLATFORM_ERROR", hostname: "err.vip.com" });
  });

  it("preserves the last good draft when the restored browser is redirected entirely to a platform error page", async () => {
    loginQueued = true; hasQueued = false; actionPending = false;
    draftState = { draft_encrypted_state: "last-good-draft", draft_actor_id: "17", draft_login_id: "84e1c739-04d9-43f5-a4b3-65c1efb5ce3e", draft_expires_at: new Date(Date.now() + 60000) };
    const browser = createBrowser(page => { page.url = () => "https://err.vip.com/?token=SECRET"; });
    const run = processCompassLogin(browser.launch);
    await vi.advanceTimersByTimeAsync(4500); await run;
    expect(helpers.draftEncrypt).not.toHaveBeenCalled();
    expect(draftState?.draft_encrypted_state).toBe("last-good-draft");
    expect(console.warn).toHaveBeenCalledWith(JSON.stringify({ event: "compass_login_stopped", stage: "WAITING_ACTION", category: "PLATFORM_ERROR", hostname: "err.vip.com" }));
    const failed = database.db.$executeRawUnsafe.mock.calls.find(([sql]) => String(sql).includes("status='FAILED'"));
    expect(failed?.[3]).toContain("平台入口返回错误页");
  });
});

describe("daily schedule and database timezone", () => {
  it("waits until Shanghai 08:00 and enqueues only once per local day", async () => {
    hasQueued = false; jobStatus = "COMPLETE"; hour = 7;
    await scheduleCompassUpdate();
    expect(database.db.$executeRawUnsafe).not.toHaveBeenCalled();
    hour = 8;
    await scheduleCompassUpdate();
    jobStatus = "COMPLETE";
    await scheduleCompassUpdate();
    const inserts = database.db.$executeRawUnsafe.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO compass_update_jobs"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].slice(1, 4)).toEqual(["17", "2026-09-11", "2026-10-10"]);
    const [, clockQuery] = database.one.mock.calls.find(([, sql]) => String(sql).startsWith("SELECT *"))!;
    expect(clockQuery).toContain("AT TIME ZONE 'Asia/Shanghai'");
    expect(lastScheduled?.toISOString().slice(0, 10)).toBe("2026-10-11");
  });

  it("does not overlap pending work and disables scheduling after permission revocation", async () => {
    jobStatus = "RUNNING";
    await scheduleCompassUpdate();
    expect(database.db.$executeRawUnsafe).not.toHaveBeenCalled();
    jobStatus = "COMPLETE"; authorized = false;
    await scheduleCompassUpdate();
    expect(scheduledEnabled).toBe(false);
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).startsWith("INSERT INTO compass_update_jobs"))).toBe(false);
  });

  it("waits for an active login window before scheduling instead of expiring its queued job", async () => {
    jobStatus = "COMPLETE"; loginQueued = true;
    await scheduleCompassUpdate();
    expect(database.db.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(lastScheduled).toBeNull();
    loginQueued = false;
    await scheduleCompassUpdate();
    expect(database.db.$executeRawUnsafe.mock.calls.some(([sql]) => String(sql).startsWith("INSERT INTO compass_update_jobs"))).toBe(true);
  });
});

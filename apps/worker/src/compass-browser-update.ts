import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { db, one, rows, type Tx } from "../../../packages/database/src/index.js";
import { compassDimensions, compassLabels, compassNormalizationVersion, shanghaiDate, shiftCompassDate, type CompassDimension } from "../../../packages/contracts/src/compass-analytics.js";
import { compassBrowserActionSchema, compassBrowserViewport, isCompassBrowserOrigin } from "../../../packages/contracts/src/compass-update.js";
import { expireCompassTasks, finishCompassUpdate, verifyCompassUpdateSources } from "../../api/src/modules/analytics/browser-update.js";
import { beginImport, appendImport, finishImport } from "../../api/src/modules/analytics/service.js";
import type { Context } from "../../api/src/core.js";
import { compassEncryptionReady, decryptCompassState, encryptCompassState, encryptCompassLoginDraft, decryptCompassLoginDraft } from "./compass-browser-state.js";
import { readCompassDownload, StaleCompassReportError } from "./compass-report-import.js";
import { checkCompassLogin, openCompassReports, downloadCompassReports, cleanupCompassDownloads, CompassBrowserError, compassSourceUrl } from "./compass-report-browser.js";

const activeLogin = "('QUEUED','RUNNING','WAITING','CHECKING')";
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const launch = () => chromium.launch({ headless: true });
const rejectedCompassHosts = new WeakMap<BrowserContext, string>();
type CompassLoginStage = "OPEN_LOGIN" | "WAITING_ACTION" | "APPLY_ACTION" | "VERIFY_LOGIN" | "VERIFY_REUSE" | "SAVE_SESSION" | "CAPTURE_FRAME";

export function compassLoginDiagnostic(error: unknown, stage: CompassLoginStage, pageUrl: string, rejectedHost?: string) {
  const value = error instanceof Error ? error : null;
  const message = value?.message ?? "";
  let hostname = "unknown";
  try { hostname = new URL(pageUrl).hostname; } catch { /* Diagnostic metadata only. */ }
  const host = rejectedHost ?? hostname;
  const category = host === "err.vip.com" ? "PLATFORM_ERROR" : rejectedHost ? "ORIGIN_REJECTED" :
    value?.name === "TimeoutError" || /timed?\s*out|timeout/i.test(message) ? "TIMEOUT" :
    /(?:page|context|browser).{0,25}(?:closed|closing)|Target closed/i.test(message) ? "PAGE_CLOSED" :
    /frame.{0,30}detach|execution context.{0,30}destroy|cannot find context|navigation.{0,25}(?:progress|interrupt|supersed)|net::ERR_ABORTED|page.{0,25}navigating/i.test(message) ? "NAVIGATION_CHANGED" : "READ_FAILED";
  return { stage, category, hostname: /^[a-z0-9.-]{1,253}$/i.test(host) ? host : "unknown" };
}
function compassNavigationRace(error: unknown) {
  return error instanceof Error && /frame.{0,30}detach|execution context.{0,30}destroy|cannot find context|(?:page|context|browser).{0,25}(?:closed|closing)|Target closed|navigation.{0,25}(?:progress|interrupt|supersed)|net::ERR_ABORTED|page.{0,25}navigating/i.test(error.message);
}
function latestCompassPage(context: BrowserContext, preferred: Page) {
  return context.pages().filter(candidate => !candidate.isClosed() && isCompassBrowserOrigin(candidate.url())).at(-1) ??
    (!preferred.isClosed() && isCompassBrowserOrigin(preferred.url()) ? preferred : null);
}
export function scopedCompassLoginDraft(saved: Record<string, any> | undefined, actorId: unknown, loginId: unknown, now = Date.now()) {
  const expiry = Number(saved?.draft_expires_ms ?? (saved?.draft_expires_at ? new Date(saved.draft_expires_at).getTime() : NaN));
  return saved?.draft_encrypted_state && String(saved.draft_actor_id) === String(actorId) && String(saved.draft_login_id) === String(loginId) && Number.isFinite(expiry) && expiry > now
    ? { encrypted: String(saved.draft_encrypted_state), expiresAtMs: expiry } : null;
}
export async function checkpointCompassLoginDraft(context: BrowserContext, job: { id: unknown; actor_id: unknown }, token: string, expiresAtMs?: number) {
  const encrypted = encryptCompassLoginDraft(await context.storageState({ indexedDB: true }), String(job.actor_id));
  return db.$transaction(async tx => {
    await rows(tx, "SELECT pg_advisory_xact_lock(2026101140)::text");
    const active = await one(tx, `SELECT id,actor_id FROM compass_logins WHERE id=$1::uuid AND actor_id=$3::bigint AND claim_token=$2::uuid AND status IN ${activeLogin} AND expires_at>now() FOR UPDATE`, job.id, token, job.actor_id);
    if (!active) return { active: false, expiresAtMs: expiresAtMs ?? null };
    await compassWorkerActor(job.actor_id, tx);
    const saved = await one(tx, "SELECT draft_encrypted_state,draft_actor_id,draft_login_id,draft_expires_at,(extract(epoch FROM draft_expires_at)*1000)::bigint AS draft_expires_ms FROM compass_session WHERE id=1 FOR UPDATE");
    const scoped = scopedCompassLoginDraft(saved, job.actor_id, job.id);
    const retainedExpiry = String(saved?.draft_actor_id) === String(job.actor_id) && String(saved?.draft_login_id) === String(job.id)
      ? Number(saved?.draft_expires_ms ?? (saved?.draft_expires_at ? new Date(saved.draft_expires_at).getTime() : NaN)) : undefined;
    const deadline = Math.min(Date.now() + 30 * 60000, expiresAtMs ?? Infinity, scoped?.expiresAtMs ?? retainedExpiry ?? Infinity);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) return { active: true, expiresAtMs: expiresAtMs ?? retainedExpiry ?? null };
    await tx.$executeRawUnsafe("UPDATE compass_session SET draft_encrypted_state=$1,draft_actor_id=$2::bigint,draft_login_id=$3::uuid,draft_expires_at=$4::timestamptz WHERE id=1", encrypted, job.actor_id, job.id, new Date(deadline).toISOString());
    return { active: true, expiresAtMs: deadline };
  });
}

export async function compassWorkerActor(actorId: unknown, tx: Tx = db) {
  const actor = await one(tx, `SELECT u.id,u.username,u.display_name FROM users u WHERE u.id=$1::bigint AND u.status='ACTIVE' AND (
    EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.code='SUPER_ADMIN') OR
    EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.id=rp.permission_id WHERE ur.user_id=u.id AND p.code='analytics.manage'))`, String(actorId));
  if (!actor) throw Error("任务发起者已停用或不再拥有经营分析导入权限");
  return { id: String(actor.id), username: actor.username, displayName: actor.display_name, permissions: ["analytics.manage"] };
}

export async function configureCompassPage(page: Page) {
  await page.context().route("**/*", async route => {
    const request = route.request();
    if (request.isNavigationRequest() && !isCompassBrowserOrigin(request.url())) {
      try { rejectedCompassHosts.set(page.context(), new URL(request.url()).hostname); } catch { /* Never log the raw URL. */ }
      await route.abort();
    }
    else await route.fallback();
  });
  // SSO/report menus may normally open a new official tab. Keep it inside
  // the same authenticated context; reject unrelated top-level destinations.
  page.context().on("page", popup => {
    popup.on("framenavigated", frame => {
      if (frame === popup.mainFrame() && frame.url() !== "about:blank" && !isCompassBrowserOrigin(frame.url())) {
        try { rejectedCompassHosts.set(page.context(), new URL(frame.url()).hostname); } catch { /* Never log the raw URL. */ }
        void popup.close();
      }
    });
  });
}

export async function compassWorkerHeartbeat() {
  await db.$executeRawUnsafe("UPDATE compass_session SET encryption_ready=$1,worker_heartbeat_at=now() WHERE id=1", compassEncryptionReady());
  await expireCompassTasks();
  await db.$executeRawUnsafe("DELETE FROM compass_login_actions WHERE completed_at<now()-interval '10 minutes'");
  await db.$executeRawUnsafe(`DELETE FROM compass_logins WHERE status NOT IN ${activeLogin} AND requested_at<now()-interval '1 day'`);
}

export async function processCompassLogin(browserLaunch: () => Promise<Browser> = launch, signal?: AbortSignal) {
  if (!compassEncryptionReady() || signal?.aborted) return;
  const token = randomUUID();
  const job = await db.$transaction(async tx => {
    await rows(tx, "SELECT pg_advisory_xact_lock(2026101140)::text");
    if (await one(tx, "SELECT 1 FROM compass_update_jobs WHERE status='RUNNING'")) return null;
    if (await one(tx, "SELECT 1 FROM compass_logins WHERE status IN ('RUNNING','WAITING','CHECKING')")) return null;
    const next = await one(tx, "SELECT id FROM compass_logins WHERE status='QUEUED' AND expires_at>now() ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED");
    if (!next) return null;
    return one(tx, "UPDATE compass_logins SET status='RUNNING',claim_token=$2::uuid,heartbeat_at=now(),note='正在打开魔方罗盘登录页面' WHERE id=$1::uuid RETURNING *, (extract(epoch FROM expires_at)*1000)::bigint AS expires_ms", next.id, token);
  });
  if (!job) return;
  let browser: Browser | undefined;
  let loginContext: BrowserContext | undefined, diagnosticPage: Page | undefined;
  let draftExpiry: number | undefined;
  let stage: CompassLoginStage = "OPEN_LOGIN";
  const close = () => void browser?.close().catch(() => {});
  const timer = setTimeout(close, Math.max(1, Number(job.expires_ms) - Date.now()));
  timer.unref(); signal?.addEventListener("abort", close, { once: true });
  const beat = setInterval(() => void db.$executeRawUnsafe(`UPDATE compass_logins SET heartbeat_at=now() WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${activeLogin}`, job.id, token).catch(() => {}), 10000);
  beat.unref();
  const update = (note: string, status = "WAITING") => db.$executeRawUnsafe(`UPDATE compass_logins SET note=$3,status=$4 WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${activeLogin} AND expires_at>now()`, job.id, token, note, status);
  try {
    await compassWorkerActor(job.actor_id);
    const saved = await one(db, "SELECT encrypted_state,state_version,status,enabled,draft_encrypted_state,draft_actor_id,draft_login_id,draft_expires_at,(extract(epoch FROM draft_expires_at)*1000)::bigint AS draft_expires_ms FROM compass_session WHERE id=1");
    const draft = scopedCompassLoginDraft(saved, job.actor_id, job.id);
    draftExpiry = draft?.expiresAtMs;
    let state;
    try {
      if (draft) state = decryptCompassLoginDraft(draft.encrypted, String(job.actor_id));
      else if (saved?.enabled && saved.encrypted_state) state = decryptCompassState(saved.encrypted_state);
    } catch { /* A new sign-in repairs unreadable saved state. */ }
    browser = await browserLaunch();
    const context = await browser.newContext({ locale: "zh-CN", timezoneId: "Asia/Shanghai", viewport: compassBrowserViewport, acceptDownloads: false, ...(state ? { storageState: state } : {}) });
    loginContext = context;
    let page = await context.newPage();
    diagnosticPage = page;
    await configureCompassPage(page);
    try { await page.goto(compassSourceUrl, { waitUntil: "domcontentloaded", timeout: 30000 }); }
    catch (error) {
      if (!compassNavigationRace(error)) throw error;
      // An SSO redirect may supersede the entry navigation. Reuse its actual
      // official tab instead of replaying the entry URL over the transition.
      let resumed: Page | null = null;
      for (let attempt = 0; attempt < 8 && !resumed && !signal?.aborted; attempt++) {
        await pause(500);
        resumed = latestCompassPage(context, page);
      }
      if (!resumed) throw error;
      page = resumed; diagnosticPage = page;
    }
    await update("请在云端画面扫码登录，通过可见的「魔方罗盘」进入自助报表，再点击「核验并保存」");
    let frameId = randomUUID(), lastUrl = page.url(), lastFrame = 0, lastCheckpoint = 0, navigationRetries = 0;
    const checkpoint = async () => {
      const result = await checkpointCompassLoginDraft(context, { id: job.id, actor_id: job.actor_id }, token, draftExpiry);
      if (result.expiresAtMs !== null) draftExpiry = result.expiresAtMs;
      lastCheckpoint = Date.now();
      return result.active;
    };
    const recover = async (error: unknown) => {
      if (!compassNavigationRace(error) || ++navigationRetries > 8) throw error;
      await db.$executeRawUnsafe(`UPDATE compass_logins SET frame_jpeg=NULL,frame_id=NULL WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${activeLogin}`, job.id, token);
      frameId = randomUUID(); lastFrame = 0;
      await update("罗盘页面正在跳转，保留当前登录并等待画面恢复");
      await pause(500);
    };
    while (!signal?.aborted && Date.now() < Number(job.expires_ms)) {
      const current = await one(db, `SELECT status,frame_id FROM compass_logins WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${activeLogin}`, job.id, token);
      if (!current) break;
      stage = "WAITING_ACTION";
      // A normal SSO link can open its application in a new tab.
      const newest = latestCompassPage(context, page);
      if (newest && newest !== page) {
        page = newest; diagnosticPage = page; frameId = randomUUID(); lastFrame = 0;
        current.frame_id = null;
        await db.$executeRawUnsafe(`UPDATE compass_logins SET frame_jpeg=NULL,frame_id=NULL WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${activeLogin}`, job.id, token);
      }
      if (!newest) {
        if (++navigationRetries > 8) throw Error("Browser page closed during navigation");
        await pause(500);
        continue;
      }
      if (!isCompassBrowserOrigin(page.url())) throw Error("罗盘登录页面离开官方域名");
      if (Date.now() - lastCheckpoint >= 5000) {
        try { if (!(await checkpoint())) break; }
        catch (error) { await recover(error); continue; }
      }
      const action = await one(db, "SELECT id,payload FROM compass_login_actions WHERE login_id=$1::uuid AND completed_at IS NULL ORDER BY id LIMIT 1", job.id);
      if (action) {
        stage = "APPLY_ACTION";
        try { if (!(await checkpoint())) break; }
        catch (error) { await recover(error); continue; }
        await db.$executeRawUnsafe("UPDATE compass_login_actions SET completed_at=now() WHERE id=$1::bigint", action.id);
        await db.$executeRawUnsafe(`UPDATE compass_logins SET frame_jpeg=NULL,frame_id=NULL WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${activeLogin}`, job.id, token);
        const input = compassBrowserActionSchema.parse(action.payload);
        try {
        if ((input.kind === "CLICK" || input.kind === "SCROLL") && input.frameId !== current.frame_id) await update("云端画面已变化，请等待刷新后重新操作");
        else if (input.kind === "CHECK") {
          stage = "VERIFY_LOGIN";
          await update("正在核验罗盘报表访问及会话复用", "CHECKING");
          const result = await checkCompassLogin(page, { load: false });
          if (!result.verified) { await update(result.note); continue; }
          // Verify the exact normalized snapshot that will be persisted. A raw
          // context can include storage discarded by the Compass domain filter.
          const encrypted = encryptCompassState(await context.storageState({ indexedDB: true }));
          stage = "VERIFY_REUSE";
          const probe = await browser.newContext({ locale: "zh-CN", timezoneId: "Asia/Shanghai", viewport: compassBrowserViewport, acceptDownloads: false, storageState: decryptCompassState(encrypted) });
          let verified = false;
          try {
            const probePage = await probe.newPage();
            await configureCompassPage(probePage);
            const reusable = await checkCompassLogin(probePage);
            verified = reusable.verified;
            let hostname = "unknown";
            try { hostname = new URL(probePage.url()).hostname; } catch { /* Safe metadata only. */ }
            const officialHosts = [...new Set(probe.pages().filter(candidate => !candidate.isClosed() && isCompassBrowserOrigin(candidate.url())).map(candidate => new URL(candidate.url()).hostname))].slice(0, 5);
            console.warn(JSON.stringify({ event: "compass_reuse_check", reason: reusable.reason, hostname: /^[a-z0-9.-]{1,253}$/i.test(hostname) ? hostname : "unknown", officialHosts }));
          } finally { await probe.close(); }
          if (!verified) { await update("登录尚不能在后台浏览器中复用，请确认已进入自助报表后再次核验"); continue; }
          stage = "SAVE_SESSION";
          await compassWorkerActor(job.actor_id);
          const stored = await db.$transaction(async tx => {
            await rows(tx, "SELECT pg_advisory_xact_lock(2026101140)::text");
            if (!(await one(tx, `SELECT id FROM compass_logins WHERE id=$1::uuid AND actor_id=$3::bigint AND claim_token=$2::uuid AND status IN ${activeLogin} AND expires_at>now() FOR UPDATE`, job.id, token, job.actor_id))) return false;
            await compassWorkerActor(job.actor_id, tx);
            await tx.$executeRawUnsafe("UPDATE compass_session SET enabled=true,status='READY',encrypted_state=$1,state_version=state_version+1,saved_at=now(),checked_at=now(),updated_by=$2::bigint,note='',draft_encrypted_state=NULL,draft_actor_id=NULL,draft_login_id=NULL,draft_expires_at=NULL WHERE id=1", encrypted, job.actor_id);
            await tx.$executeRawUnsafe("UPDATE compass_logins SET status='SAVED',frame_jpeg=NULL,frame_id=NULL,completed_at=now(),note='罗盘登录已核验并加密保存' WHERE id=$1::uuid", job.id);
            await tx.$executeRawUnsafe("DELETE FROM compass_login_actions WHERE login_id=$1::uuid", job.id);
            return true;
          });
          if (stored) return;
          break;
        } else if (input.kind === "REFRESH") { await page.goto(compassSourceUrl, { waitUntil: "domcontentloaded", timeout: 30000 }); await update("已重新打开官方供应商入口，可继续登录后核验"); }
        else if (input.kind === "CLICK") await page.mouse.click(input.point.x * compassBrowserViewport.width, input.point.y * compassBrowserViewport.height);
        else if (input.kind === "SCROLL") await page.mouse.wheel(0, input.deltaY);
        } catch (error) { await recover(error); continue; }
        frameId = randomUUID(); lastFrame = 0;
      }
      if (page.url() !== lastUrl) { lastUrl = page.url(); frameId = randomUUID(); }
      if (Date.now() - lastFrame >= 2500) {
        stage = "CAPTURE_FRAME";
        // SSO often places its login form inside an iframe. Mask editable
        // content in every frame so password-manager values never leave it.
        let frame: Buffer;
        try {
          frame = await page.screenshot({ type: "jpeg", quality: 65, mask: page.frames().map(child =>
            child.locator('input:not([type="checkbox"]):not([type="radio"]),textarea,[contenteditable="true"]')) });
        } catch (error) {
          // Never publish a partially masked frame. Rebuild the full mask after
          // SSO/iframe navigation settles, retaining the logged-in context.
          await recover(error);
          continue;
        }
        navigationRetries = 0;
        await db.$executeRawUnsafe(`UPDATE compass_logins SET frame_jpeg=$3,frame_id=$4::uuid,heartbeat_at=now() WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${activeLogin} AND expires_at>now()`, job.id, token, frame.toString("base64"), frameId);
        lastFrame = Date.now();
      }
      await pause(500);
    }
    await db.$executeRawUnsafe(`UPDATE compass_logins SET status='EXPIRED',frame_jpeg=NULL,frame_id=NULL,completed_at=now(),note='登录窗口已过期，请重新打开' WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${activeLogin}`, job.id, token);
  } catch (error) {
    // Capture a final SSO transition when possible. The transaction still
    // requires the active claim and actor, so cancellation/disconnect cannot
    // resurrect it even if this bounded attempt finishes after the failure.
    if (loginContext && !signal?.aborted && loginContext.pages().some(candidate => !candidate.isClosed() && isCompassBrowserOrigin(candidate.url()))) {
      let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          checkpointCompassLoginDraft(loginContext, { id: job.id, actor_id: job.actor_id }, token, draftExpiry),
          new Promise<void>(resolve => { checkpointTimer = setTimeout(resolve, 1500); }),
        ]);
      } catch { /* Preserve the original safe diagnostic and existing draft. */ }
      finally { if (checkpointTimer) clearTimeout(checkpointTimer); }
    }
    const diagnostic = compassLoginDiagnostic(error, stage, diagnosticPage?.url() ?? "", loginContext ? rejectedCompassHosts.get(loginContext) : undefined);
    const reason = diagnostic.category === "PLATFORM_ERROR" ? "罗盘平台入口返回错误页" :
      diagnostic.category === "ORIGIN_REJECTED" ? `罗盘跳转到尚未支持的站点 ${diagnostic.hostname}` :
      diagnostic.category === "TIMEOUT" ? "罗盘页面加载或读取超时" :
      diagnostic.category === "PAGE_CLOSED" || diagnostic.category === "NAVIGATION_CHANGED" ? "罗盘页面跳转中断" : "罗盘页面读取失败";
    const note = `${reason}，可重新打开登录继续本人未过期的进度；尚未核验成功，原有数据保留`;
    console.warn(JSON.stringify({ event: "compass_login_stopped", ...diagnostic }));
    await db.$executeRawUnsafe(`UPDATE compass_logins SET status='FAILED',frame_jpeg=NULL,frame_id=NULL,completed_at=now(),note=$3 WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${activeLogin}`, job.id, token, note);
  } finally { clearTimeout(timer); clearInterval(beat); signal?.removeEventListener("abort", close); await browser?.close().catch(() => {}); }
}

export async function processCompassUpdate(browserLaunch: () => Promise<Browser> = launch, signal?: AbortSignal) {
  if (!compassEncryptionReady() || signal?.aborted) return;
  const token = randomUUID();
  const job = await db.$transaction(async tx => {
    await rows(tx, "SELECT pg_advisory_xact_lock(2026101140)::text");
    if (await one(tx, `SELECT 1 FROM compass_logins WHERE status IN ${activeLogin}`)) return null;
    if (await one(tx, "SELECT 1 FROM compass_update_jobs WHERE status='RUNNING'")) return null;
    const next = await one(tx, "SELECT id FROM compass_update_jobs WHERE status='QUEUED' AND deadline_at>now() ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED");
    if (!next) return null;
    return one(tx, "UPDATE compass_update_jobs SET status='RUNNING',claim_token=$2::uuid,started_at=coalesce(started_at,now()),heartbeat_at=now(),note='正在核对当前来源与罗盘登录' WHERE id=$1::bigint RETURNING *, (extract(epoch FROM deadline_at)*1000)::bigint AS deadline_ms", next.id, token);
  });
  if (!job) return;
  let browser: Browser | undefined;
  const files: Awaited<ReturnType<typeof downloadCompassReports>> = [];
  let sessionVersion: number | undefined;
  const close = () => void browser?.close().catch(() => {});
  const timer = setTimeout(close, Math.max(1, Number(job.deadline_ms) - Date.now()));
  timer.unref(); signal?.addEventListener("abort", close, { once: true });
  const heartbeat = setInterval(() => void db.$executeRawUnsafe("UPDATE compass_update_jobs SET heartbeat_at=now() WHERE id=$1::bigint AND claim_token=$2::uuid AND status='RUNNING'", job.id, token).catch(() => {}), 10000);
  heartbeat.unref();
  const guard = async () => {
    if (signal?.aborted || Date.now() >= Number(job.deadline_ms)) throw Error("任务已停止或超时");
    const owned = await one(db, "SELECT 1 FROM compass_update_jobs WHERE id=$1::bigint AND claim_token=$2::uuid AND status='RUNNING' AND deadline_at>now()", job.id, token);
    if (!owned) throw Error("任务已停止或由其他进程处理");
    return compassWorkerActor(job.requested_by);
  };
  const progress = async (note: string) => { await guard(); await db.$executeRawUnsafe("UPDATE compass_update_jobs SET note=$3,heartbeat_at=now() WHERE id=$1::bigint AND claim_token=$2::uuid AND status='RUNNING'", job.id, token, note); };
  const start = job.target_start_date.toISOString().slice(0, 10), end = job.target_end_date.toISOString().slice(0, 10);
  try {
    await guard();
    const existing = await verifyCompassUpdateSources(start, end);
    if (existing.complete) { await finishCompassUpdate(String(job.id), token); return; }
    const saved = await one(db, "SELECT enabled,status,encrypted_state,state_version FROM compass_session WHERE id=1");
    sessionVersion = saved?.state_version;
    if (!saved?.enabled || saved.status !== "READY" || !saved.encrypted_state) throw new CompassBrowserError("LOGIN_REQUIRED", "请先扫码建立服务器罗盘登录会话");
    let storageState;
    try { storageState = decryptCompassState(saved.encrypted_state); }
    catch { throw new CompassBrowserError("LOGIN_REQUIRED", "已保存的罗盘会话无法读取，请重新扫码"); }
    browser = await browserLaunch();
    const context = await browser.newContext({ locale: "zh-CN", timezoneId: "Asia/Shanghai", viewport: compassBrowserViewport, acceptDownloads: true, storageState });
    const entry = await context.newPage(); await configureCompassPage(entry);
    const page = await openCompassReports(entry, signal);
    const missing = compassDimensions.filter(dimension => !existing.completedDimensions.includes(dimension));
    for (const dimension of missing) {
      let downloaded = await downloadCompassReports(page, [dimension], start, end, progress, signal);
      files.push(...downloaded);
      let file = downloaded[0];
      if (downloaded.length !== 1 || file?.dimension !== dimension) throw Error("未取得任务对应的单维度原始报表");
      await progress(`正在校验${compassLabels[dimension]}原始报表`);
      let parsed: Awaited<ReturnType<typeof readCompassDownload>>;
      try { parsed = await readCompassDownload(file, start, end); }
      catch (error) {
        if (!(error instanceof StaleCompassReportError)) throw error;
        await progress(`${compassLabels[dimension]}原文件为 ${error.actualStartDate} 至 ${error.actualEndDate}，正在重新生成本次区间报表（仅重试一次）`);
        await cleanupCompassDownloads(downloaded);
        downloaded = await downloadCompassReports(page, [dimension], start, end, progress, signal, { forceGenerate: true });
        files.push(...downloaded);
        file = downloaded[0];
        if (downloaded.length !== 1 || file?.dimension !== dimension) throw Error("重新生成后未取得任务对应的原始报表");
        // A second stale report, or any malformed content, stops this dimension.
        parsed = await readCompassDownload(file, start, end);
      }
      const { report, fileHash } = parsed;
      const contextFor = async (key: string): Promise<Context> => ({ actor: await guard(), requestId: `compass-update-${job.id}`, key });
      const task = await beginImport(await contextFor(`cu-${job.id}-${file.dimension}-${fileHash}`), { dimension: report.dimension, fileName: file.fileName, fileHash, startDate: report.startDate, endDate: report.endDate, expectedRows: report.records.length, normalizationVersion: compassNormalizationVersion });
      if (task.status !== "COMPLETE") {
        for (let offset = 0; offset < report.records.length; offset += 1000) {
          await progress(`正在导入${compassLabels[file.dimension]}：${Math.min(offset + 1000, report.records.length)} / ${report.records.length} 行`);
          await appendImport(await contextFor(`cu-${job.id}-${file.dimension}-${fileHash}-${offset}`), String(task.id), { records: report.records.slice(offset, offset + 1000) });
        }
        await finishImport(await contextFor(`cu-${job.id}-${file.dimension}-${fileHash}-finish`), String(task.id));
      }
      const sources = await verifyCompassUpdateSources(start, end);
      await db.$executeRawUnsafe("UPDATE compass_update_jobs SET completed_dimensions=$3::jsonb,source_ids=$4::jsonb,heartbeat_at=now() WHERE id=$1::bigint AND claim_token=$2::uuid AND status='RUNNING'", job.id, token, JSON.stringify(sources.completedDimensions), JSON.stringify(sources.sourceIds));
      await cleanupCompassDownloads(downloaded);
    }
    await guard();
    await db.$executeRawUnsafe("UPDATE compass_session SET encrypted_state=$1,checked_at=now(),note='' WHERE id=1 AND enabled AND status='READY' AND state_version=$2", encryptCompassState(await context.storageState({ indexedDB: true })), saved.state_version);
    await finishCompassUpdate(String(job.id), token);
  } catch (error) {
    const code = error instanceof CompassBrowserError ? error.code : "FAILED";
    const needsLogin = code === "LOGIN_REQUIRED" || code === "HUMAN_VERIFICATION";
    const state = code === "HUMAN_VERIFICATION" ? "VERIFICATION_REQUIRED" : needsLogin ? "LOGIN_REQUIRED" : "FAILED";
    const sources = await verifyCompassUpdateSources(start, end).catch(() => ({ completedDimensions: [] as CompassDimension[], sourceIds: {} }));
    const note = error instanceof CompassBrowserError ? error.message : error instanceof Error && /报表|日期|维度|权限|停止|超时|行|列|原始|100MB/.test(error.message) ? error.message.slice(0, 300) : "后台更新未完成，请重试；已完整导入的维度保留，未完成维度不替换";
    await db.$transaction(async tx => {
      const current = await one(tx, "SELECT 1 FROM compass_update_jobs WHERE id=$1::bigint AND claim_token=$2::uuid AND status='RUNNING' FOR UPDATE", job.id, token);
      if (!current) return;
      await tx.$executeRawUnsafe("UPDATE compass_update_jobs SET status=$3,note=$4,completed_dimensions=$5::jsonb,source_ids=$6::jsonb,completed_at=CASE WHEN $3 IN ('LOGIN_REQUIRED','VERIFICATION_REQUIRED') THEN NULL ELSE now() END,heartbeat_at=now() WHERE id=$1::bigint AND claim_token=$2::uuid AND status='RUNNING'", job.id, token, needsLogin ? state : sources.completedDimensions.length ? "PARTIAL" : "FAILED", note, JSON.stringify(sources.completedDimensions), JSON.stringify(sources.sourceIds));
      if (needsLogin && sessionVersion !== undefined)
        await tx.$executeRawUnsafe("UPDATE compass_session SET status=$1,note=$2,checked_at=now() WHERE id=1 AND enabled AND state_version=$3", state, note, sessionVersion);
    });
  } finally { clearTimeout(timer); clearInterval(heartbeat); signal?.removeEventListener("abort", close); await browser?.close().catch(() => {}); await cleanupCompassDownloads(files); }
}

export async function scheduleCompassUpdate() {
  if (!compassEncryptionReady()) return;
  await db.$transaction(async tx => {
    await rows(tx, "SELECT pg_advisory_xact_lock(2026101140)::text");
    const session = await one(tx, `SELECT *, (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS today,
      extract(hour FROM now() AT TIME ZONE 'Asia/Shanghai')::int AS hour FROM compass_session WHERE id=1 FOR UPDATE`);
    if (!session?.auto_update_enabled || !session.auto_update_by || session.hour < session.daily_hour || session.last_scheduled_day?.toISOString().slice(0, 10) === session.today) return;
    if (await one(tx, "SELECT 1 FROM compass_update_jobs WHERE status IN ('QUEUED','RUNNING','LOGIN_REQUIRED','VERIFICATION_REQUIRED')")) return;
    if (await one(tx, `SELECT 1 FROM compass_logins WHERE status IN ${activeLogin}`)) return;
    const today = session.today || shanghaiDate(), end = shiftCompassDate(today, -1), start = shiftCompassDate(end, -29);
    const authorized = await one(tx, `SELECT u.id FROM users u WHERE u.id=$1::bigint AND u.status='ACTIVE' AND (
      EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.code='SUPER_ADMIN') OR
      EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.id=rp.permission_id WHERE ur.user_id=u.id AND p.code='analytics.manage'))`, session.auto_update_by);
    if (!authorized) {
      await tx.$executeRawUnsafe("UPDATE compass_session SET auto_update_enabled=false,note='自动更新已关闭：设置者已停用或不再拥有导入权限' WHERE id=1");
      return;
    }
    const status = session.enabled && session.status === "READY" && session.encrypted_state ? "QUEUED" : session.status === "VERIFICATION_REQUIRED" ? "VERIFICATION_REQUIRED" : "LOGIN_REQUIRED";
    await tx.$executeRawUnsafe("INSERT INTO compass_update_jobs(requested_by,target_start_date,target_end_date,trigger,status,note) VALUES($1::bigint,$2::date,$3::date,'SCHEDULED',$4,$5)", session.auto_update_by, start, end, status, status === "QUEUED" ? "每日08:00后台更新已启动" : "每日更新需要重新扫码核验罗盘登录，现有数据保留");
    await tx.$executeRawUnsafe("UPDATE compass_session SET last_scheduled_day=$1::date WHERE id=1", today);
  });
}

export function startCompassBrowserUpdate() {
  let stopped = false, busy = false, current: Promise<void> | undefined;
  const controller = new AbortController();
  const beat = () => void compassWorkerHeartbeat().catch(() => console.warn("Compass worker heartbeat unavailable"));
  const tick = () => {
    if (busy || stopped) return;
    busy = true;
    current = (async () => { await scheduleCompassUpdate(); await processCompassLogin(undefined, controller.signal); if (!stopped) await processCompassUpdate(undefined, controller.signal); })()
      .catch(() => console.warn("Compass browser task unavailable")).finally(() => { busy = false; });
  };
  beat(); tick();
  const heartbeat = setInterval(beat, 15000), timer = setInterval(tick, 2000);
  heartbeat.unref(); timer.unref();
  return async () => { stopped = true; controller.abort(); clearInterval(heartbeat); clearInterval(timer); await current; };
}

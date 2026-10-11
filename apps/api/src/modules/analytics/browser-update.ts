import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, one, rows, type Row, type Tx } from "../../../../../packages/database/src/index.js";
import { audit, command, type Context, fail, id, parse, requirePermission } from "../../core.js";
import { compassDimensions, shanghaiDate, shiftCompassDate, type CompassDimension } from "../../../../../packages/contracts/src/compass-analytics.js";
import { compassAutoUpdateSchema, compassBrowserActionSchema, type CompassAutoUpdateSettings, type CompassBrowserLoginView, type CompassBrowserSession, type CompassUpdateJob, type CompassUpdateStatusView } from "../../../../../packages/contracts/src/compass-update.js";

const activeLogins = "('QUEUED','RUNNING','WAITING','CHECKING')";
const activeJobs = "('QUEUED','RUNNING','LOGIN_REQUIRED','VERIFICATION_REQUIRED')";
const jobColumns = "id::text,status,target_start_date::text,target_end_date::text,requested_at::text,started_at::text,completed_at::text,completed_dimensions,source_ids,note";
export const compassBrowserLock = 2026101140;

function jobView(row?: Row): CompassUpdateJob | null {
  return row ? {
    id: row.id, status: row.status, targetStartDate: row.target_start_date, targetEndDate: row.target_end_date,
    requestedAt: row.requested_at, startedAt: row.started_at, completedAt: row.completed_at,
    completedDimensions: row.completed_dimensions, sourceIds: row.source_ids, note: row.note,
  } : null;
}

export async function expireCompassTasks(tx: Tx = db) {
  await tx.$executeRawUnsafe(`UPDATE compass_logins SET status='EXPIRED',frame_jpeg=NULL,frame_id=NULL,
    completed_at=now(),note='后台登录窗口已过期或连接中断，请重新打开'
    WHERE status IN ${activeLogins} AND (expires_at<=now() OR
      (status='QUEUED' AND requested_at<now()-interval '2 minutes') OR
      (status<>'QUEUED' AND (heartbeat_at IS NULL OR heartbeat_at<now()-interval '1 minute')))`);
  await tx.$executeRawUnsafe(`UPDATE compass_update_jobs SET
    status=CASE WHEN jsonb_array_length(completed_dimensions)>0 THEN 'PARTIAL' ELSE 'FAILED' END,
    completed_at=now(),claim_token=NULL,note='更新任务超时或后台连接中断；保留已完成的报表，可重新更新'
    WHERE status IN ${activeJobs} AND (deadline_at<=now() OR
      (status='QUEUED' AND requested_at<now()-interval '2 minutes') OR
      (status='RUNNING' AND (heartbeat_at IS NULL OR heartbeat_at<now()-interval '5 minutes')))`);
  await tx.$executeRawUnsafe(`UPDATE compass_session SET draft_encrypted_state=NULL,draft_actor_id=NULL,
    draft_login_id=NULL,draft_expires_at=NULL WHERE id=1 AND draft_expires_at<=now()`);
  await tx.$executeRawUnsafe("DELETE FROM compass_login_actions WHERE completed_at<now()-interval '10 minutes'");
  await tx.$executeRawUnsafe(`DELETE FROM compass_logins WHERE status NOT IN ${activeLogins} AND requested_at<now()-interval '1 day'`);
}

export async function compassBrowserSession(tx: Tx = db): Promise<CompassBrowserSession> {
  const row = await one(tx, `SELECT enabled,status,saved_at::text,checked_at::text,encryption_ready,
    coalesce(worker_heartbeat_at>now()-interval '1 minute',false) AS worker_online,note FROM compass_session WHERE id=1`);
  if (!row) fail("COMPASS_NOT_CONFIGURED", "罗盘后台尚未初始化，请联系管理员", 503);
  return { enabled: row.enabled, status: row.status, savedAt: row.saved_at, checkedAt: row.checked_at,
    encryptionReady: row.encryption_ready, workerOnline: row.worker_online, note: row.note };
}

export async function compassUpdateStatus(): Promise<CompassUpdateStatusView> {
  await expireCompassTasks();
  return { session: await compassBrowserSession(), job: jobView(await one(db,
    `SELECT ${jobColumns} FROM compass_update_jobs ORDER BY id DESC LIMIT 1`)) };
}

export async function compassAutoUpdateSettings(c: Context, tx: Tx = db): Promise<CompassAutoUpdateSettings> {
  requirePermission(c.actor, "analytics.manage");
  const session = await compassBrowserSession(tx);
  const config = await one(tx, `SELECT auto_update_enabled,daily_hour,last_scheduled_day::text,
    EXISTS(SELECT 1 FROM compass_update_jobs WHERE trigger='MANUAL' AND status='COMPLETE'
      AND completed_dimensions @> '["style","article","barcode"]'::jsonb
      AND source_ids ?& ARRAY['style','article','barcode']) AS verified_before FROM compass_session WHERE id=1`);
  return { enabled: config!.auto_update_enabled, dailyHour: config!.daily_hour, lastScheduledDay: config!.last_scheduled_day,
    eligible: Boolean(config!.verified_before && session.enabled && session.status === "READY" && session.encryptionReady && session.workerOnline) };
}

export async function saveCompassAutoUpdate(c: Context, input: unknown): Promise<CompassAutoUpdateSettings> {
  requirePermission(c.actor, "analytics.manage");
  const b = parse(compassAutoUpdateSchema, input);
  return command(c, "compass.auto-update.settings", b, async tx => {
    await rows(tx, "SELECT pg_advisory_xact_lock($1)::text", compassBrowserLock);
    const config = await compassAutoUpdateSettings(c, tx);
    if (b.enabled && !config.eligible)
      fail("COMPASS_AUTO_UPDATE_NOT_READY", "请先保存后台罗盘登录并完成一次三维报表更新核验，再开启每日更新", 409);
    await tx.$executeRawUnsafe(`UPDATE compass_session SET auto_update_enabled=$1,auto_update_by=$2::bigint,daily_hour=8,
      last_scheduled_day=CASE WHEN $1 AND NOT auto_update_enabled
        AND extract(hour FROM now() AT TIME ZONE 'Asia/Shanghai')>=8
        THEN (now() AT TIME ZONE 'Asia/Shanghai')::date ELSE last_scheduled_day END WHERE id=1`, b.enabled, c.actor.id);
    await audit(tx, c, "COMPASS_AUTO_UPDATE_SETTINGS", "compass_session", "1", null, { enabled: b.enabled, dailyHour: 8 });
    return compassAutoUpdateSettings(c, tx);
  });
}

/** Only complete active sources with all thirty actual dates qualify. */
export async function verifyCompassUpdateSources(startDate: string, endDate: string, tx: Tx = db) {
  parse(z.iso.date(), startDate);
  parse(z.iso.date(), endDate);
  if (shiftCompassDate(startDate, 29) !== endDate)
    fail("INVALID_PERIOD", "自动更新须覆盖连续近30天", 400);
  const sources = await rows(tx, `SELECT a.dimension,i.id::text AS id
    FROM compass_active_imports a JOIN compass_imports i ON i.id=a.import_id
    JOIN compass_records r ON r.import_id=i.id AND r.business_date BETWEEN $1::date AND $2::date
    WHERE i.status='COMPLETE' AND i.start_date<=$1::date AND i.end_date>=$2::date
    GROUP BY a.dimension,i.id HAVING count(DISTINCT r.business_date)=30`, startDate, endDate);
  const sourceIds: Partial<Record<CompassDimension, string>> = {};
  for (const source of sources)
    if (compassDimensions.includes(source.dimension)) sourceIds[source.dimension as CompassDimension] = source.id;
  const completedDimensions = compassDimensions.filter(dimension => sourceIds[dimension]);
  return { complete: completedDimensions.length === 3, completedDimensions, sourceIds };
}

export async function requestCompassUpdate(c: Context, input: unknown): Promise<CompassUpdateStatusView> {
  requirePermission(c.actor, "analytics.manage");
  const b = parse(z.object({}).strict(), input);
  await expireCompassTasks();
  const endDate = shiftCompassDate(shanghaiDate(), -1), startDate = shiftCompassDate(endDate, -29);
  return command(c, "compass.update.request", b, async tx => {
    await rows(tx, "SELECT pg_advisory_xact_lock($1)::text", compassBrowserLock);
    const session = await compassBrowserSession(tx);
    const verified = await verifyCompassUpdateSources(startDate, endDate, tx);
    if (verified.complete) {
      const previous = await one(tx, `SELECT ${jobColumns} FROM compass_update_jobs
        WHERE target_start_date=$1::date AND target_end_date=$2::date AND status='COMPLETE' ORDER BY id DESC LIMIT 1`, startDate, endDate);
      const job = previous || await one(tx, `INSERT INTO compass_update_jobs(requested_by,target_start_date,target_end_date,status,
        completed_at,completed_dimensions,source_ids,note) VALUES($1::bigint,$2::date,$3::date,'COMPLETE',now(),$4::jsonb,$5::jsonb,
        '三个维度已覆盖截至昨日的连续近30天，无需重复下载') RETURNING ${jobColumns}`,
      c.actor.id, startDate, endDate, JSON.stringify(verified.completedDimensions), JSON.stringify(verified.sourceIds));
      return { session, job: jobView(job) };
    }
    if (!session.encryptionReady) fail("COMPASS_BROWSER_KEY_MISSING", "服务器尚未配置罗盘会话加密，请联系管理员", 503);
    if (!session.workerOnline) fail("COMPASS_WORKER_OFFLINE", "罗盘后台程序未在线，未提交更新，请稍后重试", 503);
    if (!session.enabled || session.status !== "READY")
      fail("COMPASS_LOGIN_REQUIRED", session.note || "请先完成后台罗盘登录并核验保存", 409);
    const active = await one(tx, `SELECT ${jobColumns} FROM compass_update_jobs WHERE status IN ${activeJobs} FOR UPDATE`);
    if (active && active.target_end_date !== endDate)
      fail("COMPASS_UPDATE_BUSY", "已有其他日期的更新正在处理，请等待完成后重试", 409);
    if ((!active || ["LOGIN_REQUIRED", "VERIFICATION_REQUIRED"].includes(active.status)) &&
      await one(tx, `SELECT 1 FROM compass_logins WHERE status IN ${activeLogins}`))
      fail("COMPASS_LOGIN_BUSY", "请先完成或关闭后台登录窗口，再更新数据", 409);
    let job = active;
    if (active && ["LOGIN_REQUIRED", "VERIFICATION_REQUIRED"].includes(active.status)) {
      job = await one(tx, `UPDATE compass_update_jobs SET status='QUEUED',requested_by=$2::bigint,claim_token=NULL,
        requested_at=now(),started_at=NULL,heartbeat_at=NULL,completed_at=NULL,deadline_at=now()+interval '1 hour',
        note='后台登录已恢复，等待继续下载与导入缺失维度' WHERE id=$1::bigint RETURNING ${jobColumns}`, active.id, c.actor.id);
    } else if (!active) {
      job = await one(tx, `INSERT INTO compass_update_jobs(requested_by,target_start_date,target_end_date,
        completed_dimensions,source_ids,note) VALUES($1::bigint,$2::date,$3::date,$4::jsonb,$5::jsonb,
        '等待后台核验罗盘登录并下载报表') RETURNING ${jobColumns}`,
      c.actor.id, startDate, endDate, JSON.stringify(verified.completedDimensions), JSON.stringify(verified.sourceIds));
    }
    await audit(tx, c, "COMPASS_UPDATE_REQUEST", "compass_update", job?.id, null, { startDate, endDate, status: job?.status });
    return { session, job: jobView(job) };
  });
}

/** Worker-only final gate. Browser/download success alone cannot complete a job. */
export async function finishCompassUpdate(jobId: string, claimToken: string): Promise<CompassUpdateJob | null> {
  parse(id, jobId);
  parse(z.uuid(), claimToken);
  return db.$transaction(async tx => {
    const job = await one(tx, `SELECT target_start_date::text,target_end_date::text FROM compass_update_jobs
      WHERE id=$1::bigint AND claim_token=$2::uuid AND status='RUNNING' AND deadline_at>now() FOR UPDATE`, jobId, claimToken);
    if (!job) return null;
    const verified = await verifyCompassUpdateSources(job.target_start_date, job.target_end_date, tx);
    const status = verified.complete ? "COMPLETE" : verified.completedDimensions.length ? "PARTIAL" : "FAILED";
    return jobView(await one(tx, `UPDATE compass_update_jobs SET status=$3,completed_dimensions=$4::jsonb,source_ids=$5::jsonb,
      completed_at=now(),heartbeat_at=now(),claim_token=NULL,note=$6 WHERE id=$1::bigint AND claim_token=$2::uuid RETURNING ${jobColumns}`,
    jobId, claimToken, status, JSON.stringify(verified.completedDimensions), JSON.stringify(verified.sourceIds), verified.complete ?
      "款号、货号和条码报表均已完整导入并核验截至昨日的连续近30天" : "来源核验未全部通过，保留已完成维度，可重新更新"));
  });
}

async function ownedLogin(c: Context, value: string, tx: Tx = db) {
  requirePermission(c.actor, "analytics.manage");
  const loginId = parse(z.uuid(), value);
  const row = await one(tx, "SELECT *,(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM compass_logins WHERE id=$1::uuid FOR UPDATE", loginId);
  if (!row) fail("NOT_FOUND", "后台登录窗口不存在", 404);
  if (String(row.actor_id) !== c.actor.id) fail("FORBIDDEN", "只能操作自己打开的后台登录窗口", 403);
  return row;
}

export async function openCompassLogin(c: Context) {
  requirePermission(c.actor, "analytics.manage");
  await expireCompassTasks();
  return command(c, "compass.browser.open", {}, async tx => {
    await rows(tx, "SELECT pg_advisory_xact_lock($1)::text", compassBrowserLock);
    const session = await compassBrowserSession(tx);
    if (!session.encryptionReady) fail("COMPASS_BROWSER_KEY_MISSING", "服务器尚未配置罗盘会话加密，请联系管理员", 503);
    if (!session.workerOnline) fail("COMPASS_WORKER_OFFLINE", "罗盘后台程序未在线，请稍后重试", 503);
    const current = await one(tx, `SELECT id::text,actor_id::text FROM compass_logins WHERE status IN ${activeLogins}`);
    if (current) {
      if (current.actor_id !== c.actor.id) fail("COMPASS_LOGIN_BUSY", "其他管理员正在登录罗盘，请稍后重试", 409);
      return { id: current.id };
    }
    const loginId = randomUUID();
    await tx.$executeRawUnsafe("INSERT INTO compass_logins(id,actor_id,note) VALUES($1::uuid,$2::bigint,'正在准备后台罗盘登录页面')", loginId, c.actor.id);
    // A draft is private progress, not a verified session. Moving its ownership
    // to a replacement window keeps the original absolute expiration intact.
    await tx.$executeRawUnsafe(`UPDATE compass_session SET draft_login_id=$1::uuid
      WHERE id=1 AND draft_actor_id=$2::bigint AND draft_encrypted_state IS NOT NULL AND draft_expires_at>now()`, loginId, c.actor.id);
    await tx.$executeRawUnsafe("UPDATE compass_session SET enabled=true,updated_by=$1::bigint WHERE id=1", c.actor.id);
    await audit(tx, c, "COMPASS_BROWSER_OPEN", "compass_login", null, null, { loginId, status: "QUEUED" });
    return { id: loginId };
  });
}

export async function compassLoginView(c: Context, value: string): Promise<CompassBrowserLoginView> {
  await expireCompassTasks();
  const row = await ownedLogin(c, value);
  return { id: row.id, status: row.status, expiresAt: new Date(Number(row.expires_ms)).toISOString(),
    frameId: row.frame_id, frame: row.frame_jpeg ? "data:image/jpeg;base64," + row.frame_jpeg : null, note: row.note };
}

export async function compassLoginAction(c: Context, value: string, input: unknown) {
  requirePermission(c.actor, "analytics.manage");
  const b = parse(compassBrowserActionSchema, input);
  await expireCompassTasks();
  return command(c, "compass.browser.action", { id: value, ...b }, async tx => {
    const row = await ownedLogin(c, value, tx);
    if (!["WAITING", "CHECKING"].includes(row.status) || Number(row.expires_ms) <= Date.now())
      fail("COMPASS_LOGIN_NOT_ACTIVE", "后台窗口尚未就绪或已关闭，请重新打开", 409);
    if ((b.kind === "CLICK" || b.kind === "SCROLL") && b.frameId !== row.frame_id)
      fail("STALE_CLOUD_FRAME", "后台画面已变化，请等待画面刷新后操作", 409);
    if ((await one(tx, "SELECT count(*)::int AS n FROM compass_login_actions WHERE login_id=$1::uuid AND completed_at IS NULL", row.id))!.n >= 3)
      fail("COMPASS_ACTION_BUSY", "后台正在处理操作，请稍候", 409);
    await tx.$executeRawUnsafe("INSERT INTO compass_login_actions(login_id,payload) VALUES($1::uuid,$2::jsonb)", row.id, JSON.stringify(b));
    return { queued: true };
  });
}

export async function cancelCompassLogin(c: Context, value: string) {
  requirePermission(c.actor, "analytics.manage");
  return command(c, "compass.browser.cancel", { id: value }, async tx => {
    await rows(tx, "SELECT pg_advisory_xact_lock($1)::text", compassBrowserLock);
    const row = await ownedLogin(c, value, tx);
    await tx.$executeRawUnsafe(`UPDATE compass_logins SET status='CANCELLED',claim_token=NULL,frame_jpeg=NULL,frame_id=NULL,completed_at=now(),
      note='后台登录已取消' WHERE id=$1::uuid AND status IN ${activeLogins}`, row.id);
    await tx.$executeRawUnsafe(`UPDATE compass_session SET draft_encrypted_state=NULL,draft_actor_id=NULL,
      draft_login_id=NULL,draft_expires_at=NULL WHERE id=1 AND draft_login_id=$1::uuid`, row.id);
    await tx.$executeRawUnsafe("DELETE FROM compass_login_actions WHERE login_id=$1::uuid", row.id);
    return { cancelled: true };
  });
}

export async function disconnectCompassSession(c: Context) {
  requirePermission(c.actor, "analytics.manage");
  return command(c, "compass.browser.disconnect", {}, async tx => {
    await rows(tx, "SELECT pg_advisory_xact_lock($1)::text", compassBrowserLock);
    await tx.$executeRawUnsafe(`UPDATE compass_session SET enabled=false,status='DISCONNECTED',encrypted_state=NULL,
      state_version=state_version+1,saved_at=NULL,checked_at=NULL,auto_update_enabled=false,
      draft_encrypted_state=NULL,draft_actor_id=NULL,draft_login_id=NULL,draft_expires_at=NULL,
      note='后台会话已断开，请重新登录',updated_by=$1::bigint WHERE id=1`, c.actor.id);
    await tx.$executeRawUnsafe(`UPDATE compass_logins SET status='CANCELLED',frame_jpeg=NULL,frame_id=NULL,
      completed_at=now(),note='后台会话已断开' WHERE status IN ${activeLogins}`);
    await tx.$executeRawUnsafe("DELETE FROM compass_login_actions");
    await tx.$executeRawUnsafe(`UPDATE compass_update_jobs SET
      status=CASE WHEN jsonb_array_length(completed_dimensions)>0 THEN 'PARTIAL' ELSE 'FAILED' END,
      claim_token=NULL,completed_at=now(),note='后台会话已断开；保留已完成报表，重新登录后可继续更新' WHERE status IN ${activeJobs}`);
    await audit(tx, c, "COMPASS_BROWSER_DISCONNECT", "compass_session", "1", null, { disconnected: true });
    return { disconnected: true };
  });
}

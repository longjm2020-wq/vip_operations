import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  db,
  one,
  rows,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import {
  audit,
  command,
  fail,
  parse,
  requirePermission,
  type Context,
} from "../../core.js";
import {
  jushuitanLoginActionSchema,
  jushuitanScope,
  jushuitanSettingsSchema,
} from "../../../../../packages/contracts/src/jushuitan-inventory.js";
import { encryptSecret, encryptionReady } from "../analytics/secrets.js";
import {
  JstExportError,
  type JstMatchedExport,
} from "../../integrations/jushuitan/export-file.js";

export const jstLock = async (tx: Tx) => {
  await rows(tx, "SELECT pg_advisory_xact_lock(2026102951)::text");
};
export const jstSettings = (tx: Tx = db, lock = false) =>
  one(
    tx,
    `SELECT * FROM jushuitan_inventory_settings WHERE id=1${lock ? " FOR UPDATE" : ""}`,
  );
const activeLogin = "('QUEUED','RUNNING','WAITING','CHECKING')";
function requireManager(c: Context) {
  requirePermission(c.actor, "inventory.adjust");
  if (!c.actor.roleCodes?.includes("SUPER_ADMIN"))
    fail("FORBIDDEN", "仅超级管理员可以配置聚水潭库存同步", 403);
}
export async function jstWorkerActor(id: unknown, tx: Tx = db) {
  const actor = await one(
    tx,
    `SELECT u.id FROM users u WHERE u.id=$1::bigint AND u.status='ACTIVE' AND
    EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.code='SUPER_ADMIN')`,
    String(id),
  );
  if (!actor)
    throw new JstExportError("任务发起者已停用或不再拥有超级管理员权限");
}
export async function expireJstTasks(tx: Tx) {
  await tx.$executeRawUnsafe(`UPDATE jushuitan_browser_logins SET status='EXPIRED',frame_id=NULL,frame_jpeg=NULL,note='登录窗口已过期，请重新打开'
    WHERE status IN ${activeLogin} AND (expires_at<=now() OR (status='QUEUED' AND created_at<now()-interval '2 minutes') OR
      (status<>'QUEUED' AND heartbeat_at<now()-interval '1 minute'))`);
  await tx.$executeRawUnsafe(`DELETE FROM jushuitan_browser_actions a USING jushuitan_browser_logins l WHERE a.login_id=l.id
    AND (l.status NOT IN ${activeLogin} OR a.created_at<now()-interval '1 minute')`);
  await tx.$executeRawUnsafe(`UPDATE jushuitan_inventory_runs SET status='FAILED',finished_at=now(),error_note='同步超时或工作进程已中断，保留上次完整结果'
    WHERE status IN ('QUEUED','RUNNING') AND (created_at<now()-interval '30 minutes' OR (status='RUNNING' AND heartbeat_at<now()-interval '1 minute'))`);
  await tx.$executeRawUnsafe(
    `DELETE FROM jushuitan_browser_logins WHERE status NOT IN ${activeLogin} AND created_at<now()-interval '1 day'`,
  );
}
function publicSettings(s: Row) {
  return {
    mode: "BROWSER_EXPORT",
    configured: !!s.encrypted_session,
    encryption_ready: encryptionReady() && s.browser_encryption_ready,
    worker_online:
      !!s.worker_heartbeat_at &&
      Date.now() - new Date(s.worker_heartbeat_at).getTime() < 60000,
    version: s.version,
    enabled: s.enabled,
    interval_minutes: s.interval_minutes,
    warehouse_name: jushuitanScope.warehouse,
    company_name: jushuitanScope.company,
    session_status: s.session_status,
    session_saved_at: s.session_saved_at,
    session_checked_at: s.session_checked_at,
    active_run_id: s.active_run_id,
    error_note: s.error_note,
    next_sync_at: s.next_sync_at,
  };
}
export async function jushuitanStatus() {
  const s = (await jstSettings())!;
  return {
    ...publicSettings(s),
    runs: await rows(
      db,
      `SELECT id,source_kind,warehouse_name,trigger_type,status,stage,requested_count,received_count,processed_count,
    exported_count,missing_codes,error_note,created_at,started_at,finished_at,source_file_name,source_sha256
    FROM jushuitan_inventory_runs ORDER BY created_at DESC LIMIT 12`,
    ),
  };
}
export async function saveJushuitan(c: Context, input: unknown) {
  requireManager(c);
  const b = parse(jushuitanSettingsSchema, input);
  return command(c, "inventory.jushuitan-settings", b, async (tx) => {
    await jstLock(tx);
    const old = (await jstSettings(tx, true))!;
    if (old.version !== b.version)
      fail("VERSION_CONFLICT", "设置已更新，请刷新后保存");
    if (b.enabled && (!old.encrypted_session || old.session_status !== "READY"))
      fail("JST_NOT_READY", "请先在网站内登录聚水潭并核验保存会话", 422);
    await tx.$executeRawUnsafe(
      `UPDATE jushuitan_inventory_settings SET enabled=$1,interval_minutes=$2,next_sync_at=CASE WHEN $1 THEN now() ELSE NULL END,
      version=version+1,updated_by=$3::bigint,updated_at=now() WHERE id=1`,
      b.enabled,
      b.intervalMinutes,
      c.actor.id,
    );
    await audit(
      tx,
      c,
      "jushuitan.settings",
      "jushuitan_inventory_settings",
      "1",
      null,
      b,
    );
    return { saved: true };
  });
}
function online(s: Row) {
  if (
    !s.worker_heartbeat_at ||
    Date.now() - new Date(s.worker_heartbeat_at).getTime() > 60000
  )
    fail("JST_WORKER_OFFLINE", "库存同步工作进程离线，请稍后重试", 503);
  if (!encryptionReady() || !s.browser_encryption_ready)
    fail("JST_ENCRYPTION", "服务器会话加密尚未就绪", 503);
}
export async function openJushuitanLogin(c: Context) {
  requireManager(c);
  return command(c, "inventory.jushuitan-login", {}, async (tx) => {
    await jstLock(tx);
    await expireJstTasks(tx);
    const s = (await jstSettings(tx, true))!;
    online(s);
    const old = await one(
      tx,
      `SELECT id,actor_id FROM jushuitan_browser_logins WHERE status IN ${activeLogin}`,
    );
    if (old) {
      if (String(old.actor_id) !== c.actor.id)
        fail("JST_BUSY", "另一位管理员正在登录，请稍后重试", 409);
      return { id: old.id };
    }
    if (
      await one(
        tx,
        "SELECT id FROM jushuitan_inventory_runs WHERE status IN ('QUEUED','RUNNING')",
      )
    )
      fail("JST_BUSY", "库存正在同步，完成后再打开登录", 409);
    const id = randomUUID();
    await tx.$executeRawUnsafe(
      "INSERT INTO jushuitan_browser_logins(id,actor_id,settings_version) VALUES($1::uuid,$2::bigint,$3)",
      id,
      c.actor.id,
      s.version,
    );
    await audit(
      tx,
      c,
      "jushuitan.login-open",
      "jushuitan_inventory_settings",
      "1",
      null,
      { loginId: id },
    );
    return { id };
  });
}
async function ownedLogin(tx: Tx, c: Context, id: string) {
  requireManager(c);
  parse(z.uuid(), id);
  const login = await one(
    tx,
    "SELECT * FROM jushuitan_browser_logins WHERE id=$1::uuid FOR UPDATE",
    id,
  );
  if (!login || String(login.actor_id) !== c.actor.id)
    fail("FORBIDDEN", "仅发起登录的管理员可操作此窗口", 403);
  return login;
}
export async function jushuitanLoginView(c: Context, id: string) {
  return db.$transaction(async (tx) => {
    const l = await ownedLogin(tx, c, id);
    const valid =
      new Date(l.expires_at).getTime() > Date.now() &&
      ["RUNNING", "WAITING", "CHECKING"].includes(l.status);
    return {
      id: l.id,
      status: l.status,
      expires_at: l.expires_at,
      note: l.note,
      frame_id: valid ? l.frame_id : null,
      frame:
        valid && l.frame_jpeg ? `data:image/jpeg;base64,${l.frame_jpeg}` : null,
    };
  });
}
export async function jushuitanLoginAction(
  c: Context,
  id: string,
  input: unknown,
) {
  requireManager(c);
  const b = parse(jushuitanLoginActionSchema, input);
  // Encrypt immediately: audit/idempotency records retain neither typed secrets nor their hashes.
  return db.$transaction(async (tx) => {
    await jstLock(tx);
    const l = await ownedLogin(tx, c, id);
    if (
      l.status !== "WAITING" ||
      new Date(l.expires_at).getTime() <= Date.now()
    )
      fail("JST_LOGIN_STATE", "登录窗口尚未就绪或已关闭", 409);
    if ("frameId" in b && b.frameId !== l.frame_id)
      fail("JST_STALE_FRAME", "画面已变化，请根据新画面重新操作", 409);
    if (
      await one(
        tx,
        "SELECT id FROM jushuitan_browser_actions WHERE login_id=$1::uuid",
        id,
      )
    )
      fail("JST_LOGIN_BUSY", "正在执行上一步，请稍候", 409);
    await tx.$executeRawUnsafe(
      "INSERT INTO jushuitan_browser_actions(login_id,encrypted_payload) VALUES($1::uuid,$2)",
      id,
      encryptSecret(
        JSON.stringify({
          purpose: "jst-action-v1",
          loginId: id,
          actorId: c.actor.id,
          action: b,
        }),
      ),
    );
    await tx.$executeRawUnsafe(
      "UPDATE jushuitan_browser_logins SET frame_id=NULL,status='RUNNING' WHERE id=$1::uuid",
      id,
    );
    return { accepted: true };
  });
}
export async function cancelJushuitanLogin(c: Context, id: string) {
  return command(c, "inventory.jushuitan-login-cancel", { id }, async (tx) => {
    await jstLock(tx);
    await ownedLogin(tx, c, id);
    await tx.$executeRawUnsafe(
      `UPDATE jushuitan_browser_logins SET status='CANCELLED',frame_id=NULL,frame_jpeg=NULL,note='已关闭登录窗口' WHERE id=$1::uuid AND status IN ${activeLogin}`,
      id,
    );
    await tx.$executeRawUnsafe(
      "DELETE FROM jushuitan_browser_actions WHERE login_id=$1::uuid",
      id,
    );
    return { cancelled: true };
  });
}
export async function disconnectJushuitan(c: Context) {
  requireManager(c);
  return command(c, "inventory.jushuitan-disconnect", {}, async (tx) => {
    await jstLock(tx);
    await tx.$executeRawUnsafe(`UPDATE jushuitan_inventory_settings SET encrypted_session=NULL,session_status='DISCONNECTED',session_saved_at=NULL,session_checked_at=NULL,
      session_actor_id=NULL,enabled=false,next_sync_at=NULL,version=version+1,error_note='登录会话已移除，上次库存仅供参考' WHERE id=1`);
    await tx.$executeRawUnsafe(
      `UPDATE jushuitan_browser_logins SET status='CANCELLED',frame_id=NULL,frame_jpeg=NULL WHERE status IN ${activeLogin}`,
    );
    await tx.$executeRawUnsafe("DELETE FROM jushuitan_browser_actions");
    await tx.$executeRawUnsafe(
      "UPDATE jushuitan_inventory_runs SET status='FAILED',finished_at=now(),error_note='登录会话已移除' WHERE status IN ('QUEUED','RUNNING')",
    );
    await audit(
      tx,
      c,
      "jushuitan.disconnect",
      "jushuitan_inventory_settings",
      "1",
      null,
      { disconnected: true },
    );
    return { disconnected: true };
  });
}
export async function enqueueJst(
  tx: Tx,
  s: Row,
  actorId: string,
  scheduled = false,
) {
  if (!s.encrypted_session || s.session_status !== "READY")
    fail("JST_NOT_READY", "请先登录聚水潭并核验保存会话", 422);
  const old = await one(
    tx,
    "SELECT id,status FROM jushuitan_inventory_runs WHERE status IN ('QUEUED','RUNNING')",
  );
  if (old) return old;
  if (
    await one(
      tx,
      `SELECT id FROM jushuitan_browser_logins WHERE status IN ${activeLogin}`,
    )
  )
    fail("JST_BUSY", "请先完成或关闭登录窗口", 409);
  const id = randomUUID();
  await tx.$executeRawUnsafe(
    `INSERT INTO jushuitan_inventory_runs(id,settings_version,warehouse_name,trigger_type,requested_by,source_kind,stage,status)
    VALUES($1::uuid,$2,$3,$4,$5::bigint,'BROWSER_EXPORT','等待同步','QUEUED')`,
    id,
    s.version,
    jushuitanScope.warehouse,
    scheduled ? "SCHEDULED" : "MANUAL",
    actorId,
  );
  await tx.$executeRawUnsafe(
    "UPDATE jushuitan_inventory_settings SET next_sync_at=now()+interval '1 minute'*interval_minutes WHERE id=1",
  );
  return { id, status: "QUEUED" };
}
export async function queueJushuitan(c: Context) {
  requireManager(c);
  return command(c, "inventory.jushuitan-sync", {}, async (tx) => {
    await jstLock(tx);
    await expireJstTasks(tx);
    const s = (await jstSettings(tx, true))!;
    online(s);
    const job = await enqueueJst(tx, s, c.actor.id);
    await audit(
      tx,
      c,
      "jushuitan.sync",
      "jushuitan_inventory_settings",
      "1",
      null,
      { runId: job.id },
    );
    return job;
  });
}
export async function jushuitanSource(tx: Tx) {
  return one(
    tx,
    `SELECT s.warehouse_name,s.active_run_id,s.error_note,s.enabled,s.interval_minutes,
    r.started_at,r.finished_at,r.requested_count,r.received_count,r.exported_count,r.source_kind,r.source_file_name
    FROM jushuitan_inventory_settings s LEFT JOIN jushuitan_inventory_runs r ON r.id=s.active_run_id AND r.status='COMPLETE' WHERE s.id=1`,
  );
}
export async function jushuitanMatches(query: Row) {
  const q = parse(
    z.object({
      skuCode: z.string().max(128).optional(),
      page: z.coerce.number().int().min(1).default(1),
    }),
    query,
  );
  const s = await jstSettings();
  if (!s?.active_run_id) return { data: [], total: 0 };
  const matches = await rows(
    db,
    `SELECT source_sku,target_code,mapped_code,color_size,quantities,count(*) OVER()::int AS total
    FROM jushuitan_inventory_sources WHERE run_id=$1::uuid AND ($2='' OR target_code=$2 OR source_sku=$2 OR mapped_code=$2)
    ORDER BY target_code,source_sku LIMIT 50 OFFSET $3`,
    s.active_run_id,
    q.skuCode ?? "",
    (q.page - 1) * 50,
  );
  return { data: matches, total: matches[0]?.total ?? 0 };
}
/** Publish only a complete, scope-verified original export, atomically. */
export async function publishJstExport(
  job: Row,
  token: string,
  report: JstMatchedExport,
  files: { bytes: Buffer; fileName: string }[],
  encryptedSession: string,
) {
  return db.$transaction(
    async (tx) => {
      await jstLock(tx);
      const s = (await jstSettings(tx, true))!;
      const run = await one(
        tx,
        "SELECT * FROM jushuitan_inventory_runs WHERE id=$1::uuid AND claim_token=$2::uuid AND status='RUNNING' FOR UPDATE",
        job.id,
        token,
      );
      if (!run || s.version !== job.settings_version || !s.encrypted_session)
        throw new JstExportError("会话或设置已改变，本次结果未发布");
      if (Date.now() - new Date(run.created_at).getTime() > 30 * 60000)
        throw new JstExportError("同步超过三十分钟，本次结果未发布");
      await jstWorkerActor(run.requested_by, tx);
      await jstWorkerActor(s.session_actor_id, tx);
      if (
        !report.records.length ||
        !files.length ||
        files.some((f) => f.bytes.length > 20971520)
      )
        throw new JstExportError(
          "没有匹配库存或导出文件不完整，本次结果未发布",
        );
      const current = await rows(
        tx,
        "SELECT sku_code,barcode,color_name,size_name FROM skus WHERE sku_code=ANY($1::text[]) ORDER BY sku_code",
        report.targets.map((t) => t.sku_code),
      );
      const stable = (records: Row[]) =>
        JSON.stringify(
          [...records]
            .sort((a, b) => a.sku_code.localeCompare(b.sku_code))
            .map((r) => [
              r.sku_code,
              r.barcode ?? null,
              r.color_name,
              r.size_name,
            ]),
        );
      if (stable(current) !== stable(report.targets))
        throw new JstExportError(
          "同步期间网站商品编码、颜色或尺码已变化，请重新同步",
        );
      await tx.$executeRawUnsafe(
        `INSERT INTO jushuitan_inventory_snapshots(run_id,sku_code,physical_qty,reserved_qty,damaged_qty,in_transit_qty,transfer_transit_qty,incoming_qty,return_qty,virtual_qty,available_qty)
      SELECT $1::uuid,r.sku_code,r.physical_qty,r.reserved_qty,NULL,r.in_transit_qty,r.transfer_transit_qty,r.incoming_qty,r.return_qty,r.virtual_qty,r.available_qty
      FROM jsonb_to_recordset($2::jsonb) r(sku_code text,physical_qty bigint,reserved_qty bigint,in_transit_qty bigint,transfer_transit_qty bigint,incoming_qty bigint,return_qty bigint,virtual_qty bigint,available_qty bigint)
      JOIN skus s ON s.sku_code=r.sku_code`,
        job.id,
        JSON.stringify(report.records),
      );
      const stats = (await one(
        tx,
        `SELECT $2::int AS total,(SELECT count(*)::int FROM jushuitan_inventory_snapshots WHERE run_id=$1::uuid) AS matched`,
        job.id,
        report.targets.length,
      ))!;
      if (!stats.matched)
        throw new JstExportError(
          "导出表格未匹配网站的完整商品编码，本次结果未发布",
        );
      const matchedCodes = new Set(report.records.map((r) => r.sku_code));
      const missing = report.targets
        .map((t) => t.sku_code)
        .filter((code) => !matchedCodes.has(code))
        .slice(0, 50);
      const safeName = `${files.length}份原始库存表`;
      await tx.$executeRawUnsafe(
        `UPDATE jushuitan_inventory_runs SET status='COMPLETE',stage='已完成',finished_at=now(),requested_count=$3,received_count=$4,processed_count=$3,
      exported_count=$5,missing_codes=$6::jsonb,source_file_name=$7,source_sha256=$8 WHERE id=$1::uuid AND claim_token=$2::uuid`,
        job.id,
        token,
        stats.total,
        stats.matched,
        report.sources.length,
        JSON.stringify(missing),
        safeName,
        createHash("sha256")
          .update(
            files
              .map((f) => createHash("sha256").update(f.bytes).digest("hex"))
              .join(":"),
          )
          .digest("hex"),
      );
      for (const [batch, file] of files.entries())
        await tx.$executeRawUnsafe(
          "INSERT INTO jushuitan_inventory_files(run_id,batch_no,file_name,sha256,original_bytes) VALUES($1::uuid,$2,$3,$4,decode($5,'base64'))",
          job.id,
          batch + 1,
          file.fileName.replace(/[\u0000-\u001f\\/]/g, "_").slice(0, 180),
          createHash("sha256").update(file.bytes).digest("hex"),
          file.bytes.toString("base64"),
        );
      await tx.$executeRawUnsafe(
        `INSERT INTO jushuitan_inventory_sources(run_id,source_sku,target_code,mapped_code,color_size,quantities)
      SELECT $1::uuid,r.sku_code,r.target_code,r.mapped_code,r.color_size,to_jsonb(r)-'sku_code'-'target_code'-'mapped_code'-'color_size'
      FROM jsonb_to_recordset($2::jsonb) r(sku_code text,target_code text,mapped_code text,color_size text,physical_qty bigint,reserved_qty bigint,in_transit_qty bigint,transfer_transit_qty bigint,incoming_qty bigint,return_qty bigint,virtual_qty bigint,available_qty bigint)`,
        job.id,
        JSON.stringify(report.sources),
      );
      await tx.$executeRawUnsafe(
        `UPDATE jushuitan_inventory_settings SET active_run_id=$1::uuid,encrypted_session=$2,session_status='READY',session_checked_at=now(),error_note='' WHERE id=1`,
        job.id,
        encryptedSession,
      );
      for (const table of [
        "jushuitan_inventory_snapshots",
        "jushuitan_inventory_files",
        "jushuitan_inventory_sources",
      ])
        await tx.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE run_id NOT IN (SELECT id FROM jushuitan_inventory_runs WHERE status='COMPLETE' ORDER BY finished_at DESC LIMIT 5)`,
        );
      return {
        matched: stats.matched,
        total: stats.total,
        exported: report.sources.length,
      };
    },
    { timeout: 60000 },
  );
}

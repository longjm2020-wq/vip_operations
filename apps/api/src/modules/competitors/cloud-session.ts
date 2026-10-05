import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  db,
  one,
  rows,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import {
  audit,
  command,
  Context,
  fail,
  parse,
  requirePermission,
} from "../../core.js";
import { cloudActionSchema } from "../../../../../packages/contracts/src/competitor-cloud.js";

const active = "('QUEUED','RUNNING','WAITING','CHECKING')";
export async function cloudStatus() {
  return one(
    db,
    `SELECT enabled,status,saved_at::text,checked_at::text,encryption_ready,
    coalesce(worker_heartbeat_at>now()-interval '1 minute',false) AS worker_online,note
    FROM competitor_cloud_session WHERE id=1`,
  );
}
export async function expireCloudLogins() {
  await db.$executeRawUnsafe(`UPDATE competitor_cloud_logins SET status='EXPIRED',frame_jpeg=NULL,frame_id=NULL,
    completed_at=now(),note='云端登录已过期，请重新打开' WHERE status IN ${active}
    AND (expires_at<now() OR (status<>'QUEUED' AND heartbeat_at<now()-interval '1 minute'))`);
}
async function owned(c: Context, value: string, tx: Tx = db) {
  requirePermission(c.actor, "analytics.manage");
  const loginId = parse(z.uuid(), value);
  const row = await one(
    tx,
    "SELECT *, (extract(epoch FROM expires_at)*1000)::bigint AS expires_ms FROM competitor_cloud_logins WHERE id=$1::uuid FOR UPDATE",
    loginId,
  );
  if (!row) fail("NOT_FOUND", "云端登录不存在", 404);
  if (String(row.actor_id) !== c.actor.id)
    fail("FORBIDDEN", "只能操作自己打开的云端登录窗口", 403);
  return row;
}
export async function openCloudLogin(c: Context) {
  requirePermission(c.actor, "analytics.manage");
  await expireCloudLogins();
  return command(c, "competitor.cloud.open", {}, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(2026100341)::text");
    const config = await one(
      tx,
      "SELECT encryption_ready,coalesce(worker_heartbeat_at>now()-interval '1 minute',false) AS worker_online FROM competitor_cloud_session WHERE id=1 FOR UPDATE",
    );
    if (!config?.encryption_ready)
      fail(
        "CLOUD_KEY_MISSING",
        "云端采集尚未配置会话加密密钥，请联系管理员",
        503,
      );
    if (!config.worker_online)
      fail("CLOUD_WORKER_OFFLINE", "云端采集程序未在线，请稍后重试", 503);
    const running = await one(
      tx,
      `SELECT id::text,actor_id::text FROM competitor_cloud_logins WHERE status IN ${active}`,
    );
    if (running) {
      if (running.actor_id !== c.actor.id)
        fail("CLOUD_LOGIN_BUSY", "其他管理员正在进行云端登录，请稍后重试");
      return { id: running.id };
    }
    const id = randomUUID();
    await tx.$executeRawUnsafe(
      "INSERT INTO competitor_cloud_logins(id,actor_id,note) VALUES($1::uuid,$2::bigint,'正在准备云端浏览器，当前采集完成步骤后会暂停')",
      id,
      c.actor.id,
    );
    await tx.$executeRawUnsafe(
      "UPDATE competitor_cloud_session SET enabled=true,updated_by=$1::bigint WHERE id=1",
      c.actor.id,
    );
    await audit(
      tx,
      c,
      "competitor.cloud.open",
      "competitor_cloud_login",
      null,
      null,
      { loginId: id, status: "QUEUED" },
    );
    return { id };
  });
}
export async function cloudLoginView(c: Context, value: string) {
  await expireCloudLogins();
  const row = await owned(c, value);
  return {
    id: row.id,
    status: row.status,
    expires_at: new Date(Number(row.expires_ms)).toISOString(),
    frame_id: row.frame_id,
    frame: row.frame_jpeg ? "data:image/jpeg;base64," + row.frame_jpeg : null,
    note: row.note,
  };
}
export async function cloudLoginAction(
  c: Context,
  value: string,
  input: unknown,
) {
  requirePermission(c.actor, "analytics.manage");
  const b = parse(cloudActionSchema, input);
  await expireCloudLogins();
  return command(
    c,
    "competitor.cloud.action",
    { id: value, ...b },
    async (tx) => {
      const row = await owned(c, value, tx);
      if (
        !["WAITING", "CHECKING"].includes(row.status) ||
        Number(row.expires_ms) <= Date.now()
      )
        fail(
          "CLOUD_LOGIN_NOT_ACTIVE",
          "云端窗口尚未就绪或已关闭，请刷新后重试",
        );
      if (
        (b.kind === "CLICK" || b.kind === "DRAG") &&
        b.frameId !== row.frame_id
      )
        fail("STALE_CLOUD_FRAME", "云端页面已变化，请等待画面刷新后操作");
      if (
        (await one(
          tx,
          "SELECT count(*)::int AS n FROM competitor_cloud_actions WHERE login_id=$1::uuid AND completed_at IS NULL",
          row.id,
        ))!.n >= 3
      )
        fail("CLOUD_ACTION_BUSY", "云端正在处理操作，请稍候");
      await tx.$executeRawUnsafe(
        "INSERT INTO competitor_cloud_actions(login_id,payload) VALUES($1::uuid,$2::jsonb)",
        row.id,
        JSON.stringify(b),
      );
      return { queued: true };
    },
  );
}
export async function cancelCloudLogin(c: Context, value: string) {
  return command(c, "competitor.cloud.cancel", { id: value }, async (tx) => {
    const row = await owned(c, value, tx);
    await tx.$executeRawUnsafe(
      `UPDATE competitor_cloud_logins SET status='CANCELLED',frame_jpeg=NULL,frame_id=NULL,
      completed_at=now(),note='云端登录已取消' WHERE id=$1::uuid AND status IN ${active}`,
      row.id,
    );
    await tx.$executeRawUnsafe(
      "DELETE FROM competitor_cloud_actions WHERE login_id=$1::uuid",
      row.id,
    );
    return { cancelled: true };
  });
}
export async function disconnectCloud(c: Context) {
  requirePermission(c.actor, "analytics.manage");
  return command(c, "competitor.cloud.disconnect", {}, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(2026100341)::text");
    await tx.$executeRawUnsafe(
      "UPDATE competitor_cloud_session SET enabled=true,status='DISCONNECTED',encrypted_state=NULL,state_version=state_version+1,saved_at=NULL,checked_at=NULL,note='云端会话已断开，请重新扫码登录',updated_by=$1::bigint WHERE id=1",
      c.actor.id,
    );
    await tx.$executeRawUnsafe(`UPDATE competitor_cloud_logins SET status='CANCELLED',frame_jpeg=NULL,frame_id=NULL,
      completed_at=now(),note='云端会话已断开' WHERE status IN ${active}`);
    await tx.$executeRawUnsafe("DELETE FROM competitor_cloud_actions");
    await audit(
      tx,
      c,
      "competitor.cloud.disconnect",
      "competitor_cloud_session",
      "1",
      null,
      { status: "DISCONNECTED" },
    );
    return { disconnected: true };
  });
}

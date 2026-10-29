import { randomUUID } from "node:crypto";
import {
  db,
  one,
  rows,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import {
  audit,
  canonical,
  command,
  fail,
  parse,
  requirePermission,
  type Context,
} from "../../core.js";
import { jushuitanSettingsSchema } from "../../../../../packages/contracts/src/jushuitan-inventory.js";
import {
  decryptSecret,
  encryptSecret,
  encryptionReady,
} from "../analytics/secrets.js";
import {
  JushuitanError,
  jushuitanTokens,
  queryJushuitanWarehouses,
  queryJushuitanStock,
  type JushuitanCredentials,
  type JushuitanWarehouse,
  type JushuitanStock,
} from "../../integrations/jushuitan/client.js";

const settings = (tx: Tx = db, lock = false) =>
  one(
    tx,
    `SELECT * FROM jushuitan_inventory_settings WHERE id=1${lock ? " FOR UPDATE" : ""}`,
  );
function requireManager(c: Context) {
  requirePermission(c.actor, "inventory.adjust");
  if (!c.actor.roleCodes?.includes("SUPER_ADMIN"))
    fail("FORBIDDEN", "仅超级管理员可以配置聚水潭库存接入", 403);
}
function publicSettings(s: Row) {
  return {
    configured: !!s.credentials_encrypted,
    encryption_ready: encryptionReady(),
    version: s.version,
    enabled: s.enabled,
    interval_minutes: s.interval_minutes,
    warehouse_id: s.warehouse_id?.toString() ?? null,
    warehouse_name: s.warehouse_name,
    company_id: s.company_id?.toString() ?? null,
    verified_at: s.verified_at,
    warehouses: s.warehouses,
    available_rule: s.available_rule,
    token_expires_at: s.token_expires_at,
    active_run_id: s.active_run_id,
    error_note: s.error_note,
    next_sync_at: s.next_sync_at,
  };
}
export async function jushuitanStatus() {
  const s = (await settings())!;
  return {
    ...publicSettings(s),
    runs: await rows(
      db,
      "SELECT * FROM jushuitan_inventory_runs ORDER BY created_at DESC LIMIT 12",
    ),
  };
}
export async function saveJushuitan(c: Context, input: unknown) {
  requireManager(c);
  const b = parse(jushuitanSettingsSchema, input);
  if (
    Boolean(b.appKey) !== Boolean(b.appSecret) ||
    (b.clearCredentials && (b.appKey || b.appSecret))
  )
    fail(
      "JST_CREDENTIALS",
      "更换凭据时请同时填写 App Key 和 App Secret；清除时请留空",
      400,
    );
  return command(c, "inventory.jushuitan-settings", b, async (tx) => {
    const old = (await settings(tx, true))!;
    if (old.version !== b.version)
      fail("VERSION_CONFLICT", "接入设置已更新，请刷新后再保存");
    const changed = !!(b.appKey || b.clearCredentials);
    const list: JushuitanWarehouse[] = changed ? [] : old.warehouses;
    const warehouse = changed
      ? null
      : list.find((w) => w.wms_co_id === b.warehouseId);
    if (!changed && b.warehouseId && !warehouse)
      fail("JST_WAREHOUSE", "请先验证连接并从返回的仓库中选择杭州总仓", 400);
    if (b.enabled && (!warehouse || !old.verified_at || changed))
      fail(
        "JST_NOT_READY",
        "请先保存凭据、验证连接并选择仓库，再开启定时同步",
        400,
      );
    const encrypted = b.clearCredentials
      ? null
      : b.appKey
        ? encryptSecret(
            JSON.stringify({ appKey: b.appKey, appSecret: b.appSecret }),
          )
        : old.credentials_encrypted;
    const scopeChanged =
      changed ||
      String(old.warehouse_id ?? "") !== String(warehouse?.wms_co_id ?? "") ||
      String(old.company_id ?? "") !== String(warehouse?.co_id ?? "") ||
      old.warehouse_name !== (warehouse?.name ?? "") ||
      canonical(b.availableRule) !== canonical(old.available_rule);
    const saved = (await one(
      tx,
      `UPDATE jushuitan_inventory_settings SET credentials_encrypted=$1,
      enabled=$2,interval_minutes=$3,warehouse_id=$4::bigint,warehouse_name=$5,company_id=$6::bigint,
      available_rule=$7::jsonb,version=version+1,updated_by=$8::bigint,updated_at=now(),next_sync_at=now(),error_note='',
      warehouses=CASE WHEN $9 THEN '[]'::jsonb ELSE warehouses END,
      verified_at=CASE WHEN $9 THEN NULL ELSE verified_at END,
      token_expires_at=CASE WHEN $9 THEN NULL ELSE token_expires_at END,
      active_run_id=CASE WHEN $10 THEN NULL ELSE active_run_id END WHERE id=1 RETURNING *`,
      encrypted,
      b.enabled,
      b.intervalMinutes,
      warehouse?.wms_co_id ?? null,
      warehouse?.name ?? "",
      warehouse?.co_id ?? null,
      b.availableRule ? JSON.stringify(b.availableRule) : null,
      c.actor.id,
      changed,
      scopeChanged,
    ))!;
    await rows(
      tx,
      "UPDATE jushuitan_inventory_runs SET status='FAILED',finished_at=now(),error_note='设置已变更，请重新发起同步' WHERE status='QUEUED' RETURNING id",
    );
    await audit(
      tx,
      c,
      "JUSHUITAN_SETTINGS",
      "jushuitan_inventory_settings",
      1,
      publicSettings(old),
      publicSettings(saved),
    );
    return publicSettings(saved);
  });
}
function safeError(error: unknown) {
  return error instanceof JushuitanError
    ? error.message
    : "聚水潭同步未完成，请稍后重试；上次完整数据保留";
}
// Serialize token rotation with settings edits; secrets only live in this server-side scope.
async function credentials(expectedVersion?: number) {
  return db.$transaction(
    async (tx) => {
      const s = (await settings(tx, true))!;
      if (expectedVersion != null && s.version !== expectedVersion)
        throw new JushuitanError("设置已变更，请重新发起同步");
      if (!s.credentials_encrypted)
        throw new JushuitanError("请先在接入设置中填写自研应用凭据");
      const c = JSON.parse(
        decryptSecret(s.credentials_encrypted),
      ) as JushuitanCredentials;
      const expires = s.token_expires_at
        ? new Date(s.token_expires_at).getTime()
        : 0;
      if (!c.accessToken || expires < Date.now() + 3 * 86400000) {
        const token = await jushuitanTokens(
          c,
          !!c.refreshToken && expires > Date.now(),
        );
        c.accessToken = token.access_token;
        c.refreshToken = token.refresh_token;
        await rows(
          tx,
          "UPDATE jushuitan_inventory_settings SET credentials_encrypted=$1,token_expires_at=$2::timestamptz WHERE id=1 RETURNING id",
          encryptSecret(JSON.stringify(c)),
          new Date(Date.now() + token.expires_in * 1000),
        );
      }
      return { c, version: s.version };
    },
    { timeout: 35000, maxWait: 35000 },
  );
}
export async function verifyJushuitan(c: Context) {
  requireManager(c);
  const original = (await settings())!;
  try {
    const auth = await credentials(original.version);
    const warehouses = await queryJushuitanWarehouses(auth.c);
    if (!warehouses.length)
      throw new JushuitanError(
        "授权账号没有可读取的仓库，请检查仓库查询权限和授权公司",
      );
    await db.$transaction(async (tx) => {
      const s = (await settings(tx, true))!;
      if (s.version !== original.version)
        throw new JushuitanError("设置已变更，请重新验证连接");
      await rows(
        tx,
        "UPDATE jushuitan_inventory_settings SET warehouses=$1::jsonb,verified_at=now(),error_note='' WHERE id=1 RETURNING id",
        JSON.stringify(warehouses),
      );
      await audit(
        tx,
        c,
        "JUSHUITAN_VERIFY",
        "jushuitan_inventory_settings",
        1,
        null,
        { warehouseCount: warehouses.length },
      );
    });
    return jushuitanStatus();
  } catch (error) {
    const note = safeError(error);
    await rows(
      db,
      "UPDATE jushuitan_inventory_settings SET error_note=$1,verified_at=NULL,enabled=false WHERE id=1 AND version=$2 RETURNING id",
      note,
      original.version,
    );
    fail("JST_VERIFY_FAILED", note, 422);
  }
}
async function enqueue(
  tx: Tx,
  s: Row,
  trigger: "MANUAL" | "SCHEDULED",
  actor?: string,
) {
  if (!s.credentials_encrypted || !s.verified_at || !s.warehouse_id)
    throw new JushuitanError("请先完成聚水潭授权验证并选择杭州总仓");
  const existing = await one(
    tx,
    "SELECT id,status FROM jushuitan_inventory_runs WHERE status IN ('QUEUED','RUNNING')",
  );
  if (existing) return existing;
  const job = (await one(
    tx,
    `INSERT INTO jushuitan_inventory_runs(id,settings_version,warehouse_id,warehouse_name,trigger_type,status,requested_by)
    VALUES($1::uuid,$2,$3::bigint,$4,$5,'QUEUED',$6::bigint) RETURNING id,status`,
    randomUUID(),
    s.version,
    s.warehouse_id,
    s.warehouse_name,
    trigger,
    actor ?? null,
  ))!;
  await rows(
    tx,
    "UPDATE jushuitan_inventory_settings SET next_sync_at=now()+interval '1 minute'*interval_minutes WHERE id=1 RETURNING id",
  );
  return job;
}
export async function queueJushuitan(c: Context) {
  requireManager(c);
  try {
    return await command(c, "inventory.jushuitan-sync", {}, async (tx) => {
      const s = (await settings(tx, true))!;
      const job = await enqueue(tx, s, "MANUAL", c.actor.id);
      await audit(
        tx,
        c,
        "JUSHUITAN_SYNC",
        "jushuitan_inventory_settings",
        1,
        null,
        { runId: job.id, warehouse: s.warehouse_name },
      );
      return job;
    });
  } catch (error) {
    if (error instanceof JushuitanError)
      fail("JST_NOT_READY", error.message, 422);
    throw error;
  }
}
export async function jushuitanSource(tx: Tx) {
  return one(
    tx,
    `SELECT s.warehouse_id,s.warehouse_name,s.company_id,s.available_rule,s.active_run_id,s.error_note,s.enabled,s.interval_minutes,
    r.started_at,r.finished_at,r.requested_count,r.received_count FROM jushuitan_inventory_settings s
    LEFT JOIN jushuitan_inventory_runs r ON r.id=s.active_run_id AND r.status='COMPLETE' WHERE s.id=1`,
  );
}
export async function runJushuitanTick() {
  const job = await db.$transaction(async (tx) => {
    const s = (await settings(tx, true))!;
    await rows(
      tx,
      "UPDATE jushuitan_inventory_runs SET status='FAILED',finished_at=now(),error_note='同步任务超时中断，请重新同步' WHERE status='RUNNING' AND started_at<now()-interval '15 minutes' RETURNING id",
    );
    if (
      s.enabled &&
      (!s.next_sync_at || new Date(s.next_sync_at).getTime() <= Date.now())
    )
      await enqueue(tx, s, "SCHEDULED");
    const queued = await one(
      tx,
      "SELECT * FROM jushuitan_inventory_runs WHERE status='QUEUED' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
    );
    if (!queued) return null;
    return one(
      tx,
      "UPDATE jushuitan_inventory_runs SET status='RUNNING',started_at=now() WHERE id=$1::uuid RETURNING *",
      queued.id,
    );
  });
  if (!job) return;
  try {
    const auth = await credentials(job.settings_version),
      s = (await settings())!;
    if (s.version !== job.settings_version)
      throw new JushuitanError("设置已变更，请重新同步");
    const warehouse = (await queryJushuitanWarehouses(auth.c)).find(
      (w) => w.wms_co_id === String(job.warehouse_id),
    );
    if (
      !warehouse ||
      warehouse.name !== job.warehouse_name ||
      warehouse.co_id !== String(s.company_id)
    )
      throw new JushuitanError("授权公司或仓库已变化，请重新验证并选择仓库");
    const codes = (await rows(db, "SELECT sku_code FROM skus ORDER BY id")).map(
      (r) => r.sku_code as string,
    );
    if (!codes.length)
      throw new JushuitanError("网站尚无商品编码，请先维护商品档案和 SKU");
    await rows(
      db,
      "UPDATE jushuitan_inventory_runs SET requested_count=$2 WHERE id=$1::uuid RETURNING id",
      job.id,
      codes.length,
    );
    const result: JushuitanStock[] = [];
    const checkDeadline = () => {
      if (Date.now() - new Date(job.started_at).getTime() > 10 * 60000)
        throw new JushuitanError("同步超过十分钟，本次数据未发布，请稍后重试");
    };
    for (let offset = 0; offset < codes.length; offset += 100) {
      checkDeadline();
      const current = (await settings())!;
      if (current.version !== job.settings_version)
        throw new JushuitanError("设置已变更，本次数据未发布");
      result.push(
        ...(await queryJushuitanStock(
          auth.c,
          String(job.warehouse_id),
          codes.slice(offset, offset + 100),
          s.available_rule,
        )),
      );
      await rows(
        db,
        "UPDATE jushuitan_inventory_runs SET processed_count=$2,received_count=$3 WHERE id=$1::uuid RETURNING id",
        job.id,
        Math.min(offset + 100, codes.length),
        result.length,
      );
      // Stay below one request per second across batches.
      if (offset + 100 < codes.length)
        await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    checkDeadline();
    if (!result.length)
      throw new JushuitanError(
        "未匹配到网站商品编码，请核对授权公司、仓库和完整商品编码；未覆盖上次库存",
      );
    const found = new Set(result.map((r) => r.sku_code)),
      missing = codes.filter((c) => !found.has(c));
    await db.$transaction(
      async (tx) => {
        const current = (await settings(tx, true))!;
        const running = await one(
          tx,
          "SELECT status FROM jushuitan_inventory_runs WHERE id=$1::uuid FOR UPDATE",
          job.id,
        );
        if (
          current.version !== job.settings_version ||
          running?.status !== "RUNNING"
        )
          throw new JushuitanError("同步配置或任务状态已变化，本次数据未发布");
        await rows(
          tx,
          `INSERT INTO jushuitan_inventory_snapshots
        SELECT $1::uuid,x.* FROM jsonb_to_recordset($2::jsonb) AS x(sku_code text,physical_qty bigint,reserved_qty bigint,damaged_qty bigint,
          in_transit_qty bigint,transfer_transit_qty bigint,incoming_qty bigint,return_qty bigint,virtual_qty bigint,available_qty bigint,source_modified text) RETURNING sku_code`,
          job.id,
          JSON.stringify(result),
        );
        await rows(
          tx,
          "UPDATE jushuitan_inventory_runs SET status='COMPLETE',finished_at=now(),missing_codes=$2::jsonb WHERE id=$1::uuid RETURNING id",
          job.id,
          JSON.stringify(missing.slice(0, 50)),
        );
        await rows(
          tx,
          "UPDATE jushuitan_inventory_settings SET active_run_id=$1::uuid,error_note='' WHERE id=1 RETURNING id",
          job.id,
        );
        // Keep five completed snapshots for inspection; inventory ledger is untouched.
        await rows(
          tx,
          `DELETE FROM jushuitan_inventory_snapshots WHERE run_id IN
        (SELECT id FROM jushuitan_inventory_runs WHERE status='COMPLETE' ORDER BY finished_at DESC OFFSET 5) AND run_id<>$1::uuid RETURNING run_id`,
          job.id,
        );
      },
      { timeout: 30000 },
    );
  } catch (error) {
    const needsVerification =
      error instanceof JushuitanError && error.needsVerification;
    const note =
      safeError(error) +
      (needsVerification ? "；定时同步已关闭，请处理后重新验证并开启" : "");
    await db.$transaction(async (tx) => {
      const current = (await settings(tx, true))!;
      const failed = await rows(
        tx,
        "UPDATE jushuitan_inventory_runs SET status='FAILED',finished_at=now(),error_note=$2 WHERE id=$1::uuid AND status='RUNNING' RETURNING id",
        job.id,
        note,
      );
      if (failed.length && current.version === job.settings_version)
        await rows(
          tx,
          `UPDATE jushuitan_inventory_settings SET error_note=$1,
          enabled=CASE WHEN $2 THEN false ELSE enabled END,
          verified_at=CASE WHEN $2 THEN NULL ELSE verified_at END WHERE id=1 RETURNING id`,
          note,
          needsVerification,
        );
    });
  }
}

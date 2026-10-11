import { z } from "zod";
import { HttpException } from "@nestjs/common";
import { camel, db, one, rows, type Tx, type Row } from "../../../../../packages/database/src/index.js";
import { selectionScope, selectionSchema } from "../../../../../packages/database/src/selection-scope.js";
import { selectionFields } from "../../../../../packages/contracts/src/selection-protection.js";
import { command, fail, id, parse, requirePermission, audit, type Context } from "../../core.js";
import { tableAccess } from "../projects/library.js";
import * as protection from "./protection.js";
import {
  previewProductArchiveOrderInTransaction,
  applyProductArchiveOrderInTransaction,
  type ArchiveOrderDatabase,
  type ArchiveOrderPlan,
} from "../../../../../scripts/rebuild-product-archive-order.js";

const applyInput = z.object({ archiveId: id, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

function adapter(tx: Tx): ArchiveOrderDatabase {
  return {
    async query<T extends Record<string, any>>(sql: string, parameters: unknown[] = []) {
      if (/^(SET LOCAL|LOCK TABLE)\b/.test(sql)) {
        await tx.$executeRawUnsafe(sql, ...parameters);
        return { rows: [] as T[] };
      }
      return { rows: await tx.$queryRawUnsafe<T[]>(sql, ...parameters) };
    },
  };
}

function fixedOrderFields(policy: protection.Policy) {
  // This operation changes only order/version/update metadata. Unlike business
  // writes, it need not authorize unregistered, unreferenced historical JSON
  // keys: the full raw row remains hashed and must be preserved exactly. Every
  // registered field (including blank/deleted ones) and rule reference still
  // participates in the usual privacy, region, claim and migration checks.
  return [...new Set([
    ...selectionFields,
    ...(policy.registeredFieldKeys || []).filter(key => key.startsWith("custom:")),
    ...policy.settings.regions.flatMap(region => region.columnKeys),
    ...policy.settings.autoHideRegions.flatMap(region => region.columnKeys),
  ])];
}

function assertFixedOrderFields(policy: protection.Policy, c: Context, record: Row, keys: string[]) {
  try {
    protection.assertFields(policy, c, record, keys);
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const code = (error.getResponse() as { error?: { code?: string } }).error?.code;
    if (code !== "REGION_FORBIDDEN" && code !== "MIGRATION_LOCKED") throw error;
    const row = camel(record);
    const style = protection.access(policy, c.actor, record, "xutiStyleNo") !== "deny"
      ? String(row.xutiStyleNo || "").trim().slice(0, 100) : "";
    const prefix = style ? `款号「${style}」：` : "";
    if (code === "MIGRATION_LOCKED")
      fail(code, prefix + "此行有跨表传送锁，请先释放原行编辑后重新预览；固定排序未建立", 409);
    const denied = keys.filter(key => protection.access(policy, c.actor, record, key) !== "edit");
    if (denied.some(key => key.startsWith("custom:") && !policy.registeredFieldKeys?.includes(key)))
      fail(code, prefix + "保护规则引用了未登记的历史字段，请管理员核查字段登记与保护规则后重新预览；固定排序未建立", 403);
    if (denied.some(key => Object.hasOwn(policy.privateFieldOwners || {}, key) && !protection.fieldVisible(policy, c.actor, key)))
      fail(code, prefix + "存在当前账号无权编辑的他人私有字段，请由有完整权限的用户处理；固定排序未建立", 403);
    if (policy.settings.claimsEnabled && row.claimedBy && String(row.claimedBy) !== c.actor.id && !protection.protectionAdmin(c.actor))
      fail(code, prefix + "此行已被其他用户认领，请先完成或释放认领后重新预览；固定排序未建立", 403);
    fail(code, prefix + "存在只读或隐藏的受保护区域，请管理员核查编辑权限后重新预览；固定排序未建立", 403);
  }
}

async function authorize(tx: Tx, c: Context, lock: boolean) {
  requirePermission(c.actor, "product.update");
  requirePermission(c.actor, "selection.manage");
  const scope = selectionScope.getStore();
  if (!scope) fail("INVALID_SCOPE", "固定排序仅适用于商品档案", 400);
  const table = await tableAccess(tx, c.actor, scope);
  if (table.system_key !== "PRODUCT_ARCHIVE") fail("INVALID_SCOPE", "固定排序仅适用于商品档案", 400);
  if (!table.can_edit) fail("FORBIDDEN", "没有商品档案表格编辑权限", 403);
  const schema = selectionSchema(scope);
  if (lock) {
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    await tx.$executeRawUnsafe(`LOCK TABLE public.products,"${schema}".style_selections IN SHARE ROW EXCLUSIVE MODE`);
  }
  const policy = lock ? await protection.writeLocks(tx, c) : await protection.policy(tx);
  const keys = fixedOrderFields(policy);
  const records = await rows(tx, `SELECT * FROM "${schema}".style_selections`);
  for (const record of records) assertFixedOrderFields(policy, c, record, keys);
  return scope;
}

function summary(plan: ArchiveOrderPlan) {
  const { orderedRows: _records, ...result } = plan;
  return result;
}

export async function previewFixedOrder(c: Context, input: unknown) {
  parse(z.object({}).strict(), input);
  return db.$transaction(async tx => {
    const scope = await authorize(tx, c, false);
    const plan = await previewProductArchiveOrderInTransaction(adapter(tx));
    if (plan.archiveId !== scope) fail("INVALID_SCOPE", "商品档案已变更，请刷新后重试", 409);
    return summary(plan);
  }, { isolationLevel: "RepeatableRead", timeout: 30000, maxWait: 15000 });
}

export async function applyFixedOrder(c: Context, input: unknown) {
  const body = parse(applyInput, input);
  requirePermission(c.actor, "product.update");
  requirePermission(c.actor, "selection.manage");
  return command(c, "style-selections/fixed-order", body, async tx => {
    const scope = await authorize(tx, c, true);
    if (body.archiveId !== scope) fail("INVALID_SCOPE", "商品档案已变更，请重新预览", 409);
    const database = adapter(tx);
    const expected = await previewProductArchiveOrderInTransaction(database);
    if (expected.archiveId !== scope || expected.digest !== body.digest)
      fail("VERSION_CONFLICT", "预览后商品档案发生变化，请重新预览后建立固定排序", 409);
    let backupId = "";
    try {
      const result = await applyProductArchiveOrderInTransaction(database, expected, async snapshot => {
        // Immutable audit storage is the durable backup. The backup and reorder
        // commit together; an audit/verification failure rolls back both.
        await audit(tx, c, "BACKUP_FIXED_ORDER", "product-archive-table", scope, snapshot, null,
          "建立固定排序前保存原行顺序、版本和创建时间快照，供管理员复核与恢复");
        const backup = await one(tx, "SELECT id::text FROM public.audit_logs WHERE request_id=$1 AND actor_id=$2::bigint AND action='BACKUP_FIXED_ORDER' AND selection_table_id=$3::bigint ORDER BY id DESC LIMIT 1",
          c.requestId, c.actor.id, scope);
        if (!backup) throw Error("Fixed-order backup was not saved");
        backupId = backup.id;
      }, { actorId: c.actor.id, reason: "用户确认按实际创建时间升序建立商品档案固定排序，同时间保留原顺序，空白尾行置后" });
      return { changedRows: result.changedRows, totalRows: result.after.totalRows,
        cutoffBoundary: result.after.cutoffBoundary, backupId, auditId: result.auditId };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (String((error as Error).message).includes("changed since preview"))
        fail("VERSION_CONFLICT", "预览后商品档案发生变化，请重新预览后建立固定排序", 409);
      fail("FIXED_ORDER_FAILED", "固定排序未完成，已保留原顺序，请重新预览或联系管理员", 500);
    }
  }, { timeout: 90000, maxWait: 15000 });
}

import { HttpException } from "@nestjs/common";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  db,
  insert,
  json,
  one,
  rows,
  Tx,
  Row,
} from "../../../packages/database/src/index.js";
import { z } from "zod";
export type Actor = {
  id: string;
  username: string;
  displayName: string;
  permissions: string[];
  roleCodes?: string[];
  roleNames?: string[];
  csrfToken?: string;
};
export type Context = { actor: Actor; requestId: string; key?: string };
export function fail(
  code: string,
  message: string,
  status = 409,
  details?: unknown,
): never {
  throw new HttpException({ error: { code, message, details } }, status);
}
export const id = z.string().regex(/^[1-9]\d{0,18}$/);
export const qty = z.number().int().min(0).max(10000000);
export const positive = qty.positive();
export const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
export const text = z.string().trim().min(1).max(255);
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success)
    fail("VALIDATION_ERROR", "请检查输入字段", 400, r.error.flatten());
  return r.data;
}
export function requirePermission(actor: Actor, permission: string) {
  if (!actor.permissions.includes(permission))
    fail("FORBIDDEN", "没有此操作权限", 403);
}
export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function passwordHash(value: string) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(value, salt, 64).toString("hex");
}
export function passwordMatches(value: string, encoded: string) {
  const [salt, key] = encoded.split(":");
  if (!salt || !key) return false;
  return timingSafeEqual(Buffer.from(key, "hex"), scryptSync(value, salt, 64));
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function audit(
  tx: Tx,
  c: Context,
  action: string,
  entityType: string,
  entityId: unknown,
  before: unknown,
  after: unknown,
  reason?: string,
) {
  await insert(tx, "audit_logs", {
    actorId: c.actor.id,
    actorLabel: c.actor.displayName,
    action,
    entityType,
    entityId,
    requestId: c.requestId,
    beforeData: before === null ? null : JSON.stringify(json(before)),
    afterData: after === null ? null : JSON.stringify(json(after)),
    reason,
  });
}
export async function command(
  c: Context,
  operation: string,
  input: unknown,
  fn: (tx: Tx) => Promise<any>,
) {
  if (!c.key || c.key.length > 128)
    fail("VALIDATION_ERROR", "缺少有效的 Idempotency-Key", 400);
  const fingerprint = hash(canonical(input));
  return db.$transaction(
    async (tx) => {
      // A transaction advisory lock serializes even the first request, before its result row exists.
      await rows(
        tx,
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
        `${c.actor.id}|${operation}|${c.key}`,
      );
      const old = await one(
        tx,
        "SELECT * FROM idempotency_records WHERE actor_id=$1::bigint AND operation=$2 AND idempotency_key=$3",
        c.actor.id,
        operation,
        c.key,
      );
      if (old) {
        if (old.request_hash !== fingerprint)
          fail("IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同内容");
        return old.response_body;
      }
      const result = json(await fn(tx));
      await insert(tx, "idempotency_records", {
        actorId: c.actor.id,
        operation,
        idempotencyKey: c.key,
        requestHash: fingerprint,
        responseStatus: 200,
        responseBody: JSON.stringify(result),
      });
      return result;
    },
    { timeout: 15000, maxWait: 15000 },
  );
}
export async function entity(
  tx: Tx,
  table: string,
  value: string,
  lock = false,
): Promise<Row> {
  const r = await one(
    tx,
    `SELECT * FROM ${table} WHERE id=$1::bigint${lock ? " FOR UPDATE" : ""}`,
    value,
  );
  if (!r) fail("NOT_FOUND", "记录不存在", 404);
  return r;
}
export function state(row: Row, allowed: string[]) {
  if (!allowed.includes(row.status))
    fail("INVALID_STATE", "当前状态不允许此操作");
}
export function version(row: Row, v: number) {
  if (row.version !== v) fail("VERSION_CONFLICT", "记录已更新，请刷新后核对");
}
export async function active(tx: Tx, table: string, value: string) {
  const r = await entity(tx, table, value);
  if (r.status !== "ACTIVE") fail("INVALID_STATE", "关联资料已停用");
  return r;
}
export function no(prefix: string) {
  return (
    prefix +
    new Date().toISOString().slice(0, 10).replaceAll("-", "") +
    "-" +
    randomBytes(6).toString("hex").toUpperCase()
  );
}
export function pagination(query: Record<string, any>) {
  return parse(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }),
    query,
  );
}

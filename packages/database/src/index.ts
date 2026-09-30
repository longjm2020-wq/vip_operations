import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { selectionScope, selectionSchema } from "./selection-scope.js";
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
// SET LOCAL is transaction-bound: pooled connections never retain a table scope.
async function scopedTransaction(fn: (tx: Tx) => Promise<any>, options?: any) {
  const scope = selectionScope.getStore();
  return client.$transaction(async (tx) => {
    if (scope)
      await tx.$executeRawUnsafe(
        `SET LOCAL search_path TO "${selectionSchema(scope)}", public`,
      );
    return fn(tx);
  }, options);
}
export const db = new Proxy(client, {
  get(target, property) {
    if (property === "$transaction")
      return (fn: any, options?: any) =>
        selectionScope.getStore()
          ? scopedTransaction(fn, options)
          : target.$transaction(fn, options);
    if (
      (property === "$queryRawUnsafe" || property === "$executeRawUnsafe") &&
      selectionScope.getStore()
    )
      return (...args: any[]) =>
        scopedTransaction((tx) => (tx[property] as any)(...args));
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
export type Tx = Prisma.TransactionClient;
// SQL identifiers are exclusively internal allowlists; all values use bind parameters.
export type Row = Record<string, any>;
export async function rows(
  tx: Tx,
  sql: string,
  ...values: unknown[]
): Promise<Row[]> {
  return tx.$queryRawUnsafe<Row[]>(
    sql,
    ...values.map((v) => (v instanceof Date ? v.toISOString() : v)),
  );
}
export async function one(
  tx: Tx,
  sql: string,
  ...values: unknown[]
): Promise<Row | undefined> {
  return (await rows(tx, sql, ...values))[0];
}
export function json(value: unknown): any {
  return JSON.parse(
    JSON.stringify(value, (_key, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  );
}
export const snake = (s: string) =>
  s
    .replace(/([a-z])([0-9])/g, "$1_$2")
    .replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
export function camel(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (Prisma.Decimal.isDecimal(value)) return value.toFixed(2);
  if (Array.isArray(value)) return value.map(camel);
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()),
      camel(v),
    ]),
  );
}
export async function insert(tx: Tx, table: string, data: Row): Promise<Row> {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  return (await one(
    tx,
    `INSERT INTO ${table} (${entries.map(([k]) => snake(k)).join(",")}) VALUES (${entries.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING *`,
    ...entries.map(([, v]) => v),
  ))!;
}
export async function update(
  tx: Tx,
  table: string,
  id: string,
  data: Row,
): Promise<Row> {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  return (await one(
    tx,
    `UPDATE ${table} SET ${entries.map(([k], i) => snake(k) + "=$" + (i + 2)).join(",")},updated_at=now() WHERE id=$1::bigint RETURNING *`,
    id,
    ...entries.map(([, v]) => v),
  ))!;
}

import { z } from "zod";
import {
  db,
  one,
  rows,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import {
  libraryKindSchema,
  visibilitySchema,
  type LibraryKind,
} from "../../../../../packages/contracts/src/project-library.js";
import {
  audit,
  command,
  fail,
  parse,
  requirePermission,
  version,
  type Actor,
  type Context,
} from "../../core.js";

export const libraryAdmin = (actor: Actor) =>
  actor.permissions.includes("user.manage") ||
  !!actor.roleCodes?.some((role) => role === "ADMIN" || role === "SUPER_ADMIN");
export const libraryConfig = {
  sop: {
    table: "project_sops",
    owner: "owner_id",
    read: "project.read",
    write: "sop.manage",
  },
  project: {
    table: "projects",
    owner: "owner_id",
    read: "project.read",
    write: "project.create",
  },
  table: {
    table: "project_tables",
    owner: "created_by",
    read: "project.read",
    write: "project.create",
  },
} as const;
export function canManageContent(actor: Actor, kind: LibraryKind, row: Row) {
  if (kind === "table" && row.system_key) return false;
  const config = libraryConfig[kind];
  return (
    actor.permissions.includes(config.write) &&
    (libraryAdmin(actor) || String(row[config.owner]) === actor.id)
  );
}
export function contentSummary(actor: Actor, kind: LibraryKind, row: Row) {
  return { ...row, can_manage: canManageContent(actor, kind, row) };
}
export function readableSql(kind: LibraryKind, alias: string) {
  const owner = `${alias}.${libraryConfig[kind].owner}`;
  const collaborator =
    kind === "table"
      ? `EXISTS(SELECT 1 FROM public.project_table_members m WHERE m.table_id=${alias}.id AND m.user_id=$2::bigint)`
      : kind === "project"
        ? `(${alias}.status<>'DRAFT' AND EXISTS(SELECT 1 FROM public.project_members m WHERE m.project_id=${alias}.id AND m.user_id=$2::bigint))`
        : "false";
  return `($1::boolean OR ${owner}=$2::bigint OR ${alias}.visibility='PUBLIC' OR ${collaborator})`;
}
// Used by the workspace interceptor both before the handler and inside each transaction.
export async function tableAccess(
  tx: Tx,
  actor: Actor | undefined,
  value: string,
) {
  const table = await one(
    tx,
    `SELECT t.* FROM public.project_tables t WHERE t.id=$3::bigint AND t.deleted_at IS NULL
     AND EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='selection_table_' || t.id::text)
     AND ($4::boolean OR (t.system_key='PRODUCT_ARCHIVE' AND $5::boolean) OR (t.system_key IS NULL AND ${readableSql("table", "t")})) FOR SHARE`,
    actor ? libraryAdmin(actor) : false,
    actor?.id || "0",
    value,
    !actor,
    !!actor?.permissions.includes("product.read"),
  );
  if (!table) fail("NOT_FOUND", "表格不存在或无权访问", 404);
  return table;
}
export async function trash(c: Context, rawKind: unknown) {
  const kind = parse(libraryKindSchema, rawKind),
    config = libraryConfig[kind];
  requirePermission(c.actor, config.read);
  requirePermission(c.actor, config.write);
  return rows(
    db,
    `SELECT t.id,t.name,t.visibility,t.version,t.deleted_at,
    t.deleted_at+interval '30 days' AS expires_at,u.display_name AS owner_name,
    d.display_name AS deleted_by_name FROM public.${config.table} t
    LEFT JOIN public.users u ON u.id=t.${config.owner}
    LEFT JOIN public.users d ON d.id=t.deleted_by
    WHERE t.deleted_at IS NOT NULL AND t.deleted_at>now()-interval '30 days'
    AND ($1::boolean OR t.${config.owner}=$2::bigint) ORDER BY t.deleted_at DESC,t.id DESC`,
    libraryAdmin(c.actor),
    c.actor.id,
  );
}
export async function changeContent(
  c: Context,
  rawKind: unknown,
  value: string,
  action: "visibility" | "delete" | "restore",
  input: unknown = {},
) {
  const kind = parse(libraryKindSchema, rawKind),
    config = libraryConfig[kind];
  requirePermission(c.actor, config.read);
  requirePermission(c.actor, config.write);
  const body = parse(
    z
      .object({
        version: z.number().int().positive().optional(),
        visibility: visibilitySchema.optional(),
      })
      .strict(),
    input,
  );
  if (action === "visibility" && !body.visibility)
    fail("VALIDATION_ERROR", "请选择公开范围", 400);
  // Recheck ownership even when a request is an idempotent retry.
  const old = await one(
    db,
    `SELECT * FROM public.${config.table} WHERE id=$1::bigint`,
    value,
  );
  if (!old) fail("NOT_FOUND", "内容不存在", 404);
  if (!canManageContent(c.actor, kind, old))
    fail("FORBIDDEN", "只有创建者或管理员可以管理此内容", 403);
  return command(c, `library/${kind}/${value}/${action}`, body, async (tx) => {
    const row = await one(
      tx,
      `SELECT *,deleted_at>now()-interval '30 days' AS recoverable FROM public.${config.table} WHERE id=$1::bigint FOR UPDATE`,
      value,
    );
    if (!row) fail("NOT_FOUND", "内容不存在", 404);
    if (!canManageContent(c.actor, kind, row))
      fail("FORBIDDEN", "只有创建者或管理员可以管理此内容", 403);
    if (body.version !== undefined) version(row, body.version);
    if (action === "restore") {
      if (!row.deleted_at) fail("INVALID_STATE", "内容已恢复，请刷新列表");
      if (!row.recoverable)
        fail("RECYCLE_EXPIRED", "已超过 30 天恢复期限，无法恢复", 410);
    } else if (row.deleted_at) fail("NOT_FOUND", "内容已移至回收站", 404);
    const set =
      action === "visibility"
        ? "visibility=$2"
        : action === "delete"
          ? "deleted_at=now(),deleted_by=$2::bigint"
          : "deleted_at=NULL,deleted_by=NULL";
    const result = await one(
      tx,
      `UPDATE public.${config.table} SET ${set},version=version+1${kind !== "table" ? ",updated_at=now()" : ""} WHERE id=$1::bigint
      RETURNING id,name,visibility,version,deleted_at,deleted_at+interval '30 days' AS expires_at`,
      value,
      ...(action === "restore"
        ? []
        : [action === "visibility" ? body.visibility : c.actor.id]),
    );
    await audit(
      tx,
      c,
      `LIBRARY_${action.toUpperCase()}`,
      kind,
      value,
      { name: row.name, visibility: row.visibility, deletedAt: row.deleted_at },
      result,
    );
    return result;
  });
}

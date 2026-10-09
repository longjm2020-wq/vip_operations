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
  libraryCollaboratorsSchema,
  type LibraryKind,
  type LibraryAccess,
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
  !!actor.roleCodes?.includes("SUPER_ADMIN");
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
  if (libraryAdmin(actor)) return true;
  if (kind === "table" && row.system_key) return false;
  const config = libraryConfig[kind];
  return String(row[config.owner]) === actor.id;
}
export function contentSummary(actor: Actor, kind: LibraryKind, row: Row): Row {
  const canManage = canManageContent(actor, kind, row);
  return { ...row, can_manage: canManage, can_edit: canManage || row.content_access === "EDIT" };
}
const memberSql = (kind: LibraryKind, alias: string) =>
  kind === "table"
    ? `EXISTS(SELECT 1 FROM public.project_table_members m WHERE m.table_id=${alias}.id AND m.user_id=$2::bigint)`
    : kind === "project"
      ? `(${alias}.status<>'DRAFT' AND EXISTS(SELECT 1 FROM public.project_members m WHERE m.project_id=${alias}.id AND m.user_id=$2::bigint))`
      : "false";
export function contentAccessSql(kind: LibraryKind, alias: string) {
  return `(CASE WHEN $1::boolean OR ${alias}.${libraryConfig[kind].owner}=$2::bigint THEN 'EDIT'
    WHEN EXISTS(SELECT 1 FROM public.project_library_acl a WHERE a.kind='${kind}' AND a.resource_id=${alias}.id AND a.user_id=$2::bigint AND a.access='DENY') THEN 'DENY'
    WHEN EXISTS(SELECT 1 FROM public.project_library_acl a WHERE a.kind='${kind}' AND a.resource_id=${alias}.id AND a.user_id=$2::bigint AND a.access='EDIT') THEN 'EDIT'
    WHEN EXISTS(SELECT 1 FROM public.project_library_acl a WHERE a.kind='${kind}' AND a.resource_id=${alias}.id AND a.user_id=$2::bigint AND a.access='READ') THEN 'READ'
    WHEN ${memberSql(kind,alias)} THEN 'EDIT'
    WHEN ${alias}.visibility='PUBLIC' THEN 'READ' ELSE 'DENY' END)`;
}
export function readableSql(kind: LibraryKind, alias: string) {
  return `${contentAccessSql(kind,alias)}<>'DENY'`;
}
export async function effectiveContentAccess(tx: Tx, actor: Actor, kind: LibraryKind, value: Row | string): Promise<LibraryAccess> {
  const row = typeof value === "string" ? await one(tx,`SELECT * FROM public.${libraryConfig[kind].table} WHERE id=$1::bigint AND deleted_at IS NULL`,value) : value;
  if (!row) return "DENY";
  if (libraryAdmin(actor) || String(row[libraryConfig[kind].owner])===actor.id) return "EDIT";
  const grant = await one(tx,"SELECT access FROM public.project_library_acl WHERE kind=$1 AND resource_id=$2::bigint AND user_id=$3::bigint",kind,row.id,actor.id);
  if (grant) return grant.access;
  if (kind==="table" && row.system_key==="PRODUCT_ARCHIVE" && actor.permissions.includes("product.read"))
    return actor.permissions.includes("product.update") ? "EDIT" : "READ";
  if (kind!=="sop") {
    const membership = await one(tx,kind==="table"
      ? "SELECT 1 FROM public.project_table_members WHERE table_id=$1::bigint AND user_id=$2::bigint"
      : "SELECT 1 FROM public.project_members WHERE project_id=$1::bigint AND user_id=$2::bigint",row.id,actor.id);
    if (membership && (kind==="table" || row.status!=="DRAFT")) return "EDIT";
  }
  return row.visibility==="PUBLIC" ? "READ" : "DENY";
}
// Used by the workspace interceptor both before the handler and inside each transaction.
export async function tableAccess(
  tx: Tx,
  actor: Actor | undefined,
  value: string,
): Promise<Row> {
  const table = await one(
    tx,
    `SELECT t.* FROM public.project_tables t WHERE t.id=$1::bigint AND t.deleted_at IS NULL
     AND EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='selection_table_' || t.id::text)
     FOR SHARE`,
    value,
  );
  if (!table) fail("NOT_FOUND", "表格不存在或无权访问", 404);
  if (!actor) return table;
  const contentAccess = await effectiveContentAccess(tx,actor,"table",table!);
  if (contentAccess==="DENY") fail("NOT_FOUND", "表格不存在或无权访问", 404);
  return contentSummary(actor,"table",{...table,content_access:contentAccess});
}
async function manageableResource(tx: Tx, c: Context, kind: LibraryKind, value: string, lock = false) {
  const row = await one(tx,`SELECT * FROM public.${libraryConfig[kind].table} WHERE id=$1::bigint AND deleted_at IS NULL${lock ? " FOR UPDATE" : ""}`,value);
  if (!row) fail("NOT_FOUND","内容不存在或已移至回收站",404);
  if (!canManageContent(c.actor,kind,row!)) fail("FORBIDDEN","只有创建者或超级管理员可以管理成员权限",403);
  return row!;
}
export async function collaborators(c: Context, rawKind: unknown, value: string) {
  const kind = parse(libraryKindSchema,rawKind);
  const resource = await manageableResource(db,c,kind,value);
  const users = await rows(db,
    `SELECT u.id,u.username,u.display_name AS "displayName",EXISTS(SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.code='SUPER_ADMIN') AS "superAdmin"
    FROM public.users u WHERE u.status='ACTIVE' ORDER BY u.display_name,u.id`);
  const ownerId = String(resource[libraryConfig[kind].owner]);
  const fixed = new Set([ownerId,...users.filter(user=>user.superAdmin).map(user=>String(user.id))]);
  const members = await rows(db,"SELECT user_id::text AS \"userId\",access FROM public.project_library_acl WHERE kind=$1 AND resource_id=$2::bigint ORDER BY user_id",kind,value);
  return {version:resource.version,ownerId,users,members:members.filter(member=>!fixed.has(member.userId))};
}
export async function saveCollaborators(c: Context, rawKind: unknown, value: string, input: unknown) {
  const kind = parse(libraryKindSchema,rawKind),body = parse(libraryCollaboratorsSchema,input);
  await manageableResource(db,c,kind,value);
  await command(c,`library/${kind}/${value}/collaborators`,body,async tx=>{
    const resource = await manageableResource(tx,c,kind,value,true);
    version(resource,body.version);
    const ownerId = String(resource[libraryConfig[kind].owner]);
    const fixed = await rows(tx,"SELECT DISTINCT ur.user_id FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id WHERE r.code='SUPER_ADMIN'");
    const fixedIds = new Set([ownerId,...fixed.map(user=>String(user.user_id))]);
    if (body.members.some(member=>fixedIds.has(member.userId)))
      fail("VALIDATION_ERROR","创建者和超级管理员始终拥有管理权限，不能设置普通覆盖权限",400);
    if (body.members.length) {
      const valid = await rows(tx,"SELECT id FROM public.users WHERE id=ANY($1::bigint[]) AND status='ACTIVE'",body.members.map(member=>member.userId));
      if (valid.length!==body.members.length) fail("VALIDATION_ERROR","协作用户不存在或已停用，请移除后重新选择",400);
    }
    const before = await rows(tx,"SELECT user_id,access FROM public.project_library_acl WHERE kind=$1 AND resource_id=$2::bigint",kind,value);
    await rows(tx,"DELETE FROM public.project_library_acl WHERE kind=$1 AND resource_id=$2::bigint",kind,value);
    if (body.members.length)
      await rows(tx,`INSERT INTO public.project_library_acl(kind,resource_id,user_id,access,created_by)
        SELECT $1,$2::bigint,(item->>'userId')::bigint,item->>'access',$4::bigint FROM jsonb_array_elements($3::jsonb) item`,kind,value,JSON.stringify(body.members),c.actor.id);
    const included = body.members.filter(member=>member.access!=="DENY").map(member=>member.userId);
    if (kind === "project" && included.length > 100)
      fail("VALIDATION_ERROR", "一个项目最多设置100位可访问的协作人员", 400);
    if (kind==="project") {
      await rows(tx,"DELETE FROM public.project_members WHERE project_id=$1::bigint",value);
      await rows(tx,`INSERT INTO public.project_members(project_id,user_id,added_by) SELECT $1::bigint,member,$3::bigint FROM unnest($2::bigint[]) member`,value,[ownerId,...included],c.actor.id);
      await rows(tx,"UPDATE public.projects SET document=jsonb_set(document,'{collaborators}',$2::jsonb),version=version+1,updated_at=now() WHERE id=$1::bigint",value,JSON.stringify(included));
    } else {
      if (kind==="table") {
        await rows(tx,"DELETE FROM public.project_table_members WHERE table_id=$1::bigint",value);
        if (included.length) await rows(tx,"INSERT INTO public.project_table_members(table_id,user_id) SELECT $1::bigint,member FROM unnest($2::bigint[]) member",value,included);
      }
      await rows(tx,`UPDATE public.${libraryConfig[kind].table} SET version=version+1${kind==="sop" ? ",updated_at=now()" : ""} WHERE id=$1::bigint`,value);
    }
    await audit(tx,c,"LIBRARY_COLLABORATORS_UPDATE",kind,value,before,body.members);
    return {ok:true};
  });
  // A retry must not return an old ACL snapshot after permissions changed.
  return collaborators(c,kind,value);
}
export async function trash(c: Context, rawKind: unknown) {
  const kind = parse(libraryKindSchema, rawKind),
    config = libraryConfig[kind];
  requirePermission(c.actor, config.read);
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
    fail("FORBIDDEN", "只有创建者或超级管理员可以管理此内容", 403);
  return command(c, `library/${kind}/${value}/${action}`, body, async (tx) => {
    const row = await one(
      tx,
      `SELECT *,deleted_at>now()-interval '30 days' AS recoverable FROM public.${config.table} WHERE id=$1::bigint FOR UPDATE`,
      value,
    );
    if (!row) fail("NOT_FOUND", "内容不存在", 404);
    if (!canManageContent(c.actor, kind, row))
      fail("FORBIDDEN", "只有创建者或超级管理员可以管理此内容", 403);
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

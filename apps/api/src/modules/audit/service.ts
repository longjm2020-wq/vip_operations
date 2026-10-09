import { db, rows, one, camel, type Row, type Tx } from "../../../../../packages/database/src/index.js";
import { selectionScope, selectionSchema } from "../../../../../packages/database/src/selection-scope.js";
import { pagination, requirePermission, canonical, type Actor, type Context } from "../../core.js";
import { canManageContent, effectiveContentAccess, libraryConfig } from "../projects/library.js";
import type { LibraryKind } from "../../../../../packages/contracts/src/project-library.js";
import { policy, project, fieldVisible, type Policy } from "../style-selections/protection.js";

const protectedTypes = ["style-selection","selection-collection","selection-collection-item","selection-protection"];
const selectionTypes = new Set([...protectedTypes,"selection-field","style-selection-image"]);
const omitted = Symbol("omitted-private-field");
const superAdmin = (actor: Actor) => !!actor.roleCodes?.includes("SUPER_ADMIN");

/** Redact identifiers and the whole definition/region when its name may reveal a field. */
function privateProjection(value: unknown, p: Policy, actor: Actor, removed: { value: boolean }): unknown {
  const hide = () => { removed.value = true; return omitted; };
  if (typeof value === "string")
    return value.startsWith("custom:") && !fieldVisible(p,actor,value) ? hide() : value;
  if (Array.isArray(value))
    return value.map(item=>privateProjection(item,p,actor,removed)).filter(item=>item!==omitted);
  if (!value || typeof value !== "object") return value;
  const input = value as Row;
  if ([input.fieldKey,input.key,input.source,input.target].some(key=>
    typeof key === "string" && key.startsWith("custom:") && !fieldVisible(p,actor,key))) return hide();
  if (Array.isArray(input.columnKeys) && input.columnKeys.some(key=>typeof key !== "string" || !fieldVisible(p,actor,key))) return hide();
  const output: Row = {};
  for (const [key,item] of Object.entries(input)) {
    if (key.startsWith("custom:") && !fieldVisible(p,actor,key)) { hide(); continue; }
    // Extra values without a registered definition have no trustworthy owner.
    if (key === "extraFields" && item && typeof item === "object") {
      const known = Object.fromEntries(Object.entries(item).filter(([field])=>{
        const visible = !!p.registeredFieldKeys?.includes(field) && fieldVisible(p,actor,field);
        if (!visible) removed.value = true;
        return visible;
      }));
      output[key] = privateProjection(known,p,actor,removed);
      continue;
    }
    const next = privateProjection(item,p,actor,removed);
    if (next !== omitted) output[key] = next;
  }
  return output;
}

function rowProjection(value: Row, p: Policy, actor: Actor, current: Row | undefined, removed: { value: boolean }): Row {
  const projected = project(p,actor,{...current,...value}),result: Row = {};
  for (const key of Object.keys(value)) {
    // Internal cell ownership is not displayed by the table either.
    if (key === "cellOwners") continue;
    if (!Object.hasOwn(projected,key)) { removed.value = true; continue; }
    result[key] = projected[key];
    if (canonical(result[key]) !== canonical(value[key])) removed.value = true;
  }
  return result;
}

async function imageVisible(tx: Tx, actor: Actor, p: Policy, imageId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(imageId)) return false;
  const candidates = await rows(tx,
    "SELECT * FROM style_selections WHERE images::text LIKE $1 OR label_images::text LIKE $1 OR extra_fields::text LIKE $1", "%"+imageId+"%");
  for (const raw of candidates) if (JSON.stringify(project(p,actor,raw)).includes(imageId)) return true;
  // A genuinely unlinked upload may only appear in its creator's history.
  if (!candidates.length) {
    const image = await one(tx,"SELECT created_by FROM style_selection_images WHERE id=$1::uuid",imageId);
    return String(image?.created_by) === actor.id;
  }
  return false;
}

async function selectionAudit(tx: Tx, actor: Actor, entries: Row[], workspace: string): Promise<Row[]> {
  const table = workspace === "default" ? undefined : await one(tx,"SELECT * FROM public.project_tables WHERE id=$1::bigint",workspace);
  let allowed = workspace === "default" ? actor.permissions.includes("selection.read") : false;
  let scopedActor = actor;
  if (table && !table.deleted_at) {
    const access = await effectiveContentAccess(tx,actor,"table",table);
    allowed = access !== "DENY";
    scopedActor = { ...actor, selectionWorkspaceScoped:true,
      permissions: [...actor.permissions.filter(value=>!["selection.read","selection.manage","selection.protect"].includes(value)),
        ...(allowed ? ["selection.read"] : []),...(access === "EDIT" ? ["selection.manage"] : []),
        ...(canManageContent(actor,"table",table) ? ["selection.protect"] : [])] };
  }
  const exists = workspace === "default" || await one(tx,"SELECT 1 FROM pg_namespace WHERE nspname=$1",selectionSchema(workspace));
  if (!allowed || !exists) return entries.map(entry=>({...entry,before_data:null,after_data:null,reason:null}));
  await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${workspace === "default" ? "public" : selectionSchema(workspace)}",public`);
  return selectionScope.run(workspace === "default" ? "" : workspace,async()=>{
    const p = await policy(tx), output: Row[] = [];
    for (const entry of entries) {
      const removed = { value:false };
      const current = entry.entity_type === "style-selection" && entry.entity_id
        ? camel(await one(tx,"SELECT * FROM style_selections WHERE id=$1::bigint",entry.entity_id)) : undefined;
      const snapshot = async (raw: unknown) => {
        const value = camel(raw),clean = privateProjection(value,p,scopedActor,removed);
        if (clean === omitted) return null;
        if (entry.entity_type === "style-selection" && clean && typeof clean === "object")
          return rowProjection(clean as Row,p,scopedActor,current,removed);
        if (entry.entity_type === "selection-collection-item" && clean && typeof clean === "object") {
          const item = clean as Row,source = item.selectionId ? camel(await one(tx,"SELECT * FROM style_selections WHERE id=$1::bigint",item.selectionId)) : undefined;
          for (const key of ["original","draft"]) if(item[key]) item[key] = rowProjection(item[key],p,scopedActor,source,removed);
        }
        if (entry.entity_type === "style-selection-image" && clean && typeof clean === "object") {
          const id = (clean as Row).id;
          if (typeof id === "string" && !await imageVisible(tx,scopedActor,p,id)) { removed.value = true; return null; }
        }
        return clean;
      };
      const before = await snapshot(entry.before_data),after = await snapshot(entry.after_data);
      const hiddenKeyInReason = typeof entry.reason === "string" && Object.keys(p.privateFieldOwners || {}).some(key=>
        !fieldVisible(p,scopedActor,key) && entry.reason.includes(key));
      output.push({...entry,before_data:before,after_data:after,reason:removed.value || hiddenKeyInReason ? null : entry.reason});
    }
    return output;
  });
}

export async function list(c: Context, query: Row) {
  requirePermission(c.actor,"audit.read");
  const page = pagination(query), values: unknown[] = [], where: string[] = [];
  if (!c.actor.roleCodes?.some(code=>code === "ADMIN" || code === "SUPER_ADMIN"))
    where.push("entity_type NOT IN ('style-selection','selection-collection','selection-collection-item','selection-protection')");
  for (const [key,column] of Object.entries({entityType:"entity_type",entityId:"entity_id",actorId:"actor_id",action:"action"}))
    if (query[key]) { values.push(query[key]); where.push(`${column}=$${values.length}${key.endsWith("Id") ? "::bigint" : ""}`); }
  const from = " FROM public.audit_logs"+(where.length ? " WHERE "+where.join(" AND ") : "");
  return db.$transaction(async tx=>{
    const data = await rows(tx,"SELECT *"+from+` ORDER BY id DESC LIMIT ${page.pageSize} OFFSET ${(page.page-1)*page.pageSize}`,...values);
    const total = (await one(tx,"SELECT count(*)::int AS n"+from,...values))!.n;
    if (superAdmin(c.actor)) return { data,...page,total };
    const groups = new Map<string,Row[]>(), projected = new Map<string,Row>();
    for (const entry of data) {
      const kind: LibraryKind | undefined = entry.entity_type === "project-table" || entry.entity_type === "table" ? "table"
        : ["sop","project"].includes(entry.entity_type) ? entry.entity_type : undefined;
      if (!kind) continue;
      const resource = entry.entity_id ? await one(tx,`SELECT * FROM public.${libraryConfig[kind].table} WHERE id=$1::bigint`,entry.entity_id) : undefined;
      if (!resource || resource.deleted_at || await effectiveContentAccess(tx,c.actor,kind,resource) === "DENY")
        projected.set(String(entry.id),{...entry,before_data:null,after_data:null,reason:null});
    }
    for (const entry of data) if(selectionTypes.has(entry.entity_type)) {
      const key = entry.selection_table_id ? String(entry.selection_table_id) : "default";
      groups.set(key,[...(groups.get(key) || []),entry]);
    }
    for (const [workspace,entries] of groups)
      for (const entry of await selectionAudit(tx,c.actor,entries,workspace)) projected.set(String(entry.id),entry);
    return { data:data.map(entry=>projected.get(String(entry.id)) || entry),...page,total };
  },{ isolationLevel:"RepeatableRead" });
}

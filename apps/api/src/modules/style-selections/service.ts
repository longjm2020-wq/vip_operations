import { selectionScope, selectionUrl } from "../../../../../packages/database/src/selection-scope.js";
import { selectionViewSchema } from "../../../../../packages/contracts/src/selection-view.js";
import { cellNumberFormatSchema } from "../../../../../packages/contracts/src/selection-format.js";
import { sortSelectionSizes } from "../../../../../packages/contracts/src/selection-sizes.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import * as protection from "./protection.js";
import { isArchive, mirrorArchiveRow } from "./archive.js";
import { insertImage, readStoredImage } from "./image-storage.js";
import { db, insert, one, rows, update, camel, type Row, type Tx } from "../../../../../packages/database/src/index.js";
import { setImmediate as yieldToRequests } from "node:timers/promises";
import {
  audit,
  command,
  entity,
  fail,
  money,
  pagination,
  parse,
  type Context,
} from "../../core.js";

const optionalText = (limit: number) => z.string().trim().max(limit).nullable().optional();
const rowColors = ["NONE", "ORANGE", "YELLOW", "GREEN", "BLUE", "PINK"] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "请输入 YYYY-MM-DD 日期");
const imageUrl = z
  .string()
  .max(1_500_000)
  .refine(
    (value) =>
      /^https?:\/\//i.test(value) ||
      /^\/api\/v1\/style-selections\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\?tableId=[1-9]\d*)?$/i.test(value) ||
      /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value),
    "图片仅支持 http(s) 网址或 JPG、PNG、WebP 文件",
  );
const image = z
  .object({
    id: z.string().min(1).max(100),
    url: imageUrl,
    color: z.string().trim().max(100).default(""),
  })
  .strict();
const labelImage = image.extend({ color: z.literal("").default("") });
const cellColors = z.record(z.string(), z.enum(rowColors).nullable());
const extraFields = z.record(z.string().max(100), z.string().max(100000).superRefine((value,ctx)=>{
  if(value.length<=2000)return;
  try{if(z.array(image).max(30).safeParse(JSON.parse(value)).success)return;}catch{}
  ctx.addIssue({code:"custom",message:"文本最多2000字，图片字段最多30张"});
}));
const presenceInput = z.object({ editingId: z.string().regex(/^[1-9]\d{0,18}$/).nullable().optional(), editingColumn: z.string().regex(/^[a-zA-Z][a-zA-Z0-9:_-]{0,99}$/).nullable().optional() }).strict();

export const styleSelectionInput = z
  .object({
    registrationBatch: date.nullable().optional(),
    images: z.array(image).default([]),
    labelImages: z.array(labelImage).default([]),
    cellColors: cellColors.default({}),
    cellNumberFormats: z.record(z.string().max(100), cellNumberFormatSchema.nullable()).default({}),
    cellTextColors: z.record(z.string().max(100), z.enum(["#262626", "#cf1322", "#d46b08", "#ad8b00", "#389e0d", "#0958d9", "#531dab", "#c41d7f", "#595959"]).nullable()).default({}),
    cellVerticalAlignments: z.record(z.string().max(100), z.enum(["top", "middle", "bottom"]).nullable()).default({}),
    cellAlignments: z.record(z.string().max(100), z.enum(["left", "center", "right"]).nullable()).default({}),
    extraFields: extraFields.default({}),
    xutiStyleNo: optionalText(64),
    supplierStyleNo: optionalText(64),
    supplierCode: optionalText(50),
    color: optionalText(100),
    sizeRange: optionalText(100),
    material: optionalText(2000),
    supplyPriceExclTax: money.nullable().optional(),
    vipPrice: money.nullable().optional(),
    livePrice: money.nullable().optional(),
    tagPrice: money.nullable().optional(),
    sortOrder: z.number().int().min(0).max(10_000_000).optional(),
    rowColor: z.enum(rowColors).default("NONE"),
  })
  .strict();

const updateInput = styleSelectionInput
  .partial()
  .extend({ expectedUpdatedAt: z.iso.datetime().optional() })
  .strict();

const selectColumns = `
  s.id,s.registration_batch::text,s.images,s.label_images,s.cell_colors,s.cell_alignments,s.cell_vertical_alignments,s.cell_text_colors,s.cell_number_formats,s.extra_fields,s.xuti_style_no,s.supplier_style_no,
  s.supplier_code,s.color,s.size_range,s.material,s.supply_price_excl_tax,
  s.selling_points,s.reorder_days,s.collection_inventory,s.vip_price,s.live_price,s.tag_price,s.row_color,s.sort_order,s.created_by,s.version,
  s.created_at,s.updated_at,s.cell_owners,s.claimed_by,s.updated_by,s.migration_locked,s.migration_target_workspace,s.migration_target_row_id,s.migrated_at,s.product_id,
  (SELECT display_name FROM users WHERE id=s.created_by) AS created_by_name,
  (SELECT username FROM users WHERE id=s.created_by) AS created_by_username,
  (SELECT display_name FROM users WHERE id=s.updated_by) AS updated_by_name,
  (SELECT username FROM users WHERE id=s.updated_by) AS updated_by_username`;
const source = " FROM style_selections s";

export async function uploadImage(c: Context, input: unknown) {
  const body = parse(z.object({ data: z.string().max(1_500_000) }).strict(), input);
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.data);
  if (!match) fail("VALIDATION_ERROR", "请选择 JPG、PNG 或 WebP 图片", 400);
  const bytes = Buffer.from(match![2], "base64");
  const type = match![1];
  const valid = type === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    : type === "image/jpeg" ? bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid || !bytes.length || bytes.length >= 500 * 1024) fail("VALIDATION_ERROR", "图片格式无效或未压缩至 500 KB 以下", 400);
  return command(c, "style-selections/image-upload", body, async (tx) => {
    const id = randomUUID();
    await insertImage(tx, id, type, bytes, c.actor.id);
    await audit(tx, c, "CREATE", "style-selection-image", null, null, { id, type, size: bytes.length });
    return { url: selectionUrl(`/api/v1/style-selections/images/${id}`) };
  });
}

export async function readImage(c: Context, value: string, metadataOnly = false) {
  const id = parse(z.string().uuid(), value);
  await protection.imageAccess(c, id);
  return readStoredImage(id, metadataOnly);
}

function tagValues(value: unknown) {
  return [
    ...new Set(
      String(value || "")
        .split("/")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
function normalizedTags(value: unknown) {
  return tagValues(value).join("/") || null;
}

const revisionSql = "SELECT md5(coalesce(string_agg(id::text || ':' || version::text || ':' || updated_at::text, ',' ORDER BY id), '')) AS revision FROM style_selections";
export async function revision(c: Context) { const p = await protection.policy(db); const value = await one(db, revisionSql); return { revision: protection.digest([selectionScope.getStore(),value!.revision,p.revision,c.actor.id,c.actor.permissions,c.actor.roleCodes]) }; }

function listSpec(query: Record<string, unknown>) {
  const values: unknown[] = [];
  const where: string[] = [];
  if (query.q) {
    values.push("%" + String(query.q).slice(0, 100) + "%");
    where.push(
      query.photoSearch === 'true' ? `(concat_ws(' ',s.xuti_style_no,s.supplier_style_no,s.supplier_code) ILIKE $${values.length})` : `(concat_ws(' ',s.registration_batch::text,s.xuti_style_no,s.supplier_style_no,s.supplier_code,s.color,s.size_range,s.material) ILIKE $${values.length})`,
    );
  }
  const clause = where.length ? " WHERE " + where.join(" AND ") : "";
  const sort = [
    "updatedAt",
    "createdAt",
    "registrationBatch",
    "xutiStyleNo",
    "supplierStyleNo",
    "supplierCode",
    "supplyPriceExclTax",
    "vipPrice",
    "livePrice",
    "tagPrice",
    "sortOrder",
  ].includes(String(query.sort))
    ? String(query.sort).replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())
    : "updated_at";
  const direction = String(query.direction).toLowerCase() === "asc" ? "ASC" : "DESC";
  return { values, clause, order: `s.${sort} ${direction} NULLS LAST,s.id DESC` };
}

const pendingSyncs = new Map<string, Promise<string>>();
export async function sync(c: Context, input: unknown) {
  const body = parse(z.object({ q: z.string().max(100).default(""), sort: z.string().max(40).default("createdAt"), direction: z.enum(["asc", "desc"]).default("asc"), known: z.record(z.string().regex(/^[1-9]\d{0,18}$/), z.string().regex(/^[a-f0-9]{32}$/)).refine(value => Object.keys(value).length <= 100000).default({}) }).strict(), input);
  // Permission scopes differ per actor. Only coalesce that actor's identical
  // in-flight reads; never reuse a completed snapshot after a write.
  const key = JSON.stringify([selectionScope.getStore(),c.actor,body]);
  const pending = pendingSyncs.get(key);
  if (pending) return pending;
  const { values, clause, order } = listSpec(body);
  // Index, changed rows and revision must describe one committed database snapshot.
  const request = db.$transaction(async tx => {
    const p = await protection.policy(tx);
    const rawRevision=(await one(tx,revisionSql))!.revision;
    const scopedRevision=protection.digest([selectionScope.getStore(),rawRevision,p.revision,c.actor.id,c.actor.permissions,c.actor.roleCodes]);
    if (protection.activePolicy(p)) {
      const sourceRows = await rows(tx, `SELECT ${selectColumns} ${source}`);
      const projected = protection.filtered(sourceRows.map(row => protection.project(p,c.actor,row)), body);
      const index = projected.map(row => ({id:String(row.id),token:protection.digest([row,c.actor.id,c.actor.permissions,c.actor.roleCodes])}));
      const tokens=new Map(index.map(item=>[item.id,item.token]));
      return {revision:scopedRevision,index,data:projected.filter(row=>body.known[String(row.id)]!==tokens.get(String(row.id)))};
    }
    const revision = scopedRevision;
    const index = await rows(tx, `SELECT s.id::text AS id,md5(s.version::text || ':' || s.updated_at::text || ':' || $${values.length+1}) AS token ${source}${clause} ORDER BY ${order}`, ...values,protection.digest([p.revision,c.actor.id,c.actor.permissions,c.actor.roleCodes]));
    const changed = index.filter(row => body.known[row.id] !== row.token).map(row => row.id);
    const data = changed.length ? await rows(tx, `SELECT ${selectColumns} ${source} WHERE s.id=ANY($1::bigint[])`, changed) : [];
    return { revision, index, data:data.map(row=>protection.project(p,c.actor,row)) };
  }, { isolationLevel: "RepeatableRead", timeout: 15000 }).then(async snapshot => {
    // Large first loads must not monopolize the event loop while converting
    // database values. Release the transaction before yielding/serialization.
    const data: Row[] = [];
    for (let offset = 0; offset < snapshot.data.length; offset += 100) {
      data.push(...camel(snapshot.data.slice(offset, offset + 100)));
      await yieldToRequests();
    }
    // Share conversion and JSON serialization as well as SQL among readers.
    // The per-request envelope is added by the controller after authorization.
    return JSON.stringify({ revision: snapshot.revision, index: snapshot.index, data });
  });
  if (pendingSyncs.size >= 100) return request;
  pendingSyncs.set(key, request);
  try { return await request; }
  finally { pendingSyncs.delete(key); }
}

export async function list(c: Context, query: Record<string, unknown>) {
  return db.$transaction(async tx=>{
  const policy = await protection.policy(tx);
  const p = pagination(query);
  if(protection.activePolicy(policy)) {
    const projected = protection.filtered((await rows(tx,`SELECT ${selectColumns} ${source}`)).map(row=>protection.project(policy,c.actor,row)),query);
    return {data:projected.slice((p.page-1)*p.pageSize,p.page*p.pageSize),total:projected.length,...p};
  }
  const { values, clause, order } = listSpec(query);
  const total = await one(tx, `SELECT count(*)::int AS n ${source}${clause}`, ...values);
  const data = await rows(
    tx,
    `SELECT ${selectColumns} ${source}${clause} ORDER BY ${order} LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
    ...values,
  );
  return { data:data.map(row=>protection.project(policy,c.actor,row)), total: total!.n, ...p };
  },{isolationLevel:"RepeatableRead",timeout:15000});
}

export async function styleCounts(c: Context) {
  const p=await protection.policy(db);
  if(protection.activePolicy(p)) {
    const counts=new Map<string,number>();
    for(const row of await rows(db,"SELECT * FROM style_selections")){const style=protection.project(p,c.actor,row).xutiStyleNo?.trim();if(style)counts.set(style,(counts.get(style)||0)+1);}
    return [...counts].map(([xutiStyleNo,count])=>({xutiStyleNo,count}));
  }
  return rows(db, `SELECT btrim(xuti_style_no) AS "xutiStyleNo",count(*)::int AS count
    FROM style_selections
    WHERE xuti_style_no IS NOT NULL AND btrim(xuti_style_no) <> ''
    GROUP BY btrim(xuti_style_no)`);
}

export async function presence(_c: Context) {
  return rows(
    db,
    `SELECT p.user_id,p.editing_id,p.editing_column,u.display_name,p.active_at
     FROM style_selection_presence p JOIN users u ON u.id=p.user_id
     WHERE p.active_at > now()-interval '45 seconds' ORDER BY p.active_at DESC`,
  );
}

export async function heartbeat(c: Context, input: unknown) {
  const body = parse(presenceInput, input);
  if (body.editingId) await entity(db, "style_selections", body.editingId);
  await rows(
    db,
    `INSERT INTO style_selection_presence(user_id,editing_id,editing_column,active_at)
     VALUES($1::bigint,$2::bigint,$3,now())
     ON CONFLICT(user_id) DO UPDATE SET editing_id=EXCLUDED.editing_id,editing_column=EXCLUDED.editing_column,active_at=EXCLUDED.active_at`,
    c.actor.id,
    body.editingId || null,
    body.editingId ? body.editingColumn || null : null,
  );
  return { ok: true };
}

function validateImageColors(images: unknown, colors: unknown) {
  const allowed = new Set(tagValues(colors));
  for (const item of Array.isArray(images) ? images : [])
    if (item?.color && !allowed.has(item.color))
      fail("VALIDATION_ERROR", "图片颜色必须来自颜色字段", 400);
}

export async function remove(c: Context, value: string) {
  const existing=await one(db,"SELECT * FROM style_selections WHERE id=$1::bigint",value);
  protection.assertFields(await protection.policy(db),c,existing || {id:value},protection.rowFields(existing || {}));
  return command(c, "style-selections/delete/" + value, {}, async (tx) => {
    const p=await protection.writeLocks(tx,c);
    const before = await entity(tx, "style_selections", value, true);
    protection.assertFields(p,c,before,protection.rowFields(before));
    if(before.product_id && await isArchive(tx)) fail("PRODUCT_IN_USE","商品档案保留商品与库存、采购的关联；请修改商品状态为停用或归档。仅空白草稿行可删除。",409);
    await rows(tx, "DELETE FROM style_selections WHERE id=$1::bigint", value);
    await audit(tx, c, "DELETE", "style-selection", value, before, null);
    return { id: value };
  });
}

export async function write(c: Context, input: unknown, value?: string) {
  const parsed = parse<Row>(value ? updateInput : styleSelectionInput, input);
  // A PATCH must not reset omitted JSON fields through schema defaults.
  const body = value ? Object.fromEntries(Object.entries(parsed).filter(([key]) => Object.prototype.hasOwnProperty.call(input, key))) : parsed;
  if (value && !Object.keys(body).some((key) => key !== "expectedUpdatedAt"))
    fail("VALIDATION_ERROR", "没有可更新字段", 400);
  await protection.preflight(c,value,body);
  const result=await command(c, "style-selections/" + (value || "create"), body, async (tx) => {
    return persist(tx, c, body, value);
  });
  return protection.detail(c,String(result.id));
}


export async function persist(tx: Tx, c: Context, body: Row, value?: string) {
    if(await isArchive(tx)) await rows(tx,"SELECT pg_advisory_xact_lock(91002)::text");
    const policy=await protection.writeLocks(tx,c);
    const before = value ? await entity(tx, "style_selections", value, true) : null;
    if (
      before &&
      body.expectedUpdatedAt &&
      new Date(before.updated_at).toISOString() !== body.expectedUpdatedAt
    )
      fail("EDIT_CONFLICT", "记录已被其他人修改，请刷新后核对", 409);
    const changes = { ...body };
    delete changes.expectedUpdatedAt;
    for(const key of ["extraFields","cellColors","cellAlignments","cellVerticalAlignments","cellTextColors","cellNumberFormats"])if(key in changes){const stored=camel(before || {})[key] || {};const merged={...stored,...changes[key]};for(const field of Object.keys(merged))if(merged[field]===null)delete merged[field];changes[key]=merged;}
    if ("color" in changes) changes.color = normalizedTags(changes.color);
    if ("sizeRange" in changes) changes.sizeRange = sortSelectionSizes(changes.sizeRange) || null;
    const security=await protection.assertWrite(tx,c,before,changes,policy);
    validateImageColors(changes.images ?? before?.images ?? [], changes.color ?? before?.color);
    for (const key of ["images", "labelImages", "cellColors", "cellAlignments", "cellVerticalAlignments", "cellTextColors", "cellNumberFormats", "extraFields"])
      if (key in changes) changes[key] = JSON.stringify(changes[key]);
    if (!before && changes.sortOrder === undefined) {
      const last = await one(tx, "SELECT coalesce(max(sort_order),0)::int AS value FROM style_selections");
      changes.sortOrder = last!.value + 1;
    }
    const result = before
      ? await update(tx, "style_selections", value!, { ...changes, ...security, updatedBy:c.actor.id, version: before.version + 1 })
      : await insert(tx, "style_selections", { ...changes, ...security, updatedBy:c.actor.id, createdBy: c.actor.id });
    await mirrorArchiveRow(tx,c,result);
    await audit(tx, c, before ? "UPDATE" : "CREATE", "style-selection", result.id, before, result);
    // Keep date-only fields identical to list responses (rather than ISO timestamps).
    return (await one(tx, `SELECT ${selectColumns} ${source} WHERE s.id=$1::bigint`, result.id))!;
}

const importValues = styleSelectionInput.pick({ registrationBatch: true, images: true, labelImages: true, xutiStyleNo: true,
  supplierStyleNo: true, supplierCode: true, color: true, sizeRange: true, material: true,
  supplyPriceExclTax: true, vipPrice: true, livePrice: true, tagPrice: true }).partial()
  .extend({ xutiStyleNo: z.string().trim().min(1).max(64) }).strict();
const importPlan = z.object({ values: importValues, id: z.string().regex(/^[1-9]\d*$/).nullable(), expectedUpdatedAt: z.iso.datetime().nullable() }).strict();
function importPatch(input: Row): Row {
  const parsed = parse<Row>(importValues, input);
  // Zod defaults must not clear omitted fields in a partial workbook update.
  return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => key in input && value !== null && value !== "" && value !== undefined && !(Array.isArray(value) && !value.length)));
}
function distinctStyles(values: Row[]) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.xutiStyleNo)) fail("VALIDATION_ERROR", `款号「${value.xutiStyleNo}」在文件中重复`, 400);
    seen.add(value.xutiStyleNo);
    if (value.registrationBatch && (!Number.isFinite(Date.parse(value.registrationBatch)) || new Date(value.registrationBatch).toISOString().slice(0, 10) !== value.registrationBatch)) fail("VALIDATION_ERROR", "登记批次日期无效", 400);
  }
}
async function findImportMatch(tx: Tx, values: Row) {
  const matches = await rows(tx, "SELECT * FROM style_selections WHERE btrim(xuti_style_no)=$1", values.xutiStyleNo);
  if (matches.length > 1) fail("VALIDATION_ERROR", `系统中款号「${values.xutiStyleNo}」有多条记录，请先核对`, 400);
  const before = matches[0];
  validateImageColors(values.images ?? before?.images ?? [], values.color ?? before?.color);
  return before;
}
export async function previewImport(c: Context, input: unknown) {
  const body = parse(z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(500) }).strict(), input);
  const values = body.rows.map(importPatch); distinctStyles(values);
  const plan = [];
  for (const value of values) {
    const before = await findImportMatch(db, value);
    if(before)protection.assertFields(await protection.policy(db),c,before,["xutiStyleNo"],false);
    await protection.preflight(c,before?String(before.id):undefined,value);
    plan.push({ values: value, id: before ? String(before.id) : null, expectedUpdatedAt: before ? new Date(before.updated_at).toISOString() : null });
  }
  return { rows: plan, created: plan.filter(row => !row.id).length, updated: plan.filter(row => row.id).length };
}
export async function commitImport(c: Context, input: unknown) {
  const body = parse(z.object({ rows: z.array(importPlan).min(1).max(500) }).strict(), input);
  const patches = body.rows.map(row => importPatch(row.values)); distinctStyles(patches);
  for(const [index,patch] of patches.entries())await protection.preflight(c,body.rows[index].id || undefined,patch);
  return command(c, "style-selections/import", body, async tx => {
    if(await isArchive(tx))await rows(tx,"SELECT pg_advisory_xact_lock(91002)::text");
    await protection.writeLocks(tx,c);
    // Matching and writes must be atomic, including concurrently created styles.
    await tx.$executeRawUnsafe("LOCK TABLE style_selections IN SHARE ROW EXCLUSIVE MODE");
    let created = 0, updated = 0;
    for (const [index, values] of patches.entries()) {
      const planned = body.rows[index], before = await findImportMatch(tx, values);
      if ((before ? String(before.id) : null) !== planned.id || (before ? new Date(before.updated_at).toISOString() : null) !== planned.expectedUpdatedAt)
        fail("EDIT_CONFLICT", `款号「${values.xutiStyleNo}」在预览后已变更，请重新导入核对；整批未写入`, 409);
      await persist(tx, c, values, before ? String(before.id) : undefined);
      if (before) updated++; else created++;
    }
    return { created, updated };
  });
}

export async function sharedView(c: Context) {
  if(protection.activePolicy(await protection.policy(db)) && !protection.protectionAdmin(c.actor))return {view:{filters:{},sort:null},revision:0};
  return one(db, "SELECT view,revision FROM style_selection_shared_view WHERE id=1");
}
export async function saveSharedView(c: Context, input: unknown) {
  if(protection.activePolicy(await protection.policy(db)) && !protection.protectionAdmin(c.actor))fail("FORBIDDEN","保护开启时，请使用个人筛选；共享筛选由管理员设置",403);
  const body = parse(z.object({ view: selectionViewSchema, revision: z.number().int().min(0) }).strict(), input);
  return command(c, "selection.shared-view", body, async tx => {
    const before = await one(tx, "SELECT view,revision FROM style_selection_shared_view WHERE id=1 FOR UPDATE");
    if (!before || before.revision !== body.revision) fail("CONFLICT", "共享筛选已被其他人更新，请关闭面板后重新打开", 409);
    const saved = await one(tx, "UPDATE style_selection_shared_view SET view=$1::jsonb,revision=revision+1,updated_by=$2::bigint,updated_at=now() WHERE id=1 RETURNING view,revision", JSON.stringify(body.view), c.actor.id);
    await audit(tx, c, "SELECTION_SHARED_VIEW_UPDATE", "style_selection_shared_view", "1", before, saved);
    return saved;
  });
}

export async function photoDetail(c: Context,value: string) {
  return protection.detail(c,value);
}
/** Reuse the first content-free row in manual order, creating one only when none exists. */
export async function nextBlankPhotoStyle(c: Context) {
  const result=await command(c, "style-selections/photo-next-blank", {}, async (tx) => {
    if(await isArchive(tx))await rows(tx,"SELECT pg_advisory_xact_lock(91002)::text");
    const p=await protection.writeLocks(tx,c);
    await tx.$executeRawUnsafe("LOCK TABLE style_selections IN SHARE ROW EXCLUSIVE MODE");
    const blank = await one(tx, `SELECT ${selectColumns} ${source}
      WHERE s.registration_batch IS NULL
        AND (s.images IS NULL OR s.images = '[]'::jsonb)
        AND (s.label_images IS NULL OR s.label_images = '[]'::jsonb)
        AND nullif(btrim(s.xuti_style_no), '') IS NULL
        AND nullif(btrim(s.supplier_style_no), '') IS NULL
        AND nullif(btrim(s.supplier_code), '') IS NULL
        AND nullif(btrim(s.color), '') IS NULL
        AND nullif(btrim(s.size_range), '') IS NULL
        AND nullif(btrim(s.material), '') IS NULL
        AND s.supply_price_excl_tax IS NULL AND s.vip_price IS NULL
        AND s.live_price IS NULL AND s.tag_price IS NULL
        AND nullif(btrim(s.selling_points), '') IS NULL
        AND s.reorder_days IS NULL
        AND (s.collection_inventory IS NULL OR s.collection_inventory = '[]'::jsonb)
        AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(s.extra_fields) AS field WHERE btrim(field.value) <> '')
      ORDER BY s.sort_order ASC,s.id DESC LIMIT 1`);
    if(blank)protection.assertFields(p,c,blank,protection.rowFields(blank));
    return blank || persist(tx, c, {}, undefined);
  });
  const row=await protection.detail(c,String(result.id));
  protection.assertFields(await protection.policy(db),c,row,protection.rowFields(row));
  return row;
}
export async function nextPhotoStyle(c:Context,value: string, query: unknown) {
  const policy=await protection.policy(db);
  if(protection.activePolicy(policy)){
    const data=protection.filtered((await rows(db,`SELECT ${selectColumns} ${source}`)).map(row=>protection.project(policy,c.actor,row)),{q:String(query || ""),photoSearch:"true",sort:"sortOrder",direction:"asc"});
    const current=await protection.detail(c,value);
    return data.find(row=>Number(row.sortOrder)>Number(current.sortOrder) || Number(row.sortOrder)===Number(current.sortOrder) && BigInt(row.id)<BigInt(value)) || null;
  }
  const current = await entity(db, "style_selections", value);
  const q = String(query || "").trim().slice(0, 100);
  const result=await one(db, `SELECT ${selectColumns} ${source}
    WHERE (s.sort_order>$1 OR (s.sort_order=$1 AND s.id<$2::bigint))
    AND ($3='' OR concat_ws(' ',s.xuti_style_no,s.supplier_style_no,s.supplier_code) ILIKE $4)
    ORDER BY s.sort_order ASC,s.id DESC LIMIT 1`, current.sort_order, value, q, "%"+q+"%");
  return result?protection.project(policy,c.actor,result):null;
}
/** Granular image operations merge under the row lock instead of replacing a stale array. */
export async function changePhoto(c: Context, value: string, input: unknown) {
  const body = parse(z.discriminatedUnion("action", [
    z.object({ action: z.literal("add"), field: z.union([z.enum(["images", "labelImages"]),z.string().regex(/^custom:[a-zA-Z0-9:-]+$/).max(100)]).default("images"), image }).strict(),
    z.object({ action: z.literal("remove"), field: z.union([z.enum(["images", "labelImages"]),z.string().regex(/^custom:[a-zA-Z0-9:-]+$/).max(100)]).default("images"), imageId: z.string().min(1).max(100) }).strict(),
  ]), input);
  protection.assertFields(await protection.policy(db),c,await entity(db,"style_selections",value),[body.field]);
  const result=await command(c, "selection.photo/"+value, body, async tx => {
    if(await isArchive(tx))await rows(tx,"SELECT pg_advisory_xact_lock(91002)::text");
    await protection.writeLocks(tx,c);
    const before = await entity(tx, "style_selections", value, true);
    const field = body.field;
    const custom=field.startsWith("custom:");
    const storedField = field === "labelImages" ? "label_images" : "images";
    let images = Array.isArray(before[storedField]) ? before[storedField] : [];
    if(custom){try{images=parse(z.array(image).max(30),JSON.parse(before.extra_fields?.[field] || "[]"));}catch{fail("INVALID_FIELD","该字段包含非图片内容，不能覆盖",400);}}
    if (body.action === "add") {
      if (field === "images") { parse(image.extend({ color: z.string().trim().min(1).max(100) }), body.image); validateImageColors([body.image], before.color); }
      else if(!custom)parse(labelImage, body.image);
      const existing = images.find((item: Row) => item.id === body.image.id);
      if (existing && (existing.url !== body.image.url || existing.color !== body.image.color)) fail("EDIT_CONFLICT", "图片标识已被使用，请重新上传", 409);
      if (!existing) images = [...images, body.image];
    } else images = images.filter((item: Row) => item.id !== body.imageId);
    if(custom){parse(z.array(image).max(30),images);return persist(tx,c,{extraFields:{...(before.extra_fields || {}),[field]:JSON.stringify(images)}},value);}
    return persist(tx, c, { [field]: images }, value);
  });
  return protection.detail(c,String(result.id));
}

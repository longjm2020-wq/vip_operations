import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db, insert, one, rows, update, type Row, type Tx } from "../../../../../packages/database/src/index.js";
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
      /^\/api\/v1\/style-selections\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
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
const cellColors = z.record(z.string(), z.enum(rowColors));
const extraFields = z.record(z.string().max(100), z.string().max(2000));
const presenceInput = z.object({ editingId: z.string().regex(/^[1-9]\d{0,18}$/).nullable().optional() }).strict();

export const styleSelectionInput = z
  .object({
    registrationBatch: date.nullable().optional(),
    images: z.array(image).default([]),
    cellColors: cellColors.default({}),
    cellAlignments: z.record(z.string().max(100), z.enum(["left", "center", "right"])).default({}),
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
  s.id,s.registration_batch::text,s.images,s.cell_colors,s.cell_alignments,s.extra_fields,s.xuti_style_no,s.supplier_style_no,
  s.supplier_code,s.color,s.size_range,s.material,s.supply_price_excl_tax,
  s.vip_price,s.live_price,s.tag_price,s.row_color,s.sort_order,s.created_by,s.version,
  s.created_at,s.updated_at`;
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
  if (!valid || !bytes.length || bytes.length >= 1024 * 1024) fail("VALIDATION_ERROR", "图片格式无效或未压缩至 1 MB 以下", 400);
  return command(c, "style-selections/image-upload", body, async (tx) => {
    const id = randomUUID();
    await rows(tx, "INSERT INTO style_selection_images(id,content_type,content,created_by) VALUES($1::uuid,$2,$3,$4::bigint)", id, type, bytes, c.actor.id);
    await audit(tx, c, "CREATE", "style-selection-image", null, null, { id, type, size: bytes.length });
    return { url: `/api/v1/style-selections/images/${id}` };
  });
}

export async function readImage(value: string) {
  const id = parse(z.string().uuid(), value);
  const file = await one(db, "SELECT content_type,content FROM style_selection_images WHERE id=$1::uuid", id);
  if (!file) fail("NOT_FOUND", "图片不存在", 404);
  return file!;
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

export async function list(query: Record<string, unknown>) {
  const p = pagination(query);
  const values: unknown[] = [];
  const where: string[] = [];
  if (query.q) {
    values.push("%" + String(query.q).slice(0, 100) + "%");
    where.push(
      `(concat_ws(' ',s.registration_batch::text,s.xuti_style_no,s.supplier_style_no,s.supplier_code,s.color,s.size_range,s.material) ILIKE $${values.length})`,
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
  const total = await one(db, `SELECT count(*)::int AS n ${source}${clause}`, ...values);
  const data = await rows(
    db,
    `SELECT ${selectColumns} ${source}${clause} ORDER BY s.${sort} ${direction} NULLS LAST,s.id DESC LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
    ...values,
  );
  return { data, total: total!.n, ...p };
}

export async function presence(_c: Context) {
  return rows(
    db,
    `SELECT p.user_id,p.editing_id,u.display_name,p.active_at
     FROM style_selection_presence p JOIN users u ON u.id=p.user_id
     WHERE p.active_at > now()-interval '45 seconds' ORDER BY p.active_at DESC`,
  );
}

export async function heartbeat(c: Context, input: unknown) {
  const body = parse(presenceInput, input);
  if (body.editingId) await entity(db, "style_selections", body.editingId);
  await rows(
    db,
    `INSERT INTO style_selection_presence(user_id,editing_id,active_at)
     VALUES($1::bigint,$2::bigint,now())
     ON CONFLICT(user_id) DO UPDATE SET editing_id=EXCLUDED.editing_id,active_at=EXCLUDED.active_at`,
    c.actor.id,
    body.editingId || null,
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
  return command(c, "style-selections/delete/" + value, {}, async (tx) => {
    const before = await entity(tx, "style_selections", value, true);
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
  return command(c, "style-selections/" + (value || "create"), body, async (tx) => {
    return persist(tx, c, body, value);
  });
}


async function persist(tx: Tx, c: Context, body: Row, value?: string) {
    const before = value ? await entity(tx, "style_selections", value, true) : null;
    if (
      before &&
      body.expectedUpdatedAt &&
      new Date(before.updated_at).toISOString() !== body.expectedUpdatedAt
    )
      fail("EDIT_CONFLICT", "记录已被其他人修改，请刷新后核对", 409);
    const changes = { ...body };
    delete changes.expectedUpdatedAt;
    if ("color" in changes) changes.color = normalizedTags(changes.color);
    if ("sizeRange" in changes) changes.sizeRange = normalizedTags(changes.sizeRange);
    validateImageColors(changes.images ?? before?.images ?? [], changes.color ?? before?.color);
    for (const key of ["images", "cellColors", "cellAlignments", "extraFields"])
      if (key in changes) changes[key] = JSON.stringify(changes[key]);
    if (!before && changes.sortOrder === undefined) {
      const last = await one(tx, "SELECT coalesce(max(sort_order),0)::int AS value FROM style_selections");
      changes.sortOrder = last!.value + 1;
    }
    const result = before
      ? await update(tx, "style_selections", value!, { ...changes, version: before.version + 1 })
      : await insert(tx, "style_selections", { ...changes, createdBy: c.actor.id });
    await audit(tx, c, before ? "UPDATE" : "CREATE", "style-selection", result.id, before, result);
    // Keep date-only fields identical to list responses (rather than ISO timestamps).
    return (await one(tx, `SELECT ${selectColumns} ${source} WHERE s.id=$1::bigint`, result.id))!;
}

const importValues = styleSelectionInput.pick({ registrationBatch: true, images: true, xutiStyleNo: true,
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
export async function previewImport(input: unknown) {
  const body = parse(z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(500) }).strict(), input);
  const values = body.rows.map(importPatch); distinctStyles(values);
  const plan = [];
  for (const value of values) {
    const before = await findImportMatch(db, value);
    plan.push({ values: value, id: before ? String(before.id) : null, expectedUpdatedAt: before ? new Date(before.updated_at).toISOString() : null });
  }
  return { rows: plan, created: plan.filter(row => !row.id).length, updated: plan.filter(row => row.id).length };
}
export async function commitImport(c: Context, input: unknown) {
  const body = parse(z.object({ rows: z.array(importPlan).min(1).max(500) }).strict(), input);
  const patches = body.rows.map(row => importPatch(row.values)); distinctStyles(patches);
  return command(c, "style-selections/import", body, async tx => {
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

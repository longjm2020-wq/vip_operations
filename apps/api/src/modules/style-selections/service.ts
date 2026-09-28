import { z } from "zod";
import { db, insert, one, rows, update, type Row } from "../../../../../packages/database/src/index.js";
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
const optionalUrl = z.string().url("请输入有效图片网址").max(2000).nullable().optional();

export const styleSelectionInput = z
  .object({
    registrationBatch: optionalText(100),
    imageUrl: optionalUrl,
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
    rowColor: z.enum(rowColors).default("NONE"),
  })
  .strict();

const updateInput = styleSelectionInput
  .partial()
  .extend({ expectedUpdatedAt: z.iso.datetime().optional() })
  .strict();

const selectColumns = `
  s.id,s.registration_batch,s.image_url,s.xuti_style_no,s.supplier_style_no,
  s.supplier_code,s.color,s.size_range,s.material,s.supply_price_excl_tax,
  s.vip_price,s.live_price,s.tag_price,s.row_color,s.created_by,s.version,
  s.created_at,s.updated_at`;
const source = " FROM style_selections s";

export async function list(query: Record<string, unknown>) {
  const p = pagination(query);
  const values: unknown[] = [];
  const where: string[] = [];
  if (query.q) {
    values.push("%" + String(query.q).slice(0, 100) + "%");
    where.push(
      `(concat_ws(' ',s.registration_batch,s.xuti_style_no,s.supplier_style_no,s.supplier_code,s.color,s.size_range,s.material) ILIKE $${values.length})`,
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

export async function write(c: Context, input: unknown, value?: string) {
  const body = parse<Row>(value ? updateInput : styleSelectionInput, input);
  if (value && !Object.keys(body).some((key) => key !== "expectedUpdatedAt"))
    fail("VALIDATION_ERROR", "没有可更新字段", 400);
  return command(c, "style-selections/" + (value || "create"), body, async (tx) => {
    const before = value ? await entity(tx, "style_selections", value, true) : null;
    if (
      before &&
      body.expectedUpdatedAt &&
      new Date(before.updated_at).toISOString() !== body.expectedUpdatedAt
    )
      fail("EDIT_CONFLICT", "记录已被其他人修改，请刷新后核对", 409);
    const changes = { ...body };
    delete changes.expectedUpdatedAt;
    const result = before
      ? await update(tx, "style_selections", value!, { ...changes, version: before.version + 1 })
      : await insert(tx, "style_selections", { ...changes, createdBy: c.actor.id });
    await audit(tx, c, before ? "UPDATE" : "CREATE", "style-selection", result.id, before, result);
    return result;
  });
}
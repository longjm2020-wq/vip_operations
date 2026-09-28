import { z } from "zod";
import { db, insert, one, rows, update, type Row, type Tx } from "../../../../../packages/database/src/index.js";
import {
  active,
  audit,
  command,
  entity,
  fail,
  id,
  money,
  pagination,
  parse,
  text,
  type Context,
} from "../../core.js";

const optionalText = (limit: number) => z.string().trim().max(limit).nullable().optional();
const selectionStatuses = ["PENDING", "SELECTED", "REVIEW", "REJECTED"] as const;
const rowColors = ["NONE", "ORANGE", "YELLOW", "GREEN", "BLUE", "PINK"] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "请输入 YYYY-MM-DD 日期");

export const styleSelectionInput = z
  .object({
    styleNo: text.max(64),
    name: text,
    categoryId: id.nullable().optional(),
    supplierId: id.nullable().optional(),
    sourceUrl: z.string().url("请输入有效网址").max(2000).nullable().optional(),
    selectionStatus: z.enum(selectionStatuses).default("PENDING"),
    selectorId: id.nullable().optional(),
    estimatedCost: money.nullable().optional(),
    plannedSampleAt: date.nullable().optional(),
    remark: optionalText(2000),
    rowColor: z.enum(rowColors).default("NONE"),
  })
  .strict();

const updateInput = styleSelectionInput
  .partial()
  .extend({ expectedUpdatedAt: z.iso.datetime().optional() })
  .strict();

const selectColumns = `
  s.id,s.style_no,s.name,s.category_id,s.supplier_id,s.source_url,s.selection_status,
  s.selector_id,s.estimated_cost,s.planned_sample_at::text,s.remark,s.row_color,s.created_by,
  s.version,s.created_at,s.updated_at,
  c.name AS category_name,sup.name AS supplier_name,u.display_name AS selector_name,
  creator.display_name AS created_by_name`;
const joins = `
  FROM style_selections s
  LEFT JOIN categories c ON c.id=s.category_id
  LEFT JOIN suppliers sup ON sup.id=s.supplier_id
  LEFT JOIN users u ON u.id=s.selector_id
  JOIN users creator ON creator.id=s.created_by`;

export async function options() {
  const [categories, suppliers, users] = await Promise.all([
    rows(
      db,
      `WITH RECURSIVE category_tree AS (
        SELECT id,parent_id,code,name,name::text AS path_name FROM categories WHERE parent_id IS NULL
        UNION ALL
        SELECT c.id,c.parent_id,c.code,c.name,concat(t.path_name,' / ',c.name)
        FROM categories c JOIN category_tree t ON c.parent_id=t.id
      )
      SELECT t.id,t.code,t.name,t.path_name
      FROM category_tree t
      JOIN categories c ON c.id=t.id
      WHERE c.status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM categories child WHERE child.parent_id=t.id)
      ORDER BY t.path_name`,
    ),
    rows(db, "SELECT id,supplier_code,name FROM suppliers WHERE status='ACTIVE' ORDER BY supplier_code"),
    rows(db, "SELECT id,display_name FROM users WHERE status='ACTIVE' ORDER BY display_name,id"),
  ]);
  return { categories, suppliers, users };
}

export async function list(query: Record<string, unknown>) {
  const p = pagination(query);
  const values: unknown[] = [];
  const where: string[] = [];
  const add = (value: unknown, condition: (index: number) => string) => {
    values.push(value);
    where.push(condition(values.length));
  };
  if (query.q) {
    const value = "%" + String(query.q).slice(0, 100) + "%";
    values.push(value);
    where.push(`(s.style_no ILIKE $${values.length} OR s.name ILIKE $${values.length} OR coalesce(s.remark,'') ILIKE $${values.length})`);
  }
  if (query.status) add(String(query.status), (i) => `s.selection_status=$${i}`);
  if (query.categoryId) add(String(query.categoryId), (i) => `s.category_id=$${i}::bigint`);
  if (query.supplierId) add(String(query.supplierId), (i) => `s.supplier_id=$${i}::bigint`);
  if (query.selectorId) add(String(query.selectorId), (i) => `s.selector_id=$${i}::bigint`);
  const clause = where.length ? " WHERE " + where.join(" AND ") : "";
  const sort = ["updatedAt", "createdAt", "styleNo", "estimatedCost", "plannedSampleAt"].includes(String(query.sort))
    ? String(query.sort).replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())
    : "updated_at";
  const direction = String(query.direction).toLowerCase() === "asc" ? "ASC" : "DESC";
  const total = await one(db, `SELECT count(*)::int AS n ${joins}${clause}`, ...values);
  const data = await rows(
    db,
    `SELECT ${selectColumns} ${joins}${clause} ORDER BY s.${sort} ${direction} NULLS LAST,s.id DESC LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
    ...values,
  );
  return { data, total: total!.n, ...p };
}

async function validateRelations(tx: Tx, body: Row) {
  if (body.categoryId) {
    await active(tx, "categories", body.categoryId);
    if (await one(tx, "SELECT 1 FROM categories WHERE parent_id=$1::bigint", body.categoryId))
      fail("VALIDATION_ERROR", "选款品类只能选择末级品类", 400);
  }
  if (body.supplierId) await active(tx, "suppliers", body.supplierId);
  if (body.selectorId) await active(tx, "users", body.selectorId);
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
    await validateRelations(tx, changes);
    const result = before
      ? await update(tx, "style_selections", value!, { ...changes, version: before.version + 1 })
      : await insert(tx, "style_selections", { ...changes, createdBy: c.actor.id });
    await audit(tx, c, before ? "UPDATE" : "CREATE", "style-selection", result.id, before, result);
    return result;
  });
}

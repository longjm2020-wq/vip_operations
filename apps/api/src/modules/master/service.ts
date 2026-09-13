import { z } from "zod";
import {
  db,
  rows,
  one,
  insert,
  update,
  snake,
  Row,
} from "../../../../../packages/database/src/index.js";
import {
  Context,
  parse,
  text,
  id,
  qty,
  money,
  command,
  audit,
  entity,
  state,
  active,
  fail,
  pagination,
} from "../../core.js";
const status = z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE");
const optionalText = z.string().trim().max(1000).nullable().optional();
const mappingSchema = z
  .object({
    code: z.string().regex(/^(?!000)[0-9]{3}$/),
    name: z.string().trim().min(1).max(100),
    status,
  })
  .strict();
export const resources = {
  "color-mappings": {
    table: "color_mappings",
    permission: "product",
    schema: mappingSchema,
    search: ["code", "name"],
  },
  "size-mappings": {
    table: "size_mappings",
    permission: "product",
    schema: mappingSchema,
    search: ["code", "name"],
  },
  suppliers: {
    table: "suppliers",
    permission: "supplier",
    schema: z
      .object({
        supplierCode: text,
        name: text,
        contactName: optionalText,
        phone: optionalText,
        address: optionalText,
        defaultLeadTimeDays: qty.nullable().optional(),
        moq: qty.positive().nullable().optional(),
        status,
      })
      .strict(),
    search: ["supplier_code", "name"],
  },
  warehouses: {
    table: "warehouses",
    permission: "warehouse",
    schema: z
      .object({ code: text, name: text, address: optionalText, status })
      .strict(),
    search: ["code", "name"],
  },
  categories: {
    table: "categories",
    permission: "product",
    schema: z
      .object({
        code: text,
        name: text,
        parentId: id.nullable().optional(),
        status,
      })
      .strict(),
    search: ["code", "name"],
  },
  brands: {
    table: "brands",
    permission: "product",
    schema: z.object({ code: text, name: text, status }).strict(),
    search: ["code", "name"],
  },
  products: {
    table: "products",
    permission: "product",
    schema: z
      .object({
        styleNo: text,
        name: text,
        categoryId: id,
        brandId: id.nullable().optional(),
        defaultSupplierId: id.nullable().optional(),
        year: z.number().int().min(1900).max(2200).nullable().optional(),
        season: optionalText,
        tagPrice: money.nullable().optional(),
        mainImageUrl: z.url().nullable().optional(),
        remark: optionalText,
        status: z.enum(["ACTIVE", "STOPPED", "ARCHIVED"]).default("ACTIVE"),
      })
      .strict(),
    search: ["style_no", "name"],
  },
  skus: {
    table: "skus",
    permission: "product",
    schema: z
      .object({
        productId: id,
        skuCode: text,
        barcode: optionalText,
        colorCode: text,
        colorName: text,
        sizeCode: text,
        sizeName: text,
        costPrice: money.nullable().optional(),
        status,
      })
      .strict(),
    search: ["sku_code", "barcode", "color_name", "size_name"],
  },
} as const;
export type Resource = keyof typeof resources;
export function getResource(name: string) {
  if (!Object.hasOwn(resources, name)) fail("NOT_FOUND", "接口不存在", 404);
  return resources[name as Resource];
}
export async function masterList(name: Resource, q: Record<string, any>) {
  const r = getResource(name),
    p = pagination(q);
  const values: unknown[] = [];
  const where: string[] = [];
  if (q.q) {
    values.push("%" + String(q.q).slice(0, 100) + "%");
    where.push(
      "(" +
        r.search.map((k) => `${k} ILIKE $${values.length}`).join(" OR ") +
        ")",
    );
  }
  const allowed: Record<string, string[]> = {
    products: [
      "categoryId",
      "brandId",
      "defaultSupplierId",
      "year",
      "season",
      "status",
    ],
    skus: ["productId", "colorCode", "sizeCode", "status"],
    suppliers: ["status"],
    warehouses: ["status"],
    brands: ["status"],
    categories: ["status"],
    "color-mappings": ["status"],
    "size-mappings": ["status"],
  };
  for (const k of allowed[name])
    if (q[k]) {
      values.push(String(q[k]));
      where.push(
        `${snake(k)}=$${values.length}${k.endsWith("Id") ? "::bigint" : k === "year" ? "::int" : ""}`,
      );
    }
  const clause = where.length ? " WHERE " + where.join(" AND ") : "";
  const count = await one(
    db,
    `SELECT count(*)::int AS n FROM ${r.table}${clause}`,
    ...values,
  );
  const data = await rows(
    db,
    `SELECT * FROM ${r.table}${clause} ORDER BY id DESC LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
    ...values,
  );
  return { data, total: count!.n, ...p };
}
export async function masterWrite(
  c: Context,
  name: Resource,
  input: unknown,
  value?: string,
) {
  const r = getResource(name);
  const b = parse<Row>(
    value ? r.schema.partial().strict() : r.schema,
    input,
  ) as Row;
  if (!Object.keys(b).length) fail("VALIDATION_ERROR", "没有可更新字段", 400);
  return command(c, name + "/" + (value ?? "create"), b, async (tx) => {
    // This lock also serializes inventory/PO checks against warehouse disabling.
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    const before = value ? await entity(tx, r.table, value, true) : null;
    if (
      name === "skus" &&
      value &&
      b.productId &&
      String(before!.product_id) !== b.productId
    )
      fail("VALIDATION_ERROR", "不能更换SKU所属商品", 400);
    if (name === "color-mappings" && b.code === "044")
      fail("INVALID_COLOR_CODE", "044 已作废，花色请使用 025", 400);
    if (
      name === "color-mappings" &&
      (b.code ?? before?.code) === "025" &&
      b.name &&
      b.name !== "花色"
    )
      fail("INVALID_COLOR_NAME", "025 对应花色", 400);
    if (
      (name === "color-mappings" || name === "size-mappings") &&
      before &&
      b.code &&
      b.code !== before.code
    ) {
      const column = name === "color-mappings" ? "color_code" : "size_code";
      if (
        await one(
          tx,
          `SELECT id FROM skus WHERE ${column}=$1 LIMIT 1`,
          before.code,
        )
      )
        fail("MAPPING_IN_USE", "编码已被 SKU 使用，不能更改；可编辑名称或停用");
    }
    if (name === "skus") {
      if (b.colorCode === "044")
        fail("INVALID_COLOR_CODE", "044 已作废，花色请使用 025", 400);
      for (const [field, column, table] of [
        ["colorCode", "color_code", "color_mappings"],
        ["sizeCode", "size_code", "size_mappings"],
      ]) {
        if (
          b[field] !== undefined &&
          (!before || b[field] !== before[column])
        ) {
          const mapping = await one(
            tx,
            `SELECT id FROM ${table} WHERE code=$1 AND status='ACTIVE'`,
            b[field],
          );
          if (!mapping)
            fail("INVALID_MAPPING", "请选择有效的颜色或尺码映射", 400);
        }
      }
    }
    if (b.productId) await active(tx, "products", b.productId);
    if (b.categoryId) await active(tx, "categories", b.categoryId);
    if (b.brandId) await active(tx, "brands", b.brandId);
    if (b.defaultSupplierId) await active(tx, "suppliers", b.defaultSupplierId);
    if (name === "categories" && b.parentId) {
      let next = b.parentId;
      const seen = new Set<string>(value ? [value] : []);
      while (next) {
        if (seen.has(next)) fail("INVALID_PARENT", "品类不能循环引用");
        seen.add(next);
        next = String((await entity(tx, "categories", next)).parent_id ?? "");
      }
    }
    if (name === "warehouses" && value && b.status === "INACTIVE") {
      const occupied = await one(
        tx,
        "SELECT EXISTS(SELECT 1 FROM inventory_balances WHERE warehouse_id=$1::bigint AND physical_qty<>0) OR EXISTS(SELECT 1 FROM purchase_orders WHERE warehouse_id=$1::bigint AND status NOT IN ('CANCELLED','COMPLETED')) AS busy",
        value,
      );
      if (occupied?.busy) fail("WAREHOUSE_IN_USE", "仓库存在库存或活动采购单");
    }
    if (before)
      state(
        before,
        name === "products"
          ? ["ACTIVE", "STOPPED", "ARCHIVED"]
          : ["ACTIVE", "INACTIVE"],
      );
    const result = value
      ? await update(tx, r.table, value, b)
      : await insert(tx, r.table, b);
    await audit(
      tx,
      c,
      value ? "UPDATE" : "CREATE",
      name,
      result.id,
      before,
      result,
    );
    return result;
  });
}

export async function mappingDelete(c: Context, name: Resource, value: string) {
  if (name !== "color-mappings" && name !== "size-mappings")
    fail("NOT_FOUND", "接口不存在", 404);
  const r = getResource(name);
  return command(c, name + "/delete/" + value, {}, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    const before = await entity(tx, r.table, value, true);
    const column = name === "color-mappings" ? "color_code" : "size_code";
    if (
      await one(
        tx,
        `SELECT id FROM skus WHERE ${column}=$1 LIMIT 1`,
        before.code,
      )
    )
      fail("MAPPING_IN_USE", "映射已被 SKU 使用，请停用而不是删除");
    await rows(
      tx,
      `DELETE FROM ${r.table} WHERE id=$1::bigint RETURNING id`,
      value,
    );
    await audit(tx, c, "DELETE", name, value, before, null);
    return { id: value, deleted: true };
  });
}

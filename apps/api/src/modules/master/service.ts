import { z } from "zod";
import {
  customValues,
  validateCustom,
  customFilter,
} from "./product-fields.js";
import {
  db,
  Tx,
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
        parentCode: z.string().trim().max(50).nullable().optional(),
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
        customFields: customValues.optional(),
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
const womenCategoryTemplate = [
  ["WOMEN", "女装"],
  ["WOMEN-ACCESSORIES", "服饰配件", "WOMEN"],
  ["WOMEN-ACCESSORIES-SHAWL", "女款披肩", "WOMEN-ACCESSORIES"],
  ["WOMEN-TOPS", "女上装", "WOMEN"],
  ["WOMEN-TOPS-LEATHER", "女式皮衣/皮草", "WOMEN-TOPS"],
  ["WOMEN-TOPS-POLO", "女式Polo衫", "WOMEN-TOPS"],
  ["WOMEN-TOPS-TSHIRT", "女式T恤", "WOMEN-TOPS"],
  ["WOMEN-TOPS-VEST", "女式背心", "WOMEN-TOPS"],
  ["WOMEN-TOPS-SHIRT", "女式衬衫", "WOMEN-TOPS"],
  ["WOMEN-TOPS-BASE", "女式打底衫", "WOMEN-TOPS"],
  ["WOMEN-TOPS-COAT", "女式大衣", "WOMEN-TOPS"],
  ["WOMEN-TOPS-TRENCH", "女式风衣", "WOMEN-TOPS"],
  ["WOMEN-TOPS-JACKET", "女式夹克", "WOMEN-TOPS"],
  ["WOMEN-TOPS-GILET", "女式马夹", "WOMEN-TOPS"],
  ["WOMEN-TOPS-SWEATER", "女式毛衣", "WOMEN-TOPS"],
  ["WOMEN-TOPS-PADDED", "女式棉衣", "WOMEN-TOPS"],
  ["WOMEN-TOPS-OUTER", "女式外套", "WOMEN-TOPS"],
  ["WOMEN-TOPS-HOODIE", "女式卫衣", "WOMEN-TOPS"],
  ["WOMEN-TOPS-BLAZER", "女式西服", "WOMEN-TOPS"],
  ["WOMEN-TOPS-WOOL", "女式羊毛衫", "WOMEN-TOPS"],
  ["WOMEN-TOPS-CASHMERE", "女式羊绒衫", "WOMEN-TOPS"],
  ["WOMEN-TOPS-DOWN", "女式羽绒服", "WOMEN-TOPS"],
  ["WOMEN-TOPS-KNIT", "女式针织衫", "WOMEN-TOPS"],
  ["WOMEN-TOPS-DRESS", "女式礼服", "WOMEN-TOPS"],
  ["WOMEN-DRESS-SETS", "女式礼服套装", "WOMEN"],
  ["WOMEN-DRESS-SETS-SUIT", "女式套装", "WOMEN-DRESS-SETS"],
  ["WOMEN-BOTTOMS", "女下装", "WOMEN"],
  ["WOMEN-BOTTOMS-LEGGINGS", "女式打底裤", "WOMEN-BOTTOMS"],
  ["WOMEN-BOTTOMS-JUMPSUIT", "女式连体裤", "WOMEN-BOTTOMS"],
  ["WOMEN-BOTTOMS-JEANS", "女式牛仔裤", "WOMEN-BOTTOMS"],
  ["WOMEN-BOTTOMS-TROUSERS", "女式西裤", "WOMEN-BOTTOMS"],
  ["WOMEN-BOTTOMS-CASUAL", "女式休闲裤", "WOMEN-BOTTOMS"],
  ["WOMEN-SKIRTS", "裙装", "WOMEN"],
  ["WOMEN-SKIRTS-HALF", "半截裙", "WOMEN-SKIRTS"],
  ["WOMEN-SKIRTS-DRESS", "连衣裙", "WOMEN-SKIRTS"],
] as const;
async function categoryDepth(tx: Tx, categoryId: string) {
  const row = await one(
    tx,
    `WITH RECURSIVE ancestors AS (
      SELECT id,parent_id,1 AS depth FROM categories WHERE id=$1::bigint
      UNION ALL
      SELECT c.id,c.parent_id,a.depth+1 FROM categories c JOIN ancestors a ON a.parent_id=c.id
    ) SELECT max(depth)::int AS depth FROM ancestors`,
    categoryId,
  );
  return Number(row?.depth || 0);
}
async function categoryHeight(tx: Tx, categoryId: string) {
  const row = await one(
    tx,
    `WITH RECURSIVE descendants AS (
      SELECT id,1 AS depth FROM categories WHERE id=$1::bigint
      UNION ALL
      SELECT c.id,d.depth+1 FROM categories c JOIN descendants d ON c.parent_id=d.id
    ) SELECT max(depth)::int AS depth FROM descendants`,
    categoryId,
  );
  return Number(row?.depth || 1);
}
async function categoryList(
  q: Record<string, any>,
  p: ReturnType<typeof pagination>,
) {
  const values: unknown[] = [];
  const where: string[] = [];
  if (q.q) {
    values.push("%" + String(q.q).slice(0, 100) + "%");
    where.push(
      `(code ILIKE $${values.length} OR path_name ILIKE $${values.length})`,
    );
  }
  if (q.status) {
    values.push(String(q.status));
    where.push(`status=$${values.length}`);
  }
  if (q.forProduct === "true") {
    where.push(
      "status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM categories child WHERE child.parent_id=category_tree.id)",
    );
  }
  const clause = where.length ? " WHERE " + where.join(" AND ") : "";
  const tree = `WITH RECURSIVE category_tree AS (
    SELECT c.*,1 AS level,c.name::text AS level1_name,NULL::text AS level2_name,NULL::text AS level3_name,
      c.name::text AS path_name,NULL::text AS parent_code
    FROM categories c WHERE c.parent_id IS NULL
    UNION ALL
    SELECT c.*,t.level+1,
      t.level1_name,
      CASE WHEN t.level=1 THEN c.name ELSE t.level2_name END,
      CASE WHEN t.level=2 THEN c.name ELSE t.level3_name END,
      concat(t.path_name,' / ',c.name),parent.code
    FROM categories c
    JOIN category_tree t ON c.parent_id=t.id
    LEFT JOIN categories parent ON parent.id=c.parent_id
  )`;
  const count = await one(
    db,
    `${tree} SELECT count(*)::int AS n FROM category_tree${clause}`,
    ...values,
  );
  const data = await rows(
    db,
    `${tree} SELECT * FROM category_tree${clause} ORDER BY level1_name,level2_name NULLS FIRST,level3_name NULLS FIRST,code LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
    ...values,
  );
  return { data, total: count!.n, ...p };
}
export async function masterList(name: Resource, q: Record<string, any>) {
  const r = getResource(name),
    p = pagination(q);
  if (name === "categories") return categoryList(q, p);
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
  if (name === "products" && q.customFilters)
    await customFilter(q.customFilters, values, where);
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
    value
      ? r.schema
          .partial()
          .extend({ expectedUpdatedAt: z.iso.datetime().optional() })
          .strict()
      : r.schema,
    input,
  ) as Row;
  if (name === "categories" && b.parentCode !== undefined) {
    const parentCode = String(b.parentCode || "").trim();
    if (b.parentId !== undefined && parentCode)
      fail("VALIDATION_ERROR", "上级品类只能使用编码或下拉选择其中一种", 400);
    if (parentCode) {
      const parent = await one(
        db,
        "SELECT id FROM categories WHERE code=$1",
        parentCode,
      );
      if (!parent) fail("INVALID_PARENT", "未找到上级品类编码", 400);
      b.parentId = String(parent.id);
    } else if (b.parentId === undefined) b.parentId = null;
    delete b.parentCode;
  }
  if (!Object.keys(b).some((key) => key !== "expectedUpdatedAt"))
    fail("VALIDATION_ERROR", "没有可更新字段", 400);
  return command(c, name + "/" + (value ?? "create"), b, async (tx) => {
    // This lock also serializes inventory/PO checks against warehouse disabling.
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    const before = value ? await entity(tx, r.table, value, true) : null;
    if (
      before &&
      b.expectedUpdatedAt &&
      new Date(before.updated_at).toISOString() !== b.expectedUpdatedAt
    )
      fail(
        "EDIT_CONFLICT",
        "资料已被其他操作修改，请关闭表格并刷新后重新编辑",
        409,
      );
    const changes = { ...b };
    delete changes.expectedUpdatedAt;
    if (name === "products" && b.customFields !== undefined) {
      changes.customFields = JSON.stringify(
        await validateCustom(tx, b.customFields, before?.custom_fields || {}),
      );
    }
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
    if (b.categoryId) {
      await active(tx, "categories", b.categoryId);
      if (
        await one(
          tx,
          "SELECT id FROM categories WHERE parent_id=$1::bigint LIMIT 1",
          b.categoryId,
        )
      )
        fail("INVALID_CATEGORY", "商品只能选择末级品类", 400);
    }
    if (b.brandId) await active(tx, "brands", b.brandId);
    if (b.defaultSupplierId) await active(tx, "suppliers", b.defaultSupplierId);
    if (name === "categories") {
      const parentId = String(b.parentId ?? before?.parent_id ?? "");
      if (parentId) {
        await active(tx, "categories", parentId);
        let next = parentId;
        const seen = new Set<string>(value ? [value] : []);
        while (next) {
          if (seen.has(next)) fail("INVALID_PARENT", "品类不能循环引用");
          seen.add(next);
          next = String((await entity(tx, "categories", next)).parent_id ?? "");
        }
      }
      const depth = parentId ? await categoryDepth(tx, parentId) : 0;
      const height = value ? await categoryHeight(tx, value) : 1;
      if (depth + height > 3)
        fail("INVALID_CATEGORY_LEVEL", "品类最多只能建立三级", 400);
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
      ? await update(tx, r.table, value, changes)
      : await insert(tx, r.table, changes);
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
export async function initializeWomenCategories(c: Context) {
  return command(
    c,
    "categories/initialize-women-template",
    { template: "women-apparel-v1" },
    async (tx) => {
      await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
      const used = await one(
        tx,
        "SELECT count(*)::int AS n FROM products WHERE category_id IS NOT NULL",
      );
      if (used?.n)
        fail(
          "CATEGORY_IN_USE",
          "已有商品关联品类，不能清空；请先调整商品品类后再初始化",
          409,
        );
      const existing = await one(
        tx,
        "SELECT count(*)::int AS n FROM categories",
      );
      await rows(tx, "DELETE FROM categories");
      for (const [code, name, parentCode] of womenCategoryTemplate) {
        const parent = parentCode
          ? await one(tx, "SELECT id FROM categories WHERE code=$1", parentCode)
          : null;
        await insert(tx, "categories", {
          code,
          name,
          parentId: parent ? String(parent.id) : null,
          status: "ACTIVE",
        });
      }
      const result = {
        cleared: existing?.n || 0,
        created: womenCategoryTemplate.length,
      };
      await audit(
        tx,
        c,
        "INITIALIZE",
        "categories",
        null,
        { count: existing?.n || 0 },
        result,
      );
      return result;
    },
  );
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

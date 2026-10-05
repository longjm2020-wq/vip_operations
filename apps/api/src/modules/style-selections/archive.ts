import {
  camel,
  db,
  insert,
  one,
  rows,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import {
  archiveMappedFields,
  archiveTableFields,
  archiveChoiceColumns,
} from "../../../../../packages/contracts/src/product-archive-table.js";
import { sharedFields } from "./shared-fields.js";
import { archiveSelectionPermissions } from "../../../../../packages/contracts/src/table-permissions.js";
import {
  audit,
  fail,
  money,
  parse,
  requirePermission,
  type Context,
} from "../../core.js";
import { persistMaster } from "../master/service.js";
import { customValues } from "../master/product-fields.js";
import { z } from "zod";

export async function isArchive(tx: Tx) {
  const scope = selectionScope.getStore();
  return (
    !!scope &&
    (
      await one(
        tx,
        "SELECT system_key FROM public.project_tables WHERE id=$1::bigint",
        scope,
      )
    )?.system_key === "PRODUCT_ARCHIVE"
  );
}
export async function archiveWorkspace(tx: Tx, c: Context) {
  requirePermission(c.actor, "product.read");
  await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
  let table = await one(
    tx,
    "SELECT * FROM public.project_tables WHERE system_key='PRODUCT_ARCHIVE'",
  );
  if (!table) {
    table = await insert(tx, "public.project_tables", {
      name: "商品档案",
      createdBy: c.actor.id,
      initialLayout: "empty",
      visibility: "PRIVATE",
      systemKey: "PRODUCT_ARCHIVE",
    });
    await rows(
      tx,
      "SELECT public.create_project_table_workspace($1::bigint)::text",
      table.id,
    );
    await rows(
      tx,
      "SELECT public.sync_product_archive_record(p,$1::bigint,$2::bigint)::text FROM public.products p ORDER BY p.id",
      table.id,
      c.actor.id,
    );
    await audit(tx, c, "CREATE", "product-archive-table", table.id, null, {
      name: table.name,
    });
  }
  return table;
}
export async function archiveMetadata(c: Context) {
  return db.$transaction(
    async (tx) => {
      const table = await archiveWorkspace(tx, c);
      const fields = camel(
        await rows(
          tx,
          "SELECT * FROM public.product_fields WHERE active ORDER BY created_at,id",
        ),
      );
      const categories = camel(
        await rows(
          tx,
          "SELECT c.id,c.name,c.status,EXISTS(SELECT 1 FROM public.categories child WHERE child.parent_id=c.id) AS has_children FROM public.categories c ORDER BY c.id",
        ),
      );
      const brands = camel(
        await rows(tx, "SELECT id,name,status FROM public.brands ORDER BY id"),
      );
      const suppliers = camel(
        await rows(
          tx,
          "SELECT id,name,status FROM public.suppliers ORDER BY id",
        ),
      );
      return {
        id: String(table.id),
        name: table.name,
        initialLayout: table.initial_layout,
        layoutGeneration: table.layout_generation,
        fields:
          table.initial_layout === "empty"
            ? archiveChoiceColumns(
                (await sharedFields(tx, String(table.id))).fields,
                archiveTableFields(fields),
              )
            : archiveTableFields(fields),
        references: {
          categoryId: categories,
          brandId: brands,
          defaultSupplierId: suppliers,
        },
      };
    },
    { timeout: 30000 },
  );
}
const coreFields = [
  "name",
  "categoryId",
  "brandId",
  "defaultSupplierId",
  "year",
  "season",
  "remark",
  "status",
];
const optionalId = z.string().regex(/^[1-9]\d{0,18}$/);
// This bridge runs inside the sheet write transaction. Master IDs and SKU references never change.
export async function mirrorArchiveRow(tx: Tx, c: Context, raw: Row) {
  if (!(await isArchive(tx))) return;
  const row = camel(raw),
    styleNo = String(row.xutiStyleNo || "").trim();
  if (!styleNo && !row.productId) return; // Empty sheet drafts are not products.
  if (!styleNo) fail("VALIDATION_ERROR", "商品款号不能为空", 400);
  const original = row.productId
    ? await one(
        tx,
        "SELECT * FROM public.products WHERE id=$1::bigint FOR UPDATE",
        row.productId,
      )
    : await one(
        tx,
        "SELECT * FROM public.products WHERE style_no=$1 FOR UPDATE",
        styleNo,
      );
  requirePermission(c.actor, original ? "product.update" : "product.create");
  const values: Row = { styleNo, customFields: {} };
  const extras = row.extraFields || {};
  for (const key of coreFields)
    if (Object.hasOwn(extras, "custom:product:" + key))
      values[key] = extras["custom:product:" + key] || null;
  values.name = values.name || original?.name || styleNo;
  if (!values.categoryId) {
    values.categoryId = original?.category_id
      ? String(original.category_id)
      : null;
    if (!values.categoryId) {
      let category = await one(
        tx,
        "SELECT * FROM public.categories WHERE code='INVENTORY_IMPORT_PENDING'",
      );
      if (!category)
        category = await insert(tx, "public.categories", {
          code: "INVENTORY_IMPORT_PENDING",
          name: "导入待分类",
          status: "ACTIVE",
        });
      values.categoryId = String(category.id);
    }
  }
  for (const key of ["categoryId", "brandId", "defaultSupplierId"])
    if (values[key]) values[key] = parse(optionalId, String(values[key]));
  if ("year" in values && values.year !== null)
    values.year = parse(
      z.coerce.number().int().min(1900).max(2200),
      values.year,
    );
  if (values.status)
    values.status = parse(
      z.enum(["ACTIVE", "STOPPED", "ARCHIVED"]),
      values.status,
    );
  else delete values.status;
  values.status ??= original?.status || "ACTIVE";
  values.name = parse(z.string().trim().min(1).max(255), values.name);
  for (const key of ["season", "remark"])
    if (values[key] !== undefined && values[key] !== null)
      values[key] = parse(
        z.string().max(key === "season" ? 32 : 1000),
        values[key],
      );
  const definitions = await rows(
    tx,
    "SELECT * FROM public.product_fields WHERE active",
  );
  for (const [column, field] of Object.entries(archiveMappedFields))
    if (definitions.some((definition) => definition.id === field))
      values.customFields[field] = row[column] ?? "";
  for (const definition of definitions)
    if (
      Object.hasOwn(extras, "custom:product:" + definition.id) &&
      !Object.values(archiveMappedFields).includes(String(definition.id))
    )
      values.customFields[definition.id] =
        extras["custom:product:" + definition.id] || "";
  for (const definition of definitions)
    if (
      definition.type === "number" &&
      values.customFields[definition.id] !== undefined &&
      values.customFields[definition.id] !== "" &&
      values.customFields[definition.id] !== null
    )
      values.customFields[definition.id] = parse(
        z.coerce
          .number()
          .finite()
          .min(definition.builtin ? 0 : -1e12)
          .max(1e12),
        values.customFields[definition.id],
      );
  values.customFields = parse(customValues, values.customFields);
  values.tagPrice =
    row.tagPrice === null || row.tagPrice === undefined
      ? null
      : parse(money, String(row.tagPrice));
  const image = row.images?.[0]?.url;
  if (image)
    values.mainImageUrl = image.startsWith("/api/")
      ? new URL(image, process.env.APP_ORIGIN).toString()
      : parse(z.url(), image);
  else values.mainImageUrl = null;
  await tx.$executeRawUnsafe("SET LOCAL erp.archive_write='1'");
  try {
    const product = await persistMaster(
      tx,
      c,
      "products",
      values,
      original ? String(original.id) : undefined,
    );
    await rows(
      tx,
      "UPDATE style_selections SET product_id=$2::bigint,extra_fields=extra_fields || $3::jsonb WHERE id=$1::bigint",
      row.id,
      product.id,
      JSON.stringify({
        "custom:product:name": values.name,
        "custom:product:categoryId": values.categoryId,
        "custom:product:status": values.status,
      }),
    );
  } finally {
    await tx.$executeRawUnsafe("SET LOCAL erp.archive_write='0'");
  }
}
export const archiveActor = (c: Context) => ({
  ...c,
  actor: {
    ...c.actor,
    permissions: archiveSelectionPermissions(c.actor.permissions),
  },
});

import { db, one, rows, type Tx } from "../../../../../packages/database/src/index.js";
import { audit, command, fail, parse, requirePermission, type Actor, type Context } from "../../core.js";
import {
  inventoryCalculationFieldDeleteSchema, inventoryCalculationFieldLimit,
  inventoryCalculationFieldViewSchema, inventoryCalculationFieldWriteSchema,
  inventoryFormulaFields,
} from "../../../../../packages/contracts/src/inventory-formula.js";

/** Private fields never leave their owner's account, including via summaries. */
export async function inventoryCalculationFields(userId?: string, tx: Tx = db, admin = false) {
  if (!userId) return [];
  return rows(tx, `SELECT f.id::text, 'calculated'||f.id::text AS key,f.name,f.formula,f.is_public,
    f.owner_id::text,u.display_name AS owner_name,f.revision,COALESCE(v.hidden,false) AS hidden,
    COALESCE(v.revision,0) AS view_revision,(f.owner_id=$1::bigint OR $2::boolean) AS can_manage
    FROM public.inventory_calculation_fields f JOIN public.users u ON u.id=f.owner_id
    LEFT JOIN public.inventory_calculation_field_views v ON v.field_id=f.id AND v.user_id=$1::bigint
    WHERE f.deleted_at IS NULL AND (f.owner_id=$1::bigint OR f.is_public)
    ORDER BY f.created_at,f.id`, userId, admin);
}
const isAdmin = (actor: Actor) => !!actor.roleCodes?.includes("SUPER_ADMIN");
export const listInventoryCalculationFields = (actor: Actor) => {
  requirePermission(actor, "inventory.read");
  return inventoryCalculationFields(actor.id, db, isAdmin(actor));
};
async function editable(tx: Tx, c: Context, id: string, revision: number) {
  const field = await one(tx, `SELECT * FROM public.inventory_calculation_fields
    WHERE id=$1::bigint AND deleted_at IS NULL AND (owner_id=$2::bigint OR is_public) FOR UPDATE`, id, c.actor.id);
  if (!field) fail("NOT_FOUND", "字段不存在或已不再公开，请刷新", 404);
  if (String(field.owner_id) !== c.actor.id && !isAdmin(c.actor)) fail("FORBIDDEN", "仅创建者或超级管理员可以管理此字段", 403);
  if (field.revision !== revision) fail("FIELD_CONFLICT", "字段已被修改，请重新读取后编辑", 409);
  return field;
}
export async function saveInventoryCalculationField(c: Context, input: unknown) {
  requirePermission(c.actor, "inventory.read");
  const body = parse(inventoryCalculationFieldWriteSchema, input);
  const reservedNames = [...inventoryFormulaFields.map(field => String(field.label)), "图片", "款号", "货号", "商品编码", "颜色", "尺码", "总计"];
  if (reservedNames.includes(body.name)) fail("FIELD_NAME", "请使用与原始字段不同的名称", 400);
  return command(c, "inventory.calculation-field.save", body, async tx => {
    // Serialize catalog mutations, including count/uniqueness checks and legacy clients.
    await rows(tx, "SELECT pg_advisory_xact_lock(hashtextextended('inventory-calculation-fields',0))::text");
    const before = body.id ? await editable(tx,c,body.id,body.revision) : null;
    if (!before && body.revision !== 0) fail("FIELD_CONFLICT", "新增字段版本必须为0", 409);
    const owner = before ? String(before.owner_id) : c.actor.id;
    const owned = await rows(tx, "SELECT id::text,name FROM public.inventory_calculation_fields WHERE owner_id=$1::bigint AND deleted_at IS NULL", owner);
    if (!before && owned.length >= inventoryCalculationFieldLimit) fail("FIELD_LIMIT", `每个账号最多新增${inventoryCalculationFieldLimit}个计算字段`,400);
    if (owned.some(field => field.id !== body.id && field.name.toLocaleLowerCase() === body.name.toLocaleLowerCase())) fail("FIELD_NAME", "你已有同名字段，请修改名称",409);
    // Bound shared query work without returning anyone's private catalog.
    const publicCount = await one(tx,"SELECT count(*)::int AS count FROM public.inventory_calculation_fields WHERE is_public AND deleted_at IS NULL");
    if (body.isPublic && !before?.is_public && publicCount!.count >= 40) fail("FIELD_LIMIT", "公开计算字段已达40个，请先取消不再使用字段的公开",400);
    const after = before
      ? await one(tx, `UPDATE public.inventory_calculation_fields SET name=$2,formula=$3,is_public=$4,
        revision=revision+1,updated_at=now() WHERE id=$1::bigint RETURNING *`, body.id,body.name,body.formula,body.isPublic)
      : await one(tx, `INSERT INTO public.inventory_calculation_fields(owner_id,name,formula,is_public)
        VALUES($1::bigint,$2,$3,$4) RETURNING *`, owner,body.name,body.formula,body.isPublic);
    if (before?.legacy_user_id) await one(tx, `UPDATE public.inventory_calculation_policies SET formula=$2,revision=revision+1,updated_at=now()
      WHERE user_id=$1::bigint RETURNING user_id`,String(before.legacy_user_id),body.formula);
    await audit(tx,c,"inventory.calculation-field.save","inventory_calculation_fields",String(after!.id),before,after);
    return after;
  });
}
export async function deleteInventoryCalculationField(c: Context, input: unknown) {
  requirePermission(c.actor,"inventory.read");
  const body = parse(inventoryCalculationFieldDeleteSchema,input);
  return command(c,"inventory.calculation-field.delete",body,async tx => {
    await rows(tx,"SELECT pg_advisory_xact_lock(hashtextextended('inventory-calculation-fields',0))::text");
    const before = await editable(tx,c,body.id,body.revision);
    const after = await one(tx,"UPDATE public.inventory_calculation_fields SET deleted_at=now(),updated_at=now(),revision=revision+1 WHERE id=$1::bigint RETURNING *",body.id);
    if (before.legacy_user_id) await one(tx,"UPDATE public.inventory_calculation_policies SET formula=NULL,revision=revision+1,updated_at=now() WHERE user_id=$1::bigint RETURNING user_id",String(before.legacy_user_id));
    await audit(tx,c,"inventory.calculation-field.delete","inventory_calculation_fields",body.id,before,after);
    return { id: body.id, deleted: true };
  });
}
export async function setInventoryCalculationFieldView(c: Context, input: unknown) {
  requirePermission(c.actor,"inventory.read");
  const body = parse(inventoryCalculationFieldViewSchema,input);
  return command(c,"inventory.calculation-field.view",body,async tx => {
    await rows(tx,"SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",`inventory-field-view:${c.actor.id}:${body.id}`);
    const field = await one(tx,"SELECT id FROM public.inventory_calculation_fields WHERE id=$1::bigint AND deleted_at IS NULL AND (owner_id=$2::bigint OR is_public) FOR SHARE",body.id,c.actor.id);
    if (!field) fail("NOT_FOUND","字段不存在或已不再公开，请刷新",404);
    const before = await one(tx,"SELECT * FROM public.inventory_calculation_field_views WHERE user_id=$1::bigint AND field_id=$2::bigint",c.actor.id,body.id);
    if ((before?.revision ?? 0) !== body.revision) fail("FIELD_CONFLICT","显示设置已在其他页面更新，请重新读取",409);
    const after = await one(tx,`INSERT INTO public.inventory_calculation_field_views(user_id,field_id,hidden) VALUES($1::bigint,$2::bigint,$3)
      ON CONFLICT(user_id,field_id) DO UPDATE SET hidden=EXCLUDED.hidden,revision=inventory_calculation_field_views.revision+1 RETURNING *`,c.actor.id,body.id,body.hidden);
    await audit(tx,c,"inventory.calculation-field.view","inventory_calculation_fields",body.id,before ?? null,after);
    return after;
  });
}

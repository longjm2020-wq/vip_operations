import { db, one, rows, snake, type Tx } from "../../../../../packages/database/src/index.js";
import { audit, command, fail, parse, requirePermission, type Context } from "../../core.js";
import { inventoryCalculationFieldLimit, inventoryCalculationWriteSchema, parseInventoryFormula, type InventoryFormulaNode } from "../../../../../packages/contracts/src/inventory-formula.js";

export async function inventoryCalculationPolicy(userId?: string, tx: Tx = db) {
  const stored = userId ? await one(tx,
    "SELECT formula,revision FROM public.inventory_calculation_policies WHERE user_id=$1::bigint", userId) : undefined;
  return { formula: (stored?.formula ?? null) as string | null, revision: (stored?.revision ?? 0) as number };
}

export function inventoryFormulaSql(formula: string | null) {
  if (!formula) return "NULL::numeric";
  const compile = (node: InventoryFormulaNode): string => {
    if (node.kind === "field") return `jst.${snake(node.key)}::numeric`;
    if (node.kind === "number") return `${node.value}::numeric`;
    const left = compile(node.left), right = compile(node.right);
    return `(${left} ${node.op} ${node.op === "/" ? `NULLIF(${right},0)` : right})`;
  };
  const value = `round(${compile(parseInventoryFormula(formula))},4)`;
  return `CASE WHEN abs(${value})<=9007199254740991 THEN ${value} END`;
}

export async function saveInventoryCalculation(c: Context, input: unknown) {
  requirePermission(c.actor, "inventory.read");
  const body = parse(inventoryCalculationWriteSchema, input);
  return command(c, "inventory.calculation-policy", body, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(hashtextextended('inventory-calculation-fields',0))::text");
    await rows(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text", `inventory-calculation:${c.actor.id}`);
    const before = await inventoryCalculationPolicy(c.actor.id, tx);
    if (body.revision !== before.revision) fail("POLICY_CONFLICT", "计算公式已在其他页面更新，请重新打开配置面板", 409);
    const after = (await one(tx, `INSERT INTO public.inventory_calculation_policies(user_id,formula)
      VALUES($1::bigint,$2) ON CONFLICT(user_id) DO UPDATE SET formula=EXCLUDED.formula,
      revision=inventory_calculation_policies.revision+1,updated_at=now() RETURNING formula,revision`, c.actor.id, body.formula))!;
    // Cached clients can still save the old single-field editor. Keep its migrated
    // field in sync; both editors advance the old revision to reject stale writes.
    const legacy = await one(tx, "SELECT * FROM public.inventory_calculation_fields WHERE legacy_user_id=$1::bigint", c.actor.id);
    if (body.formula) {
      if (!legacy || legacy.deleted_at) {
        const owned = await rows(tx, "SELECT name FROM public.inventory_calculation_fields WHERE owner_id=$1::bigint AND deleted_at IS NULL", c.actor.id);
        if (owned.length >= inventoryCalculationFieldLimit) fail("FIELD_LIMIT", "计算字段数量已达上限，请使用新的字段配置面板管理", 400);
        if (owned.some(field => field.name === "在仓总库存")) fail("FIELD_NAME", "已有同名字段，请使用新的字段配置面板编辑", 409);
      }
      if (legacy) await rows(tx, `UPDATE public.inventory_calculation_fields SET formula=$2,revision=revision+1,updated_at=now(),
        name=CASE WHEN deleted_at IS NOT NULL THEN '在仓总库存' ELSE name END,
        is_public=CASE WHEN deleted_at IS NOT NULL THEN false ELSE is_public END,deleted_at=NULL WHERE id=$1::bigint`, String(legacy.id), body.formula);
      else await rows(tx, "INSERT INTO public.inventory_calculation_fields(owner_id,name,formula,legacy_user_id) VALUES($1::bigint,'在仓总库存',$2,$1::bigint)", c.actor.id, body.formula);
    } else if (legacy && !legacy.deleted_at) await rows(tx, "UPDATE public.inventory_calculation_fields SET deleted_at=now(),updated_at=now(),revision=revision+1 WHERE id=$1::bigint", String(legacy.id));
    await audit(tx, c, "inventory.calculation-policy", "users", c.actor.id, before, after);
    return after;
  });
}

import { inventoryImportSchema } from "../../../../../packages/contracts/src/inventory-import.js";
import {
  one,
  rows,
  insert,
  update,
} from "../../../../../packages/database/src/index.js";
import {
  Context,
  parse,
  requirePermission,
  command,
  fail,
  audit,
  active,
  no,
} from "../../core.js";
import { movement } from "./service.js";
export async function importInventoryRow(c: Context, input: unknown) {
  requirePermission(c.actor, "inventory.read");
  const b = parse(inventoryImportSchema, input),
    v = b.changes;
  const skuFields = ["colorName", "sizeName", "barcode"] as const;
  const refFields = [
    "articleNo",
    "dailySales",
    "estimatedReturns",
    "targetDays",
    "sourceNote",
    "referenceDate",
  ] as const;
  const hasSku = skuFields.some((k) => v[k] !== undefined),
    hasRef =
      refFields.some((k) => v[k] !== undefined) ||
      v.returnRatePercent !== undefined;
  const hasStock = v.physicalQty !== undefined || v.quantity !== undefined;
  if (hasSku) requirePermission(c.actor, "product.update");
  if (hasRef || hasStock) requirePermission(c.actor, "inventory.adjust");
  return command(c, "inventory/import-row", b, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    const sku = await one(
      tx,
      "SELECT * FROM skus WHERE sku_code=$1 FOR UPDATE",
      b.skuCode,
    );
    if (!sku)
      fail("SKU_NOT_FOUND", "未找到商品编码（SKU 编码）：" + b.skuCode, 422);
    const skuId = String(sku.id);
    if (hasSku) {
      const changes = Object.fromEntries(
        skuFields.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]),
      );
      const result = await update(tx, "skus", skuId, changes);
      await audit(
        tx,
        c,
        "IMPORT_UPDATE",
        "skus",
        skuId,
        sku,
        result,
        "Excel 仅更新所提供的列",
      );
    }
    if (hasRef) {
      const old = await one(
        tx,
        "SELECT * FROM inventory_sku_references WHERE sku_id=$1::bigint FOR UPDATE",
        skuId,
      );
      const supplied = Object.fromEntries(
        refFields.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]),
      );
      if (v.returnRatePercent !== undefined)
        supplied.returnRate = String(v.returnRatePercent / 100);
      // Existing fields omitted from the file remain untouched, including high precision references.
      const data = { ...supplied, updatedBy: c.actor.id };
      const result = old
        ? await update(tx, "inventory_sku_references", String(old.id), data)
        : await insert(tx, "inventory_sku_references", {
            skuId,
            articleNo: "",
            dailySales: null,
            returnRate: null,
            estimatedReturns: null,
            targetDays: 14,
            sourceNote: "Excel 导入（人工维护）",
            referenceDate: new Intl.DateTimeFormat("en-CA", {
              timeZone: "Asia/Shanghai",
            }).format(new Date()),
            ...data,
          });
      await audit(
        tx,
        c,
        "IMPORT_UPDATE",
        "inventory_reference",
        skuId,
        old || null,
        result,
        "Excel 仅更新所提供的列",
      );
    }
    let adjustmentId: string | null = null;
    if (hasStock) {
      let warehouseId = b.warehouseId;
      if (b.warehouse) {
        const matches = await rows(
          tx,
          "SELECT id FROM warehouses WHERE code=$1 OR name=$1",
          b.warehouse,
        );
        if (matches.length !== 1)
          fail(
            "WAREHOUSE_NOT_FOUND",
            "仓库未找到或名称重复，请使用唯一仓库编码",
            422,
          );
        warehouseId = String(matches[0].id);
      }
      if (!warehouseId)
        fail("WAREHOUSE_REQUIRED", "修改库存需填写仓库列或选择导入仓库", 422);
      await active(tx, "warehouses", warehouseId);
      await active(tx, "skus", skuId);
      const current = await one(
        tx,
        "SELECT physical_qty FROM inventory_balances WHERE warehouse_id=$1::bigint AND sku_id=$2::bigint FOR UPDATE",
        warehouseId,
        skuId,
      );
      const delta = v.quantity ?? v.physicalQty! - (current?.physical_qty || 0);
      if (delta !== 0) {
        const reason =
            v.reason || (v.physicalQty !== undefined ? "STOCKTAKE" : "MANUAL"),
          remark = v.remark || "Excel 导入库存更新";
        const a = await insert(tx, "inventory_adjustments", {
          skuId,
          warehouseId,
          quantity: delta,
          reason,
          remark,
          adjustmentNo: no("ADJ"),
          operatorId: c.actor.id,
        });
        const event = await movement(tx, c, warehouseId, skuId, delta, {
          transactionType:
            reason === "STOCKTAKE" ? "STOCKTAKE" : "STOCK_ADJUSTMENT",
          sourceType: "ADJUSTMENT",
          sourceId: a.id,
          sourceNo: a.adjustment_no,
          adjustmentId: a.id,
          remark,
        });
        adjustmentId = String(a.id);
        await audit(
          tx,
          c,
          "IMPORT_ADJUST",
          "inventory",
          a.id,
          { physicalQty: event.before_physical },
          { physicalQty: event.after_physical },
          remark,
        );
      }
    }
    return {
      skuId,
      skuCode: b.skuCode,
      adjustmentId,
      updatedFields: Object.keys(v).filter(
        (k) => k !== "reason" && k !== "remark",
      ),
    };
  });
}

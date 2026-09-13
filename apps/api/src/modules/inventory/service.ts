import {
  db,
  rows,
  one,
  insert,
  Tx,
  Row,
} from "../../../../../packages/database/src/index.js";
import {
  Context,
  parse,
  id,
  command,
  audit,
  active,
  fail,
  no,
  pagination,
} from "../../core.js";
import { z } from "zod";
export const transitSql =
  "COALESCE((SELECT sum(i.ordered_qty-i.received_qty-i.cancelled_qty)::int FROM purchase_order_items i JOIN purchase_orders p ON p.id=i.purchase_order_id WHERE i.sku_id=s.id AND p.warehouse_id=w.id AND p.status IN ('CONFIRMED','IN_PRODUCTION','SHIPPED','PARTIALLY_RECEIVED')),0)";
export async function balances(q: Row) {
  const p = pagination(q);
  const vals: unknown[] = [];
  const conditions = ["true"];
  for (const [key, col] of Object.entries({
    warehouseId: "w.id",
    skuId: "s.id",
    productId: "s.product_id",
    supplierId: "pr.default_supplier_id",
    categoryId: "pr.category_id",
  }))
    if (q[key]) {
      parse(id, q[key]);
      vals.push(q[key]);
      conditions.push(`${col}=$${vals.length}::bigint`);
    }
  if (q.q) {
    vals.push("%" + String(q.q).slice(0, 100) + "%");
    conditions.push(
      `(s.sku_code ILIKE $${vals.length} OR pr.style_no ILIKE $${vals.length} OR pr.name ILIKE $${vals.length} OR s.barcode ILIKE $${vals.length})`,
    );
  }
  const from = ` FROM skus s JOIN products pr ON pr.id=s.product_id CROSS JOIN warehouses w LEFT JOIN inventory_balances b ON b.sku_id=s.id AND b.warehouse_id=w.id WHERE ${conditions.join(" AND ")}`;
  const data = await rows(
    db,
    `SELECT s.id::text||'-'||w.id::text AS id,s.id AS sku_id,s.sku_code,s.color_name,s.size_name,pr.name AS product_name,pr.style_no,w.id AS warehouse_id,w.name AS warehouse_name,COALESCE(b.physical_qty,0) AS physical_qty,COALESCE(b.reserved_qty,0) AS reserved_qty,COALESCE(b.damaged_qty,0) AS damaged_qty,COALESCE(b.physical_qty-b.reserved_qty-b.damaged_qty,0) AS available_qty,${transitSql} AS in_transit_qty,COALESCE(b.version,0) AS version${from} ORDER BY s.id,w.id LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
    ...vals,
  );
  return {
    data,
    ...p,
    total: (await one(db, "SELECT count(*)::int AS n" + from, ...vals))!.n,
  };
}
export async function snapshot(tx: Tx, sku: string) {
  return (await one(
    tx,
    "SELECT COALESCE((SELECT sum(physical_qty-reserved_qty-damaged_qty)::int FROM inventory_balances WHERE sku_id=$1::bigint),0) AS available,COALESCE((SELECT sum(i.ordered_qty-i.received_qty-i.cancelled_qty)::int FROM purchase_order_items i JOIN purchase_orders p ON p.id=i.purchase_order_id WHERE i.sku_id=$1::bigint AND p.status IN ('CONFIRMED','IN_PRODUCTION','SHIPPED','PARTIALLY_RECEIVED')),0) AS transit",
    sku,
  ))!;
}
export async function movement(
  tx: Tx,
  c: Context,
  warehouseId: string,
  skuId: string,
  delta: number,
  source: Row,
) {
  await rows(
    tx,
    "INSERT INTO inventory_balances(warehouse_id,sku_id) VALUES($1::bigint,$2::bigint) ON CONFLICT DO NOTHING RETURNING id",
    warehouseId,
    skuId,
  );
  const b = (await one(
    tx,
    "SELECT * FROM inventory_balances WHERE warehouse_id=$1::bigint AND sku_id=$2::bigint FOR UPDATE",
    warehouseId,
    skuId,
  ))!;
  if (b.physical_qty + delta < b.reserved_qty + b.damaged_qty)
    fail("INSUFFICIENT_AVAILABLE", "调整后可售库存不能为负", 422);
  await rows(
    tx,
    "UPDATE inventory_balances SET physical_qty=physical_qty+$3::int,version=version+1,updated_at=now() WHERE warehouse_id=$1::bigint AND sku_id=$2::bigint RETURNING id",
    warehouseId,
    skuId,
    delta,
  );
  const event = await insert(tx, "inventory_transactions", {
    warehouseId,
    skuId,
    physicalDelta: delta,
    reservedDelta: 0,
    damagedDelta: 0,
    beforePhysical: b.physical_qty,
    afterPhysical: b.physical_qty + delta,
    beforeReserved: b.reserved_qty,
    afterReserved: b.reserved_qty,
    beforeDamaged: b.damaged_qty,
    afterDamaged: b.damaged_qty,
    operatorId: c.actor.id,
    ...source,
  });
  return event;
}
export async function adjust(c: Context, input: unknown) {
  const b = parse(
    z
      .object({
        skuId: id,
        warehouseId: id,
        quantity: z
          .number()
          .int()
          .min(-10000000)
          .max(10000000)
          .refine((v) => v !== 0),
        reason: z.enum(["OPENING", "STOCKTAKE", "MANUAL"]),
        remark: z.string().trim().min(1).max(1000),
      })
      .strict(),
    input,
  );
  return command(c, "inventory/adjustments", b, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    await active(tx, "warehouses", b.warehouseId);
    await active(tx, "skus", b.skuId);
    const a = await insert(tx, "inventory_adjustments", {
      ...b,
      adjustmentNo: no("ADJ"),
      operatorId: c.actor.id,
    });
    const event = await movement(tx, c, b.warehouseId, b.skuId, b.quantity, {
      transactionType:
        b.reason === "STOCKTAKE" ? "STOCKTAKE" : "STOCK_ADJUSTMENT",
      sourceType: "ADJUSTMENT",
      sourceId: a.id,
      sourceNo: a.adjustment_no,
      adjustmentId: a.id,
      remark: b.remark,
    });
    await audit(
      tx,
      c,
      "ADJUST",
      "inventory",
      a.id,
      { physicalQty: event.before_physical },
      { physicalQty: event.after_physical },
      b.remark,
    );
    return { adjustmentId: a.id, transactionId: event.id };
  });
}
export async function transactions(q: Row) {
  const p = pagination(q),
    vals: unknown[] = [],
    where: string[] = [];
  for (const [key, col] of Object.entries({
    skuId: "t.sku_id",
    warehouseId: "t.warehouse_id",
  }))
    if (q[key]) {
      vals.push(parse(id, q[key]));
      where.push(`${col}=$${vals.length}::bigint`);
    }
  if (q.type) {
    vals.push(q.type);
    where.push(`t.transaction_type=$${vals.length}`);
  }
  const f = ` FROM inventory_transactions t JOIN skus s ON s.id=t.sku_id JOIN warehouses w ON w.id=t.warehouse_id${where.length ? " WHERE " + where.join(" AND ") : ""}`;
  return {
    data: await rows(
      db,
      `SELECT t.*,s.sku_code,w.name AS warehouse_name${f} ORDER BY t.id DESC LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
      ...vals,
    ),
    ...p,
    total: (await one(db, "SELECT count(*)::int AS n" + f, ...vals))!.n,
  };
}

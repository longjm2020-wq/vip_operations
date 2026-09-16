import { rows, Tx } from "../../../../../packages/database/src/index.js";
import { fail } from "../../core.js";
export async function reservedStock(tx: Tx, ids: string[]) {
  if (!ids.length) return [];
  return rows(
    tx,
    `SELECT i.product_id,i.color,i.size,sum(i.quantity)::int AS quantity
    FROM supply_order_items i JOIN supply_orders o ON o.id=i.order_id
    WHERE i.product_id=ANY($1::bigint[]) AND o.status IN ('PENDING','PICKING')
    GROUP BY i.product_id,i.color,i.size`,
    ids,
  );
}
export async function protectReservedStock(
  tx: Tx,
  id: string,
  stock: { color: string; size: string; quantity: number }[],
) {
  for (const r of await reservedStock(tx, [id])) {
    if (
      (stock.find((s) => s.color === r.color && s.size === r.size)?.quantity ??
        0) < r.quantity
    )
      fail(
        "RESERVED_STOCK",
        `${r.color} / ${r.size} 已被采购订单占用 ${r.quantity} 件，库存不能低于占用量，也不能移除该颜色尺码`,
        400,
      );
  }
}

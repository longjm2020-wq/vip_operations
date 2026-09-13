import { z } from "zod";
import { Decimal } from "decimal.js";
import {
  db,
  rows,
  one,
  insert,
  update,
  Tx,
  Row,
} from "../../../../../packages/database/src/index.js";
import { poState } from "../../../../../packages/contracts/src/domain.js";
import {
  Context,
  parse,
  id,
  positive,
  qty,
  money,
  command,
  audit,
  entity,
  state,
  version,
  active,
  fail,
  no,
  pagination,
} from "../../core.js";
import { movement } from "../inventory/service.js";
const item = z
  .object({
    skuId: id,
    orderedQty: positive,
    unitCost: money,
    purchaseSuggestionId: id.optional(),
  })
  .strict();
export const poInput = z
  .object({
    supplierId: id,
    warehouseId: id,
    expectedDeliveryAt: z.iso.datetime({ offset: true }).nullable().optional(),
    remark: z.string().max(1000).optional(),
    items: z.array(item).min(1).max(100),
  })
  .strict();
const receiptItem = z
  .object({
    purchaseOrderItemId: id,
    receivedQty: qty,
    qualifiedQty: qty,
    damagedQty: qty.default(0),
    shortageQty: qty.default(0),
  })
  .strict();
export const receiptInput = z
  .object({
    purchaseOrderId: id,
    warehouseId: id,
    remark: z.string().max(1000).optional(),
    items: z.array(receiptItem).min(1).max(100),
  })
  .strict();
export const cmdInput = z
  .object({
    expectedVersion: qty,
    reason: z.string().trim().min(1).max(1000).optional(),
    receivedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export async function detail(
  table: "purchase_orders" | "receipts",
  value: string,
  tx: Tx = db,
) {
  const r = await entity(tx, table, value);
  const items = await rows(
    tx,
    table === "purchase_orders"
      ? "SELECT i.*,s.sku_code,s.color_name,s.size_name,p.name AS product_name FROM purchase_order_items i JOIN skus s ON s.id=i.sku_id JOIN products p ON p.id=s.product_id WHERE i.purchase_order_id=$1::bigint ORDER BY i.id"
      : "SELECT i.*,s.sku_code,s.color_name,s.size_name,p.ordered_qty,p.received_qty AS cumulative_received_qty FROM receipt_items i JOIN skus s ON s.id=i.sku_id JOIN purchase_order_items p ON p.id=i.purchase_order_item_id WHERE i.receipt_id=$1::bigint ORDER BY i.id",
    value,
  );
  return { ...r, items };
}
export async function list(table: "purchase_orders" | "receipts", q: Row) {
  const p = pagination(q),
    v: unknown[] = [],
    w: string[] = [];
  const cols =
    table === "purchase_orders"
      ? ["supplierId", "warehouseId", "status"]
      : ["purchaseOrderId", "warehouseId", "status"];
  for (const k of cols)
    if (q[k]) {
      v.push(q[k]);
      w.push(
        k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()) +
          `=$${v.length}${k.endsWith("Id") ? "::bigint" : ""}`,
      );
    }
  if (q.productId && table === "purchase_orders") {
    v.push(parse(id, q.productId));
    w.push(
      `EXISTS(SELECT 1 FROM purchase_order_items pi JOIN skus s ON s.id=pi.sku_id WHERE pi.purchase_order_id=purchase_orders.id AND s.product_id=$${v.length}::bigint)`,
    );
  }
  if (q.q) {
    v.push("%" + String(q.q).slice(0, 100) + "%");
    w.push(
      `${table === "purchase_orders" ? "po_no" : "receipt_no"} ILIKE $${v.length}`,
    );
  }
  const f = " FROM " + table + (w.length ? " WHERE " + w.join(" AND ") : "");
  return {
    data: await rows(
      db,
      "SELECT *" +
        f +
        ` ORDER BY id DESC LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
      ...v,
    ),
    ...p,
    total: (await one(db, "SELECT count(*)::int AS n" + f, ...v))!.n,
  };
}
async function addPoItems(tx: Tx, po: Row, items: z.infer<typeof item>[]) {
  let total = new Decimal(0),
    quantity = 0;
  for (const i of items) {
    await active(tx, "skus", i.skuId);
    if (i.purchaseSuggestionId) {
      const s = await entity(
        tx,
        "purchase_suggestions",
        i.purchaseSuggestionId,
        true,
      );
      state(s, ["ACCEPTED", "MODIFIED"]);
      if (
        String(s.sku_id) !== i.skuId ||
        (s.supplier_id && String(s.supplier_id) !== String(po.supplier_id)) ||
        s.actual_purchase_qty !== i.orderedQty
      )
        fail("SUGGESTION_MISMATCH", "采购数量、SKU或供应商与建议不符");
      await update(tx, "purchase_suggestions", i.purchaseSuggestionId, {
        status: "CONVERTED",
      });
    }
    await insert(tx, "purchase_order_items", { ...i, purchaseOrderId: po.id });
    quantity += i.orderedQty;
    total = total.plus(new Decimal(i.unitCost).mul(i.orderedQty));
  }
  return update(tx, "purchase_orders", String(po.id), {
    totalQty: quantity,
    totalAmount: total.toFixed(2),
  });
}
export async function createPo(c: Context, input: unknown) {
  const b = parse(poInput, input);
  return command(c, "purchase-orders/create", b, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    await active(tx, "suppliers", b.supplierId);
    await active(tx, "warehouses", b.warehouseId);
    const { items, ...head } = b;
    const p = await insert(tx, "purchase_orders", {
      ...head,
      poNo: no("PO"),
      buyerId: c.actor.id,
    });
    await addPoItems(tx, p, items);
    const result = await detail("purchase_orders", String(p.id), tx);
    await audit(tx, c, "CREATE", "purchase_order", p.id, null, result);
    return result;
  });
}
export async function editPo(c: Context, value: string, input: unknown) {
  const b = parse(poInput.extend({ expectedVersion: qty }).strict(), input);
  return command(c, "purchase-orders/edit/" + value, b, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    const p = await entity(tx, "purchase_orders", value, true);
    state(p, ["DRAFT"]);
    version(p, b.expectedVersion);
    const linked = await one(
      tx,
      "SELECT id FROM purchase_order_items WHERE purchase_order_id=$1::bigint AND purchase_suggestion_id IS NOT NULL LIMIT 1",
      value,
    );
    if (linked) fail("LINKED_SUGGESTION", "来自建议的明细暂不支持修改");
    await active(tx, "suppliers", b.supplierId);
    await active(tx, "warehouses", b.warehouseId);
    await rows(
      tx,
      "DELETE FROM purchase_order_items WHERE purchase_order_id=$1::bigint RETURNING id",
      value,
    );
    const { items, expectedVersion: _, ...head } = b;
    await update(tx, "purchase_orders", value, {
      ...head,
      version: p.version + 1,
    });
    await addPoItems(tx, { ...p, supplier_id: b.supplierId }, items);
    const result = await detail("purchase_orders", value, tx);
    await audit(tx, c, "EDIT", "purchase_order", value, p, result);
    return result;
  });
}
export async function poCommand(
  c: Context,
  value: string,
  action: string,
  input: unknown,
) {
  const b = parse(cmdInput, input);
  return command(
    c,
    "purchase-orders/" + value + "/" + action,
    b,
    async (tx) => {
      await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
      const p = await entity(tx, "purchase_orders", value, true);
      version(p, b.expectedVersion);
      let next = "";
      if (action === "submit") {
        state(p, ["DRAFT"]);
        next = "PENDING_CONFIRMATION";
      } else if (action === "confirm") {
        state(p, ["PENDING_CONFIRMATION"]);
        await active(tx, "warehouses", String(p.warehouse_id));
        await active(tx, "suppliers", String(p.supplier_id));
        next = "CONFIRMED";
      } else if (action === "cancel") {
        state(p, ["DRAFT", "PENDING_CONFIRMATION", "CONFIRMED"]);
        if (!b.reason) fail("VALIDATION_ERROR", "取消原因必填", 400);
        const busy = await one(
          tx,
          "SELECT EXISTS(SELECT 1 FROM purchase_order_items WHERE purchase_order_id=$1::bigint AND received_qty>0) OR EXISTS(SELECT 1 FROM receipts WHERE purchase_order_id=$1::bigint AND status IN ('DRAFT','RECEIVED')) AS busy",
          value,
        );
        if (busy?.busy) fail("INVALID_STATE", "存在入库或活动入库单，不能取消");
        next = "CANCELLED";
        await rows(
          tx,
          "UPDATE purchase_order_items SET cancelled_qty=ordered_qty-received_qty WHERE purchase_order_id=$1::bigint RETURNING id",
          value,
        );
      } else fail("NOT_FOUND", "命令不存在", 404);
      const result = await update(tx, "purchase_orders", value, {
        status: next,
        version: p.version + 1,
        ...(action === "confirm" ? { orderedAt: new Date() } : {}),
      });
      await audit(tx, c, action, "purchase_order", value, p, result, b.reason);
      return detail("purchase_orders", value, tx);
    },
  );
}
async function addReceiptItems(
  tx: Tx,
  receipt: Row,
  items: z.infer<typeof receiptItem>[],
) {
  const seen = new Set<string>();
  for (const i of items) {
    if (seen.has(i.purchaseOrderItemId))
      fail("VALIDATION_ERROR", "入库明细重复", 400);
    seen.add(i.purchaseOrderItemId);
    const pi = await entity(tx, "purchase_order_items", i.purchaseOrderItemId);
    if (String(pi.purchase_order_id) !== String(receipt.purchase_order_id))
      fail("INVALID_RELATION", "入库明细不属于此采购单", 400);
    if (i.qualifiedQty > i.receivedQty || i.damagedQty > i.receivedQty)
      fail("VALIDATION_ERROR", "验收数量不能超过到货数量", 400);
    await insert(tx, "receipt_items", {
      ...i,
      receiptId: receipt.id,
      skuId: pi.sku_id,
    });
  }
}
export async function createReceipt(c: Context, input: unknown) {
  const b = parse(receiptInput, input);
  return command(c, "receipts/create", b, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    const po = await entity(tx, "purchase_orders", b.purchaseOrderId, true);
    state(po, ["CONFIRMED", "PARTIALLY_RECEIVED"]);
    if (String(po.warehouse_id) !== b.warehouseId)
      fail("INVALID_RELATION", "仓库必须与采购单一致", 400);
    await active(tx, "warehouses", b.warehouseId);
    const { items, ...head } = b;
    const r = await insert(tx, "receipts", {
      ...head,
      receiptNo: no("RC"),
      operatorId: c.actor.id,
    });
    await addReceiptItems(tx, r, items);
    const result = await detail("receipts", String(r.id), tx);
    await audit(tx, c, "CREATE", "receipt", r.id, null, result);
    return result;
  });
}
export async function editReceipt(c: Context, value: string, input: unknown) {
  const b = parse(
    z
      .object({
        expectedVersion: qty,
        items: z.array(receiptItem).min(1).max(100),
        remark: z.string().max(1000).optional(),
      })
      .strict(),
    input,
  );
  return command(c, "receipts/edit/" + value, b, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    const r = await entity(tx, "receipts", value, true);
    state(r, ["DRAFT", "RECEIVED"]);
    version(r, b.expectedVersion);
    await rows(
      tx,
      "DELETE FROM receipt_items WHERE receipt_id=$1::bigint RETURNING id",
      value,
    );
    await addReceiptItems(tx, r, b.items);
    await update(tx, "receipts", value, {
      remark: b.remark,
      version: r.version + 1,
    });
    const result = await detail("receipts", value, tx);
    await audit(tx, c, "EDIT", "receipt", value, r, result);
    return result;
  });
}
export async function receiptCommand(
  c: Context,
  value: string,
  action: string,
  input: unknown,
) {
  const b = parse(cmdInput, input);
  return command(c, "receipts/" + value + "/" + action, b, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
    const peek = await entity(tx, "receipts", value);
    const po = await entity(
      tx,
      "purchase_orders",
      String(peek.purchase_order_id),
      true,
    );
    const r = await entity(tx, "receipts", value, true);
    if (action === "post" && r.status === "POSTED")
      return detail("receipts", value, tx);
    version(r, b.expectedVersion);
    if (action === "mark-received") {
      state(r, ["DRAFT"]);
      if (!b.receivedAt) fail("VALIDATION_ERROR", "到货时间必填", 400);
      await update(tx, "receipts", value, {
        status: "RECEIVED",
        receivedAt: new Date(b.receivedAt!),
        version: r.version + 1,
      });
    } else if (action === "cancel") {
      state(r, ["DRAFT", "RECEIVED"]);
      if (!b.reason) fail("VALIDATION_ERROR", "取消原因必填", 400);
      await update(tx, "receipts", value, {
        status: "CANCELLED",
        version: r.version + 1,
      });
    } else if (action === "post") {
      state(r, ["RECEIVED"]);
      state(po, ["CONFIRMED", "PARTIALLY_RECEIVED"]);
      await active(tx, "warehouses", String(r.warehouse_id));
      const items = await rows(
        tx,
        "SELECT * FROM receipt_items WHERE receipt_id=$1::bigint ORDER BY sku_id,id",
        value,
      );
      for (const i of items) {
        if (
          i.received_qty !== i.qualified_qty ||
          i.qualified_qty <= 0 ||
          i.damaged_qty !== 0 ||
          i.shortage_qty !== 0
        )
          fail(
            "BUSINESS_RULE_PENDING",
            "B01：异常验收规则待确认，暂不能过账",
            422,
          );
        const pi = await entity(
          tx,
          "purchase_order_items",
          String(i.purchase_order_item_id),
          true,
        );
        if (
          i.qualified_qty >
          pi.ordered_qty - pi.received_qty - pi.cancelled_qty
        )
          fail("RECEIPT_EXCEEDS_REMAINING", "入库数量超过采购剩余量");
        await update(tx, "purchase_order_items", String(pi.id), {
          receivedQty: pi.received_qty + i.qualified_qty,
        });
        await movement(
          tx,
          c,
          String(r.warehouse_id),
          String(i.sku_id),
          i.qualified_qty,
          {
            transactionType: "PURCHASE_RECEIPT",
            sourceType: "RECEIPT",
            sourceId: r.id,
            sourceNo: r.receipt_no,
            receiptItemId: i.id,
          },
        );
      }
      const afterItems = await rows(
        tx,
        "SELECT * FROM purchase_order_items WHERE purchase_order_id=$1::bigint",
        String(po.id),
      );
      const afterPo = await update(tx, "purchase_orders", String(po.id), {
        status: poState(afterItems as any),
        version: po.version + 1,
      });
      await update(tx, "receipts", value, {
        status: "POSTED",
        postedAt: new Date(),
        operatorId: c.actor.id,
        version: r.version + 1,
      });
      await audit(tx, c, "RECEIPT_POST", "purchase_order", po.id, po, afterPo);
    } else fail("NOT_FOUND", "命令不存在", 404);
    const result = await detail("receipts", value, tx);
    await audit(tx, c, action, "receipt", value, r, result, b.reason);
    return result;
  });
}

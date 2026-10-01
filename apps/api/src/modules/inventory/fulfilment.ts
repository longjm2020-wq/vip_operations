import { randomInt } from "node:crypto";
import { z } from "zod";
import {
  db,
  one,
  rows,
  insert,
  update,
  Tx,
  Row,
} from "../../../../../packages/database/src/index.js";
import {
  Context,
  parse,
  id,
  qty,
  positive,
  command,
  audit,
  fail,
  entity,
  active,
  state,
  version,
  no,
  requirePermission,
  pagination,
} from "../../core.js";
import { shipmentSchema } from "../../../../../packages/contracts/src/supply-orders.js";
import { movement } from "./service.js";
import { trackingEnabled } from "../../integrations/logistics.js";
import { reservedStock } from "../supply/reservations.js";

const lock = (tx: Tx) => rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
const numberVersion = z.number().int().min(0);
const lineInput = z.object({ itemId: id, quantity: positive }).strict();
const dispatchInput = z
  .object({
    version: numberVersion,
    shipment: shipmentSchema,
    items: z.array(lineInput).min(1).max(200),
  })
  .strict();
export const issueLabels: Record<string, string> = {
  SHORTAGE: "漏发",
  WRONG: "错发",
  DAMAGED: "破损",
  DEFECT: "瑕疵",
  STAIN: "污渍",
  QUALITY: "品质问题",
};
async function purchaseAccess(
  tx: Tx,
  c: Context,
  poId: string,
  dispatch = false,
) {
  const po = await entity(tx, "purchase_orders", poId);
  const account = po.dispatch_account_id
    ? await entity(tx, "supply_accounts", String(po.dispatch_account_id))
    : null;
  const supplier =
    c.actor.permissions.includes("supply.portal") &&
    String(account?.user_id) === c.actor.id;
  if (!supplier)
    requirePermission(c.actor, dispatch ? "purchase.update" : "inventory.read");
  return { po, supplier };
}
async function supplyEvent(tx: Tx, c: Context, poId: string, body: string) {
  const o = await one(
    tx,
    "SELECT id FROM supply_orders WHERE inventory_purchase_order_id=$1::bigint",
    poId,
  );
  if (o) {
    await insert(tx, "supply_order_events", {
      orderId: o.id,
      actorId: c.actor.id,
      body,
    });
    await rows(
      tx,
      "UPDATE supply_orders SET supplier_read_at=NULL,buyer_read_at=NULL,updated_at=now() WHERE id=$1::bigint RETURNING id",
      String(o.id),
    );
  }
}
export async function procurementList(c: Context, q: Row) {
  const p = pagination(q),
    supplier = !c.actor.permissions.includes("inventory.read");
  if (supplier) requirePermission(c.actor, "supply.portal");
  const f = ` FROM purchase_orders p JOIN suppliers s ON s.id=p.supplier_id LEFT JOIN supply_accounts a ON a.id=p.dispatch_account_id LEFT JOIN supply_orders so ON so.inventory_purchase_order_id=p.id WHERE ${supplier ? "a.user_id=$1::bigint" : "true"} AND p.status NOT IN ('DRAFT','PENDING_CONFIRMATION','CANCELLED')`;
  const args = supplier ? [c.actor.id] : [];
  return {
    data: await rows(
      db,
      `SELECT p.*,s.name AS supplier_name,so.id AS supply_order_id,so.order_no AS supply_order_no${f} ORDER BY p.id DESC LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
      ...args,
    ),
    total: (await one(db, "SELECT count(*)::int AS n" + f, ...args))!.n,
    ...p,
  };
}
export async function procurementDetail(c: Context, poId: string, tx: Tx = db) {
  const { po, supplier } = await purchaseAccess(tx, c, poId);
  const items = await rows(
    tx,
    `SELECT i.*,s.sku_code,s.color_name,s.size_name,s.barcode,p.style_no,p.name AS product_name,
 COALESCE((SELECT sum(CASE WHEN sh.status='INSPECTED' THEN x.qualified_qty-x.putaway_qty ELSE x.quantity END)::int FROM inventory_shipment_items x JOIN inventory_shipments sh ON sh.id=x.shipment_id WHERE x.purchase_order_item_id=i.id),0) AS committed_qty
 FROM purchase_order_items i JOIN skus s ON s.id=i.sku_id JOIN products p ON p.id=s.product_id WHERE i.purchase_order_id=$1::bigint ORDER BY i.id`,
    poId,
  );
  const packages = await rows(
    tx,
    "SELECT * FROM inventory_shipments WHERE purchase_order_id=$1::bigint ORDER BY id DESC",
    poId,
  );
  for (const p of packages) {
    if (!supplier && String(p.operator_id) !== c.actor.id)
      delete p.verification_code;
    p.items = await rows(
      tx,
      "SELECT i.*,s.sku_code,s.color_name,s.size_name FROM inventory_shipment_items i JOIN skus s ON s.id=i.sku_id WHERE shipment_id=$1::bigint ORDER BY i.id",
      String(p.id),
    );
  }
  return {
    ...po,
    items,
    packages,
    trackingEnabled: trackingEnabled(),
    supplier,
  };
}
export async function assignSupplier(c: Context, poId: string, input: unknown) {
  requirePermission(c.actor, "purchase.update");
  const b = parse(
    z.object({ version: numberVersion, accountId: id }).strict(),
    input,
  );
  return command(c, "inventory.assign/" + poId, b, async (tx) => {
    await lock(tx);
    const po = await entity(tx, "purchase_orders", poId, true);
    version(po, b.version);
    state(po, ["CONFIRMED", "PARTIALLY_RECEIVED"]);
    if (
      await one(
        tx,
        "SELECT id FROM inventory_shipments WHERE purchase_order_id=$1::bigint LIMIT 1",
        poId,
      )
    )
      fail("INVALID_STATE", "已发货的采购单不能更换供应商账号");
    const a = await entity(tx, "supply_accounts", b.accountId);
    if (!a.effective) fail("INVALID_STATE", "供应商账号尚未通过审核");
    const result = await update(tx, "purchase_orders", poId, {
      dispatchAccountId: b.accountId,
      version: po.version + 1,
    });
    await audit(tx, c, "ASSIGN_DISPATCH", "purchase_order", poId, po, result);
    return result;
  });
}
export async function bindSupply(c: Context, orderId: string, input: unknown) {
  requirePermission(c.actor, "supply.purchase");
  requirePermission(c.actor, "purchase.create");
  const b = parse(
    z
      .object({
        version: numberVersion,
        supplierId: id,
        warehouseId: id,
        items: z
          .array(z.object({ supplyItemId: id, skuId: id }).strict())
          .min(1)
          .max(200),
      })
      .strict(),
    input,
  );
  return command(c, "inventory.bind-supply/" + orderId, b, async (tx) => {
    await lock(tx);
    const o = await entity(tx, "supply_orders", orderId, true);
    version(o, b.version);
    if (o.inventory_purchase_order_id)
      fail("ALREADY_LINKED", "订单已经关联库存采购单");
    state(o, ["PENDING", "PICKING", "SHIPPED", "DELIVERED"]);
    await active(tx, "suppliers", b.supplierId);
    await active(tx, "warehouses", b.warehouseId);
    const source = await rows(
      tx,
      "SELECT * FROM supply_order_items WHERE order_id=$1::bigint ORDER BY id",
      orderId,
    );
    if (
      source.length !== b.items.length ||
      new Set(b.items.map((i) => i.supplyItemId)).size !== source.length ||
      new Set(b.items.map((i) => i.skuId)).size !== source.length
    )
      fail(
        "INVALID_RELATION",
        "请为所有采购明细分别关联一个不同的内部 SKU",
        400,
      );
    const po = await insert(tx, "purchase_orders", {
      poNo: no("PO"),
      supplierId: b.supplierId,
      warehouseId: b.warehouseId,
      buyerId: c.actor.id,
      status: "CONFIRMED",
      orderedAt: new Date(),
      totalQty: o.total_quantity,
      totalAmount: o.total_amount,
      dispatchAccountId: o.account_id,
      trackedReceiving: true,
      remark: "供应链订单 " + o.order_no,
    });
    for (const i of source) {
      const mapping = b.items.find((x) => x.supplyItemId === String(i.id));
      if (!mapping) fail("INVALID_RELATION", "采购明细不属于该订单", 400);
      await active(tx, "skus", mapping.skuId);
      const pi = await insert(tx, "purchase_order_items", {
        purchaseOrderId: po.id,
        skuId: mapping.skuId,
        orderedQty: i.quantity,
        unitCost: String(i.unit_price),
      });
      await rows(
        tx,
        "UPDATE supply_order_items SET inventory_item_id=$2::bigint WHERE id=$1::bigint RETURNING id",
        String(i.id),
        String(pi.id),
      );
    }
    await update(tx, "supply_orders", orderId, {
      inventoryPurchaseOrderId: po.id,
      version: o.version + 1,
    });
    if (["SHIPPED", "DELIVERED"].includes(o.status)) {
      const sh =
        o.shipping_method === "COURIER"
          ? {
              method: "COURIER" as const,
              carrier: o.carrier,
              trackingNo: o.tracking_no,
              note: o.shipping_note,
            }
          : { method: "DELIVERY" as const, note: o.shipping_note };
      await createSupplyPackage(
        tx,
        c,
        { ...o, inventory_purchase_order_id: po.id },
        sh,
        o.status === "DELIVERED",
      );
    }
    await supplyEvent(
      tx,
      c,
      String(po.id),
      "已关联内部 SKU，包裹送达后请逐项盘点质检；合格数量暂存进货仓，正式入库后才增加在仓库存",
    );
    await audit(tx, c, "BIND_INVENTORY", "supply_order", orderId, null, {
      purchaseOrderId: po.id,
      items: b.items,
    });
    return { purchaseOrderId: po.id };
  });
}
// Called inside the supplier order transaction, after supplier stock is deducted.
export async function createSupplyPackage(
  tx: Tx,
  c: Context,
  o: Row,
  sh: z.infer<typeof shipmentSchema>,
  delivered = false,
) {
  if (!o.inventory_purchase_order_id) return;
  const items = await rows(
    tx,
    "SELECT id,ordered_qty FROM purchase_order_items WHERE purchase_order_id=$1::bigint ORDER BY id",
    String(o.inventory_purchase_order_id),
  );
  return createPackage(
    tx,
    c,
    String(o.inventory_purchase_order_id),
    null,
    sh,
    items.map((i) => ({ itemId: String(i.id), quantity: i.ordered_qty })),
    delivered,
  );
}
async function createPackage(
  tx: Tx,
  c: Context,
  poId: string | null,
  transferId: string | null,
  sh: z.infer<typeof shipmentSchema>,
  items: z.infer<typeof lineInput>[],
  delivered = false,
) {
  if (new Set(items.map((i) => i.itemId)).size !== items.length)
    fail("VALIDATION_ERROR", "发货明细重复", 400);
  const parent = await entity(
    tx,
    poId ? "purchase_orders" : "inventory_transfers",
    (poId || transferId)!,
    true,
  );
  if (poId) {
    state(parent, [
      "CONFIRMED",
      "IN_PRODUCTION",
      "SHIPPED",
      "PARTIALLY_RECEIVED",
    ]);
    if (
      await one(
        tx,
        "SELECT id FROM receipts WHERE purchase_order_id=$1::bigint AND status IN ('DRAFT','RECEIVED') LIMIT 1",
        poId,
      )
    )
      fail("INVALID_STATE", "请先处理或取消旧到货单，再使用配送质检流程");
  } else state(parent, ["DRAFT"]);
  await active(
    tx,
    "warehouses",
    String(poId ? parent.warehouse_id : parent.to_warehouse_id),
  );
  const details: Row[] = [];
  for (const i of items) {
    const line = await entity(
      tx,
      poId ? "purchase_order_items" : "inventory_transfer_items",
      i.itemId,
      true,
    );
    if (
      String(poId ? line.purchase_order_id : line.transfer_id) !==
      (poId || transferId)
    )
      fail("INVALID_RELATION", "发货明细不属于该订单", 400);
    await active(tx, "skus", String(line.sku_id));
    const committed = poId
      ? (await one(
          tx,
          `SELECT COALESCE(sum(CASE WHEN s.status='INSPECTED' THEN i.qualified_qty-i.putaway_qty ELSE i.quantity END),0)::int AS n FROM inventory_shipment_items i JOIN inventory_shipments s ON s.id=i.shipment_id WHERE i.purchase_order_item_id=$1::bigint`,
          i.itemId,
        ))!.n
      : 0;
    const remaining = poId
      ? line.ordered_qty - line.received_qty - line.cancelled_qty - committed
      : line.quantity;
    if (i.quantity > remaining)
      fail("QUANTITY_EXCEEDED", "发货数量超过尚未履约的 SKU 数量");
    details.push({ ...line, dispatchQty: i.quantity });
  }
  const courier = sh.method === "COURIER";
  const pkg = await insert(tx, "inventory_shipments", {
    shipmentNo: no("PKG"),
    purchaseOrderId: poId,
    transferId,
    warehouseId: poId ? parent.warehouse_id : parent.to_warehouse_id,
    method: sh.method,
    carrier: courier ? sh.carrier : null,
    trackingNo: courier ? sh.trackingNo.toUpperCase() : null,
    verificationCode: courier ? null : String(randomInt(1000, 10000)),
    note: sh.note,
    operatorId: c.actor.id,
    status: delivered ? "DELIVERED" : "SHIPPED",
    deliveredAt: delivered ? new Date() : null,
    nextPollAt: courier && !delivered ? new Date() : null,
  });
  for (const i of details) {
    await insert(tx, "inventory_shipment_items", {
      shipmentId: pkg.id,
      skuId: i.sku_id,
      purchaseOrderItemId: poId ? i.id : null,
      transferItemId: poId ? null : i.id,
      quantity: i.dispatchQty,
    });
    if (!poId)
      await movement(
        tx,
        c,
        String(parent.from_warehouse_id),
        String(i.sku_id),
        -i.dispatchQty,
        {
          transactionType: "TRANSFER_OUT",
          transferItemId: i.id,
          sourceType: "TRANSFER",
          sourceId: parent.id,
          sourceNo: parent.transfer_no,
          remark: parent.remark,
        },
      );
  }
  if (poId)
    await update(tx, "purchase_orders", poId, {
      trackedReceiving: true,
      version: parent.version + 1,
    });
  else
    await update(tx, "inventory_transfers", transferId!, {
      status: "SHIPPED",
      version: parent.version + 1,
    });
  await audit(tx, c, "SHIP", "inventory_shipment", pkg.id, null, {
    ...pkg,
    items,
  });
  return pkg;
}
export async function dispatchPurchase(
  c: Context,
  poId: string,
  input: unknown,
) {
  const b = parse(dispatchInput, input);
  return command(c, "inventory.dispatch/" + poId, b, async (tx) => {
    await lock(tx);
    const { po, supplier } = await purchaseAccess(tx, c, poId, true);
    version(po, b.version);
    const so = await one(
      tx,
      "SELECT * FROM supply_orders WHERE inventory_purchase_order_id=$1::bigint FOR UPDATE",
      poId,
    );
    if (so) {
      if (!supplier) fail("FORBIDDEN", "已关联供应链订单由对应供应商发货", 403);
      state(so, ["SHIPPED", "DELIVERED"]);
      if (
        !(await one(
          tx,
          "SELECT id FROM inventory_shipments WHERE purchase_order_id=$1::bigint LIMIT 1",
          poId,
        ))
      )
        fail("INVALID_STATE", "首次发货请使用订单中心的发货操作");
      const source = await rows(
        tx,
        "SELECT i.*,p.document FROM supply_order_items i JOIN supply_products p ON p.id=i.product_id WHERE i.order_id=$1::bigint ORDER BY i.product_id",
        String(so.id),
      );
      const products = await rows(
        tx,
        "SELECT * FROM supply_products WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE",
        [...new Set(source.map((i) => String(i.product_id)))],
      );
      for (const prod of products) {
        const reserved = await reservedStock(tx, [String(prod.id)]);
        for (const i of b.items) {
          const orig = source.find(
            (s) =>
              String(s.inventory_item_id) === i.itemId &&
              String(s.product_id) === String(prod.id),
          );
          if (!orig) continue;
          const stock = prod.document.stock.find(
            (s: Row) => s.color === orig.color && s.size === orig.size,
          );
          const held =
            reserved.find(
              (s: Row) => s.color === orig.color && s.size === orig.size,
            )?.quantity || 0;
          if (!stock || stock.quantity - held < i.quantity)
            fail("INSUFFICIENT_STOCK", "供应商可用库存不足，请先更新可发库存");
          stock.quantity -= i.quantity;
        }
        await update(tx, "supply_products", String(prod.id), {
          document: JSON.stringify(prod.document),
          version: prod.version + 1,
        });
      }
    }
    const pkg = await createPackage(tx, c, poId, null, b.shipment, b.items);
    await supplyEvent(
      tx,
      c,
      poId,
      "供应商已安排新包裹 " +
        pkg.shipment_no +
        "；无需物流配送的核销码请交给接收方核验",
    );
    return pkg;
  });
}
export async function shipmentDetail(c: Context, pkgId: string, tx: Tx = db) {
  const p = await entity(tx, "inventory_shipments", pkgId);
  if (p.purchase_order_id) {
    const { supplier } = await purchaseAccess(
      tx,
      c,
      String(p.purchase_order_id),
    );
    if (!supplier && String(p.operator_id) !== c.actor.id)
      delete p.verification_code;
  } else {
    requirePermission(c.actor, "inventory.read");
    if (String(p.operator_id) !== c.actor.id) delete p.verification_code;
  }
  return {
    ...p,
    items: await rows(
      tx,
      "SELECT i.*,s.sku_code,s.color_name,s.size_name,p.style_no FROM inventory_shipment_items i JOIN skus s ON s.id=i.sku_id JOIN products p ON p.id=s.product_id WHERE shipment_id=$1::bigint ORDER BY i.id",
      pkgId,
    ),
    trackingEnabled: trackingEnabled(),
  };
}
export async function receivePackage(
  c: Context,
  pkgId: string,
  input: unknown,
) {
  requirePermission(c.actor, "receipt.update");
  const b = parse(
    z
      .object({
        version: numberVersion,
        code: z
          .string()
          .regex(/^\d{4}$/)
          .optional(),
        signedNote: z.string().trim().min(1).max(1000).optional(),
      })
      .strict(),
    input,
  );
  const delivered = await command(
    c,
    "inventory.deliver/" + pkgId,
    b,
    async (tx) => {
      await lock(tx);
      const p = await entity(tx, "inventory_shipments", pkgId, true);
      version(p, b.version);
      state(p, ["SHIPPED"]);
      if (p.method === "DELIVERY") {
        const attempts = await one(
          tx,
          "SELECT *,started_at>now()-interval '15 minutes' AS recent FROM inventory_verification_attempts WHERE shipment_id=$1::bigint AND actor_id=$2::bigint",
          pkgId,
          c.actor.id,
        );
        if (attempts?.recent && attempts.attempts >= 10)
          return { verificationError: "TOO_MANY_ATTEMPTS" };
        if (b.code !== p.verification_code) {
          await rows(
            tx,
            "INSERT INTO inventory_verification_attempts(shipment_id,actor_id,attempts) VALUES($1::bigint,$2::bigint,1) ON CONFLICT(shipment_id,actor_id) DO UPDATE SET attempts=CASE WHEN inventory_verification_attempts.started_at>now()-interval '15 minutes' THEN inventory_verification_attempts.attempts+1 ELSE 1 END,started_at=CASE WHEN inventory_verification_attempts.started_at>now()-interval '15 minutes' THEN inventory_verification_attempts.started_at ELSE now() END RETURNING attempts",
            pkgId,
            c.actor.id,
          );
          await audit(
            tx,
            c,
            "VERIFICATION_FAILED",
            "inventory_shipment",
            pkgId,
            null,
            { verified: false },
          );
          return { verificationError: "INVALID_CODE" };
        }
      } else if (!b.signedNote)
        fail("VALIDATION_ERROR", "人工签收需要填写实际签收凭证或说明", 400);
      const result = await update(tx, "inventory_shipments", pkgId, {
        status: "DELIVERED",
        deliveredAt: new Date(),
        nextPollAt: null,
        pollToken: null,
        version: p.version + 1,
        note:
          p.note + (b.signedNote ? "\n接收方人工签收：" + b.signedNote : ""),
      });
      if (p.purchase_order_id) {
        await rows(
          tx,
          "UPDATE supply_orders SET status='DELIVERED',delivered_at=now(),version=version+1,updated_at=now() WHERE inventory_purchase_order_id=$1::bigint AND status='SHIPPED' RETURNING id",
          String(p.purchase_order_id),
        );
        await supplyEvent(
          tx,
          c,
          String(p.purchase_order_id),
          "接收方已确认包裹 " + p.shipment_no + " 送达，尚未完成 SKU 盘点质检",
        );
      }
      await audit(
        tx,
        c,
        "PACKAGE_DELIVERED",
        "inventory_shipment",
        pkgId,
        p,
        result,
      );
      return result;
    },
  );
  if (delivered.verificationError)
    fail(
      delivered.verificationError,
      delivered.verificationError === "INVALID_CODE"
        ? "发货核销码不正确，请与发货方核对"
        : "核销码连续错误次数过多，请 15 分钟后重试",
      delivered.verificationError === "INVALID_CODE" ? 422 : 429,
    );
  return delivered;
}
export async function correctShipment(
  c: Context,
  pkgId: string,
  input: unknown,
) {
  const b = parse(
    z
      .object({
        version: numberVersion,
        shipment: shipmentSchema,
        reason: z.string().trim().min(1).max(1000),
      })
      .strict(),
    input,
  );
  return command(c, "inventory.correct-tracking/" + pkgId, b, async (tx) => {
    await lock(tx);
    const p = await entity(tx, "inventory_shipments", pkgId, true);
    version(p, b.version);
    state(p, ["SHIPPED"]);
    if (p.purchase_order_id)
      await purchaseAccess(tx, c, String(p.purchase_order_id), true);
    else requirePermission(c.actor, "inventory.adjust");
    if (p.method !== "COURIER" || b.shipment.method !== "COURIER")
      fail("INVALID_STATE", "仅未签收的快递包裹可更正单号");
    const result = await update(tx, "inventory_shipments", pkgId, {
      carrier: b.shipment.carrier,
      trackingNo: b.shipment.trackingNo.toUpperCase(),
      note: b.shipment.note,
      tracking: "{}",
      trackingError: "",
      trackingCheckedAt: null,
      nextPollAt: new Date(),
      pollToken: null,
      version: p.version + 1,
    });
    if (p.purchase_order_id) {
      await rows(
        tx,
        "UPDATE supply_orders SET carrier=$2,tracking_no=$3,tracking='{}',tracking_error='',poll_token=NULL,version=version+1,updated_at=now() WHERE inventory_purchase_order_id=$1::bigint AND status='SHIPPED' AND carrier=$4 AND tracking_no=$5 RETURNING id",
        String(p.purchase_order_id),
        b.shipment.carrier,
        b.shipment.trackingNo.toUpperCase(),
        p.carrier,
        p.tracking_no,
      );
      await supplyEvent(
        tx,
        c,
        String(p.purchase_order_id),
        "包裹 " + p.shipment_no + " 已更正快递信息：" + b.reason,
      );
    }
    await audit(
      tx,
      c,
      "CORRECT_TRACKING",
      "inventory_shipment",
      pkgId,
      p,
      result,
      b.reason,
    );
    return result;
  });
}
export async function inspectPackage(
  c: Context,
  pkgId: string,
  input: unknown,
) {
  requirePermission(c.actor, "receipt.update");
  const b = parse(
    z
      .object({
        version: numberVersion,
        items: z
          .array(
            z
              .object({
                itemId: id,
                qualifiedQty: qty,
                issues: z
                  .array(
                    z
                      .object({
                        type: z.enum([
                          "SHORTAGE",
                          "WRONG",
                          "DAMAGED",
                          "DEFECT",
                          "STAIN",
                          "QUALITY",
                        ]),
                        quantity: positive,
                      })
                      .strict(),
                  )
                  .max(6)
                  .default([]),
                note: z.string().trim().max(1000).default(""),
              })
              .strict(),
          )
          .min(1)
          .max(200),
      })
      .strict(),
    input,
  );
  return command(c, "inventory.inspect/" + pkgId, b, async (tx) => {
    await lock(tx);
    const p = await entity(tx, "inventory_shipments", pkgId, true);
    version(p, b.version);
    state(p, ["DELIVERED"]);
    const items = await rows(
      tx,
      "SELECT * FROM inventory_shipment_items WHERE shipment_id=$1::bigint ORDER BY id FOR UPDATE",
      pkgId,
    );
    if (
      items.length !== b.items.length ||
      new Set(b.items.map((i) => i.itemId)).size !== items.length
    )
      fail("VALIDATION_ERROR", "请完整核对本包裹所有 SKU", 400);
    for (const i of items) {
      const r = b.items.find((x) => x.itemId === String(i.id));
      if (!r) fail("INVALID_RELATION", "质检明细不属于该包裹", 400);
      const bad = r.issues.reduce((n, x) => n + x.quantity, 0);
      if (
        r.qualifiedQty + bad !== i.quantity ||
        new Set(r.issues.map((x) => x.type)).size !== r.issues.length
      )
        fail(
          "INVALID_QUANTITY",
          "合格数量与各项问题数量合计必须等于发货数量，同一件商品只计入一种问题",
          422,
        );
      if (bad > 0 && !r.note)
        fail("VALIDATION_ERROR", "问题数量需要填写反馈说明", 400);
      await rows(
        tx,
        "UPDATE inventory_shipment_items SET qualified_qty=$2::int,issues=$3::jsonb,issue_note=$4 WHERE id=$1::bigint RETURNING id",
        String(i.id),
        r.qualifiedQty,
        JSON.stringify(r.issues),
        r.note,
      );
      if (bad > 0 && p.purchase_order_id)
        await supplyEvent(
          tx,
          c,
          String(p.purchase_order_id),
          "包裹 " +
            p.shipment_no +
            " SKU " +
            String(i.sku_id) +
            " 盘点质检反馈：" +
            r.issues
              .map((x) => issueLabels[x.type] + x.quantity + "件")
              .join("、") +
            "；" +
            r.note +
            "。请核对后再次安排发货，可重新选择配送方式。",
        );
    }
    const result = await update(tx, "inventory_shipments", pkgId, {
      status: "INSPECTED",
      inspectedAt: new Date(),
      version: p.version + 1,
    });
    await audit(tx, c, "SKU_INSPECTION", "inventory_shipment", pkgId, p, b);
    return result;
  });
}
export async function staging(c: Context, q: Row) {
  requirePermission(c.actor, "inventory.read");
  const p = pagination(q);
  const f =
    " FROM inventory_shipment_items i JOIN inventory_shipments sh ON sh.id=i.shipment_id JOIN skus s ON s.id=i.sku_id LEFT JOIN purchase_orders po ON po.id=sh.purchase_order_id LEFT JOIN inventory_transfers t ON t.id=sh.transfer_id WHERE sh.status='INSPECTED' AND i.qualified_qty>i.putaway_qty";
  return {
    data: await rows(
      db,
      `SELECT i.*,sh.shipment_no,sh.warehouse_id,sh.transfer_id,sh.purchase_order_id,s.sku_code,s.color_name,s.size_name,po.po_no,t.transfer_no${f} ORDER BY i.id LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
    ),
    total: (await one(db, "SELECT count(*)::int AS n" + f))!.n,
    ...p,
  };
}
export async function putaway(c: Context, input: unknown) {
  requirePermission(c.actor, "receipt.post");
  const b = parse(
    z.object({ itemId: id, quantity: positive, warehouseId: id }).strict(),
    input,
  );
  return command(c, "inventory.putaway", b, async (tx) => {
    await lock(tx);
    const i = await entity(tx, "inventory_shipment_items", b.itemId, true),
      p = await entity(tx, "inventory_shipments", String(i.shipment_id), true);
    state(p, ["INSPECTED"]);
    await active(tx, "warehouses", b.warehouseId);
    await active(tx, "skus", String(i.sku_id));
    if (b.quantity > i.qualified_qty - i.putaway_qty)
      fail("QUANTITY_EXCEEDED", "数量超过进货仓待入库合格数量");
    if (p.transfer_id && String(p.warehouse_id) !== b.warehouseId)
      fail("INVALID_RELATION", "调拨货品必须入调拨单指定的目标仓库", 400);
    const record = await insert(tx, "inventory_putaways", {
      shipmentItemId: i.id,
      warehouseId: b.warehouseId,
      quantity: b.quantity,
      operatorId: c.actor.id,
    });
    await movement(tx, c, b.warehouseId, String(i.sku_id), b.quantity, {
      transactionType: p.purchase_order_id
        ? "PROCUREMENT_PUTAWAY"
        : "TRANSFER_IN",
      putawayId: record.id,
      sourceType: p.purchase_order_id ? "PROCUREMENT" : "TRANSFER",
      sourceId: p.purchase_order_id || p.transfer_id,
      sourceNo: p.shipment_no,
      remark: "盘点质检合格后正式入库",
    });
    await rows(
      tx,
      "UPDATE inventory_shipment_items SET putaway_qty=putaway_qty+$2::int WHERE id=$1::bigint RETURNING id",
      b.itemId,
      b.quantity,
    );
    if (p.purchase_order_id) {
      await rows(
        tx,
        "UPDATE purchase_order_items SET received_qty=received_qty+$2::int,updated_at=now() WHERE id=$1::bigint RETURNING id",
        String(i.purchase_order_item_id),
        b.quantity,
      );
      await rows(
        tx,
        "UPDATE purchase_orders SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM purchase_order_items WHERE purchase_order_id=$1::bigint AND received_qty+cancelled_qty<ordered_qty) THEN 'COMPLETED' ELSE 'PARTIALLY_RECEIVED' END,version=version+1,updated_at=now() WHERE id=$1::bigint RETURNING id",
        String(p.purchase_order_id),
      );
    } else {
      await rows(
        tx,
        "UPDATE inventory_transfer_items SET received_qty=received_qty+$2::int WHERE id=$1::bigint RETURNING id",
        String(i.transfer_item_id),
        b.quantity,
      );
      await rows(
        tx,
        "UPDATE inventory_transfers SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_transfer_items WHERE transfer_id=$1::bigint AND received_qty<quantity) THEN 'COMPLETED' ELSE status END,version=version+1,updated_at=now() WHERE id=$1::bigint RETURNING id",
        String(p.transfer_id),
      );
    }
    await audit(tx, c, "PUTAWAY", "inventory_putaway", record.id, null, record);
    return record;
  });
}
export async function transferList(c: Context, q: Row) {
  requirePermission(c.actor, "inventory.read");
  const p = pagination(q);
  return {
    data: await rows(
      db,
      `SELECT t.*,f.name AS from_warehouse_name,w.name AS to_warehouse_name FROM inventory_transfers t JOIN warehouses f ON f.id=t.from_warehouse_id JOIN warehouses w ON w.id=t.to_warehouse_id ORDER BY t.id DESC LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`,
    ),
    total: (await one(
      db,
      "SELECT count(*)::int AS n FROM inventory_transfers",
    ))!.n,
    ...p,
  };
}
export async function transferDetail(c: Context, transferId: string) {
  requirePermission(c.actor, "inventory.read");
  const t = await entity(db, "inventory_transfers", transferId);
  const packages = await rows(
    db,
    "SELECT id FROM inventory_shipments WHERE transfer_id=$1::bigint ORDER BY id",
    transferId,
  );
  return {
    ...t,
    items: await rows(
      db,
      "SELECT i.*,s.sku_code,s.color_name,s.size_name FROM inventory_transfer_items i JOIN skus s ON s.id=i.sku_id WHERE transfer_id=$1::bigint ORDER BY i.id",
      transferId,
    ),
    packages: await Promise.all(
      packages.map((p) => shipmentDetail(c, String(p.id))),
    ),
  };
}
export async function createTransfer(c: Context, input: unknown) {
  requirePermission(c.actor, "inventory.adjust");
  const b = parse(
    z
      .object({
        fromWarehouseId: id,
        toWarehouseId: id,
        remark: z.string().trim().min(1).max(1000),
        items: z
          .array(z.object({ skuId: id, quantity: positive }).strict())
          .min(1)
          .max(200),
      })
      .strict(),
    input,
  );
  return command(c, "inventory.transfer.create", b, async (tx) => {
    await lock(tx);
    if (
      b.fromWarehouseId === b.toWarehouseId ||
      new Set(b.items.map((i) => i.skuId)).size !== b.items.length
    )
      fail("VALIDATION_ERROR", "源仓与目标仓不能相同，SKU 不能重复", 400);
    await active(tx, "warehouses", b.fromWarehouseId);
    await active(tx, "warehouses", b.toWarehouseId);
    const t = await insert(tx, "inventory_transfers", {
      transferNo: no("TR"),
      fromWarehouseId: b.fromWarehouseId,
      toWarehouseId: b.toWarehouseId,
      remark: b.remark,
      operatorId: c.actor.id,
    });
    for (const i of b.items) {
      await active(tx, "skus", i.skuId);
      await insert(tx, "inventory_transfer_items", { transferId: t.id, ...i });
    }
    await audit(tx, c, "CREATE", "inventory_transfer", t.id, null, b);
    return t;
  });
}
export async function dispatchTransfer(
  c: Context,
  transferId: string,
  input: unknown,
) {
  requirePermission(c.actor, "inventory.adjust");
  const b = parse(
    z.object({ version: numberVersion, shipment: shipmentSchema }).strict(),
    input,
  );
  return command(
    c,
    "inventory.transfer.dispatch/" + transferId,
    b,
    async (tx) => {
      await lock(tx);
      const t = await entity(tx, "inventory_transfers", transferId, true);
      version(t, b.version);
      await active(tx, "warehouses", String(t.from_warehouse_id));
      const lines = await rows(
        tx,
        "SELECT * FROM inventory_transfer_items WHERE transfer_id=$1::bigint ORDER BY id",
        transferId,
      );
      return createPackage(
        tx,
        c,
        null,
        transferId,
        b.shipment,
        lines.map((i) => ({ itemId: String(i.id), quantity: i.quantity })),
      );
    },
  );
}
export async function cancelTransfer(
  c: Context,
  transferId: string,
  input: unknown,
) {
  requirePermission(c.actor, "inventory.adjust");
  const b = parse(
    z
      .object({
        version: numberVersion,
        reason: z.string().trim().min(1).max(1000),
      })
      .strict(),
    input,
  );
  return command(
    c,
    "inventory.transfer.cancel/" + transferId,
    b,
    async (tx) => {
      await lock(tx);
      const t = await entity(tx, "inventory_transfers", transferId, true);
      version(t, b.version);
      state(t, ["DRAFT"]);
      const r = await update(tx, "inventory_transfers", transferId, {
        status: "CANCELLED",
        version: t.version + 1,
      });
      await audit(
        tx,
        c,
        "CANCEL",
        "inventory_transfer",
        transferId,
        t,
        r,
        b.reason,
      );
      return r;
    },
  );
}
export async function saveReference(c: Context, skuId: string, input: unknown) {
  requirePermission(c.actor, "inventory.adjust");
  const b = parse(
    z
      .object({
        articleNo: z.string().trim().max(100).default(""),
        dailySales: z.number().min(0).max(1000000).nullable(),
        returnRate: z.number().min(0).max(1).nullable(),
        estimatedReturns: qty.nullable(),
        targetDays: z.number().int().min(1).max(365),
        sourceNote: z.string().trim().min(1).max(500),
        referenceDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .refine(
            (d) =>
              !Number.isNaN(Date.parse(d)) &&
              new Date(d).toISOString().slice(0, 10) === d,
          ),
      })
      .strict(),
    input,
  );
  return command(c, "inventory.reference/" + skuId, b, async (tx) => {
    await lock(tx);
    await entity(tx, "skus", skuId);
    const old = await one(
      tx,
      "SELECT * FROM inventory_sku_references WHERE sku_id=$1::bigint",
      skuId,
    );
    const result = old
      ? await update(tx, "inventory_sku_references", String(old.id), {
          ...b,
          updatedBy: c.actor.id,
        })
      : await insert(tx, "inventory_sku_references", {
          ...b,
          skuId,
          updatedBy: c.actor.id,
        });
    await audit(
      tx,
      c,
      "REFERENCE",
      "inventory_reference",
      skuId,
      old || null,
      result,
    );
    return result;
  });
}

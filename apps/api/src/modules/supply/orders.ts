import { z } from "zod";
import { Decimal } from "decimal.js";
import {
  db,
  one,
  rows,
  Tx,
  Row,
} from "../../../../../packages/database/src/index.js";
import {
  Context,
  fail,
  parse,
  command,
  audit,
  version,
  no,
  id,
  requirePermission,
} from "../../core.js";
import {
  purchaseOrderSchema,
  orderActionSchema,
  carriers,
  recipientSchema,
} from "../../../../../packages/contracts/src/supply-orders.js";
import { reservedStock } from "./reservations.js";
import { trackingEnabled } from "../../integrations/logistics.js";
const canBuy = (c: Context) => c.actor.permissions.includes("supply.purchase");
export async function orderSettings(c: Context) {
  requirePermission(c.actor, "supply.purchase");
  return {
    recipient:
      (await one(db, "SELECT recipient FROM supply_order_settings WHERE id=1"))
        ?.recipient || null,
    trackingEnabled: trackingEnabled(),
  };
}
export async function saveOrderSettings(c: Context, input: unknown) {
  requirePermission(c.actor, "supply.purchase");
  const b = parse(z.object({ recipient: recipientSchema }).strict(), input);
  return command(c, "supply.order.settings", b, async (tx) => {
    await rows(
      tx,
      "INSERT INTO supply_order_settings(id,recipient,updated_by) VALUES(1,$1::jsonb,$2::bigint) ON CONFLICT(id) DO UPDATE SET recipient=excluded.recipient,updated_by=excluded.updated_by,updated_at=now() RETURNING id",
      JSON.stringify(b.recipient),
      c.actor.id,
    );
    await audit(
      tx,
      c,
      "SUPPLY_RECIPIENT_UPDATE",
      "supply_order_settings",
      "1",
      null,
      { updated: true },
    );
    return { saved: true };
  });
}
async function supplierId(c: Context) {
  requirePermission(c.actor, "supply.portal");
  const a = await one(
    db,
    "SELECT id FROM supply_accounts WHERE user_id=$1::bigint AND effective IS NOT NULL",
    c.actor.id,
  );
  if (!a) fail("FORBIDDEN", "入驻审核通过后才能处理采购订单", 403);
  return String(a.id);
}
async function accessible(tx: Tx, c: Context, orderId: string, lock = false) {
  const o = await one(
    tx,
    "SELECT o.*,a.user_id FROM supply_orders o JOIN supply_accounts a ON a.id=o.account_id WHERE o.id=$1::bigint" +
      (lock ? " FOR UPDATE OF o" : ""),
    orderId,
  );
  if (
    !o ||
    (!canBuy(c) &&
      !(
        c.actor.permissions.includes("supply.portal") &&
        String(o.user_id) === c.actor.id
      ))
  )
    fail("NOT_FOUND", "订单不存在或无权查看", 404);
  return o;
}
export async function orderList(c: Context, q: Row) {
  const f = parse(
    z.object({
      internal: z.enum(["0", "1"]).default("0"),
      status: z
        .enum(["", "PENDING", "PICKING", "SHIPPED", "DELIVERED", "CANCELLED"])
        .default(""),
      search: z.string().trim().max(100).default(""),
      page: z.coerce.number().int().min(1).default(1),
    }),
    q,
  );
  const internal = f.internal === "1";
  if (internal) requirePermission(c.actor, "supply.purchase");
  const account = internal ? null : await supplierId(c);
  const where =
    "($1::bigint IS NULL OR o.account_id=$1::bigint) AND ($2='' OR o.status=$2) AND ($3='' OR o.order_no ILIKE $4 OR o.supplier_name ILIKE $4)";
  const args = [account, f.status, f.search, "%" + f.search + "%"];
  const total = await one(
    db,
    "SELECT count(*)::int AS n FROM supply_orders o WHERE " + where,
    ...args,
  );
  const data = await rows(
    db,
    `SELECT o.*,u.display_name AS buyer_name FROM supply_orders o JOIN users u ON u.id=o.buyer_id WHERE ${where} ORDER BY o.id DESC LIMIT 20 OFFSET $5`,
    ...args,
    (f.page - 1) * 20,
  );
  return { data, total: total!.n };
}
export async function orderDetail(c: Context, orderId: string) {
  const order = await accessible(db, c, orderId);
  const items = await rows(
    db,
    "SELECT * FROM supply_order_items WHERE order_id=$1::bigint ORDER BY id",
    orderId,
  );
  const events = await rows(
    db,
    "SELECT e.*,u.display_name AS actor_name FROM supply_order_events e LEFT JOIN users u ON u.id=e.actor_id WHERE order_id=$1::bigint ORDER BY e.id DESC",
    orderId,
  );
  return { ...order, items, events, trackingEnabled: trackingEnabled() };
}
export async function orderNotices(c: Context, q: Row) {
  const internal = q.internal === "1";
  if (internal) requirePermission(c.actor, "supply.purchase");
  const account = internal ? null : await supplierId(c);
  const col = internal ? "buyer_read_at" : "supplier_read_at";
  const where = `($1::bigint IS NULL OR account_id=$1::bigint) AND ${col} IS NULL`;
  const count = await one(
    db,
    `SELECT count(*)::int AS n FROM supply_orders WHERE ${where}`,
    account,
  );
  const items = await rows(
    db,
    `SELECT id,order_no,status,supplier_name FROM supply_orders WHERE ${where} ORDER BY updated_at DESC LIMIT 8`,
    account,
  );
  return { count: count!.n, items, trackingEnabled: trackingEnabled() };
}
export async function readOrder(c: Context, orderId: string, input: unknown) {
  const b = parse(z.object({ internal: z.boolean() }).strict(), input);
  if (b.internal) requirePermission(c.actor, "supply.purchase");
  return command(c, "supply.order.read/" + orderId, b, async (tx) => {
    const o = await accessible(tx, c, orderId, true);
    if (!b.internal && String(o.user_id) !== c.actor.id)
      fail("FORBIDDEN", "无权处理此供应商订单", 403);
    const col = b.internal ? "buyer_read_at" : "supplier_read_at";
    await rows(
      tx,
      `UPDATE supply_orders SET ${col}=now() WHERE id=$1::bigint RETURNING id`,
      orderId,
    );
    return { id: orderId };
  });
}
export async function purchaseQuote(c: Context, q: Row) {
  requirePermission(c.actor, "supply.purchase");
  const accountId = parse(id, q.accountId);
  const ids = parse(
    z.array(id).min(1).max(100),
    typeof q.ids === "string" ? q.ids.split(",") : [],
  );
  const products = await rows(
    db,
    "SELECT p.* FROM supply_products p JOIN supply_accounts a ON a.id=p.account_id WHERE p.id=ANY($1::bigint[]) AND p.account_id=$2::bigint AND a.effective IS NOT NULL ORDER BY p.id",
    ids,
    accountId,
  );
  if (products.length !== new Set(ids).size)
    fail("NOT_FOUND", "部分产品不存在或不属于该供应商", 404);
  const reserved = await reservedStock(db, ids);
  return products.map((p) => ({
    ...p,
    availableStock: p.document.stock.map((s: Row) => ({
      ...s,
      quantity: Math.max(
        0,
        s.quantity -
          (reserved.find(
            (r) =>
              String(r.product_id) === String(p.id) &&
              r.color === s.color &&
              r.size === s.size,
          )?.quantity || 0),
      ),
    })),
  }));
}
export async function createOrder(c: Context, input: unknown) {
  requirePermission(c.actor, "supply.purchase");
  const b = parse(purchaseOrderSchema, input);
  if (
    b.requiredDate <
    new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  )
    fail("VALIDATION_ERROR", "要求送达日期不能早于今天", 400);
  return command(c, "supply.order.create", b, async (tx) => {
    const settings = await one(
      tx,
      "SELECT recipient FROM supply_order_settings WHERE id=1 FOR SHARE",
    );
    if (!settings)
      fail("VALIDATION_ERROR", "请先在采购订单中设置统一收货信息", 400);
    const recipient = parse(recipientSchema, settings.recipient);
    const a = await one(
      tx,
      "SELECT * FROM supply_accounts WHERE id=$1::bigint AND effective IS NOT NULL FOR UPDATE",
      b.accountId,
    );
    if (!a) fail("NOT_FOUND", "供应商未通过入驻审核", 404);
    const ids = [...new Set(b.items.map((i) => i.productId))];
    const products = await rows(
      tx,
      "SELECT * FROM supply_products WHERE account_id=$1::bigint AND id=ANY($2::bigint[]) ORDER BY id FOR UPDATE",
      b.accountId,
      ids,
    );
    if (products.length !== ids.length)
      fail("NOT_FOUND", "产品不存在或供应商不匹配", 404);
    const reserved = await reservedStock(tx, ids);
    let total = new Decimal(0),
      quantity = 0;
    const items = b.items.map((i) => {
      const p = products.find((p) => String(p.id) === i.productId)!;
      version(p, i.version);
      if (
        p.status !== "ON" ||
        !p.document.stockConfirmed ||
        p.document.colors.some(
          (color: string) =>
            !p.document.images.some((im: Row) => im.color === color),
        )
      )
        fail(
          "INVALID_STATE",
          `${p.supplier_style} 须上架并完成库存及颜色图维护后才能采购`,
        );
      const stock = p.document.stock.find(
        (s: Row) => s.color === i.color && s.size === i.size,
      );
      const used =
        reserved.find(
          (r) =>
            String(r.product_id) === i.productId &&
            r.color === i.color &&
            r.size === i.size,
        )?.quantity || 0;
      if (!stock || stock.quantity - used < i.quantity)
        fail(
          "INSUFFICIENT_STOCK",
          `${p.supplier_style} ${i.color}/${i.size} 可采购库存不足，请刷新清单`,
        );
      const price = new Decimal(p.document.taxPrice).toDecimalPlaces(2);
      total = total.plus(price.times(i.quantity));
      quantity += i.quantity;
      return {
        ...i,
        price: price.toFixed(2),
        snapshot: {
          supplierStyle: p.supplier_style,
          xutiStyle: p.xuti_style,
          name: p.document.name,
          material: p.document.material,
          reorderCycle: p.document.reorderCycle,
          netPrice: p.document.netPrice,
        },
      };
    });
    const o = await one(
      tx,
      "INSERT INTO supply_orders(order_no,account_id,buyer_id,supplier_name,recipient,requirement,required_date,total_quantity,total_amount,buyer_read_at) VALUES($1,$2::bigint,$3::bigint,$4,$5::jsonb,$6,$7::date,$8,$9::numeric,now()) RETURNING *",
      no("SC"),
      b.accountId,
      c.actor.id,
      a.effective.shortName,
      JSON.stringify(recipient),
      b.requirement,
      b.requiredDate,
      quantity,
      total.toFixed(2),
    );
    for (const i of items)
      await rows(
        tx,
        "INSERT INTO supply_order_items(order_id,product_id,color,size,quantity,unit_price,snapshot) VALUES($1::bigint,$2::bigint,$3,$4,$5,$6::numeric,$7::jsonb) RETURNING id",
        String(o!.id),
        i.productId,
        i.color,
        i.size,
        i.quantity,
        i.price,
        JSON.stringify(i.snapshot),
      );
    await event(tx, c, String(o!.id), "采购清单已推送供应商，请按要求接单配货");
    await audit(tx, c, "SUPPLY_ORDER_CREATE", "supply_order", o!.id, null, {
      orderNo: o!.order_no,
      quantity,
      total: total.toFixed(2),
    });
    return { id: o!.id, orderNo: o!.order_no };
  });
}
async function event(tx: Tx, c: Context, orderId: string, body: string) {
  await rows(
    tx,
    "INSERT INTO supply_order_events(order_id,actor_id,body) VALUES($1::bigint,$2::bigint,$3) RETURNING id",
    orderId,
    c.actor.id,
    body,
  );
}
export async function orderAction(c: Context, orderId: string, input: unknown) {
  const b = parse(orderActionSchema, input);
  return command(c, "supply.order.action/" + orderId, b, async (tx) => {
    const o = await accessible(tx, c, orderId, true);
    version(o, b.version);
    if (b.action === "CANCEL") requirePermission(c.actor, "supply.purchase");
    else if (
      !c.actor.permissions.includes("supply.portal") ||
      String(o.user_id) !== c.actor.id
    )
      fail("FORBIDDEN", "仅对应供应商可以配货、发货或反馈送达", 403);
    let status = o.status,
      body = "";
    if (b.action === "CANCEL") {
      if (!["PENDING", "PICKING"].includes(o.status))
        fail("INVALID_STATE", "仅未发货订单可取消");
      status = "CANCELLED";
      body = "采购订单已取消：" + b.reason;
    } else if (b.action === "ACCEPT") {
      if (o.status !== "PENDING") fail("INVALID_STATE", "该订单已接单或已关闭");
      status = "PICKING";
      body = "供应商已接单，开始按清单配货";
    } else if (b.action === "DELIVER") {
      if (o.status !== "SHIPPED" || o.shipping_method !== "DELIVERY")
        fail(
          "INVALID_STATE",
          "只有送货上门订单可反馈送达，快递订单须等待物流签收",
        );
      status = "DELIVERED";
      body = "供应商反馈送货上门已送达：" + b.note;
      await rows(
        tx,
        "UPDATE supply_orders SET delivered_at=now() WHERE id=$1::bigint RETURNING id",
        orderId,
      );
    } else {
      const correction = b.action === "CORRECT_TRACKING";
      if (
        correction
          ? o.status !== "SHIPPED" ||
            o.shipping_method !== "COURIER" ||
            b.shipment.method !== "COURIER"
          : o.status !== "PICKING"
      )
        fail("INVALID_STATE", "当前状态不允许此发货操作");
      if (!correction) {
        const items = await rows(
          tx,
          "SELECT * FROM supply_order_items WHERE order_id=$1::bigint",
          orderId,
        );
        const ids = [...new Set(items.map((i) => String(i.product_id)))];
        const products = await rows(
          tx,
          "SELECT * FROM supply_products WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE",
          ids,
        );
        for (const p of products) {
          for (const i of items.filter(
            (i) => String(i.product_id) === String(p.id),
          )) {
            const s = p.document.stock.find(
              (s: Row) => s.color === i.color && s.size === i.size,
            );
            if (!s || s.quantity < i.quantity)
              fail("INSUFFICIENT_STOCK", "库存不足，请核对后发货");
            s.quantity -= i.quantity;
          }
          await rows(
            tx,
            "UPDATE supply_products SET document=$2::jsonb,version=version+1,updated_at=now() WHERE id=$1::bigint RETURNING id",
            String(p.id),
            JSON.stringify(p.document),
          );
        }
      }
      const sh = b.shipment,
        courier = sh.method === "COURIER";
      await rows(
        tx,
        "UPDATE supply_orders SET shipping_method=$2,carrier=$3,tracking_no=$4,shipping_note=$5,tracking='{}',tracking_error='',tracking_checked_at=NULL,next_poll_at=CASE WHEN $6 THEN now() ELSE NULL END,poll_token=NULL,shipped_at=coalesce(shipped_at,now()) WHERE id=$1::bigint RETURNING id",
        orderId,
        sh.method,
        courier ? sh.carrier : null,
        courier ? sh.trackingNo.toUpperCase() : null,
        sh.note,
        courier,
      );
      status = "SHIPPED";
      body =
        (correction
          ? "已更正快递信息（" + b.reason + "）"
          : "供应商已整单发货") +
        (courier
          ? "：" +
            carriers.find((c) => c.value === sh.carrier)!.label +
            " " +
            sh.trackingNo
          : "，选择送货上门");
    }
    await rows(
      tx,
      "UPDATE supply_orders SET status=$2,version=version+1,updated_at=now(),buyer_read_at=CASE WHEN $3 THEN now() ELSE NULL END,supplier_read_at=CASE WHEN $3 THEN NULL ELSE now() END WHERE id=$1::bigint RETURNING id",
      orderId,
      status,
      b.action === "CANCEL",
    );
    await event(tx, c, orderId, body);
    await audit(
      tx,
      c,
      "SUPPLY_ORDER_" + b.action,
      "supply_order",
      orderId,
      { status: o.status },
      { status },
    );
    return { id: orderId, status };
  });
}

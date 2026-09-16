import { Decimal } from "decimal.js";
import { one, rows, Tx } from "../../../../../packages/database/src/index.js";
import {
  Context,
  parse,
  command,
  requirePermission,
  fail,
  version,
  no,
  audit,
} from "../../core.js";
import {
  aftersaleCreateSchema,
  aftersaleActionSchema,
  aftersaleKinds,
} from "../../../../../packages/contracts/src/supply-aftersales.js";
import { accessible } from "./orders.js";
async function notify(
  tx: Tx,
  c: Context,
  orderId: string,
  body: string,
  internal: boolean,
) {
  await rows(
    tx,
    "UPDATE supply_orders SET version=version+1,updated_at=now(),buyer_read_at=CASE WHEN $2 THEN now() ELSE NULL END,supplier_read_at=CASE WHEN $2 THEN NULL ELSE now() END WHERE id=$1::bigint RETURNING id",
    orderId,
    internal,
  );
  await rows(
    tx,
    "INSERT INTO supply_order_events(order_id,actor_id,body) VALUES($1::bigint,$2::bigint,$3) RETURNING id",
    orderId,
    c.actor.id,
    body,
  );
}
export async function createAftersale(
  c: Context,
  orderId: string,
  input: unknown,
) {
  requirePermission(c.actor, "supply.purchase");
  const b = parse(aftersaleCreateSchema, input);
  return command(c, "supply.aftersale.create/" + orderId, b, async (tx) => {
    const order = await accessible(tx, c, orderId, true);
    version(order, b.version);
    if (order.status !== "DELIVERED")
      fail(
        "INVALID_STATE",
        "交易成功后才能发起退货退款或换货；未发货订单请使用取消订单",
      );
    const items = await rows(
      tx,
      "SELECT * FROM supply_order_items WHERE order_id=$1::bigint ORDER BY id",
      orderId,
    );
    const used = await rows(
      tx,
      "SELECT ai.order_item_id,sum(ai.quantity)::int AS quantity FROM supply_aftersale_items ai JOIN supply_aftersales a ON a.id=ai.aftersale_id WHERE a.order_id=$1::bigint AND (a.status NOT IN ('DONE','REJECTED','CANCELLED') OR (a.status='DONE' AND a.kind='REFUND')) GROUP BY ai.order_item_id",
      orderId,
    );
    let amount = new Decimal(0),
      quantity = 0;
    const lines = b.items.map((i) => {
      const original = items.find((x) => String(x.id) === i.orderItemId);
      const consumed =
        used.find((x) => String(x.order_item_id) === i.orderItemId)?.quantity ||
        0;
      if (!original || i.quantity > original.quantity - consumed)
        fail(
          "VALIDATION_ERROR",
          "售后数量超出可申请量，请核对已退款及正在处理的售后",
          400,
        );
      amount = amount.plus(new Decimal(original.unit_price).times(i.quantity));
      quantity += i.quantity;
      return { ...i, price: String(original.unit_price) };
    });
    const a = await one(
      tx,
      "INSERT INTO supply_aftersales(case_no,order_id,kind,reason,requested_by,total_quantity,amount) VALUES($1,$2::bigint,$3,$4,$5::bigint,$6,$7::numeric) RETURNING *",
      no("AS"),
      orderId,
      b.kind,
      b.reason,
      c.actor.id,
      quantity,
      b.kind === "REFUND" ? amount.toFixed(2) : "0.00",
    );
    for (const i of lines)
      await rows(
        tx,
        "INSERT INTO supply_aftersale_items(aftersale_id,order_item_id,quantity,unit_price) VALUES($1::bigint,$2::bigint,$3,$4::numeric) RETURNING id",
        String(a!.id),
        i.orderItemId,
        i.quantity,
        i.price,
      );
    await notify(
      tx,
      c,
      orderId,
      `${a!.case_no} 已发起${aftersaleKinds[b.kind]}，${quantity}件：${b.reason}`,
      true,
    );
    await audit(
      tx,
      c,
      "SUPPLY_AFTERSALE_CREATE",
      "supply_aftersale",
      a!.id,
      null,
      { kind: b.kind, quantity, amount: a!.amount },
    );
    return { id: a!.id, caseNo: a!.case_no };
  });
}
export async function aftersaleAction(
  c: Context,
  orderId: string,
  caseId: string,
  input: unknown,
) {
  const b = parse(aftersaleActionSchema, input);
  return command(c, "supply.aftersale.action/" + caseId, b, async (tx) => {
    // Lock the parent first for all actions and new applications: quantity allocations serialize.
    const order = await accessible(tx, c, orderId, true);
    const a = await one(
      tx,
      "SELECT * FROM supply_aftersales WHERE id=$1::bigint AND order_id=$2::bigint FOR UPDATE",
      caseId,
      orderId,
    );
    if (!a) fail("NOT_FOUND", "售后申请不存在", 404);
    version(a, b.version);
    const internal = ["CANCEL", "RETURN", "COMPLETE"].includes(b.action);
    if (internal) requirePermission(c.actor, "supply.purchase");
    else if (
      !c.actor.permissions.includes("supply.portal") ||
      String(order.user_id) !== c.actor.id
    )
      fail("FORBIDDEN", "仅对应供应商可以处理此售后申请", 403);
    let status = a.status,
      body = "";
    const at = (expected: string[]) => {
      if (!expected.includes(a.status))
        fail("INVALID_STATE", "售后状态已变化，当前不能执行此操作");
    };
    switch (b.action) {
      case "ACCEPT":
        at(["REQUESTED"]);
        status = "ACCEPTED";
        body = "供应商同意申请并提供退货地址";
        await rows(
          tx,
          "UPDATE supply_aftersales SET return_recipient=$2::jsonb WHERE id=$1::bigint RETURNING id",
          caseId,
          JSON.stringify(b.recipient),
        );
        break;
      case "REJECT":
        at(["REQUESTED"]);
        status = "REJECTED";
        body = "供应商驳回申请";
        break;
      case "CANCEL":
        at(["REQUESTED", "ACCEPTED"]);
        status = "CANCELLED";
        body = "序缇撤销售后申请";
        break;
      case "RETURN":
        at(["ACCEPTED"]);
        status = "RETURNING";
        body = "序缇已退回商品";
        await rows(
          tx,
          "UPDATE supply_aftersales SET return_shipment=$2::jsonb WHERE id=$1::bigint RETURNING id",
          caseId,
          JSON.stringify(b.shipment),
        );
        break;
      case "RECEIVE":
        at(["RETURNING"]);
        status = "RECEIVED";
        body = "供应商确认退货已收到";
        break;
      case "REPLACE":
        at(["RECEIVED"]);
        if (a.kind !== "EXCHANGE")
          fail("INVALID_STATE", "只有换货申请可以登记补发");
        status = "REPLACEMENT_SHIPPED";
        body = "供应商已发出换货商品";
        await rows(
          tx,
          "UPDATE supply_aftersales SET replacement_shipment=$2::jsonb WHERE id=$1::bigint RETURNING id",
          caseId,
          JSON.stringify(b.shipment),
        );
        break;
      case "COMPLETE":
        at(a.kind === "REFUND" ? ["RECEIVED"] : ["REPLACEMENT_SHIPPED"]);
        status = "DONE";
        body =
          a.kind === "REFUND"
            ? "序缇确认退货退款处理完成，自动扣减货款"
            : "序缇确认换货商品已收妥，换货完成且不扣货款";
        await rows(
          tx,
          "UPDATE supply_aftersales SET completed_at=now() WHERE id=$1::bigint RETURNING id",
          caseId,
        );
        await rows(
          tx,
          "INSERT INTO supply_statement_entries(source_key,order_id,account_id,aftersale_id,kind,amount,quantity,occurred_at) VALUES($1,$2::bigint,$3::bigint,$4::bigint,$5,$6::numeric,$7,now())",
          a.kind + ":" + caseId,
          orderId,
          String(order.account_id),
          caseId,
          a.kind,
          a.kind === "REFUND"
            ? new Decimal(a.amount).negated().toFixed(2)
            : "0.00",
          a.total_quantity,
        );
        break;
    }
    await rows(
      tx,
      "UPDATE supply_aftersales SET status=$2,version=version+1,updated_at=now() WHERE id=$1::bigint RETURNING id",
      caseId,
      status,
    );
    await notify(tx, c, orderId, `${a.case_no} ${body}：${b.note}`, internal);
    await audit(
      tx,
      c,
      "SUPPLY_AFTERSALE_" + b.action,
      "supply_aftersale",
      caseId,
      { status: a.status },
      { status, kind: a.kind, amount: a.amount },
    );
    return { id: caseId, status };
  });
}

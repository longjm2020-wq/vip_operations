import { randomUUID } from "node:crypto";
import { db, one, rows } from "../../../packages/database/src/index.js";
import {
  queryTracking,
  trackingEnabled,
  TrackingInput,
  TrackingResult,
} from "../../api/src/integrations/logistics.js";
export async function pollInventoryLogistics(
  query: (s: TrackingInput) => Promise<TrackingResult> = queryTracking,
) {
  const token = randomUUID();
  const job = await db.$transaction(async (tx) => {
    const p = await one(
      tx,
      "SELECT s.*,o.recipient->>'phone' AS phone FROM inventory_shipments s LEFT JOIN supply_orders o ON o.inventory_purchase_order_id=s.purchase_order_id WHERE s.status='SHIPPED' AND s.method='COURIER' AND s.next_poll_at<=now() ORDER BY s.next_poll_at,s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED",
    );
    if (!p) return null;
    await rows(
      tx,
      "UPDATE inventory_shipments SET poll_token=$2::uuid,next_poll_at=now()+interval '60 minutes' WHERE id=$1::bigint RETURNING id",
      String(p.id),
      token,
    );
    return p;
  });
  if (!job) return false;
  try {
    const result = await query({
      carrier: job.carrier,
      trackingNo: job.tracking_no,
      phone: job.phone,
    });
    await db.$transaction(async (tx) => {
      await rows(tx, "SELECT pg_advisory_xact_lock(91002)::text");
      const p = await one(
        tx,
        "SELECT * FROM inventory_shipments WHERE id=$1::bigint AND poll_token=$2::uuid AND status='SHIPPED' FOR UPDATE",
        String(job.id),
        token,
      );
      if (!p) return;
      await rows(
        tx,
        "UPDATE inventory_shipments SET tracking=$3::jsonb,tracking_error='',tracking_checked_at=now(),poll_token=NULL,status=CASE WHEN $4 THEN 'DELIVERED' ELSE status END,delivered_at=CASE WHEN $4 THEN now() ELSE NULL END,next_poll_at=CASE WHEN $4 THEN NULL ELSE now()+interval '60 minutes' END,version=version+1,updated_at=now() WHERE id=$1::bigint AND poll_token=$2::uuid RETURNING id",
        String(p.id),
        token,
        JSON.stringify(result),
        result.delivered,
      );
      if (p.purchase_order_id) {
        await rows(
          tx,
          "UPDATE supply_orders SET tracking=$2::jsonb,tracking_error='',tracking_checked_at=now(),status=CASE WHEN $3 THEN 'DELIVERED' ELSE status END,delivered_at=CASE WHEN $3 THEN now() ELSE delivered_at END,version=version+1,updated_at=now() WHERE inventory_purchase_order_id=$1::bigint AND carrier=$4 AND tracking_no=$5 AND status='SHIPPED' RETURNING id",
          String(p.purchase_order_id),
          JSON.stringify(result),
          result.delivered,
          p.carrier,
          p.tracking_no,
        );
        if (result.delivered)
          await rows(
            tx,
            "INSERT INTO supply_order_events(order_id,body) SELECT id,$2 FROM supply_orders WHERE inventory_purchase_order_id=$1::bigint RETURNING id",
            String(p.purchase_order_id),
            "物流已确认包裹 " +
              p.shipment_no +
              " 签收，尚未盘点质检，未增加在仓库存",
          );
      }
    });
  } catch {
    await rows(
      db,
      "UPDATE inventory_shipments SET tracking_error='物流查询失败或暂无轨迹，请核对快递信息；系统将自动重试',tracking_checked_at=now(),poll_token=NULL WHERE id=$1::bigint AND poll_token=$2::uuid AND status='SHIPPED' RETURNING id",
      String(job.id),
      token,
    );
  }
  return true;
}
export function startInventoryLogistics() {
  let stopped = false,
    active: Promise<void> | undefined;
  const tick = async () => {
    if (stopped || !trackingEnabled()) return;
    try {
      for (let i = 0; i < 20 && !stopped; i++)
        if (!(await pollInventoryLogistics())) break;
    } catch {
      console.error("INVENTORY_LOGISTICS_UNAVAILABLE");
    }
  };
  const run = () => {
    if (!active)
      active = tick().finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(run, 30000);
  run();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}

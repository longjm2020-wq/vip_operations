import { randomUUID } from "node:crypto";
import { db, one, rows } from "../../../packages/database/src/index.js";
import {
  queryTracking,
  trackingEnabled,
  TrackingInput,
  TrackingResult,
} from "../../api/src/integrations/logistics.js";
// Persisted claims survive restarts and keep multiple workers from querying the same parcel.
export async function pollSupplyLogistics(
  query: (s: TrackingInput) => Promise<TrackingResult> = queryTracking,
) {
  const token = randomUUID();
  const job = await db.$transaction(async (tx) => {
    const o = await one(
      tx,
      "SELECT * FROM supply_orders WHERE status='SHIPPED' AND shipping_method='COURIER' AND next_poll_at<=now() ORDER BY next_poll_at LIMIT 1 FOR UPDATE SKIP LOCKED",
    );
    if (!o) return null;
    await rows(
      tx,
      "UPDATE supply_orders SET poll_token=$2::uuid,next_poll_at=now()+interval '60 minutes' WHERE id=$1::bigint RETURNING id",
      String(o.id),
      token,
    );
    return o;
  });
  if (!job) return false;
  try {
    const result = await query({
      carrier: job.carrier,
      trackingNo: job.tracking_no,
      phone: job.recipient.phone,
    });
    await db.$transaction(async (tx) => {
      const o = await one(
        tx,
        "SELECT * FROM supply_orders WHERE id=$1::bigint AND poll_token=$2::uuid AND status='SHIPPED' FOR UPDATE",
        String(job.id),
        token,
      );
      if (!o) return; // A corrected shipment invalidates any older in-flight response.
      await rows(
        tx,
        "UPDATE supply_orders SET tracking=$3::jsonb,tracking_error='',tracking_checked_at=now(),poll_token=NULL,status=CASE WHEN $4 THEN 'DELIVERED' ELSE status END,delivered_at=CASE WHEN $4 THEN now() ELSE NULL END,next_poll_at=CASE WHEN $4 THEN NULL ELSE now()+interval '60 minutes' END,buyer_read_at=CASE WHEN $4 THEN NULL ELSE buyer_read_at END,supplier_read_at=CASE WHEN $4 THEN NULL ELSE supplier_read_at END,version=version+1,updated_at=now() WHERE id=$1::bigint AND poll_token=$2::uuid RETURNING id",
        String(job.id),
        token,
        JSON.stringify(result),
        result.delivered,
      );
      if (result.delivered)
        await rows(
          tx,
          "INSERT INTO supply_order_events(order_id,body) VALUES($1::bigint,'物流服务已确认快递签收，订单送达完结') RETURNING id",
          String(job.id),
        );
    });
  } catch {
    await rows(
      db,
      "UPDATE supply_orders SET tracking_error='物流查询失败或暂无轨迹，请核对快递信息；系统将自动重试',tracking_checked_at=now(),poll_token=NULL WHERE id=$1::bigint AND poll_token=$2::uuid AND status='SHIPPED' RETURNING id",
      String(job.id),
      token,
    );
  }
  return true;
}
export function startSupplyLogistics() {
  let stopped = false,
    active: Promise<void> | undefined;
  const tick = async () => {
    if (stopped || !trackingEnabled()) return;
    try {
      for (let i = 0; i < 20 && !stopped; i++)
        if (!(await pollSupplyLogistics())) break;
    } catch {
      console.error("SUPPLY_LOGISTICS_UNAVAILABLE");
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

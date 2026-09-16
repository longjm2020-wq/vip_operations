import { createHash } from "node:crypto";
import { z } from "zod";
export const trackingEnabled = () =>
  process.env.LOGISTICS_PROVIDER === "kuaidi100" &&
  !!process.env.KUAIDI100_CUSTOMER &&
  !!process.env.KUAIDI100_KEY;
export type TrackingInput = {
  carrier: string;
  trackingNo: string;
  phone: string;
};
export type TrackingResult = {
  state: string;
  delivered: boolean;
  events: { time: string; context: string }[];
};
const responseSchema = z.object({
  state: z.string(),
  com: z.string(),
  nu: z.string(),
  data: z
    .array(
      z.object({ time: z.string().max(100), context: z.string().max(3000) }),
    )
    .min(1)
    .max(500),
});
export function parseTrackingResponse(
  raw: unknown,
  shipment: TrackingInput,
): TrackingResult {
  const r = responseSchema.safeParse(raw);
  if (
    !r.success ||
    r.data.com !== shipment.carrier ||
    r.data.nu.toUpperCase() !== shipment.trackingNo.toUpperCase()
  )
    throw Error("物流查询未返回有效轨迹，请核对快递公司及单号后等待重试");
  return {
    state: r.data.state,
    delivered: r.data.state === "3",
    events: r.data.data,
  };
}
export async function queryTracking(
  shipment: TrackingInput,
): Promise<TrackingResult> {
  if (!trackingEnabled()) throw Error("待接入物流查询");
  const param = JSON.stringify({
    com: shipment.carrier,
    num: shipment.trackingNo,
    phone: shipment.phone,
    show: "0",
    order: "desc",
  });
  const customer = process.env.KUAIDI100_CUSTOMER!;
  const sign = createHash("md5")
    .update(param + process.env.KUAIDI100_KEY! + customer)
    .digest("hex")
    .toUpperCase();
  const r = await fetch("https://poll.kuaidi100.com/poll/query.do", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ customer, sign, param }),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!r.ok) throw Error("物流服务暂不可用，系统稍后重试");
  const text = await r.text();
  if (text.length > 2000000) throw Error("物流查询响应异常");
  return parseTrackingResponse(JSON.parse(text), shipment);
}

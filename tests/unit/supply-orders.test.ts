import { expect, it } from "vitest";
import {
  purchaseOrderSchema,
  shipmentSchema,
  orderActionSchema,
} from "../../packages/contracts/src/supply-orders.js";
import { parseTrackingResponse } from "../../apps/api/src/integrations/logistics.js";
it("requires real variants, positive integer quantities and a valid date", () => {
  const base = {
    accountId: "1",
    requiredDate: "2026-09-18",
    items: [
      { productId: "1", version: 1, color: "红", size: "S", quantity: 1 },
    ],
  };
  expect(purchaseOrderSchema.safeParse(base).success).toBe(true);
  for (const quantity of [0, -1, 0.5])
    expect(
      purchaseOrderSchema.safeParse({
        ...base,
        items: [{ ...base.items[0], quantity }],
      }).success,
    ).toBe(false);
  expect(
    purchaseOrderSchema.safeParse({
      ...base,
      items: [...base.items, ...base.items],
    }).success,
  ).toBe(false);
  expect(
    purchaseOrderSchema.safeParse({ ...base, requiredDate: "2026-02-30" })
      .success,
  ).toBe(false);
  expect(
    purchaseOrderSchema.safeParse({
      ...base,
      recipient: { name: "cannot override fixed recipient" },
    }).success,
  ).toBe(false);
});
it("requires a courier and valid number and disallows arbitrary delivered status", () => {
  expect(shipmentSchema.safeParse({ method: "DELIVERY" }).success).toBe(true);
  expect(
    shipmentSchema.safeParse({ method: "COURIER", carrier: "shunfeng" })
      .success,
  ).toBe(false);
  expect(
    shipmentSchema.safeParse({
      method: "COURIER",
      carrier: "other",
      trackingNo: "123456",
    }).success,
  ).toBe(false);
  expect(
    orderActionSchema.safeParse({ action: "DELIVER", version: 1, note: " " })
      .success,
  ).toBe(false);
  expect(
    orderActionSchema.safeParse({
      action: "SHIP",
      version: 1,
      status: "DELIVERED",
    }).success,
  ).toBe(false);
});
it("completes express only from a matching carrier and tracking number with state 3", () => {
  const shipment = {
    carrier: "shunfeng",
    trackingNo: "SFTEST123456",
    phone: "13800000000",
  };
  const raw = {
    com: shipment.carrier,
    nu: shipment.trackingNo,
    state: "3",
    data: [{ time: "2026-09-17 12:00:00", context: "已签收" }],
  };
  expect(parseTrackingResponse(raw, shipment).delivered).toBe(true);
  for (const state of ["0", "2", "4", "14"])
    expect(parseTrackingResponse({ ...raw, state }, shipment).delivered).toBe(
      false,
    );
  for (const bad of [
    { ...raw, nu: "DIFFERENT" },
    { ...raw, com: "zhongtong" },
    { ...raw, data: [] },
    { result: false, returnCode: "500" },
  ])
    expect(() => parseTrackingResponse(bad, shipment)).toThrow();
});

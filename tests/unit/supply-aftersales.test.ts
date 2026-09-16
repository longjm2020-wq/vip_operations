import { describe, it, expect } from "vitest";
import {
  aftersaleCreateSchema,
  aftersaleActionSchema,
  statementQuerySchema,
} from "../../packages/contracts/src/supply-aftersales.js";
import { statementPeriod } from "../../packages/contracts/src/supply-statement-period.js";
describe("supplier aftersales and statement periods", () => {
  it("rejects forged refund amounts, duplicate variants and invalid quantities", () => {
    const base = {
      version: 1,
      kind: "REFUND",
      reason: "质量问题",
      items: [{ orderItemId: "1", quantity: 1 }],
    };
    expect(aftersaleCreateSchema.safeParse(base).success).toBe(true);
    for (const value of [0, -1, 1.2])
      expect(
        aftersaleCreateSchema.safeParse({
          ...base,
          items: [{ orderItemId: "1", quantity: value }],
        }).success,
      ).toBe(false);
    expect(
      aftersaleCreateSchema.safeParse({
        ...base,
        items: [...base.items, ...base.items],
      }).success,
    ).toBe(false);
    expect(
      aftersaleCreateSchema.safeParse({ ...base, amount: 0.01 }).success,
    ).toBe(false);
  });
  it("requires processing notes and explicit receiving and shipping data", () => {
    expect(
      aftersaleActionSchema.safeParse({
        action: "COMPLETE",
        version: 1,
        note: "",
      }).success,
    ).toBe(false);
    expect(
      aftersaleActionSchema.safeParse({
        action: "ACCEPT",
        version: 1,
        note: "同意",
      }).success,
    ).toBe(false);
    expect(
      aftersaleActionSchema.safeParse({
        action: "RETURN",
        version: 1,
        note: "已寄出",
        shipment: { method: "COURIER", carrier: "shunfeng", trackingNo: "123" },
      }).success,
    ).toBe(false);
  });
  it("uses inclusive calendar months, quarters, years and validates custom dates", () => {
    expect(statementPeriod("month", 2024, 2)).toEqual({
      from: "2024-02-01",
      to: "2024-02-29",
    });
    expect(statementPeriod("quarter", 2026, 4)).toEqual({
      from: "2026-10-01",
      to: "2026-12-31",
    });
    expect(statementPeriod("year", 2026, 1)).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
    });
    for (const f of [
      { from: "2026-02-30", to: "2026-03-31" },
      { from: "2026-03-31", to: "2026-03-01" },
    ])
      expect(statementQuerySchema.safeParse(f).success).toBe(false);
  });
});

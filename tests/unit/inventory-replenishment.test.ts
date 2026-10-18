import { describe, expect, it } from "vitest";
import {
  calculateReplenishmentPlan,
  planningDemand,
  replenishmentPolicySchema,
  defaultReplenishmentPolicy as defaults,
  type ReplenishmentPolicy,
} from "../../packages/contracts/src/inventory-replenishment.js";

const complete = {
  complete: true,
  days: 30,
  recordedDays: 30,
  salesSamples: 30,
  salesQty: 300,
  ambiguous: false,
  manualDailySales: null,
};
const input = {
  demand: planningDemand(complete),
  availableQty: 0,
  unconfirmedInboundQty: 0,
  referenceReturnRate: 0.5,
};
const policy = (overrides: Partial<ReplenishmentPolicy> = {}) => ({
  ...defaults,
  ...overrides,
});

describe("lead time and delayed reusable return planning", () => {
  it("defaults to 20-day purchases, 15–20-day returns, 95% resale, daily review and no safety buffer", () => {
    expect(defaults).toEqual({
      referencePeriod: "30d", dailySalesMethod: "frequent", returnRateMethod: "frequent",
      purchaseLeadDays: 20,
      returnDaysMin: 15,
      returnDaysMax: 20,
      resalableRate: 0.95,
      reviewDays: 1,
      safetyDays: 0,
      confirmedReturnRate: null,
    });
  });
  it("does not silently deduct unverified daily return ratios", () => {
    const plan = calculateReplenishmentPlan(input, defaults);
    expect(plan).toMatchObject({
      quantity: 210,
      grossQuantity: 210,
      expectedReusableReturnsMin: 4.75,
      expectedReusableReturnsMax: 28.5,
      returnAdjustedQuantityMin: 182,
      returnAdjustedQuantityMax: 206,
      returnRateSource: "unconfirmed",
    });
  });
  it("uses the slow return scenario only after a cohort rate is maintained", () => {
    const plan = calculateReplenishmentPlan(
      input,
      policy({ confirmedReturnRate: 0.5 }),
    );
    expect(plan).toMatchObject({
      quantity: 206,
      grossQuantity: 210,
      returnAdjustedQuantityMin: 182,
      returnAdjustedQuantityMax: 206,
      shortageBeforeArrival: 200,
      returnRateSource: "manual_cohort",
    });
  });
  it.each([
    [3, 0, 40],
    [14, 0, 150],
    [15, 4.75, 156],
    [19, 23.75, 177],
    [20, 28.5, 182],
  ])(
    "credits returns after their lag, not at shipment (purchase %i days)",
    (purchaseLeadDays, returns, quantity) => {
      const plan = calculateReplenishmentPlan(
        input,
        policy({
          purchaseLeadDays,
          returnDaysMin: 15,
          returnDaysMax: 15,
          confirmedReturnRate: 0.5,
        }),
      );
      expect(plan.expectedReusableReturnsMin).toBe(returns);
      expect(plan.quantity).toBe(quantity);
    },
  );
  it("does not discount the safety buffer as if it had already shipped", () => {
    const plan = calculateReplenishmentPlan(
      input,
      policy({ confirmedReturnRate: 0.5, safetyDays: 5 }),
    );
    expect(plan.expectedReusableReturnsMin).toBe(4.75);
    expect(plan.quantity).toBe(256);
  });
  it("does not use inventory in transit without an availability date", () => {
    const plan = calculateReplenishmentPlan(
      { ...input, availableQty: 10, unconfirmedInboundQty: 1000 },
      defaults,
    );
    expect(plan.quantity).toBe(200);
    expect(plan.coverageDays).toBe(1);
    expect(plan.warningCodes).toContain("INBOUND_ETA_UNKNOWN");
    expect(plan.shortageBeforeArrival).toBe(190);
  });
  it("keeps explicit 0% and 0% resale separate from missing rates", () => {
    for (const p of [
      policy({ confirmedReturnRate: 0 }),
      policy({ confirmedReturnRate: 0.5, resalableRate: 0 }),
    ]) {
      const plan = calculateReplenishmentPlan(input, p);
      expect(plan.quantity).toBe(210);
      expect(plan.expectedReusableReturnsMin).toBe(0);
    }
    expect(
      calculateReplenishmentPlan(
        { ...input, referenceReturnRate: null },
        defaults,
      ).expectedReusableReturnsMin,
    ).toBeNull();
  });
  it.each([1.2, -0.1, Infinity, NaN])(
    "never treats an invalid report rate %s as a probability",
    (referenceReturnRate) => {
      const plan = calculateReplenishmentPlan(
        { ...input, referenceReturnRate },
        defaults,
      );
      expect(plan.quantity).toBe(210);
      expect(plan.returnAdjustedQuantityMin).toBeNull();
    },
  );
  it("never recommends negative purchases and keeps zero demand distinct from missing demand", () => {
    expect(
      calculateReplenishmentPlan({ ...input, availableQty: 1000 }, defaults)
        .quantity,
    ).toBe(0);
    const zero = calculateReplenishmentPlan(
      { ...input, demand: planningDemand({ ...complete, salesQty: 0 }) },
      defaults,
    );
    expect(zero.quantity).toBe(0);
    expect(zero.coverageDays).toBeNull();
    const missing = calculateReplenishmentPlan(
      { ...input, demand: planningDemand({ ...complete, complete: false }) },
      defaults,
    );
    expect(missing.quantity).toBeNull();
    expect(missing.warningCodes).toEqual(["MISSING_DEMAND"]);
  });
  it("does not round daily fractions before rounding final procurement units up", () => {
    const demand = planningDemand({
      ...complete,
      salesQty: 2,
      days: 3,
      recordedDays: 3,
      salesSamples: 3,
    });
    expect(
      calculateReplenishmentPlan(
        { ...input, demand },
        policy({ purchaseLeadDays: 2 }),
      ).quantity,
    ).toBe(2);
  });
});

describe("planning demand coverage and parameters", () => {
  it("uses the mean including zero days for a sparse seller whose median is zero", () => {
    const demand = planningDemand({ ...complete, salesQty: 15 });
    expect(demand.dailySales).toBe(0.5);
    expect(
      calculateReplenishmentPlan({ ...input, demand }, defaults).quantity,
    ).toBe(11);
  });
  it.each([
    { complete: false },
    { recordedDays: 29 },
    { salesSamples: 29 },
    { salesQty: null },
    { ambiguous: true },
  ])(
    "does not extrapolate incomplete or ambiguous daily records (%j)",
    (changes) => {
      expect(planningDemand({ ...complete, ...changes }).source).toBe(
        "missing",
      );
      expect(
        planningDemand({ ...complete, ...changes, manualDailySales: "2" }),
      ).toMatchObject({ source: "manual", dailySales: 2 });
    },
  );
  it("validates interval order, probabilities and positive integer lead/review days", () => {
    for (const changes of [
      { returnDaysMin: 21 },
      { resalableRate: 95 },
      { confirmedReturnRate: 1.1 },
      { purchaseLeadDays: 0 },
      { purchaseLeadDays: 3.5 },
      { reviewDays: 0 },
      { safetyDays: -1 },
    ])
      expect(
        replenishmentPolicySchema.safeParse({ ...defaults, ...changes })
          .success,
      ).toBe(false);
    expect(
      replenishmentPolicySchema.parse({ ...defaults, purchaseLeadDays: 3 }),
    ).toMatchObject({ purchaseLeadDays: 3 });
  });
});

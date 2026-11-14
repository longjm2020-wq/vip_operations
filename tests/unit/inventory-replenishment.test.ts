import { describe, expect, it } from "vitest";
import {
  calculateReplenishmentPlan,
  planningDemand,
  planningDemandFromDays,
  replenishmentPolicySchema,
  defaultReplenishmentPolicy as defaults,
  type DemandDay,
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
  it("defaults to 20-day purchases, 15–20-day returns, 95% resale, daily review, 70/30 weights and 95% service level", () => {
    expect(defaults).toEqual({
      referencePeriod: "30d",
      dailySalesMethod: "median",
      returnRateMethod: "median",
      purchaseLeadDays: 20,
      returnDaysMin: 15,
      returnDaysMax: 20,
      resalableRate: 0.95,
      reviewDays: 1,
      safetyDays: 0,
      confirmedReturnRate: null,
      recentWeight: 0.3,
      excludeStockoutDays: true,
      capSpikes: true,
      minValidDays: 7,
      serviceLevel: "95",
      minOrderQty: 0,
      packSize: 1,
      stopDate: null,
      overstockDays: 90,
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

describe("daily demand preprocessing, statistical safety stock, order rounding and season cutoff", () => {
  const makeDays = (
    endDate: string,
    count: number,
    build: (indexFromStart: number, date: string) => { salesQty: number | null; saleableStock?: number | null },
  ): DemandDay[] => {
    const out: DemandDay[] = [];
    for (let i = 0; i < count; i++) {
      const d = new Date(endDate + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - (count - 1 - i));
      const date = d.toISOString().slice(0, 10);
      out.push({ date, ...build(i, date) });
    }
    return out;
  };

  it("excludes zero-sale stockout days from the divisor and falls back to manual when valid days are too few", () => {
    const endDate = "2026-10-30";
    // 20 days selling 5 with stock 10, then 10 days of stockout (sales 0, saleableStock 0)
    const days = makeDays(endDate, 30, (i) =>
      i < 20 ? { salesQty: 5, saleableStock: 10 } : { salesQty: 0, saleableStock: 0 },
    );
    const demand = planningDemandFromDays(
      { complete: true, windowDays: 30, endDate, days, ambiguous: false, manualDailySales: 2 },
      defaults,
    );
    expect(demand).toMatchObject({
      source: "report_weighted",
      validDays: 20,
      windowMean: 5,
      recentMean: null,
      dailySales: 5,
    });
    expect(demand.stockoutDays).toHaveLength(10);

    // Only 5 valid days (< minValidDays 7): falls back to manualDailySales
    const scarce = makeDays(endDate, 30, (i) =>
      i < 5 ? { salesQty: 4, saleableStock: 8 } : { salesQty: 0, saleableStock: 0 },
    );
    const fallback = planningDemandFromDays(
      { complete: true, windowDays: 30, endDate, days: scarce, ambiguous: false, manualDailySales: 3.5 },
      defaults,
    );
    expect(fallback).toMatchObject({
      source: "manual",
      dailySales: 3.5,
      validDays: 5,
    });
  });

  it("treats unrecorded pre-launch days for new products as absent rather than zero sales", () => {
    const endDate = "2026-10-30";
    // Only the last 10 days have records, selling 8/day
    const days = makeDays(endDate, 10, () => ({ salesQty: 8, saleableStock: 20 }));
    const demand = planningDemandFromDays(
      { complete: true, windowDays: 30, endDate, days, ambiguous: false, manualDailySales: null },
      defaults,
    );
    expect(demand).toMatchObject({
      source: "report_weighted",
      validDays: 10,
      noRecordDays: 20,
      dailySales: 8,
    });
  });

  it("caps isolated one-day spikes at Q3 + 3×IQR and blends 70% window mean with 30% recent 7-day mean", () => {
    const endDate = "2026-10-30";
    // 29 days of 5 units, last day bulk order of 65 units
    const days = makeDays(endDate, 30, (i) => ({
      salesQty: i === 29 ? 65 : 5,
      saleableStock: 100,
    }));
    const capped = planningDemandFromDays(
      { complete: true, windowDays: 30, endDate, days, ambiguous: false, manualDailySales: null },
      defaults,
    );
    // Q1=5, Q3=5, IQR=0 -> cap = max(5, 10, 3) = 10
    expect(capped.cap).toBe(10);
    expect(capped.cappedDays).toEqual([{ date: endDate, salesQty: 65, cappedQty: 10 }]);
    expect(capped.dailySales).toBeLessThan(6);

    // Trend shift: 23 days of 4, last 7 days of 10 (no spike cap triggered when disabled)
    const trendDays = makeDays(endDate, 30, (i) => ({
      salesQty: i < 23 ? 4 : 10,
      saleableStock: 50,
    }));
    const trend = planningDemandFromDays(
      { complete: true, windowDays: 30, endDate, days: trendDays, ambiguous: false, manualDailySales: null },
      policy({ capSpikes: false }),
    );
    // Window mean = (23*4 + 7*10)/30 = 162/30 = 5.4; recentMean = 10; 0.7*5.4 + 0.3*10 = 6.78
    expect(trend.windowMean).toBe(5.4);
    expect(trend.recentMean).toBe(10);
    expect(trend.dailySales).toBe(6.78);
  });

  it("adds statistical safety stock, rounds by MOQ/pack size, and stops replenishment past the season end date", () => {
    const endDate = "2026-10-30";
    const days = makeDays(endDate, 30, (i) => ({
      salesQty: i % 2 === 0 ? 4 : 6,
      saleableStock: 30,
    }));
    const demand = planningDemandFromDays(
      { complete: true, windowDays: 30, endDate, days, ambiguous: false, manualDailySales: null },
      defaults,
    );
    expect(demand.stdDev).toBeGreaterThan(1);
    const plan = calculateReplenishmentPlan(
      {
        demand,
        availableQty: 50,
        unconfirmedInboundQty: 0,
        referenceReturnRate: null,
        today: "2026-10-31",
      },
      policy({ minOrderQty: 80, packSize: 12 }),
    );
    expect(plan.safetyStock).toBeGreaterThan(7);
    expect(plan.rawQuantity).toBeGreaterThan(55);
    // MOQ 80 lifted and rounded up to a multiple of 12 -> 84
    expect(plan.quantity).toBe(84);
    expect(plan.status).toBe("URGENT");
    expect(plan.warningCodes).toContain("ORDER_ROUNDED");

    // Season end within lead time (20 days): stopDate is 10 days away -> SEASON_END, 0 purchase
    const seasonEndPlan = calculateReplenishmentPlan(
      {
        demand,
        availableQty: 50,
        unconfirmedInboundQty: 0,
        referenceReturnRate: null,
        today: "2026-10-31",
      },
      policy({ stopDate: "2026-11-09" }),
    );
    expect(seasonEndPlan.status).toBe("SEASON_END");
    expect(seasonEndPlan.quantity).toBe(0);

    // Missing JST warehouse total formula -> MISSING_STOCK
    const noStock = calculateReplenishmentPlan(
      {
        demand,
        availableQty: null,
        unconfirmedInboundQty: 0,
        referenceReturnRate: null,
      },
      defaults,
    );
    expect(noStock.status).toBe("MISSING");
    expect(noStock.warningCodes).toEqual(["MISSING_STOCK"]);
  });
});

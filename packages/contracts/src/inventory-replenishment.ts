import { Decimal } from "decimal.js";
import { z } from "zod";
import { inventoryReferencePeriodSchema } from "./inventory-summary.js";

export const replenishmentPolicySchema = z
  .object({
    referencePeriod: inventoryReferencePeriodSchema.default("30d"),
    dailySalesMethod: z.enum(["frequent", "median", "mode", "mean"]).default("frequent"),
    returnRateMethod: z.enum(["frequent", "median", "mode", "mean"]).default("frequent"),
    purchaseLeadDays: z.number().int().min(1).max(365).default(20),
    reviewDays: z.number().int().min(1).max(90).default(1),
    safetyDays: z.number().int().min(0).max(90).default(0),
    returnDaysMin: z.number().int().min(1).max(365).default(15),
    returnDaysMax: z.number().int().min(1).max(365).default(20),
    resalableRate: z.number().min(0).max(1).default(0.95),
    // Daily report ratios do not identify the originating order cohort. Only an
    // explicitly maintained cohort probability can reduce the primary estimate.
    confirmedReturnRate: z.number().min(0).max(1).nullable().default(null),
  })
  .strict()
  .refine((value) => value.returnDaysMin <= value.returnDaysMax, {
    path: ["returnDaysMax"],
    message: "最长回仓周期不能小于最短回仓周期",
  });
export type ReplenishmentPolicy = z.infer<typeof replenishmentPolicySchema>;
export const defaultReplenishmentPolicy = replenishmentPolicySchema.parse({});
export const replenishmentPolicyWriteSchema = z
  .object({
    revision: z.number().int().min(0),
    policy: replenishmentPolicySchema,
  })
  .strict();

export type PlanningDemand = {
  source: "report_mean" | "manual" | "missing";
  salesQty: number | null;
  days: number;
  dailySales: number | null;
  reason: string | null;
};

/** Missing dates/cells are not zeroes and a median is not a demand forecast. */
export function planningDemand(input: {
  complete: boolean;
  days: number;
  recordedDays: number;
  salesSamples: number;
  salesQty: number | null;
  ambiguous: boolean;
  manualDailySales: unknown;
}): PlanningDemand {
  if (
    input.complete &&
    !input.ambiguous &&
    input.days > 0 &&
    input.recordedDays === input.days &&
    input.salesSamples === input.days &&
    input.salesQty != null &&
    Number.isSafeInteger(input.salesQty) &&
    input.salesQty >= 0
  ) {
    return {
      source: "report_mean",
      salesQty: input.salesQty,
      days: input.days,
      dailySales: new Decimal(input.salesQty)
        .div(input.days)
        .toDecimalPlaces(8)
        .toNumber(),
      reason: null,
    };
  }
  const manual =
    input.manualDailySales == null ? null : Number(input.manualDailySales);
  if (manual != null && Number.isFinite(manual) && manual >= 0)
    return {
      source: "manual",
      salesQty: null,
      days: 0,
      dailySales: manual,
      reason: "报表未提供完整逐日销量，采用已维护的人工日销",
    };
  return {
    source: "missing",
    salesQty: null,
    days: 0,
    dailySales: null,
    reason: "需要此条码在所选期间每天的有效销量；缺失日期或单元格不补0",
  };
}

export function calculateReplenishmentPlan(
  input: {
    demand: PlanningDemand;
    availableQty: number;
    unconfirmedInboundQty: number;
    referenceReturnRate: number | null;
  },
  policy: ReplenishmentPolicy,
) {
  const { demand } = input;
  const base = {
    policy,
    demand,
    availableQty: input.availableQty,
    unconfirmedInboundQty: input.unconfirmedInboundQty,
    horizonDays: policy.purchaseLeadDays + policy.reviewDays,
    returnRateSource:
      policy.confirmedReturnRate == null ? "unconfirmed" : "manual_cohort",
  };
  if (demand.dailySales == null)
    return {
      ...base,
      quantity: null,
      coverageDays: null,
      grossQuantity: null,
      returnAdjustedQuantityMin: null,
      returnAdjustedQuantityMax: null,
      expectedReusableReturnsMin: null,
      expectedReusableReturnsMax: null,
      scenarioReturnRate: null,
      shortageBeforeArrival: null,
      warningCodes: ["MISSING_DEMAND"],
    };

  // Keep the report sum/divisor intact until the final division. Rounding a
  // daily average first can turn a two-unit need into three at ceil().
  const numerator = new Decimal(
    demand.source === "report_mean" ? demand.salesQty! : demand.dailySales,
  );
  const divisor = demand.source === "report_mean" ? demand.days : 1;
  const available = new Decimal(input.availableQty);
  const horizon = base.horizonDays;
  const probability = policy.confirmedReturnRate ?? input.referenceReturnRate;
  const rate =
    probability != null &&
    Number.isFinite(probability) &&
    probability >= 0 &&
    probability <= 1
      ? probability
      : null;
  const eligibleDays = (days: number, lag: number) => Math.max(0, days - lag);
  const reusable = (days: number, lag: number) =>
    rate == null
      ? null
      : numerator
          .mul(eligibleDays(days, lag))
          .mul(rate)
          .mul(policy.resalableRate)
          .div(divisor);
  const needed = (days: number, safetyDays: number, lag?: number) => {
    const returnDays =
      lag === undefined || rate == null ? 0 : eligibleDays(days, lag);
    const netDays = new Decimal(days + safetyDays).minus(
      new Decimal(returnDays).mul(rate ?? 0).mul(policy.resalableRate),
    );
    return Decimal.max(0, numerator.mul(netDays).div(divisor).minus(available))
      .ceil()
      .toNumber();
  };
  const minReturns = reusable(horizon, policy.returnDaysMax);
  const maxReturns = reusable(horizon, policy.returnDaysMin);
  const grossQuantity = needed(horizon, policy.safetyDays);
  const slowQuantity =
    rate == null
      ? null
      : needed(horizon, policy.safetyDays, policy.returnDaysMax);
  const fastQuantity =
    rate == null
      ? null
      : needed(horizon, policy.safetyDays, policy.returnDaysMin);
  const shortageBeforeArrival = needed(
    policy.purchaseLeadDays,
    0,
    policy.confirmedReturnRate == null ? undefined : policy.returnDaysMax,
  );
  const warningCodes = [
    ...(demand.source === "manual" ? ["MANUAL_DEMAND"] : []),
    ...(policy.confirmedReturnRate == null ? ["UNCONFIRMED_RETURN_RATE"] : []),
    ...(input.unconfirmedInboundQty > 0 ? ["INBOUND_ETA_UNKNOWN"] : []),
    ...(shortageBeforeArrival > 0 ? ["LEAD_TIME_GAP"] : []),
  ];
  return {
    ...base,
    quantity: policy.confirmedReturnRate == null ? grossQuantity : slowQuantity,
    coverageDays: numerator.isZero()
      ? null
      : available.mul(divisor).div(numerator).toDecimalPlaces(1).toNumber(),
    grossQuantity,
    scenarioReturnRate: rate,
    returnAdjustedQuantityMin: fastQuantity,
    returnAdjustedQuantityMax: slowQuantity,
    expectedReusableReturnsMin:
      minReturns?.toDecimalPlaces(4).toNumber() ?? null,
    expectedReusableReturnsMax:
      maxReturns?.toDecimalPlaces(4).toNumber() ?? null,
    shortageBeforeArrival,
    warningCodes,
  };
}

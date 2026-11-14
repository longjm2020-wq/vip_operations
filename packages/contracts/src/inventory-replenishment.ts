import { Decimal } from "decimal.js";
import { z } from "zod";
import { inventoryReferencePeriodSchema } from "./inventory-summary.js";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD")
  .refine((value) => {
    const date = new Date(value + "T00:00:00Z");
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "日期无效");

/** One-sided normal quantiles for the cycle service level (probability of no stockout per cycle). */
export const replenishmentServiceLevels = {
  off: { label: "不设统计安全库存", z: null },
  "90": { label: "90%", z: 1.2816 },
  "95": { label: "95%", z: 1.6449 },
  "98": { label: "98%", z: 2.0537 },
} as const;
export type ReplenishmentServiceLevel = keyof typeof replenishmentServiceLevels;

export const replenishmentPolicySchema = z
  .object({
    referencePeriod: inventoryReferencePeriodSchema.default("30d"),
    dailySalesMethod: z.enum(["median", "mode", "mean"]).default("median"),
    returnRateMethod: z.enum(["median", "mode", "mean"]).default("median"),
    purchaseLeadDays: z.number().int().min(1).max(365).default(20),
    reviewDays: z.number().int().min(1).max(90).default(1),
    safetyDays: z.number().int().min(0).max(90).default(0),
    returnDaysMin: z.number().int().min(1).max(365).default(15),
    returnDaysMax: z.number().int().min(1).max(365).default(20),
    resalableRate: z.number().min(0).max(1).default(0.95),
    // Daily report ratios do not identify the originating order cohort. Only an
    // explicitly maintained cohort probability can reduce the primary estimate.
    confirmedReturnRate: z.number().min(0).max(1).nullable().default(null),
    // Demand estimation
    /** Weight of the most recent 7 days; the rest goes to the whole window. */
    recentWeight: z.number().min(0).max(1).default(0.3),
    /** Days with channel saleable stock 0 and no sales are supply-constrained, not zero demand. */
    excludeStockoutDays: z.boolean().default(true),
    /** Cap isolated one-day spikes (e.g. bulk orders) at Q3 + 3×IQR. */
    capSpikes: z.boolean().default(true),
    minValidDays: z.number().int().min(1).max(60).default(7),
    // Buffer and ordering
    serviceLevel: z.enum(["off", "90", "95", "98"]).default("95"),
    minOrderQty: z.number().int().min(0).max(1_000_000).default(0),
    packSize: z.number().int().min(1).max(100_000).default(1),
    /** Last sales day of the season; no purchase is suggested when it arrives after this date. */
    stopDate: isoDate.nullable().default(null),
    overstockDays: z.number().int().min(1).max(730).default(90),
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

export type CappedDay = { date: string; salesQty: number; cappedQty: number };
export type PlanningDemand = {
  source: "report_weighted" | "report_mean" | "manual" | "missing";
  salesQty: number | null;
  days: number;
  dailySales: number | null;
  reason: string | null;
  /** Days that entered the average (in stock, recorded). */
  validDays?: number;
  stockoutDays?: string[];
  noRecordDays?: number;
  windowMean?: number | null;
  recentMean?: number | null;
  recentDays?: number;
  recentWeight?: number;
  stdDev?: number | null;
  cap?: number | null;
  cappedDays?: CappedDay[];
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
  return manualOrMissing(
    input.manualDailySales,
    "需要此条码在所选期间每天的有效销量；缺失日期或单元格不补0",
  );
}

function manualOrMissing(manualDailySales: unknown, reason: string): PlanningDemand {
  const manual = manualDailySales == null ? null : Number(manualDailySales);
  if (manual != null && Number.isFinite(manual) && manual >= 0)
    return {
      source: "manual",
      salesQty: null,
      days: 0,
      dailySales: manual,
      reason: `${reason}；采用已维护的人工日销`,
    };
  return { source: "missing", salesQty: null, days: 0, dailySales: null, reason };
}

export type DemandDay = {
  date: string;
  salesQty: number | null;
  /** Channel (VIP) saleable stock reported for the day; null when unknown. */
  saleableStock?: number | null;
};

const validQty = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function quantile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function addDays(date: string, days: number) {
  const value = new Date(date + "T00:00:00Z");
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);
}

/**
 * Demand from the channel's daily barcode records:
 * - a date without a record, or with saleable stock 0 and no sale, is not
 *   evidence of zero demand and is left out of the divisor;
 * - isolated spikes are capped at Q3 + 3×IQR (at least 2×Q3 and 3 units);
 * - the planning rate blends the window mean with the last 7 days.
 */
export function planningDemandFromDays(
  input: {
    complete: boolean;
    windowDays: number;
    endDate: string | null;
    days: DemandDay[];
    ambiguous: boolean;
    manualDailySales: unknown;
  },
  policy: Pick<
    ReplenishmentPolicy,
    "recentWeight" | "excludeStockoutDays" | "capSpikes" | "minValidDays"
  >,
): PlanningDemand {
  if (!input.complete || !input.endDate || input.windowDays <= 0)
    return manualOrMissing(input.manualDailySales, "所选期间的罗盘报表不完整");
  if (input.ambiguous)
    return manualOrMissing(input.manualDailySales, "同一日期存在重复条码记录，无法确定销量");
  const byDate = new Map<string, DemandDay>();
  for (const day of input.days) {
    if (byDate.has(day.date))
      return manualOrMissing(input.manualDailySales, "同一日期存在重复条码记录，无法确定销量");
    byDate.set(day.date, day);
  }
  if ([...byDate.values()].some((day) => day.salesQty != null && !validQty(day.salesQty)))
    return manualOrMissing(input.manualDailySales, "报表中存在无效销量单元格");

  const recentStart = addDays(input.endDate, -6);
  const valid: { date: string; qty: number }[] = [];
  const stockoutDays: string[] = [];
  let noRecordDays = 0;
  for (let offset = input.windowDays - 1; offset >= 0; offset--) {
    const date = addDays(input.endDate, -offset);
    const day = byDate.get(date);
    if (!day || day.salesQty == null) {
      noRecordDays++;
      continue;
    }
    if (
      policy.excludeStockoutDays &&
      day.salesQty === 0 &&
      day.saleableStock != null &&
      Number(day.saleableStock) <= 0
    ) {
      stockoutDays.push(date);
      continue;
    }
    valid.push({ date, qty: day.salesQty });
  }
  const salesQty = valid.reduce((sum, day) => sum + day.qty, 0);
  const base = {
    salesQty,
    days: input.windowDays,
    validDays: valid.length,
    stockoutDays,
    noRecordDays,
  };
  if (valid.length < policy.minValidDays) {
    const fallback = manualOrMissing(
      input.manualDailySales,
      `有效在售天数 ${valid.length} 天，少于 ${policy.minValidDays} 天（缺货 ${stockoutDays.length} 天、无记录 ${noRecordDays} 天）`,
    );
    return { ...fallback, ...base, salesQty: fallback.salesQty, days: fallback.days };
  }

  const sorted = valid.map((day) => day.qty).sort((a, b) => a - b);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - quantile(sorted, 0.25);
  const cap = policy.capSpikes ? Math.max(q3 + 3 * iqr, 2 * q3, 3) : null;
  const cappedDays: CappedDay[] = [];
  const values = valid.map((day) => {
    if (cap != null && day.qty > cap) {
      const cappedQty = new Decimal(cap).toDecimalPlaces(4).toNumber();
      cappedDays.push({ date: day.date, salesQty: day.qty, cappedQty });
      return { ...day, qty: cappedQty };
    }
    return day;
  });
  const mean = (list: { qty: number }[]) =>
    list.reduce((sum, day) => sum.plus(day.qty), new Decimal(0)).div(list.length);
  const windowMean = mean(values);
  const recent = values.filter((day) => day.date >= recentStart);
  // Fewer than 3 in-stock days in the last week is too thin to tilt the estimate.
  const recentMean = recent.length >= 3 ? mean(recent) : null;
  const weight = recentMean == null ? 0 : policy.recentWeight;
  const daily = windowMean.mul(1 - weight).plus(recentMean?.mul(weight) ?? 0);
  const variance =
    values.length > 1
      ? values
          .reduce((sum, day) => sum.plus(new Decimal(day.qty).minus(windowMean).pow(2)), new Decimal(0))
          .div(values.length - 1)
      : new Decimal(0);
  return {
    source: "report_weighted",
    ...base,
    dailySales: daily.toDecimalPlaces(8).toNumber(),
    reason: null,
    windowMean: windowMean.toDecimalPlaces(8).toNumber(),
    recentMean: recentMean?.toDecimalPlaces(8).toNumber() ?? null,
    recentDays: recent.length,
    recentWeight: weight,
    stdDev: variance.sqrt().toDecimalPlaces(8).toNumber(),
    cap: cap == null ? null : new Decimal(cap).toDecimalPlaces(4).toNumber(),
    cappedDays,
  };
}

export type ReplenishmentStatus =
  | "MISSING"
  | "SEASON_END"
  | "URGENT"
  | "REORDER"
  | "OVERSTOCK"
  | "OK";
export const replenishmentStatusLabels: Record<ReplenishmentStatus, string> = {
  MISSING: "数据不足",
  SEASON_END: "季末不补",
  URGENT: "紧急",
  REORDER: "需补货",
  OVERSTOCK: "滞销",
  OK: "充足",
};

// Fractions from a sum/divisor can carry 1e-9 noise; never let it add a unit at ceil().
const units = (value: Decimal) => Decimal.max(0, value).toDecimalPlaces(6).ceil().toNumber();

export function calculateReplenishmentPlan(
  input: {
    demand: PlanningDemand;
    availableQty: number | null;
    availableStockLabel?: string;
    unconfirmedInboundQty: number;
    referenceReturnRate: number | null;
    /** Business date (Asia/Shanghai) the plan is made on; needed for the season stop date. */
    today?: string | null;
  },
  policy: ReplenishmentPolicy,
) {
  const { demand } = input;
  const z = replenishmentServiceLevels[policy.serviceLevel ?? "off"]?.z ?? null;
  const fullHorizon = policy.purchaseLeadDays + policy.reviewDays;
  const daysToStop =
    policy.stopDate && input.today ? daysBetween(input.today, policy.stopDate) + 1 : null;
  const seasonEnd = daysToStop != null && daysToStop <= policy.purchaseLeadDays;
  const horizon = daysToStop == null ? fullHorizon : Math.max(0, Math.min(fullHorizon, daysToStop));
  const base = {
    policy,
    demand,
    availableQty: input.availableQty,
    availableStockLabel: input.availableStockLabel ?? "在仓总库存",
    unconfirmedInboundQty: input.unconfirmedInboundQty,
    horizonDays: horizon,
    fullHorizonDays: fullHorizon,
    daysToStop,
    serviceLevelZ: z,
    returnRateSource:
      policy.confirmedReturnRate == null ? "unconfirmed" : "manual_cohort",
  };
  const empty = {
    quantity: null,
    rawQuantity: null,
    coverageDays: null,
    grossQuantity: null,
    safetyStock: null,
    targetStock: null,
    returnAdjustedQuantityMin: null,
    returnAdjustedQuantityMax: null,
    expectedReusableReturnsMin: null,
    expectedReusableReturnsMax: null,
    scenarioReturnRate: null,
    shortageBeforeArrival: null,
  };
  if (demand.dailySales == null)
    return { ...base, ...empty, status: "MISSING" as ReplenishmentStatus, warningCodes: ["MISSING_DEMAND"] };
  if (input.availableQty == null || !Number.isFinite(input.availableQty))
    return { ...base, ...empty, status: "MISSING" as ReplenishmentStatus, warningCodes: ["MISSING_STOCK"] };

  // Keep the report sum/divisor intact until the final division. Rounding a
  // daily average first can turn a two-unit need into three at ceil().
  const numerator = new Decimal(
    demand.source === "report_mean" ? demand.salesQty! : demand.dailySales,
  );
  const divisor = demand.source === "report_mean" ? demand.days : 1;
  const daily = numerator.div(divisor);
  const available = new Decimal(input.availableQty);
  const probability = policy.confirmedReturnRate ?? input.referenceReturnRate;
  const rate =
    probability != null &&
    Number.isFinite(probability) &&
    probability >= 0 &&
    probability <= 1
      ? probability
      : null;
  const sigma = demand.stdDev ?? null;
  const safetyStock =
    z != null && sigma != null && horizon > 0
      ? new Decimal(z).mul(sigma).mul(Math.sqrt(horizon))
      : new Decimal(0);
  const eligibleDays = (days: number, lag: number) => Math.max(0, days - lag);
  const reusable = (days: number, lag: number) =>
    rate == null
      ? null
      : numerator
          .mul(eligibleDays(days, lag))
          .mul(rate)
          .mul(policy.resalableRate)
          .div(divisor);
  const target = (days: number, safetyDays: number, buffer: Decimal, lag?: number) => {
    const returnDays =
      lag === undefined || rate == null ? 0 : eligibleDays(days, lag);
    const netDays = new Decimal(days + safetyDays).minus(
      new Decimal(returnDays).mul(rate ?? 0).mul(policy.resalableRate),
    );
    return numerator.mul(netDays).div(divisor).plus(buffer);
  };
  const needed = (days: number, safetyDays: number, buffer: Decimal, lag?: number) =>
    units(target(days, safetyDays, buffer, lag).minus(available));
  const extraDays = seasonEnd ? 0 : policy.safetyDays;
  const minReturns = reusable(horizon, policy.returnDaysMax);
  const maxReturns = reusable(horizon, policy.returnDaysMin);
  const grossQuantity = needed(horizon, extraDays, safetyStock);
  const slowQuantity =
    rate == null ? null : needed(horizon, extraDays, safetyStock, policy.returnDaysMax);
  const fastQuantity =
    rate == null ? null : needed(horizon, extraDays, safetyStock, policy.returnDaysMin);
  const shortageBeforeArrival = needed(
    Math.min(policy.purchaseLeadDays, daysToStop ?? Infinity),
    0,
    new Decimal(0),
    policy.confirmedReturnRate == null ? undefined : policy.returnDaysMax,
  );
  const rawQuantity = seasonEnd
    ? 0
    : policy.confirmedReturnRate == null
      ? grossQuantity
      : slowQuantity!;
  let quantity = rawQuantity;
  if (quantity > 0) {
    quantity = Math.max(quantity, policy.minOrderQty);
    quantity = Math.ceil(quantity / policy.packSize) * policy.packSize;
  }
  const coverageDays = numerator.isZero()
    ? null
    : available.mul(divisor).div(numerator).toDecimalPlaces(1).toNumber();
  const status: ReplenishmentStatus = seasonEnd
    ? "SEASON_END"
    : shortageBeforeArrival > 0
      ? "URGENT"
      : quantity > 0
        ? "REORDER"
        : (coverageDays == null ? available.gt(0) : coverageDays > policy.overstockDays)
          ? "OVERSTOCK"
          : "OK";
  const warningCodes = [
    ...(demand.source === "manual" ? ["MANUAL_DEMAND"] : []),
    ...(z != null && sigma == null ? ["NO_VARIABILITY"] : []),
    ...(demand.stockoutDays?.length ? ["STOCKOUT_DAYS_EXCLUDED"] : []),
    ...(demand.cappedDays?.length ? ["SPIKES_CAPPED"] : []),
    ...(policy.confirmedReturnRate == null ? ["UNCONFIRMED_RETURN_RATE"] : []),
    ...(input.unconfirmedInboundQty > 0 ? ["INBOUND_ETA_UNKNOWN"] : []),
    ...(shortageBeforeArrival > 0 ? ["LEAD_TIME_GAP"] : []),
    ...(seasonEnd ? ["SEASON_END"] : []),
    ...(quantity !== rawQuantity ? ["ORDER_ROUNDED"] : []),
  ];
  return {
    ...base,
    quantity,
    rawQuantity,
    coverageDays,
    grossQuantity,
    dailySales: daily.toDecimalPlaces(8).toNumber(),
    safetyStock: safetyStock.toDecimalPlaces(2).toNumber(),
    targetStock: target(horizon, extraDays, safetyStock).toDecimalPlaces(2).toNumber(),
    scenarioReturnRate: rate,
    returnAdjustedQuantityMin: fastQuantity,
    returnAdjustedQuantityMax: slowQuantity,
    expectedReusableReturnsMin:
      minReturns?.toDecimalPlaces(4).toNumber() ?? null,
    expectedReusableReturnsMax:
      maxReturns?.toDecimalPlaces(4).toNumber() ?? null,
    shortageBeforeArrival,
    status,
    warningCodes,
  };
}

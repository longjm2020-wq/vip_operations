import { z } from "zod";
import { shiftCompassDate } from "./compass-analytics.js";

export const operatingRuleVersion = "2026-11-16.1";
export const supplyReasonLabels = {
  stock: "供应商有现货",
  fast: "生产周期不超过20天",
  moq: "不满足起订量",
  discontinued: "停产",
  slow: "生产周期超过20天",
  season: "换季倒计时不超过30天",
} as const;
export const clearanceReasonLabels = {
  none: "无停售反馈",
  quality: "品质退供",
  bulk: "大货退供",
  completed: "清仓完结",
} as const;
export const operatingFeedbackSchema = z
  .object({
    supply: z.enum(["pending", "allow", "deny"]).default("pending"),
    supplyReasons: z
      .array(z.enum(["stock", "fast", "moq", "discontinued", "slow", "season"]))
      .max(6)
      .default([]),
    supplyNote: z.string().trim().max(1000).default(""),
    clearance: z.enum(["none", "quality", "bulk", "completed"]).default("none"),
    clearanceNote: z.string().trim().max(1000).default(""),
    backlog: z.boolean().default(false),
    salesConfirmation: z.enum(["auto", "keep", "stop"]).default("auto"),
    confirmationReason: z.string().trim().max(1000).default(""),
  })
  .strict()
  .superRefine((v, ctx) => {
    const allowReasons = new Set(["stock", "fast"]);
    if (v.supply !== "pending" && !v.supplyReasons.length)
      ctx.addIssue({
        code: "custom",
        path: ["supplyReasons"],
        message: "请填写生产采购端判断原因",
      });
    if (
      v.supplyReasons.some(
        (r) =>
          v.supply === "pending" ||
          (v.supply === "allow") !== allowReasons.has(r),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["supplyReasons"],
        message: "原因与补货资格不一致",
      });
    if (v.salesConfirmation !== "auto" && !v.confirmationReason)
      ctx.addIssue({
        code: "custom",
        path: ["confirmationReason"],
        message: "人工确认销售状态须填写原因",
      });
    if (v.clearance !== "none" && v.salesConfirmation === "keep")
      ctx.addIssue({
        code: "custom",
        path: ["salesConfirmation"],
        message: "继续销售前请先撤销退供清仓端的停售反馈",
      });
  });
export type OperatingFeedback = z.infer<typeof operatingFeedbackSchema>;
export const emptyOperatingFeedback = (): OperatingFeedback =>
  operatingFeedbackSchema.parse({});
export type OperatingMetric =
  "salesQty" | "returnsQty" | "exposure" | "detailViews" | "cartUsers";
export type OperatingDay = {
  date: string;
  entityKey: string;
  saleAge: number | null;
  firstListedAt: string | null;
  metrics: Record<OperatingMetric, number | null>;
};
export type OperatingSource = {
  id: string;
  startDate: string;
  endDate: string;
  importedAt: string | null;
};
export type OperatingEvidence = {
  source: OperatingSource | null;
  issue: string | null;
  age: number | null;
  firstListedAt: string | null;
  startDate: string | null;
  endDate: string | null;
  coveredDays: number;
  expectedDays: number;
  salesQty: number | null;
  returnsQty: number | null;
  exposure: number | null;
  detailViews: number | null;
  clickRate: number | null;
  cartRate: number | null;
  returnRate: number | null;
};
export type OperatingDecision = {
  phase: "待确认" | "首测" | "回测" | "观察期" | "常测";
  replenishment: "允许补货" | "不允许补货" | "待确认";
  sales: "继续销售" | "建议停售" | "已确认停售" | "待确认";
  tags: string[];
  reasons: string[];
  evidence: OperatingEvidence;
  ruleVersion: string;
};
const difference = (a: string, b: string) =>
  Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const ratio = (a: number | null, b: number | null) =>
  a == null || b == null || b <= 0 ? null : Number((a / b).toPrecision(14));

/** Deterministic, auditable rules. Missing observations never become zero sales. */
export function evaluateOperatingDecision(
  feedback: OperatingFeedback,
  days: OperatingDay[],
  source: OperatingSource | null,
  today: string,
  unavailableReason?: string,
): OperatingDecision {
  const evidence: OperatingEvidence = {
    source,
    issue: unavailableReason || null,
    age: null,
    firstListedAt: null,
    startDate: null,
    endDate: null,
    coveredDays: 0,
    expectedDays: 0,
    salesQty: null,
    returnsQty: null,
    exposure: null,
    detailViews: null,
    clickRate: null,
    cartRate: null,
    returnRate: null,
  };
  const result: OperatingDecision = {
    phase: "待确认",
    replenishment: "待确认",
    sales: "待确认",
    tags: [],
    reasons: [],
    evidence,
    ruleVersion: operatingRuleVersion,
  };
  let salesPermission: "allow" | "deny" | "pending" = "pending";
  const issue = (text: string) => {
    evidence.issue ||= text;
  };
  if (!source) issue("尚无完整的款号罗盘报表");
  else {
    if (difference(today, source.endDate) > 3)
      issue("报表已超过3天，请先更新经营分析数据");
    if (source.endDate >= today) issue("报表截止日应早于今天");
    const latest = days.filter((d) => d.date === source.endDate);
    if (!latest.length)
      issue("报表截止日未匹配到该款，不能用历史记录代替当前状态");
    if (new Set(days.map((d) => d.entityKey)).size > 1)
      issue("同一款号存在多个平台记录，需核对映射");
    const last = latest[0];
    const age =
      last?.saleAge ??
      (last?.firstListedAt
        ? difference(source.endDate, last.firstListedAt.slice(0, 10)) + 1
        : null);
    if (age == null || age < 1 || !Number.isInteger(age)) issue("缺少有效售龄");
    else {
      evidence.age = age;
      // The report's age determines the testing windows, not archive creation time.
      const first = shiftCompassDate(source.endDate, 1 - age);
      evidence.firstListedAt = last?.firstListedAt?.slice(0, 10) || first;
      result.phase =
        age <= 10 ? "首测" : age <= 20 ? "回测" : age <= 30 ? "观察期" : "常测";
      const start =
        age <= 10
          ? first
          : age <= 20
            ? shiftCompassDate(first, 10)
            : age <= 30
              ? shiftCompassDate(first, 20)
              : shiftCompassDate(source.endDate, -29);
      evidence.startDate = start;
      evidence.endDate = source.endDate;
      evidence.expectedDays = difference(source.endDate, start) + 1;
      const window = days.filter(
        (d) => d.date >= start && d.date <= source.endDate,
      );
      evidence.coveredDays = new Set(window.map((d) => d.date)).size;
      if (
        source.startDate > start ||
        evidence.coveredDays !== evidence.expectedDays
      )
        issue("观察窗口数据覆盖不足，缺失日期不补零");
      if (window.length !== evidence.coveredDays)
        issue("同一日期存在重复记录，需核对映射");
      const sum = (key: OperatingMetric) =>
        window.length &&
        window.every(
          (d) =>
            d.metrics[key] != null &&
            Number.isFinite(d.metrics[key]) &&
            d.metrics[key]! >= 0,
        )
          ? window.reduce((total, d) => total + d.metrics[key]!, 0)
          : null;
      evidence.salesQty = sum("salesQty");
      evidence.returnsQty = sum("returnsQty");
      evidence.exposure = sum("exposure");
      evidence.detailViews = sum("detailViews");
      evidence.clickRate = ratio(evidence.detailViews, evidence.exposure);
      evidence.cartRate = ratio(sum("cartUsers"), evidence.detailViews);
      evidence.returnRate = ratio(evidence.returnsQty, evidence.salesQty);
      if (evidence.salesQty == null) issue("观察窗口缺少有效销量");
      if (!evidence.issue) {
        result.sales = "继续销售";
        const sold = evidence.salesQty! > 0;
        if (sold) {
          salesPermission = "allow";
          result.reasons.push("观察窗口已有销售");
        }
        if (age <= 10) {
          if (evidence.detailViews == null || evidence.cartRate == null) {
            result.tags.push("待观察");
            result.reasons.push("商详或加购样本不足，暂不判首测失败");
          } else if (evidence.detailViews >= 100 && evidence.cartRate >= 0.08) {
            result.tags.push("潜力款", "营销促转化", "待回测");
          } else if (
            age === 10 &&
            evidence.exposure != null &&
            evidence.exposure >= 2000 &&
            evidence.detailViews < 100 &&
            evidence.cartRate < 0.08
          ) {
            result.tags.push("非潜力款");
            if (!sold) {
              salesPermission = "deny";
              result.sales = "建议停售";
              result.tags.push("首测失败");
              result.reasons.push(
                "首测满10天且曝光达标，商详和加购均未达标、无销量",
              );
            } else
              result.reasons.push("商详和加购未达标，但已有销量，继续观察");
          } else {
            result.tags.push("待观察");
            result.reasons.push("观察期未满、流量不足或指标仅部分达标");
          }
        } else if (age <= 20) {
          if (!sold && age === 20) {
            salesPermission = "deny";
            result.sales = "建议停售";
            result.tags.push("回测失败");
            result.reasons.push("第11—20天数据完整且无销量");
          } else if (!sold) {
            result.tags.push("待观察");
            result.reasons.push("回测尚未满10天");
          }
        } else if (age <= 30) {
          result.tags.push("待观察");
          result.reasons.push("第21—30天为观察期，不自动判停售");
        } else if (age > 30) {
          if (evidence.returnRate == null) {
            salesPermission = "pending";
            result.tags.push("待补退货数据");
          } else if (evidence.returnRate > 0.8) {
            result.tags.push("高退货率");
            salesPermission = "pending";
            result.sales = "建议停售";
            result.reasons.push(
              "近30天期间退货率超过80%，需人工复核；不等于订单批次退货率",
            );
          }
        }
      }
    }
  }
  if (evidence.issue) {
    result.tags.push("数据待完善");
    result.reasons.push(evidence.issue);
  }
  if (feedback.backlog) {
    result.tags.push("压仓库存");
    result.sales = "继续销售";
    result.reasons.push("长期积压库存持续上线消化，高退货率不触发停售");
  }
  result.reasons.push(
    ...feedback.supplyReasons.map((r) => supplyReasonLabels[r]),
  );
  if (feedback.supply === "deny" || salesPermission === "deny")
    result.replenishment = "不允许补货";
  else if (feedback.supply === "allow" && salesPermission === "allow")
    result.replenishment = "允许补货";
  else
    result.reasons.push(
      feedback.supply === "pending"
        ? "生产采购端尚未反馈补货条件"
        : "销售端补货资格待确认",
    );
  if (feedback.salesConfirmation === "keep") {
    result.sales = "继续销售";
    result.reasons.push("人工确认继续销售：" + feedback.confirmationReason);
  }
  // Explicit quality/clearance feedback remains effective even on backlog stock.
  if (feedback.clearance !== "none" || feedback.salesConfirmation === "stop") {
    result.sales = "已确认停售";
    result.replenishment = "不允许补货";
    result.reasons.push(
      feedback.clearance !== "none"
        ? clearanceReasonLabels[feedback.clearance]
        : "人工确认停售：" + feedback.confirmationReason,
    );
  }
  return result;
}

export type OperatingDecisionItem = {
  rowId: string;
  styleNo: string;
  version: number;
  rowVersion: number;
  canEdit: boolean;
  feedback: OperatingFeedback;
  decision: OperatingDecision;
  updatedAt: string | null;
  updatedBy: string | null;
  needsReconfirmation: boolean;
};
export type OperatingDecisionHistory = {
  id: string;
  styleNo: string;
  createdAt: string;
  actorLabel: string;
  feedback: OperatingFeedback;
  decision: OperatingDecision | null;
};

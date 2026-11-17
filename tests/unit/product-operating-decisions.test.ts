import { describe, expect, it } from "vitest";
import {
  emptyOperatingFeedback,
  evaluateOperatingDecision,
  operatingFeedbackSchema,
  type OperatingDay,
  type OperatingFeedback,
} from "../../packages/contracts/src/product-operating-decisions.js";
import { shiftCompassDate } from "../../packages/contracts/src/compass-analytics.js";

const end = "2026-11-15",
  today = "2026-11-16";
const source = {
  id: "1",
  startDate: "2026-10-01",
  endDate: end,
  importedAt: null,
};
const allow = {
  ...emptyOperatingFeedback(),
  supply: "allow",
  supplyReasons: ["stock"],
} as OperatingFeedback;
function days(
  age: number,
  metrics: Partial<OperatingDay["metrics"]> = {},
): OperatingDay[] {
  return Array.from({ length: Math.min(age, 30) }, (_, i) => ({
    date: shiftCompassDate(end, 1 - Math.min(age, 30) + i),
    entityKey: "STYLE",
    saleAge: age,
    firstListedAt: null,
    metrics: {
      salesQty: 1,
      returnsQty: 0,
      exposure: 250,
      detailViews: 12,
      cartUsers: 1,
      onSaleStock: 20,
      saleableStock: 10,
      ...metrics,
    },
  }));
}
const decide = (
  age: number,
  metrics = {},
  feedback = emptyOperatingFeedback(),
) => evaluateOperatingDecision(feedback, days(age, metrics), source, today);

describe("product decisions: independent replenishment and sales rules", () => {
  it("uses sales data for decisions with only supplemental notes", () => {
    const notes = {
      ...emptyOperatingFeedback(),
      supplyNote: "等待核对供应商交期",
      clearanceNote: "仍在核对库存",
    };
    expect(decide(10, {}, notes)).toMatchObject({
      replenishment: "允许补货",
      sales: "继续销售",
    });
    expect(
      decide(10, { salesQty: 0, detailViews: 5, cartUsers: 0 }, notes),
    ).toMatchObject({ replenishment: "不允许补货", sales: "建议停售" });
    expect(decide(9, { salesQty: 0 }, notes).replenishment).toBe("待确认");
  });
  it("uses the procurement conclusion for replenishment despite conflicting automatic results", () => {
    expect(
      decide(10, { salesQty: 0, detailViews: 5, cartUsers: 0 }, allow),
    ).toMatchObject({
      replenishment: "允许补货",
      sales: "建议停售",
      tags: expect.arrayContaining(["首测失败"]),
    });
    expect(
      decide(10, {}, { ...allow, supply: "deny", supplyReasons: ["moq"] }),
    ).toMatchObject({ replenishment: "不允许补货", sales: "继续销售" });
  });
  it("never stops selling long-held stock solely because of high returns", () => {
    const result = decide(
      60,
      { returnsQty: 1.2 },
      {
        ...emptyOperatingFeedback(),
        backlog: true,
      },
    );
    expect(result.sales).toBe("继续销售");
    expect(result.tags).toEqual(
      expect.arrayContaining(["压仓库存", "高退货率"]),
    );
    expect(result.evidence.returnRate).toBeGreaterThan(1);
    expect(result.replenishment).toBe("待确认");
  });
  it.each(["quality", "bulk", "completed"] as const)(
    "preserves explicit %s stop feedback, including backlog",
    (clearance) => {
      expect(
        decide(60, {}, { ...allow, backlog: true, clearance }),
      ).toMatchObject({ sales: "已确认停售", replenishment: "不允许补货" });
    },
  );
  it("distinguishes a high-return suggestion from an explicit stop and keep decision", () => {
    expect(decide(60, { returnsQty: 0.81 }).sales).toBe("建议停售");
    expect(decide(60, { returnsQty: 0.8 }).sales).toBe("继续销售");
    expect(
      decide(
        60,
        { returnsQty: 0.81 },
        {
          ...emptyOperatingFeedback(),
          salesConfirmation: "keep",
          confirmationReason: "继续清理现货",
        },
      ),
    ).toMatchObject({ sales: "继续销售", replenishment: "待确认" });
    expect(
      decide(
        60,
        {},
        {
          ...allow,
          salesConfirmation: "stop",
          confirmationReason: "已人工核对",
        },
      ).replenishment,
    ).toBe("不允许补货");
  });
  it("marks potential after both traffic criteria, without inventing demand", () => {
    const result = decide(10, { salesQty: 0 });
    expect(result.tags).toContain("潜力款");
    expect(result.replenishment).toBe("待确认");
  });
  it("does not call immature, underexposed, mixed or zero-denominator samples failures", () => {
    for (const result of [
      decide(9, { salesQty: 0, detailViews: 5, cartUsers: 0 }),
      decide(10, { salesQty: 0, exposure: 100, detailViews: 5, cartUsers: 0 }),
      decide(10, { salesQty: 0, cartUsers: 0 }),
      decide(10, { salesQty: 0, detailViews: 0, cartUsers: 0 }),
    ]) {
      expect(result.sales).toBe("继续销售");
      expect(result.tags).not.toContain("首测失败");
    }
  });
  it("only fails complete first tests, and a sale resolves the conflicting positive rule", () => {
    expect(
      decide(10, { salesQty: 0, detailViews: 5, cartUsers: 0 }),
    ).toMatchObject({ sales: "建议停售", replenishment: "不允许补货" });
    expect(
      decide(10, { salesQty: 1, detailViews: 5, cartUsers: 0 }),
    ).toMatchObject({ sales: "继续销售", replenishment: "允许补货" });
  });
  it("calls for availability checks before failing a mature first test or retest", () => {
    const firstTest = decide(10, {
      salesQty: 0,
      detailViews: 5,
      cartUsers: 0,
      onSaleStock: null,
    });
    const retest = decide(20, { salesQty: 0, saleableStock: 0 });
    for (const [result, expectedFailure] of [
      [firstTest, "首测失败"],
      [retest, "回测失败"],
    ] as const) {
      expect(result).toMatchObject({
        sales: "待确认",
        replenishment: "待确认",
        tags: expect.arrayContaining(["零销量待核实"]),
      });
      expect(result.tags).not.toContain(expectedFailure);
    }
  });
  it("retest excludes first-test sales and waits for the tenth retest day", () => {
    const records = days(20, { salesQty: 0 });
    records[0].metrics.salesQty = 99;
    expect(
      evaluateOperatingDecision(
        emptyOperatingFeedback(),
        records,
        source,
        today,
      ),
    ).toMatchObject({
      phase: "回测",
      replenishment: "不允许补货",
      sales: "建议停售",
      evidence: { salesQty: 0, expectedDays: 10 },
    });
    expect(decide(19, { salesQty: 0 }).sales).toBe("继续销售");
    expect(decide(15).reasons.join(" ")).not.toContain("第21");
  });
  it.each([21, 25, 30])(
    "covers day %i as observation, without requiring prelaunch records",
    (age) => {
      expect(decide(age, { salesQty: 0 })).toMatchObject({
        phase: "观察期",
        sales: "继续销售",
        evidence: {
          issue: null,
          expectedDays: age - 20,
          zeroSalesAvailability: { availableDays: age - 20 },
        },
      });
    },
  );
  it("recommends stopping mature zero-sale styles only with positive stock snapshots for all 30 days", () => {
    const result = decide(63, { salesQty: 0 });
    expect(result).toMatchObject({
      phase: "常测",
      sales: "建议停售",
      replenishment: "不允许补货",
      tags: ["在售无销量"],
      evidence: {
        salesQty: 0,
        returnRate: null,
        zeroSalesAvailability: {
          availableDays: 30,
          zeroSaleableDays: 0,
          zeroOnSaleDays: 0,
          unknownDays: 0,
        },
      },
    });
    expect(result.reasons[0]).toContain("罗盘每日快照");
  });
  it("distinguishes interrupted availability and incomplete stock evidence from a zero-sale result with stock", () => {
    const records = days(63, { salesQty: 0 });
    records[0].metrics.saleableStock = 0;
    records[1].metrics.onSaleStock = 0;
    records[2].metrics.onSaleStock = 0;
    records[2].metrics.saleableStock = NaN;
    records[3].metrics.saleableStock = -1;
    records[4].metrics.onSaleStock = undefined;
    expect(
      evaluateOperatingDecision(
        emptyOperatingFeedback(),
        records,
        source,
        today,
      ),
    ).toMatchObject({
      sales: "待确认",
      replenishment: "待确认",
      tags: ["零销量待核实"],
      evidence: {
        salesQty: 0,
        zeroSalesAvailability: {
          availableDays: 25,
          zeroSaleableDays: 1,
          zeroOnSaleDays: 2,
          unknownDays: 3,
        },
      },
    });
    expect(
      decide(63, { salesQty: 0, saleableStock: null, onSaleStock: undefined }),
    ).toMatchObject({
      sales: "待确认",
      tags: ["零销量待核实"],
      evidence: {
        zeroSalesAvailability: { availableDays: 0, unknownDays: 30 },
      },
    });
  });
  it("preserves human decisions and the positive-sales return data check", () => {
    expect(
      decide(63, { salesQty: 0 }, { ...allow, backlog: true }),
    ).toMatchObject({ sales: "继续销售", replenishment: "允许补货" });
    expect(
      decide(
        63,
        { salesQty: 0, onSaleStock: null },
        { ...allow, clearance: "quality" },
      ),
    ).toMatchObject({ sales: "已确认停售", replenishment: "不允许补货" });
    expect(decide(63, { returnsQty: null, onSaleStock: null })).toMatchObject({
      sales: "继续销售",
      tags: ["待补退货数据"],
      evidence: { zeroSalesAvailability: null },
    });
  });
  it("does not turn missing sales, missing dates, ambiguity or stale reports into zero", () => {
    const incomplete = days(20, { salesQty: 0 });
    incomplete.splice(15, 1);
    const duplicate = days(20);
    duplicate.push({ ...duplicate[15], entityKey: "OTHER" });
    const variants = [
      evaluateOperatingDecision(
        emptyOperatingFeedback(),
        incomplete,
        source,
        today,
      ),
      evaluateOperatingDecision(
        emptyOperatingFeedback(),
        duplicate,
        source,
        today,
      ),
      decide(20, { salesQty: null }),
      evaluateOperatingDecision(
        emptyOperatingFeedback(),
        days(20),
        source,
        "2026-11-19",
      ),
      evaluateOperatingDecision(
        emptyOperatingFeedback(),
        days(20).slice(0, -1),
        source,
        today,
      ),
      evaluateOperatingDecision(
        emptyOperatingFeedback(),
        days(20),
        { ...source, startDate: end },
        today,
      ),
    ];
    for (const result of variants) {
      expect(result.replenishment).toBe("待确认");
      expect(result.sales).toBe("待确认");
      expect(result.evidence.issue).toBeTruthy();
      expect(result.evidence.zeroSalesAvailability).toBeNull();
    }
  });
  it("retains valid manual decisions when reports are absent", () => {
    expect(evaluateOperatingDecision(allow, [], null, today)).toMatchObject({
      replenishment: "允许补货",
      sales: "待确认",
      evidence: { source: null, salesQty: null },
    });
    expect(
      evaluateOperatingDecision(
        {
          ...emptyOperatingFeedback(),
          backlog: true,
        },
        [],
        null,
        today,
      ),
    ).toMatchObject({ replenishment: "待确认", sales: "继续销售" });
    expect(
      evaluateOperatingDecision(
        { ...allow, clearance: "completed" },
        [],
        null,
        today,
      ),
    ).toMatchObject({ replenishment: "不允许补货", sales: "已确认停售" });
  });
  it("validates incompatible reasons and requires manual confirmation explanations", () => {
    expect(
      operatingFeedbackSchema.safeParse({ ...allow, supplyReasons: ["moq"] })
        .success,
    ).toBe(false);
    expect(
      operatingFeedbackSchema.safeParse({ ...allow, salesConfirmation: "stop" })
        .success,
    ).toBe(false);
    expect(
      operatingFeedbackSchema.safeParse({
        ...allow,
        clearance: "quality",
        salesConfirmation: "keep",
        confirmationReason: "继续",
      }).success,
    ).toBe(false);
    expect(
      operatingFeedbackSchema.parse({ ...allow, supplyReasons: ["fast"] })
        .supply,
    ).toBe("allow");
  });
});

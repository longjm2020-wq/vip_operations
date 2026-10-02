import { describe, expect, it } from "vitest";
import {
  normalizeCompassWorkbook,
  compassRatios,
  shiftCompassDate,
  shanghaiDate,
  compassPeriodRange,
} from "../../packages/contracts/src/compass-analytics.js";
import {
  decryptMailPassword,
  encryptMailPassword,
  buildCompassEmail,
} from "../../apps/api/src/modules/analytics/mail.js";
const headers = [
  "日期",
  "P_SPU_ID",
  "款号",
  "商品ID",
  "货号",
  "条码",
  "SIZE_ID",
  "销售额",
  "销售量",
  "销售额(不含拒退)",
  "销售量(不含拒退)",
  "退货件数",
  "退货金额",
  "可售库存",
];
const row = [
  "2026-10-01",
  "SPU-1",
  "ST-1",
  "1287391390217097216",
  "AR-01",
  "000012345",
  "5517465537777173209",
  "1,200.50",
  "2",
  "900",
  "1",
  "1",
  "300.50",
  "8",
];
describe("Compass daily report normalization", () => {
  it("preserves long platform identifiers, leading-zero barcodes and missing metrics", () => {
    const report = normalizeCompassWorkbook([headers, row], "原始报表.xlsx");
    expect(report.dimension).toBe("barcode");
    expect(report.records[0].productId).toBe(row[3]);
    expect(report.records[0].barcode).toBe("000012345");
    expect(report.records[0].sizeId).toBe(row[6]);
    expect(report.records[0].metrics.salesAmount).toBe(1200.5);
    expect(report.records[0].metrics.exposure).toBeNull();
  });
  it("rejects duplicate atomic records, invalid numbers and missing daily dates", () => {
    expect(() =>
      normalizeCompassWorkbook([headers, row, row], "file.xlsx"),
    ).toThrow("重复");
    const bad = [...row];
    bad[7] = "不是数字";
    expect(() => normalizeCompassWorkbook([headers, bad], "file.xlsx")).toThrow(
      "有效数值",
    );
    const gap = [...row];
    gap[0] = "2026-09-29";
    expect(() =>
      normalizeCompassWorkbook([headers, row, gap], "file.xlsx"),
    ).toThrow("不连续");
    expect(() =>
      normalizeCompassWorkbook(
        [headers, row],
        "我的报表_20260902-20261001_20261002.xlsx",
      ),
    ).toThrow("区间");
  });
  it("accepts more than 50000 daily barcode rows under the separate analytics limit", () => {
    const data = Array.from({ length: 50001 }, (_, i) => {
      const r = [...row];
      r[6] = String(i);
      r[5] = "BC-" + i;
      return r;
    });
    expect(
      normalizeCompassWorkbook([headers, ...data], "大报表.xlsx").records,
    ).toHaveLength(50001);
  });
  it("recalculates weighted period ratios and leaves zero or missing denominators undefined", () => {
    expect(
      compassRatios({
        returnsQty: 20,
        salesQty: 100,
        customers: 10,
        detailViews: 200,
        exposure: 1000,
        salesAmount: 500,
      }),
    ).toMatchObject({
      returnRate: 0.2,
      clickRate: 0.2,
      conversionRate: 0.05,
      averagePrice: 5,
    });
    expect(
      compassRatios({
        returnsQty: 2,
        salesQty: 0,
        customers: 3,
        detailViews: null,
      }),
    ).toMatchObject({ returnRate: null, conversionRate: null });
    expect(compassRatios({ returnsQty: 5, salesQty: 2 }).returnRate).toBe(2.5);
  });
  it("uses Shanghai dates and crosses month/year boundaries correctly", () => {
    expect(shanghaiDate(new Date("2026-10-01T16:10:00Z"))).toBe("2026-10-02");
    expect(shiftCompassDate("2026-01-01", -1)).toBe("2025-12-31");
  });
  it("computes rolling and natural date periods, including leap years, Monday weeks and current-period cutoff", () => {
    expect(compassPeriodRange("recent:1", "2026-10-01")).toEqual([
      "2026-10-01",
      "2026-10-01",
    ]);
    expect(compassPeriodRange("recent:7", "2026-10-01")).toEqual([
      "2026-09-25",
      "2026-10-01",
    ]);
    expect(compassPeriodRange("week", "2026-01-01", "2026-01-04")).toEqual([
      "2025-12-29",
      "2026-01-04",
    ]);
    expect(compassPeriodRange("month", "2024-02-15", "2024-03-01")).toEqual([
      "2024-02-01",
      "2024-02-29",
    ]);
    expect(compassPeriodRange("quarter", "2026-10-01")).toEqual([
      "2026-10-01",
      "2026-10-01",
    ]);
    expect(compassPeriodRange("year", "2024-12-31")).toEqual([
      "2024-01-01",
      "2024-12-31",
    ]);
  });
});
describe("Compass email safety", () => {
  it("encrypts credentials with authentication and refuses a changed cipher", () => {
    process.env.COMPASS_MAIL_KEY = "4a".repeat(32);
    const cipher = encryptMailPassword("test-only-password");
    expect(cipher).not.toContain("test-only-password");
    expect(decryptMailPassword(cipher)).toBe("test-only-password");
    expect(() =>
      decryptMailPassword(
        cipher.slice(0, -2) + (cipher.endsWith("00") ? "ff" : "00"),
      ),
    ).toThrow();
    delete process.env.COMPASS_MAIL_KEY;
  });
  it("escapes report codes, labels sources and distinguishes rates from cohort returns", () => {
    const report = {
      dimension: "style",
      summary: {
        salesAmount: 100,
        netSalesAmount: 80,
        salesQty: 10,
        returnsQty: 2,
        returnsAmount: 20,
        returnRate: 0.2,
        saleableStock: 9,
      },
      top: [
        {
          code: "<img src=x onerror=alert(1)>",
          salesAmount: 100,
          salesQty: 10,
          returnRate: 0.2,
          saleableStock: 9,
        },
      ],
    };
    const email = buildCompassEmail(
      "2026-10-01",
      [report],
      [{ ...report, days: 7 }],
    );
    expect(email.html).toContain("&lt;img");
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("不代表同批订单");
    expect(email.subject).toContain("2026-10-01");
  });
});

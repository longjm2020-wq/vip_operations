import { describe, expect, it } from "vitest";
import {
  calendarTrend,
  trendDomain,
  trendPath,
} from "../../apps/web/src/compass-trend-data.js";
describe("商品每日趋势真实值与空缺", () => {
  it("日期对齐时保留缺失日、零和负数，折线不跨缺失日连接", () => {
    const points = calendarTrend(
      [
        { date: "2026-09-29", value: 0 },
        { date: "2026-10-01", value: "-3" },
        { date: "2026-10-02", value: 2 },
      ],
      "2026-09-29",
      "2026-10-02",
    );
    expect(points.map((point) => point.value)).toEqual([0, null, -3, 2]);
    expect(trendDomain(points)).toEqual({ min: -3, max: 2 });
    expect(
      trendPath(
        points,
        (index) => index,
        (value) => value,
      ),
    ).toBe("M0,0  M2,-3 L3,2");
  });
  it("空值和无效值不填0，单日及全0数据仍可绘图", () => {
    expect(
      calendarTrend(
        [{ date: "2026-10-01", value: "" }],
        "2026-10-01",
        "2026-10-01",
      )[0].value,
    ).toBeNull();
    expect(
      calendarTrend(
        [{ date: "2026-10-01", value: Infinity }],
        "2026-10-01",
        "2026-10-01",
      )[0].value,
    ).toBeNull();
    expect(trendDomain([{ date: "2026-10-01", value: 0 }])).toEqual({
      min: 0,
      max: 1,
    });
  });
});

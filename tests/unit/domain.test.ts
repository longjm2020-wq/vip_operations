import { describe, it, expect } from "vitest";
import { suggestion, poState } from "../../packages/contracts/src/domain.js";
import {
  validateIntegrationMode,
  UnavailableProvider,
} from "../../apps/api/src/integrations/vip/index.js";
describe("采购业务计算", () => {
  it("70/7，21天，可售30，在途20 => 160", () =>
    expect(suggestion(70, 30, 20, 21)?.suggestedQty).toBe(160));
  it("缺数据不同于已知0销量", () => {
    expect(suggestion(null, 30, 20, 21)).toBeNull();
    expect(suggestion(0, 30, 20, 21)).toMatchObject({
      suggestedQty: 0,
      stockCoverageDays: null,
    });
  });
  it("最后向上取整，过量库存截零", () => {
    expect(suggestion(1, 0, 0, 1)?.suggestedQty).toBe(1);
    expect(suggestion(70, 300, 20, 21)?.suggestedQty).toBe(0);
  });
  it("非法输入拒绝", () => expect(() => suggestion(70, -1, 0, 21)).toThrow());
  it("部分/完成由累计数量推导", () => {
    expect(
      poState([{ ordered_qty: 100, received_qty: 40, cancelled_qty: 0 }]),
    ).toBe("PARTIALLY_RECEIVED");
    expect(
      poState([{ ordered_qty: 100, received_qty: 100, cancelled_qty: 0 }]),
    ).toBe("COMPLETED");
  });
});
describe("数据源隔离", () => {
  it("未接入不是零销量", async () =>
    expect(await new UnavailableProvider().get("1")).toMatchObject({
      quality: "UNAVAILABLE",
      sales7d: null,
    }));
  it("生产拒绝fixture和未实现的真实VOP", () => {
    const old = {
      node: process.env.NODE_ENV,
      source: process.env.SALES_SOURCE,
      vip: process.env.VIP_MODE,
    };
    try {
      process.env.NODE_ENV = "production";
      process.env.SALES_SOURCE = "fixture";
      expect(validateIntegrationMode).toThrow();
      process.env.SALES_SOURCE = "unavailable";
      process.env.VIP_MODE = "live";
      expect(validateIntegrationMode).toThrow();
    } finally {
      for (const [key, v] of Object.entries({
        NODE_ENV: old.node,
        SALES_SOURCE: old.source,
        VIP_MODE: old.vip,
      })) {
        if (v === undefined) delete process.env[key];
        else process.env[key] = v;
      }
    }
  });
});

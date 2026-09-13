export function validateIntegrationMode() {
  if (process.env.VIP_MODE && process.env.VIP_MODE !== "disabled")
    throw Error(
      "VOP real integration is not implemented; VIP_MODE must be disabled",
    );
  if (
    process.env.NODE_ENV === "production" &&
    process.env.SALES_SOURCE === "fixture"
  )
    throw Error("Fixture sales cannot run in production");
}
export function vipStatus() {
  return { mode: "disabled", capabilities: [], reason: "NOT_CONFIGURED" };
}
export interface SalesMetricsProvider {
  get(skuId: string): Promise<{
    quality: "AVAILABLE" | "UNAVAILABLE";
    sales7d: number | null;
    sourceKind: "FIXTURE" | "STANDARD_SALES";
    dataAsOf: string | null;
  }>;
}
export class UnavailableProvider implements SalesMetricsProvider {
  async get(_skuId: string) {
    return {
      quality: "UNAVAILABLE" as const,
      sales7d: null,
      sourceKind: "STANDARD_SALES" as const,
      dataAsOf: null,
    };
  }
}
export class FixtureProvider implements SalesMetricsProvider {
  async get(_skuId: string) {
    if (process.env.NODE_ENV === "production") throw Error("Fixture forbidden");
    return {
      quality: "AVAILABLE" as const,
      sales7d: 70,
      sourceKind: "FIXTURE" as const,
      dataAsOf: new Date().toISOString(),
    };
  }
}
export function metricsProvider(): SalesMetricsProvider {
  return process.env.SALES_SOURCE === "fixture"
    ? new FixtureProvider()
    : new UnavailableProvider();
}

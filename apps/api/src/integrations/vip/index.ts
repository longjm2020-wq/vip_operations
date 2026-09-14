export function validateIntegrationMode() {
  if (
    process.env.VIP_MODE &&
    !["disabled", "catalog"].includes(process.env.VIP_MODE)
  )
    throw Error("Unsupported VIP_MODE");
  if (
    process.env.NODE_ENV === "production" &&
    process.env.SALES_SOURCE === "fixture"
  )
    throw Error("Fixture sales cannot run in production");
}
export async function vipStatus() {
  const { db, rows } =
    await import("../../../../../packages/database/src/index.js");
  const connections = await rows(
    db,
    `SELECT namespace,vendor_id,watermark,next_page,status,last_error,
      to_char(last_success_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_success_at,
      to_char(heartbeat_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS heartbeat_at,
      to_char(token_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS token_expires_at
      FROM vop_connections ORDER BY namespace`,
  );
  if (!connections.length)
    return {
      mode: "disabled",
      capabilities: [],
      reason: "NOT_CONFIGURED",
      connections: [],
      runs: [],
    };
  const runs = await rows(
    db,
    `SELECT id,namespace,
      to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
      to_char(finished_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS finished_at,
      status,pages,received,changed,rejected,error_code FROM vop_sync_runs ORDER BY id DESC LIMIT 30`,
  );
  const totals = (
    await rows(db, "SELECT count(*) AS total FROM vop_catalog")
  )[0];
  const rejected = (
    await rows(db, "SELECT count(*) AS total FROM vop_sync_rejections")
  )[0];
  return {
    mode: "catalog",
    capabilities: ["SCHEDULE_CATALOG"],
    connections,
    runs,
    total: totals.total,
    rejected: rejected.total,
  };
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

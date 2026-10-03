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
  const { compassDocumentation } = await import("./compass.js");
  const { listingDocumentation } = await import("./listing.js");
  const listing = {
    documentation: listingDocumentation,
    scope: "COLLECTED_SCHEDULE_BARCODES",
    freshnessSeconds: 7200,
    jobs: await rows(
      db,
      `SELECT j.namespace,j.status,j.scanned,j.last_error,
      to_char(j.heartbeat_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS heartbeat_at,
      to_char(j.last_success_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_success_at,
      (SELECT count(DISTINCT lower(c.barcode)) FROM vop_catalog c WHERE c.namespace=j.namespace) AS total,
      (SELECT count(*) FROM vop_listing_states s WHERE s.namespace=j.namespace AND s.checked_at>now()-interval '2 hours'
        AND s.last_error IS NULL AND EXISTS(SELECT 1 FROM vop_catalog c WHERE c.namespace=s.namespace AND lower(c.barcode)=s.barcode_key)) AS checked,
      (SELECT count(*) FROM vop_listing_states s WHERE s.namespace=j.namespace AND s.last_error IS NOT NULL) AS unresolved
      FROM vop_listing_jobs j ORDER BY j.namespace`,
    ),
  };
  const compass = {
    documentation: compassDocumentation,
    metricContractVerified: false,
    analyticsSource: "IMPORTED_REPORTS",
    probes: await rows(
      db,
      `SELECT namespace,configured,ready_for_probe,status,last_error,business_code,row_count,
      field_names,has_next_cursor,source_update_time,
      to_char(last_probe_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_probe_at,
      to_char(heartbeat_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS heartbeat_at
      FROM vop_compass_probes ORDER BY namespace`,
    ),
  };
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
      compass,
      listing,
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
    capabilities: ["SCHEDULE_CATALOG", "PRODUCT_DETAILS", "BARCODE_LISTING"],
    detailJobs: await rows(
      db,
      `SELECT j.namespace,j.status,j.next_page,j.scanned,j.last_error,
      to_char(j.last_success_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_success_at,
      (SELECT count(*) FROM vop_catalog c JOIN vop_product_details d ON d.namespace=c.namespace AND d.barcode=c.barcode WHERE c.namespace=j.namespace) AS matched
      FROM vop_detail_jobs j ORDER BY j.namespace`,
    ),
    connections,
    runs,
    total: totals.total,
    rejected: rejected.total,
    compass,
    listing,
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

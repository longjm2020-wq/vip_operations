import pg from "pg";
import { VipClient } from "../../api/src/integrations/vip/client.js";
import { syncDetails } from "../../api/src/integrations/vip/details.js";
import { syncListing } from "../../api/src/integrations/vip/listing.js";
import {
  loadCompassProbeSetup,
  probeCompass,
} from "../../api/src/integrations/vip/compass-probe.js";
import {
  syncCatalog,
  syncConfig,
} from "../../api/src/integrations/vip/sync.js";
export function startVopScheduler() {
  const config = syncConfig();
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 10000,
  });
  const client = new VipClient(config.credentials);
  const compassSetup = loadCompassProbeSetup();
  let running = false,
    stopped = false,
    nextRun = 0,
    active: Promise<void> | undefined;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const requested = (
        await pool.query(
          "SELECT requested_at FROM vop_connections WHERE namespace=$1",
          [config.namespace],
        )
      ).rows[0]?.requested_at;
      if (Date.now() >= nextRun || requested) {
        const result = await syncCatalog(
          pool,
          client,
          config.namespace,
          config.token,
        );
        nextRun =
          Date.now() +
          (result.status === "CONTINUING"
            ? 15000
            : result.status === "FAILED"
              ? 300000
              : 3600000);
        console.log(JSON.stringify({ event: "vop-catalog", ...result }));
      }
      const compass = await probeCompass(
        pool,
        client,
        config.namespace,
        await compassSetup,
      );
      if (!["IDLE", "BUSY", "NOT_CONFIGURED", "BLOCKED"].includes(compass))
        console.log(
          JSON.stringify({ event: "vop-compass-probe", status: compass }),
        );
      const details = await syncDetails(pool, client, config.namespace);
      if (!["IDLE", "BUSY"].includes(details))
        console.log(JSON.stringify({ event: "vop-details", status: details }));
    } catch {
      nextRun = Date.now() + 300000;
      console.error("VOP_SYNC_SERVICE_UNAVAILABLE");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    if (!running && !stopped) active = tick();
  }, 15000);
  active = tick();
  // A single independent loop preserves the API batch spacing, resumes promptly,
  // and cannot overlap itself or wait behind catalog/detail collection.
  let listingTimer: ReturnType<typeof setTimeout> | undefined;
  let listingActive: Promise<void> | undefined;
  const listingTick = async () => {
    if (stopped) return;
    let delay = 15000;
    try {
      const status = await syncListing(pool, client, config.namespace);
      if (status === "CONTINUING") delay = 100;
      if (!["IDLE", "BUSY", "NOT_CONFIGURED"].includes(status))
        console.log(JSON.stringify({ event: "vop-listing", status }));
    } catch {
      console.error("VOP_LISTING_SERVICE_UNAVAILABLE");
    } finally {
      if (!stopped) listingTimer = setTimeout(() => { listingActive = listingTick(); }, delay);
    }
  };
  if (process.env.VOP_LISTING_SYNC_ENABLED !== "off") listingActive = listingTick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(listingTimer);
    await Promise.all([active, listingActive]);
    await pool.end();
  };
}

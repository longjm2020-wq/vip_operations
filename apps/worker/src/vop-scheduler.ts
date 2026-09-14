import pg from "pg";
import { VipClient } from "../../api/src/integrations/vip/client.js";
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
      if (Date.now() < nextRun && !requested) return;
      const result = await syncCatalog(
        pool,
        client,
        config.namespace,
        config.token,
      );
      nextRun = Date.now() + (result.status === "CONTINUING" ? 15000 : 300000);
      console.log(JSON.stringify({ event: "vop-catalog", ...result }));
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
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
    await pool.end();
  };
}

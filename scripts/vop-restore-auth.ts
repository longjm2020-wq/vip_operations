import "dotenv/config";
import pg from "pg";
import { seal } from "../apps/api/src/integrations/vip/client.js";
import { syncConfig } from "../apps/api/src/integrations/vip/sync.js";
// Operator-only recovery after the user has installed newly authorized tokens.
// Normal startup must never replace the database token with stale environment values.
async function restore() {
  if (process.argv[2] !== "--apply")
    throw Error(
      "Use --apply only after installing newly authorized credentials",
    );
  const config = syncConfig();
  if (config.token.expiresAt <= Date.now()) throw Error("NEW_AUTH_EXPIRED");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const r = await c.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
      ["vop-sync:" + config.namespace],
    );
    if (!r.rows[0].locked) throw Error("SYNC_BUSY");
    await c.query(
      `UPDATE vop_connections SET token_cipher=$2,token_expires_at=$3,status='READY',last_error=NULL,requested_at=now(),updated_at=now() WHERE namespace=$1`,
      [
        config.namespace,
        seal(config.token, config.credentials.appSecret, config.namespace),
        new Date(config.token.expiresAt),
      ],
    );
    console.log("VOP_AUTH_RESTORED");
  } finally {
    await c.end();
  }
}
restore().catch(() => {
  console.error("VOP_AUTH_RESTORE_FAILED");
  process.exitCode = 1;
});

import pg from "pg";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  VipClient,
  VipError,
  adaptSku,
  safeSku,
  seal,
  unseal,
  type Token,
} from "./client.js";
export function syncConfig(env = process.env) {
  const vendorId = Number(env.VOP_VENDOR_ID),
    expiresAt = Number(env.VOP_TOKEN_EXPIRES_AT);
  if (
    !env.DATABASE_URL ||
    !env.VOP_APP_KEY ||
    !env.VOP_APP_SECRET ||
    !env.VOP_ACCESS_TOKEN ||
    !env.VOP_REFRESH_TOKEN ||
    !Number.isSafeInteger(vendorId) ||
    vendorId <= 0 ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= 0 ||
    !env.VOP_REQUEST_IP ||
    !isIP(env.VOP_REQUEST_IP)
  )
    throw new VipError("SYNC_CONFIG_MISSING");
  return {
    namespace: env.VOP_APP_KEY + ":" + vendorId,
    credentials: {
      appKey: env.VOP_APP_KEY,
      appSecret: env.VOP_APP_SECRET,
      vendorId,
      requestIp: env.VOP_REQUEST_IP,
    },
    token: {
      accessToken: env.VOP_ACCESS_TOKEN,
      refreshToken: env.VOP_REFRESH_TOKEN,
      expiresAt,
    },
  };
}
export async function syncCatalog(
  pool: pg.Pool,
  client: VipClient,
  namespace: string,
  bootstrap: Token,
  maxPages = 10,
  force = false,
) {
  const c = await pool.connect();
  let runId: string | undefined;
  try {
    const locked = await c.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
      ["vop-sync:" + namespace],
    );
    if (!locked.rows[0].locked) return { status: "BUSY" };
    await c.query(
      `INSERT INTO vop_connections(namespace,vendor_id,token_cipher,token_expires_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [
        namespace,
        client.credentials.vendorId,
        seal(bootstrap, client.credentials.appSecret, namespace),
        new Date(bootstrap.expiresAt),
      ],
    );
    const state = (
      await c.query("SELECT * FROM vop_connections WHERE namespace=$1", [
        namespace,
      ])
    ).rows[0];
    await c.query(
      "UPDATE vop_connections SET heartbeat_at=now() WHERE namespace=$1",
      [namespace],
    );
    if (state.status === "BLOCKED" && !force && !state.requested_at)
      return { status: "BLOCKED" };
    // Continue an unfinished fixed window; otherwise overlap five minutes to absorb late arrival.
    const full =
      state.window_start === null
        ? !state.reconciled_at ||
          Date.now() - new Date(state.reconciled_at).getTime() > 86400_000
        : state.window_full;
    const from =
      state.window_start === null
        ? full
          ? 0
          : Math.max(0, Number(state.watermark) - 300)
        : Number(state.window_start);
    const to =
      state.window_end === null
        ? Math.floor(Date.now() / 1000) - 120
        : Number(state.window_end);
    let page = state.window_end === null ? 1 : state.next_page;
    await c.query(
      `UPDATE vop_sync_runs SET status='INTERRUPTED',finished_at=now(),error_code='WORKER_INTERRUPTED' WHERE namespace=$1 AND status='RUNNING'`,
      [namespace],
    );
    runId = String(
      (
        await c.query(
          "INSERT INTO vop_sync_runs(namespace) VALUES($1) RETURNING id",
          [namespace],
        )
      ).rows[0].id,
    );
    await c.query(
      `UPDATE vop_connections SET status='RUNNING',last_error=NULL,requested_at=CASE WHEN requested_at<=$6 THEN NULL ELSE requested_at END,window_start=$2,window_end=$3,next_page=$4,window_full=$5,updated_at=now() WHERE namespace=$1`,
      [namespace, from, to, page, full, state.requested_at],
    );
    let token = unseal(
      state.token_cipher,
      client.credentials.appSecret,
      namespace,
    );
    const refresh = async () => {
      // Mark before external rotation: after an uncertain failure require operator recovery,
      // never reuse a possibly consumed refresh token in an automatic loop.
      await c.query(
        `UPDATE vop_connections SET status='REFRESHING' WHERE namespace=$1`,
        [namespace],
      );
      try {
        token = await client.refresh(token);
      } catch {
        throw new VipError("REFRESH_RECOVERY_REQUIRED");
      }
      await c.query(
        `UPDATE vop_connections SET token_cipher=$2,token_expires_at=$3,status='RUNNING' WHERE namespace=$1`,
        [
          namespace,
          seal(token, client.credentials.appSecret, namespace),
          new Date(token.expiresAt),
        ],
      );
    };
    if (
      state.status === "REFRESHING" ||
      state.last_error === "REFRESH_RECOVERY_REQUIRED"
    )
      throw new VipError("REFRESH_RECOVERY_REQUIRED");
    if (token.expiresAt - Date.now() < 24 * 3600_000) await refresh();
    for (let n = 0; n < maxPages; n++, page++) {
      const result = await client.page(token, from, to, page);
      let changed = 0,
        rejected = 0;
      await c.query("BEGIN");
      try {
        // Retry a bounded batch of quarantined records after adapter fixes. Rotate invalid
        // records to the end so one bad record cannot starve the remainder.
        const pending = (
          await c.query(
            "SELECT payload FROM vop_sync_rejections WHERE namespace=$1 ORDER BY last_seen_at LIMIT 100",
            [namespace],
          )
        ).rows;
        for (const raw of [...pending.map((r) => r.payload), ...result.list]) {
          let sku: ReturnType<typeof adaptSku>;
          try {
            sku = adaptSku(raw);
          } catch {
            const safe = safeSku(raw),
              hash = createHash("sha256")
                .update(JSON.stringify(safe))
                .digest("hex");
            await c.query(
              `INSERT INTO vop_sync_rejections(namespace,record_hash,payload,error_code) VALUES($1,$2,$3,'SKU_CONTRACT_INVALID') ON CONFLICT(namespace,record_hash) DO UPDATE SET last_seen_at=now()`,
              [namespace, hash, JSON.stringify(safe)],
            );
            rejected++;
            continue;
          }
          const v = sku.value;
          const upsert = await c.query(
            `INSERT INTO vop_catalog(namespace,external_key,barcode,style_no,product_name,cooperation_no,warehouse,source_updated_at,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(namespace,external_key) DO UPDATE SET style_no=EXCLUDED.style_no,product_name=EXCLUDED.product_name,source_updated_at=EXCLUDED.source_updated_at,payload_hash=EXCLUDED.payload_hash,synced_at=now()
      WHERE vop_catalog.source_updated_at<=EXCLUDED.source_updated_at AND vop_catalog.payload_hash<>EXCLUDED.payload_hash`,
            [
              namespace,
              sku.key,
              v.barcode,
              v.sn,
              v.product_name,
              v.cooperation_no,
              v.warehouse,
              v.latest_update_time,
              sku.hash,
            ],
          );
          changed += upsert.rowCount || 0;
          const replayHash = createHash("sha256")
            .update(JSON.stringify(safeSku(raw)))
            .digest("hex");
          await c.query(
            "DELETE FROM vop_sync_rejections WHERE namespace=$1 AND record_hash=$2",
            [namespace, replayHash],
          );
        }
        await c.query(
          "UPDATE vop_sync_runs SET pages=pages+1,received=received+$2,changed=changed+$3,rejected=rejected+$4 WHERE id=$1",
          [runId, result.list.length, changed, rejected],
        );
        await c.query(
          "UPDATE vop_connections SET next_page=$2,heartbeat_at=now() WHERE namespace=$1",
          [namespace, page + 1],
        );
        if (!result.has_next) {
          const failures = Number(
            (
              await c.query(
                "SELECT count(*) AS n FROM vop_sync_rejections WHERE namespace=$1",
                [namespace],
              )
            ).rows[0].n,
          );
          await c.query(
            `UPDATE vop_connections SET watermark=$2,window_start=NULL,window_end=NULL,next_page=1,status=$3,last_success_at=now(),reconciled_at=CASE WHEN window_full THEN now() ELSE reconciled_at END,window_full=false,updated_at=now() WHERE namespace=$1`,
            [namespace, to, failures ? "PARTIAL" : "SUCCESS"],
          );
          await c.query(
            `UPDATE vop_sync_runs SET status=$2,finished_at=now() WHERE id=$1`,
            [runId, failures ? "PARTIAL" : "SUCCESS"],
          );
        }
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
      if (!result.has_next) return { status: "COMPLETE" };
      await new Promise((r) => setTimeout(r, 1000));
    }
    await c.query(
      `UPDATE vop_connections SET status='CONTINUING' WHERE namespace=$1`,
      [namespace],
    );
    await c.query(
      `UPDATE vop_sync_runs SET status='CONTINUING',finished_at=now() WHERE id=$1`,
      [runId],
    );
    return { status: "CONTINUING" };
  } catch (error) {
    let code = error instanceof VipError ? error.code : "SYNC_STORAGE_FAILED";
    if (runId) {
      const state = (
        await c.query("SELECT status FROM vop_connections WHERE namespace=$1", [
          namespace,
        ])
      ).rows[0]?.status;
      if (state === "REFRESHING") code = "REFRESH_RECOVERY_REQUIRED";
      const retry =
        error instanceof VipError && error.retryable && state !== "REFRESHING";
      await c.query(
        `UPDATE vop_connections SET status=$2,last_error=$3,updated_at=now() WHERE namespace=$1`,
        [namespace, retry ? "RETRY" : "BLOCKED", code],
      );
      await c.query(
        `UPDATE vop_sync_runs SET status='FAILED',error_code=$2,finished_at=now() WHERE id=$1`,
        [runId, code],
      );
    }
    return { status: "FAILED", code };
  } finally {
    await c
      .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        "vop-sync:" + namespace,
      ])
      .catch(() => {});
    c.release();
  }
}

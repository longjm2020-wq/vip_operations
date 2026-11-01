import { randomUUID } from "node:crypto";
import type pg from "pg";
import { VipClient, VipError, unseal } from "./client.js";
import { queryListing, type ListingObservation } from "./listing.js";

/** Persist a batch atomically. Failed observations never replace the last known state. */
async function saveBatch(
  c: pg.PoolClient,
  namespace: string,
  runId: string,
  observations: ListingObservation[],
) {
  await c.query("BEGIN");
  try {
    const updated = await c.query(
      `UPDATE vop_listing_states s SET
        state=CASE WHEN v.error IS NULL THEN v.state ELSE s.state END,
        result_code=CASE WHEN v.error IS NULL THEN v."resultCode" ELSE s.result_code END,
        listing_status=CASE WHEN v.error IS NULL THEN v."listingStatus" ELSE s.listing_status END,
        last_change_type=CASE WHEN v.error IS NULL THEN v."lastChangeType" ELSE s.last_change_type END,
        last_change_time=CASE WHEN v.error IS NULL THEN v."lastChangeTime" ELSE s.last_change_time END,
        last_changed_at=CASE WHEN v.error IS NULL THEN v."lastChangedAt" ELSE s.last_changed_at END,
        time_warning=CASE WHEN v.error IS NULL THEN v."timeWarning" ELSE s.time_warning END,
        checked_at=CASE WHEN v.error IS NULL THEN now() ELSE s.checked_at END,
        attempted_at=now(),run_attempted_at=now(),last_error=v.error,
        next_run_at=now()+CASE WHEN v.error IS NULL THEN interval '1 hour' ELSE interval '5 minutes' END
      FROM jsonb_to_recordset($3::jsonb) AS v("barcodeKey" text,state text,"resultCode" integer,
        "listingStatus" integer,"lastChangeType" text,"lastChangeTime" bigint,
        "lastChangedAt" timestamptz,"timeWarning" text,error text)
      WHERE s.namespace=$1 AND s.run_id=$2::uuid AND s.barcode_key=v."barcodeKey" AND s.run_attempted_at IS NULL`,
      [namespace, runId, JSON.stringify(observations)],
    );
    if (updated.rowCount !== observations.length)
      throw new VipError("LISTING_RUN_CHANGED");
    await c.query(
      `UPDATE vop_listing_jobs SET scanned=scanned+$3,run_completed=run_completed+$3,
        run_failed=run_failed+$4,heartbeat_at=now(),updated_at=now()
      WHERE namespace=$1 AND run_id=$2::uuid`,
      [
        namespace,
        runId,
        observations.length,
        observations.filter((v) => v.error).length,
      ],
    );
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  }
}

export async function syncListing(
  pool: pg.Pool,
  client: VipClient,
  namespace: string,
  maxBatches = 10,
  pauseMs = 1000,
) {
  const c = await pool.connect();
  let locked = false;
  let batch: string[] = [];
  let runId: string | undefined;
  try {
    // Listing is read-only and has its own lock; long catalog/detail scans cannot starve it.
    locked = (
      await c.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        ["vop-listing:" + namespace],
      )
    ).rows[0].locked;
    if (!locked) return "BUSY";
    const connection = (
      await c.query(
        "SELECT vendor_id,token_cipher,token_expires_at FROM vop_connections WHERE namespace=$1",
        [namespace],
      )
    ).rows[0];
    if (!connection) return "NOT_CONFIGURED";
    await c.query(
      "INSERT INTO vop_listing_jobs(namespace) VALUES($1) ON CONFLICT DO NOTHING",
      [namespace],
    );
    await c.query(
      "UPDATE vop_listing_jobs SET heartbeat_at=now() WHERE namespace=$1",
      [namespace],
    );
    if (Number(connection.vendor_id) !== client.credentials.vendorId)
      throw new VipError("LISTING_VENDOR_MISMATCH");

    // Serialize capture with manual requests, but never hold a transaction during HTTP calls.
    await c.query("BEGIN");
    try {
      const job = (
        await c.query(
          "SELECT *,next_run_at<=now() AS due FROM vop_listing_jobs WHERE namespace=$1 FOR UPDATE",
          [namespace],
        )
      ).rows[0];
      if (!job.due) {
        await c.query("COMMIT");
        return "IDLE";
      }
      if (
        job.run_id &&
        job.run_started_at &&
        !job.run_finished_at &&
        ["RUNNING", "CONTINUING"].includes(job.status)
      ) {
        runId = job.run_id;
      } else {
        await c.query(
          `INSERT INTO vop_listing_states(namespace,barcode_key,source_updated_at)
          SELECT namespace,lower(barcode),max(source_updated_at) FROM vop_catalog WHERE namespace=$1 AND barcode<>'' GROUP BY 1,2
          ON CONFLICT(namespace,barcode_key) DO UPDATE SET source_updated_at=EXCLUDED.source_updated_at,
          next_run_at=CASE WHEN EXCLUDED.source_updated_at>vop_listing_states.source_updated_at
            THEN LEAST(vop_listing_states.next_run_at,now()) ELSE vop_listing_states.next_run_at END
          WHERE EXCLUDED.source_updated_at IS DISTINCT FROM vop_listing_states.source_updated_at`,
          [namespace],
        );
        const requested = job.status === "READY";
        runId =
          requested && job.run_id && !job.run_started_at
            ? job.run_id
            : randomUUID();
        const captured = await c.query(
          `UPDATE vop_listing_states s SET run_id=$2::uuid,run_attempted_at=NULL,next_run_at=LEAST(s.next_run_at,now())
          WHERE s.namespace=$1 AND ($3::boolean OR s.next_run_at<=now())
            AND EXISTS(SELECT 1 FROM vop_catalog c WHERE c.namespace=s.namespace AND lower(c.barcode)=s.barcode_key)`,
          [namespace, runId, requested],
        );
        const total = captured.rowCount ?? 0;
        if (!total && !requested) {
          // Idle checks are not successful syncs and must not advance completion times.
          await c.query(
            "UPDATE vop_listing_jobs SET next_run_at=now()+interval '1 minute' WHERE namespace=$1",
            [namespace],
          );
          await c.query("COMMIT");
          return "IDLE";
        }
        await c.query(
          `UPDATE vop_listing_jobs SET run_id=$2::uuid,run_started_at=now(),run_finished_at=NULL,
            run_total=$3::bigint,run_completed=0,run_failed=0,scanned=0,status='RUNNING',last_error=NULL,
            full_run=($3::bigint>0 AND $3::bigint=(SELECT count(DISTINCT lower(barcode)) FROM vop_catalog WHERE namespace=$1 AND barcode<>'')),updated_at=now()
          WHERE namespace=$1`,
          [namespace, runId, total],
        );
      }
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    }

    let accessToken: string | undefined;
    if (new Date(connection.token_expires_at).getTime() > Date.now()) {
      const token = unseal(
        connection.token_cipher,
        client.credentials.appSecret,
        namespace,
      );
      if (token.expiresAt > Date.now()) accessToken = token.accessToken;
    }
    for (let n = 0; n < maxBatches; n++) {
      batch = (
        await c.query(
          `SELECT barcode_key FROM vop_listing_states WHERE namespace=$1 AND run_id=$2::uuid AND run_attempted_at IS NULL
          ORDER BY checked_at NULLS FIRST,barcode_key LIMIT 50`,
          [namespace, runId],
        )
      ).rows.map((row) => row.barcode_key);
      if (!batch.length) {
        const empty = (
          await c.query(
            "SELECT run_total FROM vop_listing_jobs WHERE namespace=$1",
            [namespace],
          )
        ).rows[0];
        if (!Number(empty.run_total)) throw new VipError("LISTING_NO_BARCODES");
      } else {
        await c.query(
          "UPDATE vop_listing_jobs SET status='RUNNING',heartbeat_at=now(),updated_at=now() WHERE namespace=$1",
          [namespace],
        );
        const observations = await queryListing(client, batch, accessToken);
        await saveBatch(c, namespace, runId!, observations);
        batch = [];
      }
      // Complete immediately after the final saved batch, including an exact multiple of 50.
      const done = (
        await c.query(
          `UPDATE vop_listing_jobs SET status=CASE WHEN run_failed>0 THEN 'PARTIAL' ELSE 'SUCCESS' END,
          run_finished_at=now(),last_error=NULL,
          last_success_at=CASE WHEN full_run AND run_failed=0 THEN now() ELSE last_success_at END,
          next_run_at=now()+interval '1 minute',heartbeat_at=now(),updated_at=now()
        WHERE namespace=$1 AND run_id=$2::uuid AND run_total>0 AND run_completed=run_total RETURNING status`,
          [namespace, runId],
        )
      ).rows[0];
      if (done) return done.status as "SUCCESS" | "PARTIAL";
      if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    await c.query(
      "UPDATE vop_listing_jobs SET status='CONTINUING',heartbeat_at=now(),updated_at=now() WHERE namespace=$1",
      [namespace],
    );
    return "CONTINUING";
  } catch (error) {
    const code = error instanceof VipError ? error.code : "LISTING_SYNC_FAILED";
    const retry = !(error instanceof VipError) || error.retryable;
    if (runId && batch.length) {
      await saveBatch(
        c,
        namespace,
        runId,
        batch.map((barcodeKey) => ({
          barcodeKey,
          state: "UNKNOWN",
          resultCode: null,
          listingStatus: null,
          lastChangeType: null,
          lastChangeTime: null,
          lastChangedAt: null,
          timeWarning: null,
          error: code,
        })),
      );
    }
    await c.query(
      `UPDATE vop_listing_jobs SET status=$2,last_error=$3,run_finished_at=now(),heartbeat_at=now(),updated_at=now(),
        next_run_at=now()+CASE WHEN $4 THEN interval '5 minutes' ELSE interval '100 years' END WHERE namespace=$1`,
      [namespace, retry ? "FAILED" : "BLOCKED", code, retry],
    );
    return retry ? "FAILED" : "BLOCKED";
  } finally {
    if (locked)
      await c
        .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          "vop-listing:" + namespace,
        ])
        .catch(() => {});
    c.release();
  }
}

import type pg from "pg";
import { z } from "zod";
import { VipClient, VipError, unseal } from "./client.js";

export const listingService =
  "com.vip.somp.sales.backend.service.SalesVopService";
export const listingMethod = "queryConsignmentBarcodeListingInfo";
export const listingDocumentation = `https://vop.vip.com/home#/api/method/detail/${listingService}-1.0.0/${listingMethod}`;
export const listingRequestSchema = z
  .object({ namespace: z.string().min(1).max(255) })
  .strict();
export const listingStates = [
  "LISTED",
  "UNLISTED",
  "PARTIAL",
  "UNPUBLISHED",
  "NOT_FOUND",
  "UNKNOWN",
] as const;
export const listingCatalogQuerySchema = z.object({
  state: z.enum(listingStates).optional(),
});
const observationSchema = z.object({
  barcode: z.string().min(1).max(1000).nullish(),
  code: z.number().int(),
  listing_status: z.number().int().nullish(),
  last_status_change_type: z.string().max(50).nullish(),
  last_status_change_time: z
    .union([
      z.number().int().nonnegative().safe(),
      z
        .string()
        .regex(/^\d{1,15}$/)
        .transform(Number),
    ])
    .nullish(),
});
export type ListingObservation = {
  barcodeKey: string;
  state: "UNKNOWN" | "LISTED" | "UNLISTED" | "UNPUBLISHED" | "NOT_FOUND";
  resultCode: number | null;
  listingStatus: number | null;
  lastChangeType: string | null;
  lastChangeTime: number | null;
  lastChangedAt: Date | null;
  timeWarning: string | null;
  error: string | null;
};
export const barcodeKey = (value: string) => value.toLowerCase();

/** Correlate by the documented lowercase map key, never by response order. */
export function adaptListingResponse(
  raw: unknown,
  requested: string[],
): ListingObservation[] {
  const object = z.record(z.string().max(1000), z.unknown()).safeParse(raw);
  if (!object.success) throw new VipError("LISTING_RESPONSE_INVALID");
  // The official test tool uses a Thrift success wrapper; HTTP result maps may be direct.
  const map =
    Object.keys(object.data).length === 1 &&
    Object.hasOwn(object.data, "success")
      ? z
          .record(z.string().max(1000), z.unknown())
          .safeParse(object.data.success)
      : object;
  if (!map.success) throw new VipError("LISTING_RESPONSE_INVALID");
  const entries = new Map<string, unknown>();
  for (const [key, value] of Object.entries(map.data)) {
    const normalized = barcodeKey(key);
    if (entries.has(normalized))
      throw new VipError("LISTING_RESPONSE_AMBIGUOUS");
    entries.set(normalized, value);
  }
  return requested.map((barcode) => {
    const key = barcodeKey(barcode);
    const result: ListingObservation = {
      barcodeKey: key,
      state: "UNKNOWN",
      resultCode: null,
      listingStatus: null,
      lastChangeType: null,
      lastChangeTime: null,
      lastChangedAt: null,
      timeWarning: null,
      error: null,
    };
    if (!entries.has(key))
      return { ...result, error: "LISTING_RESULT_MISSING" };
    const parsed = observationSchema.safeParse(entries.get(key));
    if (
      !parsed.success ||
      (parsed.data.barcode && barcodeKey(parsed.data.barcode) !== key)
    )
      return { ...result, error: "LISTING_RECORD_INVALID" };
    const v = parsed.data;
    result.resultCode = v.code;
    if (v.code === 404) return { ...result, state: "NOT_FOUND" };
    if (v.code === 500) return { ...result, state: "UNPUBLISHED" };
    if (v.code !== 200) return { ...result, error: "LISTING_RESULT_REJECTED" };
    if (![0, 1].includes(v.listing_status ?? -1))
      return { ...result, error: "LISTING_RECORD_INVALID" };
    result.listingStatus = v.listing_status!;
    result.state = v.listing_status === 1 ? "LISTED" : "UNLISTED";
    result.lastChangeType = ["LISTED", "UNLISTED"].includes(
      v.last_status_change_type || "",
    )
      ? v.last_status_change_type!
      : null;
    result.lastChangeTime = v.last_status_change_time ?? null;
    // The untranslated official HTTP example specifies milliseconds. Keep the raw value;
    // conflicting/implausible time units must not fabricate a last-change date.
    if (
      result.lastChangeTime &&
      result.lastChangeTime >= 946684800000 &&
      result.lastChangeTime <= Date.now() + 86400000
    )
      result.lastChangedAt = new Date(result.lastChangeTime);
    else if (result.lastChangeTime)
      result.timeWarning = "LISTING_TIME_UNVERIFIED";
    return result;
  });
}

export async function queryListing(
  client: VipClient,
  barcodes: string[],
  accessToken?: string,
) {
  const requested = [...new Set(barcodes)];
  if (
    !requested.length ||
    requested.length > 50 ||
    requested.some((value) => !value || value.length > 1000)
  )
    throw new VipError("LISTING_REQUEST_INVALID");
  const response = await client.call(
    listingService,
    listingMethod,
    {
      req_context: { vendor_code: client.credentials.vendorId },
      barcode_listing_req: { barcode_list: requested },
    },
    accessToken,
  ); // The documented optional token is reused when the current connection has valid authorization.
  return adaptListingResponse(response, requested);
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
  try {
    locked = (
      await c.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        ["vop-sync:" + namespace],
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
    if (Number(connection.vendor_id) !== client.credentials.vendorId)
      throw new VipError("LISTING_VENDOR_MISMATCH");
    await c.query(
      "INSERT INTO vop_listing_jobs(namespace) VALUES($1) ON CONFLICT DO NOTHING",
      [namespace],
    );
    const job = (
      await c.query("SELECT * FROM vop_listing_jobs WHERE namespace=$1", [
        namespace,
      ])
    ).rows[0];
    await c.query(
      "UPDATE vop_listing_jobs SET heartbeat_at=now() WHERE namespace=$1",
      [namespace],
    );
    if (new Date(job.next_run_at).getTime() > Date.now()) return "IDLE";
    let accessToken: string | undefined;
    if (new Date(connection.token_expires_at).getTime() > Date.now()) {
      const token = unseal(
        connection.token_cipher,
        client.credentials.appSecret,
        namespace,
      );
      if (token.expiresAt > Date.now()) accessToken = token.accessToken;
    }
    await c.query(
      `INSERT INTO vop_listing_states(namespace,barcode_key,source_updated_at)
      SELECT namespace,lower(barcode),max(source_updated_at) FROM vop_catalog WHERE namespace=$1 AND barcode<>'' GROUP BY 1,2
      ON CONFLICT(namespace,barcode_key) DO UPDATE SET source_updated_at=EXCLUDED.source_updated_at,
      next_run_at=CASE WHEN EXCLUDED.source_updated_at>vop_listing_states.source_updated_at
        THEN LEAST(vop_listing_states.next_run_at,now()) ELSE vop_listing_states.next_run_at END`,
      [namespace],
    );
    for (let n = 0; n < maxBatches; n++) {
      batch = (
        await c.query(
          `SELECT s.barcode_key FROM vop_listing_states s WHERE s.namespace=$1 AND s.next_run_at<=now()
        AND EXISTS(SELECT 1 FROM vop_catalog c WHERE c.namespace=s.namespace AND lower(c.barcode)=s.barcode_key)
        ORDER BY s.checked_at NULLS FIRST,s.next_run_at,s.barcode_key LIMIT 50`,
          [namespace],
        )
      ).rows.map((row) => row.barcode_key);
      if (!batch.length) {
        const unresolved = Number(
          (
            await c.query(
              "SELECT count(*) FROM vop_listing_states WHERE namespace=$1 AND last_error IS NOT NULL",
              [namespace],
            )
          ).rows[0].count,
        );
        const state = unresolved ? "PARTIAL" : "SUCCESS";
        await c.query(
          `UPDATE vop_listing_jobs SET status=$2,last_error=NULL,
          last_success_at=CASE WHEN $2='SUCCESS' THEN now() ELSE last_success_at END,
          next_run_at=now()+interval '1 minute',heartbeat_at=now(),updated_at=now() WHERE namespace=$1`,
          [namespace, state],
        );
        return n === 0 && job.status === state ? "IDLE" : state;
      }
      await c.query(
        "UPDATE vop_listing_jobs SET status='RUNNING',last_error=NULL,heartbeat_at=now(),updated_at=now() WHERE namespace=$1",
        [namespace],
      );
      const observations = await queryListing(client, batch, accessToken);
      await c.query("BEGIN");
      try {
        for (const v of observations) {
          if (v.error) {
            await c.query(
              `UPDATE vop_listing_states SET attempted_at=now(),last_error=$3,next_run_at=now()+interval '5 minutes'
              WHERE namespace=$1 AND barcode_key=$2`,
              [namespace, v.barcodeKey, v.error],
            );
          } else {
            await c.query(
              `UPDATE vop_listing_states SET state=$3,result_code=$4,listing_status=$5,last_change_type=$6,last_change_time=$7,
              last_changed_at=$8,time_warning=$9,checked_at=now(),attempted_at=now(),last_error=NULL,next_run_at=now()+interval '1 hour'
              WHERE namespace=$1 AND barcode_key=$2`,
              [
                namespace,
                v.barcodeKey,
                v.state,
                v.resultCode,
                v.listingStatus,
                v.lastChangeType,
                v.lastChangeTime,
                v.lastChangedAt,
                v.timeWarning,
              ],
            );
          }
        }
        await c.query(
          "UPDATE vop_listing_jobs SET scanned=scanned+$2,heartbeat_at=now(),updated_at=now() WHERE namespace=$1",
          [namespace, batch.length],
        );
        await c.query("COMMIT");
      } catch (error) {
        await c.query("ROLLBACK");
        throw error;
      }
      batch = [];
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
    if (batch.length)
      await c.query(
        `UPDATE vop_listing_states SET attempted_at=now(),last_error=$3,
      next_run_at=now()+interval '5 minutes' WHERE namespace=$1 AND barcode_key=ANY($2::text[])`,
        [namespace, batch, code],
      );
    await c.query(
      `UPDATE vop_listing_jobs SET status=$2,last_error=$3,heartbeat_at=now(),updated_at=now(),
      next_run_at=now()+CASE WHEN $4 THEN interval '5 minutes' ELSE interval '100 years' END WHERE namespace=$1`,
      [namespace, retry ? "FAILED" : "BLOCKED", code, retry],
    );
    return retry ? "FAILED" : "BLOCKED";
  } finally {
    if (locked)
      await c
        .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          "vop-sync:" + namespace,
        ])
        .catch(() => {});
    c.release();
  }
}

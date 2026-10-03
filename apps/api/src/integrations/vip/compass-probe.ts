import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import type pg from "pg";
import { VipClient, VipError } from "./client.js";
import {
  CompassClient,
  compassBusinessError,
  compassParametersSchema,
  compassResponseMetadata,
  type CompassConfiguration,
} from "./compass.js";

export type CompassProbeSetup = {
  configured: {
    account: boolean;
    privateKeyFile: boolean;
    apiCode: boolean;
    parameters: boolean;
  };
  hash: string;
  status: "NOT_CONFIGURED" | "READY" | "BLOCKED";
  error: string | null;
  configuration?: CompassConfiguration;
  parameters?: Record<string, string>;
};

export async function loadCompassProbeSetup(
  env = process.env,
): Promise<CompassProbeSetup> {
  const account = env.VOP_COMPASS_ACCOUNT?.trim() || "";
  const file = env.VOP_COMPASS_PRIVATE_KEY_FILE?.trim() || "";
  const apiCode = env.VOP_COMPASS_API_CODE?.trim() || "";
  const query = env.VOP_COMPASS_QUERY_JSON?.trim() || "";
  const configured = {
    account: Boolean(account),
    privateKeyFile: Boolean(file),
    apiCode: Boolean(apiCode),
    parameters: Boolean(query),
  };
  const base = JSON.stringify([account, file, apiCode, query]);
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const result: CompassProbeSetup = {
    configured,
    hash: hash(base),
    status: "NOT_CONFIGURED",
    error: null,
  };
  if (!Object.values(configured).every(Boolean)) return result;
  try {
    const parameters = compassParametersSchema.parse(JSON.parse(query));
    if (
      account.length > 255 ||
      apiCode.length > 500 ||
      Object.hasOwn(parameters, "account") ||
      Object.hasOwn(parameters, "sign")
    )
      throw new VipError("COMPASS_PARAMETERS_INVALID");
    let privateKey;
    try {
      privateKey = createPrivateKey(await readFile(file));
      if (privateKey.asymmetricKeyType !== "rsa")
        throw new VipError("COMPASS_PRIVATE_KEY_INVALID");
    } catch {
      throw new VipError("COMPASS_PRIVATE_KEY_UNAVAILABLE");
    }
    const publicKey = createPublicKey(privateKey).export({
      format: "pem",
      type: "spki",
    });
    return {
      configured,
      hash: hash(base + "\0" + publicKey),
      status: "READY",
      error: null,
      configuration: { account, privateKey, apiCode },
      parameters,
    };
  } catch (error) {
    return {
      ...result,
      status: "BLOCKED",
      error:
        error instanceof VipError ? error.code : "COMPASS_PARAMETERS_INVALID",
    };
  }
}

/** A single page only; metric mapping and cursor parameter names are account-specific. */
export async function probeCompass(
  pool: pg.Pool,
  client: VipClient,
  namespace: string,
  setup: CompassProbeSetup,
) {
  const c = await pool.connect();
  let locked = false;
  let started = false;
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
        "SELECT vendor_id FROM vop_connections WHERE namespace=$1",
        [namespace],
      )
    ).rows[0];
    if (!connection) return "NOT_CONFIGURED";
    if (Number(connection.vendor_id) !== client.credentials.vendorId)
      throw new VipError("COMPASS_VENDOR_MISMATCH");
    await c.query(
      `INSERT INTO vop_compass_probes(namespace,configuration_hash,configured,status,last_error,ready_for_probe)
       VALUES($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT(namespace) DO UPDATE SET
       configuration_hash=EXCLUDED.configuration_hash,configured=EXCLUDED.configured,
       ready_for_probe=EXCLUDED.ready_for_probe,
       status=CASE WHEN vop_compass_probes.configuration_hash<>EXCLUDED.configuration_hash
         THEN EXCLUDED.status ELSE vop_compass_probes.status END,
       requested_at=CASE WHEN vop_compass_probes.configuration_hash<>EXCLUDED.configuration_hash
         THEN NULL ELSE vop_compass_probes.requested_at END,
       last_error=CASE WHEN vop_compass_probes.configuration_hash<>EXCLUDED.configuration_hash
         THEN EXCLUDED.last_error ELSE vop_compass_probes.last_error END,
       last_probe_at=CASE WHEN vop_compass_probes.configuration_hash<>EXCLUDED.configuration_hash
         THEN NULL ELSE vop_compass_probes.last_probe_at END,
       business_code=CASE WHEN vop_compass_probes.configuration_hash<>EXCLUDED.configuration_hash
         THEN NULL ELSE vop_compass_probes.business_code END,
       row_count=CASE WHEN vop_compass_probes.configuration_hash<>EXCLUDED.configuration_hash
         THEN NULL ELSE vop_compass_probes.row_count END,
       field_names=CASE WHEN vop_compass_probes.configuration_hash<>EXCLUDED.configuration_hash
         THEN '[]'::jsonb ELSE vop_compass_probes.field_names END,
       has_next_cursor=CASE WHEN vop_compass_probes.configuration_hash<>EXCLUDED.configuration_hash
         THEN NULL ELSE vop_compass_probes.has_next_cursor END,
       source_update_time=CASE WHEN vop_compass_probes.configuration_hash<>EXCLUDED.configuration_hash
         THEN NULL ELSE vop_compass_probes.source_update_time END,
       heartbeat_at=now(),updated_at=now()`,
      [
        namespace,
        setup.hash,
        JSON.stringify(setup.configured),
        setup.status,
        setup.error,
        setup.status === "READY",
      ],
    );
    const job = (
      await c.query(
        "SELECT *,requested_at::text AS observed_request FROM vop_compass_probes WHERE namespace=$1",
        [namespace],
      )
    ).rows[0];
    if (setup.status !== "READY") return setup.status;
    if (job.status === "RUNNING") {
      await c.query(
        "UPDATE vop_compass_probes SET status='FAILED',last_error='COMPASS_PROBE_INTERRUPTED',updated_at=now() WHERE namespace=$1",
        [namespace],
      );
      return "FAILED";
    }
    if (!job.requested_at) return "IDLE";
    await c.query(
      `UPDATE vop_compass_probes SET status='RUNNING',last_error=NULL,business_code=NULL,
       row_count=NULL,field_names='[]'::jsonb,has_next_cursor=NULL,source_update_time=NULL,
       last_probe_at=now(),requested_at=CASE WHEN requested_at<=$2::timestamptz THEN NULL ELSE requested_at END,
       updated_at=now() WHERE namespace=$1`,
      [namespace, job.observed_request],
    );
    started = true;
    const response = await new CompassClient(
      client,
      setup.configuration!,
    ).query(setup.parameters);
    const metadata = compassResponseMetadata(response);
    const error = compassBusinessError(response.code);
    const status = error ? "BLOCKED" : "RESPONSE_RECEIVED";
    await c.query(
      `UPDATE vop_compass_probes SET status=$2,last_error=$3,business_code=$4,
       row_count=$5,field_names=$6::jsonb,has_next_cursor=$7,source_update_time=$8,
       heartbeat_at=now(),updated_at=now() WHERE namespace=$1`,
      [
        namespace,
        status,
        error || null,
        metadata.businessCode,
        error ? null : metadata.rowCount,
        JSON.stringify(error ? [] : metadata.fieldNames),
        error ? null : metadata.hasNextCursor,
        error ? null : metadata.sourceUpdateTime,
      ],
    );
    return status;
  } catch (error) {
    if (started)
      await c.query(
        "UPDATE vop_compass_probes SET status='FAILED',last_error=$2,heartbeat_at=now(),updated_at=now() WHERE namespace=$1",
        [
          namespace,
          error instanceof VipError ? error.code : "COMPASS_PROBE_FAILED",
        ],
      );
    return "FAILED";
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

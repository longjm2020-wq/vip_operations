import "dotenv/config";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import {
  VipClient,
  VipError,
} from "../../apps/api/src/integrations/vip/client.js";
import { syncListing } from "../../apps/api/src/integrations/vip/listing.js";

const url = new URL(process.env.DATABASE_URL!);
if (!["localhost", "127.0.0.1"].includes(url.hostname))
  throw Error("Local disposable database required");
const database = "vop_listing_test_" + Date.now();
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query("CREATE DATABASE " + database);
url.pathname = "/" + database;
process.env.DATABASE_URL = url.toString();
const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
const namespace = "listing-test:123";
const client = new VipClient({
  appKey: "test",
  appSecret: "test-only",
  vendorId: 123,
  requestIp: "127.0.0.1",
});
let calls = 0;
let fail: VipError | undefined;
let ambiguous = false;
const now = Date.now() - 1000;
const values: Record<string, unknown> = {
  abc001: {
    code: 200,
    listing_status: 1,
    last_status_change_type: "LISTED",
    last_status_change_time: now,
  },
  abc002: {
    code: 200,
    listing_status: 0,
    last_status_change_type: "UNLISTED",
    last_status_change_time: now,
  },
  "0012345678901234567890": { code: 200, listing_status: 1 },
  absent: { code: 404, listing_status: 0 },
  unpub: { code: 500, listing_status: 0 },
};
client.call = async (service, method, body, token) => {
  calls++;
  assert.equal(service, "com.vip.somp.sales.backend.service.SalesVopService");
  assert.equal(method, "queryConsignmentBarcodeListingInfo");
  assert.equal(token, undefined);
  const input = body as {
    req_context: { vendor_code: number };
    barcode_listing_req: { barcode_list: string[] };
  };
  assert.equal(input.req_context.vendor_code, 123);
  assert.ok(input.barcode_listing_req.barcode_list.length <= 50);
  if (fail) throw fail;
  if (ambiguous) return { abc001: values.abc001, ABC001: values.abc001 };
  return Object.fromEntries(
    input.barcode_listing_req.barcode_list
      .filter((key) => key in values)
      .map((key) => [key, values[key]]),
  );
};
let passed = 0;
const pass = (label: string) => {
  passed++;
  console.log("PASS", label);
};
let databaseClient: { $disconnect(): Promise<void> } | undefined;
try {
  for (const migration of [
    "003_vop_sync.sql",
    "004_vop_details.sql",
    "042_vop_listing_status.sql",
  ])
    await pool.query(
      await readFile("packages/database/migrations/" + migration, "utf8"),
    );
  await pool.query(
    "INSERT INTO vop_connections(namespace,vendor_id,token_cipher,token_expires_at) VALUES($1,123,'not-used-by-no-oauth-method',now()-interval '1 day')",
    [namespace],
  );
  const samples = [
    ["one", "AbC001", "STYLE-A"],
    ["duplicate", "ABC001", "STYLE-A"],
    ["two", "AbC002", "STYLE-A"],
    ["long", "0012345678901234567890", ""],
    ["absent", "ABSENT", "STYLE-ABSENT"],
    ["unpub", "UNPUB", "STYLE-UNPUB"],
    ["missing", "MISSING", "STYLE-MISSING"],
  ];
  for (const [key, barcode, style] of samples)
    await pool.query(
      "INSERT INTO vop_catalog(namespace,external_key,barcode,style_no,product_name,cooperation_no,warehouse,source_updated_at,payload_hash) VALUES($1,$2,$3,$4,'fixture-only',1,'WH',1,'fixture')",
      [namespace, key, barcode, style],
    );
  await pool.query(
    "CREATE TABLE stock_balances(id integer); CREATE TABLE compass_imports(id integer); CREATE TABLE compass_mail_settings(enabled boolean); INSERT INTO compass_mail_settings VALUES(false)",
  );
  assert.equal(await syncListing(pool, client, namespace, 1, 0), "CONTINUING");
  assert.equal(calls, 1);
  assert.equal(
    (await pool.query("SELECT count(*) FROM vop_listing_states")).rows[0].count,
    "6",
  );
  assert.equal(await syncListing(pool, client, namespace, 1, 0), "PARTIAL");
  assert.equal(calls, 1, "successful observations are not repeatedly fetched");
  pass(
    "batch persistence deduplicates catalog aliases and retains deferred missing results",
  );
  const { platformCatalog } =
    await import("../../apps/api/src/integrations/vip/catalog.js");
  const { db } = await import("../../packages/database/src/index.js");
  databaseClient = db;
  const partial = await platformCatalog({ state: "PARTIAL", pageSize: 20 });
  assert.equal(partial.total, 3);
  assert.ok(
    partial.items.every((row) => Number(row.style_barcode_count) === 2),
  );
  assert.ok(partial.items.some((row) => row.barcode === "AbC001"));
  assert.ok(
    (await platformCatalog({})).items.some(
      (row) => row.barcode === "0012345678901234567890",
    ),
  );
  assert.equal((await platformCatalog({ state: "NOT_FOUND" })).total, 1);
  assert.equal((await platformCatalog({ state: "UNPUBLISHED" })).total, 1);
  assert.equal((await platformCatalog({ state: "UNKNOWN" })).total, 1);
  await assert.rejects(() => platformCatalog({ state: "invalid" }));
  pass(
    "server filtering uses all collected barcodes, accurate totals and intact identifiers",
  );
  const lock = await pool.connect();
  await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
    "vop-sync:" + namespace,
  ]);
  assert.equal(await syncListing(pool, client, namespace, 1, 0), "BUSY");
  assert.equal(calls, 1);
  await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
    "vop-sync:" + namespace,
  ]);
  lock.release();
  pass("the shared VOP lock prevents overlapping workers and catalog requests");
  await pool.query(
    "UPDATE vop_listing_jobs SET next_run_at=now() WHERE namespace=$1",
    [namespace],
  );
  await pool.query(
    "UPDATE vop_listing_states SET next_run_at=now() WHERE namespace=$1 AND barcode_key='abc001'",
    [namespace],
  );
  fail = new VipError("NETWORK_FAILED", true);
  assert.equal(await syncListing(pool, client, namespace, 1, 0), "FAILED");
  const prior = (
    await pool.query(
      "SELECT * FROM vop_listing_states WHERE barcode_key='abc001'",
    )
  ).rows[0];
  assert.equal(prior.state, "LISTED");
  assert.equal(prior.last_error, "NETWORK_FAILED");
  assert.equal((await platformCatalog({ state: "PARTIAL" })).total, 0);
  assert.equal((await platformCatalog({ state: "UNKNOWN" })).total, 4);
  assert.equal(await syncListing(pool, client, namespace, 1, 0), "IDLE");
  assert.equal(calls, 2);
  pass(
    "failure preserves prior observations but never presents them as current or offline",
  );
  fail = undefined;
  await pool.query(
    "UPDATE vop_listing_jobs SET next_run_at=now() WHERE namespace=$1",
    [namespace],
  );
  await pool.query(
    "UPDATE vop_listing_states SET next_run_at=now() WHERE namespace=$1 AND barcode_key='abc001'",
    [namespace],
  );
  values.abc001 = {
    code: 200,
    listing_status: 0,
    last_status_change_time: String(now),
  };
  assert.equal(await syncListing(pool, client, namespace, 1, 0), "CONTINUING");
  assert.equal((await platformCatalog({ state: "UNLISTED" })).total, 3);
  pass(
    "successful retry replaces the prior state and clears the failure marker",
  );
  await pool.query(
    "UPDATE vop_listing_states SET checked_at=now()-interval '3 hours' WHERE namespace=$1 AND barcode_key IN ('abc001','abc002')",
    [namespace],
  );
  assert.equal((await platformCatalog({ state: "UNLISTED" })).total, 0);
  const expired = await platformCatalog({ state: "UNKNOWN" });
  assert.equal(expired.total, 4);
  assert.ok(expired.items.some((row) => row.barcode_listing_state === "STALE"));
  pass(
    "stale observations remain visible as history and are excluded from current-state filters",
  );
  await pool.query(
    "UPDATE vop_listing_states SET next_run_at=now() WHERE namespace=$1 AND barcode_key='abc001'",
    [namespace],
  );
  ambiguous = true;
  assert.equal(await syncListing(pool, client, namespace, 1, 0), "BLOCKED");
  const count = calls;
  assert.equal(await syncListing(pool, client, namespace, 1, 0), "IDLE");
  assert.equal(calls, count);
  pass("ambiguous contracts stop repeated requests until an explicit retry");
  ambiguous = false;
  const largeNamespace = "listing-large:123";
  await pool.query(
    "INSERT INTO vop_connections(namespace,vendor_id,token_cipher,token_expires_at) VALUES($1,123,'unused',now())",
    [largeNamespace],
  );
  for (let n = 0; n < 63; n++) {
    const barcode = "batch-" + String(n).padStart(3, "0");
    values[barcode] = { code: 200, listing_status: 1 };
    await pool.query(
      "INSERT INTO vop_catalog(namespace,external_key,barcode,style_no,product_name,cooperation_no,warehouse,source_updated_at,payload_hash) VALUES($1,$2,$2,'LARGE','fixture',1,'WH',1,'fixture')",
      [largeNamespace, barcode],
    );
  }
  const start = calls;
  assert.equal(
    await syncListing(pool, client, largeNamespace, 1, 0),
    "CONTINUING",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM vop_listing_states WHERE namespace=$1 AND checked_at IS NOT NULL",
        [largeNamespace],
      )
    ).rows[0].count,
    "50",
  );
  assert.equal(
    await syncListing(pool, client, largeNamespace, 1, 0),
    "CONTINUING",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM vop_listing_states WHERE namespace=$1 AND checked_at IS NOT NULL",
        [largeNamespace],
      )
    ).rows[0].count,
    "63",
  );
  assert.equal(
    await syncListing(pool, client, largeNamespace, 1, 0),
    "SUCCESS",
  );
  assert.equal(calls - start, 2);
  pass("bounded batches resume without skipping or refetching successful rows");
  assert.equal(
    (await pool.query("SELECT count(*) FROM stock_balances")).rows[0].count,
    "0",
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM compass_imports")).rows[0].count,
    "0",
  );
  assert.equal(
    (await pool.query("SELECT enabled FROM compass_mail_settings")).rows[0]
      .enabled,
    false,
  );
  pass("listing sync does not mutate ERP stock, reports or disabled email");
  console.log(
    `Listing integration: ${passed} scenarios passed; no external requests.`,
  );
} finally {
  await databaseClient?.$disconnect();
  await pool.end();
  await admin.query("DROP DATABASE " + database);
  await admin.end();
}

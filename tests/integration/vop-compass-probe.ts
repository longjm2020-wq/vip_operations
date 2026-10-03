import "dotenv/config";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import {
  VipClient,
  VipError,
} from "../../apps/api/src/integrations/vip/client.js";
import {
  probeCompass,
  type CompassProbeSetup,
} from "../../apps/api/src/integrations/vip/compass-probe.js";

const url = new URL(process.env.DATABASE_URL!);
if (!["localhost", "127.0.0.1"].includes(url.hostname))
  throw Error("Compass integration tests require a local disposable database");
const database = "vop_compass_test_" + Date.now();
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query("CREATE DATABASE " + database);
url.pathname = "/" + database;
const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
const namespace = "test:123";
const client = new VipClient({
  appKey: "test",
  appSecret: "test-only",
  vendorId: 123,
  requestIp: "127.0.0.1",
});
const setup: CompassProbeSetup = {
  configured: {
    account: true,
    privateKeyFile: true,
    apiCode: true,
    parameters: true,
  },
  hash: "test-configuration-v1",
  status: "READY",
  error: null,
  configuration: {
    account: "example",
    apiCode: "documented-code",
    privateKey: generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey,
  },
  parameters: { date: "2026-10-02" },
};
let calls = 0;
let result: unknown = {
  code: "example-status",
  msg: "provider secret text not retained",
  data: [{ product_id: "12345678901234567890", sales: "15.80" }],
  searchAfterIndex: "private-cursor-not-retained",
  updateTime: "2026-10-03 08:21:00",
};
client.call = async (service, method, input, token) => {
  calls++;
  assert.equal(
    service,
    "com.vip.data.compass.service.vop.CompassDataOspService",
  );
  assert.equal(method, "data");
  assert.equal(
    token,
    undefined,
    "documented no-OAuth method must not copy browser authentication",
  );
  assert.equal((input as { vendor_id: string }).vendor_id, "123");
  return result;
};
const state = async () =>
  (
    await pool.query("SELECT * FROM vop_compass_probes WHERE namespace=$1", [
      namespace,
    ])
  ).rows[0];
const request = async () =>
  pool.query(
    "UPDATE vop_compass_probes SET requested_at=clock_timestamp(),status='PENDING' WHERE namespace=$1",
    [namespace],
  );
let passed = 0;
const pass = (label: string) => {
  passed++;
  console.log("PASS", label);
};
try {
  for (const migration of ["003_vop_sync.sql", "041_vop_compass_probe.sql"])
    await pool.query(
      await readFile("packages/database/migrations/" + migration, "utf8"),
    );
  await pool.query(
    "INSERT INTO vop_connections(namespace,vendor_id,token_cipher,token_expires_at) VALUES($1,123,'test-only-not-used',now())",
    [namespace],
  );
  // These guards prove the probe does not need report or ERP writes.
  await pool.query(
    "CREATE TABLE compass_imports(id integer); CREATE TABLE stock_balances(id integer); CREATE TABLE compass_mail_settings(enabled boolean); INSERT INTO compass_mail_settings VALUES(false)",
  );
  assert.equal(await probeCompass(pool, client, namespace, setup), "IDLE");
  assert.equal(calls, 0);
  assert.equal((await state()).status, "READY");
  pass("configuration is checked without automatically requesting data");
  await request();
  assert.equal(
    await probeCompass(pool, client, namespace, setup),
    "RESPONSE_RECEIVED",
  );
  let current = await state();
  assert.equal(calls, 1);
  assert.equal(
    current.requested_at,
    null,
    "microsecond request timestamp is fully consumed",
  );
  assert.equal(current.row_count, 1);
  assert.deepEqual(current.field_names, ["product_id", "sales"]);
  assert.equal(current.has_next_cursor, true);
  const stored = JSON.stringify(current);
  for (const sensitive of [
    "12345678901234567890",
    "private-cursor",
    "provider secret",
    "PRIVATE KEY",
    "sign",
  ])
    assert.ok(!stored.includes(sensitive));
  assert.equal(await probeCompass(pool, client, namespace, setup), "IDLE");
  assert.equal(calls, 1, "no automatic pagination or retry after response");
  pass("one page only, with metadata retained and values/signatures discarded");
  result = { code: "403", msg: "provider secret text", data: [] };
  await request();
  assert.equal(await probeCompass(pool, client, namespace, setup), "BLOCKED");
  current = await state();
  assert.equal(current.last_error, "COMPASS_ACCESS_OR_CONCURRENCY_REJECTED");
  assert.equal(current.business_code, "403");
  assert.equal(current.row_count, null);
  assert.deepEqual(current.field_names, []);
  assert.equal(await probeCompass(pool, client, namespace, setup), "IDLE");
  assert.equal(calls, 2);
  pass(
    "gateway acceptance does not turn a business rejection into synchronization success",
  );
  const disabled: CompassProbeSetup = {
    configured: {
      account: false,
      privateKeyFile: false,
      apiCode: false,
      parameters: false,
    },
    hash: "disabled",
    status: "NOT_CONFIGURED",
    error: null,
  };
  assert.equal(
    await probeCompass(pool, client, namespace, disabled),
    "NOT_CONFIGURED",
  );
  current = await state();
  assert.equal(current.ready_for_probe, false);
  assert.equal(current.last_probe_at, null);
  assert.equal(current.business_code, null);
  assert.equal(current.has_next_cursor, null);
  assert.equal(calls, 2);
  pass(
    "configuration changes invalidate old response metadata and pending requests",
  );
  const rotated = { ...setup, hash: "test-configuration-v2" };
  await probeCompass(pool, client, namespace, rotated);
  const lock = await pool.connect();
  await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
    "vop-sync:" + namespace,
  ]);
  await request();
  assert.equal(await probeCompass(pool, client, namespace, rotated), "BUSY");
  assert.equal(calls, 2);
  await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
    "vop-sync:" + namespace,
  ]);
  lock.release();
  await pool.query(
    "UPDATE vop_compass_probes SET status='RUNNING',requested_at=NULL WHERE namespace=$1",
    [namespace],
  );
  assert.equal(await probeCompass(pool, client, namespace, rotated), "FAILED");
  assert.equal((await state()).last_error, "COMPASS_PROBE_INTERRUPTED");
  assert.equal(calls, 2);
  pass("shared VOP lock and interrupted worker state prevent duplicate calls");
  const receive = client.call;
  client.call = async () => {
    calls++;
    throw new VipError("NETWORK_FAILED", true);
  };
  await request();
  assert.equal(await probeCompass(pool, client, namespace, rotated), "FAILED");
  assert.equal((await state()).last_error, "NETWORK_FAILED");
  assert.equal(await probeCompass(pool, client, namespace, rotated), "IDLE");
  assert.equal(calls, 3);
  client.call = receive;
  result = { code: "example-status", data: [{ id: 123 }] };
  await request();
  assert.equal(await probeCompass(pool, client, namespace, rotated), "FAILED");
  assert.equal((await state()).last_error, "COMPASS_RESPONSE_INVALID");
  pass(
    "transport and response errors remain observable without unsafe retries or numeric ID coercion",
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM compass_imports")).rows[0].count,
    "0",
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM stock_balances")).rows[0].count,
    "0",
  );
  assert.equal(
    (await pool.query("SELECT enabled FROM compass_mail_settings")).rows[0]
      .enabled,
    false,
  );
  pass("existing reports, ERP stock and disabled daily email are unchanged");
  console.log(`Compass probe integration: ${passed} scenarios passed.`);
} finally {
  await pool.end();
  await admin.query("DROP DATABASE " + database);
  await admin.end();
}

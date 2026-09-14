import "dotenv/config";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
import {
  VipClient,
  VipError,
  seal,
  unseal,
  safeSku,
  type Token,
} from "../../apps/api/src/integrations/vip/client.js";
import { syncCatalog } from "../../apps/api/src/integrations/vip/sync.js";
const database = "vop_sync_test_" + Date.now();
const url = new URL(process.env.DATABASE_URL!);
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query("CREATE DATABASE " + database);
url.pathname = "/" + database;
const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
const credentials = {
  appKey: "test",
  appSecret: "test-secret",
  vendorId: 123,
  requestIp: "127.0.0.1",
};
const initial: Token = {
  accessToken: "initial-access",
  refreshToken: "initial-refresh",
  expiresAt: Date.now() + 7 * 86400000,
};
const sku = (name = "new", updated = 100) => ({
  barcode: "001",
  sn: "STYLE",
  product_name: name,
  cooperation_no: 1,
  warehouse: "WH",
  latest_update_time: updated,
});
let count = 0;
const pass = (s: string) => {
  count++;
  console.log("PASS", s);
};
try {
  await pool.query(
    await readFile("packages/database/migrations/003_vop_sync.sql", "utf8"),
  );
  const client = new VipClient(credentials);
  const calls: number[] = [];
  client.page = async (_token, _from, _to, page) => {
    calls.push(page);
    if (page === 2) throw new VipError("NETWORK_FAILED", true);
    return { list: [sku()], has_next: true };
  };
  const failed = await syncCatalog(pool, client, "test:123", initial);
  assert.equal(failed.status, "FAILED");
  const state = (await pool.query("SELECT * FROM vop_connections")).rows[0];
  assert.equal(state.next_page, 2);
  assert.equal(Number(state.watermark), 0);
  assert.equal(state.status, "RETRY");
  const windowEnd = state.window_end;
  pass("page commit survives network failure without advancing watermark");
  client.page = async (_token, _from, to, page) => {
    assert.equal(String(to), windowEnd);
    calls.push(page);
    return { list: [sku()], has_next: false };
  };
  await syncCatalog(pool, client, "test:123", initial);
  assert.deepEqual(calls, [1, 2, 2]);
  assert.equal((await pool.query("SELECT * FROM vop_catalog")).rowCount, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT changed FROM vop_sync_runs ORDER BY id DESC LIMIT 1",
      )
    ).rows[0].changed,
    0,
  );
  pass("resume starts at failed page; duplicate record is idempotent");
  client.page = async (_token, from) => {
    assert.equal(from, Number(windowEnd) - 300);
    return { list: [sku("old", 90)], has_next: false };
  };
  await syncCatalog(pool, client, "test:123", initial);
  assert.equal(
    (await pool.query("SELECT product_name FROM vop_catalog")).rows[0]
      .product_name,
    "new",
  );
  pass("incremental overlap rejects older source updates");
  client.page = async () => ({
    list: [{ barcode: "bad", secret: "not retained" }],
    has_next: false,
  });
  await syncCatalog(pool, client, "test:123", initial);
  assert.equal(
    (await pool.query("SELECT status FROM vop_connections")).rows[0].status,
    "PARTIAL",
  );
  const bad = (await pool.query("SELECT payload FROM vop_sync_rejections"))
    .rows[0].payload;
  assert.equal(bad.secret, undefined);
  pass("invalid rows are isolated durably without unrelated fields");
  const repair = safeSku({ ...sku("repaired", 200), barcode: "002" });
  const hash = createHash("sha256")
    .update(JSON.stringify(repair))
    .digest("hex");
  await pool.query(
    "INSERT INTO vop_sync_rejections(namespace,record_hash,payload,error_code) VALUES($1,$2,$3,$4)",
    ["test:123", hash, JSON.stringify(repair), "OLD_CONTRACT"],
  );
  client.page = async () => ({ list: [], has_next: false });
  await syncCatalog(pool, client, "test:123", initial);
  assert.equal(
    (await pool.query("SELECT * FROM vop_catalog WHERE barcode=$1", ["002"]))
      .rowCount,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT * FROM vop_sync_rejections WHERE record_hash=$1",
        [hash],
      )
    ).rowCount,
    0,
  );
  pass("quarantine replay recovers valid records after adapter correction");
  const lock = await pool.connect();
  await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
    "vop-sync:test:123",
  ]);
  assert.equal(
    (await syncCatalog(pool, client, "test:123", initial)).status,
    "BUSY",
  );
  await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
    "vop-sync:test:123",
  ]);
  lock.release();
  pass("concurrent workers cannot duplicate the same connection job");
  const expired = { ...initial, expiresAt: Date.now() - 1 };
  await pool.query("UPDATE vop_connections SET token_cipher=$1", [
    seal(expired, credentials.appSecret, "test:123"),
  ]);
  const rotated = {
    accessToken: "rotated-access",
    refreshToken: "rotated-refresh",
    expiresAt: Date.now() + 7 * 86400000,
  };
  let refreshes = 0;
  client.refresh = async () => {
    refreshes++;
    return rotated;
  };
  client.page = async (token) => {
    const cipher = (
      await pool.query("SELECT token_cipher FROM vop_connections")
    ).rows[0].token_cipher;
    assert.equal(cipher.includes(rotated.accessToken), false);
    assert.deepEqual(
      unseal(cipher, credentials.appSecret, "test:123"),
      rotated,
    );
    assert.deepEqual(token, rotated);
    return { list: [], has_next: false };
  };
  await syncCatalog(pool, client, "test:123", initial);
  await syncCatalog(pool, client, "test:123", initial);
  assert.equal(refreshes, 1);
  pass(
    "rotated credentials are encrypted before querying; stale bootstrap cannot overwrite them",
  );
  await pool.query(
    "UPDATE vop_connections SET reconciled_at=now()-interval '2 days'",
  );
  client.page = async (_token, from) => {
    assert.equal(from, 0);
    return { list: [], has_next: false };
  };
  await syncCatalog(pool, client, "test:123", initial);
  pass("daily full reconciliation revisits late changes");
  await pool.query("UPDATE vop_connections SET token_cipher=$1", [
    seal(expired, credentials.appSecret, "test:123"),
  ]);
  client.refresh = async () => {
    refreshes++;
    throw new VipError("NETWORK_FAILED", true);
  };
  const unsafe = await syncCatalog(pool, client, "test:123", initial);
  assert.equal(unsafe.code, "REFRESH_RECOVERY_REQUIRED");
  await syncCatalog(pool, client, "test:123", initial, 10, true);
  assert.equal(refreshes, 2);
  pass(
    "uncertain refresh blocks repeated token rotation, including manual retry",
  );
  await pool.query("UPDATE vop_connections SET status='READY',last_error=NULL");
  await pool.query(`CREATE FUNCTION fail_rotation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.status='REFRESHING' THEN RAISE EXCEPTION 'injected write failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_rotation BEFORE UPDATE OF token_cipher ON vop_connections FOR EACH ROW EXECUTE FUNCTION fail_rotation()`);
  client.refresh = async () => {
    refreshes++;
    return rotated;
  };
  assert.equal(
    (await syncCatalog(pool, client, "test:123", initial)).code,
    "REFRESH_RECOVERY_REQUIRED",
  );
  await syncCatalog(pool, client, "test:123", initial, 10, true);
  assert.equal(refreshes, 3);
  pass(
    "credential storage failure after successful rotation requires recovery without replaying the old token",
  );
  console.log(`VOP integration: ${count} scenarios passed.`);
} finally {
  await pool.end();
  await admin.query("DROP DATABASE " + database);
  await admin.end();
}

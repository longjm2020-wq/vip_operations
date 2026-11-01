import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";

const base = new URL(process.env.DATABASE_URL || "");
assert.ok(["127.0.0.1", "localhost"].includes(base.hostname));
assert.equal(base.port, "55538", "Use the isolated inventory test cluster");
const database = "inventory_trend_test_" + Date.now();
const admin = new pg.Client({ connectionString: base.toString() });
await admin.connect(); await admin.query(`CREATE DATABASE ${database}`);
base.pathname = "/" + database; process.env.DATABASE_URL = base.toString();
let disconnect = async () => {}, fixture: pg.Client | undefined, passed = 0;
const check = async (name: string, work: () => Promise<void>) => { await work(); console.log("PASS", ++passed, name); };
try {
  await migrate();
  const { db, camel } = await import("../../packages/database/src/index.js");
  disconnect = () => db.$disconnect();
  const { inventoryTrend } = await import("../../apps/api/src/modules/inventory/trend.js");
  const { inventorySummary } = await import("../../apps/api/src/modules/inventory/summary.js");
  fixture = new pg.Client({ connectionString: base.toString() }); await fixture.connect();
  const sql = async (text: string, values: unknown[] = []) => (await fixture!.query(text, values)).rows;
  const [user, other] = await sql("INSERT INTO users(username,display_name,password_hash) VALUES('trend','趋势测试','test'),('trend-other','其他账号','test') RETURNING id::text");
  const actor = { id: user.id, username: "trend", displayName: "趋势测试", permissions: ["inventory.read"] };
  const [supplier] = await sql("INSERT INTO suppliers(supplier_code,name) VALUES('TREND','测试') RETURNING id");
  const [category] = await sql("INSERT INTO categories(code,name) VALUES('TREND','测试') RETURNING id");
  const [product] = await sql("INSERT INTO products(style_no,name,category_id,default_supplier_id) VALUES('STYLE-A','测试款',$1,$2) RETURNING id", [category.id, supplier.id]);
  const [sku, second] = await sql(`INSERT INTO skus(product_id,sku_code,barcode,color_code,color_name,size_code,size_name)
    VALUES($1,'000000012345678901234','000123','PINK','粉色','L','L'),($1,'SECOND','000124','PINK','粉色','M','M') RETURNING id::text,sku_code`, [product.id]);
  await sql("INSERT INTO inventory_sku_references(sku_id,article_no,source_note,reference_date,updated_by) VALUES($1,'ARTICLE-A','test',current_date,$3),($2,'ARTICLE-B','test',current_date,$3)", [sku.id, second.id, user.id]);
  const [field] = await sql(`INSERT INTO inventory_calculation_fields(owner_id,name,formula) VALUES($1,'在仓可用库存','[实际库存数]+[销退仓库存]+[进货仓库存]-[订单占有数]') RETURNING id::text`, [user.id]);
  await sql("UPDATE jushuitan_inventory_settings SET warehouse_name='序缇杭州总仓' WHERE id=1");
  const snapshot = async (at: string, physical: number | null, options: { second?: boolean; warehouse?: string; failed?: boolean; missing?: boolean } = {}) => {
    const run = randomUUID(), count = options.second ? 2 : 1;
    await sql(`INSERT INTO jushuitan_inventory_runs(id,settings_version,warehouse_name,trigger_type,status)
      VALUES($1,1,$2,'MANUAL','RUNNING')`, [run, options.warehouse ?? "序缇杭州总仓"]);
    await sql(`INSERT INTO jushuitan_inventory_snapshots(run_id,sku_code,physical_qty,reserved_qty,return_qty,incoming_qty,in_transit_qty,transfer_transit_qty)
      VALUES($1,$2,$3,1,2,1,50,0)`, [run, options.missing ? second.sku_code : sku.sku_code, physical]);
    if (options.second) await sql(`INSERT INTO jushuitan_inventory_snapshots(run_id,sku_code,physical_qty,reserved_qty,return_qty,incoming_qty,in_transit_qty,transfer_transit_qty)
      VALUES($1,$2,5,0,0,0,0,0)`, [run, second.sku_code]);
    await sql("UPDATE jushuitan_inventory_runs SET status=$2,finished_at=$3,received_count=$4,requested_count=2 WHERE id=$1", [run, options.failed ? "FAILED" : "COMPLETE", at, count]);
    if (!options.failed && !options.warehouse) await sql("UPDATE jushuitan_inventory_settings SET active_run_id=$1 WHERE id=1", [run]);
    return run;
  };
  const query = (extra: Record<string, unknown> = {}, who = actor) => inventoryTrend(who, { skuId: sku.id, period: "3d", endDate: "2026-11-02", fieldId: field.id, ...extra });
  await check("Beijing dates, latest daily snapshot, formula and adjacent delta", async () => {
    await snapshot("2026-10-31T15:50:00Z", 5, { second: true });
    await snapshot("2026-10-31T16:01:00Z", 9);
    await snapshot("2026-11-01T12:00:00Z", 19);
    await snapshot("2026-11-02T01:00:00Z", 21);
    const result = await query();
    assert.deepEqual(result.points.map((p: any) => p.stockQty), [7, 21, 23]);
    assert.deepEqual(result.points.map((p: any) => p.stockDelta), [null, 14, 2]);
    assert.equal(result.warehouseName, "序缇杭州总仓");
    await snapshot("2026-11-01T10:00:00Z", 999);
    assert.equal((await query()).points[1].stockQty, 21, "Older run cannot overwrite a newer complete day");
  });
  await check("Failed runs, another warehouse and missing days never fill gaps", async () => {
    await snapshot("2026-11-01T14:00:00Z", 999, { failed: true });
    await snapshot("2026-11-01T15:00:00Z", 888, { warehouse: "其他仓" });
    assert.equal((await query()).points[1].stockQty, 21);
    const earlier = await query({ endDate: "2026-10-31" });
    assert.deepEqual(earlier.points.map((p: any) => p.stockQty), [null, null, 7]);
    assert.equal(earlier.points[2].stockDelta, null);
    const later = await query({ endDate: "2026-11-05" });
    assert.ok(later.points.every((p: any) => p.stockQty === null));
  });
  await check("Daily replacement removes a SKU absent from the latest run", async () => {
    await snapshot("2026-11-02T02:00:00Z", 3, { missing: true });
    const result = await query();
    assert.equal(result.points[2].stockQty, null);
    assert.equal(result.points[2].stockState, "NO_MATCH");
    assert.equal(result.points[2].stockDelta, null);
    await snapshot("2026-11-02T03:00:00Z", null);
    assert.equal((await query()).points[2].stockState, "UNKNOWN");
  });
  await check("Daily history survives raw snapshot cleanup", async () => {
    await sql("DELETE FROM jushuitan_inventory_snapshots");
    assert.deepEqual((await query()).points.map((p: any) => p.stockQty), [7, 21, null]);
  });
  await check("Formula access, visibility and revision remain enforced server-side", async () => {
    await assert.rejects(() => query({}, { ...actor, permissions: [] }));
    await assert.rejects(() => query({}, { ...actor, id: other.id, roleCodes: ["SUPER_ADMIN"] } as typeof actor));
    await sql("UPDATE inventory_calculation_fields SET is_public=true WHERE id=$1", [field.id]);
    assert.equal((await query({}, { ...actor, id: other.id })).points[0].stockQty, 7);
    await sql("UPDATE inventory_calculation_fields SET formula='[实际库存数]*2',revision=revision+1 WHERE id=$1", [field.id]);
    assert.equal((await query()).points[0].stockQty, 10);
    await sql("UPDATE inventory_calculation_fields SET formula='[实际库存数]/[调拨在途数]',revision=revision+1 WHERE id=$1", [field.id]);
    assert.equal((await query()).points[0].stockQty, null);
    assert.equal((await query({ fieldId: undefined })).points[0].stockState, "NO_FIELD");
    await sql("UPDATE inventory_calculation_fields SET is_public=false WHERE id=$1", [field.id]);
    await assert.rejects(() => query({}, { ...actor, id: other.id }));
    await assert.rejects(() => query({ endDate: "2026-02-30" }));
  });
  await check("Sales preserve explicit zero, missing rows, null cells and duplicate ambiguity", async () => {
    for (const day of ["2026-10-31", "2026-11-01", "2026-11-02"]) await sql(`INSERT INTO compass_barcode_history_days
      VALUES($1,1,'original.xlsx','hash','2026-10-31','2026-11-02',3,now())`, [day]);
    await sql(`INSERT INTO compass_barcode_history_records VALUES('2026-10-31','a','000123','{"metrics":{"salesQty":0}}'),('2026-11-01','a','000123','{"metrics":{"salesQty":11}}')`);
    const result = await query();
    assert.deepEqual(result.points.map((p: any) => p.salesQty), [0, 11, null]);
    assert.equal(result.periodSalesQty, 11); assert.equal(result.coverage.salesDays, 2);
    assert.equal(result.points[2].salesState, "NO_RECORD");
    await sql(`INSERT INTO compass_barcode_history_records VALUES('2026-11-02','a','000123','{"metrics":{"salesQty":null}}')`);
    assert.equal((await query()).periodSalesQty, null);
    await sql(`INSERT INTO compass_barcode_history_records VALUES('2026-11-01','b','000123','{"metrics":{"salesQty":10}}')`);
    const ambiguous = await query();
    assert.equal(ambiguous.points[1].salesQty, null); assert.equal(ambiguous.points[1].salesState, "AMBIGUOUS");
    assert.equal(ambiguous.periodSalesQty, null); assert.equal(ambiguous.ambiguousSales, true);
    await sql("DELETE FROM compass_barcode_history_days WHERE business_date='2026-10-31'");
    assert.equal((await query()).points[0].salesState, "NO_REPORT");
  });
  await check("Batch exact OR matching deduplicates, preserves long codes and applies before aggregation", async () => {
    await snapshot("2026-11-02T04:00:00Z", 10, { second: true });
    const summary = async (codes: string[], dimension = "sku") => camel(await inventorySummary({ stockSource: "jushuitan", codes, dimension }, db, user.id));
    const mixed = await summary([sku.sku_code, "article-b", sku.sku_code]);
    assert.equal(mixed.total, 2); assert.equal(mixed.totals.physicalQty, 15);
    assert.equal((await summary(["STYLE-A", "000123"])).total, 2);
    assert.equal((await summary(["00000001234567890123"])).total, 0);
    assert.equal((await summary(["%"])).total, 0);
    assert.equal((await summary(["000123"])).total, 1);
    const grouped = await summary(["STYLE-A"], "style");
    assert.equal(grouped.total, 1); assert.equal(grouped.totals.physicalQty, 15);
    const thousand = [sku.sku_code, ...Array.from({ length: 999 }, (_, i) => `UNMATCHED-${i}`)];
    assert.equal((await summary(thousand)).total, 1);
    await assert.rejects(() => summary([...thousand, "OVERFLOW"]));
  });
  await check("Upgrade backfill uses only retained latest daily snapshots", async () => {
    await sql("DROP TRIGGER jushuitan_capture_daily_history ON jushuitan_inventory_runs; DROP FUNCTION capture_jushuitan_inventory_history(); DROP FUNCTION publish_jushuitan_inventory_history(uuid); DROP TABLE jushuitan_inventory_history_records; DROP TABLE jushuitan_inventory_history_days");
    await sql(await readFile("packages/database/migrations/081_inventory_daily_history.sql", "utf8"));
    const result = await query();
    assert.equal(result.points[0].stockState, "NO_SNAPSHOT");
    assert.equal(result.points[1].stockState, "NO_SNAPSHOT");
    assert.equal(result.points[2].snapshotAt != null, true);
  });
  console.log(`${passed} inventory trend and batch search checks passed`);
} finally {
  await fixture?.end(); await disconnect();
  await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); await admin.end();
}

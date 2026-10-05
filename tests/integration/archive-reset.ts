import "dotenv/config";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
import {
  previewArchiveReset,
  resetProductArchive,
} from "../../scripts/reset-product-archive.js";

const root = new URL(process.env.DATABASE_URL!);
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(root.hostname),
  "Reset tests must use localhost",
);
root.pathname = "/postgres";
const admin = new pg.Client({ connectionString: root.toString() });
const name = "archive_reset_test_" + Date.now();
await admin.connect();
await admin.query("CREATE DATABASE " + name);
const url = new URL(root);
url.pathname = "/" + name;
const client = new pg.Client({ connectionString: url.toString() });
try {
  await migrate(url.toString());
  await client.connect();
  const user = (
    await client.query(
      "INSERT INTO users(username,display_name,password_hash) VALUES('fixture','Fixture','unused') RETURNING id",
    )
  ).rows[0].id;
  const category = (
    await client.query(
      "INSERT INTO categories(code,name) VALUES('fixture','Fixture') RETURNING id",
    )
  ).rows[0].id;
  const warehouse = (
    await client.query(
      "INSERT INTO warehouses(code,name) VALUES('fixture','Fixture') RETURNING id",
    )
  ).rows[0].id;
  const archive = (
    await client.query(
      "INSERT INTO project_tables(name,created_by,system_key) VALUES('商品档案',$1,'PRODUCT_ARCHIVE') RETURNING id",
      [user],
    )
  ).rows[0].id;
  await client.query("SELECT create_project_table_workspace($1)", [archive]);
  const other = (
    await client.query(
      "INSERT INTO project_tables(name,created_by) VALUES('Other',$1) RETURNING id",
      [user],
    )
  ).rows[0].id;
  await client.query("SELECT create_project_table_workspace($1)", [other]);
  const schema = '"selection_table_' + archive + '"';
  await client.query(
    "INSERT INTO public.style_selections(xuti_style_no,created_by) VALUES('keep-source',$1)",
    [user],
  );
  await client.query(
    `INSERT INTO "selection_table_${other}".style_selections(xuti_style_no,created_by) VALUES('keep-other',$1)`,
    [user],
  );
  const product = (
    await client.query(
      "INSERT INTO products(style_no,name,category_id) VALUES('reset-product','Fixture',$1) RETURNING id",
      [category],
    )
  ).rows[0].id;
  const sku = (
    await client.query(
      "INSERT INTO skus(product_id,sku_code,color_code,color_name,size_code,size_name) VALUES($1,'reset-sku','B','Black','M','M') RETURNING id",
      [product],
    )
  ).rows[0].id;
  await client.query(
    "INSERT INTO inventory_balances(warehouse_id,sku_id,physical_qty) VALUES($1,$2,5)",
    [warehouse, sku],
  );
  const adjustment = (
    await client.query(
      "INSERT INTO inventory_adjustments(adjustment_no,warehouse_id,sku_id,quantity,reason,remark,operator_id) VALUES('reset-adjustment',$1,$2,5,'OPENING','Fixture',$3) RETURNING id",
      [warehouse, sku, user],
    )
  ).rows[0].id;
  await client.query(
    "INSERT INTO inventory_transactions(warehouse_id,sku_id,transaction_type,physical_delta,before_physical,after_physical,before_reserved,after_reserved,before_damaged,after_damaged,source_type,source_id,source_no,adjustment_id,operator_id) VALUES($1,$2,'STOCK_ADJUSTMENT',5,0,5,0,0,0,0,'ADJUSTMENT',$3,'reset-adjustment',$3,$4)",
    [warehouse, sku, adjustment, user],
  );
  await client.query(
    "INSERT INTO inventory_sku_references(sku_id,source_note,reference_date,updated_by) VALUES($1,'Fixture',current_date,$2)",
    [sku, user],
  );
  await client.query(
    `INSERT INTO ${schema}.style_selection_images(id,content_type,content,created_by) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','image/png',decode('0102','hex'),$1)`,
    [user],
  );
  const original = await previewArchiveReset(client);

  await assert.rejects(
    resetProductArchive(client, original, async () => {
      throw Error("Backup unavailable");
    }),
    /Backup unavailable/,
  );
  assert.deepEqual(await previewArchiveReset(client), original);
  console.log("PASS backup failure rolls back and leaves all data intact");

  await client.query("UPDATE products SET name='Changed' WHERE id=$1", [
    product,
  ]);
  await assert.rejects(
    resetProductArchive(client, original, async () => {}),
    /Data changed/,
  );
  console.log("PASS stale preview cannot clear newer business data");
  const current = await previewArchiveReset(client);
  await client.query(
    "INSERT INTO purchase_suggestions(sku_id,available_qty_snapshot,in_transit_qty_snapshot,sales_7d_snapshot,avg_daily_sales,target_stock_days,suggested_qty,source_kind,algorithm_version,input_snapshot) VALUES($1,5,0,0,0,14,0,'fixture','fixture','{}')",
    [sku],
  );
  await assert.rejects(
    resetProductArchive(client, current, async () => {}),
    /business orders/,
  );
  await client.query("DELETE FROM purchase_suggestions");
  console.log("PASS purchase dependencies are guarded without deleting orders");
  await client.query(
    "UPDATE public.style_selections SET product_id=$1 WHERE xuti_style_no='keep-source'",
    [product],
  );
  await assert.rejects(
    resetProductArchive(client, current, async () => {}),
    /Other sheets/,
  );
  await client.query(
    "UPDATE public.style_selections SET product_id=NULL WHERE xuti_style_no='keep-source'",
  );
  console.log("PASS other sheet product references are protected");

  // Force a late failure after the destructive statements to verify transactional trigger restoration.
  await client.query(
    "CREATE FUNCTION reject_fixture_reset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='RESET' THEN RAISE EXCEPTION 'fixture late failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_reset_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_fixture_reset()",
  );
  await assert.rejects(
    resetProductArchive(client, current, async () => {}),
    /fixture late failure/,
  );
  assert.deepEqual(await previewArchiveReset(client), current);
  assert.equal(
    (
      await client.query(
        "SELECT tgenabled FROM pg_trigger WHERE tgname='inventory_history_immutable'",
      )
    ).rows[0].tgenabled,
    "O",
  );
  await client.query(
    "DROP TRIGGER fixture_reset_failure ON audit_logs; DROP FUNCTION reject_fixture_reset()",
  );
  console.log("PASS late failure restores rows and immutable history trigger");

  let backupRows = 0;
  const result = await resetProductArchive(client, current, async (backup) => {
    backupRows = backup.tables.reduce(
      (sum, table) => sum + table.records.length,
      0,
    );
    assert.ok(
      backup.tables.find((table) =>
        table.name.endsWith(".style_selection_images"),
      )!.records.length,
    );
  });
  assert.ok(backupRows >= 8);
  assert.ok(Object.values(result.after.counts).every((value) => value === 0));
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM public.style_selections",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await client.query(
        `SELECT count(*)::int AS n FROM "selection_table_${other}".style_selections`,
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await client.query("SELECT count(*)::int AS n FROM users")).rows[0].n,
    1,
  );
  assert.equal(
    (await client.query("SELECT count(*)::int AS n FROM warehouses")).rows[0].n,
    1,
  );
  assert.equal(
    (
      await client.query(
        `SELECT count(*)::int AS n FROM ${schema}.style_selection_protection`,
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE action='RESET'",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await client.query(
        "SELECT tgenabled FROM pg_trigger WHERE tgname='inventory_history_immutable'",
      )
    ).rows[0].tgenabled,
    "O",
  );
  console.log(
    "PASS authorized reset clears archive, SKU and inventory while retaining other workspaces and permissions",
  );
  await client.query(
    "INSERT INTO products(style_no,name,category_id) VALUES('new-product','New',$1)",
    [category],
  );
  assert.equal(
    (
      await client.query(
        `SELECT count(*)::int AS n FROM ${schema}.style_selections WHERE xuti_style_no='new-product'`,
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await client.query(
        `SELECT count(*)::int AS n FROM ${schema}.style_selections WHERE xuti_style_no='reset-product'`,
      )
    ).rows[0].n,
    0,
  );
  console.log(
    "PASS new products still mirror normally and deleted products do not return",
  );
} finally {
  await client.end().catch(() => {});
  await admin.query("DROP DATABASE " + name + " WITH (FORCE)");
  await admin.end();
}

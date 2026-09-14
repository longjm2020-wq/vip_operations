import "dotenv/config";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { VipClient, seal } from "../../apps/api/src/integrations/vip/client.js";
import {
  adaptDetail,
  imageUrl,
  syncDetails,
} from "../../apps/api/src/integrations/vip/details.js";
const credentials = {
  appKey: "test",
  appSecret: "secret",
  vendorId: 123,
  requestIp: "127.0.0.1",
};
const token = {
  accessToken: "a",
  refreshToken: "r",
  expiresAt: Date.now() + 86400000,
};
const product = (barcode = "001") => ({
  vendor_id: 123,
  barcode,
  brand_id: 1,
  category_id: 2,
  flat_sale_props: { 134: "灰色", 453: "M" },
  market_price: 1797,
  sell_price: 0,
  currency: "CNY",
  product_image: "/upload/example.jpg",
});
assert.equal(adaptDetail(product(), 123).color, "灰色");
assert.equal(adaptDetail(product(), 123).sellPrice, 0);
assert.equal(
  adaptDetail({ vendor_id: 123, barcode: "empty" }, 123).sellPrice,
  null,
);
assert.throws(() => adaptDetail(product(), 456));
assert.equal(imageUrl("javascript:alert(1)"), null);
assert.equal(imageUrl("https://evil.example/image.jpg"), null);
assert.equal(imageUrl("/upload/a.jpg"), "https://a.vpimg4.com/upload/a.jpg");
const url = new URL(process.env.DATABASE_URL!);
const database = "vop_details_test_" + Date.now();
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query("CREATE DATABASE " + database);
url.pathname = "/" + database;
const pool = new pg.Pool({ connectionString: url.toString() });
try {
  for (const file of ["003_vop_sync.sql", "004_vop_details.sql"])
    await pool.query(
      await readFile("packages/database/migrations/" + file, "utf8"),
    );
  await pool.query(
    "INSERT INTO vop_connections(namespace,vendor_id,token_cipher,token_expires_at,status) VALUES($1,123,$2,$3,'SUCCESS')",
    ["test:123", seal(token, "secret", "test:123"), new Date(token.expiresAt)],
  );
  await pool.query(
    "INSERT INTO vop_catalog(namespace,external_key,barcode,style_no,product_name,cooperation_no,warehouse,source_updated_at,payload_hash) VALUES('test:123','key','001','STYLE','name',1,'WH',1,'hash')",
  );
  const client = new VipClient(credentials);
  const pages: number[] = [];
  let failSecond = true;
  client.call = async (_service, method, input) => {
    if (method === "getBrandInfo") return { brand_name: "品牌" };
    if (method === "getCategoryById") return { category_name: "品类" };
    const i = input as { page: number; sn: string };
    assert.equal(i.sn, "STYLE");
    pages.push(i.page);
    if (i.page === 2 && failSecond) throw Error("network");
    const products =
      i.page === 1
        ? Array.from({ length: 20 }, (_, n) =>
            product(String(n + 1).padStart(3, "0")),
          )
        : [product("021")];
    return { total: products.length, products };
  };
  assert.equal(await syncDetails(pool, client, "test:123", 1, 0), "CONTINUING");
  assert.equal(
    (await pool.query("SELECT next_page FROM vop_detail_tasks")).rows[0]
      .next_page,
    2,
  );
  assert.equal(await syncDetails(pool, client, "test:123", 2, 0), "FAILED");
  assert.equal(
    (await pool.query("SELECT count(*) FROM vop_product_details")).rows[0]
      .count,
    "20",
  );
  failSecond = false;
  await pool.query("UPDATE vop_detail_jobs SET next_run_at=now()");
  assert.equal(await syncDetails(pool, client, "test:123", 2, 0), "SUCCESS");
  assert.deepEqual(pages, [1, 2, 2]);
  assert.equal(
    (await pool.query("SELECT count(*) FROM vop_product_details")).rows[0]
      .count,
    "21",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT detail FROM vop_product_details WHERE barcode='001'",
      )
    ).rows[0].detail.brandName,
    "品牌",
  );
  assert.equal(await syncDetails(pool, client, "test:123", 2, 0), "IDLE");
  // Same records can be refreshed without duplicates; internal catalog stays unchanged.
  await pool.query("UPDATE vop_detail_jobs SET next_run_at=now()");
  await pool.query("UPDATE vop_detail_tasks SET next_run_at=now()");
  assert.equal(await syncDetails(pool, client, "test:123", 3, 0), "SUCCESS");
  assert.equal(
    (await pool.query("SELECT count(*) FROM vop_product_details")).rows[0]
      .count,
    "21",
  );
  assert.equal(
    (await pool.query("SELECT product_name FROM vop_catalog")).rows[0]
      .product_name,
    "name",
  );
  console.log(
    "PASS details: field parsing, zero vs missing price, vendor isolation, image URLs, pagination, failure checkpoint, retry, dictionary cache, idempotence, hourly idle, catalog isolation",
  );
} finally {
  await pool.end();
  await admin.query("DROP DATABASE " + database + " WITH (FORCE)");
  await admin.end();
}

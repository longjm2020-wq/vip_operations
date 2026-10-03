import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";

// Creates and drops only a generated database on a dedicated loopback test port.
// Run with DATABASE_URL=postgresql://postgres@127.0.0.1:55538/postgres.
const base = new URL(process.env.DATABASE_URL || "");
assert.ok(["127.0.0.1", "localhost"].includes(base.hostname));
assert.equal(base.port, "55538", "Use the isolated inventory test cluster");
const database = "inventory_summary_test_" + Date.now();
const admin = new pg.Client({ connectionString: base.toString() });
await admin.connect();
await admin.query(`CREATE DATABASE ${database}`);
base.pathname = "/" + database;
process.env.DATABASE_URL = base.toString();
let disconnect = async () => {};
let fixtures: pg.Client | undefined;
let passed = 0;
const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
  await fn();
  console.log("PASS", ++passed, name);
};
try {
  await migrate();
  const { db, camel } = await import("../../packages/database/src/index.js");
  disconnect = () => db.$disconnect();
  const { inventorySummary } =
    await import("../../apps/api/src/modules/inventory/summary.js");
  const { balances } =
    await import("../../apps/api/src/modules/inventory/service.js");
  fixtures = new pg.Client({ connectionString: base.toString() });
  await fixtures.connect();
  const sql = async (statement: string, values: unknown[] = []) =>
    (await fixtures!.query(statement, values)).rows;
  const [user] = await sql(
    "INSERT INTO users(username,display_name,password_hash) VALUES('summary-test','库存测试','test-only') RETURNING id",
  );
  const [supplier] = await sql(
    "INSERT INTO suppliers(supplier_code,name) VALUES('SUMMARY','测试供应商') RETURNING id",
  );
  const [category] = await sql(
    "INSERT INTO categories(code,name) VALUES('SUMMARY','测试品类') RETURNING id",
  );
  const warehouses = await sql(
    "INSERT INTO warehouses(code,name) VALUES('ALPHA','测试甲仓'),('BETA','测试乙仓'),('EMPTY','测试空仓') RETURNING id,name",
  );
  const products: string[] = [];
  for (const style of ["SUM-A", "SUM-B", "SUM-C", "SUM-LARGE"]) {
    const [product] = await sql(
      "INSERT INTO products(style_no,name,category_id,default_supplier_id) VALUES($1,$1,$2,$3) RETURNING id",
      [style, category.id, supplier.id],
    );
    products.push(product.id);
  }
  const skus: string[] = [];
  const addSku = async (
    product: number,
    code: string,
    color = "黑色",
    size = "M",
    barcode: string | null = null,
  ) => {
    const id = (9007199254740993n + BigInt(skus.length)).toString();
    await sql(
      "INSERT INTO skus(id,product_id,sku_code,barcode,color_code,color_name,size_code,size_name) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$5,$6,$6)",
      [id, products[product], code, barcode, color, size],
    );
    skus.push(id);
    return id;
  };
  await addSku(
    0,
    "000000012345678901234",
    "黑色",
    "M",
    "0012345678901234567890",
  );
  await addSku(0, "SKU-A-BLACK-L", "黑色", "L", "0012345678901234567890");
  await addSku(0, "SKU-A-WHITE-M", "白色");
  await addSku(1, "SKU-B-BLACK-M");
  await addSku(2, "SKU-C-MISSING");
  await addSku(2, "SKU-C-BLANK");
  for (let i = 0; i < 25; i++) await addSku(2, "SKU-C-PAGE-" + i);
  await addSku(3, "SKU-LARGE");
  const stock = async (
    sku: number,
    warehouse: number,
    physical: number,
    reserved = 0,
    damaged = 0,
  ) =>
    sql(
      "INSERT INTO inventory_balances(sku_id,warehouse_id,physical_qty,reserved_qty,damaged_qty) VALUES($1,$2,$3,$4,$5)",
      [skus[sku], warehouses[warehouse].id, physical, reserved, damaged],
    );
  await stock(0, 0, 10, 2, 1);
  await stock(0, 1, 5, 1);
  await stock(1, 0, 4, 1);
  await stock(2, 0, 2);
  await stock(2, 1, 4);
  await stock(3, 1, 7, 0, 1);
  await stock(4, 0, 3);
  await stock(6, 1, 1);
  await stock(31, 0, 2_000_000_000);
  await stock(31, 1, 2_000_000_000);
  for (const [sku, article] of [
    [0, "ARTICLE-A-01"],
    [1, " ARTICLE-A-01 "],
    [2, "ARTICLE-A-02"],
    [3, "ARTICLE-A-01"],
    [5, ""],
    [31, "ARTICLE-LARGE"],
  ] as const) {
    await sql(
      "INSERT INTO inventory_sku_references(sku_id,article_no,daily_sales,return_rate,estimated_returns,target_days,source_note,reference_date,updated_by) VALUES($1,$2,$3,$4,$5,14,'测试参考','2026-10-02',$6)",
      [
        skus[sku],
        article,
        sku === 0 ? 2.5 : null,
        sku === 0 ? 0.1 : null,
        sku === 0 ? 2 : null,
        user.id,
      ],
    );
  }
  const purchases: { id: string; item: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const [po] = await sql(
      "INSERT INTO purchase_orders(po_no,supplier_id,warehouse_id,buyer_id,status) VALUES($1,$2,$3,$4,'CONFIRMED') RETURNING id",
      ["SUMMARY-PO-" + i, supplier.id, warehouses[i].id, user.id],
    );
    const [item] = await sql(
      "INSERT INTO purchase_order_items(purchase_order_id,sku_id,ordered_qty,unit_cost) VALUES($1,$2,30,10) RETURNING id",
      [po.id, skus[0]],
    );
    purchases.push({ id: po.id, item: item.id });
  }
  const [transfer] = await sql(
    "INSERT INTO inventory_transfers(transfer_no,from_warehouse_id,to_warehouse_id,status,remark,operator_id) VALUES('SUMMARY-TRANSFER',$1,$2,'SHIPPED','测试',$3) RETURNING id",
    [warehouses[1].id, warehouses[0].id, user.id],
  );
  const [transferItem] = await sql(
    "INSERT INTO inventory_transfer_items(transfer_id,sku_id,quantity) VALUES($1,$2,4) RETURNING id",
    [transfer.id, skus[0]],
  );
  let shipmentIndex = 0;
  const shipment = async (
    warehouse: number,
    status: string,
    quantity: number,
    qualified: number | null = null,
    putaway = 0,
    isTransfer = false,
  ) => {
    const po = purchases[warehouse];
    const [sh] = await sql(
      "INSERT INTO inventory_shipments(shipment_no,purchase_order_id,transfer_id,warehouse_id,method,verification_code,status,operator_id) VALUES($1,$2,$3,$4,'DELIVERY','1234',$5,$6) RETURNING id",
      [
        "SUMMARY-SH-" + shipmentIndex++,
        isTransfer ? null : po.id,
        isTransfer ? transfer.id : null,
        warehouses[warehouse].id,
        status,
        user.id,
      ],
    );
    await sql(
      "INSERT INTO inventory_shipment_items(shipment_id,sku_id,purchase_order_item_id,transfer_item_id,quantity,qualified_qty,putaway_qty) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        sh.id,
        skus[0],
        isTransfer ? null : po.item,
        isTransfer ? transferItem.id : null,
        quantity,
        qualified,
        putaway,
      ],
    );
  };
  await shipment(0, "SHIPPED", 3);
  await shipment(0, "DELIVERED", 2);
  await shipment(1, "SHIPPED", 7);
  await shipment(0, "DELIVERED", 4, null, 0, true);
  await shipment(0, "INSPECTED", 9, 5, 2);
  await shipment(1, "INSPECTED", 5, 4, 4);

  const summary = async (q: Record<string, unknown> = {}) =>
    camel(await inventorySummary(q));
  const expected = {
    physicalQty: 4_000_000_036,
    inTransitQty: 12,
    transferTransitQty: 4,
    incomingQty: 3,
    availableQty: 4_000_000_030,
    reservedQty: 4,
    damagedQty: 2,
  };
  for (const [dimension, total] of [
    ["sku", 32],
    ["article", 31],
    ["style", 4],
  ] as const) {
    await check(
      dimension + " groups, full totals, pagination and no double counting",
      async () => {
        const first = await summary({ dimension });
        assert.equal(first.total, total);
        assert.deepEqual(first.totals, expected);
        assert.equal(first.data.length, Math.min(total, 20));
        let totalPhysical = 0;
        for (let page = 1; page <= Math.ceil(total / 20); page++) {
          const result = await summary({ dimension, page });
          assert.deepEqual(result.totals, expected);
          totalPhysical += result.data.reduce(
            (n: number, r: any) => n + r.physicalQty,
            0,
          );
        }
        assert.equal(totalPhysical, expected.physicalQty);
        assert.equal((await summary({ dimension, page: 99 })).data.length, 0);
        assert.deepEqual(
          (await summary({ dimension, page: 99 })).totals,
          expected,
        );
      },
    );
    await check(
      dimension + " warehouse filters and zero stock without balances",
      async () => {
        const alpha = await summary({
          dimension,
          warehouseId: warehouses[0].id,
        });
        assert.deepEqual(alpha.totals, {
          physicalQty: 2_000_000_019,
          inTransitQty: 5,
          transferTransitQty: 4,
          incomingQty: 3,
          availableQty: 2_000_000_015,
          reservedQty: 3,
          damagedQty: 1,
        });
        const empty = await summary({
          dimension,
          warehouseId: warehouses[2].id,
        });
        assert.equal(empty.total, total);
        assert.ok(Object.values(empty.totals).every((n) => n === 0));
      },
    );
  }
  await check(
    "SKU references are not multiplied by warehouses; IDs and codes stay exact",
    async () => {
      const all = await summary({ skuId: skus[0] });
      const row = all.data[0];
      assert.equal(row.skuId, "9007199254740993");
      assert.equal(row.skuCode, "000000012345678901234");
      assert.equal(row.barcode, "0012345678901234567890");
      assert.equal(row.physicalQty, 15);
      assert.equal(row.dailySales, "2.5000");
      assert.equal(row.estimatedReturns, 2);
      assert.equal(row.coverageDays, 4.4);
      assert.equal(row.replenishmentQty, 5);
      const alpha = (
        await summary({ skuId: skus[0], warehouseId: warehouses[0].id })
      ).data[0];
      assert.equal(alpha.coverageDays, 2.8);
      assert.equal(alpha.replenishmentQty, 16);
      assert.equal(alpha.warehouseName, "测试甲仓");
      assert.equal(row.warehouseName, "全部仓库");
    },
  );
  await check("Duplicate barcodes do not merge distinct SKUs", async () => {
    const result = await summary({ q: "0012345678901234567890" });
    assert.equal(result.total, 2);
    assert.equal(result.totals.physicalQty, 19);
  });
  await check(
    "Article groups merge sizes and whitespace but not different styles",
    async () => {
      const result = await summary({ dimension: "article", q: "ARTICLE-A-01" });
      assert.equal(result.total, 2);
      assert.deepEqual(
        result.data.map((r: any) => [r.styleNo, r.articleNo, r.physicalQty]),
        [
          ["SUM-A", "ARTICLE-A-01", 19],
          ["SUM-B", "ARTICLE-A-01", 7],
        ],
      );
      assert.equal(result.data[0].sizeName, null);
      assert.equal(result.data[0].dailySales, null);
      assert.equal(result.data[0].estimatedReturns, null);
    },
  );
  await check(
    "Missing and blank articles remain separate with SKU fallback",
    async () => {
      const result = await summary({
        dimension: "article",
        productId: products[2],
        pageSize: 100,
      });
      assert.equal(result.total, 27);
      assert.equal(new Set(result.data.map((r: any) => r.id)).size, 27);
      assert.ok(
        result.data.every((r: any) => r.skuCode && r.articleNo === null),
      );
    },
  );
  await check(
    "Style merges colors and sizes without exposing a single SKU for editing",
    async () => {
      const result = await summary({
        dimension: "style",
        productId: products[0],
      });
      assert.equal(result.total, 1);
      assert.equal(result.data[0].physicalQty, 25);
      assert.equal(result.data[0].colorName, "多颜色");
      assert.equal(result.data[0].skuId, null);
      assert.equal(result.data[0].articleNo, null);
    },
  );
  await check(
    "Supplier/category filters, exact code search and empty totals",
    async () => {
      assert.deepEqual(
        (await summary({ supplierId: supplier.id, categoryId: category.id }))
          .totals,
        expected,
      );
      assert.equal((await summary({ q: "000000012345678901234" })).total, 1);
      const empty = await summary({ q: "NO-MATCH" });
      assert.equal(empty.total, 0);
      assert.deepEqual(empty.data, []);
      assert.ok(Object.values(empty.totals).every((n) => n === 0));
    },
  );
  await check("Old balance endpoint preserves SKU/warehouse rows", async () => {
    const old = camel(await balances({ skuId: skus[0] }));
    assert.equal(old.total, 3);
    assert.equal(
      old.data.reduce((n: number, r: any) => n + r.physicalQty, 0),
      15,
    );
    assert.equal(old.data[0].skuId, skus[0]);
  });
  await check("Invalid dimension and IDs fail before querying", async () => {
    await assert.rejects(() => inventorySummary({ dimension: "other" }));
    await assert.rejects(() =>
      inventorySummary({ warehouseId: "0; DROP TABLE skus" }),
    );
  });
  console.log(`Inventory summary: ${passed} database scenarios passed`);
  if (process.argv.includes("--serve")) {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, "http://127.0.0.1:5186");
        const q = Object.fromEntries(url.searchParams);
        assert.equal(req.method, "GET", "Review fixture server is read only");
        const result =
          url.pathname === "/api/v1/inventory/summary"
            ? await summary(q)
            : url.pathname === "/api/v1/warehouses"
              ? { data: camel(warehouses), total: warehouses.length }
              : undefined;
        res.writeHead(result ? 200 : 404, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(result || { error: { message: "Not found" } }));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: (error as Error).message } }),
        );
      }
    });
    server.listen(5186, "127.0.0.1");
    console.log("Read-only fixture review ready: http://127.0.0.1:5186");
    await new Promise<void>((resolve) =>
      process.once("SIGINT", () => server.close(() => resolve())),
    );
  }
} finally {
  await fixtures?.end();
  await disconnect();
  await admin.query(`DROP DATABASE ${database}`);
  await admin.end();
}

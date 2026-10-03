import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
import {
  normalizeCompassWorkbook,
  shiftCompassDate,
} from "../../packages/contracts/src/compass-analytics.js";

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
  const reportEnd = "2026-10-02",
    reportStart = shiftCompassDate(reportEnd, -29);
  let importIndex = 0;
  const salesValues = [
    1,
    1,
    1,
    3,
    3,
    3,
    5,
    5,
    5,
    ...Array.from({ length: 21 }, (_, i) => 10 + i),
  ];
  const rateValues = [
    0.1,
    0.1,
    0.1,
    0.3,
    0.3,
    0.3,
    0.5,
    0.5,
    0.5,
    ...Array.from({ length: 21 }, (_, i) => (60 + i) / 100),
  ];
  const referenceReport = async ({
    version = 3,
    status = "COMPLETE",
    start = reportStart,
    omitDate = "",
    missingSaleDate = "",
    duplicate = false,
    zero = false,
  } = {}) => {
    const records: Record<string, unknown>[] = [];
    for (
      let date = start;
      date <= reportEnd;
      date = shiftCompassDate(date, 1)
    ) {
      // Filler ensures that sparse SKU data does not remove a global report date.
      records.push({
        date,
        entityKey: "filler",
        barcode: "UNMATCHED-FILLER",
        metrics: { salesQty: 0 },
        reportedReturnRate: 0,
      });
      if (date === omitDate) continue;
      const index = Math.round(
        (Date.parse(date) - Date.parse(reportStart)) / 86400000,
      );
      const record = {
        date,
        entityKey: "primary",
        barcode: "0012345678901234567890",
        metrics: {
          salesQty:
            date === missingSaleDate
              ? null
              : zero
                ? 0
                : index < 0
                  ? 999
                  : salesValues[index],
        },
        ...(version >= 3
          ? { reportedReturnRate: zero ? 0 : index < 0 ? 9 : rateValues[index] }
          : {}),
      };
      records.push(record);
      if (duplicate && date === reportStart)
        records.push({ ...record, entityKey: "different-platform-product" });
    }
    const [source] = await sql(
      "INSERT INTO compass_imports(dimension,file_name,file_hash,start_date,end_date,expected_rows,status,imported_by,completed_at,normalization_version) VALUES('barcode','条码测试.xlsx',$1,$2,$3,$4,$5,$6,now(),$7) RETURNING id",
      [
        (++importIndex).toString(16).padStart(64, "0"),
        start,
        reportEnd,
        records.length,
        status,
        user.id,
        version,
      ],
    );
    await sql(
      `INSERT INTO compass_records(import_id,business_date,entity_key,style_no,article_no,barcode,payload)
      SELECT $1,(p->>'date')::date,p->>'entityKey','SUM-A','ARTICLE-A-01',p->>'barcode',p FROM jsonb_array_elements($2::jsonb) p`,
      [source.id, JSON.stringify(records)],
    );
    return source.id;
  };
  const activateReport = async (source: string) =>
    sql(
      "INSERT INTO compass_active_imports(dimension,import_id) VALUES('barcode',$1) ON CONFLICT(dimension) DO UPDATE SET import_id=excluded.import_id",
      [source],
    );
  const completeSource = await referenceReport();
  await activateReport(completeSource);
  await check(
    "Barcode report modes, tied percentages and estimated returns use the full 30 days",
    async () => {
      const row = (await summary({ skuId: skus[0] })).data[0];
      assert.equal(row.dailySales, 3);
      assert.equal(row.returnRate, 0.3);
      assert.equal(row.estimatedReturns, 134.1);
      assert.deepEqual(row.channelReference.dailySales, {
        value: 3,
        values: [1, 3, 5],
        frequency: 3,
        samples: 30,
      });
      assert.deepEqual(row.channelReference.returnRate.values, [0.1, 0.3, 0.5]);
      assert.equal(row.channelReference.salesQty, 447);
      assert.equal(row.channelReference.source.id, completeSource);
      assert.equal(row.channelReference.source.startDate, reportStart);
      assert.equal(row.channelReference.source.endDate, reportEnd);
      assert.equal(row.channelReference.barcode, "0012345678901234567890");
      assert.equal(row.coverageDays, 3.7);
      assert.equal(row.replenishmentQty, 12);
      assert.deepEqual(
        (await summary({ dimension: "style" })).totals,
        expected,
      );
      const [manual] = await sql(
        "SELECT daily_sales::text,return_rate::text,estimated_returns FROM inventory_sku_references WHERE sku_id=$1",
        [skus[0]],
      );
      assert.deepEqual(manual, {
        daily_sales: "2.5000",
        return_rate: "0.100000",
        estimated_returns: 2,
      });
    },
  );
  await check(
    "References are unchanged by warehouse filters and duplicate internal barcodes",
    async () => {
      const result = await summary({
        q: "0012345678901234567890",
        warehouseId: warehouses[0].id,
      });
      assert.equal(result.total, 2);
      assert.ok(
        result.data.every(
          (r: any) => r.dailySales === 3 && r.estimatedReturns === 134.1,
        ),
      );
    },
  );
  await check(
    "Staging imports and unrelated style dimensions never change references",
    async () => {
      await referenceReport({ status: "STAGING", zero: true });
      assert.equal((await summary({ skuId: skus[0] })).data[0].dailySales, 3);
      const style = (
        await summary({ dimension: "style", productId: products[0] })
      ).data[0];
      assert.equal(style.dailySales, null);
      assert.equal(style.channelReference, undefined);
    },
  );
  await check(
    "Complete replacement reports replace references and preserve known zeroes",
    async () => {
      await activateReport(await referenceReport({ zero: true }));
      const row = (await summary({ skuId: skus[0] })).data[0];
      assert.equal(row.dailySales, 0);
      assert.equal(row.returnRate, 0);
      assert.equal(row.estimatedReturns, 0);
      assert.equal(row.coverageDays, null);
      assert.equal(row.replenishmentQty, 0);
    },
  );
  await check(
    "Legacy reports retain manual rates until the original percentage is reimported",
    async () => {
      await activateReport(await referenceReport({ version: 2 }));
      const row = (await summary({ skuId: skus[0] })).data[0];
      assert.equal(row.dailySales, 3);
      assert.equal(row.returnRate, "0.100000");
      assert.equal(row.estimatedReturns, 2);
      assert.equal(row.channelReference.needsReturnRateImport, true);
    },
  );
  await check(
    "Missing dates are disclosed and not zero-filled; unknown sales cells prevent estimates",
    async () => {
      for (const config of [
        { omitDate: reportStart },
        { missingSaleDate: reportStart },
      ]) {
        await activateReport(await referenceReport(config));
        const row = (await summary({ skuId: skus[0] })).data[0];
        assert.equal(row.channelReference.dailySales.samples, 29);
        if ("omitDate" in config) {
          assert.equal(row.channelReference.salesQty, 446);
          assert.equal(row.estimatedReturns, 178.4);
          assert.equal(row.channelReference.estimatedReturns.samples, 29);
        } else {
          assert.equal(row.channelReference.estimatedReturns.value, null);
          assert.equal(row.estimatedReturns, 2);
        }
      }
    },
  );
  await check(
    "Same-day platform ambiguity, insufficient windows and unmatched codes remain explicit",
    async () => {
      await activateReport(await referenceReport({ duplicate: true }));
      const ambiguous = (await summary({ skuId: skus[0] })).data[0];
      assert.equal(ambiguous.dailySales, "2.5000");
      assert.equal(ambiguous.channelReference.reason, "AMBIGUOUS_BARCODE");
      await activateReport(
        await referenceReport({ start: shiftCompassDate(reportStart, 1) }),
      );
      assert.equal(
        (await summary({ skuId: skus[0] })).data[0].channelReference.reason,
        "NO_COMPLETE_REPORT",
      );
      await activateReport(completeSource);
      const unmatched = (await summary({ skuId: skus[2] })).data[0];
      assert.equal(unmatched.dailySales, null);
      assert.equal(unmatched.channelReference.reason, "NO_MATCH");
    },
  );
  await check(
    "Reports longer than 30 days only use the final 30-day window",
    async () => {
      await activateReport(
        await referenceReport({ start: shiftCompassDate(reportStart, -30) }),
      );
      const row = (await summary({ skuId: skus[0] })).data[0];
      assert.equal(row.dailySales, 3);
      assert.equal(row.returnRate, 0.3);
      assert.equal(row.estimatedReturns, 134.1);
      assert.equal(row.channelReference.dailySales.samples, 30);
    },
  );
  await check(
    "Unmaintained barcodes use the full internal SKU code as an exact fallback",
    async () => {
      await sql(
        "UPDATE skus SET barcode=NULL,sku_code='0012345678901234567890' WHERE id=$1",
        [skus[0]],
      );
      assert.equal((await summary({ skuId: skus[0] })).data[0].dailySales, 3);
      await sql("UPDATE skus SET barcode='DIFFERENT-BARCODE' WHERE id=$1", [
        skus[0],
      ]);
      assert.equal(
        (await summary({ skuId: skus[0] })).data[0].channelReference.reason,
        "NO_MATCH",
      );
    },
  );
  await check(
    "Matched records are prioritized across pages and filters report full coverage and correct totals",
    async () => {
      await sql(
        "UPDATE skus SET barcode='0012345678901234567890' WHERE id=$1",
        [skus[0]],
      );
      await activateReport(completeSource);
      await sql(
        `INSERT INTO compass_records(import_id,business_date,entity_key,style_no,article_no,barcode,payload)
        VALUES($1,$2,'late-inventory','SUM-LARGE','','SKU-LARGE',$3::jsonb)`,
        [
          completeSource,
          reportEnd,
          JSON.stringify({ metrics: { salesQty: 0 }, reportedReturnRate: 0 }),
        ],
      );
      const all = await summary();
      assert.equal(all.reportCoverage.total, 32);
      assert.equal(all.reportCoverage.matched, 3);
      assert.equal(all.reportCoverage.unmatched, 29);
      assert.equal(all.reportCoverage.source.id, completeSource);
      assert.deepEqual(
        all.data.slice(0, 3).map((r: any) => r.skuId),
        [skus[0], skus[1], skus[31]],
      );
      assert.equal((await summary({ page: 2 })).reportCoverage.matched, 3);
      assert.deepEqual(all.totals, expected);
      const matched = await summary({ reportMatch: "matched" });
      assert.equal(matched.total, 3);
      assert.equal(matched.totals.physicalQty, 4_000_000_019);
      assert.ok(matched.data.every((r: any) => r.compassMatched));
      const unmatched = await summary({ reportMatch: "unmatched" });
      assert.equal(unmatched.total, 29);
      assert.equal(unmatched.totals.physicalQty, 17);
      assert.ok(unmatched.data.every((r: any) => !r.compassMatched));
      const narrowed = await summary({
        productId: products[0],
        warehouseId: warehouses[0].id,
        reportMatch: "matched",
      });
      assert.equal(narrowed.reportCoverage.total, 3);
      assert.equal(narrowed.reportCoverage.matched, 2);
      assert.equal(narrowed.totals.physicalQty, 14);
      const empty = await summary({ skuId: skus[2], reportMatch: "matched" });
      assert.equal(empty.total, 0);
      assert.deepEqual(empty.data, []);
      assert.equal(empty.reportCoverage.source.id, completeSource);
      assert.ok(Object.values(empty.totals).every((v) => v === 0));
      assert.deepEqual(
        (await summary({ dimension: "style", reportMatch: "matched" })).totals,
        expected,
      );
      await assert.rejects(() => summary({ reportMatch: "invalid" }));
    },
  );
  await check(
    "Image matching uses each color's exact article and style without writing catalog data",
    async () => {
      await sql(
        "UPDATE products SET main_image_url='https://example.com/catalog.jpg' WHERE id=ANY($1::bigint[])",
        [products],
      );
      const [source] = await sql(
        "INSERT INTO compass_imports(dimension,file_name,file_hash,start_date,end_date,expected_rows,status,imported_by,completed_at,normalization_version) VALUES('article','货号图片.xlsx',$1,$2,$3,3,'COMPLETE',$4,now(),3) RETURNING id",
        ["a".repeat(64), reportStart, reportEnd, user.id],
      );
      for (const [style, article, image] of [
        ["SUM-A", "ARTICLE-A-01", "https://example.com/black.jpg"],
        ["SUM-A", "ARTICLE-A-02", "https://example.com/white.jpg"],
        ["SUM-B", "ARTICLE-A-01", "https://example.com/other-style.jpg"],
      ]) {
        await sql(
          "INSERT INTO compass_records(import_id,business_date,entity_key,style_no,article_no,barcode,payload) VALUES($1,$2,$3,$4,$5,'',$6::jsonb)",
          [
            source.id,
            reportEnd,
            style + article,
            style,
            article,
            JSON.stringify({ image }),
          ],
        );
      }
      await sql(
        "INSERT INTO compass_active_imports(dimension,import_id) VALUES('article',$1)",
        [source.id],
      );
      const black = (await summary({ skuId: skus[1] })).data[0];
      assert.equal(black.mainImageUrl, "https://example.com/black.jpg");
      assert.equal(black.inventoryImage.articleNo, "ARTICLE-A-01");
      assert.equal(black.inventoryImage.sourceId, source.id);
      assert.equal(
        (await summary({ skuId: skus[2] })).data[0].mainImageUrl,
        "https://example.com/white.jpg",
      );
      assert.equal(
        (await summary({ skuId: skus[3] })).data[0].mainImageUrl,
        "https://example.com/other-style.jpg",
      );
      const grouped = await summary({
        dimension: "article",
        productId: products[0],
      });
      assert.deepEqual(
        grouped.data.map((r: any) => r.mainImageUrl),
        ["https://example.com/black.jpg", "https://example.com/white.jpg"],
      );
      const unknown = (await summary({ skuId: skus[4] })).data[0];
      assert.equal(unknown.mainImageUrl, "https://example.com/catalog.jpg");
      assert.equal(unknown.inventoryImage, undefined);
      const [catalog] = await sql(
        "SELECT main_image_url FROM products WHERE id=$1",
        [products[0]],
      );
      assert.equal(catalog.main_image_url, "https://example.com/catalog.jpg");
      assert.equal(
        (await summary({ dimension: "style", productId: products[0] })).data[0]
          .mainImageUrl,
        "https://example.com/catalog.jpg",
      );
    },
  );
  await check(
    "Only current complete image reports apply; exact barcode fallback and unknown colors stay explicit",
    async () => {
      const [articleSource] = await sql(
        "SELECT import_id FROM compass_active_imports WHERE dimension='article'",
      );
      await sql("UPDATE compass_imports SET status='STAGING' WHERE id=$1", [
        articleSource.import_id,
      ]);
      assert.equal(
        (await summary({ skuId: skus[1] })).data[0].mainImageUrl,
        "https://example.com/catalog.jpg",
      );
      const [barcodeSource] = await sql(
        "SELECT import_id FROM compass_active_imports WHERE dimension='barcode'",
      );
      await sql(
        "UPDATE compass_records SET payload=jsonb_set(payload,'{image}','\"https://example.com/barcode-black.jpg\"') WHERE import_id=$1",
        [barcodeSource.import_id],
      );
      assert.equal(
        (await summary({ skuId: skus[1] })).data[0].mainImageUrl,
        "https://example.com/barcode-black.jpg",
      );
      await sql(
        "INSERT INTO compass_records(import_id,business_date,entity_key,style_no,article_no,barcode,payload) VALUES($1,$2,'white-image','SUM-A','ARTICLE-A-02','SKU-A-WHITE-M',$3::jsonb)",
        [
          barcodeSource.import_id,
          reportEnd,
          JSON.stringify({
            metrics: { salesQty: 0 },
            reportedReturnRate: 0,
            image: "https://example.com/barcode-white.jpg",
          }),
        ],
      );
      assert.equal(
        (await summary({ skuId: skus[2] })).data[0].mainImageUrl,
        "https://example.com/barcode-white.jpg",
      );
      await sql("UPDATE skus SET color_name='白色' WHERE id=$1", [skus[1]]);
      const multi = (
        await summary({ dimension: "article", productId: products[0] })
      ).data.find((r: any) => r.articleNo === "ARTICLE-A-01");
      assert.equal(multi.colorName, "多颜色");
      assert.equal(multi.inventoryImage, undefined);
      await sql("UPDATE skus SET color_name='黑色' WHERE id=$1", [skus[1]]);
      await sql("UPDATE compass_imports SET status='COMPLETE' WHERE id=$1", [
        articleSource.import_id,
      ]);
      await sql(
        "UPDATE compass_records SET payload=jsonb_set(payload,'{image}','\"javascript:invalid\"') WHERE import_id=$1",
        [articleSource.import_id],
      );
      assert.equal(
        (await summary({ skuId: skus[1] })).data[0].mainImageUrl,
        "https://example.com/barcode-black.jpg",
      );
      await sql(
        "UPDATE compass_records SET payload=jsonb_set(payload,'{image}','\"https://example.com/stale.jpg\"') WHERE import_id=$1",
        [articleSource.import_id],
      );
      await sql("DELETE FROM compass_active_imports WHERE dimension='article'");
      assert.equal(
        (await summary({ skuId: skus[1] })).data[0].mainImageUrl,
        "https://example.com/barcode-black.jpg",
      );
    },
  );
  await check(
    "Version 3 original report import persists daily percentages, retries safely, and keeps period ratios unchanged",
    async () => {
      const { beginImport, appendImport, finishImport, dashboard } =
        await import("../../apps/api/src/modules/analytics/service.js");
      const context = () => ({
        actor: {
          id: user.id,
          username: "summary-test",
          displayName: "库存测试",
          permissions: ["analytics.manage"],
        },
        requestId: randomUUID(),
        key: randomUUID(),
      });
      const report = normalizeCompassWorkbook(
        [
          [
            "日期",
            "P_SPU_ID",
            "款号",
            "商品ID",
            "货号",
            "条码",
            "SIZE_ID",
            "销售额",
            "销售量",
            "销售额(不含拒退)",
            "销售量(不含拒退)",
            "退货件数",
            "退货金额",
            "可售库存",
            "退货率(退货件数/销售量)",
          ],
          ...Array.from({ length: 30 }, (_, i) => [
            shiftCompassDate(reportStart, i),
            "900719925474099312345",
            "SUM-A",
            "900719925474099312346",
            "ARTICLE-A-01",
            "0012345678901234567890",
            "900719925474099312347",
            "30",
            "3",
            "20",
            "2",
            "1",
            "10",
            "5",
            "33.3%",
          ]),
        ],
        "original-test.xlsx",
      );
      const input = {
        dimension: report.dimension,
        fileName: "original-test.xlsx",
        fileHash: "f".repeat(64),
        startDate: report.startDate,
        endDate: report.endDate,
        expectedRows: report.records.length,
        normalizationVersion: 3,
      };
      const task = (await beginImport(context(), input))!;
      await appendImport(context(), task.id, { records: report.records });
      await finishImport(context(), task.id);
      const row = (await summary({ skuId: skus[1] })).data[0];
      assert.equal(row.dailySales, 3);
      assert.equal(row.returnRate, 0.333);
      assert.equal(row.estimatedReturns, 29.97);
      assert.equal(row.channelReference.source.id, task.id);
      assert.equal((await beginImport(context(), input))!.id, task.id);
      await appendImport(context(), task.id, { records: report.records });
      await finishImport(context(), task.id);
      assert.equal(
        (
          await sql(
            "SELECT count(*)::int AS n FROM compass_records WHERE import_id=$1",
            [task.id],
          )
        )[0].n,
        30,
      );
      const period = await dashboard({
        dimension: "barcode",
        days: 30,
        q: "0012345678901234567890",
      });
      assert.equal(Number(period.summary.returnRate), 1 / 3);
      const old = (await beginImport(context(), {
        ...input,
        normalizationVersion: 2,
      }))!;
      await appendImport(context(), old.id, { records: report.records });
      await assert.rejects(
        () => finishImport(context(), old.id),
        (error: unknown) =>
          error instanceof HttpException &&
          (error.getResponse() as { error: { code: string } }).error.code ===
            "OLD_NORMALIZATION",
      );
      assert.equal(
        (await summary({ skuId: skus[1] })).data[0].channelReference.source.id,
        task.id,
      );
    },
  );
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

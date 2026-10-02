import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { readWorkbook } from "../../apps/web/src/sheet-excel.js";
import {
  importInventoryRows,
  parseInventoryRows,
} from "../../apps/web/src/inventory-import-data.js";
import { inventoryImportLimits } from "../../packages/contracts/src/inventory-import.js";
import { importInventoryBatch } from "../../apps/api/src/modules/inventory/import-batch.js";
export async function testInventoryImportBatch(
  h: Record<string, any>,
  warehouse: Record<string, any>,
) {
  const { owner, ok, request, db, pass } = h;
  const endpoint = "/inventory/fulfilment/import-batch";
  const batch = (entries: any[]) =>
    ok(owner, endpoint, "POST", { rows: entries });
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet("库存");
  sheet.addRow([
    "图片",
    "款号",
    "货号",
    "商品编码",
    "颜色",
    "尺码",
    "在仓库存数",
    "仓库",
  ]);
  for (let i = 0; i < 6885; i++)
    sheet.addRow([
      "",
      "PERF-STYLE-" + Math.floor(i / 20),
      "ARTICLE-" + i,
      "PERF-SKU-" + i,
      "导入验收颜色",
      "导入验收尺码",
      10,
      warehouse.code,
    ]);
  const file = new File(
    [Buffer.from(await book.xlsx.writeBuffer())],
    "6885.xlsx",
  );
  const start = performance.now();
  const workbook = await readWorkbook(file, {
    ...inventoryImportLimits,
    formattedCells: true,
  });
  const parsed = parseInventoryRows(workbook[0].rows);
  let requests = 0;
  const result = await importInventoryRows(
    parsed.entries,
    async (entries) => {
      requests++;
      return (await batch(entries.map(({ key, input }) => ({ key, input }))))
        .results;
    },
    () => {},
  );
  const seconds = (performance.now() - start) / 1000;
  assert.equal(
    result.filter((e) => e.saved).length,
    6885,
    JSON.stringify(result.find((e) => e.error)),
  );
  assert.equal(requests, 7);
  assert.ok(
    seconds < 15,
    `6885 行读取、校验、新增建档、库存流水和审计耗时 ${seconds.toFixed(2)} 秒，超过目标`,
  );
  const stats = async () =>
    (
      await db.$queryRawUnsafe(
        `SELECT count(*)::int n,sum(b.physical_qty)::int qty,(SELECT count(*)::int FROM inventory_transactions t JOIN skus s ON s.id=t.sku_id WHERE s.sku_code LIKE 'PERF-SKU-%') ledger FROM inventory_balances b JOIN skus s ON s.id=b.sku_id WHERE s.sku_code LIKE 'PERF-SKU-%'`,
      )
    )[0];
  assert.deepEqual(await stats(), { n: 6885, qty: 68850, ledger: 6885 });
  assert.equal(
    (
      await db.$queryRawUnsafe(
        "SELECT count(*)::int n FROM inventory_sku_references r JOIN skus s ON s.id=r.sku_id WHERE s.sku_code LIKE 'PERF-SKU-%' AND r.article_no LIKE 'ARTICLE-%'",
      )
    )[0].n,
    6885,
  );
  // Retry an acknowledged batch with exactly the same row keys.
  const retry = await batch(
    parsed.entries.slice(0, 1000).map(({ key, input }) => ({ key, input })),
  );
  assert.ok(retry.results.every((r: any) => r.saved));
  assert.deepEqual(await stats(), { n: 6885, qty: 68850, ledger: 6885 });
  const first = parsed.entries[0];
  assert.equal(
    (
      await batch([
        {
          key: first.key,
          input: { ...first.input, changes: { physicalQty: 99 } },
        },
      ])
    ).results[0].code,
    "IDEMPOTENCY_CONFLICT",
  );
  const before = (
    await db.$queryRawUnsafe("SELECT * FROM skus WHERE sku_code='PERF-SKU-0'")
  )[0];
  const mixed = await batch([
    {
      key: randomUUID(),
      input: {
        skuCode: "PERF-SKU-0",
        warehouse: "NO-WAREHOUSE",
        changes: { colorName: "不得写入", quantity: 1 },
      },
    },
    {
      key: randomUUID(),
      input: {
        skuCode: "PERF-SKU-1",
        changes: { colorName: "局部更新" },
        creation: { styleNo: "不得替换款号" },
      },
    },
    {
      key: randomUUID(),
      input: { skuCode: "NEW-INCOMPLETE", changes: { colorName: "未知" } },
    },
    {
      key: randomUUID(),
      input: {
        skuCode: "PERF-SKU-2",
        warehouse: warehouse.code,
        changes: { quantity: -11, articleNo: "不得写入" },
      },
    },
    {
      key: randomUUID(),
      input: { skuCode: "PERF-SKU-3", changes: { physicalQty: 0 } },
    },
  ]);
  assert.deepEqual(
    mixed.results.map((r: any) => r.saved),
    [false, true, false, false, false],
  );
  assert.deepEqual(
    mixed.results.filter((r: any) => !r.saved).map((r: any) => r.code),
    [
      "WAREHOUSE_NOT_FOUND",
      "NEW_SKU_FIELDS_REQUIRED",
      "INSUFFICIENT_AVAILABLE",
      "WAREHOUSE_REQUIRED",
    ],
  );
  assert.equal(
    (
      await db.$queryRawUnsafe(
        "SELECT color_name FROM skus WHERE sku_code='PERF-SKU-0'",
      )
    )[0].color_name,
    before.color_name,
  );
  assert.equal(
    (
      await db.$queryRawUnsafe(
        "SELECT r.article_no FROM inventory_sku_references r JOIN skus s ON s.id=r.sku_id WHERE s.sku_code='PERF-SKU-2'",
      )
    )[0].article_no,
    "ARTICLE-2",
  );
  assert.equal(
    (
      await db.$queryRawUnsafe(
        "SELECT count(*)::int n FROM skus WHERE sku_code='NEW-INCOMPLETE'",
      )
    )[0].n,
    0,
  );
  const limited = {
    actor: {
      id: owner.id,
      username: "limited",
      displayName: "受限",
      permissions: ["inventory.read"],
    },
    requestId: randomUUID(),
  };
  const forbidden = await importInventoryBatch(limited, {
    rows: [{ key: first.key, input: first.input }],
  });
  assert.equal(forbidden.results[0].code, "FORBIDDEN");
  assert.equal(
    (
      await request(owner, endpoint, "POST", {
        rows: [
          { key: randomUUID(), input: first.input },
          { key: randomUUID(), input: first.input },
        ],
      })
    ).status,
    400,
  );
  const deltaKey = randomUUID(),
    deltaInput = {
      skuCode: "PERF-SKU-0",
      warehouse: warehouse.code,
      changes: { quantity: 3 },
    };
  const [one, two] = await Promise.all([
    batch([{ key: deltaKey, input: deltaInput }]),
    batch([{ key: deltaKey, input: deltaInput }]),
  ]);
  assert.equal(
    one.results[0].result.adjustmentId,
    two.results[0].result.adjustmentId,
  );
  assert.deepEqual(await stats(), { n: 6885, qty: 68853, ledger: 6886 });
  // New batch endpoint and legacy row endpoint share idempotency records.
  assert.equal(
    (
      await ok(
        owner,
        "/inventory/fulfilment/import-row",
        "POST",
        deltaInput,
        deltaKey,
      )
    ).adjustmentId,
    one.results[0].result.adjustmentId,
  );
  assert.deepEqual(await stats(), { n: 6885, qty: 68853, ledger: 6886 });
  await ok(
    owner,
    "/inventory/fulfilment/references/" + String(before.id),
    "POST",
    {
      articleNo: "PRECISION",
      dailySales: 1.2345,
      returnRate: 0.015001,
      estimatedReturns: 2,
      targetDays: 14,
      sourceNote: "精确参考验收",
      referenceDate: "2026-10-02",
    },
  );
  await batch([
    {
      key: randomUUID(),
      input: { skuCode: "PERF-SKU-0", changes: { articleNo: "PARTIAL" } },
    },
  ]);
  const precise = (
    await db.$queryRawUnsafe(
      "SELECT daily_sales::text daily,return_rate::text rate,source_note source FROM inventory_sku_references WHERE sku_id=$1::bigint",
      String(before.id),
    )
  )[0];
  assert.deepEqual(precise, {
    daily: "1.2345",
    rate: "0.015001",
    source: "精确参考验收",
  });
  await db.$executeRawUnsafe(
    "UPDATE categories SET status='INACTIVE' WHERE code='INVENTORY_IMPORT_PENDING'",
  );
  const disabledCategory = await batch([
    {
      key: randomUUID(),
      input: {
        skuCode: "CATEGORY-REJECT",
        creation: { styleNo: "CATEGORY-NEW" },
        changes: { colorName: "白色", sizeName: "L" },
      },
    },
  ]);
  assert.equal(disabledCategory.results[0].code, "INVALID_CATEGORY");
  assert.equal(
    (
      await db.$queryRawUnsafe(
        "SELECT count(*)::int n FROM products WHERE style_no='CATEGORY-NEW'",
      )
    )[0].n,
    0,
  );
  await db.$executeRawUnsafe(
    "UPDATE categories SET status='ACTIVE' WHERE code='INVENTORY_IMPORT_PENDING'",
  );
  pass(
    `库存批量导入：6885 行真实新增含文件读取 ${seconds.toFixed(2)} 秒，7 次请求；库存/流水/参考值齐全、部分失败隔离、权限及并发重试不重复`,
  );
}

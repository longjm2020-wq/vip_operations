import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { Row, Tx } from "../../packages/database/src/index.js";
import type { Context } from "../../apps/api/src/core.js";
import { shiftCompassDate } from "../../packages/contracts/src/compass-analytics.js";

const fixture = vi.hoisted(() => ({ database: null as PGlite | null,
  transactions: [] as Record<string, unknown>[], queries: [] as string[] }));
vi.mock("../../packages/database/src/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../packages/database/src/index.js")>();
  const wrap = (database: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (query: string, ...values: unknown[]) => {
      fixture.queries.push(query);
      return (await database.query<Row>(query, values)).rows;
    },
    $executeRawUnsafe: async (query: string, ...values: unknown[]) => {
      fixture.queries.push(query);
      return (await database.query(query, values)).affectedRows || 0;
    },
  }) as unknown as Tx;
  const transaction = async (work: (tx: Tx) => Promise<unknown>, options: Record<string, unknown> = {}) => {
    fixture.transactions.push(options);
    return fixture.database!.transaction(async tx => work(wrap(tx)));
  };
  return { ...original, db: { $transaction: transaction } };
});

import { inventorySummary } from "../../apps/api/src/modules/inventory/summary.js";
import { beginImport, finishImport } from "../../apps/api/src/modules/analytics/service.js";
import { camel } from "../../packages/database/src/index.js";

const query = async (text: string, values: unknown[] = []) =>
  (await fixture.database!.query<Row>(text, values)).rows;
const context = (): Context => ({ actor: { id: "1", username: "test", displayName: "Test", permissions: ["analytics.manage"] }, key: randomUUID(), requestId: randomUUID() });
let serial = 0;
async function report(start: string, end: string, options: {
  sales?: number | null; rate?: number | null; omitBarcode?: boolean;
  duplicate?: boolean; version?: number; hash?: string; dimension?: string;
  missingDay?: string;
} = {}) {
  const records: Row[] = [];
  for (let day = start; day <= end; day = shiftCompassDate(day, 1)) {
    if (day === options.missingDay) continue;
    records.push({ date: day, key: "filler", barcode: "FILLER", payload: { metrics: { salesQty: 0 }, reportedReturnRate: 0 } });
    if (!options.omitBarcode) {
      const payload = { metrics: { salesQty: options.sales === undefined ? 3 : options.sales },
        ...(options.version !== undefined && options.version < 3 ? {} : { reportedReturnRate: options.rate === undefined ? 0.25 : options.rate }),
        image: "https://example.com/current.jpg", irrelevantLargeMetric: 99,
      };
      records.push({ date: day, key: "platform-a", barcode: "001234", payload });
      if (options.duplicate) records.push({ date: day, key: "platform-b", barcode: "001234", payload });
    }
  }
  const [source] = await query(`INSERT INTO compass_imports(dimension,file_name,file_hash,start_date,end_date,expected_rows,status,imported_by,normalization_version)
    VALUES($1,$2,$3,$4,$5,$6,'STAGING',1,$7) RETURNING id`, [options.dimension || "barcode", `report-${++serial}.xlsx`, options.hash || serial.toString(16).padStart(64, "0"), start, end, records.length, options.version || 3]);
  for (const record of records) await query(`INSERT INTO compass_records(import_id,business_date,entity_key,style_no,article_no,barcode,payload)
    VALUES($1,$2,$3,'STYLE','ARTICLE',$4,$5)`, [source.id, record.date, record.key, record.barcode, JSON.stringify(record.payload)]);
  return String(source.id);
}
const finish = async (id: string) => finishImport(context(), id);
const summary = async (extra: Row = {}) => camel(await inventorySummary({ skuId: "1", ...extra }));
const day = "2026-10-15";

beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(`
    CREATE TABLE compass_imports(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,dimension text,file_name text,file_hash text,start_date date,end_date date,
      expected_rows int,status text DEFAULT 'STAGING',imported_by bigint,normalization_version int,completed_at timestamptz,created_at timestamptz DEFAULT now());
    CREATE TABLE compass_records(import_id bigint REFERENCES compass_imports(id) ON DELETE CASCADE,business_date date,entity_key text,style_no text,article_no text,barcode text,payload jsonb,PRIMARY KEY(import_id,business_date,entity_key));
    CREATE TABLE compass_active_imports(dimension text PRIMARY KEY,import_id bigint UNIQUE REFERENCES compass_imports(id));
    CREATE TABLE idempotency_records(id bigserial,actor_id bigint,operation text,idempotency_key text,request_hash text,response_status int,response_body jsonb);
    CREATE TABLE audit_logs(id bigserial,actor_id bigint,actor_label text,action text,entity_type text,entity_id bigint,request_id text,before_data jsonb,after_data jsonb,reason text);
    CREATE TABLE products(id bigint PRIMARY KEY,style_no text,name text,main_image_url text,custom_fields jsonb,default_supplier_id bigint,category_id bigint);
    INSERT INTO products VALUES(1,'STYLE','Product','https://example.com/catalog.jpg','{}',NULL,NULL);
    CREATE TABLE skus(id bigint PRIMARY KEY,product_id bigint,sku_code text,barcode text,color_name text,size_name text);
    INSERT INTO skus VALUES(1,1,'SKU','001234','black','M'),(2,1,'OTHER','UNMATCHED','black','L');
    CREATE TABLE warehouses(id bigint PRIMARY KEY,name text); INSERT INTO warehouses VALUES(1,'one'),(2,'two');
    CREATE TABLE inventory_balances(sku_id bigint,warehouse_id bigint,physical_qty int,reserved_qty int,damaged_qty int);
    INSERT INTO inventory_balances VALUES(1,1,10,1,0),(1,2,5,0,0);
    CREATE TABLE inventory_sku_references(sku_id bigint,article_no text,daily_sales numeric,return_rate numeric,estimated_returns numeric,target_days int,source_note text,reference_date date);
    INSERT INTO inventory_sku_references VALUES(1,'ARTICLE',8,0.1,2,14,'manual','2026-01-01');
    CREATE TABLE inventory_shipments(id bigint,warehouse_id bigint,purchase_order_id bigint,transfer_id bigint,status text);
    CREATE TABLE inventory_shipment_items(shipment_id bigint,sku_id bigint,quantity int,qualified_qty int,putaway_qty int);
  `);
  // Seed retained complete files before migration to test backfill independently
  // of the new finish hook. Distinct report days are verified before archiving.
  const old = await report("2026-01-01", "2026-01-02", { sales: 1 });
  await query("UPDATE compass_imports SET status='COMPLETE',completed_at='2026-01-03' WHERE id=$1", [old]);
  const correctedHash = "a".repeat(64);
  const corrected = await report("2026-01-02", "2026-01-03", { sales: 7, hash: correctedHash });
  await query("UPDATE compass_imports SET status='COMPLETE',completed_at='2026-01-04' WHERE id=$1", [corrected]);
  // Old deployments compared normalization only with the current active file;
  // the same older parser could finish later after a different file was active.
  const downgraded = await report("2026-01-02", "2026-01-03", { sales: 99, hash: correctedHash, version: 1 });
  await query("UPDATE compass_imports SET status='COMPLETE',completed_at='2026-01-05' WHERE id=$1", [downgraded]);
  await report("2026-01-01", "2026-01-03", { sales: 99 });
  await fixture.database.exec(await readFile(new URL("../../packages/database/migrations/066_compass_barcode_history.sql", import.meta.url), "utf8"));
  const recovered = await query("SELECT business_date::text,payload->'metrics'->>'salesQty' AS sales FROM compass_barcode_history_records WHERE barcode='001234' ORDER BY business_date");
  expect(recovered).toEqual([
    { business_date: "2026-01-01", sales: "1" }, { business_date: "2026-01-02", sales: "7" }, { business_date: "2026-01-03", sales: "7" },
  ]);
}, 30000);
beforeEach(async () => {
  await fixture.database!.exec("TRUNCATE compass_active_imports,compass_records,compass_imports,compass_barcode_history_records,compass_barcode_history_days,compass_barcode_history_files,idempotency_records,audit_logs RESTART IDENTITY");
  fixture.transactions = []; fixture.queries = [];
});
afterAll(async () => fixture.database?.close());

describe("complete barcode daily history and inventory median windows", () => {
  it("publishes complete imports only and calculates all fields from one read-only snapshot", async () => {
    const id = await report(shiftCompassDate(day, -29), day);
    expect((await summary()).reportCoverage.window.complete).toBe(false);
    await finish(id);
    const result = await summary(), row = result.data[0];
    expect(row.dailySales).toBe(3); expect(row.returnRate).toBe(0.25); expect(row.estimatedReturns).toBe(22.5);
    expect(row.channelReference.dailySales).toEqual({ value: 3, values: [3, 3], samples: 30, method: "median" });
    expect(row.channelReference.window).toEqual(result.reportCoverage.window);
    expect(result.reportCoverage.window).toMatchObject({ period: "30d", days: 30, coveredDays: 30, complete: true, method: "median" });
    expect(fixture.transactions.at(-1)).toMatchObject({ isolationLevel: "RepeatableRead" });
    expect(fixture.queries).toContain("SET TRANSACTION READ ONLY");
    expect((await query("SELECT payload FROM compass_barcode_history_records WHERE barcode='001234' LIMIT 1"))[0].payload)
      .toEqual({ metrics: { salesQty: 3 }, reportedReturnRate: 0.25 });
  });

  it("reports incomplete long periods and retains manual fallback without changing stock totals or images", async () => {
    await finish(await report(shiftCompassDate(day, -29), day));
    const short = await summary({ referencePeriod: "3d" }), long = await summary({ referencePeriod: "6m" });
    expect(short.data[0].estimatedReturns).toBe(2.25);
    expect(long.reportCoverage.window).toMatchObject({ days: 183, coveredDays: 30, complete: false });
    expect(long.data[0]).toMatchObject({ dailySales: "8", returnRate: "0.1", estimatedReturns: "2" });
    expect(long.data[0].channelReference).toMatchObject({ reason: "INCOMPLETE_PERIOD", dailySales: { value: null }, returnRate: { value: null }, estimatedReturns: { value: null } });
    expect(long.totals).toEqual(short.totals);
    expect(long.data[0].mainImageUrl).toBe(short.data[0].mainImageUrl);
    expect(long.data[0].inventoryImage.sourceId).toBe(short.data[0].inventoryImage.sourceId);
  });

  it("accumulates segmented historical imports for one calendar year without rolling back active analytics", async () => {
    const current = await report("2026-09-16", day);
    await finish(current);
    for (const [start, end] of [["2025-10-16", "2026-01-13"], ["2026-01-14", "2026-04-13"], ["2026-04-14", "2026-07-12"], ["2026-07-13", "2026-09-15"]])
      await finish(await report(start, end, { sales: 1, rate: 0.5 }));
    const result = await summary({ referencePeriod: "1y" });
    expect(result.reportCoverage.window).toMatchObject({ startDate: "2025-10-16", endDate: day, days: 365, coveredDays: 365, complete: true });
    expect(result.data[0].dailySales).toBe(1); expect(result.data[0].estimatedReturns).toBe(212.5);
    expect(String((await query("SELECT import_id FROM compass_active_imports WHERE dimension='barcode'"))[0].import_id)).toBe(current);
    expect(String(result.reportCoverage.source.id)).toBe(current);
  }, 20000);

  it("replaces entire corrected days, removes disappeared barcodes and clears previously nonempty cells", async () => {
    await finish(await report(shiftCompassDate(day, -2), day));
    const correction = await report(day, day, { sales: null, rate: null });
    await finish(correction);
    let row = (await summary({ referencePeriod: "3d" })).data[0];
    expect(row.channelReference.dailySales.samples).toBe(2);
    expect(row.channelReference.estimatedReturns.value).toBeNull();
    expect(row.estimatedReturns).toBe("2");
    await finish(await report(day, day, { omitBarcode: true }));
    row = (await summary({ referencePeriod: "3d" })).data[0];
    expect(row.channelReference.dailySales.samples).toBe(2);
    expect(row.channelReference.estimatedReturns.value).toBe(1.5);
    expect(await query("SELECT * FROM compass_barcode_history_records WHERE business_date=$1 AND barcode='001234'", [day])).toEqual([]);
    // An idempotent retry of the superseded correction cannot revive its rows.
    await finish(correction);
    expect(await query("SELECT * FROM compass_barcode_history_records WHERE business_date=$1 AND barcode='001234'", [day])).toEqual([]);
  });

  it("applies short corrections ending on the current day without narrowing the active 30-day panel", async () => {
    const original = await report(shiftCompassDate(day, -29), day); await finish(original);
    await finish(await report(day, day, { sales: 9, rate: 1 }));
    await finish(await report(shiftCompassDate(day, -2), day, { sales: 5, rate: 0.5 }));
    const result = await summary();
    expect(String(result.reportCoverage.source.id)).toBe(original);
    expect(result.reportCoverage.source.startDate).toBe(shiftCompassDate(day, -29));
    expect(result.reportCoverage.window).toMatchObject({ days: 30, coveredDays: 30, complete: true });
    expect(result.data[0].dailySales).toBe(3);
    expect(result.data[0].estimatedReturns).toBe(24);
    expect(String((await query("SELECT import_id FROM compass_active_imports WHERE dimension='barcode'"))[0].import_id)).toBe(original);
  });

  it("keeps same-day platform ambiguity, explicit zeroes, and absent rates distinct", async () => {
    await finish(await report(shiftCompassDate(day, -2), day, { duplicate: true }));
    expect((await summary({ referencePeriod: "3d" })).data[0].channelReference.reason).toBe("AMBIGUOUS_BARCODE");
    await finish(await report(shiftCompassDate(day, -2), day, { sales: 0, rate: 0 }));
    expect((await summary({ referencePeriod: "3d" })).data[0]).toMatchObject({ dailySales: 0, returnRate: 0, estimatedReturns: 0 });
    await finish(await report(shiftCompassDate(day, -2), day, { version: 2 }));
    const row = (await summary({ referencePeriod: "3d" })).data[0];
    expect(row.dailySales).toBe(3); expect(row.channelReference.returnRate.value).toBeNull();
    expect(row.channelReference.needsReturnRateImport).toBe(true);
  });

  it("does not publish failed incomplete imports or mix new rows into an old complete snapshot", async () => {
    await finish(await report(shiftCompassDate(day, -2), day));
    const id = await report(shiftCompassDate(day, -2), day, { sales: 100, missingDay: shiftCompassDate(day, -1) });
    await expect(finish(id)).rejects.toThrow();
    const result = await summary({ referencePeriod: "3d" });
    expect(result.data[0].dailySales).toBe(3);
    expect(result.reportCoverage.window.coveredDays).toBe(3);
  });

  it("keeps copied history after 45-day raw import cleanup and prevents historical normalization downgrade", async () => {
    const hash = "a".repeat(64);
    const old = await report("2026-06-01", "2026-06-03", { hash }); await finish(old);
    await query("UPDATE compass_imports SET created_at=now()-interval '46 days' WHERE id=$1", [old]);
    await finish(await report("2026-10-13", day));
    expect(await query("SELECT * FROM compass_imports WHERE id=$1", [old])).toEqual([]);
    expect((await query("SELECT count(*)::int AS n FROM compass_barcode_history_records WHERE barcode='001234' AND business_date<'2026-10-01'"))[0].n).toBe(3);
    // Another file can win every historical day; the old file's parser version
    // still has to remain protected after its raw import and daily pointers go.
    await finish(await report("2026-06-01", "2026-06-03", { sales: 5 }));
    const downgrade = await report("2026-06-01", "2026-06-03", { hash, version: 1 });
    await expect(finish(downgrade)).rejects.toMatchObject({ response: { error: { code: "OLD_NORMALIZATION" } } });
    expect((await query("SELECT normalization_version FROM compass_barcode_history_days WHERE business_date='2026-06-01'"))[0].normalization_version).toBe(3);
  });

  it("retains old-report rejection for non-barcode analytics and validates period inputs", async () => {
    await finish(await report("2026-10-13", day, { dimension: "style" }));
    await expect(finish(await report("2026-09-01", "2026-09-03", { dimension: "style" }))).rejects.toMatchObject({ response: { error: { code: "OLD_REPORT" } } });
    await expect(summary({ referencePeriod: "365d" })).rejects.toThrow();
  });

  it("keeps the original 90-day per-file gate while allowing historical barcode segments", async () => {
    const input = { dimension: "barcode", fileName: "history.xlsx", fileHash: "b".repeat(64),
      startDate: "2025-10-16", endDate: "2026-01-13", expectedRows: 1, normalizationVersion: 3 };
    const accepted = await beginImport(context(), input);
    expect(accepted).toMatchObject({ status: "STAGING", dimension: "barcode" });
    await expect(beginImport(context(), { ...input, endDate: "2026-01-14" }))
      .rejects.toMatchObject({ response: { error: { code: "INVALID_PERIOD" } } });
    expect(await query("SELECT * FROM compass_barcode_history_days")).toEqual([]);
  });
});

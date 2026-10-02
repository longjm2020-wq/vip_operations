import { z } from "zod";
import {
  audit,
  command,
  Context,
  fail,
  id,
  parse,
  requirePermission,
} from "../../core.js";
import {
  db,
  json,
  one,
  rows,
  Tx,
} from "../../../../../packages/database/src/index.js";
import {
  compassDimensions,
  compassMetrics,
  compassSortFields,
  compassRatios,
  compassRecordSchema,
  shiftCompassDate,
  shanghaiDate,
} from "../../../../../packages/contracts/src/compass-analytics.js";

const dimensionSchema = z.enum(compassDimensions);
export const beginSchema = z
  .object({
    dimension: dimensionSchema,
    fileName: z.string().trim().min(1).max(255),
    fileHash: z.string().regex(/^[a-f0-9]{64}$/),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    expectedRows: z.number().int().min(1).max(200000),
  })
  .strict();
export async function beginImport(c: Context, input: unknown) {
  requirePermission(c.actor, "analytics.manage");
  const b = parse(beginSchema, input);
  if (
    b.endDate > shiftCompassDate(shanghaiDate(), -1) ||
    b.startDate > b.endDate ||
    shiftCompassDate(b.startDate, 89) < b.endDate
  )
    fail("INVALID_PERIOD", "统计区间应在昨日以前，且不超过 90 天", 400);
  return command(c, "compass.begin", b, async (tx) => {
    await rows(
      tx,
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
      "compass:" + b.dimension + b.fileHash,
    );
    const old = await one(
      tx,
      "SELECT *, (SELECT count(*)::int FROM compass_records WHERE import_id=i.id) AS received_rows FROM compass_imports i WHERE dimension=$1 AND file_hash=$2",
      b.dimension,
      b.fileHash,
    );
    if (old) {
      if (
        old.expected_rows !== b.expectedRows ||
        old.start_date.toISOString().slice(0, 10) !== b.startDate ||
        old.end_date.toISOString().slice(0, 10) !== b.endDate
      )
        fail("IMPORT_CONFLICT", "同一文件的导入信息不一致", 400);
      return old;
    }
    return one(
      tx,
      "INSERT INTO compass_imports(dimension,file_name,file_hash,start_date,end_date,expected_rows,imported_by) VALUES($1,$2,$3,$4::date,$5::date,$6,$7::bigint) RETURNING *,0 AS received_rows",
      b.dimension,
      b.fileName,
      b.fileHash,
      b.startDate,
      b.endDate,
      b.expectedRows,
      c.actor.id,
    );
  });
}
export const chunkSchema = z
  .object({ records: z.array(compassRecordSchema).min(1).max(1000) })
  .strict();
export async function appendImport(c: Context, value: string, input: unknown) {
  requirePermission(c.actor, "analytics.manage");
  const importId = parse(id, value),
    b = parse(chunkSchema, input);
  return command(c, "compass.chunk:" + importId, b, async (tx) => {
    const task = await one(
      tx,
      "SELECT * FROM compass_imports WHERE id=$1::bigint FOR UPDATE",
      importId,
    );
    if (!task) fail("NOT_FOUND", "导入任务不存在", 404);
    if (task.status !== "STAGING")
      return { receivedRows: task.expected_rows, complete: true };
    const start = task.start_date.toISOString().slice(0, 10),
      end = task.end_date.toISOString().slice(0, 10);
    const keys = new Set<string>();
    for (const row of b.records) {
      const expectedKey = JSON.stringify(
        task.dimension === "style"
          ? [row.spuId, row.styleNo]
          : task.dimension === "article"
            ? [row.productId, row.articleNo]
            : [row.productId, row.sizeId, row.barcode],
      );
      if (
        row.date < start ||
        row.date > end ||
        expectedKey !== row.entityKey ||
        !row.spuId ||
        !(task.dimension === "style"
          ? row.styleNo
          : task.dimension === "article"
            ? row.articleNo && row.productId
            : row.barcode && row.sizeId && row.productId)
      )
        fail("INVALID_RECORD", "数据行的日期、维度或平台 ID 不正确", 400);
      const key = row.date + row.entityKey;
      if (keys.has(key)) fail("DUPLICATE_ROW", "数据批次存在重复平台记录", 400);
      keys.add(key);
    }
    const encoded = JSON.stringify(b.records);
    const conflict = await one(
      tx,
      `SELECT 1 FROM jsonb_array_elements($2::jsonb) p JOIN compass_records r ON r.import_id=$1::bigint AND r.business_date=(p->>'date')::date AND r.entity_key=p->>'entityKey' WHERE r.payload<>p LIMIT 1`,
      importId,
      encoded,
    );
    if (conflict)
      fail("IMPORT_CONFLICT", "已上传行内容不一致，请重新选择原始文件", 400);
    await tx.$executeRawUnsafe(
      `INSERT INTO compass_records(import_id,business_date,entity_key,style_no,article_no,barcode,payload)
      SELECT $1::bigint,(p->>'date')::date,p->>'entityKey',p->>'styleNo',p->>'articleNo',p->>'barcode',p FROM jsonb_array_elements($2::jsonb) p ON CONFLICT DO NOTHING`,
      importId,
      encoded,
    );
    const count = await one(
      tx,
      "SELECT count(*)::int AS received_rows FROM compass_records WHERE import_id=$1::bigint",
      importId,
    );
    if (count!.received_rows > task.expected_rows)
      fail("ROW_LIMIT", "上传行数超过申报行数", 400);
    return count;
  });
}
export async function finishImport(c: Context, value: string) {
  requirePermission(c.actor, "analytics.manage");
  const importId = parse(id, value);
  return command(c, "compass.finish:" + importId, {}, async (tx) => {
    const task = await one(
      tx,
      "SELECT * FROM compass_imports WHERE id=$1::bigint FOR UPDATE",
      importId,
    );
    if (!task) fail("NOT_FOUND", "导入任务不存在", 404);
    if (task.status === "COMPLETE") return task;
    const stats = await one(
      tx,
      "SELECT count(*)::int AS n,count(DISTINCT business_date)::int AS days,min(business_date) AS start,max(business_date) AS end FROM compass_records WHERE import_id=$1::bigint",
      importId,
    );
    const span =
      Math.round(
        (task.end_date.getTime() - task.start_date.getTime()) / 86400000,
      ) + 1;
    if (
      stats!.n !== task.expected_rows ||
      stats!.days !== span ||
      stats!.start?.getTime() !== task.start_date.getTime() ||
      stats!.end?.getTime() !== task.end_date.getTime()
    )
      fail(
        "INCOMPLETE_IMPORT",
        "上传尚未完成或统计日期不完整，请重试原始文件",
        400,
      );
    await rows(
      tx,
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
      "compass-active:" + task.dimension,
    );
    const active = await one(
      tx,
      "SELECT i.* FROM compass_active_imports a JOIN compass_imports i ON i.id=a.import_id WHERE a.dimension=$1",
      task.dimension,
    );
    if (active && active.end_date > task.end_date)
      fail("OLD_REPORT", "已有更新日期的报表，不能用旧报表覆盖", 400);
    const result = await one(
      tx,
      "UPDATE compass_imports SET status='COMPLETE',completed_at=now() WHERE id=$1::bigint RETURNING *",
      importId,
    );
    await tx.$executeRawUnsafe(
      "INSERT INTO compass_active_imports(dimension,import_id) VALUES($1,$2::bigint) ON CONFLICT(dimension) DO UPDATE SET import_id=excluded.import_id",
      task.dimension,
      importId,
    );
    await audit(tx, c, "COMPASS_IMPORT", "compass_import", importId, null, {
      dimension: task.dimension,
      fileName: task.file_name,
      rows: stats!.n,
      start: task.start_date,
      end: task.end_date,
    });
    // Active snapshots are immutable; retain recent imports without letting daily files grow indefinitely.
    await tx.$executeRawUnsafe(
      "DELETE FROM compass_imports WHERE created_at<now()-interval '45 days' AND id NOT IN(SELECT import_id FROM compass_active_imports)",
    );
    return result;
  });
}
export async function compassSources(tx: Tx = db) {
  return rows(
    tx,
    "SELECT i.id,i.dimension,i.file_name,i.start_date::text,i.end_date::text,i.expected_rows,i.completed_at FROM compass_active_imports a JOIN compass_imports i ON i.id=a.import_id ORDER BY i.dimension",
  );
}
const querySchema = z.object({
  dimension: dimensionSchema.default("style"),
  days: z.coerce
    .number()
    .pipe(
      z.union([
        z.literal(1),
        z.literal(3),
        z.literal(7),
        z.literal(15),
        z.literal(30),
      ]),
    )
    .default(7),
  endDate: z.iso.date().optional(),
  startDate: z.iso.date().optional(),
  q: z.string().trim().max(150).default(""),
  styleNo: z.string().max(150).default(""),
  articleNo: z.string().max(150).default(""),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(20),
  sort: z.enum(compassSortFields).default("salesAmount"),
});
const ratioSortInputs: Record<string, [string, string]> = {
  returnRate: ["returnsQty", "salesQty"],
  rejectionRate: ["rejectedQty", "salesQty"],
  conversionRate: ["customers", "detailViews"],
  clickRate: ["detailViews", "exposure"],
  averagePrice: ["salesAmount", "salesQty"],
};
const metricSQL = (prefix: string) =>
  Object.keys(compassMetrics)
    .filter((k) => !k.endsWith("Stock"))
    .map(
      (k) => `sum((${prefix}payload->'metrics'->>'${k}')::numeric) AS "${k}"`,
    )
    .join(",");
export async function dashboard(
  input: unknown,
  tx: Tx = db,
  topLimit: 10 | 20 = 20,
) {
  const b = parse(querySchema, input),
    sources = await compassSources(tx),
    source = sources.find((s) => s.dimension === b.dimension);
  if (!source)
    return {
      sources,
      dimension: b.dimension,
      empty: true,
      items: [],
      daily: [],
      top: [],
      total: 0,
    };
  const endDate = b.endDate || source.end_date,
    startDate = b.startDate || shiftCompassDate(endDate, 1 - b.days),
    periodDays =
      Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 1;
  if (periodDays < 1 || periodDays > 366)
    fail("INVALID_PERIOD", "统计日期须按先后顺序选择，且最多支持 366 天", 400);
  if (endDate > shiftCompassDate(shanghaiDate(), -1))
    fail("INVALID_PERIOD", "截止日期不能晚于昨日", 400);
  const column = {
    style: "style_no",
    article: "article_no",
    barcode: "barcode",
  }[b.dimension];
  const params = [source.id, startDate, endDate, b.q, b.styleNo, b.articleNo];
  const where = `import_id=$1::bigint AND business_date BETWEEN $2::date AND $3::date AND ($4='' OR position(lower($4) in lower(style_no||' '||article_no||' '||barcode||' '||coalesce(payload->>'category','')||' '||coalesce(payload->>'size','')))>0) AND ($5='' OR style_no=$5) AND ($6='' OR article_no=$6)`;
  const cte = `WITH filtered AS (SELECT * FROM compass_records WHERE ${where}), grouped AS (SELECT ${column} AS code,
    min(style_no) AS style_no,min(article_no) AS article_no,min(barcode) AS barcode,
    (array_agg(payload->>'image' ORDER BY business_date DESC) FILTER(WHERE payload->>'image'<>''))[1] AS image,
    string_agg(DISTINCT nullif(payload->>'size',''),'、') AS sizes, ${metricSQL("")},
    sum((payload->'metrics'->>'onSaleStock')::numeric) FILTER(WHERE business_date=$3::date) AS "onSaleStock",
    sum((payload->'metrics'->>'saleableStock')::numeric) FILTER(WHERE business_date=$3::date) AS "saleableStock",
    max(business_date)::text AS last_date FROM filtered GROUP BY ${column})`;
  const summary = await one(
    tx,
    `SELECT ${metricSQL("")},sum((payload->'metrics'->>'onSaleStock')::numeric) FILTER(WHERE business_date=$3::date) AS "onSaleStock",sum((payload->'metrics'->>'saleableStock')::numeric) FILTER(WHERE business_date=$3::date) AS "saleableStock",count(DISTINCT ${column})::int AS entities,count(DISTINCT business_date)::int AS covered_days FROM compass_records WHERE ${where}`,
    ...params,
  );
  const daily = await rows(
    tx,
    `SELECT business_date::text AS date,${metricSQL("")} FROM compass_records WHERE ${where} GROUP BY business_date ORDER BY business_date`,
    ...params,
  );
  const total = await one(
    tx,
    `${cte} SELECT count(*)::int AS n FROM grouped`,
    ...params,
  );
  const items = await rows(
    tx,
    `${cte} SELECT * FROM grouped ORDER BY ${
      ratioSortInputs[b.sort]
        ? `CASE WHEN "${ratioSortInputs[b.sort][1]}">0 THEN "${ratioSortInputs[b.sort][0]}"/"${ratioSortInputs[b.sort][1]}" END`
        : `"${b.sort}"`
    } DESC NULLS LAST,code OFFSET $7 LIMIT $8`,
    ...params,
    (b.page - 1) * b.pageSize,
    b.pageSize,
  );
  const top = await rows(
    tx,
    `${cte} SELECT * FROM grouped ORDER BY "salesAmount" DESC NULLS LAST,code LIMIT $7`,
    ...params,
    topLimit,
  );
  const format = (row: any) => ({ ...json(row), ...compassRatios(row) });
  const complete = startDate >= source.start_date && endDate <= source.end_date;
  return {
    sources,
    dimension: b.dimension,
    empty: false,
    startDate,
    endDate,
    days: periodDays,
    complete,
    stale: source.end_date < shiftCompassDate(shanghaiDate(), -1),
    summary: format(summary),
    daily: daily.map(format),
    items: items.map(format),
    top: top.map(format),
    total: total!.n,
    source,
    metricNotes: [
      "三个报表独立统计，不合并相加。",
      "库存为截止日快照，不累计每日库存。",
      "客户数与 UV 为每日累计，跨日未去重。",
      "退货率按期间退货件数 / 销售量重算，可能超过 100%，不代表同一订单批次。",
    ],
  };
}

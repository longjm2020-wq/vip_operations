import { z } from "zod";
import { db, one, rows } from "../../../../../packages/database/src/index.js";
import {
  audit,
  command,
  Context,
  fail,
  parse,
  requirePermission,
} from "../../core.js";
import {
  analyzeCompetitor,
  competitorDetailSchema,
  competitorImportSchema,
  competitorSources,
  CompetitorBrand,
  CompetitorDataset,
  materialTags,
  titleCategory,
  vipSearchUrl,
} from "../../../../../packages/contracts/src/competitor-analysis.js";
import { crawlStatus } from "./crawl-jobs.js";

const day = (value: Date | string | null) =>
  value
    ? (value instanceof Date ? value.toISOString() : value).slice(0, 10)
    : null;
export async function brands() {
  const list = await rows(
    db,
    "SELECT id::text,name,is_own,brand_sn FROM competitor_brands ORDER BY is_own DESC,id",
  );
  return list.map((x) => ({
    id: x.id,
    name: x.name,
    isOwn: x.is_own,
    brandSn: x.brand_sn,
    searchUrl: vipSearchUrl(x.name, x.brand_sn),
  })) as CompetitorBrand[];
}
export async function addBrand(c: Context, input: unknown) {
  requirePermission(c.actor, "analytics.manage");
  const b = parse(
    z
      .object({
        name: z.string().trim().min(1).max(40),
        brandSn: z
          .string()
          .regex(/^\d{1,20}$/)
          .nullable()
          .default(null),
      })
      .strict(),
    input,
  );
  return command(c, "competitor.brand.add", b, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(2026100337)::text");
    if (
      (await one(tx, "SELECT count(*)::int AS count FROM competitor_brands"))!
        .count >= 40
    )
      fail("BRAND_LIMIT", "最多管理40个品牌", 400);
    if (await one(tx, "SELECT id FROM competitor_brands WHERE name=$1", b.name))
      fail("DUPLICATE_BRAND", "品牌已存在", 409);
    const saved = await one(
      tx,
      "INSERT INTO competitor_brands(name,brand_sn,created_by) VALUES($1,$2,$3::bigint) RETURNING id",
      b.name,
      b.brandSn,
      c.actor.id,
    );
    await audit(
      tx,
      c,
      "competitor.brand.add",
      "competitor_brand",
      saved!.id,
      null,
      b,
    );
    return saved;
  });
}
function snapshot(row: any): CompetitorDataset {
  return {
    id: String(row.id),
    brandId: String(row.brand_id),
    source: row.source,
    asOfDate: day(row.as_of_date)!,
    periodStart: day(row.period_start),
    periodEnd: day(row.period_end),
    scope: row.scope,
    sourceUrl: row.source_url,
    createdAt: row.created_at.toISOString(),
    products: row.products,
  };
}
export async function dashboard(input: unknown) {
  const q = parse(
    z
      .object({
        brandIds: z
          .string()
          .regex(/^\d+(,\d+){0,11}$/)
          .optional(),
        source: z.enum(competitorSources).default("PUBLIC_RANK"),
        category: z.string().max(100).optional(),
        material: z.string().max(40).optional(),
        season: z.string().max(20).optional(),
        priceBand: z.string().max(40).optional(),
        keyword: z.string().max(100).optional(),
        sort: z.enum(["rank", "sales", "priceAsc", "priceDesc"]).optional(),
      })
      .strict(),
    input,
  );
  if (q.source === "PUBLIC_RANK" && q.sort === "sales")
    fail("INVALID_SORT", "公开排名没有实际销售件数", 400);
  const allBrands = await brands();
  const ids = [
    ...new Set(
      q.brandIds?.split(",") || allBrands.slice(0, 7).map((x) => x.id),
    ),
  ];
  const selected = ids.map((id) => allBrands.find((x) => x.id === id));
  if (selected.some((x) => !x)) fail("UNKNOWN_BRAND", "品牌不存在", 400);
  const data = await rows(
    db,
    "SELECT DISTINCT ON(brand_id) * FROM competitor_snapshots WHERE source=$1 AND brand_id=ANY($2::bigint[]) ORDER BY brand_id,as_of_date DESC,id DESC",
    q.source,
    ids,
  );
  const datasets = data.map(snapshot);
  const allProducts = datasets.flatMap((x) => x.products);
  const options = {
    categories: [
      ...new Set(allProducts.map((x) => x.category || titleCategory(x.title))),
    ].sort(),
    materials: [
      ...new Set(
        allProducts.flatMap((x) =>
          materialTags(x.materialInfo || x.title).concat(x.materialTags),
        ),
      ),
    ].sort(),
    seasons: [...new Set(allProducts.flatMap((x) => x.seasons))].sort(),
  };
  const periods = [
    ...new Set(
      datasets.map((x) =>
        q.source === "SALES_REPORT"
          ? `${x.periodStart}—${x.periodEnd}`
          : x.asOfDate,
      ),
    ),
  ];
  return {
    source: q.source,
    crawl: await crawlStatus(),
    brands: allBrands,
    options,
    alignedPeriod: periods.length <= 1,
    results: selected.map((b) =>
      analyzeCompetitor(
        b!,
        datasets.find((x) => x.brandId === b!.id),
        q,
      ),
    ),
  };
}
export async function importSnapshot(c: Context, input: unknown) {
  requirePermission(c.actor, "analytics.manage");
  const b = parse(competitorImportSchema, input);
  if (
    b.asOfDate >
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date())
  )
    fail("FUTURE_DATE", "数据日期不能晚于今天", 400);
  return command(c, "competitor.import", b, async (tx) => {
    await rows(
      tx,
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
      "competitor:" + b.brandId + ":" + b.source,
    );
    const brand = await one(
      tx,
      "SELECT * FROM competitor_brands WHERE id=$1::bigint",
      b.brandId,
    );
    if (!brand || brand.name !== b.brandName)
      fail("BRAND_MISMATCH", "导入品牌与所选品牌不一致", 400);
    const sourceSn = b.sourceUrl
      ? new URL(b.sourceUrl).searchParams.get("brand_sn")
      : null;
    if (
      b.source === "PUBLIC_RANK" &&
      brand.brand_sn &&
      sourceSn !== brand.brand_sn
    )
      fail("BRAND_MISMATCH", "公开页面品牌ID与所选品牌不一致", 400);
    const latest = await one(
      tx,
      "SELECT as_of_date,products FROM competitor_snapshots WHERE brand_id=$1::bigint AND source=$2 ORDER BY as_of_date DESC,id DESC LIMIT 1",
      b.brandId,
      b.source,
    );
    if (latest && day(latest.as_of_date)! > b.asOfDate)
      fail("OLDER_SNAPSHOT", "旧数据不能覆盖更新的数据", 409);
    const priorDetails = new Map<string, CompetitorDataset["products"][number]>(
      (latest?.products || []).map(
        (p: CompetitorDataset["products"][number]) => [p.productId, p],
      ),
    );
    const products = b.products.map((p) => {
      const prior = priorDetails.get(p.productId);
      if (
        b.source !== "PUBLIC_RANK" ||
        p.detailVerified ||
        !prior?.detailVerified
      )
        return p;
      return {
        ...p,
        styleCode: prior.styleCode || p.styleCode,
        category: prior.category || p.category,
        materialInfo: prior.materialInfo,
        materialTags: prior.materialTags,
        seasons: prior.seasons,
        detailVerified: true,
        detailObservedAt: prior.detailObservedAt,
      };
    });
    const saved = await one(
      tx,
      "INSERT INTO competitor_snapshots(brand_id,source,as_of_date,period_start,period_end,source_url,scope,products,created_by) VALUES($1::bigint,$2,$3::date,$4::date,$5::date,$6,$7,$8::jsonb,$9::bigint) RETURNING id",
      b.brandId,
      b.source,
      b.asOfDate,
      b.periodStart,
      b.periodEnd,
      b.sourceUrl,
      b.scope,
      JSON.stringify(products),
      c.actor.id,
    );
    if (b.source === "PUBLIC_RANK" && !brand.brand_sn)
      await tx.$executeRawUnsafe(
        "UPDATE competitor_brands SET brand_sn=$2 WHERE id=$1::bigint",
        b.brandId,
        sourceSn,
      );
    await audit(
      tx,
      c,
      "competitor.import",
      "competitor_snapshot",
      saved!.id,
      null,
      {
        brandId: b.brandId,
        source: b.source,
        asOfDate: b.asOfDate,
        count: b.products.length,
      },
    );
    return { id: saved!.id, count: b.products.length };
  });
}
export async function enrichDetails(c: Context, input: unknown) {
  requirePermission(c.actor, "analytics.manage");
  const b = parse(competitorDetailSchema, input);
  if (b.products.some((p) => !p.detailVerified || !p.detailObservedAt))
    fail("DETAIL_UNVERIFIED", "详情数据需保留采集时间和核对标记", 400);
  return command(c, "competitor.details", b, async (tx) => {
    await rows(
      tx,
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text",
      "competitor:" + b.brandId + ":PUBLIC_RANK",
    );
    const brand = await one(
      tx,
      "SELECT name FROM competitor_brands WHERE id=$1::bigint",
      b.brandId,
    );
    if (!brand || brand.name !== b.brandName)
      fail("BRAND_MISMATCH", "详情品牌与所选品牌不一致", 400);
    const latest = await one(
      tx,
      "SELECT * FROM competitor_snapshots WHERE brand_id=$1::bigint AND source='PUBLIC_RANK' ORDER BY as_of_date DESC,id DESC LIMIT 1 FOR UPDATE",
      b.brandId,
    );
    if (!latest) fail("NO_SNAPSHOT", "请先导入该品牌的公开销量排名", 400);
    if (b.snapshotId && String(latest.id) !== b.snapshotId)
      fail(
        "SNAPSHOT_CHANGED",
        "排名样本已更新，本次详情任务停止；请重新采集",
        409,
      );
    const indexed = new Map(b.products.map((p) => [p.productId, p]));
    let count = 0;
    const products = (latest.products as CompetitorDataset["products"]).map(
      (p) => {
        const d = indexed.get(p.productId);
        if (!d) return p;
        if (
          p.detailObservedAt &&
          d.detailObservedAt &&
          d.detailObservedAt < p.detailObservedAt
        )
          fail("OLDER_DETAIL", "较旧的详情不能覆盖已核对的数据", 409);
        count++;
        return {
          ...p,
          styleCode: d.styleCode || p.styleCode,
          category: d.category || p.category,
          materialInfo: d.materialInfo,
          materialTags: materialTags(d.materialInfo),
          seasons: d.seasons,
          detailVerified: true,
          detailObservedAt: d.detailObservedAt,
        };
      },
    );
    if (count === 0)
      fail("NO_MATCHING_PRODUCT", "详情商品不在最新排名样本中", 400);
    await tx.$executeRawUnsafe(
      "UPDATE competitor_snapshots SET products=$2::jsonb,updated_at=now() WHERE id=$1::bigint",
      String(latest.id),
      JSON.stringify(products),
    );
    await audit(
      tx,
      c,
      "competitor.details",
      "competitor_snapshot",
      latest.id,
      null,
      { count },
    );
    return { count, unmatched: b.products.length - count };
  });
}

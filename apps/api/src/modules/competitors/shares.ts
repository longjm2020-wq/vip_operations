import { randomBytes } from "node:crypto";
import { db, one, rows } from "../../../../../packages/database/src/index.js";
import {
  competitorShareSchema,
  competitorShareFiltersSchema,
} from "../../../../../packages/contracts/src/competitor-sharing.js";
import type {
  CompetitorProduct,
  CompetitorProductPreview,
} from "../../../../../packages/contracts/src/competitor-analysis.js";
import {
  audit,
  command,
  Context,
  fail,
  hash,
  id,
  parse,
  requirePermission,
} from "../../core.js";
import { analysisData } from "./service.js";

export async function createShare(c: Context, input: unknown) {
  requirePermission(c.actor, "analytics.manage");
  const b = parse(competitorShareSchema, input);
  return command(c, "competitor.share.create", b, async (tx) => {
    const brands = await rows(
      tx,
      "SELECT id::text,name FROM competitor_brands WHERE id=ANY($1::bigint[])",
      b.brandIds,
    );
    if (brands.length !== b.brandIds.length)
      fail("UNKNOWN_BRAND", "品牌不存在，请刷新后重新选择", 400);
    const names = b.brandIds.map(
      (id) => brands.find((brand) => brand.id === id)!.name,
    );
    const token = randomBytes(32).toString("hex");
    const saved = await one(
      tx,
      "INSERT INTO competitor_shares(token_hash,brand_ids,brand_names,filters,expires_at,created_by) VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb,now()+make_interval(days=>$5::int),$6::bigint) RETURNING id,expires_at",
      hash(token),
      JSON.stringify(b.brandIds),
      JSON.stringify(names),
      JSON.stringify(b.filters),
      b.days,
      c.actor.id,
    );
    await audit(
      tx,
      c,
      "competitor.share.create",
      "competitor_share",
      saved!.id,
      null,
      b,
    );
    return {
      id: String(saved!.id),
      path: "/share/competitors/" + token,
      expiresAt: saved!.expires_at,
    };
  });
}

export async function listShares(c: Context) {
  requirePermission(c.actor, "analytics.manage");
  // Keep every active link manageable, plus the latest 30 expired/revoked links.
  return rows(
    db,
    `SELECT id::text,brand_names,filters,expires_at,revoked_at,created_at
    FROM competitor_shares WHERE created_by=$1::bigint AND (
      (revoked_at IS NULL AND expires_at>now()) OR id IN (
        SELECT id FROM competitor_shares WHERE created_by=$1::bigint ORDER BY id DESC LIMIT 30))
    ORDER BY id DESC`,
    c.actor.id,
  );
}

export async function revokeShare(c: Context, shareId: string) {
  requirePermission(c.actor, "analytics.manage");
  parse(id, shareId);
  return command(c, "competitor.share.revoke", { id: shareId }, async (tx) => {
    const share = await one(
      tx,
      "SELECT created_by,revoked_at FROM competitor_shares WHERE id=$1::bigint FOR UPDATE",
      shareId,
    );
    if (
      !share ||
      (String(share.created_by) !== c.actor.id &&
        !c.actor.roleCodes?.includes("SUPER_ADMIN"))
    )
      fail("SHARE_NOT_FOUND", "分享不存在或无权关闭", 404);
    if (!share.revoked_at) {
      await tx.$executeRawUnsafe(
        "UPDATE competitor_shares SET revoked_at=now() WHERE id=$1::bigint",
        shareId,
      );
      await audit(
        tx,
        c,
        "competitor.share.revoke",
        "competitor_share",
        shareId,
        null,
        { revoked: true },
      );
    }
    return { revoked: true };
  });
}

// Explicit public fields: future private dashboard/collection fields must never leak.
const preview = (p: CompetitorProductPreview): CompetitorProductPreview => ({
  productId: p.productId,
  title: p.title,
  styleCode: p.styleCode,
  productUrl: p.productUrl,
  imageUrl: p.imageUrl,
  salePrice: p.salePrice,
  publicRank: p.publicRank,
  materialInfo: p.materialInfo,
});
const product = (p: CompetitorProduct): CompetitorProduct => ({
  ...preview(p),
  marketPrice: p.marketPrice,
  salesCount: null,
  category: p.category,
  materialTags: p.materialTags,
  seasons: p.seasons,
  detailVerified: p.detailVerified,
  detailObservedAt: p.detailObservedAt,
});
export async function publicShare(token: string) {
  const unavailable = () =>
    fail("SHARE_UNAVAILABLE", "分享链接不存在、已过期或已关闭", 404);
  if (!/^[a-f0-9]{64}$/.test(token)) unavailable();
  const record = await one(
    db,
    "SELECT brand_ids,filters,expires_at,created_at FROM competitor_shares WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()",
    hash(token),
  );
  if (!record) return unavailable();
  const filters = parse(competitorShareFiltersSchema, record.filters);
  const data = await analysisData({
    source: "PUBLIC_RANK",
    brandIds: record.brand_ids.join(","),
    ...filters,
  });
  const results = data.results.map((r) => ({
    brand: {
      id: r.brand.id,
      name: r.brand.name,
      isOwn: r.brand.isOwn,
      brandSn: r.brand.brandSn,
      searchUrl: r.brand.searchUrl,
    },
    snapshot: r.snapshot
      ? {
          id: r.snapshot.id,
          brandId: r.snapshot.brandId,
          source: r.snapshot.source,
          asOfDate: r.snapshot.asOfDate,
          periodStart: null,
          periodEnd: null,
          scope: r.snapshot.scope,
          sourceUrl: r.snapshot.sourceUrl,
          createdAt: r.snapshot.createdAt,
        }
      : null,
    total: r.total,
    captured: r.captured,
    medianPrice: r.medianPrice,
    minPrice: r.minPrice,
    maxPrice: r.maxPrice,
    salesCount: null,
    materialCoverage: r.materialCoverage,
    top20: r.top20.map(product),
    ...Object.fromEntries(
      (["categories", "materials", "seasons", "prices"] as const).map((key) => [
        key,
        r[key].map((group) => ({
          name: group.name,
          count: group.count,
          top10: group.top10.map(preview),
        })),
      ]),
    ),
  }));
  return {
    source: "PUBLIC_RANK",
    brands: results.map((r) => r.brand),
    alignedPeriod: data.alignedPeriod,
    results,
    share: {
      filters,
      expiresAt: record.expires_at,
      createdAt: record.created_at,
    },
  };
}

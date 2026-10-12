import {
  competitorDetailSchema,
  competitorImportSchema,
  vipListUrl,
  vipProductUrl,
  type CompetitorBrand,
} from "./competitor-analysis.js";

export const localCollectorVersion = "1.0.0";
export type LocalCaptureReply = {
  status: "READY" | "WAIT" | "LOGIN" | "VERIFY" | "ERROR";
  note?: string;
  data?: unknown;
};

// Also serialized into the extension. Keep this function self-contained.
export function localCollectorUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.port || u.username || u.password)
      return null;
    if (
      u.hostname === "detail.vip.com" &&
      /^\/detail-\d+-\d+\.html$/.test(u.pathname)
    )
      return u.origin + u.pathname;
    if (
      u.hostname !== "category.vip.com" ||
      u.pathname !== "/suggest.php" ||
      u.searchParams.get("orderId") !== "6" ||
      !/^\d{1,20}$/.test(u.searchParams.get("brand_sn") || "") ||
      !u.searchParams.get("keyword") ||
      (u.searchParams.has("page") && u.searchParams.get("page") !== "1")
    )
      return null;
    const q = new URLSearchParams({
      keyword: u.searchParams.get("keyword")!,
      orderId: "6",
      brand_sn: u.searchParams.get("brand_sn")!,
    });
    return u.origin + u.pathname + "?" + q;
  } catch {
    return null;
  }
}

export function localListImport(data: unknown, brand: CompetitorBrand) {
  const raw = data as Record<string, unknown> | null;
  if (raw?.kind !== "LIST" || !Array.isArray(raw.products))
    throw Error("未读取到品牌榜单");
  const { kind: _kind, ...body } = raw;
  const parsed = competitorImportSchema.parse({
    ...body,
    brandId: brand.id,
    products: raw.products.slice(0, 50),
    scope: `本机浏览器采集品牌公开销量榜前${Math.min(raw.products.length, 50)}款样本（最多50款，非全品牌目录）`,
  });
  const url = parsed.sourceUrl && vipListUrl(parsed.sourceUrl);
  if (
    parsed.brandName !== brand.name ||
    !url ||
    !brand.brandSn ||
    new URL(url).searchParams.get("brand_sn") !== brand.brandSn ||
    !localCollectorUrl(url) ||
    parsed.products.some((p, i) => p.publicRank !== i + 1)
  )
    throw Error("榜单品牌或排名与本次任务不一致，请返回目标品牌销量第一页");
  return parsed;
}

export function localDetailImport(
  data: unknown,
  brand: CompetitorBrand,
  snapshotId: string,
  productUrl: string,
) {
  const raw = data as Record<string, unknown> | null;
  if (raw?.kind !== "DETAILS") throw Error("未读取到商品规格参数");
  const { kind: _kind, ...body } = raw;
  const sameBrand =
    typeof body.brandName === "string" &&
    body.brandName
      .split(/[\/／|｜]/)
      .some((name) => name.trim() === brand.name);
  if (!sameBrand) throw Error("商品或品牌发生跳转，未写入这款详情");
  const parsed = competitorDetailSchema.parse({
    ...body,
    brandName: brand.name,
    brandId: brand.id,
    snapshotId,
  });
  if (
    parsed.brandName !== brand.name ||
    parsed.products.length !== 1 ||
    parsed.products[0].productUrl !== vipProductUrl(productUrl) ||
    !parsed.products[0].detailVerified ||
    !parsed.products[0].detailObservedAt
  )
    throw Error("商品或品牌发生跳转，未写入这款详情");
  return parsed;
}

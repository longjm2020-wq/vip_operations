import { z } from "zod";

export const competitorSources = ["PUBLIC_RANK", "SALES_REPORT"] as const;
export type CompetitorSource = (typeof competitorSources)[number];
export const defaultCompetitorNames = [
  "序缇",
  "帕罗",
  "米皇",
  "笑涵阁",
  "生活在左",
  "金菊",
  "南宋丝府",
];
export const competitorPriceBands = [
  { key: "under200", label: "200元以下", min: 0, max: 200 },
  { key: "200to500", label: "200–499元", min: 200, max: 500 },
  { key: "500to1000", label: "500–999元", min: 500, max: 1000 },
  { key: "1000to2000", label: "1000–1999元", min: 1000, max: 2000 },
  { key: "over2000", label: "2000元及以上", min: 2000, max: Infinity },
];
export function vipProductUrl(value: string) {
  try {
    const u = new URL(value, "https://detail.vip.com");
    if (
      u.protocol !== "https:" ||
      u.hostname !== "detail.vip.com" ||
      u.port ||
      u.username ||
      u.password ||
      !/^\/detail-\d+-\d+\.html$/.test(u.pathname)
    )
      return null;
    return u.origin + u.pathname;
  } catch {
    return null;
  }
}
export function vipSearchUrl(name: string, brandSn?: string | null) {
  const p = new URLSearchParams({ keyword: name, orderId: "6" });
  if (brandSn) p.set("brand_sn", brandSn);
  return "https://category.vip.com/suggest.php?" + p;
}
export function vipListUrl(value: string) {
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.hostname !== "category.vip.com" ||
      u.port ||
      u.username ||
      u.password ||
      u.pathname !== "/suggest.php"
    )
      return null;
    return u.href;
  } catch {
    return null;
  }
}
export function vipImageUrl(value: string) {
  try {
    const u = new URL(value, "https://a.vpimg4.com");
    if (
      !/^(?:[ab]\.vpimg\d+\.com|(?:[ab]|h\d+)\.appsimg\.com)$/.test(
        u.hostname,
      ) ||
      u.username ||
      u.password ||
      u.port ||
      !["http:", "https:"].includes(u.protocol)
    )
      return null;
    u.protocol = "https:";
    return u.href;
  } catch {
    return null;
  }
}
const cleanText = z.string().trim().max(2000);
const price = z.number().finite().min(0).max(10000000).nullable().default(null);
export const competitorProductSchema = z
  .object({
    productId: z.string().regex(/^\d{1,30}$/),
    title: cleanText.min(1),
    styleCode: z.string().trim().max(100).default(""),
    productUrl: z
      .string()
      .max(1000)
      .refine((v) => !!vipProductUrl(v), "请填写唯品会官方商品详情链接")
      .transform((v) => vipProductUrl(v)!),
    imageUrl: z
      .string()
      .max(2000)
      .nullable()
      .default(null)
      .transform((v) => (v ? vipImageUrl(v) : null)),
    salePrice: price,
    marketPrice: price,
    publicRank: z.number().int().min(1).max(1000000).nullable().default(null),
    salesCount: z
      .number()
      .int()
      .min(0)
      .max(1000000000)
      .nullable()
      .default(null),
    category: z.string().trim().max(100).default(""),
    materialInfo: cleanText.default(""),
    materialTags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    seasons: z.array(z.string().trim().min(1).max(20)).max(8).default([]),
    detailVerified: z.boolean().default(false),
    detailObservedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.productUrl.match(/-(\d+)\.html$/)?.[1] !== v.productId)
      c.addIssue({ code: "custom", message: "商品ID与详情链接不一致" });
  });
export type CompetitorProduct = z.infer<typeof competitorProductSchema>;
export const competitorImportSchema = z
  .object({
    brandId: z.string().regex(/^[1-9]\d{0,18}$/),
    brandName: z.string().trim().min(1).max(40),
    source: z.enum(competitorSources),
    asOfDate: z.iso.date(),
    periodStart: z.iso.date().nullable().default(null),
    periodEnd: z.iso.date().nullable().default(null),
    sourceUrl: z
      .string()
      .max(2000)
      .nullable()
      .default(null)
      .refine(
        (v) => v === null || !!vipListUrl(v),
        "来源链接须为唯品会官方品牌搜索页",
      ),
    scope: z.string().trim().min(1).max(300),
    products: z.array(competitorProductSchema).min(1).max(5000),
  })
  .strict()
  .superRefine((v, c) => {
    if (new Set(v.products.map((x) => x.productId)).size !== v.products.length)
      c.addIssue({ code: "custom", message: "同一批次不能包含重复商品ID" });
    if (v.source === "PUBLIC_RANK") {
      const url = v.sourceUrl && vipListUrl(v.sourceUrl);
      if (
        !url ||
        new URL(url).searchParams.get("orderId") !== "6" ||
        !/^\d+$/.test(new URL(url).searchParams.get("brand_sn") || "")
      )
        c.addIssue({
          code: "custom",
          message: "公开排名须来自已选择品牌的唯品会销量排序页",
        });
      if (url && new URL(url).searchParams.get("keyword") !== v.brandName)
        c.addIssue({
          code: "custom",
          message: "来源页面的品牌关键词与导入品牌不一致",
        });
      if (
        v.products.some((x) => x.publicRank === null || x.salesCount !== null)
      )
        c.addIssue({
          code: "custom",
          message: "公开排名必须填写排名，不能作为实际销量",
        });
      if (
        new Set(v.products.map((x) => x.publicRank)).size !== v.products.length
      )
        c.addIssue({ code: "custom", message: "公开排名不可重复" });
    } else if (
      !v.periodStart ||
      !v.periodEnd ||
      v.periodStart > v.periodEnd ||
      v.periodEnd > v.asOfDate ||
      v.products.some((x) => x.salesCount === null)
    )
      c.addIssue({
        code: "custom",
        message: "销量报表须有统一统计起止日期及每款实际销量",
      });
  });
export const competitorDetailSchema = z
  .object({
    brandId: z.string().regex(/^[1-9]\d{0,18}$/),
    brandName: z.string().trim().min(1).max(40),
    snapshotId: z
      .string()
      .regex(/^[1-9]\d{0,18}$/)
      .optional(),
    products: z.array(competitorProductSchema).min(1).max(5000),
  })
  .strict();

export function materialTags(text: string) {
  return [
    "桑蚕丝",
    "羊绒",
    "绵羊毛",
    "羊毛",
    "亚麻",
    "苎麻",
    "棉",
    "粘纤",
    "莱赛尔",
    "聚酯纤维",
    "锦纶",
    "氨纶",
    "醋酯纤维",
  ]
    .filter((x) => text.includes(x))
    .filter((x) => x !== "羊毛" || !text.includes("绵羊毛"));
}
export function titleCategory(title: string) {
  return (
    [
      "连衣裙",
      "半身裙",
      "羊毛衫",
      "羊绒衫",
      "衬衫",
      "大衣",
      "羽绒服",
      "马甲",
      "背心",
      "T恤",
      "针织衫",
      "开衫",
      "外套",
      "长裤",
      "短裤",
      "套装",
      "上衣",
    ].find((x) => title.includes(x)) || "未分类"
  );
}
export type CompetitorBrand = {
  id: string;
  name: string;
  isOwn: boolean;
  brandSn: string | null;
  searchUrl: string;
};
export type CompetitorDataset = {
  id: string;
  brandId: string;
  source: CompetitorSource;
  asOfDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  scope: string;
  sourceUrl: string | null;
  createdAt: string;
  products: CompetitorProduct[];
};
export type CompetitorFilters = {
  category?: string;
  material?: string;
  season?: string;
  priceBand?: string;
  keyword?: string;
  sort?: "rank" | "sales" | "priceAsc" | "priceDesc";
};
export function analyzeCompetitor(
  brand: CompetitorBrand,
  snapshot: CompetitorDataset | undefined,
  filters: CompetitorFilters,
) {
  const all = snapshot?.products || [];
  const band = competitorPriceBands.find((x) => x.key === filters.priceBand);
  const products = all.filter(
    (x) =>
      (!filters.category ||
        (x.category || titleCategory(x.title)) === filters.category) &&
      (!filters.material ||
        materialTags(x.materialInfo || x.title)
          .concat(x.materialTags)
          .includes(filters.material)) &&
      (!filters.season || x.seasons.includes(filters.season)) &&
      (!filters.keyword ||
        (x.title + " " + x.styleCode)
          .toLowerCase()
          .includes(filters.keyword.toLowerCase())) &&
      (!band ||
        (x.salePrice !== null &&
          x.salePrice >= band.min &&
          x.salePrice < band.max)),
  );
  const sort =
    filters.sort || (snapshot?.source === "SALES_REPORT" ? "sales" : "rank");
  const value = (x: CompetitorProduct) =>
    sort === "sales"
      ? x.salesCount
      : sort === "rank"
        ? x.publicRank
        : x.salePrice;
  const ranked = [...products]
    .sort((a, b) => {
      const av = value(a),
        bv = value(b);
      return av === null
        ? bv === null
          ? a.productId.localeCompare(b.productId)
          : 1
        : bv === null
          ? -1
          : (sort === "priceDesc" || sort === "sales" ? bv - av : av - bv) ||
            a.productId.localeCompare(b.productId);
    })
    .slice(0, 20);
  const prices = products
    .map((x) => x.salePrice)
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  const median = prices.length
    ? (prices[Math.floor((prices.length - 1) / 2)] +
        prices[Math.floor(prices.length / 2)]) /
      2
    : null;
  const distribution = (fn: (x: CompetitorProduct) => string[]) => {
    const counts = new Map<string, number>();
    products.forEach((p) =>
      new Set(fn(p)).forEach((k) => counts.set(k, (counts.get(k) || 0) + 1)),
    );
    return [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };
  return {
    brand,
    snapshot: snapshot ? { ...snapshot, products: undefined } : null,
    total: products.length,
    captured: all.length,
    medianPrice: median,
    minPrice: prices[0] ?? null,
    maxPrice: prices.at(-1) ?? null,
    salesCount:
      snapshot?.source === "SALES_REPORT"
        ? products.reduce((s, x) => s + (x.salesCount || 0), 0)
        : null,
    materialCoverage: products.filter((x) => x.detailVerified && x.materialInfo)
      .length,
    top20: ranked,
    categories: distribution((x) => [x.category || titleCategory(x.title)]),
    materials: distribution((x) =>
      materialTags(x.materialInfo || x.title).concat(x.materialTags).length
        ? materialTags(x.materialInfo || x.title).concat(x.materialTags)
        : ["未公开"],
    ),
    seasons: distribution((x) => (x.seasons.length ? x.seasons : ["未公开"])),
    prices: competitorPriceBands.map((b) => ({
      name: b.label,
      count: products.filter(
        (x) =>
          x.salePrice !== null && x.salePrice >= b.min && x.salePrice < b.max,
      ).length,
    })),
  };
}

import { describe, expect, it } from "vitest";
import {
  analyzeCompetitor,
  competitorImportSchema,
  competitorProductSchema,
  materialTags,
  vipImageUrl,
  vipProductUrl,
  vipSearchUrl,
  type CompetitorDataset,
} from "../../packages/contracts/src/competitor-analysis.js";
const brand = {
  id: "1",
  name: "序缇",
  isOwn: true,
  brandSn: "10204477",
  searchUrl: vipSearchUrl("序缇", "10204477"),
};
const product = (index: number, extra: Record<string, unknown> = {}) =>
  competitorProductSchema.parse({
    productId: String(6921659409327812000n + BigInt(index)),
    title: `桑蚕丝连衣裙 ${index}`,
    productUrl: `https://detail.vip.com/detail-1714040133-${6921659409327812000n + BigInt(index)}.html`,
    publicRank: index,
    ...extra,
  });
const snapshot = (
  source: "PUBLIC_RANK" | "SALES_REPORT",
  products: ReturnType<typeof product>[],
): CompetitorDataset => ({
  id: "1",
  brandId: "1",
  source,
  asOfDate: "2026-10-03",
  periodStart: source === "SALES_REPORT" ? "2026-09-01" : null,
  periodEnd: source === "SALES_REPORT" ? "2026-09-30" : null,
  scope: "测试样本",
  sourceUrl: brand.searchUrl,
  createdAt: "2026-10-03T00:00:00Z",
  products,
});
describe("Competitor analysis integrity", () => {
  it("previews each distribution's first ten matching products from the complete filtered sample", () => {
    const data = snapshot(
      "PUBLIC_RANK",
      Array.from({ length: 50 }, (_, i) =>
        product(i + 1, {
          category: i < 20 ? "连衣裙" : "衬衫",
          materialInfo: i < 20 ? "桑蚕丝100%" : "羊绒70% 桑蚕丝30%",
          materialTags: ["桑蚕丝"],
          salePrice: i < 20 ? 199.99 : 200 + i,
          seasons: [i < 20 ? "夏" : "秋"],
        }),
      ),
    );
    const result = analyzeCompetitor(brand, data, {});
    expect(result.top20.every((p) => p.category === "连衣裙")).toBe(true);
    const shirts = result.categories.find((x) => x.name === "衬衫")!;
    expect(shirts.count).toBe(30);
    expect(shirts.top10.map((p) => p.publicRank)).toEqual(
      Array.from({ length: 10 }, (_, i) => 21 + i),
    );
    expect(result.materials.find((x) => x.name === "桑蚕丝")!.count).toBe(50);
    expect(result.seasons.find((x) => x.name === "秋")!.top10).toHaveLength(10);
    expect(result.prices.find((x) => x.name === "200–499元")!.top10).toEqual(
      shirts.top10,
    );
    const filtered = analyzeCompetitor(brand, data, {
      category: "衬衫",
      season: "秋",
      priceBand: "200to500",
      sort: "priceDesc",
    });
    expect(
      filtered.materials.find((x) => x.name === "羊绒")!.top10[0].publicRank,
    ).toBe(50);
    expect(filtered.categories.every((x) => x.name === "衬衫")).toBe(true);
    expect(filtered.seasons.map((x) => x.name)).toEqual(["秋"]);
    expect(filtered.prices.find((x) => x.name === "200元以下")!.top10).toEqual(
      [],
    );
    expect(filtered.categories[0].top10[0].materialInfo).toBe(
      "羊绒70% 桑蚕丝30%",
    );
    expect(
      analyzeCompetitor(brand, snapshot("PUBLIC_RANK", [product(1)]), {})
        .categories[0].top10[0].materialInfo,
    ).toBe("");
  });
  it("validates official product identity and URLs, leaving missing prices and pictures missing", () => {
    expect(product(1).productId).toBe("6921659409327812001");
    expect(product(1).salePrice).toBeNull();
    expect(() =>
      product(1, { productUrl: "https://detail.vip.com/detail-1-2.html" }),
    ).toThrow("商品ID");
    for (const url of [
      "https://detail.vip.com.evil.test/detail-1-2.html",
      "http://detail.vip.com/detail-1-2.html",
      "https://user@detail.vip.com/detail-1-2.html",
      "https://detail.vip.com:8443/detail-1-2.html",
    ])
      expect(vipProductUrl(url)).toBeNull();
    expect(vipImageUrl("javascript:alert(1)")).toBeNull();
    expect(vipImageUrl("https://127.0.0.1/x.png")).toBeNull();
    expect(vipImageUrl("//h2.appsimg.com/a.appsimg.com/image.jpg")).toBe(
      "https://h2.appsimg.com/a.appsimg.com/image.jpg",
    );
  });
  it("selects TOP20 within each brand and never substitutes public rank for sales", () => {
    const data = snapshot(
      "PUBLIC_RANK",
      Array.from({ length: 25 }, (_, i) =>
        product(25 - i, { salePrice: i % 2 ? 300 : null }),
      ),
    );
    const result = analyzeCompetitor(brand, data, {});
    expect(result.top20.map((p) => p.publicRank)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(result.total).toBe(25);
    expect(result.salesCount).toBeNull();
    expect(result.medianPrice).toBe(300);
    const actual = snapshot("SALES_REPORT", [
      product(1, { publicRank: null, salesCount: 0 }),
      product(2, { publicRank: null, salesCount: 10 }),
    ]);
    expect(analyzeCompetitor(brand, actual, {}).top20[0].salesCount).toBe(10);
    expect(analyzeCompetitor(brand, actual, {}).salesCount).toBe(10);
    expect(analyzeCompetitor(brand, undefined, {}).snapshot).toBeNull();
  });
  it("applies category, material, season and exact price bands before ranking, without deriving compositions", () => {
    const products = [
      product(1, { salePrice: 199.99 }),
      product(2, {
        salePrice: 200,
        category: "连衣裙",
        materialInfo: "【面料】桑蚕丝80% 羊绒20%",
        seasons: ["秋"],
        detailVerified: true,
      }),
      product(3, { salePrice: 500 }),
      product(4, { salePrice: null }),
    ];
    const result = analyzeCompetitor(brand, snapshot("PUBLIC_RANK", products), {
      category: "连衣裙",
      material: "羊绒",
      season: "秋",
      priceBand: "200to500",
    });
    expect(result.total).toBe(1);
    expect(result.top20[0].publicRank).toBe(2);
    expect(result.materialCoverage).toBe(1);
    expect(
      analyzeCompetitor(brand, snapshot("PUBLIC_RANK", products), {
        priceBand: "under200",
      }).total,
    ).toBe(1);
    expect(
      analyzeCompetitor(brand, snapshot("PUBLIC_RANK", products), {}).top20[0]
        .materialInfo,
    ).toBe("");
    expect(materialTags("绵羊毛80% 羊绒20%")).toEqual(["羊绒", "绵羊毛"]);
  });
  it("requires sales order, exact brand keyword, unique rank and sales report periods", () => {
    const input = {
      brandId: "1",
      brandName: "序缇",
      source: "PUBLIC_RANK",
      asOfDate: "2026-10-03",
      sourceUrl: brand.searchUrl,
      scope: "公开测试",
      products: [product(1)],
    };
    expect(competitorImportSchema.safeParse(input).success).toBe(true);
    for (const sourceUrl of [
      brand.searchUrl.replace("orderId=6", "orderId=0"),
      vipSearchUrl("帕罗", "10204477"),
      "https://example.test/?orderId=6&brand_sn=1",
    ]) {
      expect(
        competitorImportSchema.safeParse({ ...input, sourceUrl }).success,
      ).toBe(false);
    }
    expect(
      competitorImportSchema.safeParse({
        ...input,
        products: [product(1, { salesCount: 10 })],
      }).success,
    ).toBe(false);
    expect(
      competitorImportSchema.safeParse({
        ...input,
        products: [product(1), product(2, { publicRank: 1 })],
      }).success,
    ).toBe(false);
    const actual = {
      ...input,
      source: "SALES_REPORT",
      sourceUrl: null,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      products: [product(1, { publicRank: null, salesCount: 0 })],
    };
    expect(competitorImportSchema.safeParse(actual).success).toBe(true);
    expect(
      competitorImportSchema.safeParse({
        ...actual,
        products: [product(1, { publicRank: null })],
      }).success,
    ).toBe(false);
  });
});

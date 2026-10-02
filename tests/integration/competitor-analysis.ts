import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  shanghaiDate,
  shiftCompassDate,
} from "../../packages/contracts/src/compass-analytics.js";
import { competitorProductSchema } from "../../packages/contracts/src/competitor-analysis.js";

export async function testCompetitorAnalysis(h: Record<string, any>) {
  const { ok, request, db, one, check, buyer } = h,
    endpoint = "/analytics/competitors",
    asOfDate = shanghaiDate();
  assert.equal(
    (
      await request(endpoint, "GET", undefined, undefined, {
        cookie: "",
        csrf: "",
      })
    ).status,
    401,
  );
  assert.equal(
    (await request(endpoint, "GET", undefined, undefined, buyer)).status,
    403,
  );
  const initial = await ok(endpoint);
  assert.equal(initial.brands.length, 7);
  assert.equal(initial.results.length, 7);
  assert.equal(initial.brands[0].name, "序缇");
  assert.ok(initial.brands.some((b: any) => b.name === "笑涵阁"));
  assert.equal(initial.results[0].snapshot, null);
  const own = initial.brands[0],
    rival = initial.brands[1],
    key = randomUUID();
  const added = await ok(
    endpoint + "/brands",
    "POST",
    { name: "测试新增竞品", brandSn: "10000001" },
    key,
  );
  assert.equal(
    (
      await ok(
        endpoint + "/brands",
        "POST",
        { name: "测试新增竞品", brandSn: "10000001" },
        key,
      )
    ).id,
    added.id,
  );
  assert.equal(
    (await request(endpoint + "/brands", "POST", { name: "测试新增竞品" }))
      .status,
    409,
  );
  assert.equal(
    (
      await request(
        endpoint + "/brands",
        "POST",
        { name: "禁止新增" },
        undefined,
        buyer,
      )
    ).status,
    403,
  );
  const products = Array.from({ length: 25 }, (_, i) =>
    competitorProductSchema.parse({
      productId: String(6921659409327812000n + BigInt(i)),
      title: `羊绒衫测试${i}`,
      styleCode: `CT-${i}`,
      productUrl: `https://detail.vip.com/detail-1714040133-${6921659409327812000n + BigInt(i)}.html`,
      imageUrl: "https://h2.appsimg.com/a.appsimg.com/test.jpg",
      publicRank: i + 1,
      salePrice: 200 + i * 10,
      category: "羊绒衫",
    }),
  );
  const rank = {
    brandId: own.id,
    brandName: own.name,
    source: "PUBLIC_RANK",
    asOfDate,
    sourceUrl: own.searchUrl,
    scope: "销量排序首屏25款测试样本",
    products,
  };
  const importKey = randomUUID();
  await ok(endpoint + "/imports", "POST", rank, importKey);
  await ok(endpoint + "/imports", "POST", rank, importKey);
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM competitor_snapshots WHERE brand_id=$1::bigint",
        own.id,
      )
    ).n,
    1,
  );
  assert.equal(
    (
      await request(endpoint + "/imports", "POST", {
        ...rank,
        sourceUrl: rival.searchUrl,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(endpoint + "/imports", "POST", {
        ...rank,
        sourceUrl: "https://127.0.0.1/?orderId=6&brand_sn=1",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(endpoint + "/imports", "POST", {
        ...rank,
        asOfDate: shiftCompassDate(asOfDate, -1),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(endpoint + "/imports", "POST", {
        ...rank,
        asOfDate: shiftCompassDate(asOfDate, 1),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(endpoint + "/imports", "POST", {
        ...rank,
        products: [{ ...products[0], salesCount: 99 }],
      })
    ).status,
    400,
  );
  const before = (await ok(endpoint + `?brandIds=${own.id}`)).results[0];
  assert.equal(before.total, 25);
  assert.equal(before.top20.length, 20);
  assert.equal(before.top20[0].publicRank, 1);
  assert.equal(before.salesCount, null);
  assert.equal(before.materialCoverage, 0);
  const detail = {
    ...products[0],
    salePrice: 1,
    publicRank: 999,
    materialInfo: "【面料】羊绒70% 桑蚕丝30%",
    seasons: ["秋"],
    detailVerified: true,
    detailObservedAt: new Date().toISOString(),
  };
  assert.equal(
    (
      await ok(endpoint + "/details", "POST", {
        brandId: own.id,
        brandName: own.name,
        products: [detail],
      })
    ).count,
    1,
  );
  const material = (
    await ok(
      endpoint +
        `?brandIds=${own.id}&material=${encodeURIComponent("桑蚕丝")}&season=${encodeURIComponent("秋")}&priceBand=200to500`,
    )
  ).results[0];
  assert.equal(material.total, 1);
  assert.equal(material.top20[0].salePrice, 200);
  assert.equal(material.top20[0].publicRank, 1);
  assert.equal(material.materialCoverage, 1);
  const newer = await ok(endpoint + "/imports", "POST", rank);
  assert.equal(
    (
      await request(endpoint + "/details", "POST", {
        brandId: own.id,
        brandName: own.name,
        snapshotId: String(BigInt(newer.id) - 1n),
        products: [detail],
      })
    ).status,
    409,
    "an older crawl cannot change a newer snapshot",
  );
  const retained = (await ok(endpoint + `?brandIds=${own.id}`)).results[0];
  assert.equal(retained.top20[0].materialInfo, detail.materialInfo);
  assert.equal(retained.top20[0].detailObservedAt, detail.detailObservedAt);
  assert.equal(
    (
      await request(endpoint + "/details", "POST", {
        brandId: own.id,
        brandName: own.name,
        products: [{ ...detail, detailObservedAt: "2020-01-01T00:00:00Z" }],
      })
    ).status,
    409,
  );
  const actual = {
    ...rank,
    source: "SALES_REPORT",
    sourceUrl: null,
    periodStart: shiftCompassDate(asOfDate, -30),
    periodEnd: shiftCompassDate(asOfDate, -1),
    products: products.map((p, i) => ({
      ...p,
      publicRank: null,
      salesCount: i,
    })),
  };
  await ok(endpoint + "/imports", "POST", actual);
  const sales = (await ok(endpoint + `?brandIds=${own.id}&source=SALES_REPORT`))
    .results[0];
  assert.equal(sales.top20[0].salesCount, 24);
  assert.equal(sales.salesCount, 300);
  assert.equal(
    (await ok(endpoint + `?brandIds=${own.id}`)).results[0].salesCount,
    null,
    "independent sources must never mix counts and ranks",
  );
  assert.equal(
    (await request(endpoint + "?source=PUBLIC_RANK&sort=sales")).status,
    400,
  );
  assert.equal(
    (
      await request(endpoint + "/imports", "POST", {
        ...actual,
        periodEnd: null,
      })
    ).status,
    400,
  );
  await ok(endpoint + "/imports", "POST", {
    ...rank,
    brandId: rival.id,
    brandName: rival.name,
    sourceUrl: rival.searchUrl,
    asOfDate: shiftCompassDate(asOfDate, -1),
  });
  assert.equal(
    (await ok(endpoint + `?brandIds=${own.id},${rival.id}`)).alignedPeriod,
    false,
  );
  assert.equal(
    (await ok(endpoint + `?brandIds=${own.id},${own.id}`)).results.length,
    1,
  );
  assert.ok(
    (await ok("/help")).some(
      (chapter: any) => chapter.id === "33-competitor-analysis.md",
    ),
  );
  check(
    "Competitor authorized imports, precise IDs, separate ranking/sales, TOP20, filters, retained details and date alignment",
  );
}

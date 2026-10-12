import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { shanghaiDate } from "../../packages/contracts/src/compass-analytics.js";
import { vipSearchUrl } from "../../packages/contracts/src/competitor-analysis.js";

export async function testCompetitorShares(h: Record<string, any>) {
  const { ok, request, db, one, buyer, check } = h;
  const base = "/analytics/competitors",
    endpoint = base + "/shares";
  const brand = {
    ...(await ok(base + "/brands", "POST", {
      name: "分享范围测试品牌",
      brandSn: "908001",
    })),
    name: "分享范围测试品牌",
  };
  const other = {
    ...(await ok(base + "/brands", "POST", {
      name: "未分享的品牌",
      brandSn: "908002",
    })),
    name: "未分享的品牌",
  };
  brand.id = String(brand.id);
  other.id = String(other.id);
  const products = Array.from({ length: 3 }, (_, i) => ({
    productId: String(6000000 + i),
    productUrl: `https://detail.vip.com/detail-1-${6000000 + i}.html`,
    title: i === 2 ? "不包含的商品" : "允许查看桑蚕丝连衣裙",
    styleCode: `SHARE-${i}`,
    imageUrl: "https://h2.appsimg.com/test.jpg",
    publicRank: i + 1,
    salePrice: 600 + i * 50,
    category: "连衣裙",
    materialInfo: "桑蚕丝100%",
    materialTags: ["桑蚕丝"],
    seasons: ["夏"],
  }));
  const upload = (b: any, items: any[]) =>
    ok(base + "/imports", "POST", {
      brandId: b.id,
      brandName: b.name,
      source: "PUBLIC_RANK",
      asOfDate: shanghaiDate(),
      scope: "分享测试样本",
      sourceUrl: vipSearchUrl(b.name, b.id === brand.id ? "908001" : "908002"),
      products: items,
    });
  await upload(brand, products);
  await upload(other, products);
  const body = {
    brandIds: [brand.id],
    days: 7,
    filters: {
      keyword: "允许",
      category: "连衣裙",
      material: "桑蚕丝",
      season: "夏",
      priceBand: "500to1000",
      sort: "priceDesc",
    },
  };
  const key = randomUUID(),
    share = await ok(endpoint, "POST", body, key);
  assert.deepEqual(await ok(endpoint, "POST", body, key), share);
  const token = share.path.split("/").at(-1),
    path = "/public/competitor-shares/" + token;
  const anonymous = { cookie: "", csrf: "" };
  const view = async (suffix = "") =>
    await request(path + suffix, "GET", undefined, undefined, anonymous);
  const first = await view();
  assert.equal(first.status, 200);
  const data = first.body.data;
  assert.deepEqual(
    data.brands.map((b: any) => b.id),
    [brand.id],
  );
  assert.equal(data.results[0].total, 2);
  assert.deepEqual(
    data.results[0].top20.map((p: any) => p.styleCode),
    ["SHARE-1", "SHARE-0"],
  );
  for (const forbidden of ["crawl", "options", "createdBy", "tokenHash"])
    assert.equal(forbidden in data, false);
  assert.equal(JSON.stringify(data).includes(other.name), false);
  assert.equal(JSON.stringify(data).includes("不包含的商品"), false);
  assert.equal(data.results[0].snapshot.products, undefined);
  assert.deepEqual(
    (await view(`?brandIds=${other.id}&keyword=&source=SALES_REPORT`)).body
      .data,
    data,
    "URL parameters cannot expand the stored share scope",
  );
  const saved = await one(
    db,
    "SELECT token_hash FROM competitor_shares WHERE id=$1::bigint",
    share.id,
  );
  assert.notEqual(saved.token_hash, token);
  assert.match(saved.token_hash, /^[a-f0-9]{64}$/);
  const audit = await one(
    db,
    "SELECT after_data FROM audit_logs WHERE action='competitor.share.create' AND entity_id=$1::bigint",
    share.id,
  );
  assert.equal(JSON.stringify(audit).includes(token), false);
  await upload(
    brand,
    products.map((p) => ({
      ...p,
      salePrice: p.salePrice + 10,
      materialInfo: "桑蚕丝95% 氨纶5%",
    })),
  );
  const latest = (await view()).body.data;
  assert.equal(latest.results[0].top20[0].salePrice, 660);
  assert.equal(
    latest.results[0].top20[0].materialInfo,
    "桑蚕丝95% 氨纶5%",
    "shares use live latest data",
  );
  assert.deepEqual(latest.share.filters, body.filters);
  const history = await ok(endpoint);
  assert.deepEqual(history[0].brandNames, [brand.name]);
  for (const forbidden of ["token", "tokenHash", "path", "createdBy"])
    assert.equal(forbidden in history[0], false);
  for (const method of ["GET", "POST"]) {
    assert.equal(
      (
        await request(
          endpoint,
          method,
          method === "POST" ? body : undefined,
          undefined,
          anonymous,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await request(
          endpoint,
          method,
          method === "POST" ? body : undefined,
          undefined,
          buyer,
        )
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await request(
        endpoint + `/${share.id}/revoke`,
        "POST",
        {},
        undefined,
        anonymous,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request(
        endpoint + `/${share.id}/revoke`,
        "POST",
        {},
        undefined,
        buyer,
      )
    ).status,
    403,
  );
  // A manager cannot revoke another manager's link; super admin retains incident recovery access.
  const role = (await ok("/roles")).find((r: any) => r.code === "BUYER");
  await db.$executeRawUnsafe(
    "INSERT INTO role_permissions(role_id,permission_id) SELECT $1::bigint,id FROM permissions WHERE code='analytics.manage' ON CONFLICT DO NOTHING",
    role.id,
  );
  assert.equal(
    (
      await request(
        endpoint + `/${share.id}/revoke`,
        "POST",
        {},
        undefined,
        buyer,
      )
    ).status,
    404,
  );
  assert.deepEqual(
    (await request(endpoint, "GET", undefined, undefined, buyer)).body.data,
    [],
  );
  await db.$executeRawUnsafe(
    "DELETE FROM role_permissions WHERE role_id=$1::bigint AND permission_id=(SELECT id FROM permissions WHERE code='analytics.manage')",
    role.id,
  );
  for (const invalid of [
    { ...body, brandIds: [] },
    { ...body, brandIds: [brand.id, brand.id] },
    { ...body, brandIds: ["999999999"] },
    { ...body, days: 365 },
    { ...body, filters: { source: "SALES_REPORT" } },
    { ...body, filters: { sort: "sales" } },
  ])
    assert.equal((await request(endpoint, "POST", invalid)).status, 400);
  const expired = await ok(endpoint, "POST", { ...body, days: 1 });
  await db.$executeRawUnsafe(
    "UPDATE competitor_shares SET expires_at=now()-interval '1 second' WHERE id=$1::bigint",
    expired.id,
  );
  assert.equal(
    (
      await request(
        "/public/competitor-shares/" + expired.path.split("/").at(-1),
        "GET",
        undefined,
        undefined,
        anonymous,
      )
    ).status,
    404,
  );
  await ok(endpoint + `/${share.id}/revoke`, "POST", {});
  assert.equal((await view()).status, 404);
  await ok(endpoint + `/${share.id}/revoke`, "POST", {});
  assert.equal(
    (
      await request(
        "/public/competitor-shares/invalid",
        "GET",
        undefined,
        undefined,
        anonymous,
      )
    ).status,
    404,
  );
  check(
    "Live competitor shares: fixed scope, latest data, anonymous read only, permissions, hashed tokens, expiry and revocation",
  );
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { vipSearchUrl } from "../../packages/contracts/src/competitor-analysis.js";

export async function testCompetitorBrandBinding(h: Record<string, any>) {
  const { ok, request, buyer, check } = h;
  const base = "/analytics/competitors";
  const name = "待绑定测试品牌";
  const added = await ok(base + "/brands", "POST", { name });
  const endpoint = `${base}/brands/${added.id}/binding`;
  const sourceUrl = `https://category.vip.com/suggest.php?keyword=${encodeURIComponent(name)}&brand_sn=12345678`;
  const input = { sourceUrl };
  assert.equal(
    (await request(endpoint, "POST", input, undefined, buyer)).status,
    403,
  );
  for (const url of [
    "https://example.com/suggest.php?keyword=brand&brand_sn=12345678",
    vipSearchUrl(name),
    vipSearchUrl("其他品牌", "12345678"),
    sourceUrl + "&brand_sn=12345679",
    sourceUrl.replace("12345678", "12345678,12345679"),
    sourceUrl.replace("category.vip.com", "category.vip.com.evil.test"),
  ])
    assert.equal(
      (await request(endpoint, "POST", { sourceUrl: url })).status,
      400,
    );
  assert.equal(
    (await request(`${base}/brands/999999999/binding`, "POST", input)).status,
    404,
  );
  const before = (await ok(base + `?brandIds=${added.id}`)).brands.find(
    (b: any) => b.id === added.id,
  );
  assert.equal(before.brandSn, null);
  const key = randomUUID();
  const saved = await ok(endpoint, "POST", input, key);
  assert.equal(saved.brandSn, "12345678");
  assert.equal(saved.searchUrl, vipSearchUrl(name, "12345678"));
  assert.deepEqual(await ok(endpoint, "POST", input, key), saved);
  assert.deepEqual(await ok(endpoint, "POST", input), saved);
  const dashboard = await ok(base + `?brandIds=${added.id}`);
  assert.equal(
    dashboard.brands.find((b: any) => b.id === added.id).brandSn,
    "12345678",
  );
  assert.equal(
    dashboard.results[0].snapshot,
    null,
    "binding does not create a snapshot or start a crawl",
  );
  assert.equal(
    (
      await request(endpoint, "POST", {
        sourceUrl: sourceUrl.replace("12345678", "12345679"),
      })
    ).status,
    409,
  );
  const otherName = "重复品牌ID测试";
  const other = await ok(base + "/brands", "POST", { name: otherName });
  assert.equal(
    (
      await request(`${base}/brands/${other.id}/binding`, "POST", {
        sourceUrl: vipSearchUrl(otherName, "12345678"),
      })
    ).status,
    409,
  );
  const results = await Promise.all(
    ["12345679", "12345680"].map((id) =>
      request(`${base}/brands/${other.id}/binding`, "POST", {
        sourceUrl: vipSearchUrl(otherName, id),
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  check(
    "Official brand binding permissions, precise links, shared persistence, retry and concurrent conflict protection",
  );
}

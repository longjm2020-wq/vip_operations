import { test, expect } from "@playwright/test";
import { captureVipPage } from "../../packages/contracts/src/competitor-capture.js";
import { vipSearchUrl } from "../../packages/contracts/src/competitor-analysis.js";
import { crawlPublicBrand } from "../../apps/worker/src/competitor-crawler.js";

const ids = ["6921659409327812229", "6921659409327812230"];
const detailUrl = (id: string) =>
  `https://detail.vip.com/detail-1714040133-${id}.html`;
const list = ids
  .map(
    (id, i) =>
      `<a href="${detailUrl(id)}"><div class="c-goods-item__name">序缇羊绒衫${i}</div><img class="J-goods-item__img" data-original="https://h2.appsimg.com/a.appsimg.com/test.jpg"><span class="J-goods-item__sale-price">${500 + i * 100}</span><span class="J-goods-item__market-price">1200</span></a>`,
  )
  .join("");
const detail =
  '<div class="J_brandName">序缇/XUTI</div><div class="pib-title-detail">羊绒桑蚕丝针织衫</div><div id="J_detail_barCode">商品编码：CT-001</div><table><tr><td class="dc-table-tit">详细材质信息：</td><td>【面料】羊绒70% 桑蚕丝30%</td></tr><tr><td class="dc-table-tit">主款式：</td><td>针织衫</td></tr><tr><td class="dc-table-tit">适用季节：</td><td>春秋</td></tr></table>';
test("后台DOM采集保留精确商品ID和已核对详情，验证页停止", async ({ page }) => {
  test.setTimeout(45000);
  await page.route("https://**.vip.com/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: route.request().url().includes("category.vip.com")
        ? list
        : route.request().url().includes(ids[0])
          ? detail
          : '<input placeholder="验证码"><p>请输入验证码</p>',
    }),
  );
  const saved: any[] = [],
    details: any[] = [];
  await expect(
    crawlPublicBrand(
      page,
      { id: "1", name: "序缇", brandSn: "10204477" },
      {
        list: async (data) => {
          saved.push(data);
        },
        detail: async (products) => {
          details.push(...products);
        },
      },
    ),
  ).rejects.toMatchObject({ verification: true });
  expect(saved[0].products.map((p: any) => p.productId)).toEqual(ids);
  expect(saved[0].products.map((p: any) => p.publicRank)).toEqual([1, 2]);
  expect(saved[0].products[0].salesCount).toBeNull();
  expect(details).toHaveLength(1);
  expect(details[0].materialInfo).toBe("【面料】羊绒70% 桑蚕丝30%");
  expect(details[0].seasons).toEqual(["春", "秋"]);
  // The worker and optional browser bookmark use the same self-contained
  // public-page collector; no cookies or hidden application data are required.
  await page.goto(vipSearchUrl("序缇", "10204477"));
  const captured = await page.evaluate(captureVipPage, {
    href: page.url(),
    observedAt: new Date().toISOString(),
  });
  expect(captured.kind).toBe("LIST");
  expect(captured.products[0].productId).toBe(ids[0]);
});

test("详情跳转到其他商品时不写入错误材质，并继续核对后续商品", async ({
  page,
}) => {
  test.setTimeout(30000);
  const redirectedId = "6921659409327812999";
  await page.route("https://**.vip.com/**", async (route) => {
    const url = route.request().url();
    if (url.includes("category.vip.com"))
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: list,
      });
    else if (url.includes(ids[0]))
      await route.fulfill({
        status: 302,
        headers: { Location: detailUrl(redirectedId) },
      });
    else
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: detail,
      });
  });
  const details: any[] = [];
  await expect(
    crawlPublicBrand(
      page,
      { id: "1", name: "序缇", brandSn: "10204477" },
      {
        list: async () => {},
        detail: async (products) => {
          details.push(...products);
        },
      },
    ),
  ).rejects.toMatchObject({ verification: false });
  expect(details.map((product) => product.productId)).toEqual([ids[1]]);
  expect(details[0].materialInfo).toContain("羊绒70%");
});

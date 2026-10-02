import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { shanghaiDate } from "../../packages/contracts/src/compass-analytics.js";

test("竞品单品牌TOP20、详细材质、商品预览及后台队列设置", async ({ page }) => {
  await page.route("https://h2.appsimg.com/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#ead9cd"/></svg>',
    }),
  );
  await page.goto("/analytics/competitors");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "竞品分析", exact: true }),
  ).toBeVisible();
  await page.goto("/operations");
  await page
    .locator(".operations-workspace")
    .getByRole("tab", { name: "唯品会", exact: true })
    .click();
  await page.getByRole("link", { name: "竞品分析", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "竞品分析", exact: true }),
  ).toBeVisible();
  const me = (await (await page.request.get("/api/v1/auth/me")).json()).data;
  const dashboard = (
    await (await page.request.get("/api/v1/analytics/competitors")).json()
  ).data;
  const own = dashboard.brands[0];
  const products = Array.from({ length: 23 }, (_, i) => ({
    productId: String(6921659409327812000n + BigInt(i)),
    title: `界面测试羊绒衫${i + 1}`,
    productUrl: `https://detail.vip.com/detail-1714040133-${6921659409327812000n + BigInt(i)}.html`,
    imageUrl: "https://h2.appsimg.com/a.appsimg.com/test.jpg",
    salePrice: 500 + i,
    publicRank: i + 1,
    styleCode: `UI-CT-${i + 1}`,
    materialInfo: "【面料】羊绒70% 桑蚕丝30%",
    seasons: ["秋"],
    detailVerified: true,
    detailObservedAt: new Date().toISOString(),
  }));
  const imported = await page.request.post(
    "/api/v1/analytics/competitors/imports",
    {
      headers: {
        "X-CSRF-Token": me.csrfToken,
        "Idempotency-Key": randomUUID(),
        Origin: "http://127.0.0.1:5174",
      },
      data: {
        brandId: own.id,
        brandName: own.name,
        source: "PUBLIC_RANK",
        sourceUrl: own.searchUrl,
        asOfDate: shanghaiDate(),
        scope: "仅用于自动化测试的23款样本",
        products,
      },
    },
  );
  expect(imported.status()).toBe(201);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(
    page.locator(".competitor-page .ant-table-body .ant-table-row"),
  ).toHaveCount(20);
  await expect(page.locator(".competitor-material").first()).toContainText(
    "羊绒70% 桑蚕丝30%",
  );
  await page.locator(".competitor-photo").first().hover();
  await expect(page.locator(".competitor-photo-hover").first()).toHaveCSS(
    "width",
    "120px",
  );
  await expect(page.locator(".competitor-photo").first()).toHaveAttribute(
    "href",
    products[0].productUrl,
  );
  await page
    .locator(".competitor-page .ant-segmented-item")
    .filter({ hasText: "单品牌对比" })
    .click();
  await expect(page.locator(".competitor-page .ant-tabs-tab")).toHaveCount(2);
  await page.getByRole("button", { name: "更新竞品数据", exact: true }).click();
  await expect(
    page.getByText("后台采集已排队，可继续使用页面", { exact: true }),
  ).toBeVisible();
  await page.locator(".competitor-crawl-status summary").click();
  await expect(page.locator(".competitor-crawl-jobs")).toContainText("待采集");
  await page.getByRole("button", { name: "采集设置", exact: true }).click();
  const settings = page.getByRole("dialog", {
    name: "后台采集设置",
    exact: true,
  });
  await settings
    .getByRole("switch", { name: "自动采集", exact: true })
    .uncheck();
  await settings.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(
    page.getByText("后台自动采集已暂停", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("后台自动采集已暂停", { exact: true }),
  ).toBeVisible();
});

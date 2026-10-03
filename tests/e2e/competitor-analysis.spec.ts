import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { shanghaiDate } from "../../packages/contracts/src/compass-analytics.js";

test("竞品单品牌TOP20、详细材质、商品预览及后台队列设置", async ({
  page,
  context,
}) => {
  await context.route("https://detail.vip.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>商品详情测试页</h1>",
    }),
  );
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
    materialInfo:
      "【烟雨蓝的面料】羊绒70% 桑蚕丝30%\n【烟雨蓝的里料】聚酯纤维100%",
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
  const competitor = dashboard.brands.find(
    (brand: { isOwn: boolean }) => !brand.isOwn,
  );
  const competitorImport = await page.request.post(
    "/api/v1/analytics/competitors/imports",
    {
      headers: {
        "X-CSRF-Token": me.csrfToken,
        "Idempotency-Key": randomUUID(),
        Origin: "http://127.0.0.1:5174",
      },
      data: {
        brandId: competitor.id,
        brandName: competitor.name,
        source: "PUBLIC_RANK",
        sourceUrl: competitor.searchUrl,
        asOfDate: shanghaiDate(),
        scope: "仅用于自动化测试的23款竞品样本",
        products,
      },
    },
  );
  expect(competitorImport.status()).toBe(201);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(
    page.locator(".competitor-page .ant-table-body .ant-table-row"),
  ).toHaveCount(20);
  await expect(page.locator(".competitor-material").first()).toContainText(
    "羊绒70% 桑蚕丝30%",
  );
  await expect(
    page.getByRole("combobox", { name: "竞品数据口径" }),
  ).toHaveCount(0);
  await expect(page.getByText("实际销量报表", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "导入数据", exact: true }).click();
  const importDialog = page.getByRole("dialog", { name: "导入竞品数据" });
  await expect(importDialog.getByLabel("选择竞品数据文件")).toHaveAttribute(
    "accept",
    ".json",
  );
  await expect(
    importDialog.getByRole("button", { name: "下载销量模板" }),
  ).toHaveCount(0);
  await importDialog
    .locator(".ant-modal-footer")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.locator(".competitor-photo button").first().hover();
  await expect(page.locator(".compass-product-image-hover:visible")).toHaveCSS(
    "width",
    "120px",
  );
  await expect(page.locator(".competitor-product a").first()).toHaveAttribute(
    "href",
    products[0].productUrl,
  );
  await page.locator(".competitor-photo button").first().click();
  await expect(page.locator(".competitor-product-preview-image")).toBeVisible();
  const productPreview = page.getByRole("dialog", { name: "商品预览" });
  await expect(productPreview).toContainText("款号：UI-CT-1");
  await expect(
    productPreview.locator(".competitor-product-preview-price"),
  ).toContainText("¥ 500");
  await expect(
    productPreview.locator(".competitor-product-preview-material"),
  ).toHaveText("【面料】羊绒70% 桑蚕丝30%\n【里料】聚酯纤维100%");
  await expect(productPreview).not.toContainText("烟雨蓝");
  await page.keyboard.press("Escape");
  await expect(page.locator(".competitor-product-preview-root")).toHaveCount(0);
  for (const title of ["品类分布", "特卖价区间", "材质分布", "季节分布"]) {
    const chart = page
      .locator(".competitor-distribution")
      .filter({ has: page.getByText(title, { exact: true }) });
    await expect(chart.locator(".ant-card-head-title")).toHaveText(title);
    const bar = chart.locator(".competitor-bar-row:enabled").first();
    const bucketName = (await bar.getAttribute("aria-label"))!
      .split(" · ")[1]
      .split("，")[0];
    await bar.hover();
    // Wait for this bar's content rather than the previous popup's exit motion.
    const popup = page.locator(".competitor-bar-popover:visible").filter({
      has: page.getByText(`${own.name} · ${bucketName} · 前10款`, {
        exact: true,
      }),
    });
    await expect(popup.locator(".competitor-bar-products a")).toHaveCount(10);
    await expect(popup.locator(".competitor-bar-products img")).toHaveCount(10);
    await expect(popup.locator(".competitor-bar-material")).toHaveCount(0);
    await expect(popup.locator(".competitor-bar-products button")).toHaveCount(
      10,
    );
    await expect(popup).not.toHaveClass(/ant-zoom-big-(enter|appear|leave)/);
    const tabsBeforePreview = context.pages().length;
    await popup
      .getByRole("button", { name: "放大图片 UI-CT-1", exact: true })
      .click();
    await expect(productPreview).toBeVisible();
    await expect(
      productPreview.locator(".competitor-product-preview-material"),
    ).toHaveText("【面料】羊绒70% 桑蚕丝30%\n【里料】聚酯纤维100%");
    expect(context.pages()).toHaveLength(tabsBeforePreview);
    await page.keyboard.press("Escape");
    await expect(page.locator(".competitor-product-preview-root")).toHaveCount(
      0,
    );
    await bar.hover();
    await expect(popup).toBeVisible();
    // The popup stays open when the pointer moves from the bar to a product.
    await popup.locator(".competitor-bar-products a").first().hover();
    await expect(popup).toBeVisible();
    await expect(
      popup.locator(".competitor-bar-products a").first(),
    ).toHaveAttribute("href", products[0].productUrl);
    await expect(
      popup.locator(".competitor-bar-products a").first(),
    ).toHaveAttribute("target", "_blank");
    const newTab = page.waitForEvent("popup");
    await popup.locator(".competitor-bar-products a").first().click();
    const detail = await newTab;
    await expect(detail).toHaveURL(products[0].productUrl);
    await detail.close();
  }
  await page.mouse.move(0, 0);
  await expect(page.locator(".competitor-bar-popover:visible")).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 812 });
  const mobileBar = page
    .locator(".competitor-distribution")
    .first()
    .locator(".competitor-bar-row:enabled")
    .first();
  await mobileBar.press("Enter");
  const mobilePopup = page.locator(".competitor-bar-popover:visible");
  await expect(mobilePopup.locator(".competitor-bar-products a")).toHaveCount(
    10,
  );
  const popupBox = (await mobilePopup.boundingBox())!;
  expect(popupBox.x).toBeGreaterThanOrEqual(0);
  expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(375);
  await mobileBar.press("Enter");
  await page.mouse.move(0, 0);
  await expect(mobilePopup).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 760 });
  await page.getByRole("tab", { name: competitor.name, exact: true }).click();
  const top20 = page.locator(".competitor-page > .ant-card").filter({
    has: page.getByText("商品 TOP20", { exact: true }),
  });
  await top20.evaluate((element) => {
    const header = document.querySelector(".topbar")!.getBoundingClientRect();
    window.scrollTo({
      top:
        window.scrollY +
        element.getBoundingClientRect().top -
        header.bottom -
        12,
      behavior: "instant",
    });
  });
  const body = top20.locator(".ant-table-body");
  const head = top20.locator(".ant-table-header");
  const bodyBox = (await body.boundingBox())!;
  await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + 80);
  await page.mouse.wheel(0, 200);
  await expect
    .poll(() => body.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  const anchor = await page.evaluate(() => window.scrollY);
  const panelTop = (await top20.boundingBox())!.y;
  const headerTop = (await head.boundingBox())!.y;
  const bodyOffset = await body.evaluate((element) => element.scrollTop);
  expect(panelTop).toBeGreaterThanOrEqual(48);
  expect(panelTop).toBeLessThanOrEqual(62);
  // Slow uncached queries expose a disappearing panel and browser scroll clamping.
  await page.route("**/api/v1/analytics/competitors?**", async (route) => {
    if (new URL(route.request().url()).searchParams.has("sort"))
      await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fallback();
  });
  for (const [sort, label, firstCode] of [
    ["priceDesc", "特卖价从高到低", "UI-CT-23"],
    ["priceAsc", "特卖价从低到高", "UI-CT-1"],
    ["rank", "公开销量排名", "UI-CT-1"],
  ]) {
    const response = page.waitForResponse(
      (result) => new URL(result.url()).searchParams.get("sort") === sort,
    );
    await top20
      .getByRole("combobox", { name: "TOP20排序指标", exact: true })
      .click();
    await page
      .locator(".ant-select-dropdown:visible")
      .getByText(label, { exact: true })
      .click();
    await expect(top20.locator(".ant-spin-spinning")).toBeVisible();
    await expect(
      top20.getByRole("button", { name: "导出TOP20", exact: true }),
    ).toBeDisabled();
    expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(anchor, 0);
    expect((await top20.boundingBox())!.y).toBeCloseTo(panelTop, 0);
    expect((await head.boundingBox())!.y).toBeCloseTo(headerTop, 0);
    expect(await body.evaluate((element) => element.scrollTop)).toBeCloseTo(
      bodyOffset,
      0,
    );
    await response;
    await expect(top20.locator(".ant-spin-spinning")).toHaveCount(0);
    await expect(body.locator(".ant-table-row").first()).toContainText(
      firstCode,
    );
    await expect(
      top20.getByRole("tab", { name: competitor.name, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(anchor, 0);
    expect((await top20.boundingBox())!.y).toBeCloseTo(panelTop, 0);
    expect((await head.boundingBox())!.y).toBeCloseTo(headerTop, 0);
    expect(await body.evaluate((element) => element.scrollTop)).toBeCloseTo(
      bodyOffset,
      0,
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
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

import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { shanghaiDate } from "../../packages/contracts/src/compass-analytics.js";

test("竞品分享免登录、固定范围、同步最新数据，关闭后清除商品和预览", async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  await page.goto("/analytics/competitors");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "竞品分析", exact: true }),
  ).toBeVisible();
  const me = (await (await page.request.get("/api/v1/auth/me")).json()).data;
  const dashboard = (
    await (await page.request.get("/api/v1/analytics/competitors")).json()
  ).data;
  const own = dashboard.brands[0],
    rival = dashboard.brands[1],
    excluded = dashboard.brands[2];
  const products = Array.from({ length: 3 }, (_, i) => ({
    productId: String(6999900 + i),
    productUrl: `https://detail.vip.com/detail-1-${6999900 + i}.html`,
    title: i === 2 ? "筛选外商品" : "允许查看的连衣裙",
    styleCode: `PUBLIC-${i}`,
    imageUrl: "https://h2.appsimg.com/share-test.jpg",
    publicRank: i + 1,
    salePrice: 600 + i * 50,
    materialInfo: "桑蚕丝100%",
    seasons: ["夏"],
    detailVerified: true,
    detailObservedAt: new Date().toISOString(),
  }));
  const upload = async (delta = 0) => {
    const response = await page.request.post(
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
          scope: "自动化测试商品样本",
          products: products.map((p) => ({
            ...p,
            salePrice: p.salePrice + delta,
          })),
        },
      },
    );
    expect(response.status()).toBe(201);
  };
  await upload();
  await page
    .locator(".competitor-page .ant-segmented-item")
    .filter({ hasText: "单品牌对比" })
    .click();
  await page.getByRole("textbox", { name: "搜索竞品商品" }).fill("允许");
  await page.getByRole("combobox", { name: "TOP20排序指标" }).click();
  await page.getByText("特卖价从高到低", { exact: true }).click();
  await expect(page.locator(".competitor-top20 .ant-table-row")).toHaveCount(2);
  await page.getByRole("button", { name: "分享", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "分享竞品分析",
    exact: true,
  });
  await expect(dialog).toContainText(`本次品牌：${own.name}、${rival.name}`);
  await expect(dialog).toContainText("关键词：允许");
  await expect(dialog).not.toContainText(excluded.name);
  await dialog
    .getByRole("button", { name: "创建分享链接", exact: true })
    .click();
  const link = dialog.getByRole("textbox", { name: "外部分享链接" });
  await expect(link).toHaveValue(/\/share\/competitors\/[a-f0-9]{64}$/);
  const url = await link.inputValue();
  const anon = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  try {
    await anon.route("https://h2.appsimg.com/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="260"><rect width="200" height="260" fill="#d8c5b7"/></svg>',
      }),
    );
    const viewer = await anon.newPage(),
      apiRequests: string[] = [];
    viewer.on("request", (req) => {
      if (req.url().includes("/api/v1/"))
        apiRequests.push(new URL(req.url()).pathname);
    });
    await viewer.clock.install();
    await viewer.goto(url);
    await expect(
      viewer.getByText("竞品分析 · 只读分享", { exact: true }),
    ).toBeVisible();
    await expect(viewer.locator(".competitor-shared-scope")).toContainText(
      `分享品牌：${own.name}、${rival.name}`,
    );
    await expect(
      viewer.locator(".competitor-top20 .ant-table-row"),
    ).toHaveCount(2);
    await expect(
      viewer.locator(".competitor-top20 .ant-table-row").first(),
    ).toContainText("PUBLIC-1");
    await expect(viewer.locator("body")).not.toContainText("筛选外商品");
    await expect(viewer.locator("body")).not.toContainText(excluded.name);
    for (const name of [
      "分享",
      "更新竞品数据",
      "采集设置",
      "导入数据",
      "新增品牌",
      "导出TOP20",
      "进入工作台",
    ])
      await expect(
        viewer.getByRole("button", { name, exact: true }),
      ).toHaveCount(0);
    await expect(
      viewer.getByRole("combobox", { name: "TOP20排序指标" }),
    ).toBeDisabled();
    const publicApi = await anon.request.get(
      url.replace("/share/competitors/", "/api/v1/public/competitor-shares/"),
    );
    expect(publicApi.headers()["cache-control"]).toContain("no-store");
    expect(publicApi.headers()["referrer-policy"]).toBe("no-referrer");
    expect(publicApi.headers()["x-robots-tag"]).toContain("noindex");
    await upload(11);
    await viewer.clock.fastForward(31000);
    await expect(
      viewer.locator(".competitor-top20 .ant-table-row").first(),
    ).toContainText("¥ 661");
    const bar = viewer
      .locator(".competitor-distribution")
      .first()
      .locator(".competitor-bar-row:enabled")
      .first();
    await bar.press("Enter");
    await expect(
      viewer.locator(
        ".competitor-bar-popover:visible .competitor-bar-products a",
      ),
    ).toHaveCount(2);
    await bar.press("Enter");
    await viewer.mouse.move(0, 0);
    await viewer.setViewportSize({ width: 375, height: 812 });
    await expect
      .poll(() =>
        viewer.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await viewer.screenshot({
      path: ".local/competitor-share-mobile-test.png",
      fullPage: true,
    });
    await viewer.setViewportSize({ width: 1440, height: 1000 });
    await viewer.locator(".competitor-photo button").first().click();
    await expect(
      viewer.getByRole("dialog", { name: "商品预览" }),
    ).toContainText("PUBLIC-1");
    await dialog
      .locator(".compass-share-history")
      .getByRole("button", { name: "关闭分享", exact: true })
      .first()
      .click();
    await page
      .locator(".ant-popconfirm")
      .getByRole("button", { name: "关闭分享", exact: true })
      .click();
    await expect(
      dialog
        .locator(".compass-share-history")
        .getByText("已关闭", { exact: true })
        .first(),
    ).toBeVisible();
    await viewer.clock.fastForward(31000);
    await expect(
      viewer.getByText("分享链接不存在、已过期或已关闭", { exact: true }),
    ).toBeVisible();
    await expect(viewer.locator(".competitor-top20")).toHaveCount(0);
    await expect(viewer.getByRole("dialog", { name: "商品预览" })).toHaveCount(
      0,
    );
    expect(apiRequests.length).toBeGreaterThanOrEqual(3);
    expect(
      apiRequests.every((path) =>
        path.startsWith("/api/v1/public/competitor-shares/"),
      ),
    ).toBe(true);
    expect(await anon.cookies()).toEqual([]);
    await viewer.goto(url.replace(/[a-f0-9]{64}$/, "invalid"));
    await expect(
      viewer.getByText("分享链接不存在、已过期或已关闭", { exact: true }),
    ).toBeVisible();
  } finally {
    await anon.close();
  }
});

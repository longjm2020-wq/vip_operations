import { test, expect, type Page } from "@playwright/test";
import {
  analyzeCompetitor,
  vipSearchUrl,
} from "../../packages/contracts/src/competitor-analysis.js";

async function fixture(page: Page) {
  const brands = [
    "序缇",
    "帕罗",
    "米皇",
    "笑涵阁",
    "生活在左",
    "金菊",
    "南宋丝府",
  ].map((name, i) => ({
    id: String(i + 1),
    name,
    isOwn: i === 0,
    brandSn: String(100 + i),
    searchUrl: vipSearchUrl(name, String(100 + i)),
  }));
  const states = [
    "FAILED",
    "LOGIN_REQUIRED",
    "RUNNING",
    "PARTIAL",
    "VERIFICATION_REQUIRED",
    "READY",
  ];
  const jobs = states.map((status, i) => ({
    id: String(i + 1),
    brandId: brands[i].id,
    status,
    requestedAt: "2026-10-05T00:00:00Z",
    startedAt: "2026-10-05T00:00:01Z",
    completedAt: status === "RUNNING" ? null : "2026-10-05T00:01:00Z",
    capturedCount: i < 2 ? 0 : i === 5 ? 20 : 50,
    detailCount: i < 2 ? 0 : i === 5 ? 20 : 15,
    note:
      status === "LOGIN_REQUIRED"
        ? "唯品会要求登录，保留上次数据"
        : status === "FAILED"
          ? "没有返回有效商品数据，保留上次数据"
          : "",
  }));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith("/auth/me")
      ? {
          id: "1",
          displayName: "测试用户",
          permissions: ["analytics.read", "analytics.manage"],
          roleCodes: ["ADMIN"],
          csrfToken: "test",
        }
      : path.endsWith("/analytics/competitors")
        ? {
            crawl: {
              settings: { enabled: true, dailyHour: 8, version: 1 },
              jobs,
            },
            source: "PUBLIC_RANK",
            brands,
            alignedPeriod: true,
            options: { categories: [], materials: [], seasons: [] },
            results: brands.map((brand) =>
              analyzeCompetitor(brand, undefined, {}),
            ),
          }
        : [];
    await route.fulfill({ json: { data, requestId: "test" } });
  });
}
test("every brand card shows real collection progress including failures and unstarted brands", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/analytics/competitors");
  await page.getByText("采集状态", { exact: true }).click();
  await expect(page.getByRole("progressbar")).toHaveCount(7);
  await expect(
    page.getByRole("progressbar", { name: "序缇采集进度" }),
  ).toHaveAttribute("aria-valuenow", "0");
  await expect(
    page.getByRole("progressbar", { name: "米皇采集进度" }),
  ).toHaveAttribute("aria-valuenow", "65");
  await expect(
    page.getByRole("progressbar", { name: "金菊采集进度" }),
  ).toHaveAttribute("aria-valuenow", "100");
  await expect(
    page.getByRole("progressbar", { name: "南宋丝府采集进度" }),
  ).toHaveAttribute("aria-valuenow", "0");
  await expect(
    page.locator(".competitor-crawl-job").filter({ hasText: "帕罗" }),
  ).toContainText("需要登录");
  await expect(
    page.locator(".competitor-crawl-job").filter({ hasText: "米皇" }),
  ).toContainText("详情 15 / 50 款");
  await expect(
    page.locator(".competitor-crawl-job").filter({ hasText: "金菊" }),
  ).toContainText("详情 20 / 20 款");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("progressbar", { name: "南宋丝府采集进度" }),
  ).toBeVisible();
});
test("login opens a local VIP popup and accepts only that official window's login check", async ({
  page,
  context,
}) => {
  await fixture(page);
  await context.route("https://category.vip.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<a href="//myi.vip.com/index.html">已登录测试账号</a><p>品牌销量页</p>',
    }),
  );
  await page.goto("/analytics/competitors");
  await expect(
    page.getByText("唯品会 · 本机登录待核验", { exact: true }),
  ).toBeVisible();
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "登录唯品会", exact: true }).click();
  const popup = await opened;
  await expect(
    page.getByRole("dialog", { name: "唯品会本机登录" }),
  ).toBeVisible();
  expect(popup.url()).toMatch(/^https:\/\/category.vip.com\//);
  await page.evaluate(() =>
    window.postMessage(
      { kind: "XUTI_VIP_BROWSER_LOGIN", status: "LOGGED_IN" },
      window.location.origin,
    ),
  );
  await expect(
    page.getByText("唯品会 · 本机登录待核验", { exact: true }),
  ).toBeVisible();
  const bookmark = await page
    .getByRole("link", { name: "核验登录并采集商品", exact: true })
    .getAttribute("href");
  expect(bookmark).toContain("postMessage");
  popup.on("dialog", (dialog) => dialog.dismiss());
  await popup.evaluate((script) => {
    (0, eval)(script!.slice("javascript:".length));
  }, bookmark);
  await expect(
    page.getByText("唯品会 · 本机已登录", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回竞品分析", exact: true }).click();
  await page.reload();
  await expect(
    page.getByText("唯品会 · 本机已登录", { exact: true }),
  ).toBeVisible();
  await popup.close();
});

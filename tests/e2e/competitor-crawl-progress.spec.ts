import { test, expect, type Page } from "@playwright/test";
import {
  analyzeCompetitor,
  vipSearchUrl,
} from "../../packages/contracts/src/competitor-analysis.js";

async function fixture(page: Page, restricted = false) {
  await page.addInitScript(() =>
    localStorage.setItem("competitor-update-mode", "CLOUD"),
  );
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
      restricted && status === "VERIFICATION_REQUIRED"
        ? "唯品会商品接口返回 HTTP 920，云端访问受限，采集已停止；已保留上次有效数据。"
        : status === "LOGIN_REQUIRED"
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
  await page.getByText("云端采集状态", { exact: true }).click();
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
test("HTTP 920 shows access restriction while ordinary challenges keep their verification label", async ({
  page,
}) => {
  await fixture(page, true);
  await page.route("**/api/v1/analytics/competitors/cloud-session", (route) =>
    route.fulfill({
      json: {
        data: {
          enabled: true,
          status: "VERIFICATION_REQUIRED",
          encryptionReady: true,
          workerOnline: true,
          note: "唯品会商品接口返回 HTTP 920，云端访问受限，采集已停止；已保留上次有效数据。",
          savedAt: "2026-10-05T01:00:00Z",
        },
      },
    }),
  );
  await page.goto("/analytics/competitors");
  await expect(page.getByText("云端访问受限", { exact: true })).toBeVisible();
  await page.getByText("云端采集状态", { exact: true }).click();
  const blocked = page
    .locator(".competitor-crawl-job")
    .filter({ hasText: "生活在左" });
  await expect(blocked.getByText("访问受限", { exact: true })).toBeVisible();
  await expect(blocked).toContainText("HTTP 920");
  await expect(blocked).toContainText("详情 15 / 50 款");
  await fixture(page);
  await page.reload();
  await page.getByText("云端采集状态", { exact: true }).click();
  await expect(
    page.locator(".competitor-crawl-job").filter({ hasText: "生活在左" }),
  ).toContainText("需要验证");
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
  await page.getByRole("button", { name: "采集设置", exact: true }).click();
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
  await page.getByRole("button", { name: "采集设置", exact: true }).click();
  await expect(
    page.getByText("唯品会 · 本机已登录", { exact: true }),
  ).toBeVisible();
  await popup.close();
});

test("云端扫码只在窗口内轮询画面，核验成功后清除画面并显示连接", async ({
  page,
}) => {
  await fixture(page);
  const id = "fe0ee591-002b-4975-a20a-9a32e19e5731",
    frameId = "83f8e28b-0c67-40f2-b702-19d6c8d201b1";
  let connected = false,
    cancelled = false;
  const graphic =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="760"><rect width="1080" height="760" fill="#fff7ef"/><rect x="650" y="190" width="220" height="220" fill="#5d4130"/></svg>';
  await page.route("**/api/v1/analytics/competitors/cloud**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown;
    if (path.endsWith("/cloud-session"))
      data = {
        enabled: true,
        status: connected ? "READY" : "DISCONNECTED",
        encryptionReady: true,
        workerOnline: true,
      };
    else if (path.endsWith("/cloud-login")) data = { id };
    else if (path.endsWith("/actions")) {
      connected = route.request().postDataJSON().kind === "CHECK";
      data = { queued: true };
    } else if (path.endsWith("/cancel")) {
      cancelled = true;
      data = { cancelled: true };
    } else
      data = {
        id,
        status: connected ? "SAVED" : "WAITING",
        expiresAt: "2026-10-05T03:00:00Z",
        frameId,
        frame: connected
          ? null
          : "data:image/svg+xml;base64," +
            Buffer.from(graphic).toString("base64"),
        note: connected
          ? "云端登录已核验并保存"
          : "请使用唯品会 App 扫描云端二维码",
      };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data }),
    });
  });
  await page.goto("/analytics/competitors");
  await page.getByRole("button", { name: "云端登录", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "唯品会云端登录画面" }),
  ).toBeVisible();
  await expect(page.getByText("保存后无需保持电脑或 Codex 在线")).toBeVisible();
  await page.getByRole("button", { name: "核验并保存", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "唯品会云端登录画面" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("云端已连接", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回竞品分析", exact: true }).click();
  expect(cancelled, "closing a saved login must preserve credentials").toBe(
    false,
  );
  await page.getByRole("button", { name: "管理云端登录" }).click();
  // This fixture returns an already saved window, which remains safely closable.
  await page.getByRole("button", { name: "返回竞品分析", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

async function recoveryFixture(page: Page) {
  await fixture(page);
  let connected = false;
  let loginSequence = 0;
  const attempts: string[][] = [];
  await page.route("**/api/v1/analytics/competitors/crawl", async (route) => {
    attempts.push(route.request().postDataJSON().brandIds);
    await route.fulfill(
      connected
        ? {
            json: {
              data: {
                jobs: attempts.at(-1)!.map((id) => ({ id, status: "QUEUED" })),
              },
            },
          }
        : {
            status: 409,
            json: {
              error: {
                code: "CLOUD_NOT_READY",
                message: "云端需登录",
                details: { recovery: "CLOUD_LOGIN" },
              },
            },
          },
    );
  });
  await page.route("**/api/v1/analytics/competitors/cloud**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown;
    if (path.endsWith("/cloud-session"))
      data = {
        enabled: true,
        status: connected ? "READY" : "LOGIN_REQUIRED",
        encryptionReady: true,
        workerOnline: true,
        note: "",
        savedAt: "2026-10-12T01:00:00Z",
      };
    else if (path.endsWith("/cloud-login"))
      data = { id: "recovery-" + ++loginSequence };
    else if (path.endsWith("/actions")) {
      connected = route.request().postDataJSON().kind === "CHECK";
      data = { queued: true };
    } else if (path.endsWith("/cancel")) data = { cancelled: true };
    else
      data = {
        id: "recovery-" + loginSequence,
        status: connected ? "SAVED" : "WAITING",
        note: connected ? "已保存" : "请扫码后核验",
        frameId: "test-frame",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        frame: connected
          ? null
          : "data:image/svg+xml;base64," +
            Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="760"><rect width="1080" height="760" fill="#fff7ef"/></svg>',
            ).toString("base64"),
      };
    await route.fulfill({ json: { data } });
  });
  return attempts;
}

test("需要登录时核验后只继续原品牌更新一次，短屏保留操作按钮", async ({
  page,
}) => {
  const attempts = await recoveryFixture(page);
  await page.setViewportSize({ width: 1000, height: 620 });
  await page.goto("/analytics/competitors");
  await page.getByRole("button", { name: "更新竞品数据", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "云端更新竞品数据" });
  await picker.getByRole("button", { name: "清空", exact: true }).click();
  await picker.getByRole("checkbox", { name: "帕罗", exact: true }).check();
  await picker.getByRole("checkbox", { name: "米皇", exact: true }).check();
  await picker
    .getByRole("button", { name: "开始采集（2 个品牌）", exact: true })
    .click();
  const verify = page.getByRole("button", {
    name: "核验并继续更新",
    exact: true,
  });
  await expect(verify).toBeEnabled();
  await expect(verify).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 650 });
  await expect(verify).toBeInViewport();
  await verify.click();
  await expect(
    page.getByRole("dialog", { name: "唯品会云端登录" }),
  ).toHaveCount(0);
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[1]).toEqual(["2", "3"]);
  await expect(page.getByText("云端已连接", { exact: true })).toBeVisible();
});

test("取消待继续更新后，单独保存登录不会启动已取消的更新", async ({ page }) => {
  const attempts = await recoveryFixture(page);
  await page.goto("/analytics/competitors");
  await page.getByRole("button", { name: "更新竞品数据", exact: true }).click();
  await page
    .getByRole("button", { name: "开始采集（1 个品牌）", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "核验并继续更新", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "云端登录", exact: true }).click();
  await page.getByRole("button", { name: "核验并保存", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "返回竞品分析", exact: true }),
  ).toBeVisible();
  expect(attempts).toHaveLength(1);
});

test("采集选择独立于对比品牌，单选多选按实际勾选提交，清空不能开始", async ({
  page,
}) => {
  await fixture(page);
  const attempts: string[][] = [];
  await page.route("**/api/v1/analytics/competitors/crawl", (route) => {
    attempts.push(route.request().postDataJSON().brandIds);
    return route.fulfill({
      json: { data: { jobs: [{ id: "test", status: "QUEUED" }] } },
    });
  });
  await page.goto("/analytics/competitors");
  await page.getByRole("button", { name: "更新竞品数据", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "云端更新竞品数据" });
  await expect(
    modal.getByRole("checkbox", { name: "序缇", exact: true }),
  ).toBeChecked();
  expect(attempts).toEqual([]);
  await modal.getByRole("button", { name: "清空", exact: true }).click();
  await expect(
    modal.getByRole("button", { name: "开始采集（0 个品牌）", exact: true }),
  ).toBeDisabled();
  await modal.getByRole("checkbox", { name: "帕罗", exact: true }).check();
  await modal
    .getByRole("button", { name: "开始采集（1 个品牌）", exact: true })
    .click();
  await expect.poll(() => attempts.length).toBe(1);
  expect(attempts[0]).toEqual(["2"]);
  await page.getByRole("button", { name: "更新竞品数据", exact: true }).click();
  await expect(
    modal.getByRole("checkbox", { name: "帕罗", exact: true }),
  ).toBeChecked();
  await modal.getByRole("checkbox", { name: "米皇", exact: true }).check();
  await modal
    .getByRole("button", { name: "开始采集（2 个品牌）", exact: true })
    .click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[1]).toEqual(["2", "3"]);
  await page.getByRole("button", { name: "更新竞品数据", exact: true }).click();
  await modal.getByRole("button", { name: "全选", exact: true }).click();
  await expect(
    modal.getByText("已选 7 / 7 个品牌", { exact: true }),
  ).toBeVisible();
  expect(attempts).toHaveLength(2);
});

test("自动采集可保存单个品牌，开启时不允许空范围", async ({ page }) => {
  await fixture(page);
  const saved: any[] = [];
  await page.route(
    "**/api/v1/analytics/competitors/crawl-settings",
    (route) => {
      saved.push(route.request().postDataJSON());
      return route.fulfill({ json: { data: { ...saved.at(-1), version: 2 } } });
    },
  );
  await page.goto("/analytics/competitors");
  await page.getByRole("button", { name: "采集设置", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "后台采集设置", exact: true });
  await modal.getByRole("button", { name: "清空", exact: true }).click();
  await expect(
    modal.getByRole("button", { name: "保存设置", exact: true }),
  ).toBeDisabled();
  await modal.getByRole("checkbox", { name: "南宋丝府", exact: true }).check();
  await modal.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0].brandIds).toEqual(["7"]);
});

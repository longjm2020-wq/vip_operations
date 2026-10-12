import { chromium, expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { localExtensionFiles } from "../../packages/contracts/src/competitor-local-extension.js";
import {
  analyzeCompetitor,
  type CompetitorBrand,
  vipSearchUrl,
} from "../../packages/contracts/src/competitor-analysis.js";

const brand = {
  id: "1",
  name: "序缇",
  isOwn: true,
  brandSn: "10204477",
  searchUrl: vipSearchUrl("序缇", "10204477"),
};
const href = (id: string) => `https://detail.vip.com/detail-1-${id}.html`;
const rival = {
  ...brand,
  id: "2",
  name: "帕罗",
  isOwn: false,
  brandSn: "10012281",
  searchUrl: vipSearchUrl("帕罗", "10012281"),
};
const unbound = {
  ...brand,
  id: "3",
  name: "新品牌",
  isOwn: false,
  brandSn: null,
  searchUrl: vipSearchUrl("新品牌"),
};

test("installed MV3 helper returns public DOM, pauses on verification, resumes and saves exact snapshot details", async () => {
  test.setTimeout(60000);
  const dir = await mkdtemp(resolve(".local/local-collector-test-"));
  const extension = join(dir, "extension");
  await mkdir(extension);
  for (const [name, value] of Object.entries(
    localExtensionFiles("http://127.0.0.1:5174"),
  ))
    await writeFile(join(extension, name), value);
  const context = await chromium.launchPersistentContext(join(dir, "profile"), {
    channel: "chromium",
    executablePath:
      process.env.LOCAL_COLLECTOR_TEST_BROWSER || chromium.executablePath(),
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
    viewport: { width: 1200, height: 850 },
  });
  try {
    // Extension-created tabs can send their first request before Playwright attaches.
    // Keep that initial tab blank until routing is attached; every VIP document below is a fixture.
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    await worker.evaluate(() => {
      const api = (globalThis as any).chrome;
      const create = api.tabs.create.bind(api.tabs);
      api.tabs.create = async (options: any) => {
        const tab = await create({ ...options, url: "about:blank" });
        await new Promise((resolve) => setTimeout(resolve, 400));
        return api.tabs.update(tab.id, { url: options.url });
      };
    });
    await context.route("https://**/*", (route) => route.abort());
    const page = context.pages()[0];
    let verify = true;
    let extraBrand: CompetitorBrand = unbound;
    const bindings: unknown[] = [];
    const saved: { path: string; data: any }[] = [];
    await context.route("https://category.vip.com/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: ["11", "12"]
          .map(
            (id, i) =>
              `<a href="${href(id)}"><div class="c-goods-item__name">序缇衬衫${id}</div><span class="J-goods-item__sale-price">${500 + i}</span></a>`,
          )
          .join(""),
      }),
    );
    await context.route("https://detail.vip.com/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: verify
          ? '<p>请完成安全验证</p><input placeholder="验证码">'
          : '<p class="J_brandName">帕罗/PALUO</p><p class="pib-title-detail">桑蚕丝衬衫</p><p id="J_detail_barCode">商品编码：LOCAL-TEST</p><table><tr><th class="dc-table-tit">详细材质信息：</th><td>桑蚕丝95% 聚酯薄膜纤维5%</td></tr></table>',
      }),
    );
    await context.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith(`/brands/${unbound.id}/binding`)) {
        bindings.push(route.request().postDataJSON());
        extraBrand = {
          ...unbound,
          brandSn: "12345678",
          searchUrl: vipSearchUrl(unbound.name, "12345678"),
        };
        await route.fulfill({ json: { data: extraBrand } });
        return;
      }
      if (path.endsWith("/imports") || path.endsWith("/details"))
        saved.push({ path, data: route.request().postDataJSON() });
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
              source: "PUBLIC_RANK",
              crawl: {
                settings: { enabled: false, dailyHour: 8, version: 1 },
                jobs: [],
              },
              brands: [brand, rival, extraBrand],
              alignedPeriod: true,
              options: { categories: [], materials: [], seasons: [] },
              results: [analyzeCompetitor(brand, undefined, {})],
            }
          : path.endsWith("/imports")
            ? { id: "991", count: 2 }
            : path.endsWith("/details")
              ? { count: 1, unmatched: 0 }
              : [];
      await route.fulfill({ json: { data } });
    });
    await page.goto("http://127.0.0.1:5174/analytics/competitors");
    await page
      .getByRole("button", { name: "更新竞品数据", exact: true })
      .first()
      .click();
    const modal = page.getByRole("dialog", { name: "本机更新竞品数据" });
    await expect(
      modal.getByText("本机采集助手已连接", { exact: true }),
    ).toBeVisible();
    await modal.getByRole("button", { name: "清空", exact: true }).click();
    await expect(
      modal.getByRole("button", { name: "开始本机更新", exact: true }),
    ).toBeDisabled();
    await modal.getByRole("checkbox", { name: "新品牌", exact: true }).check();
    await expect(
      modal.getByRole("button", { name: "开始本机更新", exact: true }),
    ).toBeDisabled();
    await modal
      .getByRole("button", { name: "绑定「新品牌」", exact: true })
      .click();
    const binding = page.getByRole("dialog", {
      name: "绑定唯品会品牌：新品牌",
      exact: true,
    });
    await expect(
      binding.getByRole("link", { name: "打开唯品会品牌搜索" }),
    ).toHaveAttribute("href", unbound.searchUrl);
    await binding
      .getByRole("textbox", { name: "唯品会品牌筛选链接" })
      .fill(rival.searchUrl);
    await expect(
      binding.getByRole("button", { name: "保存绑定" }),
    ).toBeDisabled();
    const sourceUrl = `https://category.vip.com/suggest.php?keyword=${encodeURIComponent(unbound.name)}&brand_sn=12345678`;
    await binding
      .getByRole("textbox", { name: "唯品会品牌筛选链接" })
      .fill(sourceUrl);
    await binding.getByRole("button", { name: "保存绑定" }).click();
    await expect(binding).toBeHidden();
    await expect(modal.getByText(/这些品牌尚未绑定品牌ID/)).toHaveCount(0);
    await expect(
      modal.getByRole("button", { name: "开始本机更新", exact: true }),
    ).toBeEnabled();
    expect(bindings).toEqual([{ sourceUrl }]);
    expect(saved).toHaveLength(0);
    await modal
      .getByRole("checkbox", { name: "新品牌", exact: true })
      .uncheck();
    await modal.getByRole("checkbox", { name: "帕罗", exact: true }).check();
    await expect(modal.getByText(/这些品牌尚未绑定品牌ID/)).toHaveCount(0);
    await modal
      .getByRole("button", { name: "开始本机更新", exact: true })
      .click();
    await expect(modal.getByText("已暂停", { exact: true })).toBeVisible({
      timeout: 22000,
    });
    expect(saved).toHaveLength(1);
    expect(saved[0].data.brandId).toBe(rival.id);
    await expect(
      modal.getByRole("checkbox", { name: "序缇", exact: true }),
    ).toBeDisabled();
    expect(saved[0].data.products.map((p: any) => p.productId)).toEqual([
      "11",
      "12",
    ]);
    await expect(
      modal.getByText("已保存榜单 2 款 · 本次详情 0 / 2 款"),
    ).toBeVisible();
    verify = false;
    await modal.getByRole("button", { name: "继续更新", exact: true }).click();
    await expect(modal.getByText("本次所有品牌已更新并保存")).toBeVisible({
      timeout: 15000,
    });
    expect(saved).toHaveLength(3);
    expect(
      saved
        .slice(1)
        .every(
          (x) => x.data.snapshotId === "991" && x.data.brandName === "帕罗",
        ),
    ).toBe(true);
    expect(saved.slice(1).map((x) => x.data.products[0].productId)).toEqual([
      "11",
      "12",
    ]);
    expect(saved[1].data.products[0].materialInfo).toBe(
      "桑蚕丝95% 聚酯薄膜纤维5%",
    );
    await expect(
      modal.getByRole("checkbox", { name: "序缇", exact: true }),
    ).toBeEnabled();
    expect(saved.every((x) => x.data.brandId === rival.id)).toBe(true);
    await page.screenshot({ path: join(dir, "completed.png") });
  } finally {
    await context.close();
  }
});

test("without helper the default local mode offers installation and cannot falsely start", async ({
  page,
}) => {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      json: {
        data: path.endsWith("/auth/me")
          ? {
              id: "1",
              displayName: "测试",
              permissions: ["analytics.read", "analytics.manage"],
              roleCodes: ["ADMIN"],
            }
          : path.endsWith("/analytics/competitors")
            ? {
                brands: [brand],
                source: "PUBLIC_RANK",
                options: { categories: [], materials: [], seasons: [] },
                results: [analyzeCompetitor(brand, undefined, {})],
                crawl: {
                  settings: { enabled: false, dailyHour: 8, version: 1 },
                  jobs: [],
                },
              }
            : [],
      },
    });
  });
  await page.goto("/analytics/competitors");
  await page
    .getByRole("button", { name: "更新竞品数据", exact: true })
    .first()
    .click();
  const modal = page.getByRole("dialog", { name: "本机更新竞品数据" });
  await expect(
    modal.getByRole("button", { name: "开始本机更新", exact: true }),
  ).toBeDisabled();
  await expect(
    modal.getByRole("link", { name: "下载采集助手" }),
  ).toHaveAttribute("href", "/api/v1/analytics/competitors/local-extension");
  await expect(modal.getByText(/未连接本机采集助手，请安装后刷新/)).toBeVisible(
    { timeout: 9000 },
  );
});

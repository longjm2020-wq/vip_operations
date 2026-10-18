import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import {
  analyzeCompetitor,
  competitorProductSchema,
  vipSearchUrl,
  type CompetitorDataset,
} from "../../packages/contracts/src/competitor-analysis.js";

const own = {
  id: "1",
  name: "序缇",
  isOwn: true,
  brandSn: "10204477",
  searchUrl: vipSearchUrl("序缇", "10204477"),
};
const rival = {
  id: "7",
  name: "南宋丝府",
  isOwn: false,
  brandSn: "10204548",
  searchUrl: vipSearchUrl("南宋丝府", "10204548"),
};
const products = Array.from({ length: 23 }, (_, i) =>
  competitorProductSchema.parse({
    productId: String(6922027805267748239n + BigInt(i)),
    productUrl: `https://detail.vip.com/detail-1-${6922027805267748239n + BigInt(i)}.html`,
    title: `TOP20导出样本${i + 1}`,
    styleCode: `NS-${i + 1}`,
    publicRank: i + 1,
    salePrice: i === 19 ? null : 504 + i,
    materialInfo: "【烟雨蓝的面料】桑蚕丝100%",
    seasons: ["秋"],
  }),
);

async function setup(page: Page) {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const dataset: CompetitorDataset = {
      id: "700",
      brandId: rival.id,
      source: "PUBLIC_RANK",
      asOfDate: "2026-10-12",
      periodStart: null,
      periodEnd: null,
      scope: "导出测试样本",
      sourceUrl: rival.searchUrl,
      createdAt: "2026-10-12T03:00:00Z",
      products,
    };
    const data = url.pathname.endsWith("/auth/me")
      ? {
          id: "1",
          displayName: "导出测试",
          permissions: ["analytics.read"],
          roleCodes: [],
          csrfToken: "test",
        }
      : url.pathname.endsWith("/analytics/competitors")
        ? {
            brands: [own, rival],
            source: "PUBLIC_RANK",
            alignedPeriod: true,
            crawl: {
              settings: { enabled: false, dailyHour: 8, version: 1 },
              jobs: [],
            },
            options: { categories: [], materials: [], seasons: [] },
            results: [
              analyzeCompetitor(own, undefined, {}),
              analyzeCompetitor(rival, dataset, {
                sort: (url.searchParams.get("sort") || "rank") as
                  "rank" | "priceDesc",
              }),
            ],
          }
        : [];
    await route.fulfill({ json: { data } });
  });
  await page.goto("/analytics/competitors");
  await page.getByRole("tab", { name: rival.name, exact: true }).click();
}

test("TOP20 exports the selected brand, preserves workbook data and offers a reusable direct download", async ({
  page,
}) => {
  await setup(page);
  await page.route(/exceljs.*\.js/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出TOP20", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导出TOP20", exact: true });
  await expect(dialog.getByText("正在生成 Excel，请稍候…")).toBeVisible();
  const download = await event;
  expect(download.suggestedFilename()).toBe("南宋丝府-竞品TOP20.xlsx");
  await expect(
    dialog.getByText("Excel 文件已生成", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText("南宋丝府 · 20 款");
  const workbook = new ExcelJS.Workbook();
  const original = await readFile((await download.path())!);
  await workbook.xlsx.load(original as any);
  const sheet = workbook.worksheets[0];
  expect(sheet.rowCount).toBe(21);
  expect(sheet.columnCount).toBe(10);
  for (let i = 1; i <= 20; i++) {
    expect(sheet.getCell(i + 1, 1).value).toBe("南宋丝府");
    expect(sheet.getCell(i + 1, 2).value).toBe(i);
    expect(sheet.getCell(i + 1, 4).value).toBe(`NS-${i}`);
    expect(sheet.getCell(i + 1, 7).value).toBe("【面料】桑蚕丝100%");
    expect(sheet.getCell(i + 1, 10).value).toBe(products[i - 1].productUrl);
  }
  expect(sheet.getCell(2, 5).value).toBe(504);
  expect(sheet.getCell(21, 5).value).toBeNull();
  const retryEvent = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "下载 Excel", exact: true }).click();
  expect(await readFile((await (await retryEvent).path())!)).toEqual(original);
  await dialog
    .getByRole("button", { name: "关闭", exact: true })
    .filter({ hasText: "关闭" })
    .click();
  // A new export uses the new sort; the old file stays tied to its original rows.
  await page.getByRole("combobox", { name: "TOP20排序指标" }).click();
  await page.getByText("特卖价从高到低", { exact: true }).click();
  await expect(page.locator(".competitor-product").first()).toContainText(
    "NS-23",
  );
  const sortedEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出TOP20", exact: true }).click();
  await workbook.xlsx.readFile((await (await sortedEvent).path())!);
  expect(workbook.worksheets[0].getCell(2, 4).value).toBe("NS-23");
});

test("a failed lazy export download shows a recoverable error instead of failing silently", async ({
  page,
}) => {
  await setup(page);
  await page.route(/exceljs.*\.js/, (route) => route.abort());
  await page.getByRole("button", { name: "导出TOP20", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导出TOP20", exact: true });
  await expect(
    dialog.getByText("导出失败，请重试", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText("Excel 处理组件加载失败，请检查网络后重试");
  await expect(dialog.getByRole("button", { name: "重新生成" })).toBeEnabled();
  await expect(dialog.getByRole("link", { name: "下载 Excel" })).toHaveCount(0);
  await page.unroute(/exceljs.*\.js/);
  await page.reload();
  await page.getByRole("tab", { name: rival.name, exact: true }).click();
  const recovered = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出TOP20", exact: true }).click();
  expect((await recovered).suggestedFilename()).toBe("南宋丝府-竞品TOP20.xlsx");
  await expect(
    dialog.getByText("Excel 文件已生成", { exact: true }),
  ).toBeVisible();
});

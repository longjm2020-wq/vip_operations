import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";

const periods = [
  {
    period: "3d",
    label: "近3天",
    startDate: "2026-10-13",
    days: 3,
    daily: 5,
    rate: 0.1,
    sales: 20,
  },
  {
    period: "7d",
    label: "近7天",
    startDate: "2026-10-09",
    days: 7,
    daily: 3,
    rate: 0.25,
    sales: 40,
  },
  {
    period: "15d",
    label: "近15天",
    startDate: "2026-10-01",
    days: 15,
    daily: 4.5,
    rate: 0.15,
    sales: 100,
  },
  {
    period: "30d",
    label: "近30天",
    startDate: "2026-09-16",
    days: 30,
    daily: 6,
    rate: 0.2,
    sales: 240,
  },
  {
    period: "3m",
    label: "近3个月",
    startDate: "2026-07-16",
    days: 92,
    daily: 8.5,
    rate: 0.125,
    sales: 800,
  },
  {
    period: "6m",
    label: "近半年",
    startDate: "2026-04-16",
    days: 183,
    daily: 9,
    rate: 0.3,
    sales: 40,
  },
  {
    period: "1y",
    label: "近1年",
    startDate: "2025-10-16",
    days: 365,
    daily: 9,
    rate: 0.3,
    sales: 40,
  },
] as const;
type Period = (typeof periods)[number];
const endDate = "2026-10-15";
const inventoryUrl = "/operations/vip/inventory";

async function fixture(page: Page, splitSkuSales = false) {
  const requests: URL[] = [],
    writes: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (!["GET", "HEAD"].includes(request.method()))
      writes.push(`${request.method()} ${url.pathname}`);
    if (url.pathname.endsWith("/auth/me")) {
      await route.fulfill({
        json: {
          data: {
            id: "reference-reader",
            displayName: "参考周期验收",
            username: "reference-reader",
            roleCodes: [],
            permissions: ["inventory.read"],
            csrfToken: "fixture",
          },
        },
      });
      return;
    }
    if (!url.pathname.endsWith("/inventory/summary")) {
      await route.fulfill({ json: { data: [], total: 0 } });
      return;
    }
    requests.push(url);
    const item =
      periods.find(
        (item) => item.period === url.searchParams.get("referencePeriod"),
      ) ?? periods[3];
    const complete = !["6m", "1y"].includes(item.period);
    const window = {
      period: item.period,
      startDate: item.startDate,
      endDate,
      days: item.days,
      coveredDays: complete ? item.days : 30,
      complete,
      method: "median",
    };
    const source = {
      id: "source-1",
      fileName: "原始条码近30天.xlsx",
      startDate: "2026-09-16",
      endDate,
      normalizationVersion: 3,
    };
    const median = (value: number, values = [value]) => ({
      value,
      values,
      samples: item.days,
      method: "median",
    });
    const reference = {
      source,
      window,
      barcode: "0001234567890",
      reason: complete ? undefined : "INCOMPLETE_PERIOD",
      salesQty: complete ? item.sales : null,
      recordedDays: complete ? item.days : 0,
      ...(complete
        ? {
            dailySales: median(
              item.daily,
              item.period === "30d" ? [5, 7] : [item.daily],
            ),
            returnRate: median(
              item.rate,
              item.period === "30d" ? [0.1, 0.3] : [item.rate],
            ),
            estimatedReturns: {
              value: item.sales * item.rate,
              salesQty: item.sales,
              returnRate: item.rate,
              samples: item.days,
            },
          }
        : {}),
    };
    const defaultRow = {
      id: "101",
      styleNo: "REF-STYLE-001",
      articleNo: "REF-ARTICLE-001",
      skuCode: "REF-SKU-001",
      barcode: "0001234567890",
      colorName: "米白色",
      sizeName: "M",
      physicalQty: 29,
      inTransitQty: 10,
      transferTransitQty: 5,
      incomingQty: 2,
      dailySales: item.daily,
      returnRate: item.rate,
      estimatedReturns: complete ? item.sales * item.rate : 12,
      coverageDays: 10,
      replenishmentQty: 2,
      channelReference: reference,
    };
    const responseRows = splitSkuSales
      ? [
          { id: "101", size: "M", salesQty: 15, daily: 0 },
          { id: "102", size: "L", salesQty: 24, daily: 1 },
          { id: "103", size: "XL", salesQty: 3, daily: 0 },
          { id: "104", size: "缺失", salesQty: null, daily: 0 },
        ].map((sku) => ({
          ...defaultRow,
          id: sku.id,
          styleNo: "XFA16X31196L",
          skuCode: `PERIOD-SALES-${sku.id}`,
          colorName: "粉色",
          sizeName: sku.size,
          dailySales: sku.daily,
          estimatedReturns:
            sku.salesQty === null ? null : sku.salesQty * item.rate,
          coverageDays: sku.daily > 0 ? 29 : null,
          channelReference: {
            ...reference,
            salesQty: sku.salesQty,
            recordedDays: item.days,
            dailySales: {
              ...median(sku.daily),
              samples: sku.salesQty === null ? item.days - 1 : item.days,
            },
            returnRate: median(item.rate),
            estimatedReturns: {
              value: sku.salesQty === null ? null : sku.salesQty * item.rate,
              salesQty: sku.salesQty,
              returnRate: item.rate,
              samples: sku.salesQty === null ? item.days - 1 : item.days,
            },
          },
        }))
      : [defaultRow];
    await route.fulfill({
      json: {
        data: responseRows,
        total: splitSkuSales ? responseRows.length : 42,
        page: Number(url.searchParams.get("page") ?? 1),
        pageSize: 20,
        dimension: url.searchParams.get("dimension") ?? "sku",
        totals: {
          physicalQty: 29,
          inTransitQty: 10,
          transferTransitQty: 5,
          incomingQty: 2,
        },
        reportCoverage: {
          matched: 1,
          total: 42,
          unmatched: 41,
          source,
          window,
        },
      },
    });
  });
  await page.goto(inventoryUrl);
  await expect(
    page.getByRole("heading", { name: "库存明细", exact: true }),
  ).toBeVisible();
  await expect(row(page)).toBeVisible();
  return { requests, writes };
}

const table = (page: Page) => page.locator(".inventory-summary-table");
const row = (page: Page, id = "101") =>
  table(page).locator(`tr[data-row-key="${id}"]`);
const selector = (page: Page) =>
  page.getByRole("combobox", { name: "经营参考周期", exact: true });
const coverage = (page: Page) => page.locator(".inventory-report-coverage");
async function cell(page: Page, name: string, id = "101") {
  const labels = (
    await table(page).getByRole("columnheader").allTextContents()
  ).map((text) => text.trim());
  const index = labels.indexOf(name);
  expect(index).toBeGreaterThanOrEqual(0);
  return row(page, id).locator("td").nth(index);
}
async function choose(page: Page, item: Period) {
  await selector(page).click();
  await page
    .locator(".ant-select-dropdown .ant-select-item-option")
    .filter({ hasText: new RegExp(`^${item.label}$`) })
    .click();
  await expect(coverage(page)).toContainText(item.startDate);
  await expect(coverage(page)).toContainText(endDate);
}
async function tooltip(page: Page, name: string) {
  const target = (await cell(page, name)).locator("span[tabindex]").first();
  await target.focus();
  await expect(target).toHaveAttribute("aria-describedby", /.+/);
  const visible = page.locator(
    `[role="tooltip"][id="${await target.getAttribute("aria-describedby")}"]`,
  );
  await expect(visible).toBeVisible();
  return visible;
}

test("经营参考提供七个周期，切换重取第一页且跨汇总维度保留选择", async ({
  page,
}) => {
  const state = await fixture(page);
  await expect(selector(page)).toBeVisible();
  await expect(selector(page).locator("..")).toContainText("近30天");
  expect(state.requests.at(-1)!.searchParams.get("referencePeriod")).toBe(
    null,
  );
  await page.locator(".ant-pagination-item-2").click();
  await expect(page.locator(".ant-pagination-item-active")).toHaveText("2");
  for (const item of periods) {
    await choose(page, item);
    // Revisiting the default period may reuse the same fresh query-cache result.
    await expect
      .poll(() =>
        state.requests.some(
          (request) =>
            request.searchParams.get("referencePeriod") === item.period &&
            request.searchParams.get("page") === "1",
        ),
      )
      .toBe(true);
    await expect(page.locator(".ant-pagination-item-active")).toHaveText("1");
    await expect(coverage(page)).toContainText("中位数");
    await expect(await cell(page, "期间销量")).toHaveText(
      ["6m", "1y"].includes(item.period) ? "历史覆盖不足" : String(item.sales),
    );
    await expect(await cell(page, "渠道日销参考")).toHaveText(
      String(item.daily),
    );
    const periodTip = await tooltip(page, "渠道日销参考");
    await expect(periodTip).toContainText(item.startDate);
    await expect(periodTip).toContainText(endDate);
    await page.getByRole("heading", { name: "库存明细", exact: true }).click();
  }
  await page.getByRole("tab", { name: "货号", exact: true }).click();
  await expect(selector(page)).toHaveCount(0);
  await page.getByRole("tab", { name: "款号", exact: true }).click();
  await expect(selector(page)).toHaveCount(0);
  await page
    .getByRole("tab", { name: "条码（商品编码）", exact: true })
    .click();
  await expect(selector(page).locator("..")).toContainText("近1年");
  await expect(coverage(page)).toContainText("2025-10-16");
  expect(state.writes).toEqual([]);
});

test("中位数提示展示中间两值与预估公式，导出沿用当前周期及来源日期", async ({
  page,
}) => {
  const state = await fixture(page);
  await expect(await cell(page, "渠道日销参考")).toHaveText("6");
  await expect(await cell(page, "退货率")).toHaveText("20%");
  await expect(await cell(page, "预估销退数")).toHaveText("48");
  const dailyTip = await tooltip(page, "渠道日销参考");
  await expect(dailyTip).toContainText("中位数");
  await expect(dailyTip).toContainText("5");
  await expect(dailyTip).toContainText("7");
  await expect(dailyTip).not.toContainText("最高频次");
  await expect(dailyTip).not.toContainText("众数");
  await page.getByRole("heading", { name: "库存明细", exact: true }).click();
  const estimatedTip = await tooltip(page, "预估销退数");
  await expect(estimatedTip).toContainText("中位数");
  await expect(estimatedTip).toContainText("240 × 20% = 48");
  await page.getByRole("heading", { name: "库存明细", exact: true }).click();

  await choose(page, periods[1]);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("当前页数据.xlsx");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile((await download.path())!);
  const sheet = workbook.worksheets[0];
  const labels = sheet.getRow(1).values as string[];
  const column = (name: string) => {
    const index = labels.indexOf(name);
    expect(index).toBeGreaterThan(0);
    return index;
  };
  const exportedRow = sheet.getRow(3),
    totalRow = sheet.getRow(2);
  expect(Number(exportedRow.getCell(column("渠道日销参考")).value)).toBe(3);
  expect(Number(exportedRow.getCell(column("退货率")).value)).toBe(25);
  expect(Number(exportedRow.getCell(column("预估销退数")).value)).toBe(10);
  expect(exportedRow.getCell(column("经营参考周期")).value).toBe("近7天");
  expect(exportedRow.getCell(column("经营参考起始日期")).value).toBe(
    "2026-10-09",
  );
  expect(exportedRow.getCell(column("经营参考截止日期")).value).toBe(endDate);
  expect(totalRow.getCell(column("经营参考周期")).value).toBe("近7天");
  expect(state.writes).toEqual([]);
});

test("半年和一年历史不足时明确提示覆盖缺口，保留人工参考且导出注明", async ({
  page,
}) => {
  const state = await fixture(page);
  for (const item of [periods[5], periods[6]]) {
    await choose(page, item);
    await expect(coverage(page)).toContainText("历史覆盖不足");
    await expect(coverage(page)).toContainText("30");
    await expect(coverage(page)).toContainText(String(item.days));
    await expect(await cell(page, "渠道日销参考")).toHaveText("9");
    await expect(await cell(page, "退货率")).toHaveText("30%");
    await expect(await cell(page, "预估销退数")).toHaveText("12");
    const manualTip = await tooltip(page, "渠道日销参考");
    await expect(manualTip).toContainText("人工");
    await expect(manualTip).toContainText("历史覆盖不足");
    await expect(manualTip).toContainText(item.startDate);
    await page.getByRole("heading", { name: "库存明细", exact: true }).click();
  }
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile((await (await downloadPromise).path())!);
  const sheet = workbook.worksheets[0];
  const labels = sheet.getRow(1).values as string[];
  const methodIndex = labels.indexOf("参考数据口径");
  expect(methodIndex).toBeGreaterThan(0);
  expect(String(sheet.getRow(3).getCell(methodIndex).value)).toContain(
    "人工参考",
  );
  expect(state.writes).toEqual([]);
});

test("期间销量按SKU显示42件的拆分，零中位数不误称无日销且缺失不补零", async ({
  page,
}) => {
  const state = await fixture(page, true);
  const expected = [
    { id: "101", sales: 15, daily: 0 },
    { id: "102", sales: 24, daily: 1 },
    { id: "103", sales: 3, daily: 0 },
  ];
  let displayedSales = 0;
  for (const sku of expected) {
    const salesCell = await cell(page, "期间销量", sku.id);
    await expect(salesCell).toHaveText(String(sku.sales));
    displayedSales += Number(await salesCell.textContent());
    await expect(await cell(page, "渠道日销参考", sku.id)).toContainText(
      String(sku.daily),
    );
    await expect(row(page, sku.id)).not.toContainText("无日销");
    if (sku.daily === 0) {
      await expect(await cell(page, "渠道日销参考", sku.id)).toContainText(
        "期间有销量",
      );
      await expect(await cell(page, "可售天数", sku.id)).toHaveText(
        "中位数为0",
      );
    }
  }
  expect(displayedSales).toBe(42);
  await expect(await cell(page, "期间销量", "104")).toHaveText("销量数据不足");
  const labels = (
    await table(page).getByRole("columnheader").allTextContents()
  ).map((text) => text.trim());
  const totalSales = page
    .getByRole("row", { name: "当前筛选库存总计", exact: true })
    .locator("td")
    .nth(labels.indexOf("期间销量"));
  await expect(totalSales).toHaveText("—");
  const zeroMedianTip = await tooltip(page, "渠道日销参考");
  await expect(zeroMedianTip).toContainText("中位数");
  await expect(zeroMedianTip).toContainText("15");
  await page.getByRole("heading", { name: "库存明细", exact: true }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile((await (await downloadPromise).path())!);
  const sheet = workbook.worksheets[0],
    exportLabels = sheet.getRow(1).values as string[];
  const salesIndex = exportLabels.indexOf("期间销量");
  expect(salesIndex).toBeGreaterThan(0);
  expect(sheet.getRow(2).getCell(salesIndex).value).toBe("—");
  expect(
    [3, 4, 5].map((index) =>
      Number(sheet.getRow(index).getCell(salesIndex).value),
    ),
  ).toEqual([15, 24, 3]);
  expect([null, "", "—"]).toContain(sheet.getRow(6).getCell(salesIndex).value);

  await page.getByRole("tab", { name: "货号", exact: true }).click();
  await expect(
    table(page).getByRole("columnheader", { name: "期间销量", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "款号", exact: true }).click();
  await expect(
    table(page).getByRole("columnheader", { name: "期间销量", exact: true }),
  ).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

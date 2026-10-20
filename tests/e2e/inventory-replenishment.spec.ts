import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { compassInventoryReference } from "../../packages/contracts/src/compass-inventory-reference.js";
import {
  calculateReplenishmentPlan,
  planningDemand,
  defaultReplenishmentPolicy,
  type ReplenishmentPolicy,
} from "../../packages/contracts/src/inventory-replenishment.js";

type Saved = { revision: number; policy: ReplenishmentPolicy };
const url = "/operations/vip/inventory";
const table = (page: Page) => page.locator(".inventory-summary-table");
async function cell(page: Page, name: string) {
  const names = (
    await table(page).getByRole("columnheader").allTextContents()
  ).map((value) => value.trim());
  return table(page)
    .locator('tr[data-row-key="101"] td')
    .nth(names.indexOf(name));
}
async function boot(
  page: Page,
  saved: Map<string, Saved>,
  user = "1",
  failSave = false,
) {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const current = saved.get(user) || {
      revision: 0,
      policy: { ...defaultReplenishmentPolicy },
    };
    if (path.endsWith("/auth/me"))
      return route.fulfill({
        json: {
          data: {
            id: user,
            displayName: "补货验收",
            username: `user-${user}`,
            permissions: ["inventory.read"],
            csrfToken: "fixture",
          },
        },
      });
    if (path.endsWith("/inventory/replenishment-policy")) {
      if (request.method() === "POST") {
        const body = request.postDataJSON() as Saved;
        if (failSave || body.revision !== current.revision)
          return route.fulfill({
            status: 409,
            json: {
              error: {
                message: "计算配置已在其他页面更新，请重新打开面板后修改",
              },
            },
          });
        saved.set(user, {
          policy: body.policy,
          revision: current.revision + 1,
        });
      }
      return route.fulfill({ json: { data: saved.get(user) || current } });
    }
    if (!path.endsWith("/inventory/summary"))
      return route.fulfill({ json: { data: [], total: 0 } });
    const period =
      new URL(request.url()).searchParams.get("referencePeriod") ||
      current.policy.referencePeriod;
    const days = period.endsWith("d") ? Number(period.slice(0, -1)) : 30;
    const records = Array.from({ length: days }, (_, index) => ({
      date: new Date(Date.UTC(2026, 9, 18 - days + index))
        .toISOString()
        .slice(0, 10),
      salesQty: index === days - 1 ? 15 : 0,
      reportedReturnRate: 0.5,
    }));
    const reference = compassInventoryReference(records, {
      dailySales: current.policy.dailySalesMethod,
      returnRate: current.policy.returnRateMethod,
    });
    const demand = planningDemand({
      complete: true,
      days,
      recordedDays: days,
      salesSamples: days,
      salesQty: 15,
      ambiguous: false,
      manualDailySales: null,
    });
    const plan = calculateReplenishmentPlan(
      {
        demand,
        availableQty: 0,
        unconfirmedInboundQty: 2,
        referenceReturnRate: 0.5,
      },
      current.policy,
    );
    const window = {
      startDate: records[0].date,
      endDate: "2026-10-17",
      days,
      coveredDays: days,
      complete: true,
      method: current.policy.dailySalesMethod,
      period,
    };
    const row = {
      id: "101",
      skuCode: "SKU-001",
      barcode: "000001",
      styleNo: "S-01",
      colorName: "粉色",
      sizeName: "M",
      physicalQty: 0,
      inTransitQty: 2,
      transferTransitQty: 0,
      incomingQty: 0,
      dailySales: reference.dailySales.value,
      returnRate: 0.5,
      planningDailySales: demand.dailySales,
      estimatedReturns: 7.5,
      replenishmentQty: plan.quantity,
      coverageDays: plan.coverageDays,
      replenishmentPlan: plan,
      channelReference: {
        window,
        salesQty: 15,
        recordedDays: days,
        barcode: "000001",
        dailySales: reference.dailySales,
        returnRate: reference.returnRate,
        estimatedReturns: {
          value: 7.5,
          salesQty: 15,
          returnRate: 0.5,
          samples: 30,
        },
      },
    };
    return route.fulfill({
      json: {
        data: [row],
        total: 1,
        page: 1,
        pageSize: 20,
        totals: {
          physicalQty: 0,
          inTransitQty: 2,
          transferTransitQty: 0,
          incomingQty: 0,
        },
        replenishmentPolicy: current,
        reportCoverage: { total: 1, matched: 1, window },
      },
    });
  });
  await page.goto(url);
  await expect(table(page).locator('tr[data-row-key="101"]')).toBeVisible();
}

test("补货用完整日均并展示延迟回仓、交期内缺口和未核对在途", async ({
  page,
}) => {
  await boot(page, new Map());
  // Default 高频均值 ignores the 29 zero days (样本不足); 补货日均 still uses 15 ÷ 30.
  await expect(await cell(page, "渠道日销参考")).toContainText("15");
  await expect(await cell(page, "渠道日销参考")).toContainText("样本不足");
  await expect(await cell(page, "补货日均")).toHaveText("0.5");
  await expect(await cell(page, "补货建议")).toHaveText("11件需核对");
  const focus = (await cell(page, "补货建议")).locator("span[tabindex]");
  await focus.focus();
  const tip = page.getByRole("tooltip").filter({ hasText: "期间销量 15" });
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("15–20 天");
  await expect(tip).toContainText("95%");
  await expect(tip).toContainText("主建议未抵扣");
  await expect(tip).toContainText("到货前预计缺口 10 件");
  await expect(tip).toContainText("进货仓 2 件");
  await page.getByRole("heading", { name: "库存明细", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile((await (await downloading).path())!);
  const sheet = workbook.worksheets[0],
    headers = sheet.getRow(1).values as string[];
  expect(
    Number(sheet.getRow(3).getCell(headers.indexOf("补货日均")).value),
  ).toBe(0.5);
  expect(
    Number(sheet.getRow(3).getCell(headers.indexOf("补货建议")).value),
  ).toBe(11);
  expect(
    String(sheet.getRow(3).getCell(headers.indexOf("参考数据口径")).value),
  ).toContain("主建议不抵扣退货");
});

test("保存交期后重新计算，并通过服务器在新的浏览器上下文恢复", async ({
  page,
  browser,
}) => {
  const saved = new Map<string, Saved>();
  await boot(page, saved);
  await page.getByRole("button", { name: "计算配置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "计算面板", exact: true });
  await expect(
    dialog.getByLabel("采购交期（天）", { exact: true }),
  ).toHaveValue("20");
  await expect(
    dialog.getByLabel("退回商品预计可再售比例（%）", { exact: true }),
  ).toHaveValue("95.00");
  await dialog.getByLabel("采购交期（天）", { exact: true }).fill("3");
  await dialog.getByRole("button", { name: "保存并重算", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(await cell(page, "补货建议")).toHaveText("2件需核对");
  expect(saved.get("1")).toMatchObject({
    revision: 1,
    policy: { purchaseLeadDays: 3, resalableRate: 0.95 },
  });
  const secondContext = await browser.newContext();
  try {
    const secondPage = await secondContext.newPage();
    await boot(secondPage, saved);
    await expect(await cell(secondPage, "补货建议")).toHaveText("2件需核对");
    await secondPage
      .getByRole("button", { name: "计算配置", exact: true })
      .click();
    await expect(
      secondPage
        .getByRole("dialog")
        .getByLabel("采购交期（天）", { exact: true }),
    ).toHaveValue("3");
    const otherPage = await secondContext.newPage();
    await boot(otherPage, saved, "2");
    await expect(await cell(otherPage, "补货建议")).toHaveText("11件需核对");
  } finally {
    await secondContext.close();
  }
});

test("校验回仓范围，保存冲突时保留输入且不宣称成功", async ({ page }) => {
  const saved = new Map<string, Saved>();
  await boot(page, saved, "1", true);
  await page.getByRole("button", { name: "计算配置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("最短可再售回仓周期（天）", { exact: true })
    .fill("21");
  await dialog.getByRole("button", { name: "保存并重算", exact: true }).click();
  await expect(
    page.getByText("最长回仓周期不能小于最短回仓周期", { exact: true }),
  ).toBeVisible();
  expect(saved.size).toBe(0);
  await dialog
    .getByLabel("最短可再售回仓周期（天）", { exact: true })
    .fill("15");
  await dialog.getByLabel("采购交期（天）", { exact: true }).fill("5");
  await dialog.getByRole("button", { name: "保存并重算", exact: true }).click();
  await expect(
    page.getByText("计算配置已在其他页面更新，请重新打开面板后修改", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByLabel("采购交期（天）", { exact: true }),
  ).toHaveValue("5");
  expect(saved.size).toBe(0);
});

test("页签右侧计算图标提供日销、退货率和周期配置，保存后恢复并按新口径导出", async ({
  page,
}, testInfo) => {
  const saved = new Map<string, Saved>();
  await boot(page, saved);
  const trigger = page
    .locator(".ant-tabs-extra-content")
    .getByRole("button", { name: "计算配置", exact: true });
  await expect(trigger).toBeVisible();
  await expect(
    page.locator(".table-toolbar").getByRole("button", { name: "计算配置" }),
  ).toHaveCount(0);
  await trigger.click();
  const panel = page.getByRole("dialog", { name: "计算面板", exact: true });
  const choose = async (label: string, option: string) => {
    await panel.getByRole("combobox", { name: label, exact: true }).click();
    await page
      .locator(".ant-select-dropdown:visible .ant-select-item-option")
      .filter({ hasText: new RegExp(`^${option}$`) })
      .click();
    await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
  };
  await choose("报表周期（保存为默认）", "近7天");
  await choose("渠道日销参考取值", "平均值");
  await choose("退货率参考取值", "众数（并列取均值）");
  await page.screenshot({
    path: testInfo.outputPath("calculation-panel.png"),
    fullPage: true,
  });
  await panel.getByRole("button", { name: "保存并重算", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(await cell(page, "渠道日销参考")).toHaveText("2.1429");
  expect(saved.get("1")?.policy).toMatchObject({
    referencePeriod: "7d",
    dailySalesMethod: "mean",
    returnRateMethod: "mode",
  });
  await page.reload();
  await expect(table(page).locator('tr[data-row-key="101"]')).toBeVisible();
  await expect(await cell(page, "渠道日销参考")).toHaveText("2.1429");
  await expect(
    page.locator(".inventory-report-coverage").first(),
  ).toContainText("近7天");
  const focus = (await cell(page, "退货率")).locator("span[tabindex]");
  await focus.focus();
  await expect(
    page.getByRole("tooltip").filter({ hasText: "最高频次" }),
  ).toContainText("7 次");
  await page.getByRole("heading", { name: "库存明细", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile((await (await download).path())!);
  const sheet = workbook.worksheets[0],
    headers = sheet.getRow(1).values as string[];
  expect(
    String(sheet.getRow(3).getCell(headers.indexOf("参考数据口径")).value),
  ).toContain("退货率：罗盘众数（并列取均值）");
});

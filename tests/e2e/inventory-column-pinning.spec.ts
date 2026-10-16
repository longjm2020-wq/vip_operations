import { expect, test, type Locator, type Page } from "@playwright/test";

const inventoryUrl = "/operations/vip/inventory";
const allHeaders = [
  "图片",
  "款号",
  "货号",
  "商品编码",
  "供应商款式编码",
  "颜色",
  "尺码",
  "在仓库存数",
  "采购在途数",
  "调拨在途数",
  "进货仓库存",
  "期间销量",
  "预估销退数",
  "渠道日销参考",
  "退货率",
  "可售天数",
  "补货建议",
];

async function fixture(page: Page) {
  let userId = "inventory-reader-101";
  const writes: string[] = [];
  const rows = [
    {
      id: "101",
      styleNo: "PIN-STYLE-001",
      articleNo: "PIN-ARTICLE-001",
      skuCode: "PIN-SKU-001",
      supplierStyleCode: "SUPPLIER-001",
      colorName: "米白色",
      sizeName: "M",
      mainImageUrl: null,
      physicalQty: 17,
      inTransitQty: 4,
      transferTransitQty: 2,
      incomingQty: 3,
      estimatedReturns: 1,
      dailySales: 2,
      returnRate: 0.02,
      coverageDays: 8,
      replenishmentQty: 12,
    },
    {
      id: "102",
      styleNo: "PIN-STYLE-002",
      articleNo: "PIN-ARTICLE-002",
      skuCode: "PIN-SKU-002",
      supplierStyleCode: "SUPPLIER-002",
      colorName: "黑色",
      sizeName: "L",
      mainImageUrl: null,
      physicalQty: 12,
      inTransitQty: 6,
      transferTransitQty: 3,
      incomingQty: 7,
      estimatedReturns: 2,
      dailySales: 1,
      returnRate: 0.01,
      coverageDays: 12,
      replenishmentQty: 5,
    },
  ];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (!["GET", "HEAD"].includes(request.method()))
      writes.push(`${request.method()} ${url.pathname}`);
    if (url.pathname.endsWith("/auth/me")) {
      await route.fulfill({
        json: {
          data: {
            id: userId,
            username: userId,
            displayName: "库存只读验收",
            roleCodes: [],
            permissions: ["inventory.read"],
            csrfToken: "fixture",
          },
        },
      });
    } else if (url.pathname.endsWith("/inventory/summary")) {
      await route.fulfill({
        json: {
          data: rows,
          total: rows.length,
          page: 1,
          pageSize: 20,
          dimension: url.searchParams.get("dimension") ?? "sku",
          totals: {
            physicalQty: 29,
            inTransitQty: 10,
            transferTransitQty: 5,
            incomingQty: 10,
            availableQty: 29,
            reservedQty: 0,
            damagedQty: 0,
          },
        },
      });
    } else {
      await route.fulfill({ json: { data: [], total: 0 } });
    }
  });
  await page.goto(inventoryUrl);
  await expect(
    page.getByRole("heading", { name: "库存明细", exact: true }),
  ).toBeVisible();
  await expect(dataRows(page)).toHaveCount(2);
  return {
    writes,
    setUser(id: string) {
      userId = id;
    },
  };
}

const table = (page: Page) => page.locator(".inventory-summary-table");
const dataRows = (page: Page) =>
  table(page).locator(".ant-table-tbody > tr[data-row-key]");
const headers = (page: Page) => table(page).getByRole("columnheader");
const header = (page: Page, name: string) =>
  table(page).getByRole("columnheader", { name, exact: true });
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "固定多列", exact: true });
const summary = (page: Page) =>
  page.getByRole("row", { name: "当前筛选库存总计", exact: true });

async function headerIndex(page: Page, name: string) {
  const labels = (await headers(page).allTextContents()).map((text) =>
    text.trim(),
  );
  const index = labels.indexOf(name);
  expect(index, `表头包含 ${name}`).toBeGreaterThanOrEqual(0);
  return index;
}

async function cells(page: Page, name: string) {
  const index = await headerIndex(page, name);
  return {
    header: header(page, name),
    body: dataRows(page).first().locator("td").nth(index),
    summary: summary(page).locator("td").nth(index),
  };
}

async function x(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!.x;
}

async function open(page: Page, name = "款号") {
  await header(page, name).click({ button: "right" });
  await expect(dialog(page)).toBeVisible();
}

async function selectPins(page: Page, names: string[]) {
  await open(page);
  const panel = dialog(page);
  for (const checkbox of await panel.getByRole("checkbox").all()) {
    const label = await checkbox.getAttribute("aria-label");
    await checkbox.setChecked(
      names.includes(label?.replace(/^固定/, "") ?? ""),
    );
  }
  await panel.getByRole("button", { name: "应用固定", exact: true }).click();
  await expect(panel).toHaveCount(0);
}

async function fixedNames(page: Page) {
  return headers(page).evaluateAll((elements) =>
    elements
      .filter((element) => getComputedStyle(element).position === "sticky")
      .map((element) => element.textContent?.trim() ?? ""),
  );
}

test("只读账号可通过右键固定非连续多列，横滚时表头、数据和总计保持对齐", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const state = await fixture(page);
  await expect(
    page.getByRole("button", { name: /固定多列|应用固定|取消所有固定列/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "导入", exact: true }),
  ).toHaveCount(0);

  // Body cells and headers provide the same exclusive context-menu entry.
  const stock = await cells(page, "在仓库存数");
  await stock.body.click({ button: "right" });
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("button", { name: "取消", exact: true }).click();
  await selectPins(page, ["在仓库存数", "款号"]);
  expect(await fixedNames(page)).toEqual(["款号", "在仓库存数"]);
  expect(
    (await headers(page).allTextContents())
      .map((text) => text.trim())
      .slice(0, 2),
  ).toEqual(["款号", "在仓库存数"]);

  const styleCells = await cells(page, "款号"),
    stockCells = await cells(page, "在仓库存数");
  await expect(styleCells.body).toHaveText("PIN-STYLE-001");
  await expect(stockCells.body).toHaveText("17");
  await expect(stockCells.summary).toHaveText("29");
  await expect(summary(page)).toContainText("总计");
  const styleX = await x(styleCells.header),
    stockX = await x(stockCells.header);
  const moving = header(page, "商品编码"),
    movingX = await x(moving);
  const scrollBody = table(page).locator(".ant-table-body");
  await scrollBody.evaluate((element) => {
    element.scrollLeft = 450;
  });
  await expect
    .poll(() => scrollBody.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(300);
  await expect.poll(() => x(moving)).toBeLessThan(movingX - 250);

  for (const [group, originalX] of [
    [styleCells, styleX],
    [stockCells, stockX],
  ] as const) {
    await expect.poll(() => x(group.header)).toBeCloseTo(originalX, 0);
    expect(Math.abs((await x(group.body)) - originalX)).toBeLessThan(2);
    expect(Math.abs((await x(group.summary)) - originalX)).toBeLessThan(2);
  }
  await expect(stockCells.summary).toHaveText("29");
  expect(state.writes).toEqual([]);
});

test("右键草稿取消不改变列，清空固定后恢复原列顺序", async ({ page }) => {
  const state = await fixture(page);
  await selectPins(page, ["款号", "在仓库存数"]);
  await open(page);
  await dialog(page)
    .getByRole("checkbox", { name: "固定颜色", exact: true })
    .check();
  await dialog(page)
    .getByRole("checkbox", { name: "固定款号", exact: true })
    .uncheck();
  await dialog(page).getByRole("button", { name: "取消", exact: true }).click();
  expect(await fixedNames(page)).toEqual(["款号", "在仓库存数"]);
  await open(page);
  await expect(
    dialog(page).getByRole("checkbox", { name: "固定款号", exact: true }),
  ).toBeChecked();
  await expect(
    dialog(page).getByRole("checkbox", { name: "固定颜色", exact: true }),
  ).not.toBeChecked();
  await dialog(page)
    .getByRole("checkbox", { name: "固定款号", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  await expect(dialog(page)).toBeVisible();
  await page.screenshot({
    path: ".local/inventory-column-pinning-preview-20261016.png",
    animations: "disabled",
    caret: "hide",
  });
  await dialog(page)
    .getByRole("button", { name: "取消所有固定列", exact: true })
    .click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await fixedNames(page)).toEqual([]);
  expect(
    (await headers(page).allTextContents()).map((text) => text.trim()),
  ).toEqual(allHeaders);
  const stockCells = await cells(page, "在仓库存数");
  await expect(stockCells.summary).toHaveText("29");
  await page.reload();
  await expect(dataRows(page)).toHaveCount(2);
  expect(await fixedNames(page)).toEqual([]);
  expect(state.writes).toEqual([]);
});

test("三个汇总维度分别记住固定列，刷新恢复且切换账号隔离", async ({ page }) => {
  const state = await fixture(page);
  await selectPins(page, ["款号", "在仓库存数"]);
  await page.getByRole("tab", { name: "货号", exact: true }).click();
  expect(await fixedNames(page)).toEqual([]);
  await selectPins(page, ["供应商款式编码", "采购在途数"]);
  await page.getByRole("tab", { name: "款号", exact: true }).click();
  expect(await fixedNames(page)).toEqual([]);
  await selectPins(page, ["调拨在途数"]);
  expect(await fixedNames(page)).toEqual(["调拨在途数"]);

  await page.reload();
  await expect(dataRows(page)).toHaveCount(2);
  expect(await fixedNames(page)).toEqual(["款号", "在仓库存数"]);
  await page.getByRole("tab", { name: "货号", exact: true }).click();
  expect(await fixedNames(page)).toEqual(["供应商款式编码", "采购在途数"]);
  await page.getByRole("tab", { name: "款号", exact: true }).click();
  expect(await fixedNames(page)).toEqual(["调拨在途数"]);

  state.setUser("inventory-reader-202");
  await page.reload();
  await expect(dataRows(page)).toHaveCount(2);
  expect(await fixedNames(page)).toEqual([]);
  await selectPins(page, ["颜色"]);
  expect(await fixedNames(page)).toEqual(["颜色"]);
  state.setUser("inventory-reader-101");
  await page.reload();
  await expect(dataRows(page)).toHaveCount(2);
  expect(await fixedNames(page)).toEqual(["款号", "在仓库存数"]);
  expect(state.writes).toEqual([]);
});

test("固定总宽超出窗口时阻止应用，已保存固定在窄窗口暂时停用并可恢复", async ({
  page,
}) => {
  const state = await fixture(page);
  await open(page);
  for (const checkbox of await dialog(page).getByRole("checkbox").all())
    await checkbox.check();
  await dialog(page)
    .getByRole("button", { name: "应用固定", exact: true })
    .click();
  await expect(
    page.getByText("固定列总宽超过当前可视区域，请减少勾选列后再应用", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog(page)).toBeVisible();
  expect(await fixedNames(page)).toEqual([]);
  await dialog(page).getByRole("button", { name: "取消", exact: true }).click();
  await selectPins(page, [
    "款号",
    "货号",
    "供应商款式编码",
    "颜色",
    "在仓库存数",
  ]);
  expect(await fixedNames(page)).toEqual([
    "款号",
    "货号",
    "供应商款式编码",
    "颜色",
    "在仓库存数",
  ]);
  await page.setViewportSize({ width: 760, height: 900 });
  await expect.poll(() => fixedNames(page)).toEqual([]);
  const scrollBody = table(page).locator(".ant-table-body");
  await scrollBody.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect
    .poll(() => scrollBody.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await expect(header(page, "补货建议")).toBeInViewport();
  await scrollBody.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await open(page);
  await expect(
    dialog(page).getByText("窗口较窄，固定暂时停用；放大窗口或减少固定列", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog(page).getByRole("checkbox", { name: "固定颜色", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect
    .poll(() => fixedNames(page))
    .toEqual(["款号", "货号", "供应商款式编码", "颜色", "在仓库存数"]);
  expect(state.writes).toEqual([]);
});

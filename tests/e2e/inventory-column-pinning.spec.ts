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
  "补货日均",
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
const menu = (page: Page) =>
  page.locator(".inventory-column-pinning-menu").getByRole("menu");
const menuItem = (page: Page, name: string) =>
  menu(page)
    .getByRole("menuitem")
    .filter({ hasText: new RegExp(`^${name}$`) });
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

async function selectedNames(page: Page) {
  return headers(page).evaluateAll((elements) =>
    elements
      .filter((element) => element.getAttribute("aria-selected") === "true")
      .map((element) => element.textContent?.trim() ?? ""),
  );
}

/** Click the first column, Ctrl/Cmd+click the rest, then pin them from the header context menu. */
async function selectPins(page: Page, names: string[]) {
  await header(page, names[0]).click();
  for (const name of names.slice(1))
    await header(page, name).click({ modifiers: ["ControlOrMeta"] });
  await header(page, names[0]).click({ button: "right" });
  await menuItem(
    page,
    names.length > 1 ? `固定所选 ${names.length} 列` : "固定此列",
  ).click();
  await expect(menu(page)).toBeHidden();
}

/** The last pinned column carries the same darker divider as 选款登记 (#bda58f). */
async function expectDivider(group: Record<string, Locator>) {
  for (const cell of Object.values(group))
    await expect(cell).toHaveCSS("border-right", "1px solid rgb(189, 165, 143)");
}

async function fixedNames(page: Page) {
  return headers(page).evaluateAll((elements) =>
    elements
      .filter((element) => getComputedStyle(element).position === "sticky")
      .map((element) => element.textContent?.trim() ?? ""),
  );
}

test("Ctrl/⌘ 跳选非连续多列后右键固定，横滚时表头、数据和总计保持对齐", async ({
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

  // Right-clicking an unselected body cell acts on that single column.
  const stock = await cells(page, "在仓库存数");
  await stock.body.click({ button: "right" });
  await expect(menuItem(page, "固定此列")).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await selectedNames(page)).toEqual(["在仓库存数"]);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();

  await header(page, "在仓库存数").click();
  await header(page, "款号").click({ modifiers: ["ControlOrMeta"] });
  expect(await selectedNames(page)).toEqual(["款号", "在仓库存数"]);
  await header(page, "在仓库存数").click({ button: "right" });
  await expect(menuItem(page, "固定所选 2 列")).toBeVisible();
  await expect(menuItem(page, "取消所有固定列")).toHaveCount(0);
  await menuItem(page, "固定所选 2 列").click();
  await expect(menu(page)).toBeHidden();
  expect(await selectedNames(page)).toEqual([]);
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
  await expectDivider(stockCells);
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
  await expectDivider(stockCells);
  const styleBorder = await styleCells.body.evaluate(
    (element) => getComputedStyle(element).borderRightWidth,
  );
  expect(styleBorder).toBe("0px");
  expect(state.writes).toEqual([]);
});

test("Shift 连续选列后右键固定，可单列取消或取消所有固定列，Esc 与空白点击清除选择", async ({
  page,
}) => {
  const state = await fixture(page);
  await header(page, "颜色").click();
  await header(page, "在仓库存数").click({ modifiers: ["Shift"] });
  expect(await selectedNames(page)).toEqual(["颜色", "尺码", "在仓库存数"]);
  await page.keyboard.press("Escape");
  expect(await selectedNames(page)).toEqual([]);

  await header(page, "颜色").click();
  await header(page, "在仓库存数").click({ modifiers: ["Shift"] });
  await dataRows(page).first().locator("td").first().click();
  expect(await selectedNames(page)).toEqual([]);

  await header(page, "在仓库存数").click();
  await header(page, "颜色").click({ modifiers: ["Shift"] });
  await header(page, "尺码").click({ button: "right" });
  await expect(menuItem(page, "固定所选 3 列")).toBeVisible();
  await page.screenshot({
    path: ".local/inventory-column-pinning-preview-20261017.png",
    animations: "disabled",
    caret: "hide",
  });
  await menuItem(page, "固定所选 3 列").click();
  expect(await fixedNames(page)).toEqual(["颜色", "尺码", "在仓库存数"]);

  // Right-clicking an unselected header acts only on that column.
  await header(page, "款号").click();
  await header(page, "货号").click({ modifiers: ["ControlOrMeta"] });
  await header(page, "商品编码").click({ button: "right" });
  expect(await selectedNames(page)).toEqual(["商品编码"]);
  await menuItem(page, "固定此列").click();
  expect(await fixedNames(page)).toEqual([
    "商品编码",
    "颜色",
    "尺码",
    "在仓库存数",
  ]);

  await header(page, "尺码").click({ button: "right" });
  await expect(menuItem(page, "固定此列")).toHaveCount(0);
  await menuItem(page, "取消固定此列").click();
  expect(await fixedNames(page)).toEqual(["商品编码", "颜色", "在仓库存数"]);

  await header(page, "颜色").click();
  await header(page, "采购在途数").click({ modifiers: ["ControlOrMeta"] });
  await header(page, "颜色").click({ button: "right" });
  await expect(menuItem(page, "固定所选 2 列")).toBeVisible();
  await expect(menuItem(page, "取消固定所选 2 列")).toBeVisible();
  await menuItem(page, "取消固定所选 2 列").click();
  expect(await fixedNames(page)).toEqual(["商品编码", "在仓库存数"]);

  await page.reload();
  await expect(dataRows(page)).toHaveCount(2);
  expect(await fixedNames(page)).toEqual(["商品编码", "在仓库存数"]);
  await (await cells(page, "颜色")).body.click({ button: "right" });
  await menuItem(page, "取消所有固定列").click();
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

test("固定总宽超出窗口时阻止固定，已保存固定在窄窗口暂时停用并可恢复", async ({
  page,
}) => {
  const state = await fixture(page);
  await header(page, "图片").click();
  await header(page, "补货建议").click({ modifiers: ["Shift"] });
  expect(await selectedNames(page)).toEqual(allHeaders);
  await header(page, "款号").click({ button: "right" });
  await menuItem(page, `固定所选 ${allHeaders.length} 列`).click();
  await expect(
    page.getByText("固定列总宽超过当前可视区域，请减少选中列后再固定", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await fixedNames(page)).toEqual([]);
  expect(await selectedNames(page)).toEqual(allHeaders);
  await page.keyboard.press("Escape");
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
  await header(page, "颜色").click({ button: "right" });
  await expect(menuItem(page, "窗口较窄，固定暂时停用")).toBeVisible();
  await expect(menuItem(page, "取消固定此列")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect
    .poll(() => fixedNames(page))
    .toEqual(["款号", "货号", "供应商款式编码", "颜色", "在仓库存数"]);
  expect(state.writes).toEqual([]);
});

async function dragHeaders(page: Page, from: string, to: string, ctrl = false) {
  const start = (await header(page, from).boundingBox())!,
    end = (await header(page, to).boundingBox())!;
  if (ctrl) await page.keyboard.down("ControlOrMeta");
  await page.mouse.move(start.x + 12, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + 12, end.y + end.height / 2, { steps: 8 });
}

async function releaseDrag(page: Page, ctrl = false) {
  await page.mouse.up();
  if (ctrl) await page.keyboard.up("ControlOrMeta");
}

test("按住鼠标拖过表头连续选列，Ctrl/⌘ 拖动追加范围，右键固定所选列", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const state = await fixture(page);
  await dragHeaders(page, "颜色", "货号");
  // Live highlight while the mouse button is still held.
  await expect.poll(() => selectedNames(page)).toEqual([
    "货号",
    "商品编码",
    "供应商款式编码",
    "颜色",
  ]);
  await releaseDrag(page);
  expect(await selectedNames(page)).toEqual([
    "货号",
    "商品编码",
    "供应商款式编码",
    "颜色",
  ]);
  expect(
    await page.evaluate(() => window.getSelection()?.toString() ?? ""),
  ).toBe("");

  // A plain drag replaces the selection; Ctrl/⌘ + drag adds its range.
  await dragHeaders(page, "尺码", "在仓库存数");
  await releaseDrag(page);
  expect(await selectedNames(page)).toEqual(["尺码", "在仓库存数"]);
  await header(page, "款号").click({ modifiers: ["ControlOrMeta"] });
  await dragHeaders(page, "商品编码", "货号", true);
  await expect
    .poll(() => selectedNames(page))
    .toEqual(["款号", "货号", "商品编码", "尺码", "在仓库存数"]);
  await page.screenshot({
    path: ".local/inventory-column-drag-select-20261017.png",
    animations: "disabled",
    caret: "hide",
  });
  await releaseDrag(page, true);
  await header(page, "尺码").click({ button: "right" });
  await menuItem(page, "固定所选 5 列").click();
  expect(await fixedNames(page)).toEqual([
    "款号",
    "货号",
    "商品编码",
    "尺码",
    "在仓库存数",
  ]);
  expect(await selectedNames(page)).toEqual([]);

  // Dragging back onto the starting header keeps a single-column selection.
  await dragHeaders(page, "颜色", "供应商款式编码");
  const color = (await header(page, "颜色").boundingBox())!;
  await page.mouse.move(color.x + 12, color.y + color.height / 2, {
    steps: 4,
  });
  await releaseDrag(page);
  expect(await selectedNames(page)).toEqual(["颜色"]);
  await page.keyboard.press("Escape");
  expect(await selectedNames(page)).toEqual([]);
  expect(state.writes).toEqual([]);
});

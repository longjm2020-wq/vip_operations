import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";

const table = (page: Page) => page.locator(".inventory-summary-table");
const choice = (page: Page, label: string, state: string) =>
  page
    .getByRole("group", { name: `${label}筛选` })
    .getByRole("button", { name: new RegExp(`^${label}：${state}（`) });
async function fixture(page: Page) {
  const requests: URLSearchParams[] = [],
    writes: string[] = [];
  const source = Array.from({ length: 60 }, (_, index) => {
    const style = Math.floor(index / 2);
    return {
      id: `sku:${index + 1}`,
      styleNo: `STYLE-${String(style + 1).padStart(2, "0")}`,
      skuCode: `000${index + 1}`,
      barcode: `000${index + 1}`,
      articleNo: `ART-${style + 1}`,
      colorName: "粉色",
      sizeName: index % 2 ? "L" : "M",
      physicalQty: 1,
      barcodeListingState:
        style < 10 || (style < 20 && index % 2 === 0)
          ? "LISTED"
          : style < 28
            ? "UNLISTED"
            : "UNPUBLISHED",
      styleListingState:
        style < 10
          ? "LISTED"
          : style < 20
            ? "PARTIAL"
            : style < 28
              ? "UNLISTED"
              : "UNPUBLISHED",
    };
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() !== "GET") writes.push(request.method());
    if (url.pathname.endsWith("/auth/me"))
      return route.fulfill({
        json: {
          data: {
            id: "status-card-reader",
            username: "reader",
            displayName: "库存查看",
            permissions: ["inventory.read"],
            roleCodes: [],
            csrfToken: "fixture",
          },
        },
      });
    if (!url.pathname.endsWith("/inventory/summary"))
      return route.fulfill({ json: { data: [], total: 0 } });
    const params = url.searchParams;
    requests.push(params);
    const scope = source.filter((row) =>
      row.styleNo.includes(params.get("q") || ""),
    );
    const styleRows = [
      ...new Map(scope.map((row) => [row.styleNo, row])).values(),
    ];
    const count = (
      rows: typeof source,
      field: "barcodeListingState" | "styleListingState",
      state: string,
    ) => rows.filter((row) => row[field] === state).length;
    const listingCounts = {
      barcode: {
        total: scope.length,
        other: 0,
        LISTED: count(scope, "barcodeListingState", "LISTED"),
        UNLISTED: count(scope, "barcodeListingState", "UNLISTED"),
        UNPUBLISHED: count(scope, "barcodeListingState", "UNPUBLISHED"),
      },
      style: {
        total: styleRows.length,
        other: 0,
        LISTED: count(styleRows, "styleListingState", "LISTED"),
        UNLISTED: count(styleRows, "styleListingState", "UNLISTED"),
        PARTIAL: count(styleRows, "styleListingState", "PARTIAL"),
        UNPUBLISHED: count(styleRows, "styleListingState", "UNPUBLISHED"),
      },
    };
    let filtered = scope.filter(
      (row) =>
        (!params.has("barcodeState") ||
          row.barcodeListingState === params.get("barcodeState")) &&
        (!params.has("styleState") ||
          row.styleListingState === params.get("styleState")),
    );
    const stock = filtered.length;
    if (params.get("dimension") !== "sku")
      filtered = [
        ...new Map(
          filtered.map((row) => [
            row.styleNo,
            {
              ...row,
              physicalQty: filtered.filter(
                (item) => item.styleNo === row.styleNo,
              ).length,
            },
          ]),
        ).values(),
      ];
    const current = Number(params.get("page") || 1);
    return route.fulfill({
      json: {
        data: filtered.slice((current - 1) * 20, current * 20),
        total: filtered.length,
        page: current,
        pageSize: 20,
        listingCounts,
        totals: {
          physicalQty: stock,
          inTransitQty: 0,
          transferTransitQty: 0,
          incomingQty: 0,
        },
      },
    });
  });
  await page.goto("/operations/vip/inventory");
  await expect(choice(page, "条码状态", "上线")).toBeEnabled();
  return { requests, writes };
}

test("状态卡片显示全量数量，组合筛选重置分页，导出与筛选总计一致，点击与键盘可取消", async ({
  page,
}) => {
  const state = await fixture(page);
  await expect(table(page).locator("tr[data-row-key]")).toHaveCount(20);
  await expect(choice(page, "条码状态", "上线")).toContainText("30");
  await expect(choice(page, "款号状态", "部分上线")).toContainText("10");
  await table(page).locator('.ant-pagination-item[title="2"]').click();
  await expect.poll(() => state.requests.at(-1)?.get("page")).toBe("2");
  await choice(page, "条码状态", "上线").click();
  await expect
    .poll(() => Object.fromEntries(state.requests.at(-1)!))
    .toMatchObject({ page: "1", barcodeState: "LISTED" });
  await choice(page, "款号状态", "部分上线").click();
  await expect(choice(page, "条码状态", "上线")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(choice(page, "款号状态", "部分上线")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(table(page).locator("tr[data-row-key]")).toHaveCount(10);
  await expect(choice(page, "条码状态", "上线")).toContainText("30");
  await expect(
    table(page).getByRole("row", { name: "当前筛选库存总计" }),
  ).toContainText("10");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile((await (await downloaded).path())!);
  const sheet = book.worksheets[0],
    labels = sheet.getRow(1).values as string[];
  expect(sheet.rowCount).toBe(12);
  expect(
    Number(sheet.getRow(2).getCell(labels.indexOf("在仓库存数")).value),
  ).toBe(10);
  expect(
    sheet.getRow(3).getCell(labels.indexOf("平台状态口径")).value,
  ).toContain("条码状态筛选：上线");
  await page.screenshot({
    path: ".local/inventory-status-cards-preview.png",
    animations: "disabled",
  });
  await choice(page, "条码状态", "上线").click();
  await expect
    .poll(() => state.requests.at(-1)?.has("barcodeState"))
    .toBe(false);
  await expect(table(page).locator("tr[data-row-key]")).toHaveCount(20);
  await choice(page, "款号状态", "部分上线").focus();
  await page.keyboard.press("Enter");
  await expect(choice(page, "款号状态", "部分上线")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(state.writes).toEqual([]);
});

test("无结果时保留卡片可取消，搜索及维度切换保留筛选，小屏卡片不溢出", async ({
  page,
}) => {
  const state = await fixture(page);
  await choice(page, "条码状态", "未发布").click();
  await choice(page, "款号状态", "上线").click();
  await expect(table(page).locator("tr[data-row-key]")).toHaveCount(0);
  await expect(choice(page, "条码状态", "未发布")).toBeEnabled();
  await expect(choice(page, "条码状态", "未发布")).toContainText("4");
  await expect(
    page.getByRole("button", { name: "导出", exact: true }),
  ).toBeDisabled();
  await choice(page, "条码状态", "未发布").click();
  await choice(page, "款号状态", "部分上线").click();
  await page
    .getByRole("textbox", { name: "商品编码 / 货号 / 款号 / 条码" })
    .fill("STYLE-11");
  await expect.poll(() => state.requests.at(-1)?.get("q")).toBe("STYLE-11");
  await expect(choice(page, "款号状态", "部分上线")).toContainText("1");
  await expect(table(page).locator("tr[data-row-key]")).toHaveCount(2);
  await choice(page, "条码状态", "上线").click();
  await page.getByRole("combobox", { name: "库存汇总维度" }).click();
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: /^款号$/ })
    .click();
  await expect
    .poll(() => Object.fromEntries(state.requests.at(-1)!))
    .toMatchObject({
      dimension: "style",
      barcodeState: "LISTED",
      styleState: "PARTIAL",
      q: "STYLE-11",
    });
  await expect(table(page).locator("tr[data-row-key]")).toHaveCount(1);
  await expect(table(page).locator("tr[data-row-key]")).toContainText(
    "部分上线",
  );
  await page.setViewportSize({ width: 760, height: 960 });
  const rects = await page
    .locator(".inventory-status-card")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const r = element.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }),
    );
  expect(rects[1].top).toBeGreaterThanOrEqual(rects[0].bottom);
  expect(rects.every((r) => r.left >= 0 && r.right <= 760)).toBe(true);
  expect(state.writes).toEqual([]);
});

import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";

const platformFields = [
  "条码状态",
  "款号状态",
  "状态核验时间",
  "最后上下架时间",
  "最后上下架操作",
];
const table = (page: Page) => page.locator(".inventory-summary-table");
const header = (page: Page, name: string) =>
  table(page).getByRole("columnheader", { name, exact: true });
const body = (page: Page) => table(page).locator(".ant-table-body");
const names = (page: Page) =>
  table(page).getByRole("columnheader").allTextContents();
async function fixture(page: Page) {
  let user = "inventory-platform-reader";
  const writes: string[] = [];
  await page.route("https://a.vpimg4.com/fixture.jpg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="60"><rect width="40" height="60" fill="orange"/></svg>',
    }),
  );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() !== "GET")
      writes.push(`${request.method()} ${url.pathname}`);
    if (url.pathname.endsWith("/auth/me"))
      return route.fulfill({
        json: {
          data: {
            id: user,
            username: user,
            displayName: "库存查看",
            roleCodes: [],
            permissions: ["inventory.read"],
            csrfToken: "fixture",
          },
        },
      });
    if (url.pathname.endsWith("/inventory/summary"))
      return route.fulfill({
        json: {
          data: [
            {
              id: "sku:1",
              styleNo: "STYLE",
              skuCode: "000001",
              barcode: "001ABC",
              articleNo: "ARTICLE",
              colorName: "粉色",
              sizeName: "M",
              physicalQty: 13,
              mainImageUrl: "https://a.vpimg4.com/fixture.jpg",
              inventoryImage: { source: "vip" },
              barcodeListingState: "LISTED",
              styleListingState: "PARTIAL",
              styleBarcodeCount: 2,
              styleListedCount: 1,
              styleUnlistedCount: 1,
              styleUnknownCount: 0,
              listingScope:
                url.searchParams.get("dimension") === "sku"
                  ? "barcode"
                  : "style",
              listingCheckedAt: "2026-10-21T06:00:00.000Z",
              lastListingChangeAt: "2026-10-20T05:00:00.000Z",
              lastListingChangeType: "LISTED",
            },
          ],
          page: 1,
          pageSize: 20,
          total: 1,
          totals: {
            physicalQty: 13,
            inTransitQty: 0,
            transferTransitQty: 0,
            incomingQty: 0,
          },
        },
      });
    return route.fulfill({ json: { data: [], total: 0 } });
  });
  await page.goto("/operations/vip/inventory");
  await expect(table(page).locator("tr[data-row-key]")).toHaveCount(1);
  return {
    writes,
    setUser: (next: string) => {
      user = next;
    },
  };
}

test("状态分组定位、固定列和总计保持一致，导出中文状态及平台图片", async ({
  page,
}) => {
  const state = await fixture(page);
  await expect(page.getByRole("button", { name: "更新商品状态" })).toHaveCount(
    0,
  );
  await expect(
    table(page).locator(".compass-product-image-thumb"),
  ).toHaveAttribute("src", "https://a.vpimg4.com/fixture.jpg");
  await page.getByRole("tab", { name: "平台状态", exact: true }).click();
  await expect(header(page, "条码状态")).toBeInViewport();
  await expect
    .poll(() => body(page).evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(100);
  await page.getByRole("tab", { name: "全部字段", exact: true }).click();
  await expect.poll(() => body(page).evaluate((el) => el.scrollLeft)).toBe(0);
  await header(page, "款号").click({ button: "right" });
  await page
    .locator(".inventory-column-pinning-menu")
    .getByRole("menuitem")
    .filter({ hasText: /^固定此列$/ })
    .click();
  await page.getByRole("tab", { name: "平台状态", exact: true }).click();
  expect((await names(page)).slice(0, 6)).toEqual(["款号", ...platformFields]);
  await expect(header(page, "款号")).toHaveCSS("position", "sticky");
  const row = table(page).locator("tr[data-row-key]");
  await expect(row.locator("td").nth(1)).toHaveText("上线");
  await expect(row.locator("td").nth(2)).toHaveText("部分上线");
  await expect(
    page.getByRole("row", { name: "当前筛选库存总计" }),
  ).toContainText("13");
  await page.reload();
  await expect(page.getByRole("tab", { name: "平台状态" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect((await names(page)).slice(0, 6)).toEqual(["款号", ...platformFields]);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile((await (await downloaded).path())!);
  const sheet = book.worksheets[0],
    labels = sheet.getRow(1).values as string[];
  const value = (label: string, index = 3) =>
    sheet.getRow(index).getCell(labels.indexOf(label)).value;
  expect(value("条码状态")).toBe("上线");
  expect(value("款号状态")).toBe("部分上线");
  expect(value("最后上下架操作")).toBe("上架");
  expect(String(value("状态核验时间"))).toContain("2026");
  expect(value("图片")).toBe("https://a.vpimg4.com/fixture.jpg");
  expect(value("商品编码")).toBe("000001");
  expect(value("条码状态", 2)).toBe("—");
  expect(labels.indexOf("在仓库存数")).toBeLessThan(labels.indexOf("条码状态"));
  expect(value("平台状态口径")).toContain("全部");
  expect(state.writes).toEqual([]);
});

test("自定义分组保存、取消、调序和删除，按账号及维度独立记忆", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "字段分组", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "配置字段分组" });
  await dialog.getByRole("button", { name: "添加分组", exact: true }).click();
  await dialog.getByRole("textbox", { name: "分组名称4" }).fill("核验");
  await dialog
    .getByRole("combobox", { name: "分组字段4" })
    .fill("状态核验时间");
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: /^状态核验时间$/ })
    .click();
  await page.keyboard.press("Escape");
  await dialog
    .getByRole("button", { name: "上移分组核验", exact: true })
    .click();
  await dialog.getByRole("button", { name: "保存分组", exact: true }).click();
  await expect(dialog).toBeHidden();
  const tabs = page.getByRole("tab", { name: "核验", exact: true });
  await tabs.click();
  await expect(header(page, "状态核验时间")).toBeInViewport();
  await page.reload();
  await expect(tabs).toHaveAttribute("aria-selected", "true");
  await page.getByRole("combobox", { name: "库存汇总维度", exact: true }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: /^货号$/ }).click();
  await expect(tabs).toHaveCount(0);
  await expect(header(page, "条码状态")).toHaveCount(0);
  await page.getByRole("combobox", { name: "库存汇总维度", exact: true }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: /^条码（商品编码）$/ }).click();
  await expect(tabs).toHaveAttribute("aria-selected", "true");
  state.setUser("other-reader");
  await page.reload();
  await expect(tabs).toHaveCount(0);
  state.setUser("inventory-platform-reader");
  await page.reload();
  await expect(tabs).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "字段分组", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "配置字段分组" });
  await dialog.getByRole("textbox", { name: "分组名称3" }).fill("未保存");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(tabs).toBeVisible();
  await expect(page.getByRole("tab", { name: "未保存" })).toHaveCount(0);
  await page.getByRole("button", { name: "字段分组", exact: true }).click();
  await dialog.getByRole("button", { name: "删除分组3", exact: true }).click();
  await dialog.getByRole("button", { name: "保存分组", exact: true }).click();
  await expect(tabs).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "全部字段", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(state.writes).toEqual([]);
});

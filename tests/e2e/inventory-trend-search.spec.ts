import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  const summaries: Record<string, any>[] = [], trends: URLSearchParams[] = [];
  await page.route("**/api/v1/**", route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith("/auth/me")) return route.fulfill({ json: { data: {
      id: "trend-reader", displayName: "趋势测试", permissions: ["inventory.read"], roleCodes: [], csrfToken: "fixture",
    } } });
    if (url.pathname.endsWith("/my-workspace/appearance")) return route.fulfill({ json: { data: { mode: "light", version: 1 } } });
    if (url.pathname.endsWith("/inventory/summary")) {
      summaries.push(request.method() === "POST" ? request.postDataJSON() : Object.fromEntries(url.searchParams));
      const window = { period: "3d", startDate: "2026-10-31", endDate: "2026-11-02", days: 3, coveredDays: 3, complete: true };
      return route.fulfill({ json: { data: [{ id: "sku:1", skuId: "1", styleNo: "XFA16X31196L", skuCode: "000000012345678901234", barcode: "000123", colorName: "粉色", sizeName: "L",
        physicalQty: 39, calculated1: 41, channelReference: { window, salesQty: 11, recordedDays: 3, barcode: "000123" }, barcodeListingState: "LISTED", styleListingState: "LISTED" }],
        total: 1, totals: { physicalQty: 39, calculated1: 41 },
        calculationFields: [{ id: "1", key: "calculated1", name: "在仓可用库存", formula: "[实际库存数]+[销退仓库存]", revision: 1, ownerName: "趋势测试", ownerId: "trend-reader", hidden: false }],
        reportCoverage: { window, matched: 1, total: 1 },
        stockSourceInfo: { warehouseName: "序缇杭州总仓", finishedAt: "2026-11-02T03:00:00Z", receivedCount: 1, requestedCount: 1 },
      } });
    }
    if (url.pathname.endsWith("/inventory/trend")) {
      trends.push(url.searchParams);
      return route.fulfill({ json: { data: { startDate: "2026-10-31", endDate: "2026-11-02", warehouseName: "序缇杭州总仓",
        field: { id: "1", name: "在仓可用库存", formula: "[实际库存数]+[销退仓库存]", revision: 1 },
        periodSalesQty: 11, coverage: { days: 3, reportDays: 3, salesDays: 3, stockDays: 2 },
        points: [
          { date: "2026-10-31", salesQty: 0, salesState: "RECORDED", stockQty: null, stockState: "NO_SNAPSHOT", stockDelta: null, snapshotAt: null, sourceFile: "original.xlsx" },
          { date: "2026-11-01", salesQty: 4, salesState: "RECORDED", stockQty: 45, stockState: "RECORDED", stockDelta: null, snapshotAt: "2026-11-01T08:00:00Z", sourceFile: "original.xlsx" },
          { date: "2026-11-02", salesQty: 7, salesState: "RECORDED", stockQty: 41, stockState: "RECORDED", stockDelta: -4, snapshotAt: "2026-11-02T03:00:00Z", sourceFile: "original.xlsx" },
        ],
      } } });
    }
    return route.fulfill({ json: { data: [], total: 0 } });
  });
  return { summaries, trends };
}

test("period sales opens lazy SKU history with formula, gaps, zero and Beijing times", async ({ page }) => {
  const f = await fixture(page);
  await page.goto("/operations/vip/inventory");
  await page.getByRole("tab", { name: "经营参考", exact: true }).click();
  expect(f.trends).toHaveLength(0);
  await page.getByRole("button", { name: "查看000000012345678901234每日销量与库存趋势" }).click();
  const dialog = page.getByRole("dialog", { name: "每日销量与库存趋势" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("粉色", { exact: false }).first()).toBeVisible();
  await expect(dialog.getByRole("img", { name: "每日销量趋势图" })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "在仓可用库存趋势图" })).toBeVisible();
  await expect(dialog.getByText("无当日快照", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "2026-10-31 每日销量 0件" })).toBeVisible();
  await expect(dialog.getByText("-4", { exact: true })).toBeVisible();
  await expect(dialog.getByText("2026/11/2 11:00:00", { exact: true })).toBeVisible();
  expect(f.trends[0].get("skuId")).toBe("1"); expect(f.trends[0].get("fieldId")).toBe("1");
  expect(f.trends[0].get("period")).toBe("3d"); expect(f.trends[0].get("endDate")).toBe("2026-11-02");
  await page.screenshot({ path: test.info().outputPath("inventory-trend.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Close", exact: true }).or(dialog.getByRole("button", { name: "关闭", exact: true })).click();
});

test("batch paste preserves identifiers and filters, deduplicates and clears without stale queries", async ({ page }) => {
  const f = await fixture(page);
  await page.goto("/operations/vip/inventory");
  const search = page.getByRole("textbox", { name: "商品编码 / 货号 / 款号 / 条码" });
  await search.fill("old-search");
  await expect.poll(() => f.summaries.at(-1)?.q).toBe("old-search");
  await search.evaluate(element => {
    const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", "000000012345678901234\nXFA16X31196L\n000000012345678901234");
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  });
  const dialog = page.getByRole("dialog", { name: "批量查询库存" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("去重后 2 个编码", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "查询", exact: true }).click();
  await expect.poll(() => f.summaries.at(-1)?.codes).toEqual(["000000012345678901234", "XFA16X31196L"]);
  await expect(search).toHaveValue("");
  await expect(search).toHaveAttribute("placeholder", "已选择 2 个编码");
  // Let the input debounce settle after clearing the previous single keyword.
  await page.waitForTimeout(700);
  expect(f.summaries.at(-1)?.codes).toEqual(["000000012345678901234", "XFA16X31196L"]);
  expect(f.summaries.at(-1)?.q).toBeUndefined();
  await page.getByRole("button", { name: "清空批量查询" }).click();
  await expect(search).toHaveAttribute("placeholder", "商品编码 / 货号 / 款号 / 条码");
  await search.fill("next-search");
  await expect.poll(() => f.summaries.at(-1)?.q).toBe("next-search");
  expect(f.summaries.at(-1)?.codes).toBeUndefined();
});

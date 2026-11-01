import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";

async function fixture(page: Page, manager = true) {
  const summaryRequests: URLSearchParams[] = [], writes: string[] = [], images: string[] = [];
  const job = { namespace: "vip-fixture", status: "SUCCESS", checked: 5000, total: 5000,
    unresolved: 0, heartbeatAt: new Date().toISOString(), lastSuccessAt: "2026-10-31T07:00:00Z", lastError: "" };
  await page.addInitScript(() => {
    localStorage.setItem("inventory-fixed-columns-v1:inventory-update:sku", JSON.stringify(["mainImageUrl", "colorName", "sizeName"]));
  });
  await page.route("https://inventory-images.example/**", (route) => {
    images.push(route.request().url());
    return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="66"><rect width="56" height="66" fill="#445ee9"/></svg>' });
  });
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() !== "GET") writes.push(url.pathname);
    if (url.pathname.endsWith("/auth/me")) return route.fulfill({ json: { data: {
      id: "inventory-update", username: "reader", displayName: "库存测试", csrfToken: "fixture", roleCodes: [],
      permissions: ["inventory.read", ...(manager ? ["vip.settings"] : [])],
    } } });
    if (url.pathname.endsWith("/integrations/vip/status")) return route.fulfill({ json: { data: { listing: { jobs: [job] } } } });
    if (url.pathname.endsWith("/integrations/vip/listing/sync")) {
      expect(req.postDataJSON()).toEqual({ namespace: "vip-fixture" });
      job.status = "READY";
      return route.fulfill({ json: { data: { requested: true } } });
    }
    if (url.pathname.endsWith("/inventory/summary")) {
      const params = url.searchParams;
      summaryRequests.push(params);
      const size = Number(params.get("pageSize")), current = Number(params.get("page"));
      return route.fulfill({ json: {
        data: Array.from({ length: Math.min(size, 5000 - (current - 1) * size) }, (_, i) => {
          const index = (current - 1) * size + i + 1;
          return { id: `sku:${index}`, styleNo: `STYLE${index}`, skuCode: `000${index}`, barcode: `000${index}`,
            articleNo: `ARTICLE${index}`, colorName: "蓝色", sizeName: "M", physicalQty: 1,
            inTransitQty: 0, transferTransitQty: 0, incomingQty: 0, reservedQty: 0, returnQty: 0, virtualQty: 0, availableQty: 1,
            mainImageUrl: `https://inventory-images.example/${index}.svg`,
            barcodeListingState: "LISTED", styleListingState: "LISTED", listingCheckedAt: job.lastSuccessAt };
        }),
        total: 5000, totals: { physicalQty: 5000, inTransitQty: 0, transferTransitQty: 0, incomingQty: 0, availableQty: 5000 },
        stockSourceInfo: { warehouseName: "序缇杭州总仓", finishedAt: new Date().toISOString(), receivedCount: 5000, requestedCount: 5000, intervalMinutes: 60 },
      } });
    }
    return route.fulfill({ json: { data: [], total: 0 } });
  });
  await page.route("**/api/v1/my-workspace/appearance", route => route.fulfill({ json: { data: { mode: "light", version: 1 } } }));
  return { job, summaryRequests, writes, images };
}

async function pageSize(page: Page, size: number) {
  await page.getByRole("combobox", { name: "每页条数" }).click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
    .filter({ hasText: new RegExp(`^${size}\\s*条/页$`) }).click();
}

test("5000条只渲染可见行，末尾可达，固定列、分组、总计和完整当前页导出可用", async ({ page }) => {
  const f = await fixture(page);
  await page.goto("/operations/vip/inventory");
  await expect(page.getByRole("button", { name: "导入网站库存" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "库存数据来源" })).toHaveCount(0);
  const expectBottomFilled = async () => {
    await expect.poll(() => page.locator(".inventory-details-card").evaluate(element =>
      Math.abs(element.getBoundingClientRect().bottom - window.innerHeight))).toBeLessThan(2);
    await expect(page.getByRole("combobox", { name: "每页条数" })).toBeInViewport();
  };
  await expectBottomFilled();
  await pageSize(page, 5000);
  const table = page.locator(".inventory-summary-table"), rows = table.locator(".ant-table-row[data-row-key]");
  const holder = table.locator(".ant-table-tbody-virtual-holder");
  await expect(holder).toBeVisible();
  await expectBottomFilled();
  await expect.poll(() => rows.count()).toBeGreaterThan(0);
  expect(await rows.count()).toBeLessThan(80);
  expect(f.images.length).toBeLessThan(100);
  await expect(table.locator(".inventory-total-row").first()).toContainText("5,000");
  await holder.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(table.locator('[data-row-key="sku:5000"]')).toBeVisible();
  expect(await rows.count()).toBeLessThan(80);
  await page.getByRole("tab", { name: "平台状态", exact: true }).click();
  await expect(table.getByRole("columnheader", { name: "条码状态", exact: true })).toBeInViewport();
  await expect(table.locator('[data-row-key="sku:5000"] .ant-table-cell-fix-start')).not.toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("inventory-5000-virtual.png") });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const file = await download, book = new ExcelJS.Workbook();
  await book.xlsx.readFile((await file.path())!);
  const sheet = book.worksheets[0];
  expect(sheet.rowCount).toBe(5002);
  expect(sheet.getRow(5002).values).toContain("0005000");
  await table.getByRole("columnheader", { name: "图片", exact: true }).click({ button: "right" });
  await page.locator(".inventory-column-pinning-menu").getByRole("menuitem").filter({ hasText: /^取消所有固定列$/ }).click();
  await page.getByRole("tab", { name: "全部字段", exact: true }).click();
  await page.getByRole("tab", { name: "平台状态", exact: true }).click();
  await expect(table.getByRole("columnheader", { name: "条码状态", exact: true })).toBeInViewport();
  const last = table.locator('[data-row-key="sku:5000"]');
  const stateIndex = (await table.getByRole("columnheader").allTextContents()).indexOf("条码状态");
  const headerBox = await table.getByRole("columnheader", { name: "条码状态", exact: true }).boundingBox();
  const cellBox = await last.getByRole("cell").nth(stateIndex).boundingBox();
  expect(Math.abs(headerBox!.x - cellBox!.x)).toBeLessThan(2);
  await pageSize(page, 20);
  await expect(table.locator(".ant-table-body tr[data-row-key]")).toHaveCount(20);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expectBottomFilled();
  await page.getByRole("button", { name: "收起工作区导航", exact: true }).click();
  await page.setViewportSize({ width: 1920, height: 922 });
  await expectBottomFilled();
  await page.screenshot({ path: test.info().outputPath("inventory-bottom-filled.png") });
  expect(f.summaryRequests.every((p) => p.get("stockSource") === "jushuitan")).toBe(true);
});

test("平台状态提交后台核验，完成后刷新；排队期间不能重复提交", async ({ page }) => {
  const f = await fixture(page);
  await page.goto("/operations/vip/inventory");
  await page.getByRole("button", { name: "同步平台状态", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "唯品会平台状态同步" });
  await panel.getByRole("button", { name: "立即同步", exact: true }).click();
  await expect(panel.getByText("等待同步", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "立即同步", exact: true })).toBeDisabled();
  expect(f.writes).toEqual(["/api/v1/integrations/vip/listing/sync"]);
  const before = f.summaryRequests.length;
  f.job.status = "SUCCESS";
  f.job.lastSuccessAt = new Date().toISOString();
  await expect.poll(() => f.summaryRequests.length, { timeout: 10000 }).toBeGreaterThan(before);
  await expect(panel.getByText("同步完成", { exact: true })).toBeVisible();
});

test("核验失败保留具体错误，离线及只读账号不能提交", async ({ page }) => {
  const f = await fixture(page);
  await page.goto("/operations/vip/inventory");
  await page.getByRole("button", { name: "同步平台状态", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "唯品会平台状态同步" });
  await panel.getByRole("button", { name: "立即同步", exact: true }).click();
  await expect(panel.getByText("等待同步", { exact: true })).toBeVisible();
  f.job.status = "BLOCKED"; f.job.lastError = "VOP_PERMISSION_DENIED";
  f.job.heartbeatAt = "2026-10-01T00:00:00Z";
  await expect(panel.getByText(/核验未完成：VOP_PERMISSION_DENIED/)).toBeVisible({ timeout: 10000 });
  await expect(panel.getByRole("button", { name: "立即同步", exact: true })).toBeDisabled();
  await page.unroute("**/api/v1/**");
  const reader = await fixture(page, false);
  await page.reload();
  await expect(page.getByRole("button", { name: "同步平台状态", exact: true })).toBeDisabled();
  expect(reader.writes).toEqual([]);
});

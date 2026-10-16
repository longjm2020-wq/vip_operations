import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";

async function fixture(page: Page) {
  const writes: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(`${request.method()} ${path}`);
    if (path.endsWith("/auth/me")) return route.fulfill({ json: { data: {
      id: "excel-recovery-user", username: "excel-recovery-user", displayName: "读取验证",
      csrfToken: "fixture", roleCodes: [], permissions: ["inventory.read", "product.update"],
    } } });
    return route.fulfill({ json: { data: [], total: 0, totals: {
      physicalQty: 0, inTransitQty: 0, transferTransitQty: 0, incomingQty: 0,
    } } });
  });
  await page.goto("/operations/vip/inventory");
  await page.getByRole("button", { name: "导入", exact: true }).click();
  return writes;
}

async function workbookFile() {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("数据").addRows([["商品编码", "颜色"], ["EXCEL-RETRY-001", "蓝色"]]);
  return { name: "保留文件重试.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(await book.xlsx.writeBuffer()) };
}

test("Excel组件两次加载失败后保留同一个文件，重新读取恢复且不自动保存", async ({ page }) => {
  let blocked = true;
  const requests: string[] = [];
  await page.route(/\/vendor\/exceljs(?:\/|\-compat\.js)/, async (route) => {
    requests.push(route.request().url());
    return blocked ? route.abort("failed") : route.continue();
  });
  const writes = await fixture(page);
  const panel = page.getByRole("dialog", { name: "从 Excel 导入库存资料", exact: true });
  await panel.locator('input[type="file"]').setInputFiles(await workbookFile());
  await expect(panel.getByText(/已保留所选文件/)).toBeVisible();
  await expect(panel.getByText("文件：保留文件重试.xlsx", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "确认导入", exact: true })).toBeDisabled();
  expect(requests).toHaveLength(2);
  expect(new URL(requests[0]).pathname).toBe("/vendor/exceljs/4.4.0/exceljs-browser.js");
  expect(new URL(requests[1]).pathname).toBe("/vendor/exceljs-compat.js");
  blocked = false;
  await panel.getByRole("button", { name: "重新读取文件", exact: true }).click();
  await expect(panel.getByText("共 1 行，更新列：颜色", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "确认导入", exact: true })).toBeEnabled();
  expect(requests).toHaveLength(3);
  expect(requests[2]).not.toBe(requests[1]);
  expect(writes).toEqual([]);
});

test("旧页面ExcelJS哈希模块兼容两种旧命名空间，真实Workbook可以读取XLSX", async ({ page }) => {
  const writes = await fixture(page);
  const file = await workbookFile();
  const result = await page.evaluate(async (bytes) => {
    // This import is intentionally a deleted release filename, just like a tab
    // left open across deployments. No current application chunk is imported.
    const moduleUrl = "/assets/exceljs.min-PreviousReleaseHash.js";
    const legacy = await import(moduleUrl);
    const book = new legacy.e.default.Workbook();
    await book.xlsx.load(new Uint8Array(bytes));
    return { defaultWorkbook: typeof legacy.default.Workbook,
      namespaceWorkbook: typeof legacy.e.default.Workbook,
      value: book.worksheets[0].getCell("A2").text };
  }, [...file.buffer]);
  expect(result).toEqual({ defaultWorkbook: "function", namespaceWorkbook: "function", value: "EXCEL-RETRY-001" });
  const response = await page.request.get("/assets/exceljs.min-PreviousReleaseHash.js");
  expect(response.headers()["content-type"]).toContain("javascript");
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(writes).toEqual([]);
});

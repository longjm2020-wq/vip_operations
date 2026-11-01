import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { evaluateInventoryFormula, parseInventoryFormula, type InventoryCalculationField } from "../../packages/contracts/src/inventory-formula.js";

async function fixture(page: Page, manager = true) {
  const summaryRequests: URLSearchParams[] = [], writes: string[] = [], images: string[] = [];
  const fields: InventoryCalculationField[] = [];
  let nextFieldId = 1;
  const source = { warehouseName: "序缇杭州总仓", finishedAt: new Date().toISOString(), receivedCount: 5000, requestedCount: 5000, intervalMinutes: 60, errorNote: "" };
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
      permissions: ["inventory.read", "analytics.read", "selection.read", "product.read", ...(manager ? ["vip.settings"] : [])],
    } } });
    if (url.pathname.endsWith("/integrations/vip/status")) return route.fulfill({ json: { data: { listing: { jobs: [job] } } } });
    if (url.pathname.endsWith("/integrations/vip/listing/sync")) {
      expect(req.postDataJSON()).toEqual({ namespace: "vip-fixture" });
      job.status = "READY";
      return route.fulfill({ json: { data: { requested: true } } });
    }
    if (url.pathname.includes("/inventory/calculation-fields")) {
      if (req.method() === "POST") {
        const body = req.postDataJSON(), found = fields.find(f => f.id === body.id);
        const view = url.pathname.endsWith("/view");
        if (found && (view ? found.viewRevision : found.revision) !== body.revision) return route.fulfill({ status: 409, json: { error: { message: "字段已被修改，请重新读取后编辑" } } });
        if (view && found) { found.hidden = body.hidden; found.viewRevision++; }
        else if (url.pathname.endsWith("/delete") && found) fields.splice(fields.indexOf(found), 1);
        else if (found) Object.assign(found, body, { revision: found.revision + 1 });
        else { const id = String(nextFieldId++); fields.push({ ...body, id, key: `calculated${id}`, revision: 1, hidden: false, viewRevision: 0, canManage: true, ownerId: "inventory-update", ownerName: "库存测试" }); }
      }
      return route.fulfill({ json: { data: fields } });
    }
    if (url.pathname.endsWith("/inventory/summary")) {
      const params = url.searchParams;
      summaryRequests.push(params);
      const size = Number(params.get("pageSize")), current = Number(params.get("page"));
      const visibleFields = fields.filter(f => !f.hidden);
      const calculated = Object.fromEntries(visibleFields.map(f => [f.key, evaluateInventoryFormula(parseInventoryFormula(f.formula),
        { physicalQty: 1, returnQty: 0, incomingQty: 0, reservedQty: 0, inTransitQty: 0, transferTransitQty: 0 })]));
      return route.fulfill({ json: {
        data: Array.from({ length: Math.min(size, 5000 - (current - 1) * size) }, (_, i) => {
          const index = (current - 1) * size + i + 1;
          return { id: `sku:${index}`, styleNo: `STYLE${index}`, skuCode: `000${index}`, barcode: `000${index}`,
            articleNo: `ARTICLE${index}`, colorName: "蓝色", sizeName: "M", physicalQty: 1, ...calculated,
            inTransitQty: 0, transferTransitQty: 0, incomingQty: 0, reservedQty: 0, returnQty: 0, virtualQty: 0, availableQty: 1,
            mainImageUrl: `https://inventory-images.example/${index}.svg`,
            barcodeListingState: "LISTED", styleListingState: "LISTED", listingCheckedAt: job.lastSuccessAt };
        }),
        total: 5000, totals: { physicalQty: 5000, inTransitQty: 0, transferTransitQty: 0, incomingQty: 0, availableQty: 5000, ...Object.fromEntries(Object.entries(calculated).map(([key, value]) => [key, value == null ? null : value * 5000])) },
        stockSourceInfo: source, calculationFields: visibleFields,
        listingCounts: { barcode: { total: 5000, other: 0, LISTED: 983, UNLISTED: 3885, UNPUBLISHED: 132 }, style: { total: 1255, other: 0, LISTED: 148, UNLISTED: 921, PARTIAL: 162, UNPUBLISHED: 24 } },
      } });
    }
    return route.fulfill({ json: { data: [], total: 0 } });
  });
  await page.route("**/api/v1/my-workspace/appearance", route => route.fulfill({ json: { data: { mode: "light", version: 1 } } }));
  return { job, summaryRequests, writes, images, fields, source };
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
  expect(sheet.getRow(1).values).not.toContain("虚拟库存");
  expect(sheet.getRow(1).values).not.toContain("可用数");
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

test("多计算字段可编辑、公开、隐藏和删除；保存后跨刷新恢复并用于导出", async ({ page }) => {
  const f = await fixture(page);
  await page.goto("/operations/vip/inventory");
  const table = page.locator(".inventory-summary-table");
  await expect(table.getByRole("columnheader", { name: "实际库存数", exact: true })).toBeVisible();
  const headers = await table.getByRole("columnheader").allTextContents();
  expect(headers).not.toContain("虚拟库存"); expect(headers).not.toContain("可用数");
  await page.getByRole("button", { name: "计算字段配置", exact: true }).click();
  const panel = page.locator(".ant-drawer:visible"), input = panel.getByRole("textbox", { name: "计算公式", exact: true });
  await panel.getByRole("button", { name: "新增字段", exact: true }).click();
  await panel.getByRole("textbox", { name: "字段名称" }).fill("在仓总库存");
  await panel.getByRole("button", { name: "实际库存数", exact: true }).click();
  await panel.getByRole("button", { name: "插入 +", exact: true }).click();
  await panel.getByRole("button", { name: "销退仓库存", exact: true }).click();
  await expect(input).toHaveValue("[实际库存数] + [销退仓库存]");
  await input.fill("([实际库存数]+[销退仓库存]");
  await expect(panel.getByRole("button", { name: "保存并重算" })).toBeDisabled();
  const formula = "([实际库存数]+[销退仓库存]+2)*3/2";
  await input.fill(formula);
  await expect(panel.locator(".ant-table-tbody tr").first()).toContainText("4.5");
  await panel.getByRole("button", { name: "保存并重算" }).click();
  const totalField = panel.getByRole("region", { name: "计算字段：在仓总库存", exact: true });
  await expect(totalField).toBeVisible();
  await panel.getByRole("button", { name: "新增在仓可用库存", exact: true }).click();
  await expect(input).toHaveValue("[实际库存数] + [销退仓库存] + [进货仓库存] - [订单占有数]");
  await panel.getByRole("button", { name: "保存并重算" }).click();
  const available = panel.getByRole("region", { name: "计算字段：在仓可用库存", exact: true });
  await expect(available.getByText("不公开", { exact: true })).toBeVisible();
  await available.getByRole("button", { name: "公开字段", exact: true }).click();
  await expect(available.getByText("公开", { exact: true })).toBeVisible();
  await available.getByRole("button", { name: "设为不公开", exact: true }).click();
  await expect(available.getByText("不公开", { exact: true })).toBeVisible();
  await totalField.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(input).toHaveValue(formula);
  await panel.getByRole("textbox", { name: "字段名称" }).fill("在仓总量");
  await panel.getByRole("button", { name: "保存并重算" }).click();
  await expect(panel.getByRole("region", { name: "计算字段：在仓总量", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "关闭", exact: true }).last().click();
  await expect(table.locator('[data-row-key="sku:1"]')).toContainText("4.5");
  await expect(table.locator(".inventory-total-row")).toContainText("22,500");
  const nextHeaders = await table.getByRole("columnheader").allTextContents();
  expect(nextHeaders.slice(nextHeaders.indexOf("实际库存数") - 2, nextHeaders.indexOf("实际库存数"))).toEqual(["在仓总量", "在仓可用库存"]);
  expect(f.fields[0].formula).toBe(formula);
  await page.reload();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const file = await download, book = new ExcelJS.Workbook();
  await book.xlsx.readFile((await file.path())!);
  const sheet = book.worksheets[0];
  const col = (sheet.getRow(1).values as unknown[]).indexOf("在仓总量");
  expect(sheet.getCell(2, col).value).toBe("22500");
  expect(sheet.getCell(3, col).value).toBe("4.5");
  expect(JSON.stringify(sheet.getRow(3).values)).toContain(formula);
  await page.getByRole("button", { name: "计算字段配置", exact: true }).click();
  await available.getByRole("switch", { name: "显示在仓可用库存" }).click();
  await expect(available.getByRole("switch")).not.toBeChecked();
  await panel.getByRole("button", { name: "关闭", exact: true }).last().click();
  await expect(table.getByRole("columnheader", { name: "在仓可用库存", exact: true })).toHaveCount(0);
  const hiddenDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const hiddenBook = new ExcelJS.Workbook(); await hiddenBook.xlsx.readFile((await (await hiddenDownload).path())!);
  expect(hiddenBook.worksheets[0].getRow(1).values).not.toContain("在仓可用库存");
  expect(JSON.stringify(hiddenBook.worksheets[0].getRow(3).values)).not.toContain("订单占有数]");
  await page.reload();
  await page.getByRole("button", { name: "计算字段配置", exact: true }).click();
  await expect(available.getByRole("switch")).not.toBeChecked();
  await available.getByRole("switch").click();
  await expect(available.getByRole("switch")).toBeChecked();
  await available.getByRole("button", { name: "删除", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "删除“在仓可用库存”？" });
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(available).toBeVisible();
  await available.getByRole("button", { name: "删除", exact: true }).click();
  await confirm.getByRole("button", { name: "删除字段", exact: true }).click();
  await expect(available).toHaveCount(0);
  expect(f.fields).toHaveLength(1);
  expect(f.writes.every(path => path.startsWith("/api/v1/inventory/calculation-fields"))).toBe(true);
});

test("成功提示30秒后收起，同批刷新不反复弹出，新批次及错误仍显示", async ({ page }) => {
  await page.clock.install();
  const f = await fixture(page);
  await page.goto("/operations/vip/inventory");
  const notice = page.locator(".inventory-source-notice");
  await expect(notice).toBeVisible();
  await expect(notice.locator(".ant-alert-description")).toHaveCount(0);
  await expect(notice.locator(".inventory-source-notice-line")).toHaveCSS("white-space", "nowrap");
  await page.clock.fastForward(31_000);
  await expect(notice).toHaveCount(0);
  await page.getByRole("button", { name: /刷新$/ }).click();
  await expect(page.locator('.inventory-summary-table [data-row-key="sku:1"]')).toBeVisible();
  await expect(notice).toHaveCount(0);
  f.source.finishedAt = "2026-11-01T12:00:00Z";
  await page.getByRole("button", { name: /刷新$/ }).click();
  await expect(notice).toBeVisible();
  await page.clock.fastForward(31_000);
  await expect(notice).toHaveCount(0);
  f.source.errorNote = "最新同步未完成，请重新登录聚水潭";
  await page.getByRole("button", { name: /刷新$/ }).click();
  await expect(notice).toContainText(f.source.errorNote);
  await page.clock.fastForward(60_000);
  await expect(notice).toBeVisible();
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

import { expect, test, type Page } from "@playwright/test";

async function fixture(
  page: Page,
  manager = true,
  configured = false,
  mode = "light",
) {
  const now = new Date().toISOString();
  const settings: Record<string, any> = {
    version: 1,
    configured,
    encryptionReady: true,
    enabled: false,
    intervalMinutes: 15,
    warehouseId: configured ? "456" : null,
    warehouseName: configured ? "杭州总仓" : "",
    companyId: configured ? "123" : null,
    verifiedAt: configured ? now : null,
    tokenExpiresAt: null,
    availableRule: null,
    activeRunId: configured ? "run-1" : null,
    warehouses: configured
      ? [{ name: "杭州总仓", wmsCoId: "456", coId: "123" }]
      : [],
    runs: [],
    errorNote: "",
  };
  const saved: any[] = [];
  let pending = false;
  const stock = (external: boolean) =>
    [5, external ? null : 24].map((qty, index) => ({
      id: `sku:${index + 1}`,
      skuCode: index ? "000000012345678901235" : "000000012345678901234",
      styleNo: "XFA16X31196L",
      articleNo: index ? "XFA16X31196L034" : "XFA16X31196L029",
      colorName: index ? "米白色" : "粉色",
      sizeName: "L",
      physicalQty: qty,
      reservedQty: external && index ? null : 0,
      incomingQty: 0,
      inTransitQty: 0,
      transferTransitQty: 0,
      returnQty: 0,
      virtualQty: external ? -1 : 0,
      availableQty: null,
    }));
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname.replace("/api/v1", "");
    let data: any = [];
    if (path === "/auth/me")
      data = {
        id: "1",
        username: "fixture",
        displayName: "测试用户",
        csrfToken: "fixture",
        roleCodes: [manager ? "SUPER_ADMIN" : "ANALYST"],
        permissions: [
          "inventory.read",
          "product.read",
          ...(manager ? ["inventory.adjust"] : []),
        ],
      };
    if (path === "/my-workspace/appearance") data = { mode, version: 1 };
    if (path === "/inventory/jushuitan/settings") {
      const body = route.request().postDataJSON();
      saved.push(body);
      Object.assign(settings, {
        version: settings.version + 1,
        configured: settings.configured || !!body.appKey,
        warehouseId: body.warehouseId,
        warehouseName: body.warehouseId ? "杭州总仓" : "",
        companyId: body.warehouseId ? "123" : null,
        enabled: body.enabled,
        intervalMinutes: body.intervalMinutes,
        availableRule: body.availableRule,
      });
      data = settings;
    }
    if (path === "/inventory/jushuitan/verify") {
      Object.assign(settings, {
        verifiedAt: now,
        warehouses: [{ name: "杭州总仓", wmsCoId: "456", coId: "123" }],
      });
      data = settings;
    }
    if (path === "/inventory/jushuitan/sync") {
      pending = true;
      settings.runs = [
        {
          id: "run-1",
          status: "QUEUED",
          createdAt: now,
          warehouseName: "杭州总仓",
          triggerType: "MANUAL",
          requestedCount: 2,
          processedCount: 0,
          receivedCount: 0,
        },
      ];
      data = { id: "run-1", status: "QUEUED" };
    }
    if (path === "/inventory/jushuitan") data = settings;
    if (path === "/inventory/summary") {
      const external = url.searchParams.get("stockSource") === "jushuitan";
      if (external && !settings.activeRunId)
        return route.fulfill({
          status: 422,
          json: {
            error: {
              message: "聚水潭尚无完整同步数据，请先配置杭州总仓并完成同步",
            },
          },
        });
      return route.fulfill({
        json: {
          data: stock(external),
          total: 2,
          totals: {
            physicalQty: external ? null : 29,
            reservedQty: null,
            incomingQty: 0,
            inTransitQty: 0,
            transferTransitQty: 0,
          },
          stockSource: external ? "jushuitan" : "internal",
          stockSourceInfo: external
            ? {
                warehouseName: "杭州总仓",
                finishedAt: now,
                intervalMinutes: 15,
                receivedCount: 1,
                requestedCount: 2,
                availableRule: null,
              }
            : null,
        },
      });
    }
    await route.fulfill({ json: { data } });
  });
  return {
    saved,
    complete() {
      expect(pending).toBe(true);
      settings.activeRunId = "run-1";
      Object.assign(settings.runs[0], {
        status: "COMPLETE",
        processedCount: 2,
        receivedCount: 1,
        missingCodes: ["000000012345678901235"],
        finishedAt: now,
      });
    },
  };
}

test("管理员依次保存应用、核验杭州总仓并等待完整同步后查看", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/operations/vip/inventory");
  await page.getByRole("button", { name: "聚水潭同步", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "聚水潭库存接入" });
  await expect(
    panel.getByRole("button", { name: "立即同步", exact: true }),
  ).toBeDisabled();
  await panel.getByLabel("App Key", { exact: true }).fill("fixture-key");
  await panel.getByLabel("App Secret", { exact: true }).fill("fixture-secret");
  await panel.getByRole("button", { name: "保存设置" }).click();
  await expect(panel.getByLabel("App Secret", { exact: true })).toHaveValue("");
  await panel.getByRole("button", { name: "验证授权并读取仓库" }).click();
  await panel.getByRole("combobox", { name: "同步仓库" }).click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .getByText("杭州总仓 · 456（公司 123）", { exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "立即同步", exact: true }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "保存设置" }).click();
  await expect(
    panel.getByText("杭州总仓 · 编号 456 · 公司 123", { exact: true }),
  ).toBeVisible();
  expect(f.saved.at(-1)).toMatchObject({
    warehouseId: "456",
    enabled: false,
    availableRule: null,
    appKey: "",
    appSecret: "",
  });
  await panel.getByRole("button", { name: "立即同步", exact: true }).click();
  await expect(panel.getByText("等待同步", { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "查看聚水潭库存" }),
  ).toBeDisabled();
  f.complete();
  await panel.getByRole("button", { name: "刷新状态" }).click();
  await expect(panel.getByText("1 / 2 / 2", { exact: true })).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: test.info().outputPath("jushuitan-settings-light.png"),
  });
  await panel.getByRole("button", { name: "查看聚水潭库存" }).click();
  await expect(panel).not.toBeVisible();
  await expect(page.getByText(/聚水潭 · 杭州总仓 · 完整同步/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "导入网站库存", exact: true }),
  ).toBeVisible();
  const missing = page.locator('.ant-table-body tr[data-row-key="sku:2"]');
  await expect(missing).toContainText("暂无数据");
  await expect(missing).toContainText("待核对口径");
  await expect(page.locator(".inventory-total-row").first()).toContainText(
    "不完整",
  );
});

test("只读账号查看来源和记录，暗色与窄屏均不提供配置操作", async ({ page }) => {
  await fixture(page, false, true, "dark");
  await page.goto("/operations/vip/inventory");
  await page.getByRole("combobox", { name: "库存数据来源" }).click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .getByText("聚水潭库存", { exact: true })
    .click();
  await expect(page.getByText(/聚水潭 · 杭州总仓 · 完整同步/)).toBeVisible();
  await page.getByRole("button", { name: "聚水潭同步", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "聚水潭库存接入" });
  await expect(panel.getByText("请由超级管理员配置或发起同步。")).toBeVisible();
  await expect(panel.getByLabel("App Secret", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "立即同步" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "保存设置" })).toHaveCount(0);
  await page.screenshot({
    animations: "disabled",
    path: test.info().outputPath("jushuitan-readonly-dark.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    panel.getByRole("button", { name: "查看聚水潭库存" }),
  ).toBeVisible();
  const box = await panel.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    animations: "disabled",
    path: test.info().outputPath("jushuitan-mobile.png"),
  });
});

test("无快照时提示接入未完成，不把网站库存当作聚水潭结果", async ({ page }) => {
  await fixture(page);
  await page.goto("/operations/vip/inventory");
  await expect(page.locator(".ant-table-body tr[data-row-key]")).toHaveCount(2);
  await page.getByRole("combobox", { name: "库存数据来源" }).click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .getByText("聚水潭库存", { exact: true })
    .click();
  await expect(
    page.getByText("聚水潭尚无完整同步数据，请先配置杭州总仓并完成同步", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".ant-table-body tr[data-row-key]")).toHaveCount(0);
});

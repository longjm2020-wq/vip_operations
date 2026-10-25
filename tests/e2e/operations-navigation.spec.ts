import { expect, test, type Page } from "@playwright/test";
import { availableWorkspaceTools, workspaceDefaults } from "../../packages/contracts/src/personal-workspace.js";

async function fixture(page: Page, permissions = ["analytics.read", "selection.read", "product.read", "inventory.read", "project.read", "supply.review", "user.read", "vip.settings", "purchase.read", "receipt.read", "supplier.read", "warehouse.read"]) {
  const requests: string[] = [];
  const actor = { id: "nav-user", displayName: "导航验收", roleCodes: ["ADMIN"], permissions, csrfToken: "fixture" };
  await page.route("**/api/v1/**", route => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    requests.push(path);
    let data: unknown = [];
    if (path === "/auth/me") data = actor;
    if (path === "/my-workspace") data = { version: 0, shortcuts: [], todos: [], note: "", defaults: workspaceDefaults(actor), available: availableWorkspaceTools(actor) };
    if (path === "/integrations/vip/status") data = { mode: "disabled", connections: [], detailJobs: [], total: 0, rejected: 0 };
    if (path === "/products/1") data = { id: "1", name: "保留的商品详情", styleNo: "STYLE-001", status: "ACTIVE" };
    return route.fulfill({ json: { data, total: 0 } });
  });
  return requests;
}

test("唯品会 API 图标与平台标签同排，侧栏和页脚移除 ERP 及功能摘要", async ({ page }) => {
  await fixture(page);
  await page.goto("/operations?platform=vip");
  const workspace = page.locator(".operations-workspace");
  await expect(page.locator(".sidebar .ant-menu-root > .ant-menu-item, .sidebar .ant-menu-root > .ant-menu-submenu > .ant-menu-submenu-title")).toHaveText(["我的工作台", "运营中心", "项目协作", "供应链端", "系统设置"]);
  const integration = workspace.getByRole("link", { name: "唯品会接入", exact: true });
  await expect(integration).toHaveAttribute("href", "/operations/vip/integration");
  await expect(integration).toHaveText("");
  await expect(integration.locator("svg")).toBeVisible();
  await expect(page.locator(".sidebar-caption")).toHaveText("内部管理系统");
  await expect(page.locator(".sidebar").getByText("工作区", { exact: true })).toHaveCount(0);
  await expect(page.locator(".page-footer")).toHaveText("XUTI");
  await expect(workspace.getByRole("link", { name: "库存明细", exact: true })).toHaveAttribute("href", "/operations/vip/inventory");
  await expect(workspace.getByRole("link", { name: "商品档案", exact: true })).toHaveAttribute("href", "/products");
  await workspace.getByRole("tab", { name: "淘宝", exact: true }).click();
  await expect(integration).toHaveCount(0);
  await workspace.getByRole("tab", { name: "唯品会", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(integration).toBeInViewport();
  await integration.click();
  await expect(page).toHaveURL(/\/operations\/vip\/integration$/);
  await expect(page.getByRole("heading", { name: "唯品会接入", exact: true })).toBeVisible();
  await expect(page.locator(".topbar")).toContainText("运营中心");
  await expect(page.locator(".topbar").getByRole("link", { name: /唯品会工作区/ })).toHaveAttribute("href", "/operations?platform=vip");
  await expect(page.getByRole("link", { name: "使用手册", exact: true })).toHaveAttribute("href", "/help?chapter=19-vip.md");
});

test("只有接入管理权限也能进入唯品会，无权限不显示图标也不查询接口", async ({ page }) => {
  const requests = await fixture(page, ["vip.settings"]);
  await page.goto("/operations");
  await expect(page.locator(".sidebar").getByRole("link", { name: "运营中心", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "唯品会接入", exact: true })).toBeVisible();
  expect(requests.some(path => path.startsWith("/integrations/vip"))).toBe(false);
  await page.goto("/vip");
  await expect(page).toHaveURL(/\/operations\/vip\/integration$/);
  await expect(page.getByRole("heading", { name: "唯品会接入", exact: true })).toBeVisible();
  await expect.poll(() => requests.includes("/integrations/vip/status")).toBe(true);
});

test("普通运营人员不能使用新接入地址扩大权限", async ({ page }) => {
  const requests = await fixture(page, ["analytics.read"]);
  await page.goto("/operations");
  await expect(page.getByRole("heading", { name: "运营中心", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "唯品会接入", exact: true })).toHaveCount(0);
  await page.goto("/operations/vip/integration");
  await expect(page.getByRole("alert")).toContainText("需要唯品会接入管理权限");
  expect(requests.some(path => path.startsWith("/integrations/vip"))).toBe(false);
});

test("旧 ERP 网址均退出业务页面且不发起旧模块请求", async ({ page }) => {
  const requests = await fixture(page);
  for (const path of ["/erp", "/inventory", "/inventory/transactions?skuId=1", "/purchase-suggestions", "/purchase-orders", "/purchase-orders/new", "/purchase-orders/1", "/receipts", "/receipts/1", "/suppliers", "/warehouses", "/categories", "/brands", "/skus"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/my-workspace$/);
    await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
  }
  expect(requests.filter(path => /^\/(inventory|purchase-orders|purchase-suggestions|receipts|suppliers|warehouses|categories|brands|skus)(\/|$)/.test(path))).toEqual([]);
});

test("商品详情保留 SKU 与库存，移除采购页签和旧流水入口", async ({ page }) => {
  await fixture(page);
  await page.goto("/products/1");
  await expect(page.getByRole("heading", { name: "保留的商品详情", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "SKU", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "库存", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "采购", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "库存", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "流水", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "唯品会信息", exact: true }).click();
  await expect(page.getByRole("link", { name: "查看唯品会接入", exact: true })).toHaveAttribute("href", "/operations/vip/integration");
});

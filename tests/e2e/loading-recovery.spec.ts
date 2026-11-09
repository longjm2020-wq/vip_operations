import { expect, test, type Page } from "@playwright/test";

type Fault = "ok" | "once" | "always" | "unauthorized";
const systemModule =
  /\/(?:src\/system\.tsx|assets\/system-[^/?]+\.js)(?:\?.*)?$/;

async function fixture(
  page: Page,
  options: { auth?: Fault; audit?: Fault; htmlAuthError?: boolean } = {},
) {
  let auth = options.auth ?? "ok";
  let audit = options.audit ?? "ok";
  let authCalls = 0;
  let auditCalls = 0;
  const authResponses: number[] = [];
  const documents: string[] = [];
  const writes: string[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/v1/auth/me")
      authResponses.push(response.status());
  });
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(request.url());
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (request.method() !== "GET") writes.push(`${request.method()} ${path}`);
    let data: unknown = [];
    if (path === "/auth/me") {
      authCalls += 1;
      if (auth === "unauthorized") {
        await route.fulfill({
          status: 401,
          json: { error: { message: "请登录后继续" } },
        });
        return;
      }
      // StrictMode can cancel its first mount before receiving a response.
      if (
        auth === "always" ||
        (auth === "once" && !authResponses.includes(503))
      ) {
        await route.fulfill(
          options.htmlAuthError
            ? {
                status: 502,
                contentType: "text/html",
                body: "<h1>Bad Gateway</h1>",
              }
            : {
                status: 503,
                json: { error: { message: "账号服务暂时不可用" } },
              },
        );
        return;
      }
      data = {
        id: "loading-user",
        username: "loading-fixture",
        displayName: "加载验收",
        roleCodes: ["ADMIN"],
        permissions: ["inventory.read", "user.read", "audit.read"],
        csrfToken: "fixture-only",
      };
    } else if (path === "/my-workspace/appearance") {
      data = { mode: "dark", version: 1 };
    } else if (path === "/audit-logs") {
      auditCalls += 1;
      if (audit === "always" || (audit === "once" && auditCalls === 1)) {
        await route.fulfill({
          status: 503,
          json: { error: { message: "审计日志暂时不可用" } },
        });
        return;
      }
      data = [
        {
          id: "loading-audit-row",
          occurredAt: "2026-11-10T00:00:00.000Z",
          actorLabel: "加载验收",
          action: "READ_TEST",
          entityType: "verification",
          entityId: "fixture-only",
          reason: "数据已完整载入",
        },
      ];
    }
    await route.fulfill({
      json: { data, total: Array.isArray(data) ? data.length : 0 },
    });
  });
  return {
    documents,
    writes,
    authCalls: () => authCalls,
    authResponses,
    auditCalls: () => auditCalls,
    recoverAuth: () => {
      auth = "ok";
    },
    recoverAudit: () => {
      audit = "ok";
    },
  };
}

async function openAuditFromSidebar(page: Page) {
  await page
    .locator(".sidebar .ant-menu-submenu-title")
    .filter({ hasText: "系统设置" })
    .click();
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "操作日志", exact: true })
    .click();
}

test("首次账号请求短暂失败自动恢复，不需要刷新或重新登录", async ({ page }) => {
  const state = await fixture(page, { auth: "once" });
  await page.goto("/operations");
  await expect(
    page.getByRole("heading", { name: "运营中心", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".login")).toHaveCount(0);
  expect(state.authCalls()).toBeGreaterThan(1);
  expect(state.authResponses).toEqual([503, 200]);
  expect(state.documents).toHaveLength(1);
  expect(state.writes).toEqual([]);
});

test("账号服务持续返回非JSON错误时可重试，不能误判为退出登录", async ({
  page,
}) => {
  const state = await fixture(page, { auth: "always", htmlAuthError: true });
  await page.goto("/operations");
  const error = page.getByTestId("session-loading-error");
  await expect(error).toContainText("暂时无法加载账号信息", { timeout: 15000 });
  await expect(error).not.toContainText(/Unexpected token|SyntaxError|<h1>/);
  await expect(page.locator(".login")).toHaveCount(0);
  state.recoverAuth();
  await error.getByRole("button", { name: "重试加载", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "运营中心", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  expect(state.documents).toHaveLength(1);
  expect(state.writes).toEqual([]);
});

test("真实401仍进入登录界面，不重复请求失效会话", async ({ page }) => {
  const state = await fixture(page, { auth: "unauthorized" });
  await page.goto("/operations");
  await expect(
    page.getByRole("button", { name: "进入工作台", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("session-loading-error")).toHaveCount(0);
  expect(state.authResponses).toEqual([401]);
  expect(state.writes).toEqual([]);
});

test("只读页面数据短暂失败自动补试，无需整页刷新", async ({ page }) => {
  const state = await fixture(page, { audit: "once" });
  await page.goto("/audit-logs");
  await expect(page.getByText("数据已完整载入", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  expect(state.auditCalls()).toBeGreaterThan(1);
  expect(state.documents).toHaveLength(1);
  expect(state.writes).toEqual([]);
});

test("持续数据错误显示可操作重试并保留侧栏，无需整页刷新", async ({ page }) => {
  const state = await fixture(page, { audit: "always" });
  await page.goto("/audit-logs");
  const error = page
    .getByRole("alert")
    .filter({ hasText: "审计日志暂时不可用" });
  await expect(error).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".topbar")).toBeVisible();
  state.recoverAudit();
  await error.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("数据已完整载入", { exact: true })).toBeVisible();
  await expect(error).toHaveCount(0);
  expect(state.documents).toHaveLength(1);
  expect(state.writes).toEqual([]);
});

test("切换到加载缓慢的页面仍保留导航，并提示加载进度", async ({ page }) => {
  const state = await fixture(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let moduleRequested = false;
  await page.route(systemModule, async (route) => {
    moduleRequested = true;
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/operations");
    await expect(
      page.getByRole("heading", { name: "运营中心", exact: true }),
    ).toBeVisible({ timeout: 15000 });
    expect(moduleRequested).toBe(false);
    await openAuditFromSidebar(page);
    await expect.poll(() => moduleRequested).toBe(true);
    const loading = page.locator('.page-resource-state[data-state="loading"]');
    await expect(loading).toContainText("正在加载页面");
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator(".topbar")).toBeVisible();
    await expect(
      page.locator('.page-resource-state[data-state="slow"]'),
    ).toContainText("页面加载较慢", { timeout: 15000 });
    await page.screenshot({
      path: ".local/loading-recovery-20261110/slow-route.png",
    });
    release();
    await expect(
      page.getByRole("heading", { name: "操作日志", exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByText("数据已完整载入", { exact: true }),
    ).toBeVisible();
    expect(state.documents).toHaveLength(1);
    expect(state.writes).toEqual([]);
  } finally {
    release();
  }
});

test("页面模块短暂503后自动补试，不要求用户刷新", async ({ page }) => {
  const state = await fixture(page);
  let moduleCalls = 0;
  await page.route(systemModule, (route) => {
    moduleCalls += 1;
    return moduleCalls === 1
      ? route.fulfill({
          status: 503,
          contentType: "text/plain",
          body: "temporary failure",
        })
      : route.continue();
  });
  await page.goto("/operations");
  await expect(
    page.getByRole("heading", { name: "运营中心", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await openAuditFromSidebar(page);
  await expect(
    page.getByRole("heading", { name: "操作日志", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("数据已完整载入", { exact: true })).toBeVisible();
  expect(moduleCalls).toBeGreaterThan(1);
  expect(state.documents).toHaveLength(1);
  expect(state.writes).toEqual([]);
});

test("页面模块加载失败后可离开或主动重载恢复，不自动刷新白屏", async ({
  page,
}) => {
  const state = await fixture(page);
  let failModule = true;
  let moduleCalls = 0;
  await page.route(systemModule, (route) => {
    moduleCalls += 1;
    return failModule ? route.abort("failed") : route.continue();
  });
  await page.goto("/operations");
  await expect(
    page.getByRole("heading", { name: "运营中心", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await openAuditFromSidebar(page);
  const error = page.locator('.page-resource-state[data-state="error"]');
  await expect(error).toContainText("页面资源加载失败", { timeout: 15000 });
  expect(moduleCalls).toBe(2);
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".topbar")).toBeVisible();
  expect(state.documents).toHaveLength(1);
  await page.screenshot({
    path: ".local/loading-recovery-20261110/failed-route.png",
  });
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "运营中心", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "运营中心", exact: true }),
  ).toBeVisible();
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "操作日志", exact: true })
    .click();
  await expect(error).toBeVisible();
  failModule = false;
  await error
    .getByRole("button", { name: "重新加载页面", exact: true })
    .click();
  await expect(page).toHaveURL(/\/audit-logs$/);
  await expect(
    page.getByRole("heading", { name: "操作日志", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("数据已完整载入", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "账号菜单：加载验收", exact: true }),
  ).toBeVisible();
  expect(state.documents).toHaveLength(2);
  expect(state.writes).toEqual([]);
});

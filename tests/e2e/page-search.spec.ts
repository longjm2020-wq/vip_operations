import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "我的工作台" })).toBeVisible();
}

const searchHost = (page: Page) => page.getByRole("search", { name: "当前页面搜索", exact: true });

test("shared search stays compact across page controls when a query exceeds the visible width", async ({ page }) => {
  test.setTimeout(90000);
  await login(page);
  const longQuery = "QUERY-".repeat(20);
  for (const path of [
    "/products", "/suppliers", "/analytics/compass", "/analytics/competitors",
    "/operations/vip/inventory", "/supply/catalog", "/supply/procurement", "/help", "/style-selections",
  ]) {
    await page.goto(path);
    const host = searchHost(page), input = host.getByRole("textbox"), control = host.locator(".page-search-control");
    await expect(input).toBeVisible();
    const before = (await page.locator(".topbar").boundingBox())!;
    await input.fill(longQuery);
    await expect(input).toHaveValue(longQuery);
    await expect.poll(async () => Math.round((await control.boundingBox())!.height), { message: path }).toBe(28);
    expect(Math.round((await control.boundingBox())!.width), path).toBe(320);
    const after = (await page.locator(".topbar").boundingBox())!;
    expect(after.height, path).toBe(before.height);
    await expect(control).toHaveCSS("border-radius", "18px");
    await expect(control).toHaveCSS("background-color", "rgb(255, 253, 249)");
  }
});

test("compact batch search preserves every line and scrolls inside the unchanged header on desktop and narrow screens", async ({ page }) => {
  await login(page);
  await page.goto("/analytics/compass");
  const host = searchHost(page), input = host.getByRole("textbox"), control = host.locator(".page-search-control");
  await expect(input).toBeVisible();
  await input.blur();
  await host.screenshot({ path: ".local/page-search-default.png" });
  const viewports = [{ width: 1440, height: 1000 }, { width: 900, height: 700 }, { width: 375, height: 812 }];
  for (const [screen, viewport] of viewports.entries()) {
    const batch = Array.from({ length: 100 }, (_, index) => `BATCH-${screen}-${index}`).join("\n");
    await page.setViewportSize(viewport);
    await input.fill("");
    const before = (await page.locator(".topbar").boundingBox())!;
    const queried = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname === "/api/v1/analytics/compass" && url.searchParams.get("q") === batch;
    });
    await input.fill(batch);
    await queried;
    await expect(input).toHaveValue(batch);
    const bounds = (await control.boundingBox())!, after = (await page.locator(".topbar").boundingBox())!;
    expect(Math.round(bounds.height)).toBe(28);
    expect(bounds.width).toBeLessThanOrEqual(320);
    expect(after.height).toBe(before.height);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(after.y + after.height);
    expect(await input.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await input.evaluate(element => { element.scrollTop = 0; });
    await input.hover();
    await page.mouse.wheel(0, 120);
    await expect.poll(() => input.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(input).toHaveValue(batch);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await input.fill("");
  await input.focus();
  await host.screenshot({ path: ".local/page-search-focus.png" });
  await page.screenshot({ path: ".local/page-search-analytics.png" });
});

test("explicit search keeps Enter, search icon and clear behavior after editing the visible query", async ({ page }) => {
  await login(page);
  await page.route("**/api/v1/suppliers?*", route => {
    const query = new URL(route.request().url()).searchParams.get("q");
    return route.fulfill({ json: { data: [{ id: "search-result", code: "SEARCH-RESULT", name: query ? `Search matches: ${query}` : "All suppliers", status: "ACTIVE" }], total: 1 } });
  });
  await page.goto("/suppliers");
  const host = searchHost(page), input = host.getByRole("textbox");
  await expect(input).toBeVisible();
  const result = (name: string) => page.getByRole("cell", { name, exact: true });
  await expect(result("All suppliers")).toBeVisible();
  const requestedQuery = (query: string) => page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === "/api/v1/suppliers" && (url.searchParams.get("q") || "") === query;
  });
  await input.fill("SEARCH-A");
  await expect(result("All suppliers")).toBeVisible();
  const enter = requestedQuery("SEARCH-A");
  await input.press("Enter");
  await enter;
  await expect(result("Search matches: SEARCH-A")).toBeVisible();
  await input.fill("SEARCH-B");
  await expect(result("Search matches: SEARCH-A")).toBeVisible();
  const click = requestedQuery("SEARCH-B");
  await host.getByRole("button", { name: "搜索", exact: true }).click();
  await click;
  await expect(result("Search matches: SEARCH-B")).toBeVisible();
  await host.locator(".ant-input-clear-icon").click();
  await expect(input).toHaveValue("");
  // Clearing may immediately restore the fresh cached unfiltered response.
  await expect(result("All suppliers")).toBeVisible();
});

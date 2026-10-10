import { expect, test, type Page } from "@playwright/test";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=", "base64");
test.use({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });

async function fixture(page: Page, archive = false) {
  const searches: URLSearchParams[] = [], writes: { path: string; params: URLSearchParams; body: Record<string, any> }[] = [];
  const state = { total: 83 };
  const selected = { id: "selected-style", xutiStyleNo: "SELECTED-STYLE", color: "粉色/黑色", images: [], labelImages: [], updatedAt: "2026-10-10T00:00:00.000Z" };
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() !== "GET") writes.push({ path, params: url.searchParams, body: request.postDataJSON() });
    if (path.endsWith("/auth/me")) {
      await route.fulfill({ json: { data: { id: "pagination-user", displayName: "手机分页测试", permissions: archive ? ["product.read"] : ["selection.read", "selection.manage"], roleCodes: [], csrfToken: "fixture" } } });
      return;
    }
    if (path === "/api/v1/style-selections") {
      searches.push(url.searchParams);
      const q = url.searchParams.get("q"), missing = url.searchParams.get("missingStyleNo") === "true";
      const total = q === "NONE" ? 0 : q === "SMALL" ? 21 : missing ? 41 : state.total;
      const currentPage = Number(url.searchParams.get("page")), offset = (currentPage - 1) * 20;
      const data = Array.from({ length: Math.min(20, Math.max(0, total - offset)) }, (_, index) => ({ id: `result-${offset + index + 1}`, xutiStyleNo: missing ? "" : `STYLE-${offset + index + 1}`, supplierStyleNo: `SUPPLIER-${offset + index + 1}`, color: "粉色", images: [], labelImages: [] }));
      await route.fulfill({ json: { data, total, missingStyleNoCount: q === "NONE" ? 0 : 41 } });
      return;
    }
    if (path === "/api/v1/style-selections/selected-style") { await route.fulfill({ json: { data: selected } }); return; }
    if (path === "/api/v1/style-selections/images" && request.method() === "POST") { await route.fulfill({ json: { data: { url: "/api/v1/style-selections/images/fixture-image" } } }); return; }
    await route.fulfill({ json: { data: [] } });
  });
  await page.goto(`/mobile/style-photos?id=selected-style${archive ? "&tableId=777&archive=1" : ""}`);
  await expect(page.getByRole("heading", { name: "SELECTED-STYLE", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "选择款式", exact: true }).tap();
  await expect(page.locator(".mobile-photo-result")).toHaveCount(20);
  return { searches, writes, state };
}

const pager = (page: Page) => page.getByRole("navigation", { name: "搜索结果分页", exact: true });
async function atPage(page: Page, current: number, total: number) {
  await expect(pager(page).getByText(`第 ${current} 页`, { exact: true })).toBeVisible();
  await expect(pager(page).getByText(`共 ${total} 页`, { exact: true })).toBeVisible();
  await expect(pager(page).getByLabel("跳转页码", { exact: true })).toHaveValue(String(current));
}

test("首页尾页和输入跳转遵循边界，保持所选款与拍图目标，320/393宽无横向溢出", async ({ page }) => {
  const state = await fixture(page);
  await atPage(page, 1, 5);
  await expect(pager(page).getByRole("button", { name: "首页", exact: true })).toBeDisabled();
  await expect(pager(page).getByRole("button", { name: "上一页", exact: true })).toBeDisabled();
  const currentPhotos = page.locator(".mobile-photo-current");
  await page.getByRole("button", { name: "收起搜索结果", exact: true }).tap();
  await page.getByRole("button", { name: "黑色 · 0 张", exact: true }).tap();
  const chooserPromise = page.waitForEvent("filechooser");
  await currentPhotos.getByRole("button", { name: "相册选择" }).tap();
  const chooser = await chooserPromise;
  await page.getByRole("button", { name: "选择款式", exact: true }).tap();
  await pager(page).getByRole("button", { name: "尾页", exact: true }).tap();
  await atPage(page, 5, 5);
  await expect(page.locator(".mobile-photo-result")).toHaveCount(3);
  await expect(pager(page).getByRole("button", { name: "尾页", exact: true })).toBeDisabled();
  await expect(pager(page).getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "SELECTED-STYLE", exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("id")).toBe("selected-style");
  await expect(page.getByRole("button", { name: "黑色 · 0 张", exact: true })).toHaveAttribute("aria-pressed", "true");
  const input = pager(page).getByLabel("跳转页码", { exact: true });
  await input.fill("3");
  await input.press("Enter");
  await atPage(page, 3, 5);
  await input.fill("2");
  await pager(page).getByRole("button", { name: "跳转", exact: true }).tap();
  await atPage(page, 2, 5);
  await pager(page).getByRole("button", { name: "下一页", exact: true }).tap();
  await atPage(page, 3, 5);
  await pager(page).getByRole("button", { name: "上一页", exact: true }).tap();
  await atPage(page, 2, 5);
  const requestsBefore = state.searches.length;
  for (const value of ["0", "6", "1.5", "bad", ""]) {
    await input.fill(value);
    await pager(page).getByRole("button", { name: "跳转", exact: true }).tap();
    await expect(page.getByText("请输入 1 至 5 的整数页码", { exact: true }).last()).toBeVisible();
    await expect(pager(page).getByText("第 2 页", { exact: true })).toBeVisible();
  }
  expect(state.searches.length).toBe(requestsBefore);
  for (const width of [320, 393]) {
    await page.setViewportSize({ width, height: 852 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const bounds = await pager(page).boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x || 0) + (bounds?.width || 0)).toBeLessThanOrEqual(width);
  }
  await pager(page).getByRole("button", { name: "首页", exact: true }).tap();
  await atPage(page, 1, 5);
  await chooser.setFiles({ name: "pagination-target.png", mimeType: "image/png", buffer: pixel });
  await expect.poll(() => state.writes.find(write => write.path.endsWith("/selected-style/photos"))?.body.image?.color).toBe("黑色");
  expect(state.writes.filter(write => write.path.endsWith("/photos")).map(write => write.path)).toEqual(["/api/v1/style-selections/selected-style/photos"]);
});

test("商品档案扫码分页保持表格范围、搜索和缺款号筛选，零结果禁用跳转", async ({ page }) => {
  const state = await fixture(page, true);
  await pager(page).getByRole("button", { name: "尾页", exact: true }).tap();
  await atPage(page, 5, 5);
  await page.getByLabel("搜索款号或供应商编码", { exact: true }).fill("SUPPLIER");
  await atPage(page, 1, 5);
  await expect.poll(() => state.searches.at(-1)?.get("q")).toBe("SUPPLIER");
  await page.getByRole("button", { name: "筛选序缇款号缺失", exact: true }).tap();
  await atPage(page, 1, 3);
  await pager(page).getByRole("button", { name: "尾页", exact: true }).tap();
  await atPage(page, 3, 3);
  await expect(page.locator(".mobile-photo-result")).toHaveCount(1);
  const request = state.searches.at(-1)!;
  expect(request.get("q")).toBe("SUPPLIER");
  expect(request.get("missingStyleNo")).toBe("true");
  expect(request.get("tableId")).toBe("777");
  expect(request.get("photoSearch")).toBe("true");
  expect(request.get("pageSize")).toBe("20");
  expect(new URL(page.url()).searchParams.get("id")).toBe("selected-style");
  await page.getByLabel("搜索款号或供应商编码", { exact: true }).fill("NONE");
  await atPage(page, 1, 0);
  await expect(pager(page).getByLabel("跳转页码", { exact: true })).toBeDisabled();
  await expect(pager(page).getByRole("button", { name: "跳转", exact: true })).toBeDisabled();
  for (const name of ["首页", "上一页", "下一页", "尾页"]) await expect(pager(page).getByRole("button", { name, exact: true })).toBeDisabled();
  expect(state.searches.every(query => query.get("tableId") === "777")).toBe(true);
  expect(state.writes).toEqual([]);
});

test("搜索结果数量减少时回到合法末页，不产生空的超范围页面", async ({ page }) => {
  const state = await fixture(page);
  await pager(page).getByRole("button", { name: "尾页", exact: true }).tap();
  await atPage(page, 5, 5);
  state.state.total = 21;
  await pager(page).getByRole("button", { name: "上一页", exact: true }).tap();
  await atPage(page, 2, 2);
  await expect(page.locator(".mobile-photo-result")).toHaveCount(1);
  await expect(pager(page).getByRole("button", { name: "尾页", exact: true })).toBeDisabled();
  expect(state.searches.slice(-2).map(query => query.get("page"))).toEqual(["4", "2"]);
  expect(new URL(page.url()).searchParams.get("id")).toBe("selected-style");
  expect(state.writes).toEqual([]);
});

import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, path = "/operations/vip/inventory") {
  const reads: URL[] = [], writes: string[] = [];
  await page.addInitScript(() => {
    (window as any).copiedCodes = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { (window as any).copiedCodes.push(text); },
    } });
  });
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() !== "GET") writes.push(`${request.method()} ${path}`);
    if (path.endsWith("/auth/me")) return route.fulfill({ json: { data: { id: "copy-reader", displayName: "编号复制验收", roleCodes: [], permissions: ["inventory.read", "analytics.read"], csrfToken: "fixture" } } });
    if (path.endsWith("/inventory/summary")) {
      reads.push(url);
      return route.fulfill({ json: { data: [{ id: "1", styleNo: "STYLE-001", articleNo: "ARTICLE-001", skuCode: "000123456789012345", barcode: "000987654321098765", supplierStyleCode: "SUP-001", colorName: url.searchParams.get("q") || "米白", sizeName: "M", physicalQty: 8, inTransitQty: 0, transferTransitQty: 0, incomingQty: 0 }], total: 41, page: Number(url.searchParams.get("page")), pageSize: 20, dimension: url.searchParams.get("dimension"), totals: { physicalQty: 8, inTransitQty: 0, transferTransitQty: 0, incomingQty: 0 } } });
    }
    if (path.endsWith("/analytics/compass")) {
      reads.push(url);
      const dimension = url.searchParams.get("dimension") || "style";
      const code = ({ style: "STYLE-001", article: "ARTICLE-001", barcode: "000123456789012345" } as Record<string, string>)[dimension];
      const row = { code, styleNo: "STYLE-001", sizes: "M", salesAmount: 123, salesQty: 1, saleableStock: 8, trend: [] };
      return route.fulfill({ json: { data: { empty: false, dimension, complete: true, days: 7, startDate: "2026-10-14", endDate: "2026-10-20", summary: { entities: 1, coveredDays: 7, salesAmount: 123 }, top: [row], items: [row], total: 1, daily: [], sources: [] } } });
    }
    return route.fulfill({ json: { data: [], total: 0 } });
  });
  await page.goto(path);
  await expect(page.getByRole(path.includes("compass") ? "heading" : "region", { name: path.includes("compass") ? "经营分析" : "库存明细", exact: true })).toBeVisible();
  return { reads, writes };
}

const copied = (page: Page) => page.evaluate(() => (window as any).copiedCodes as string[]);
const search = (page: Page) => page.getByRole("textbox", { name: "商品编码 / 货号 / 款号 / 条码", exact: true });

test("只读库存用户分别复制完整款号、货号、商品编码和条码，不修改资料", async ({ page }) => {
  const state = await fixture(page);
  for (const [label, value] of [["款号", "STYLE-001"], ["货号", "ARTICLE-001"], ["商品编码", "000123456789012345"], ["条码", "000987654321098765"], ["供应商款式编码", "SUP-001"]]) {
    await page.getByRole("button", { name: `复制${label} ${value}`, exact: true }).click();
    await expect.poll(async () => (await copied(page)).at(-1)).toBe(value);
    await expect(page.locator(".ant-message")).toContainText(`${label}已复制`);
  }
  expect(state.writes).toEqual([]);
  expect(state.reads).toHaveLength(1);
  await page.screenshot({ path: test.info().outputPath("inventory-copy.png") });
});

test("复制可用键盘操作，剪贴板被拒绝时明确提示失败", async ({ page }) => {
  await fixture(page);
  const button = page.getByRole("button", { name: "复制条码 000987654321098765", exact: true });
  await button.focus();
  await button.press("Enter");
  await expect.poll(() => copied(page)).toEqual(["000987654321098765"]);
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new DOMException("denied", "NotAllowedError"); }; });
  await button.press("Space");
  await expect(page.locator(".ant-message")).toContainText("复制失败");
  expect(await copied(page)).toEqual(["000987654321098765"]);
});

test("旧浏览器使用复制后备方案并恢复焦点", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    document.execCommand = (command: string) => {
      if (command !== "copy") return false;
      (window as any).copiedCodes.push((document.activeElement as HTMLTextAreaElement).value);
      return true;
    };
  });
  const button = page.getByRole("button", { name: "复制商品编码 000123456789012345", exact: true });
  await button.focus();
  await button.press("Enter");
  await expect.poll(() => copied(page)).toEqual(["000123456789012345"]);
  await expect(button).toBeFocused();
});

test("库存输入与粘贴自动查询，连续输入只提交最终值，回车及清空立即生效", async ({ page }) => {
  const state = await fixture(page), input = search(page);
  await expect(page.getByRole("button", { name: "复制款号 STYLE-001", exact: true })).toBeVisible();
  await page.clock.install();
  await input.fill("STYLE");
  await page.clock.runFor(300);
  await input.fill("STYLE-001");
  await page.clock.runFor(499);
  expect(state.reads).toHaveLength(1);
  await page.clock.runFor(1);
  await expect.poll(() => state.reads.at(-1)?.searchParams.get("q")).toBe("STYLE-001");
  expect(state.reads).toHaveLength(2);
  await input.fill("000123456789012345");
  await input.press("Enter");
  await expect.poll(() => state.reads.at(-1)?.searchParams.get("q")).toBe("000123456789012345");
  await page.clock.runFor(600);
  expect(state.reads).toHaveLength(3);
  await page.locator(".page-search-control .ant-input-clear-icon").click();
  await expect(input).toHaveValue("");
  // Clearing can reuse the first page cached by React Query without another request.
  await expect(page.getByRole("cell", { name: "米白", exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});

test("中文组字不提前查询，完成后再计时；新查询回到首页且保留维度", async ({ page }) => {
  const state = await fixture(page), input = search(page);
  await expect(page.getByRole("button", { name: "复制款号 STYLE-001", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "库存汇总维度", exact: true }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: /^货号$/ }).click();
  await expect.poll(() => state.reads.at(-1)?.searchParams.get("dimension")).toBe("article");
  await page.locator(".ant-pagination-item-2").click();
  await expect.poll(() => state.reads.at(-1)?.searchParams.get("page")).toBe("2");
  const count = state.reads.length;
  await page.clock.install();
  await input.dispatchEvent("compositionstart");
  await input.fill("mi");
  await page.clock.runFor(800);
  await input.press("Enter");
  expect(state.reads).toHaveLength(count);
  await input.fill("米白");
  await input.dispatchEvent("compositionend", { data: "米白" });
  await page.clock.runFor(500);
  await expect.poll(() => state.reads.at(-1)?.searchParams.get("q")).toBe("米白");
  expect(state.reads.at(-1)?.searchParams.get("page")).toBe("1");
  expect(state.reads.at(-1)?.searchParams.get("dimension")).toBe("article");
});

test("排行榜和明细三个维度均能复制，复制不下钻，编号仍可下钻", async ({ page }) => {
  const state = await fixture(page, "/analytics/compass");
  for (const [label, value, dimension] of [["款号", "STYLE-001", "style"], ["货号", "ARTICLE-001", "article"], ["条码", "000123456789012345", "barcode"]]) {
    const rank = page.locator(".compass-ranks"), detail = page.locator(".compass-detail-table");
    await expect(rank.getByRole("button", { name: `复制${label} ${value}`, exact: true })).toBeVisible();
    const count = state.reads.length;
    for (const scope of [rank, detail]) {
      await scope.getByRole("button", { name: `复制${label} ${value}`, exact: true }).click();
      await expect.poll(async () => (await copied(page)).at(-1)).toBe(value);
    }
    await expect(page.getByRole("tab", { name: `按${label}分析`, exact: true })).toHaveAttribute("aria-selected", "true");
    expect(state.reads).toHaveLength(count);
    if (dimension !== "barcode") await rank.getByRole("button", { name: value, exact: true }).click();
  }
  await page.locator(".compass-drill").getByRole("button", { name: "复制款号 STYLE-001", exact: true }).click();
  await expect(page.locator(".compass-drill")).toContainText("ARTICLE-001");
  await page.locator(".compass-detail-table").getByRole("button", { name: "查看000123456789012345每日趋势", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "复制条码 000123456789012345", exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(state.writes).toEqual([]);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.screenshot({ path: test.info().outputPath("compass-copy.png") });
});

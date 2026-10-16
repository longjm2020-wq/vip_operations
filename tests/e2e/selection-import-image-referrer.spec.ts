import { expect, test } from "@playwright/test";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

test("imported supplier pictures render, preload and download without a blocked referer", async ({ page, context }) => {
  const origin = "http://127.0.0.1:5174";
  await context.addCookies([{ name: "image-fixture-session", value: "authenticated", url: origin }]);
  const preferences = selectionLayoutSchema.parse({ columns: [
    { key: "images", label: "图片", width: 140, type: "image" },
    { key: "xutiStyleNo", label: "序缇款号", width: 160, type: "text" },
    { key: "labelImages", label: "洗唛/吊牌图", width: 140, type: "image" },
  ] });
  const urls = ["https://images-erp.sursung.com/product-a.png", "https://images.sursung.com/product-b.png"];
  const rows = [{ id: "1", xutiStyleNo: "IMPORT-PHOTO", sortOrder: 1,
    createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z",
    images: urls.map((url, index) => ({ id: `supplier-${index}`, color: "", url })),
    labelImages: [{ id: "internal-label", color: "", url: "/api/v1/style-selections/images/internal-label" }], extraFields: {},
  }];
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6h70AAAAASUVORK5CYII=", "base64");
  const requests: { url: string; referer: string | undefined }[] = [];
  const internalCookies: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith("/images/internal-label")) {
      internalCookies.push((await request.allHeaders()).cookie || "");
      return route.fulfill({ contentType: "image/png", body: png });
    }
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "11", displayName: "图片测试", roleCodes: [], csrfToken: "fixture", permissions: ["selection.read"] };
    if (path.endsWith("/layout-preferences")) data = { preferences, revision: 0, sharedPreferences: null, sharedRevision: 0, canEditShared: false };
    if (path.endsWith("/revision")) data = { revision: "image-referrer-fixture" };
    if (path.endsWith("/sync")) data = { revision: "image-referrer-fixture", index: [{ id: "1", token: rows[0].updatedAt }], data: rows };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/protection")) data = { settings: defaultProtection, revision: 0, canManage: false };
    await route.fulfill({ json: { data } });
  });
  await page.route(/^https:\/\/images(?:-erp)?\.sursung\.com\//u, async route => {
    const referer = (await route.request().allHeaders()).referer;
    requests.push({ url: route.request().url(), referer });
    // The real supplier CDN rejects requests carrying an unrelated site referer.
    if (referer) return route.fulfill({ status: 403, body: "" });
    await route.fulfill({ contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" }, body: png });
  });
  await page.goto("/style-selections");
  const imageCell = page.locator('td[data-selection-row="1"][data-selection-column="images"]');
  const loaded = (selector: string) => page.locator(selector).evaluateAll(images => images.length > 0 && images.every(node => (node as HTMLImageElement).naturalWidth > 0 && !(node as HTMLImageElement).currentSrc.startsWith("data:")));
  await expect.poll(() => loaded('td[data-selection-column="images"] .selection-image-slide img')).toBe(true);
  await expect.poll(() => loaded('td[data-selection-column="labelImages"] .selection-image-slide img')).toBe(true);
  expect(internalCookies.some(cookie => cookie.includes("image-fixture-session=authenticated"))).toBe(true);
  await imageCell.locator(".selection-image-slide img").click();
  await expect.poll(() => loaded(".selection-preview-image")).toBe(true);
  await expect.poll(() => requests.some(request => request.url === urls[1])).toBe(true);
  await page.getByRole("button", { name: "下一张大图", exact: true }).click();
  await expect(page.locator(".selection-preview-image")).toHaveAttribute("src", urls[1]);
  await expect.poll(() => loaded(".selection-preview-image")).toBe(true);
  await page.locator(".selection-preview-image").click({ button: "right" });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 10000 }),
    page.getByRole("menuitem", { name: "下载当前图片", exact: false }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.png$/u);
  await page.getByRole("button", { name: "关闭图片预览", exact: true }).click();
  await imageCell.getByRole("button", { name: "全部", exact: true }).click();
  await expect.poll(() => loaded(".selection-image-gallery .selection-image-item img")).toBe(true);
  expect(requests.length).toBeGreaterThanOrEqual(3);
  expect(requests.every(request => !request.referer)).toBe(true);
});

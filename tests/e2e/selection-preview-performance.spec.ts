import { expect, test, type Page } from "@playwright/test";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

const pictureUrl = (index: number) => `/api/v1/style-selections/images/performance-${index}`;
const pictures = Array.from({ length: 12 }, (_, index) => ({ id: `picture-${index}`, url: pictureUrl(index), color: "" }));

async function fixture(page: Page, saveData = false) {
  const requested: string[] = [];
  const row = { id: "preview-performance", xutiStyleNo: "PREVIEW-PERFORMANCE", createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z", images: pictures, labelImages: [], extraFields: {}, defaultCellAccess: "read" };
  const preferences = selectionLayoutSchema.parse({ columns: [
    { key: "images", label: "图片", type: "image", width: 120, imageConfig: { autoplay: false, colors: false, links: false, upload: false, mobile: false, max: 30 } },
    { key: "xutiStyleNo", label: "序缇款号", type: "text", width: 180 },
  ] });
  if (saveData) await page.addInitScript(() => Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } }));
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("/style-selections/images/")) {
      requested.push(path);
      await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#e9dccd"/><text x="60" y="435" font-size="38">Preview performance</text></svg>' });
      return;
    }
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "preview-reader", displayName: "图片预览测试", roleCodes: [], csrfToken: "fixture", permissions: ["selection.read"] };
    if (path === "/api/v1/style-selections") { await route.fulfill({ json: { data: [row], total: 1 } }); return; }
    if (path.endsWith("/revision")) data = { revision: "preview-performance" };
    if (path.endsWith("/sync")) data = { revision: "preview-performance", index: [{ id: row.id, token: row.updatedAt }], data: [row] };
    if (path.endsWith("/layout-preferences")) data = { preferences, revision: 1, sharedPreferences: null, sharedRevision: 0, canEditShared: false };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  const cell = page.locator('td[data-selection-column="images"]').first();
  await expect(cell.locator("img")).toBeVisible();
  return { requested, cell };
}

test("大图仅提前准备本格相邻图片，切图可用且关闭后停止请求", async ({ page }) => {
  const { requested, cell } = await fixture(page);
  expect([...new Set(requested)]).toEqual([pictureUrl(0)]);
  await cell.locator("img").click();
  const preview = page.getByRole("dialog", { name: "图片图片预览", exact: true });
  const image = preview.locator(".selection-preview-image");
  await expect(image).toHaveAttribute("decoding", "async");
  await expect(image).toHaveAttribute("fetchpriority", "high");
  await expect.poll(() => requested.includes(pictureUrl(1))).toBe(true);
  expect([...new Set(requested)]).toEqual([pictureUrl(0), pictureUrl(1)]);
  await preview.getByRole("button", { name: "下一张大图", exact: true }).click();
  await expect(image).toHaveAttribute("src", pictureUrl(1));
  await expect.poll(() => requested.includes(pictureUrl(2))).toBe(true);
  expect([...new Set(requested)]).toEqual([pictureUrl(0), pictureUrl(1), pictureUrl(2)]);
  await preview.getByRole("button", { name: "上一张大图", exact: true }).click();
  await expect(image).toHaveAttribute("src", pictureUrl(0));
  await preview.getByRole("button", { name: "关闭图片预览", exact: true }).click();
  await expect(preview).toHaveCount(0);
  const count = requested.length;
  // Two idle deadlines pass without requesting the cell's remaining pictures.
  await page.waitForTimeout(650);
  expect(requested.length).toBe(count);
  expect(requested.some(url => /performance-(?:[3-9]|1\d)$/.test(url))).toBe(false);
});

test("大图连续指针移动每帧只提交一次，最终位置和框选保持准确", async ({ page }) => {
  const { cell, requested } = await fixture(page, true);
  await cell.locator("img").click();
  const preview = page.getByRole("dialog", { name: "图片图片预览", exact: true });
  const image = preview.locator(".selection-preview-image");
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(600);
  const bounds = (await image.boundingBox())!;
  const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const commits = await image.evaluate(async (element, origin) => {
    let changes = 0;
    const observer = new MutationObserver(records => { changes += records.length; });
    observer.observe(element, { attributes: true, attributeFilter: ["style"] });
    for (let index = 1; index <= 100; index++) element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1, clientX: origin.x + index, clientY: origin.y + index / 2 }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    observer.disconnect(); return changes;
  }, start);
  expect(commits).toBeGreaterThan(0);
  expect(commits).toBeLessThanOrEqual(2);
  await page.mouse.move(start.x + 100, start.y + 50);
  await page.mouse.up();
  const dragged = (await image.boundingBox())!;
  expect(dragged.x - bounds.x).toBeCloseTo(100, 0);
  expect(dragged.y - bounds.y).toBeCloseTo(50, 0);
  await preview.getByRole("button", { name: "框选识别文字", exact: true }).click();
  const cropStart = { x: dragged.x + 30, y: dragged.y + 30 };
  await page.mouse.move(cropStart.x, cropStart.y);
  await page.mouse.down();
  await page.mouse.move(cropStart.x + 100, cropStart.y + 50, { steps: 20 });
  const crop = page.locator(".selection-preview-text-crop");
  await expect.poll(async () => Math.round((await crop.boundingBox())?.width || 0)).toBe(100);
  await expect.poll(async () => Math.round((await crop.boundingBox())?.height || 0)).toBe(50);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(preview).toHaveCount(0);
  expect([...new Set(requested)]).toEqual([pictureUrl(0)]);
});

import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

const cell = (page: Page, id: number, key: string) => page.locator(`td[data-selection-row="${id}"][data-selection-column="${key}"]`);
async function fixture(page: Page, options: { count?: number; hidden?: boolean; failed?: boolean } = {}) {
  const fields = [
    { key: "images", label: "图片", type: "image", width: 120 },
    { key: "xutiStyleNo", label: "序缇款号", type: "text", width: 160 },
    { key: "custom:photos", label: "细节图片", type: "image", custom: true, width: 120 },
    { key: "material", label: "成分", type: "text", width: 160 },
  ];
  const records = Array.from({ length: options.count || 3 }, (_, index) => ({
    id: String(index + 1), sortOrder: index, xutiStyleNo: `000${index + 1}`, material: "第一行\n第二行",
    images: [{ id: `first-${index}`, url: `/test-images/${index}.jpg` }, { id: `second-${index}`, url: `/test-images/second-${index}.jpg` }],
    extraFields: { "custom:photos": JSON.stringify([{ id: `custom-${index}`, url: `/test-images/custom-${index}.jpg` }]) },
    createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z", defaultCellAccess: "read",
    cellAccess: { images: options.hidden ? "deny" : "read", "custom:photos": options.hidden ? "deny" : "read" },
    hiddenCells: options.hidden ? ["images", "custom:photos"] : [],
  }));
  let preferences = selectionLayoutSchema.parse({ columns: fields, pageSize: 5000, rowHeight: "normal", sort: "sortOrder", direction: "asc" });
  const minted: { rowId: string; columnKey: string; imageId: string }[][] = [];
  const imageRequests: string[] = [];
  const jpeg = await sharp({ create: { width: 120, height: 180, channels: 3, background: "#4361ee" } }).jpeg().toBuffer();
  await page.addInitScript(() => {
    (window as any).officeCopies = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      write: async (items: ClipboardItem[]) => {
        const values: Record<string, string> = {};
        for (const type of items[0].types) {
          const blob = await items[0].getType(type);
          values[type] = type === "image/png" ? `${blob.type}:${blob.size}` : await blob.text();
        }
        (window as any).officeCopies.push(values);
      },
    } });
  });
  await page.route("**/test-images/*", route => route.fulfill({ contentType: "image/jpeg", body: jpeg }));
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "7", displayName: "图文复制测试", roleCodes: [], permissions: ["selection.read"], csrfToken: "fixture" };
    if (path.endsWith("/my-workspace/appearance")) data = { mode: "light", version: 0 };
    if (path.endsWith("/my-workspace/activity")) data = { items: [] };
    if (path.endsWith("/revision")) data = { revision: "office-copy" };
    if (path.endsWith("/sync")) data = { revision: "office-copy", index: records.map(row => ({ id: row.id, token: "office" })), data: records };
    if (path.endsWith("/layout-preferences")) {
      if (request.method() === "POST") preferences = request.postDataJSON().preferences;
      data = { preferences, revision: 0, sharedPreferences: null, sharedRevision: 0, canEditShared: false };
    }
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/clipboard-images")) {
      const images = request.postDataJSON().images; minted.push(images);
      if (options.failed) { await route.fulfill({ status: 403, json: { error: { message: "图片查看权限已变更" } } }); return; }
      data = { images: images.map((image: any, index: number) => ({ ...image, url: `${url.origin}/api/v1/selection-clipboard/fixture/${index}.jpg` })) };
    }
    if (path.includes("/selection-clipboard/")) {
      imageRequests.push(path);
      await route.fulfill({ contentType: "image/jpeg", body: jpeg }); return;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(cell(page, 1, "images")).toBeVisible();
  return { minted, imageRequests };
}
async function copy(page: Page) {
  return page.locator(".selection-sheet table").evaluate(element => {
    const data = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data }));
    return { text: data.getData("text/plain"), html: data.getData("text/html") };
  });
}
const copies = (page: Page) => page.evaluate(() => (window as any).officeCopies as Record<string, string>[]);

test("multiple rows paste as an editable HTML grid with one picture each and aligned style numbers", async ({ page }) => {
  const state = await fixture(page);
  await page.locator('th[data-selection-column="images"]').click();
  await page.locator('th[data-selection-column="xutiStyleNo"]').click({ modifiers: ["Control"] });
  const fallback = await copy(page);
  await expect.poll(async () => (await copies(page)).length).toBe(1);
  expect(state.minted[0].map(image => image.imageId)).toEqual(["first-0", "first-1", "first-2"]);
  const html = (await copies(page))[0]["text/html"];
  expect(html.match(/<tr/g)).toHaveLength(3);
  expect(html.match(/<img /g)).toHaveLength(3);
  expect(html.match(/<td /g)).toHaveLength(6);
  expect(html).toContain("0001</td>");
  expect(html).not.toContain("/test-images/");
  expect((await copies(page))[0]["image/png"]).toBeUndefined();
  expect(fallback.text).toContain("\t0002");
  await expect(page.getByText("图文已复制，可粘贴到 Excel / WPS（每格一张图片）")).toBeVisible();
});

test("a single custom picture cell also includes native PNG clipboard data", async ({ page }) => {
  const state = await fixture(page);
  await cell(page, 1, "custom:photos").click({ position: { x: 2, y: 2 } });
  await copy(page);
  await expect.poll(async () => (await copies(page)).length).toBe(1);
  expect(state.minted[0]).toEqual([{ rowId: "1", columnKey: "custom:photos", imageId: "custom-0" }]);
  expect((await copies(page))[0]["image/png"]).toMatch(/^image\/png:[1-9]\d*$/);
});

test("protected pictures never enter the request or rich clipboard", async ({ page }) => {
  const state = await fixture(page, { hidden: true });
  await page.locator('th[data-selection-column="images"]').click();
  await page.locator('th[data-selection-column="xutiStyleNo"]').click({ modifiers: ["Control"] });
  const result = await copy(page);
  expect(result.html).toContain("••••");
  expect(result.html).not.toContain("<img");
  expect(result.text).not.toContain("test-images");
  expect(state.minted).toHaveLength(0);
});

test("whole image column includes virtual rows beyond the mounted viewport", async ({ page }) => {
  const state = await fixture(page, { count: 205 });
  await expect(page.locator(".selection-sheet")).toHaveAttribute("data-windowed", "true");
  await expect(page.locator('td[data-selection-row="205"]')).toHaveCount(0);
  await page.locator('th[data-selection-column="images"]').click();
  await copy(page);
  await expect.poll(async () => (await copies(page)).length, { timeout: 30000 }).toBe(1);
  expect(state.minted[0]).toHaveLength(205);
  expect((await copies(page))[0]["text/html"].match(/<img /g)).toHaveLength(205);
});

test("a revoked picture reports failure and preserves the plain-text fallback", async ({ page }) => {
  const state = await fixture(page, { failed: true });
  await cell(page, 1, "images").click({ position: { x: 2, y: 2 } });
  const result = await copy(page);
  await expect(page.getByText(/图片查看权限已变更；本次仅复制/)).toBeVisible();
  expect(result.text).toContain("/test-images/0.jpg");
  expect(await copies(page)).toHaveLength(0);
  expect(state.imageRequests).toHaveLength(0);
});

import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  selectionLayoutSchema,
  type SelectionField,
} from "../../packages/contracts/src/selection-layout.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";

const columns: SelectionField[] = [
  { key: "images", label: "产品图片", width: 120, type: "image" },
  { key: "xutiStyleNo", label: "序缇款号", width: 170, type: "text" },
  { key: "material", label: "成分说明", width: 170, type: "text" },
  { key: "custom:status", label: "质检状态", width: 150, custom: true,
    type: "single", options: ["已核对"], optionColors: { "已核对": "blue" } },
];

type FixtureOptions = {
  readonly?: boolean;
  count?: number;
  fields?: SelectionField[];
  compact?: boolean;
  deniedImage?: boolean;
  unsupportedImage?: boolean;
};

async function fixture(page: Page, options: FixtureOptions = {}) {
  const fields = options.fields || columns;
  const readonly = options.readonly || false;
  let preferences = selectionLayoutSchema.parse({
    columns: fields, pageSize: 5000, sort: "sortOrder", direction: "asc",
    rowHeight: options.compact ? "compact" : "normal",
  });
  const rows = Array.from({ length: options.count ?? 3 }, (_, index) => ({
    id: String(index + 1), sortOrder: index,
    xutiStyleNo: `COPY-${String(index + 1).padStart(3, "0")}`,
    material: index === 1
      ? Array.from({ length: 12 }, (_, line) => `成分说明第${line + 1}行`).join("\n")
      : "桑蚕丝100%",
    images: index === 0 ? [{ id: "red-product", color: "", url: options.unsupportedImage
      ? 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>'
      : `/api/v1/style-selections/images/${options.deniedImage ? "denied" : "red"}` }] : [],
    labelImages: [], extraFields: { "custom:status": "已核对" },
    createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z",
    cellColors: index === 1 ? { material: "GREEN" } : index === (options.count ?? 3) - 1
      ? { xutiStyleNo: "BLUE" } : {},
    cellTextColors: { material: "#000000" },
    cellAccess: Object.fromEntries(fields.map(field => [field.key,
      options.deniedImage && field.key === "images" ? "deny" : readonly ? "read" : "edit"])),
    defaultCellAccess: readonly ? "read" : "edit", policyRevision: 0,
  }));
  const redPng = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 64, 64);
    return canvas.toDataURL("image/png").split(",")[1];
  }), "base64");
  let deniedRequests = 0;
  const writes: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && path.includes("/style-selections") &&
      !/\/(?:layout-preferences|presence|sync)$/.test(path)) writes.push(path);
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = {
      id: "11", displayName: "图片复制测试", roleCodes: [], csrfToken: "fixture",
      permissions: readonly ? ["selection.read"] : ["selection.read", "selection.manage"],
    };
    if (path.endsWith("/my-workspace/appearance")) data = { mode: "dark", version: 0 };
    if (path.endsWith("/my-workspace/activity")) data = { items: [] };
    if (path.endsWith("/layout-preferences")) {
      if (request.method() === "POST") preferences = request.postDataJSON().preferences;
      data = { preferences, revision: 0, sharedPreferences: null, sharedRevision: 0, canEditShared: !readonly };
    }
    if (path.endsWith("/revision")) data = { revision: "range-image-fixture" };
    if (path.endsWith("/sync")) data = {
      revision: "range-image-fixture", index: rows.map(row => ({ id: row.id, token: "fixture" })), data: rows,
    };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/protection")) data = { settings: defaultProtection, revision: 0, canManage: false };
    await route.fulfill({ json: { data } });
  });
  await page.route("**/api/v1/style-selections/images/*", async route => {
    if (new URL(route.request().url()).pathname.endsWith("/denied")) deniedRequests++;
    await route.fulfill({ contentType: "image/png", body: redPng });
  });
  await page.goto("/style-selections");
  await expect(page.locator("thead th[data-selection-column]")).toHaveCount(fields.length);
  if (rows.length) await expect(cell(page, 1, fields[0].key)).toBeVisible();
  return { deniedRequests: () => deniedRequests, writes };
}

const cell = (page: Page, id: number, key: string) =>
  page.locator(`td[data-selection-row="${id}"][data-selection-column="${key}"]`);
const header = (page: Page, key: string) =>
  page.locator(`thead th[data-selection-column="${key}"]`);

async function selectRectangle(page: Page, from: Locator, to: Locator) {
  // Wait until the loaded table has an unobstructed drag start.
  await expect.poll(() => from.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + 2, rect.y + 2));
  })).toBe(true);
  const start = (await from.boundingBox())!, end = (await to.boundingBox())!;
  await page.mouse.move(start.x + 2, start.y + 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width - 4, end.y + end.height - 4, { steps: 12 });
  await page.mouse.up();
}

async function menuAction(page: Page, label: string) {
  const item = page.getByRole("menuitem", { name: new RegExp(`(?:^|\\s)${label}$`) });
  await expect(item).toBeVisible();
  // Ant Design aligns and animates a newly opened context menu before it accepts clicks.
  await expect.poll(() => item.evaluate(element => {
    const popup = element.closest<HTMLElement>(".ant-dropdown"), rect = element.getBoundingClientRect();
    return !!popup && getComputedStyle(popup).position === "absolute" &&
      !/ant-slide-up-(appear|enter|leave)/.test(popup.className) &&
      element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
  await item.click();
}

async function pngClipboard(page: Page) {
  return page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items.find(value => value.types.includes("image/png"));
    if (!item) throw new Error("The clipboard did not contain a PNG image");
    const blob = await item.getType("image/png"), bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = { red: 0, green: 0, blue: 0, chipBlue: 0, dark: 0, black: 0, bottomBlue: 0 };
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
      if (r === 255 && g === 0 && b === 0) colors.red++;
      if (r === 238 && g === 249 && b === 232) colors.green++;
      if (r === 237 && g === 245 && b === 255) {
        colors.blue++;
        if (Math.floor(offset / 4 / canvas.width) > canvas.height - 100) colors.bottomBlue++;
      }
      if (r === 232 && g === 237 && b === 255) colors.chipBlue++;
      if (0.2126 * r + 0.7152 * g + 0.0722 * b < 110) colors.dark++;
      if (r === 0 && g === 0 && b === 0) colors.black++;
    }
    bitmap.close();
    return { width: canvas.width, height: canvas.height, bytes: blob.size,
      mime: blob.type, colors, base64: canvas.toDataURL("image/png").split(",")[1] };
  });
}

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

test("readonly range image copies product pixels, cell color, choice color and full multiline text while retaining selection", async ({ page }, testInfo) => {
  const state = await fixture(page, { readonly: true });
  await selectRectangle(page, cell(page, 1, "images"), cell(page, 3, "custom:status"));
  await expect(page.locator("td.selection-cell-active")).toHaveCount(12);
  await cell(page, 2, "material").click({ button: "right", position: { x: 2, y: 2 } });
  await expect(page.locator("td.selection-cell-active")).toHaveCount(12);
  await menuAction(page, "复制选区为图片");
  await expect(page.getByText("选区图片已复制", { exact: true })).toBeVisible();
  const png = await pngClipboard(page);
  expect(png.mime).toBe("image/png");
  expect(png.bytes).toBeGreaterThan(1000);
  expect(png.width).toBeGreaterThan(500);
  expect(png.height).toBeGreaterThan(260); // Twelve text lines must expand beyond the 50px screen row.
  expect(png.colors.red).toBeGreaterThan(500);
  expect(png.colors.green).toBeGreaterThan(1000);
  expect(png.colors.blue).toBeGreaterThan(500);
  expect(png.colors.chipBlue).toBeGreaterThan(50);
  await expect(page.locator("td.selection-cell-active")).toHaveCount(12);
  expect(state.writes).toEqual([]);
  await testInfo.attach("range-clipboard.png", { body: Buffer.from(png.base64, "base64"), contentType: "image/png" });
});

test("readonly users can copy a protected image cell as a masked PNG without fetching its hidden URL", async ({ page }, testInfo) => {
  const state = await fixture(page, { readonly: true, count: 1, deniedImage: true });
  await expect(cell(page, 1, "images").getByLabel("受保护内容", { exact: true })).toBeVisible();
  await cell(page, 1, "images").click({ button: "right", position: { x: 2, y: 2 } });
  await menuAction(page, "复制选区为图片");
  await expect(page.getByText("选区图片已复制", { exact: true })).toBeVisible();
  const png = await pngClipboard(page);
  expect(png.width).toBeGreaterThanOrEqual(120);
  expect(png.height).toBeGreaterThan(50);
  expect(png.colors.red).toBe(0);
  expect(png.colors.dark).toBeGreaterThan(20); // Visible header and protected placeholder remain readable.
  expect(state.deniedRequests()).toBe(0);
  expect(state.writes).toEqual([]);
  await testInfo.attach("protected-clipboard.png", { body: Buffer.from(png.base64, "base64"), contentType: "image/png" });
});

test("selected empty-table headers copy labels as TSV and produce a header-only PNG for readonly users", async ({ page }) => {
  const state = await fixture(page, { readonly: true, count: 0, fields: columns.slice(1, 3) });
  await header(page, "xutiStyleNo").click();
  await header(page, "material").click({ modifiers: ["Shift"] });
  await expect(page.locator("thead th[data-column-selected]")).toHaveCount(2);
  await header(page, "material").click({ button: "right" });
  await menuAction(page, "复制表头");
  await expect(page.getByText("表头已复制", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("序缇款号\t成分说明");
  await expect(page.locator("thead th[data-column-selected]")).toHaveCount(2);
  await header(page, "material").click({ button: "right" });
  await menuAction(page, "复制选区为图片");
  await expect(page.getByText("选区图片已复制", { exact: true })).toBeVisible();
  const png = await pngClipboard(page);
  expect(png.width).toBeGreaterThanOrEqual(340);
  expect(png.height).toBeGreaterThan(20);
  expect(png.height).toBeLessThan(100);
  expect(png.colors.dark).toBeGreaterThan(20);
  expect(state.writes).toEqual([]);
});

test("unsupported image data URL produces one placeholder warning while copying the remaining content", async ({ page }, testInfo) => {
  const state = await fixture(page, { readonly: true, count: 1, unsupportedImage: true });
  // The browser can display SVG, but the range copier deliberately accepts bitmap data URLs only.
  await expect(cell(page, 1, "images").locator("img")).toBeVisible();
  await selectRectangle(page, cell(page, 1, "images"), cell(page, 1, "material"));
  await expect(page.locator("td.selection-cell-active")).toHaveCount(3);
  await cell(page, 1, "material").click({ button: "right", position: { x: 2, y: 2 } });
  await menuAction(page, "复制选区为图片");
  await expect(page.getByText("图片已复制，1张图片无法加载，已显示占位图", { exact: true })).toBeVisible();
  const png = await pngClipboard(page);
  expect(png.width).toBeGreaterThanOrEqual(460);
  expect(png.height).toBeGreaterThan(100);
  expect(png.colors.red).toBe(0);
  expect(png.colors.black).toBeGreaterThan(50); // The allowed composition text remains, in its configured black color.
  expect(state.writes).toEqual([]);
  await expect(page.locator("td.selection-cell-active")).toHaveCount(3);
  await testInfo.attach("unsupported-image-clipboard.png", { body: Buffer.from(png.base64, "base64"), contentType: "image/png" });
});

test("compact 5000-per-page column image includes 205 records beyond the virtualized DOM", async ({ page }, testInfo) => {
  await fixture(page, { readonly: true, compact: true, count: 205, fields: [columns[1]] });
  const sheet = page.locator(".selection-sheet");
  await expect(sheet).toHaveAttribute("data-windowed", "true");
  await expect(page.locator(".selection-pagination")).toContainText("5000");
  await expect(cell(page, 205, "xutiStyleNo")).toHaveCount(0);
  const renderedRows = await page.locator("tbody tr[data-selection-row]").count();
  expect(renderedRows).toBeLessThan(100);
  await header(page, "xutiStyleNo").click();
  await header(page, "xutiStyleNo").click({ button: "right" });
  await menuAction(page, "复制选区为图片");
  await expect(page.getByText("选区图片已复制", { exact: true })).toBeVisible();
  const png = await pngClipboard(page);
  expect(png.width).toBeGreaterThanOrEqual(170);
  expect(png.height).toBeGreaterThan(8000);
  expect(png.height).toBeLessThanOrEqual(12000);
  expect(png.colors.bottomBlue).toBeGreaterThan(1000); // Only the final offscreen record has this fill.
  await expect(cell(page, 205, "xutiStyleNo")).toHaveCount(0);
  await testInfo.attach("virtual-column-clipboard.png", { body: Buffer.from(png.base64, "base64"), contentType: "image/png" });
});

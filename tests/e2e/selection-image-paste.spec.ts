import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";
import { selectionLayoutSchema, type SelectionField } from "../../packages/contracts/src/selection-layout.js";

type Picture = { id: string; color: string; url: string };
type Row = {
  id: string; sortOrder: number; xutiStyleNo: string; color: string; material: string;
  images: Picture[]; labelImages: Picture[]; extraFields: Record<string, string>;
  createdAt: string; updatedAt: string; defaultCellAccess: "edit";
  cellAccess: Record<string, "edit" | "read">; policyRevision: number;
  migrationLocked?: boolean;
};
const customImage = "custom:paste-photo";
const imageConfig = { colors: true, links: true, upload: true, mobile: false, max: 5 };
const columns: SelectionField[] = [
  { key: "images", label: "图片", width: 145, type: "image", imageConfig },
  { key: "xutiStyleNo", label: "序缇款号", width: 180, type: "text" },
  { key: "labelImages", label: "洗唛/吊牌图", width: 145, type: "image", imageConfig: { ...imageConfig, colors: false } },
  { key: customImage, label: "自定义细节图", width: 160, custom: true, ownerId: "11", visibility: "PUBLIC", type: "image", imageConfig },
  { key: "material", label: "成分说明", width: 240, type: "text" },
];

async function fixture(page: Page, options: { max?: number; labelUpload?: boolean; labelLinks?: boolean } = {}) {
  let revision = 1, readonly = false, uploadFailure = false;
  const preferences = selectionLayoutSchema.parse({
    columns: columns.map(column => column.key === "images" && options.max
      ? { ...column, imageConfig: { ...imageConfig, max: options.max } }
      : column.key === "labelImages" && (options.labelUpload === false || options.labelLinks === false)
        ? { ...column, imageConfig: { ...imageConfig, colors: false, upload: options.labelUpload !== false, links: options.labelLinks !== false } }
        : column),
    rowHeight: "normal", pageSize: 200, sort: "sortOrder", direction: "asc",
  });
  const rows: Row[] = Array.from({ length: 4 }, (_, index) => ({
    id: String(index + 1), sortOrder: index + 1, xutiStyleNo: `PASTE-IMAGE-0${index + 1}`,
    color: "蓝色", material: "桑蚕丝100%", images: index === 1
      ? [{ id: "original-product", color: "蓝色", url: "/api/v1/style-selections/images/original" }] : [],
    labelImages: [], extraFields: {}, createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.001Z", defaultCellAccess: "edit", policyRevision: 0,
    cellAccess: Object.fromEntries(columns.map(column => [column.key, index === 2 ? "read" : "edit"])),
    ...(index === 3 ? { migrationLocked: true } : {}),
  }));
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 96;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#086ba6"; context.fillRect(0, 0, 96, 96);
    context.fillStyle = "#e5f7ff"; context.fillRect(18, 12, 60, 72);
    context.fillStyle = "#086ba6"; context.font = "bold 22px sans-serif"; context.fillText("PNG", 23, 58);
    return canvas.toDataURL("image/png");
  });
  const uploads: { data: string }[] = [], patches: { id: string; body: Record<string, unknown> }[] = [];
  const current = (id: string) => rows.find(row => row.id === id)!;
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const method = request.method();
    if (/\/style-selections\/images\//u.test(path))
      return route.fulfill({ contentType: "image/png", body: Buffer.from(png.split(",")[1], "base64") });
    if (path.endsWith("/style-selections/images") && method === "POST") {
      uploads.push(request.postDataJSON());
      if (uploadFailure) return route.fulfill({ status: 503, json: { error: { code: "UPLOAD_FAILED", message: "图片上传暂时失败，请重试" } } });
      return route.fulfill({ json: { data: { url: `/api/v1/style-selections/images/pasted-${uploads.length}` } } });
    }
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "11", displayName: "图片粘贴验证", roleCodes: [], csrfToken: "fixture",
      permissions: readonly ? ["selection.read"] : ["selection.read", "selection.manage"] };
    if (path.endsWith("/layout-preferences")) data = { preferences, revision: 0, sharedPreferences: null, sharedRevision: 0, canEditShared: !readonly };
    if (path.endsWith("/revision")) data = { revision: `paste-${revision}` };
    if (path.endsWith("/sync")) data = { revision: `paste-${revision}`, index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/protection")) data = { settings: defaultProtection, revision: 0, canManage: false };
    if (/\/style-selections\/\d+$/u.test(path) && method === "PATCH") {
      const id = path.split("/").at(-1)!, row = current(id), body = request.postDataJSON();
      patches.push({ id, body });
      if (body.expectedUpdatedAt !== row.updatedAt) return route.fulfill({ status: 409, json: { error: { code: "EDIT_CONFLICT", message: "记录已修改" } } });
      const { expectedUpdatedAt: _expectedUpdatedAt, ensureTrailingBlank: _ensureTrailingBlank, ...values } = body;
      Object.assign(row, values, { extraFields: { ...row.extraFields, ...values.extraFields }, updatedAt: new Date(Date.UTC(2026, 9, 17) + ++revision).toISOString() });
      data = row;
    }
    await route.fulfill({ json: { data } });
  });
  await page.route("https://paste-image.example.test/**", route => route.fulfill({ contentType: "image/png", body: Buffer.from(png.split(",")[1], "base64") }));
  await page.goto("/style-selections");
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(4);
  return { current, rows, uploads, patches, png, setReadonly: () => { readonly = true; }, failUpload: (value: boolean) => { uploadFailure = value; } };
}

const cell = (page: Page, id: string, key = "images") => page.locator(`td[data-selection-row="${id}"][data-selection-column="${key}"]`);

async function pastePng(target: Locator, png: string, options: { count?: number; text?: string; filesOnly?: boolean } = {}) {
  return target.evaluate((element, { png, count, text, filesOnly }) => {
    const bytes = Uint8Array.from(atob(png.split(",")[1]), character => character.charCodeAt(0));
    const clipboardData = new DataTransfer();
    for (let index = 0; index < count; index++) clipboardData.items.add(new File([bytes], `paste-${index}.png`, { type: "image/png" }));
    if (text) clipboardData.setData("text/plain", text);
    if (filesOnly) Object.defineProperty(clipboardData, "items", { value: [] });
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData });
    element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented };
  }, { png, count: options.count ?? 1, text: options.text ?? "", filesOnly: options.filesOnly ?? false });
}

async function pasteText(target: Locator, text: string) {
  return target.evaluate((element, value) => {
    const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", value);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData });
    element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented };
  }, text);
}

test.beforeEach(async ({ context }) => { await context.grantPermissions(["clipboard-read", "clipboard-write"]); });

test("clicking an empty cell then native Ctrl+V uploads once, saves its row and survives reload", async ({ page }) => {
  const state = await fixture(page);
  await cell(page, "1").click({ position: { x: 3, y: 3 } });
  await expect(cell(page, "1")).toBeFocused();
  await page.evaluate(async png => {
    const response = await fetch(png), blob = await response.blob();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }, state.png);
  await page.keyboard.press("Control+V");
  await expect.poll(() => state.current("1").images.length).toBe(1);
  expect(state.uploads).toHaveLength(1); expect(state.patches.map(patch => patch.id)).toEqual(["1"]);
  expect(state.uploads[0].data).toMatch(/^data:image\/png;base64,/u);
  expect(state.current("1").images[0]).toMatchObject({ url: "/api/v1/style-selections/images/pasted-1", color: "蓝色" });
  expect(state.current("2").images).toHaveLength(1);
  await page.reload();
  await expect(cell(page, "1").locator(".selection-image-slide img")).toHaveAttribute("src", "/api/v1/style-selections/images/pasted-1");
  await expect.poll(() => cell(page, "1").locator(".selection-image-slide img").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await mkdir(".local", { recursive: true });
  await page.screenshot({ path: ".local/selection-image-paste-fixed-20261017.png", fullPage: true });
});

test("binary image wins over accompanying text and inner carousel/gallery paste never doubles an upload", async ({ page }) => {
  const state = await fixture(page);
  const summary = cell(page, "2").locator(".selection-image-summary");
  await summary.focus();
  expect((await pastePng(summary, state.png, { text: "https://invalid.example/should-not-be-added.png\t不要改写款号" })).defaultPrevented).toBe(true);
  await expect.poll(() => state.current("2").images.length).toBe(2);
  expect(state.uploads).toHaveLength(1); expect(state.patches).toHaveLength(1);
  expect(state.current("2").images[0].id).toBe("original-product");
  expect(state.current("2").xutiStyleNo).toBe("PASTE-IMAGE-02");
  await cell(page, "2").getByRole("button", { name: "全部", exact: true }).click();
  const gallery = page.locator(".selection-image-gallery .selection-image-editor");
  await gallery.focus(); await pastePng(gallery, state.png);
  await expect.poll(() => state.current("2").images.length).toBe(3);
  expect(state.uploads).toHaveLength(2); expect(state.patches).toHaveLength(2);
  expect(state.current("1").images).toEqual([]);
});

test("focused label/custom image cells use their own field and clipboard files fallback", async ({ page }) => {
  const state = await fixture(page);
  await cell(page, "1", "labelImages").focus();
  await pastePng(cell(page, "1", "labelImages"), state.png, { filesOnly: true });
  await expect.poll(() => state.current("1").labelImages.length).toBe(1);
  expect(state.current("1").labelImages[0].color).toBe("");
  expect(state.patches[0].body).toHaveProperty("labelImages");
  expect(state.patches[0].body).not.toHaveProperty("images");
  await cell(page, "2", customImage).focus();
  await pastePng(cell(page, "2", customImage), state.png);
  await expect.poll(() => JSON.parse(state.current("2").extraFields[customImage] || "[]").length).toBe(1);
  expect(state.patches[1].body).toHaveProperty(`extraFields.${customImage}`);
  expect(state.current("2").images).toHaveLength(1);
  await page.reload();
  await expect(cell(page, "1", "labelImages").locator(".selection-image-slide img")).toBeVisible();
  await expect(cell(page, "2", customImage).locator(".selection-image-slide img")).toBeVisible();
  expect(state.uploads).toHaveLength(2);
});

test("a selected image range only pastes into the target cell", async ({ page }) => {
  const state = await fixture(page);
  const first = cell(page, "1"), second = cell(page, "2");
  const a = (await first.boundingBox())!, b = (await second.boundingBox())!;
  await page.mouse.move(a.x + 3, a.y + 3); await page.mouse.down();
  await page.mouse.move(b.x + b.width - 4, b.y + b.height - 4, { steps: 10 }); await page.mouse.up();
  await expect(page.locator("td.selection-cell-active")).toHaveCount(2);
  await pastePng(second, state.png);
  await expect.poll(() => state.current("2").images.length).toBe(2);
  expect(state.current("1").images).toEqual([]); expect(state.uploads).toHaveLength(1);
  expect(state.patches.map(patch => patch.id)).toEqual(["2"]);
});

test("cell read-only, migration lock, disabled uploads and account read-only never upload or save", async ({ page }) => {
  const state = await fixture(page, { labelUpload: false });
  for (const target of [cell(page, "3"), cell(page, "4"), cell(page, "1", "labelImages")]) {
    await target.focus(); await pastePng(target, state.png);
  }
  state.setReadonly(); await page.reload();
  await expect(cell(page, "1")).toBeVisible();
  await cell(page, "1").focus(); await pastePng(cell(page, "1"), state.png);
  await page.waitForTimeout(1200); // Exceed the 900 ms autosave delay before checking absence of writes.
  expect(state.uploads).toEqual([]); expect(state.patches).toEqual([]);
  expect(state.current("1").images).toEqual([]); expect(state.current("3").images).toEqual([]);
});

test("normal text paste stays native in a textarea and image URL input without an upload", async ({ page }) => {
  const state = await fixture(page);
  const text = cell(page, "1", "material").getByRole("textbox");
  await text.dblclick(); await text.press("Control+A");
  await page.evaluate(() => navigator.clipboard.writeText("正常粘贴的成分说明"));
  await page.keyboard.press("Control+V");
  await expect(text).toHaveValue("正常粘贴的成分说明");
  await expect.poll(() => state.current("1").material).toBe("正常粘贴的成分说明");
  expect((await pastePng(text, state.png)).defaultPrevented).toBe(false);
  await cell(page, "1").getByRole("button", { name: "+ 图片", exact: true }).click();
  await page.locator(".selection-image-gallery").getByRole("button", { name: /链接$/u }).click();
  const urlInput = page.getByRole("textbox", { name: "图片网址", exact: true });
  await urlInput.focus();
  expect((await pastePng(urlInput, state.png)).defaultPrevented).toBe(false);
  await page.evaluate(() => navigator.clipboard.writeText("https://example.test/picture.png"));
  await page.keyboard.press("Control+V");
  await expect(urlInput).toHaveValue("https://example.test/picture.png");
  expect(state.uploads).toEqual([]); expect(state.current("1").images).toEqual([]);
});

test("image limits block the whole over-limit batch and a failed upload can retry without replacing originals", async ({ page }) => {
  const state = await fixture(page, { max: 2 });
  await cell(page, "2").focus();
  await pastePng(cell(page, "2"), state.png, { count: 2 });
  await expect(page.getByText("最多 2 张图片", { exact: true }).last()).toBeVisible();
  expect(state.uploads).toEqual([]); expect(state.current("2").images).toHaveLength(1);
  state.failUpload(true); await pastePng(cell(page, "2"), state.png);
  await expect(page.getByText("图片上传暂时失败，请重试", { exact: true })).toBeVisible();
  expect(state.patches).toEqual([]); expect(state.current("2").images[0].id).toBe("original-product");
  state.failUpload(false); await pastePng(cell(page, "2"), state.png);
  await expect.poll(() => state.current("2").images.length).toBe(2);
  await pastePng(cell(page, "2"), state.png);
  await expect(page.getByText("最多 2 张图片", { exact: true }).last()).toBeVisible();
  expect(state.uploads).toHaveLength(2); expect(state.patches).toHaveLength(1);
  expect(state.current("2").images[0].id).toBe("original-product");
});

test("direct URL paste appends built-in/custom images and respects maximum and disabled links", async ({ page }) => {
  const state = await fixture(page, { max: 2, labelLinks: false });
  await cell(page, "2").focus();
  const direct = "https://paste-image.example.test/direct.png";
  expect((await pasteText(cell(page, "2"), direct)).defaultPrevented).toBe(true);
  await expect.poll(() => state.current("2").images.length).toBe(2);
  expect(state.current("2").images[0].id).toBe("original-product");
  expect(state.current("2").images[1].url).toBe(direct);
  await pasteText(cell(page, "2"), "https://paste-image.example.test/over-limit.png");
  await expect(page.getByText("最多 2 张图片", { exact: true }).last()).toBeVisible();
  await cell(page, "1", customImage).focus();
  await pasteText(cell(page, "1", customImage), "https://paste-image.example.test/detail-a.png\nhttps://paste-image.example.test/detail-b.png");
  await expect.poll(() => JSON.parse(state.current("1").extraFields[customImage] || "[]").map((image: Picture) => image.url))
    .toEqual(["https://paste-image.example.test/detail-a.png", "https://paste-image.example.test/detail-b.png"]);
  await cell(page, "1", "labelImages").focus();
  await pasteText(cell(page, "1", "labelImages"), "https://paste-image.example.test/disabled.png");
  await page.waitForTimeout(1200);
  expect(state.current("1").labelImages).toEqual([]); expect(state.current("1").images).toEqual([]);
  expect(state.current("2").images).toHaveLength(2); expect(state.uploads).toEqual([]);
  expect(state.patches.map(patch => patch.id)).toEqual(["2", "1"]);
});

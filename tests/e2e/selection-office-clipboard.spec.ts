import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import ExcelJS from "exceljs";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

const cell = (page: Page, id: number, key: string) => page.locator(`td[data-selection-row="${id}"][data-selection-column="${key}"]`);
async function fixture(page: Page, options: { count?: number; hidden?: boolean; failed?: boolean; wide?: boolean; failedImage?: number; waitForPictures?: Promise<void> } = {}) {
  const fields = [
    { key: "images", label: "图片", type: "image", width: 120 },
    { key: "xutiStyleNo", label: "序缇款号", type: "text", width: 160 },
    { key: "custom:photos", label: "细节图片", type: "image", custom: true, width: 120 },
    { key: "material", label: "成分", type: "text", width: 160 },
  ];
  if (options.wide) fields.push(...["supplierStyleNo", "supplierCode", "color"].map(key => ({ key, label: key, type: "text", width: 120 })));
  let failedImage = options.failedImage;
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
      if (Number(path.split("/").at(-1)?.split(".")[0]) === failedImage) {
        await route.fulfill({ status: 400, json: { error: { code: "CLIPBOARD_IMAGE_TOO_LARGE", message: "原图超过 32 MB，请压缩或重新上传后复制" } } }); return;
      }
      await options.waitForPictures;
      await route.fulfill({ contentType: "image/jpeg", body: jpeg }); return;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(cell(page, 1, "images")).toBeVisible();
  return { minted, imageRequests, recoverPictures: () => { failedImage = undefined; } };
}
async function copy(page: Page) {
  return page.locator(".selection-sheet table").evaluate(element => {
    const data = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data }));
    return { text: data.getData("text/plain"), html: data.getData("text/html") };
  });
}
const copies = (page: Page) => page.evaluate(() => (window as any).officeCopies as Record<string, string>[]);

test("62 rows and 124 pictures retain all seven columns in the clipboard and embedded workbook", async ({ page }) => {
  const state = await fixture(page, { count: 62, wide: true });
  for (const key of ["images", "xutiStyleNo", "custom:photos", "material", "supplierStyleNo", "supplierCode", "color"])
    await page.locator(`th[data-selection-column="${key}"]`).click({ modifiers: key === "images" ? [] : ["Control"] });
  await copy(page);
  await expect(page.getByText("62 行 · 7 列 · 124 张图片（每个图片格第一张）")).toBeVisible();
  await expect.poll(async () => (await copies(page)).length).toBe(1);
  expect(state.minted[0]).toHaveLength(124);
  expect((await copies(page))[0]["text/html"].match(/<img /g)).toHaveLength(124);
  expect((await copies(page))[0]["text/html"].match(/<td /g)).toHaveLength(62 * 7);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载带图表格" }).click();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile((await (await downloaded).path())!);
  expect(workbook.worksheets[0].rowCount).toBe(62);
  expect(workbook.worksheets[0].getImages()).toHaveLength(124);
  expect(workbook.worksheets[0].getCell(23, 2).value).toBe("00023");
});

test("the 45th failing picture identifies its style and field and a fresh preparation can succeed", async ({ page }) => {
  const state = await fixture(page, { count: 62, failedImage: 44 });
  await page.locator('th[data-selection-column="images"]').click();
  await page.locator('th[data-selection-column="custom:photos"]').click({ modifiers: ["Control"] });
  await copy(page);
  await expect(page.getByText("00023 · 图片（第 45/124 张图片）准备失败：原图超过 32 MB，请压缩或重新上传后复制")).toBeVisible();
  await expect(page.getByRole("button", { name: "下载带图表格" })).toBeDisabled();
  expect(await copies(page)).toHaveLength(0);
  state.recoverPictures();
  await page.getByRole("button", { name: "重新准备" }).click();
  await expect.poll(async () => (await copies(page)).length).toBe(1);
  expect((await copies(page))[0]["text/html"].match(/<img /g)).toHaveLength(124);
});

for (const selection of ["headers", "filled-axis shortcut"] as const) {
test(`multiple rows selected with ${selection} paste as an editable HTML grid with one picture each and aligned style numbers`, async ({ page }) => {
  const state = await fixture(page);
  if (selection === "headers") {
    await page.locator('th[data-selection-column="images"]').click();
    await page.locator('th[data-selection-column="xutiStyleNo"]').click({ modifiers: ["Control"] });
  } else {
    const start = (await cell(page, 1, "images").boundingBox())!, end = (await cell(page, 1, "xutiStyleNo").boundingBox())!;
    await page.mouse.move(start.x + 3, start.y + start.height / 2); await page.mouse.down();
    await page.mouse.move(end.x + 3, end.y + end.height / 2, { steps: 6 }); await page.mouse.up();
    await expect(page.locator("td.selection-cell-active")).toHaveCount(2);
    await page.keyboard.press("Control+Shift+ArrowDown");
    await expect(page.locator("td.selection-cell-active")).toHaveCount(6);
  }
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
  expect(fallback).toEqual({ text: "", html: "" });
  expect((await copies(page))[0]["text/plain"]).toContain("\t0002");
  await expect(page.getByText("图文已复制，可切换到 Excel / WPS 粘贴")).toBeVisible();
});
}

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

test("a revoked picture reports failure without publishing URL-only clipboard data", async ({ page }) => {
  const state = await fixture(page, { failed: true });
  await cell(page, 1, "images").click({ position: { x: 2, y: 2 } });
  const result = await copy(page);
  await expect(page.getByText("图片查看权限已变更")).toBeVisible();
  await expect(page.getByText("本次图文未复制")).toBeVisible();
  expect(result).toEqual({ text: "", html: "" });
  await expect(page.getByRole("button", { name: "下载带图表格" })).toBeDisabled();
  expect(await copies(page)).toHaveLength(0);
  expect(state.imageRequests).toHaveLength(0);
});

test("switching apps during preparation keeps the prepared selection for a fresh copy gesture", async ({ page }) => {
  let release!: () => void;
  await fixture(page, { waitForPictures: new Promise<void>(resolve => { release = resolve; }) });
  await page.locator('th[data-selection-column="images"]').click();
  await page.locator('th[data-selection-column="xutiStyleNo"]').click({ modifiers: ["Control"] });
  const initial = await copy(page);
  expect(initial).toEqual({ text: "", html: "" });
  await expect(page.getByText("正在准备图片，尚未完成复制")).toBeVisible();
  await expect(page.getByRole("button", { name: "复制图文", exact: true })).toBeDisabled();
  await page.evaluate(() => Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false }));
  release();
  await expect(page.getByText("图片已准备，请点击「复制图文」", { exact: true })).toBeVisible();
  expect(await copies(page)).toHaveLength(0);
  await page.getByRole("button", { name: "复制图文", exact: true }).click();
  await expect.poll(async () => (await copies(page)).length).toBe(1);
  expect((await copies(page))[0]["text/html"].match(/<img /g)).toHaveLength(3);
  expect((await copies(page))[0]["text/html"]).toContain("0003</td>");
});

test("denied async clipboard write can be retried with native copy from the prepared dialog", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { navigator.clipboard.write = async () => { throw new DOMException("Denied", "NotAllowedError"); }; });
  await cell(page, 1, "images").click({ position: { x: 2, y: 2 } });
  await copy(page);
  await expect(page.getByText("复制提示", { exact: true })).toBeVisible();
  const result = await page.getByRole("dialog").evaluate(element => {
    const data = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data }));
    return data.getData("text/html");
  });
  expect(result.match(/<img /g)).toHaveLength(1);
  expect(result).not.toContain("/test-images/");
  await expect(page.getByText("图文已复制，可切换到 Excel / WPS 粘贴")).toBeVisible();
});

test("closing while preparing cancels the job without late clipboard writes", async ({ page }) => {
  let release!: () => void;
  const state = await fixture(page, { waitForPictures: new Promise<void>(resolve => { release = resolve; }) });
  await cell(page, 1, "images").click({ position: { x: 2, y: 2 } });
  await copy(page);
  await expect.poll(() => state.imageRequests.length).toBe(1);
  await page.getByRole("dialog").getByRole("button", { name: "关闭复制窗口", exact: true }).click();
  release();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(await copies(page)).toHaveLength(0);
});

test("copying after a long pause refreshes expiring image links before writing", async ({ page }) => {
  const state = await fixture(page);
  await cell(page, 1, "images").click({ position: { x: 2, y: 2 } });
  await copy(page);
  await expect.poll(async () => (await copies(page)).length).toBe(1);
  await page.evaluate(() => { const now = Date.now(); Date.now = () => now + 15 * 60_000; });
  await page.getByRole("button", { name: "再次复制", exact: true }).click();
  await expect.poll(async () => (await copies(page)).length).toBe(2);
  expect(state.minted).toHaveLength(2);
  expect(state.imageRequests).toHaveLength(2);
});

test("download embeds the first picture in each row with editable aligned style and composition cells", async ({ page }) => {
  await fixture(page);
  for (const key of ["images", "xutiStyleNo", "material"]) {
    await page.locator(`th[data-selection-column="${key}"]`).click({ modifiers: key === "images" ? [] : ["Control"] });
  }
  await copy(page);
  await expect(page.getByRole("button", { name: "下载带图表格" })).toBeEnabled();
  const downloadReady = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载带图表格" }).click();
  const download = await downloadReady;
  expect(download.suggestedFilename()).toBe("表格选区_带图.xlsx");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile((await download.path())!);
  const sheet = workbook.worksheets[0];
  expect(sheet.rowCount).toBe(3);
  expect(sheet.getImages()).toHaveLength(3);
  for (let index = 0; index < 3; index++) {
    expect(sheet.getCell(index + 1, 1).value).toBe("");
    expect(sheet.getCell(index + 1, 2).value).toBe(`000${index + 1}`);
    expect(sheet.getCell(index + 1, 3).value).toBe("第一行\n第二行");
    const image = sheet.getImages()[index];
    expect(image.range.tl.nativeRow).toBe(index);
    expect(image.range.tl.nativeCol).toBe(0);
    const media = workbook.getImage(Number(image.imageId));
    expect(media.extension).toBe("jpeg");
    expect(media.buffer?.byteLength).toBeGreaterThan(0);
  }
});

import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { randomBytes, createHash } from "node:crypto";
import { selectionLayoutSchema, projectSelectionSharedLayout } from "../../packages/contracts/src/selection-layout.js";

type InputImage = { path: string; base64: string; type: string };
async function jpg(path: string, width = 1200, height = 1200): Promise<InputImage> {
  return { path, type: "image/jpeg", base64: (await sharp({ create: { width, height, channels: 3, background: "#467ba1" } }).jpeg().toBuffer()).toString("base64") };
}
async function flat(path: string): Promise<InputImage> {
  return { path, type: "image/png", base64: (await sharp({ create: { width: 800, height: 800, channels: 4, background: { r: 155, g: 55, b: 50, alpha: 0.6 } } }).png().toBuffer()).toString("base64") };
}
async function installDirectory(page: Page, files: InputImage[], options: { deny?: boolean; writeFailure?: string; abortOnWrite?: boolean } = {}) {
  await page.addInitScript(({ files, options }) => {
    const win = window as any;
    win.batchWrites = {}; win.batchSourceWrites = []; win.batchReadCount = 0;
    function directory(name: string, path = "") {
      const entries = new Map<string, any>();
      return { kind: "directory", name, entries,
        async *values() { for (const entry of entries.values()) yield entry; },
        async requestPermission() { return options.deny ? "denied" : "granted"; },
        async getDirectoryHandle(child: string, config?: { create?: boolean }) {
          if (!entries.has(child)) {
            if (!config?.create) throw new DOMException("missing", "NotFoundError");
            entries.set(child, directory(child, path + child + "/"));
          }
          if (entries.get(child).kind !== "directory") throw new DOMException("not a directory", "TypeMismatchError");
          return entries.get(child);
        },
        async getFileHandle(child: string, config?: { create?: boolean }) {
          if (!entries.has(child)) {
            if (!config?.create) throw new DOMException("missing", "NotFoundError");
            entries.set(child, { kind: "file", name: child, async createWritable() {
              let pending: Blob | string;
              return { async write(data: Blob | string) {
                if (options.writeFailure && (path + child).endsWith(options.writeFailure)) throw new DOMException("模拟磁盘写入失败", "NotAllowedError");
                pending = data;
              }, async close() {
                win.batchWrites[path + child] = pending;
                if (options.abortOnWrite && child !== "处理清单.json") win.batchAbort?.abort();
              }, async abort() {} };
            } });
          }
          return entries.get(child);
        },
      };
    }
    const root = directory("原图目录");
    for (const input of files) {
      const parts = input.path.split("/"); let parent = root;
      for (const name of parts.slice(0, -1)) {
        if (!parent.entries.has(name)) parent.entries.set(name, directory(name));
        parent = parent.entries.get(name);
      }
      const name = parts.at(-1)!, bytes = Uint8Array.from(atob(input.base64), char => char.charCodeAt(0));
      const file = new File([bytes], name, { type: input.type });
      parent.entries.set(name, { kind: "file", name, async getFile() { win.batchReadCount++; return file; }, async createWritable() { win.batchSourceWrites.push(input.path); throw Error("禁止修改源文件"); } });
    }
    win.batchRoot = root;
    win.showDirectoryPicker = async () => root;
  }, { files, options });
}
async function fixture(page: Page, path = "/products") {
  const preferences = selectionLayoutSchema.parse({ columns: [{ key: "xutiStyleNo", label: "序缇款号", type: "text" }] });
  const writes: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    let data: unknown = [];
    if (pathname.endsWith("/auth/me")) data = { id: "1", displayName: "图片命名测试", csrfToken: "test", roleCodes: [], permissions: ["product.read", "selection.read", "project.read"] };
    if (pathname.endsWith("/product-archive-table")) data = { id: "3", initialLayout: "selection", fields: [], references: {}, canEdit: false, canManage: false };
    if (pathname.endsWith("/project-tables/7")) data = { id: "7", name: "图片协作表", initialLayout: "selection", canEdit: false, canManage: false };
    if (pathname.endsWith("/sync")) data = { revision: "1", index: [], data: [] };
    if (pathname.endsWith("/revision")) data = { revision: "1" };
    if (pathname.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (pathname.endsWith("/layout-preferences")) data = { preferences, revision: 1, sharedPreferences: projectSelectionSharedLayout(preferences), sharedRevision: 1, canEditShared: false };
    if (request.method() !== "GET" && /uploads|style-selections\/\d+(?:\/bulk)?$/.test(pathname)) writes.push(pathname);
    await route.fulfill({ json: { data } });
  });
  await page.goto(path);
  await page.getByRole("button", { name: "工具箱", exact: true }).click();
  await page.getByRole("button", { name: "图片批量命名", exact: true }).click();
  const tool = page.getByRole("dialog", { name: "图片批量命名", exact: true });
  await expect(tool).toBeVisible();
  return { tool, writes };
}
async function outputData(page: Page) {
  return page.evaluate(async () => {
    const result: Record<string, { type: string; base64: string }> = {};
    for (const [path, data] of Object.entries((window as any).batchWrites)) {
      const blob = typeof data === "string" ? new Blob([data], { type: "application/json" }) : data as Blob;
      const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      result[path] = { type: blob.type, base64: btoa(binary) };
    }
    return result;
  });
}
test("工具箱批量生成单色与多色成品，保留原图并跳过旧结果目录", async ({ page }) => {
  const files = [await jpg("SINGLE123/主图1.jpg"), await jpg("SINGLE123/主图2.jpg"), await jpg("SINGLE123/主图3.jpg"), await jpg("SINGLE123/主图4.jpg"), await jpg("SINGLE123/主图5.jpg"), await flat("SINGLE123/透明平铺.png"), await jpg("SINGLE123/列表.jpg", 950, 1200), await jpg("SINGLE123/吊牌.jpg", 640, 840), await jpg("SINGLE123/详情.jpg", 900, 2600),
    await jpg("MULTI456/MULTI456001/原图1.jpg"), await flat("MULTI456/MULTI456001/透明平铺.png"), await jpg("MULTI456/MULTI456002/原图1.jpg"), await jpg("MULTI456/MULTI456002/列表.jpg", 950, 1200), await jpg("MULTI456/详情.jpg", 900, 1230), await jpg("MULTI456/吊牌.jpg", 640, 840), await jpg("图片命名结果-旧/NEVER/1.jpg")];
  await installDirectory(page, files);
  const { tool, writes } = await fixture(page);
  await tool.getByRole("button", { name: "选择本地目录", exact: true }).click();
  await expect(tool).toContainText("2 款 · 15 张图片 · 待确认 0 张");
  expect(await page.evaluate(() => (window as any).batchReadCount)).toBe(15);
  expect(await page.evaluate(() => Object.keys((window as any).batchWrites))).toEqual([]);
  await expect(tool.getByRole("cell", { name: "SINGLE123/15.jpg", exact: true })).toBeVisible();
  await tool.screenshot({ path: test.info().outputPath("image-batch-preview.png") });
  await tool.getByRole("button", { name: "开始处理 15 张", exact: true }).click();
  await expect(tool).toContainText("处理完成：成功 15 张，失败 0 张");
  const output = await outputData(page);
  const prefix = Object.keys(output)[0].split("/")[0];
  expect(Object.keys(output).map(key => key.slice(prefix.length + 1))).toEqual(expect.arrayContaining(["SINGLE123/1.jpg", "SINGLE123/15.jpg", "SINGLE123/30.png", "SINGLE123/50.jpg", "SINGLE123/601.jpg", "SINGLE123/826.jpg", "MULTI456/MULTI456001/1.jpg", "MULTI456/MULTI456001/30.png", "MULTI456/MULTI456002/1.jpg", "MULTI456/MULTI456002/50.jpg", "MULTI456/601.jpg", "MULTI456/826.jpg", "处理清单.json"]));
  const original = files.find(file => file.path === "SINGLE123/主图1.jpg")!;
  expect(createHash("sha256").update(Buffer.from(output[`${prefix}/SINGLE123/1.jpg`].base64, "base64")).digest("hex")).toBe(createHash("sha256").update(Buffer.from(original.base64, "base64")).digest("hex"));
  expect(await page.evaluate(() => (window as any).batchSourceWrites)).toEqual([]);
  expect(writes).toEqual([]);
  await tool.getByRole("button", { name: "开始处理 15 张", exact: true }).click();
  await expect.poll(() => page.evaluate(() => new Set(Object.keys((window as any).batchWrites).map(key => key.split("/")[0])).size)).toBe(2);
});
test("超限 JPEG 与透明 PNG 真正压缩至限额，输出编码和透明度正确", async ({ page }) => {
  const width = 1600, height = 1600;
  const pixels = randomBytes(width * height * 4);
  for (let index = 3; index < pixels.length; index += 4) pixels[index] = index % 12 === 3 ? 0 : 255;
  const jpeg = await sharp(pixels, { raw: { width, height, channels: 4 } }).removeAlpha().jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  expect(jpeg.length).toBeGreaterThan(1024 * 1024); expect(png.length).toBeGreaterThan(600 * 1024);
  await installDirectory(page, [{ path: "STYLE123/主图.jpg", type: "image/jpeg", base64: jpeg.toString("base64") }, { path: "STYLE123/30.png", type: "image/png", base64: png.toString("base64") }]);
  const { tool } = await fixture(page);
  await tool.getByRole("button", { name: "选择本地目录", exact: true }).click();
  await tool.getByRole("button", { name: "开始处理 2 张", exact: true }).click();
  await expect(tool).toContainText("处理完成：成功 2 张，失败 0 张", { timeout: 30000 });
  const output = await outputData(page);
  const jpegOut = Buffer.from(Object.entries(output).find(([path]) => path.endsWith("/1.jpg"))![1].base64, "base64");
  const pngOut = Buffer.from(Object.entries(output).find(([path]) => path.endsWith("/30.png"))![1].base64, "base64");
  expect(jpegOut.length).toBeLessThanOrEqual(1024 * 1024); expect(pngOut.length).toBeLessThanOrEqual(600 * 1024);
  const j = await sharp(jpegOut).metadata(), p = await sharp(pngOut).metadata();
  expect(j.format).toBe("jpeg"); expect(j.width).toBe(j.height); expect(j.width).toBeLessThanOrEqual(width);
  expect(p.format).toBe("png"); expect(p.hasAlpha).toBe(true); expect(p.width).toBe(p.height);
  const stats = await sharp(pngOut).stats(); expect(stats.channels[3].min).toBeLessThan(255);
});
test("重名与缺失颜色须修正后才能处理，批量分组支持编号目录", async ({ page }) => {
  await installDirectory(page, [await flat("STYLE123/平铺1.png"), await flat("STYLE123/平铺2.png")]);
  const { tool } = await fixture(page, "/style-selections");
  await tool.getByRole("button", { name: "选择本地目录", exact: true }).click();
  await expect(tool.getByRole("button", { name: /^开始处理/ })).toBeDisabled();
  await tool.getByRole("textbox", { name: "颜色组 STYLE123/平铺1.png", exact: true }).fill("黑色");
  await tool.getByRole("textbox", { name: "颜色组 STYLE123/平铺2.png", exact: true }).fill("白色");
  await tool.getByRole("combobox", { name: "多色目录命名", exact: true }).click();
  await page.getByText("颜色分组文件夹（1）（2）…", { exact: true }).click();
  await tool.getByRole("button", { name: "开始处理 2 张", exact: true }).click();
  await expect(tool).toContainText("处理完成：成功 2 张，失败 0 张");
  const paths = await page.evaluate(() => Object.keys((window as any).batchWrites));
  expect(paths.some(path => path.endsWith("/颜色分组文件夹（1）/30.png"))).toBe(true);
  expect(paths.some(path => path.endsWith("/颜色分组文件夹（2）/30.png"))).toBe(true);
});
test("拒绝写权限时不生成文件，目录可重新选择", async ({ page }) => {
  await installDirectory(page, [await jpg("STYLE123/1.jpg")], { deny: true });
  const { tool } = await fixture(page, "/project-tables/7");
  await tool.getByRole("button", { name: "选择本地目录", exact: true }).click();
  await tool.getByRole("button", { name: "开始处理 1 张", exact: true }).click();
  await expect(tool).toContainText("未获准写入目录");
  expect(await page.evaluate(() => Object.keys((window as any).batchWrites))).toEqual([]);
  await expect(tool.getByRole("button", { name: "选择本地目录", exact: true })).toBeEnabled();
});
test("单文件写入失败有准确清单并继续处理后续图片", async ({ page }) => {
  await installDirectory(page, [await jpg("STYLE123/1.jpg"), await jpg("STYLE123/2.jpg")], { writeFailure: "/1.jpg" });
  const { tool } = await fixture(page);
  await tool.getByRole("button", { name: "选择本地目录", exact: true }).click();
  await tool.getByRole("button", { name: "开始处理 2 张", exact: true }).click();
  await expect(tool).toContainText("处理完成：成功 1 张，失败 1 张");
  const output = await outputData(page);
  const report = JSON.parse(Buffer.from(Object.entries(output).find(([path]) => path.endsWith("处理清单.json"))![1].base64, "base64").toString());
  expect(report.files.map((file: any) => file.status)).toEqual(["failed", "success"]);
  expect(await page.evaluate(() => (window as any).batchSourceWrites)).toEqual([]);
});
test("停止后保留已完成文件并记录未完成数量", async ({ page }) => {
  await installDirectory(page, [await jpg("STYLE123/1.jpg"), await jpg("STYLE123/2.jpg")], { abortOnWrite: true });
  await fixture(page);
  const result = await page.evaluate(async () => {
    const local = await import("/src/image-batch-local.ts" as string);
    const plan = await import("/src/image-batch-plan.ts" as string);
    const win = window as any; win.batchAbort = new AbortController();
    const scan = await local.scanImageDirectory(win.batchRoot, win.batchAbort.signal, () => {});
    return local.runImageBatch(win.batchRoot, plan.buildImageBatchPlan(local.scanToItems(win.batchRoot.name, scan, "auto")), new Map(scan.files.map((file: any) => [file.sourcePath, file.file])), win.batchAbort.signal, () => {});
  });
  expect(result.cancelled).toBe(true); expect(result.files).toHaveLength(1); expect(result.total).toBe(2);
  expect(await page.evaluate(() => (window as any).batchSourceWrites)).toEqual([]);
});

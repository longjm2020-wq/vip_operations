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
async function installDirectory(page: Page, files: InputImage[], options: { deny?: boolean; writeFailure?: string; abortOnWrite?: boolean; rootName?: string } = {}) {
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
    const root = directory(options.rootName || "原图目录");
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
test("单款自动处理将款号连字符替换为 X，保存路径及清单一致", async ({ page }) => {
  const files = [await jpg("主图.jpg"), await jpg("详情.jpg", 900, 1210)];
  await installDirectory(page, files, { rootName: "XFW19-31757L" });
  const { tool, writes } = await fixture(page);
  await tool.getByRole("button", { name: "选择本地目录", exact: true }).click();
  await expect(tool).toContainText("处理完成：成功 2 张，原图另存待确认 0 张，失败 0 张");
  const output = await outputData(page), prefix = Object.keys(output)[0].split("/")[0];
  expect(Object.keys(output).map(path => path.slice(prefix.length + 1)).sort()).toEqual(["XFW19X31757L/1.jpg", "XFW19X31757L/601.jpg", "处理清单.json"].sort());
  const report = JSON.parse(Buffer.from(output[`${prefix}/处理清单.json`].base64, "base64").toString("utf8"));
  expect(report.files.map((file: any) => [file.source, file.target, file.status]).sort()).toEqual([["主图.jpg", "XFW19X31757L/1.jpg", "success"], ["详情.jpg", "XFW19X31757L/601.jpg", "success"]].sort());
  expect(output[`${prefix}/XFW19X31757L/1.jpg`].base64).toBe(files[0].base64);
  expect(await page.evaluate(() => (window as any).batchSourceWrites)).toEqual([]);
  expect(writes).toEqual([]);
});

test("多款预览与实际输出使用替换后的款号目录并保留颜色分组", async ({ page }) => {
  await installDirectory(page, [await jpg("XFW19-31757L/黑色/1.jpg"), await jpg("XFW19-31757L/白色/1.jpg"), await jpg("XFW19-31757L/详情.jpg", 900, 1210), await jpg("XFW21-31966L/1.jpg")]);
  const { tool } = await fixture(page);
  await tool.getByRole("checkbox", { name: "识别后自动处理整个目录" }).uncheck();
  await tool.getByRole("button", { name: "选择本地目录", exact: true }).click();
  for (const target of ["XFW19X31757L/黑色/1.jpg", "XFW19X31757L/白色/1.jpg", "XFW19X31757L/601.jpg", "XFW21X31966L/1.jpg"]) await expect(tool.getByText(target, { exact: true })).toBeVisible();
  await tool.screenshot({ path: test.info().outputPath("style-directory-normalization.png") });
  await tool.getByRole("button", { name: "处理整个目录 4 张", exact: true }).click();
  await expect(tool).toContainText("处理完成：成功 4 张，原图另存待确认 0 张，失败 0 张");
  const output = await outputData(page), prefix = Object.keys(output)[0].split("/")[0];
  expect(Object.keys(output).map(path => path.slice(prefix.length + 1)).sort()).toEqual(["XFW19X31757L/黑色/1.jpg", "XFW19X31757L/白色/1.jpg", "XFW19X31757L/601.jpg", "XFW21X31966L/1.jpg", "处理清单.json"].sort());
  expect(await page.evaluate(() => (window as any).batchSourceWrites)).toEqual([]);
});

test("工具箱批量生成单色与多色成品，保留原图并跳过旧结果目录", async ({ page }) => {
  const files = [await jpg("SINGLE123/主图1.jpg"), await jpg("SINGLE123/主图2.jpg"), await jpg("SINGLE123/主图3.jpg"), await jpg("SINGLE123/主图4.jpg"), await jpg("SINGLE123/主图5.jpg"), await flat("SINGLE123/透明平铺.png"), await jpg("SINGLE123/列表.jpg", 950, 1200), await jpg("SINGLE123/吊牌.jpg", 640, 840), await jpg("SINGLE123/详情.jpg", 900, 2600),
    await jpg("MULTI456/MULTI456001/原图1.jpg"), await flat("MULTI456/MULTI456001/透明平铺.png"), await jpg("MULTI456/MULTI456002/原图1.jpg"), await jpg("MULTI456/MULTI456002/列表.jpg", 950, 1200), await jpg("MULTI456/详情.jpg", 900, 1230), await jpg("MULTI456/吊牌.jpg", 640, 840), await jpg("图片命名结果-旧/NEVER/1.jpg")];
  await installDirectory(page, files);
  const { tool, writes } = await fixture(page);
  await tool.getByRole("button", { name: "选择本地目录", exact: true }).click();
  await expect(tool).toContainText("2 款 · 15 张图片 · 可自动命名 15 张 · 原图待确认 0 张");
  expect(await page.evaluate(() => (window as any).batchReadCount)).toBe(15);
  await expect(tool).toContainText("处理完成：成功 15 张，原图另存待确认 0 张，失败 0 张");
  await tool.screenshot({ path: test.info().outputPath("image-batch-preview.png") });
  const output = await outputData(page);
  const prefix = Object.keys(output)[0].split("/")[0];
  expect(Object.keys(output).map(key => key.slice(prefix.length + 1))).toEqual(expect.arrayContaining(["SINGLE123/1.jpg", "SINGLE123/15.jpg", "SINGLE123/30.png", "SINGLE123/50.jpg", "SINGLE123/601.jpg", "SINGLE123/826.jpg", "MULTI456/MULTI456001/1.jpg", "MULTI456/MULTI456001/30.png", "MULTI456/MULTI456002/1.jpg", "MULTI456/MULTI456002/50.jpg", "MULTI456/601.jpg", "MULTI456/826.jpg", "处理清单.json"]));
  const original = files.find(file => file.path === "SINGLE123/主图1.jpg")!;
  expect(createHash("sha256").update(Buffer.from(output[`${prefix}/SINGLE123/1.jpg`].base64, "base64")).digest("hex")).toBe(createHash("sha256").update(Buffer.from(original.base64, "base64")).digest("hex"));
  expect(await page.evaluate(() => (window as any).batchSourceWrites)).toEqual([]);
  expect(writes).toEqual([]);
  await tool.getByRole("button", { name: "处理整个目录 15 张", exact: true }).click();
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
  await expect(tool).toContainText("处理完成：成功 2 张，原图另存待确认 0 张，失败 0 张", { timeout: 30000 });
  const output = await outputData(page);
  const jpegOut = Buffer.from(Object.entries(output).find(([path]) => path.endsWith("/1.jpg"))![1].base64, "base64");
  const pngOut = Buffer.from(Object.entries(output).find(([path]) => path.endsWith("/30.png"))![1].base64, "base64");
  expect(jpegOut.length).toBeLessThanOrEqual(1024 * 1024); expect(pngOut.length).toBeLessThanOrEqual(600 * 1024);
  const j = await sharp(jpegOut).metadata(), p = await sharp(pngOut).metadata();
  expect(j.format).toBe("jpeg"); expect(j.width).toBe(j.height); expect(j.width).toBeLessThanOrEqual(width);
  expect(p.format).toBe("png"); expect(p.hasAlpha).toBe(true); expect(p.width).toBe(p.height);
  const stats = await sharp(pngOut).stats(); expect(stats.channels[3].min).toBeLessThan(255);
});
test("可关闭自动处理先调整颜色，批量分组支持编号目录", async ({ page }) => {
  await installDirectory(page, [await flat("STYLE123/平铺1.png"), await flat("STYLE123/平铺2.png")]);
  const { tool } = await fixture(page, "/style-selections");
  await tool.getByRole("checkbox", { name: "识别后自动处理整个目录", exact: true }).uncheck();
  await tool.getByRole("button", { name: "选择本地目录", exact: true }).click();
  await expect(tool.getByRole("button", { name: "处理整个目录 2 张", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => Object.keys((window as any).batchWrites))).toEqual([]);
  await tool.getByRole("textbox", { name: "颜色组 STYLE123/平铺1.png", exact: true }).fill("黑色");
  await tool.getByRole("textbox", { name: "颜色组 STYLE123/平铺2.png", exact: true }).fill("白色");
  await tool.getByRole("combobox", { name: "多色目录命名", exact: true }).click();
  await page.getByText("颜色分组文件夹（1）（2）…", { exact: true }).click();
  await tool.getByRole("button", { name: "处理整个目录 2 张", exact: true }).click();
  await expect(tool).toContainText("处理完成：成功 2 张，原图另存待确认 0 张，失败 0 张");
  const paths = await page.evaluate(() => Object.keys((window as any).batchWrites));
  expect(paths.some(path => path.endsWith("/颜色分组文件夹（1）/30.png"))).toBe(true);
  expect(paths.some(path => path.endsWith("/颜色分组文件夹（2）/30.png"))).toBe(true);
});
test("拒绝写权限时不生成文件，目录可重新选择", async ({ page }) => {
  await installDirectory(page, [await jpg("STYLE123/1.jpg")], { deny: true });
  const { tool } = await fixture(page, "/project-tables/7");
  await tool.getByRole("button", { name: "选择本地目录", exact: true }).click();
  await expect(tool).toContainText("未获准写入目录");
  expect(await page.evaluate(() => Object.keys((window as any).batchWrites))).toEqual([]);
  await expect(tool.getByRole("button", { name: "选择本地目录", exact: true })).toBeEnabled();
});
test("单文件写入失败有准确清单并继续处理后续图片", async ({ page }) => {
  await installDirectory(page, [await jpg("STYLE123/1.jpg"), await jpg("STYLE123/2.jpg")], { writeFailure: "/1.jpg" });
  const { tool } = await fixture(page);
  await tool.getByRole("button", { name: "选择本地目录", exact: true }).click();
  await expect(tool).toContainText("处理完成：成功 1 张，原图另存待确认 0 张，失败 1 张");
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

test("选择目录后自动处理跨分页全部图片，异常原图另存且不阻断", async ({ page }) => {
  const files: InputImage[] = [];
  for (let style = 1; style <= 5; style++) for (let number = 1; number <= 9; number++) files.push(await jpg(`STYLE${style}/主图/${number}.jpg`, 240, 240));
  files.push(await jpg("STYLE1/30.jpg", 240, 240), await jpg("STYLE2/横图.jpg", 300, 100));
  await installDirectory(page, files);
  const { tool } = await fixture(page);
  await tool.getByRole("button", { name: "选择本地目录", exact: true }).click();
  await expect(tool).toContainText("处理完成：成功 45 张，原图另存待确认 2 张，失败 0 张");
  const output = await outputData(page);
  expect(Object.keys(output)).toHaveLength(48);
  const report = JSON.parse(Buffer.from(Object.entries(output).find(([path]) => path.endsWith("处理清单.json"))![1].base64, "base64").toString());
  expect(report.total).toBe(47);
  expect(report.files.filter((file: any) => file.status === "review")).toHaveLength(2);
  expect(new Set(report.files.map((file: any) => file.source)).size).toBe(47);
  for (const original of files.slice(-2)) {
    const saved = Object.entries(output).find(([path]) => path.endsWith(`/_待确认/${original.path}`))!;
    expect(saved[1].base64).toBe(original.base64);
  }
  expect(await page.evaluate(() => (window as any).batchSourceWrites)).toEqual([]);
  await tool.screenshot({ path: test.info().outputPath("image-batch-all-results.png") });
});

test("混放图片根据画面颜色匹配到颜色组，全流程无需逐张设置", async ({ page }) => {
  const files: InputImage[] = [];
  for (const [index, color] of ["#b5132b", "#1937ce"].entries()) {
    const jpeg = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
    files.push({ path: `STYLE1/${index + 1}.jpg`, type: "image/jpeg", base64: (await jpeg(240, 240)).toString("base64") });
    files.push({ path: `STYLE1/${50 + index}.jpg`, type: "image/jpeg", base64: (await jpeg(950, 1200)).toString("base64") });
    files.push({ path: `STYLE1/${30 + index}.png`, type: "image/png", base64: (await sharp({ create: { width: 240, height: 240, channels: 4, background: color } }).composite([{ input: Buffer.from('<svg width="240" height="240"><rect width="240" height="240" opacity="0.7" fill="white"/></svg>'), blend: "dest-in" }]).png().toBuffer()).toString("base64") });
  }
  await installDirectory(page, files);
  const { tool } = await fixture(page);
  await tool.getByRole("button", { name: "选择本地目录", exact: true }).click();
  await expect(tool).toContainText("处理完成：成功 6 张，原图另存待确认 0 张，失败 0 张");
  const output = await outputData(page);
  const report = JSON.parse(Buffer.from(Object.entries(output).find(([path]) => path.endsWith("处理清单.json"))![1].base64, "base64").toString());
  for (const number of [1, 2]) {
    const targets = report.files.filter((file: any) => [`STYLE1/${number}.jpg`, `STYLE1/${49 + number}.jpg`, `STYLE1/${29 + number}.png`].includes(file.source)).map((file: any) => file.target.split("/").slice(0, -1).join("/"));
    expect(new Set(targets).size).toBe(1);
    expect(targets[0]).toContain(`颜色分组文件夹（${number}）`);
  }
});

test("勾选当前分页与仅看待确认不会缩小处理范围", async ({ page }) => {
  const files = [...await Promise.all(Array.from({ length: 25 }, (_, i) => jpg(`STYLE${Math.floor(i / 5)}/主图${i}.jpg`, 240, 240))), await jpg("STYLE1/30.jpg", 240, 240)];
  await installDirectory(page, files);
  const { tool } = await fixture(page);
  await tool.getByRole("checkbox", { name: "识别后自动处理整个目录", exact: true }).uncheck();
  await tool.getByRole("button", { name: "选择本地目录", exact: true }).click();
  await expect(tool).toContainText("26 张图片");
  await tool.locator("thead").getByRole("checkbox").check();
  await tool.getByRole("checkbox", { name: "仅看待确认", exact: true }).check();
  await tool.getByRole("button", { name: "处理整个目录 26 张", exact: true }).click();
  await expect(tool).toContainText("处理完成：成功 25 张，原图另存待确认 1 张，失败 0 张");
  expect(await page.evaluate(() => Object.keys((window as any).batchWrites).length)).toBe(27);
});

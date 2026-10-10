import { expect, test, type Page } from "@playwright/test";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

const image = { id: "match-photo", url: "/api/v1/style-selections/images/11111111-1111-4111-8111-111111111111?tableId=777", color: "黑色" };
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=", "base64");
const candidate = { id: "501", xutiStyleNo: "", supplierStyleNo: "MATCH-SUPPLIER", supplierCode: "MATCH-CODE", material: "羊毛", color: "黑色", images: [image], labelImages: [], extraFields: {}, defaultCellAccess: "read", cellAccess: { images: "read" }, updatedAt: "2026-10-10T00:00:00.000Z", createdAt: "2026-10-10T00:00:00.000Z" };
const original = { ...candidate, id: "500", xutiStyleNo: "ORIGINAL-STYLE", supplierStyleNo: "ORIGINAL-SUPPLIER", material: "棉", images: [] };
type Result = { data: Record<string, any>[]; total: number; scannedImages: number; skippedImages: number };
const result = (rows = [candidate]): Result => ({ data: rows.map(row => ({ ...row, matchedImage: image })), total: rows.length, scannedImages: 2, skippedImages: 0 });

async function fixture(page: Page, options: { web?: boolean; onSearch?: (index: number) => Promise<Result> } = {}) {
  const state = {
    searchStatus: 200, revisionStatus: 200, detailStatus: 200, blockedImage: false,
    response: result(), searches: [] as { params: URLSearchParams; body: { data: string } }[],
    details: [] as URLSearchParams[], businessWrites: [] as string[],
  };
  let preferences = selectionLayoutSchema.parse({ columns: [
    { key: "images", label: "图片", type: "image", width: 120 },
    { key: "xutiStyleNo", label: "序缇款号", type: "text", width: 150 },
    { key: "supplierStyleNo", label: "供应商款号", type: "text", width: 160 },
    { key: "material", label: "成分", type: "text", width: 160 },
  ], searchText: options.web ? "ORIGINAL" : "", columnFilters: options.web ? { material: { mode: "equals", value: "棉" } } : {}, rowHeight: "compact" });
  await page.addInitScript(() => {
    const tracked = { created: [] as string[], revoked: [] as string[] };
    (window as typeof window & { __imageSearchUrls: typeof tracked }).__imageSearchUrls = tracked;
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); tracked.created.push(url); return url; };
    URL.revokeObjectURL = url => { tracked.revoked.push(url); revoke(url); };
  });
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (["PATCH", "DELETE"].includes(request.method()) || request.method() === "POST" &&
      !["/api/v1/style-selections/image-search", "/api/v1/style-selections/sync", "/api/v1/style-selections/presence", "/api/v1/style-selections/layout-preferences"].includes(path)) state.businessWrites.push(path);
    if (path.includes("/style-selections/images/")) { await route.fulfill({ contentType: "image/png", body: pixel }); return; }
    if (path.endsWith("/auth/me")) { await route.fulfill({ json: { data: { id: "image-reader", displayName: "图片查找只读测试", roleCodes: [], csrfToken: "fixture", permissions: options.web ? ["selection.read"] : ["product.read"] } } }); return; }
    if (path.endsWith("/revision")) {
      await route.fulfill({ status: state.revisionStatus, json: state.revisionStatus === 200 ? { data: { revision: "image-search-fixture" } } : { error: { message: "当前表格已取消查看权限" } } }); return;
    }
    if (path === "/api/v1/style-selections/image-search") {
      state.searches.push({ params: url.searchParams, body: request.postDataJSON() });
      const response = options.onSearch ? await options.onSearch(state.searches.length) : state.response;
      try { await route.fulfill({ status: state.searchStatus, json: state.searchStatus === 200 ? { data: response } : { error: { message: "图片搜索暂不可用" } } }); } catch { /* A cancelled browser request may finish after its dialog closes. */ }
      return;
    }
    if (path === "/api/v1/style-selections/501") {
      state.details.push(url.searchParams);
      await route.fulfill({ status: state.detailStatus, json: state.detailStatus === 200 ? { data: state.blockedImage ? { ...candidate, images: [], cellAccess: { images: "deny" }, hiddenCells: ["images"] } : candidate } : { error: { message: "当前表格已取消查看权限" } } }); return;
    }
    let data: unknown = [];
    if (path === "/api/v1/style-selections") { await route.fulfill({ json: { data: [original, candidate], total: 2, missingStyleNoCount: 1 } }); return; }
    if (path.endsWith("/sync")) data = { revision: "image-search-fixture", index: [original, candidate].map(row => ({ id: row.id, token: row.updatedAt })), data: [original, candidate] };
    if (path.endsWith("/layout-preferences")) {
      if (request.method() === "POST") preferences = request.postDataJSON().preferences;
      data = { preferences, revision: 1, sharedPreferences: null, sharedRevision: 0, canEditShared: false };
    }
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    await route.fulfill({ json: { data } });
  });
  await page.goto(options.web ? "/style-selections" : "/mobile/style-photos?tableId=777&archive=1");
  await expect(page.getByRole("button", { name: "拍照或上传图片查找同款", exact: true })).toBeVisible();
  return state;
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "图片查找同款", exact: true });
async function open(page: Page) {
  await page.getByRole("button", { name: "拍照或上传图片查找同款", exact: true }).click();
  await expect(dialog(page).getByRole("button", { name: "上传图片查找" })).toBeEnabled();
}
async function upload(page: Page, camera = false) {
  const chooserPromise = page.waitForEvent("filechooser");
  await dialog(page).getByRole("button", { name: camera ? "拍照查找" : "上传图片查找" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "query.png", mimeType: "image/png", buffer: pixel });
}
const urls = (page: Page) => page.evaluate(() => (window as typeof window & { __imageSearchUrls: { created: string[]; revoked: string[] } }).__imageSearchUrls);

test("手机只读用户可拍照找同款，查询不入库且无款号候选按当前商品档案进入拍图", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const state = await fixture(page);
  await open(page);
  await expect(dialog(page).getByLabel("拍照查找图片文件", { exact: true })).toHaveAttribute("capture", "environment");
  await expect(dialog(page).getByLabel("上传查找图片文件", { exact: true })).not.toHaveAttribute("multiple", "");
  await upload(page, true);
  await expect(dialog(page).getByAltText("本次查找图片", { exact: true })).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "选择图片候选 MATCH-SUPPLIER", exact: true })).toBeVisible();
  expect(state.searches).toHaveLength(1);
  expect(state.searches[0].params.get("tableId")).toBe("777");
  expect(state.searches[0].body.data).toMatch(/^data:image\/png;base64,/);
  expect(Object.keys(state.searches[0].body)).toEqual(["data"]);
  await dialog(page).getByRole("button", { name: "选择图片候选 MATCH-SUPPLIER", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "MATCH-SUPPLIER", exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("id")).toBe("501");
  expect(new URL(page.url()).searchParams.get("tableId")).toBe("777");
  expect(state.details.length).toBeGreaterThanOrEqual(2);
  expect(state.details.every(params => params.get("tableId") === "777")).toBe(true);
  expect(state.businessWrites).toEqual([]);
  const tracked = await urls(page);
  expect(tracked.revoked).toEqual(tracked.created);
});

test("取消后旧查询不会回显，重新打开只显示新查询，关闭回收查询图", async ({ page }) => {
  let release: () => void = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const state = await fixture(page, { onSearch: async index => {
    if (index === 1) { await waiting; return result([{ ...candidate, id: "999", supplierStyleNo: "OLD-CANDIDATE" }]); }
    return result();
  } });
  await open(page); await upload(page);
  await expect.poll(() => state.searches.length).toBe(1);
  await dialog(page).locator(".ant-modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  release();
  await open(page);
  await expect(dialog(page).getByAltText("本次查找图片", { exact: true })).toHaveCount(0);
  await upload(page);
  await expect(dialog(page).getByRole("button", { name: "选择图片候选 MATCH-SUPPLIER", exact: true })).toBeVisible();
  await expect(page.getByText("OLD-CANDIDATE", { exact: true })).toHaveCount(0);
  await dialog(page).locator(".ant-modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  const tracked = await urls(page);
  expect(tracked.created).toHaveLength(2);
  expect(tracked.revoked).toEqual(tracked.created);
  expect(new URL(page.url()).searchParams.has("id")).toBe(false);
  expect(state.businessWrites).toEqual([]);
});

test("打开和选择时复查权限，网络错误可重试，撤销或图片变动清除旧候选但保留查询图", async ({ page }) => {
  const state = await fixture(page);
  state.revisionStatus = 403;
  await page.getByRole("button", { name: "拍照或上传图片查找同款", exact: true }).click();
  await expect(page.getByText("当前表格已取消查看权限", { exact: true })).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  expect(state.searches).toHaveLength(0);
  state.revisionStatus = 200; state.searchStatus = 503;
  await open(page); await upload(page);
  await expect(dialog(page).getByText("图片搜索暂不可用", { exact: true })).toBeVisible();
  state.searchStatus = 200; state.blockedImage = true;
  await dialog(page).getByRole("button", { name: "重新查找", exact: true }).click();
  await dialog(page).getByRole("button", { name: "选择图片候选 MATCH-SUPPLIER", exact: true }).click();
  await expect(dialog(page).getByText("该候选图片已变化或不再允许查看，请重新查找", { exact: true })).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "选择图片候选 MATCH-SUPPLIER", exact: true })).toHaveCount(0);
  await expect(dialog(page).getByAltText("本次查找图片", { exact: true })).toBeVisible();
  state.detailStatus = 403;
  await dialog(page).getByRole("button", { name: "重新查找", exact: true }).click();
  await dialog(page).getByRole("button", { name: "选择图片候选 MATCH-SUPPLIER", exact: true }).click();
  await expect(dialog(page).getByText("当前表格已取消查看权限", { exact: true })).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "选择图片候选 MATCH-SUPPLIER", exact: true })).toHaveCount(0);
  await expect(dialog(page).getByAltText("本次查找图片", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("id")).toBe(false);
  expect(state.businessWrites).toEqual([]);
});

test("没有可比较图时准确显示外链或不可读图未参与，可关闭并换图", async ({ page }) => {
  const state = await fixture(page);
  state.response = { data: [], total: 0, scannedImages: 0, skippedImages: 3 };
  await open(page); await upload(page);
  await expect(dialog(page).getByText("3 张外链或暂时无法读取的图片未参与查找", { exact: true })).toBeVisible();
  await expect(dialog(page).getByText("未能读取可比较的款式图片，可上传款式图片后重试", { exact: true })).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "上传图片查找" })).toBeEnabled();
  expect(state.businessWrites).toEqual([]);
});

test("网页图片候选缺款号仍按记录定位，保留原文字与列筛选且可清除恢复", async ({ page }) => {
  const state = await fixture(page, { web: true });
  const rows = page.locator("tr[data-selection-row]");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByLabel("序缇款号", { exact: true })).toHaveValue("ORIGINAL-STYLE");
  const textSearch = page.getByLabel("搜索选款", { exact: true });
  await expect(textSearch).toHaveValue("ORIGINAL");
  await open(page); await upload(page);
  await dialog(page).getByRole("button", { name: "选择图片候选 MATCH-SUPPLIER", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByLabel("供应商款号", { exact: true })).toHaveValue("MATCH-SUPPLIER");
  await expect(rows.first().getByLabel("序缇款号", { exact: true })).toHaveValue("");
  await expect(textSearch).toHaveValue("ORIGINAL");
  await expect(page.getByText("图片查找：当前显示所选款式，清除后恢复原搜索与列筛选。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "清除图片查找", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByLabel("序缇款号", { exact: true })).toHaveValue("ORIGINAL-STYLE");
  await expect(textSearch).toHaveValue("ORIGINAL");
  expect(state.details).toHaveLength(1);
  expect(state.businessWrites).toEqual([]);
});

import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const rows = [
  {
    id: "style:1", productId: "1", styleNo: "S22X20130", supplierStyleCode: "QQWJX5992", colorName: "黑色",
    mainImageUrl: "/api/v1/inventory/images/broken",
    imageSources: [
      { url: "/api/v1/inventory/images/broken", source: "vip" },
      { url: "/api/v1/inventory/images/good", source: "user" },
    ],
    inventoryUserImage: { id: "good" }, imageUploadColor: "", physicalQty: 1,
  },
  {
    id: "style:2", productId: "2", styleNo: "S15X19287", supplierStyleCode: "FDL6258402", colorName: "白色",
    mainImageUrl: null, imageSources: [], inventoryUserImage: null, imageUploadColor: "", physicalQty: 2,
  },
];

async function fixture(page: Page) {
  const writes: { path: string; body: any }[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "GET") writes.push({ path: url.pathname, body: request.postDataJSON() });
    if (url.pathname.endsWith("/auth/me"))
      return route.fulfill({ json: { data: { id: "9", username: "ops", displayName: "运营", permissions: ["inventory.read", "inventory.adjust", "product.create", "product.update"], roleCodes: [], csrfToken: "t" } } });
    if (url.pathname.endsWith("/inventory/images/broken")) return route.fulfill({ status: 404, body: "" });
    if (url.pathname.endsWith("/inventory/images/good")) return route.fulfill({ status: 200, contentType: "image/png", body: png });
    if (url.pathname.endsWith("/inventory/images") && request.method() === "POST")
      return route.fulfill({ json: { data: { id: "new", url: "/api/v1/inventory/images/new" } } });
    if (url.pathname.endsWith("/inventory/images/batch"))
      return route.fulfill({ json: { data: { results: request.postDataJSON().items.map((item: any) => ({ ...item, status: "SAVED" })) } } });
    if (url.pathname.endsWith("/inventory/fulfilment/import-batch"))
      return route.fulfill({ json: { data: { results: request.postDataJSON().rows.map((row: any) => ({ key: row.key, saved: true })) } } });
    if (url.pathname.endsWith("/inventory/summary"))
      return route.fulfill({ json: { data: rows, total: rows.length, page: 1, pageSize: 20, listingCounts: null, totals: { physicalQty: 3 } } });
    if (url.pathname.endsWith("/my-workspace/appearance")) return route.fulfill({ json: { data: { mode: "light", version: 1 } } });
    return route.fulfill({ json: { data: [], total: 0 } });
  });
  await page.goto("/operations/vip/inventory");
  await expect(page.locator(".inventory-summary-table")).toContainText("S22X20130");
  return writes;
}

test("库存图片加载失败时回退到下一来源，缺图时可直接上传", async ({ page }) => {
  const writes = await fixture(page);
  const table = page.locator(".inventory-summary-table");
  await expect(table.locator('img.compass-product-image-thumb[src="/api/v1/inventory/images/good"]')).toBeVisible();
  await expect(table.getByRole("img", { name: /暂无图片 S22X20130/ })).toHaveCount(0);
  const upload = table.getByRole("button", { name: "上传图片 S15X19287" });
  await expect(upload).toBeVisible();
  await table.getByLabel("选择图片 S15X19287").setInputFiles({ name: "S15X19287.png", mimeType: "image/png", buffer: png });
  await expect.poll(() => writes.find((write) => write.path.endsWith("/inventory/images"))?.body).toMatchObject({ productId: "2", colorName: "" });
});

async function workbook(rows: (string | null)[][]) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("数据");
  sheet.addRow(["图片（选填）", "款号（必填）", "货号（必填）", "商品编码（必填）", "供应商款式编码（必填）", "颜色（必填）", "尺码（必填）"]);
  for (const row of rows) sheet.addRow(row);
  return { name: "sku.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await book.xlsx.writeBuffer()) };
}

test("导入SKU提供模板下载、逐行校验并在确认后导入和保存图片", async ({ page }) => {
  const writes = await fixture(page);
  await page.getByRole("button", { name: "导入SKU" }).click();
  const dialog = page.getByRole("dialog", { name: "导入SKU" });
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "模板下载" }).click();
  const template = new ExcelJS.Workbook();
  await template.xlsx.load(new Uint8Array(await readFile(await (await download).path())) as never);
  expect((template.getWorksheet("数据")!.getRow(1).values as string[]).slice(1)).toEqual([
    "图片（选填）", "款号（必填）", "货号（必填）", "商品编码（必填）", "供应商款式编码（必填）", "颜色（必填）", "尺码（必填）",
  ]);
  const input = dialog.locator('input[type="file"]');
  await input.setInputFiles(await workbook([
    ["", "S22X20130", "A1", "SKU-1", "QQWJX5992", "黑色", "M"],
    ["", "", "A1", "SKU-2", "QQWJX5992", "", "L"],
  ]));
  await expect(dialog.getByRole("list", { name: "校验错误" })).toContainText("第 3 行：「款号」必填；「颜色」必填");
  await expect(dialog.getByRole("button", { name: "确认导入" })).toBeDisabled();
  await input.setInputFiles(await workbook([
    ["https://a.vpimg4.com/s22.jpg", "S22X20130", "A1", "SKU-1", "QQWJX5992", "黑色", "M"],
    ["", "S22X20130", "A1", "SKU-2", "QQWJX5992", "黑色", "L"],
  ]));
  await expect(dialog).toContainText("校验通过：共 2 行，含图片 1 行");
  await expect(dialog.getByRole("table")).toContainText("SKU-2");
  await dialog.getByRole("button", { name: "确认导入" }).click();
  await expect(dialog).toContainText("导入成功 2 行，失败 0 行；图片 1 / 1 张已保存");
  const batch = writes.find((write) => write.path.endsWith("/fulfilment/import-batch"))!.body;
  expect(batch.rows.map((row: any) => row.input)).toEqual([
    expect.objectContaining({ skuCode: "SKU-1", mode: "sku", creation: expect.objectContaining({ styleNo: "S22X20130", mainImageUrl: "https://a.vpimg4.com/s22.jpg" }) }),
    expect.objectContaining({ skuCode: "SKU-2", mode: "sku", changes: { colorName: "黑色", sizeName: "L", articleNo: "A1" } }),
  ]);
  expect(writes.find((write) => write.path.endsWith("/inventory/images/batch"))!.body.items).toEqual([
    expect.objectContaining({ styleNo: "S22X20130", colorName: "黑色", url: "https://a.vpimg4.com/s22.jpg", source: "excel" }),
  ]);
});

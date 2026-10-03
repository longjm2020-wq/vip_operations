import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
// Run this large shared-database fixture last; its immutable ledger is retained.
test("6885 行首次库存导入：浏览器读取与真实建档保存在 15 秒内", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "我的工作台" })).toBeVisible();
  const me = (await (await page.request.get("/api/v1/auth/me")).json()).data;
  const response = await page.request.post("/api/v1/warehouses", {
    headers: {
      "X-CSRF-Token": me.csrfToken,
      "Idempotency-Key": crypto.randomUUID(),
      Origin: "http://127.0.0.1:5174",
    },
    data: { code: "BULK-E2E", name: "批量导入验收仓" },
  });
  expect(response.ok()).toBeTruthy();
  const warehouse = (await response.json()).data;
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet("数据");
  sheet.addRow([
    "款号",
    "货号",
    "商品编码",
    "颜色",
    "尺码",
    "在仓库存数",
    "仓库",
  ]);
  for (let i = 0; i < 6885; i++)
    sheet.addRow([
      "BULK-STYLE-" + Math.floor(i / 20),
      "BULK-ARTICLE-" + i,
      "BULK-SKU-" + i,
      "白色",
      "L",
      10,
      warehouse.code,
    ]);
  const buffer = Buffer.from(await book.xlsx.writeBuffer());
  await page.goto("/operations/vip/inventory");
  await page.getByRole("button", { name: "导入", exact: true }).click();
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/inventory/fulfilment/import-batch"))
      requests++;
  });
  await page
    .locator('.ant-modal input[type="file"]')
    .setInputFiles({
      name: "缺少仓库.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("商品编码,在仓库存数\nPRECHECK-ONLY,1"),
    });
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(
    page.getByText("第 2 行：修改库存需填写仓库列或选择导入仓库"),
  ).toBeVisible();
  expect(requests).toBe(0);
  await page.getByLabel("导入仓库", { exact: true }).click();
  await page
    .locator(".ant-select-dropdown .ant-select-item-option")
    .filter({ hasText: warehouse.name })
    .click();
  await expect(
    page.getByText("第 2 行：修改库存需填写仓库列或选择导入仓库"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "确认导入", exact: true }),
  ).toBeEnabled();
  const start = performance.now();
  await page.locator('.ant-modal input[type="file"]').setInputFiles({
    name: "6885行库存.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer,
  });
  await expect(page.getByText(/共 6885 行，更新列/)).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.getByText(/导入成功 6885 行，失败 0 行/)).toBeVisible({
    timeout: 15000,
  });
  const seconds = (performance.now() - start) / 1000;
  console.log(
    `6885 行浏览器真实导入：${seconds.toFixed(2)} 秒，${requests} 次批量请求`,
  );
  expect(seconds).toBeLessThan(15);
  expect(requests).toBe(7);
  const stocks = (
    await (
      await page.request.get(
        "/api/v1/inventory?q=BULK-SKU-6884&warehouseId=" + warehouse.id,
      )
    ).json()
  ).data;
  expect(stocks).toHaveLength(1);
  expect(stocks[0].physicalQty).toBe(10);
  expect(stocks[0].articleNo).toBe("BULK-ARTICLE-6884");
});

import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
test("库存管理：发货核销、SKU 差异质检、进货仓入库与人工参考值", async ({
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
  await expect(
    page.getByRole("menuitem", { name: "SKU 管理", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "SKU 库存", exact: true }),
  ).toHaveCount(0);
  const me = (await (await page.request.get("/api/v1/auth/me")).json()).data;
  const post = async (path: string, body: unknown) => {
    const r = await page.request.post("/api/v1" + path, {
      headers: {
        "X-CSRF-Token": me.csrfToken,
        "Idempotency-Key": crypto.randomUUID(),
        Origin: "http://127.0.0.1:5174",
      },
      data: body,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return (await r.json()).data;
  };
  const suffix = String(Date.now()),
    warehouse = await post("/warehouses", {
      code: "IF-W-" + suffix,
      name: "库存流程验收仓",
    }),
    supplier = await post("/suppliers", {
      supplierCode: "IF-S-" + suffix,
      name: "库存流程供应商",
    }),
    category = await post("/categories", {
      code: "IF-C-" + suffix,
      name: "库存流程品类",
    });
  const prod = await post("/products", {
      styleNo: "IF-P-" + suffix,
      name: "库存流程商品",
      categoryId: category.id,
    }),
    sku = await post("/skus", {
      productId: prod.id,
      skuCode: "IF-SKU-" + suffix,
      colorCode: "001",
      colorName: "黑色",
      sizeCode: "004",
      sizeName: "L",
    });
  let po = await post("/purchase-orders", {
    supplierId: supplier.id,
    warehouseId: warehouse.id,
    items: [{ skuId: sku.id, orderedQty: 3, unitCost: "10.00" }],
  });
  po = await post("/purchase-orders/" + po.id + "/submit", {
    expectedVersion: po.version,
  });
  po = await post("/purchase-orders/" + po.id + "/confirm", {
    expectedVersion: po.version,
  });
  await page.goto("/purchase-orders/" + po.id);
  await page.getByRole("button", { name: "安排 SKU 发货 / 补发" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("spinbutton").fill("3");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const codeText = page.getByText(/^\d{4}（提供给接收方）$/);
  await expect(codeText).toBeVisible();
  const code = (await codeText.textContent())!.slice(0, 4);
  await page.getByRole("button", { name: "核验发货码", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("请向发货方索取本包裹四位核销码").fill(code);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "SKU 盘点质检", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("准确且完好的合格数量").fill("2");
  await dialog.getByRole("button", { name: "添加问题数量" }).click();
  await dialog.getByLabel("问题反馈说明").fill("漏发一件，请补发");
  await dialog.getByRole("button", { name: "提交质检并反馈" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("cell").filter({ hasText: "漏发一件，请补发" }),
  ).toBeVisible();
  await page.goto("/inventory");
  await expect(page.getByRole("heading", { name: "库存管理" })).toBeVisible();
  await page.getByRole("tab", { name: "进货仓待入库" }).click();
  const row = page.getByRole("row").filter({ hasText: sku.skuCode });
  await row.getByRole("button", { name: "选择仓库入库" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("本次入库数量")).toHaveValue("2");
  await dialog.getByRole("button", { name: "确认正式入库" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "库存明细", exact: true }),
  ).toHaveCount(0);
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "运营中心", exact: true })
    .click();
  await page.getByRole("link", { name: "库存明细", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "库存明细", exact: true }),
  ).toBeVisible();
  const stockRow = page
    .getByRole("row")
    .filter({ hasText: sku.skuCode })
    .filter({ hasText: warehouse.name });
  await stockRow.getByRole("button", { name: "参考值设置" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("货号", { exact: true }).fill("ARTICLE-IF");
  await dialog.getByLabel("渠道日销参考（件/日，未知留空）").fill("1.25");
  await dialog.getByLabel("退货率（%，未知留空）").fill("1.5");
  await dialog.getByLabel("预估销退数（件，未知留空）").fill("1");
  await dialog.getByLabel("参考来源 / 渠道").fill("人工渠道验收");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(stockRow).toContainText("ARTICLE-IF");
  await expect(stockRow).toContainText("1.5%");
  await expect(stockRow).toContainText("人工渠道验收");
  const balance = await (
    await page.request.get("/api/v1/inventory?skuId=" + sku.id)
  ).json();
  expect(
    balance.data.find((r: any) => r.warehouseId === warehouse.id).physicalQty,
  ).toBe(2);
  await expect(page.getByRole("tab", { name: "SKU 资料" })).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("当前页数据.xlsx");
  await page.getByRole("button", { name: "导入", exact: true }).click();
  const templatePromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载模板", exact: true }).click();
  expect((await templatePromise).suggestedFilename()).toBe(
    "库存资料导入模板.xlsx",
  );
  await expect(page.getByText(/最多 100MB \/ 50000 行/)).toBeVisible();
  const largeCsv = [
    "商品编码,参考来源",
    ...Array.from({ length: 50000 }, (_, i) => `LIMIT-${i},${"a".repeat(120)}`),
  ].join("\n");
  await page.locator('.ant-modal input[type="file"]').setInputFiles({
    name: "50000行.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(largeCsv, "utf8"),
  });
  await expect(page.getByText("共 50000 行，更新列：参考来源")).toBeVisible({
    timeout: 30000,
  });
  await page.locator('.ant-modal input[type="file"]').setInputFiles({
    name: "负数库存.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`商品编码,在仓库存数\n${sku.skuCode},-3`, "utf8"),
  });
  await expect(
    page.getByText("第 2 行 B 列「在仓库存数」不能小于 0（当前值：-3）"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认导入", exact: true }),
  ).toBeDisabled();
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet("数据");
  sheet.addRow(["商品编码", "颜色"]);
  sheet.addRow([sku.skuCode, "蓝色"]);
  await page.locator('.ant-modal input[type="file"]').setInputFiles({
    name: "改颜色.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(await book.xlsx.writeBuffer()),
  });
  await expect(page.getByText("共 1 行，更新列：颜色")).toBeVisible();
  const before = (
    await (await page.request.get("/api/v1/skus/" + sku.id)).json()
  ).data;
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.getByText(/导入成功 1 行，失败 0 行/)).toBeVisible();
  const after = (
    await (await page.request.get("/api/v1/skus/" + sku.id)).json()
  ).data;
  expect(after.colorName).toBe("蓝色");
  for (const key of [
    "barcode",
    "colorCode",
    "sizeCode",
    "sizeName",
    "productId",
  ])
    expect(after[key]).toBe(before[key]);
  expect(
    (
      await (await page.request.get("/api/v1/inventory?skuId=" + sku.id)).json()
    ).data.find((r: any) => r.warehouseId === warehouse.id).physicalQty,
  ).toBe(2);
  await page.screenshot({
    path: ".local/inventory-import-preview.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: ".local/inventory-management-preview.png",
    fullPage: true,
    animations: "disabled",
  });
});

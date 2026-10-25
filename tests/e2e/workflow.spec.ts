import { test, expect, Page } from "@playwright/test";
import ExcelJS from "exceljs";
const { Workbook } = ExcelJS;
test.describe.configure({ mode: "serial" });
test("颜色映射新增、编辑和删除", async ({ page }) => {
  await login(page);
  await create(page, "/color-mappings", {
    "色码（3 位）": "099",
    参考颜色名称: "验收测试色",
  });
  let row = page.getByRole("row").filter({ hasText: "验收测试色" });
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("参考颜色名称", { exact: true }).fill("验收修改色");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  row = page.getByRole("row").filter({ hasText: "验收修改色" });
  await row.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "验收修改色" }),
  ).toHaveCount(0);
});
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
}
async function create(
  page: Page,
  path: string,
  fields: Record<string, string>,
) {
  await page.goto(path);
  await page.getByRole("button", { name: /新建/ }).first().click();
  for (const [label, value] of Object.entries(fields))
    await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
test("小卡片 Excel 库存导入，网络重试不重复增加库存", async ({ page }) => {
  await login(page);
  const me = (await (await page.request.get("/api/v1/auth/me")).json()).data;
  const warehouse = await page.request.post("/api/v1/warehouses", {
    headers: { "X-CSRF-Token": me.csrfToken, "Idempotency-Key": crypto.randomUUID(), Origin: new URL(page.url()).origin },
    data: { code: "RETRY-E2E", name: "导入重试验收仓" },
  });
  expect(warehouse.ok()).toBeTruthy();
  let loseResponse = true;
  await page.route(
    "**/api/v1/inventory/fulfilment/import-batch",
    async (route) => {
      const response = await route.fetch();
      if (loseResponse) {
        expect(response.ok()).toBeTruthy();
        loseResponse = false;
        await route.abort("failed");
      } else await route.fulfill({ response });
    },
  );
  await page.goto("/operations/vip/inventory");
  await page.getByRole("button", { name: "导入", exact: true }).click();
  const book = new Workbook(),
    sheet = book.addWorksheet("数据");
  sheet.addRow(["商品编码", "款号", "颜色", "尺码", "仓库", "变化数量", "原因", "说明"]);
  sheet.addRow(["RETRY-E2E-SKU", "RETRY-E2E-STYLE", "黑色", "L", "RETRY-E2E", 3, "人工调整", "导入盘点验收"]);
  await page.locator('.ant-modal input[type="file"]').setInputFiles({
    name: "库存调整.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(await book.xlsx.writeBuffer()),
  });
  await expect(page.getByText(/共 1 行，更新列/)).toBeVisible();
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.getByText(/导入成功 0 行，失败 1 行/)).toBeVisible();
  await expect(page.locator('.ant-modal input[type="file"]')).toBeDisabled();
  await page.getByRole("button", { name: "重试失败行", exact: true }).click();
  await expect(page.getByText(/导入成功 1 行，失败 0 行/)).toBeVisible();
  const importDialog = page.getByRole("dialog", {
    name: "从 Excel 导入库存资料",
  });
  await importDialog
    .locator(".ant-modal-footer")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(importDialog).not.toBeVisible();
  const inventorySearch = page.getByRole("textbox", { name: "商品编码 / 货号 / 款号 / 条码", exact: true });
  await inventorySearch.fill("RETRY-E2E-SKU");
  await inventorySearch.press("Enter");
  await expect(
    page.getByRole("row").filter({ hasText: "RETRY-E2E-SKU" }),
  ).toContainText("3");
  const balances = (await (await page.request.get("/api/v1/inventory?q=RETRY-E2E-SKU")).json()).data;
  expect(balances).toHaveLength(1);
  expect(Number(balances[0].physicalQty)).toBe(3);
});

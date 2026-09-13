import { test, expect, Page } from "@playwright/test";
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
  await expect(page.getByRole("heading", { name: "商品档案" })).toBeVisible();
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
async function select(page: Page, label: string, value: string) {
  await page.getByLabel(label, { exact: true }).click();
  if (["颜色代码", "尺码代码"].includes(label))
    await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByTitle(value, { exact: true }).last().click();
}
test("真实前后端：建档、采购确认、两次入库、流水追溯", async ({ page }) => {
  await login(page);
  await create(page, "/suppliers", {
    供应商编码: "E2E-SUP",
    供应商名称: "验收服饰供应商",
  });
  await create(page, "/warehouses", { 仓库编码: "E2E-WH", 仓库名称: "验收仓" });
  await create(page, "/categories", { 品类编码: "E2E-CAT", 名称: "针织衫" });
  await page.goto("/products");
  await page.getByRole("button", { name: "新建商品" }).click();
  await page.getByLabel("款号", { exact: true }).fill("E2E-STYLE");
  await page.getByLabel("商品名称", { exact: true }).fill("秋季针织开衫");
  await select(page, "品类", "针织衫");
  await select(page, "默认供应商", "验收服饰供应商");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("link", { name: "E2E-STYLE" })).toBeVisible();
  await page.goto("/skus");
  await page.getByRole("button", { name: "新建资料" }).click();
  await select(page, "所属商品", "秋季针织开衫");
  await select(page, "颜色代码", "001 · 黑色");
  await select(page, "尺码代码", "004 · L");
  for (const [label, value] of Object.entries({
    "SKU 编码": "E2E-BK-L",
    颜色名称: "黑色",
    尺码名称: "L",
  }))
    await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "E2E-BK-L", exact: true }),
  ).toBeVisible();
  await page.goto("/purchase-orders/new");
  await select(page, "供应商", "验收服饰供应商");
  await select(page, "目标仓库", "验收仓");
  await select(page, "SKU", "E2E-BK-L");
  await page.getByLabel("采购数量", { exact: true }).fill("99");
  await page.getByLabel("单价", { exact: true }).fill("78");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("button", { name: "提交采购" })).toBeVisible();
  await page.getByRole("button", { name: "编辑单据", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("采购数量", { exact: true })
    .fill("100");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("cell", { name: "100", exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "提交采购" }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认采购", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认采购", exact: true }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(page.getByRole("button", { name: "创建入库单" })).toBeVisible();
  const poUrl = page.url();
  for (const quantity of [40, 60]) {
    await page.goto(poUrl);
    await page.getByRole("button", { name: "创建入库单" }).click();
    await page
      .getByRole("dialog")
      .getByRole("spinbutton")
      .fill(String(quantity));
    await page.getByRole("button", { name: "保存入库草稿" }).click();
    await page.getByRole("button", { name: "确认到货", exact: true }).click();
    await page.getByRole("button", { name: "确定", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "核对并过账" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "核对并过账" }).click();
    await page.getByRole("button", { name: "确定", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "查看库存流水" }),
    ).toBeVisible();
  }
  await page.goto(poUrl);
  await expect(page.getByText("已完成", { exact: true }).first()).toBeVisible();
  await page.goto("/inventory");
  await expect(
    page.getByRole("row").filter({ hasText: "E2E-BK-L" }),
  ).toContainText("100");
  await page.screenshot({
    path: ".local/inventory-preview.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.goto("/inventory/transactions");
  await expect(
    page.getByRole("cell", { name: "PURCHASE_RECEIPT" }),
  ).toHaveCount(2);
  await page.goto("/audit-logs");
  await expect(
    page.getByRole("cell", { name: "RECEIPT_POST" }).first(),
  ).toBeVisible();
});
test("未知销量明确跳过建议，并可退出登录", async ({ page }) => {
  await login(page);
  await page.goto("/purchase-suggestions");
  await page.getByRole("button", { name: "生成建议", exact: true }).click();
  await select(page, "SKU", "E2E-BK-L");
  await page.getByLabel("目标库存天数（需明确填写）").fill("21");
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(page.getByText("SKU 1：暂无完整销售数据")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page.getByRole("button", { name: "进入工作台" })).toBeVisible();
});

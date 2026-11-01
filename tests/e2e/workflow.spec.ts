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

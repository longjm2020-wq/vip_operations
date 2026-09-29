import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("external multiline paste fills successive style rows", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "商品档案" })).toBeVisible();
  await page.goto("/style-selections");
  await page.getByText("添加一行", { exact: true }).click();

  const cells = page.locator('textarea[aria-label="序缇款号"]');
  const count = await cells.count();
  const values = Array.from({ length: 3 }, (_, index) => `PASTE-${randomUUID().slice(0, 8)}-${index}`);
  await cells.last().evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  }, values.join("\r\n"));

  await expect(cells).toHaveCount(count + 2);
  for (let index = 0; index < values.length; index++)
    await expect(cells.nth(count - 1 + index)).toHaveValue(values[index]);
  await expect(page.locator("td.selection-cell-error")).toHaveCount(0);
});

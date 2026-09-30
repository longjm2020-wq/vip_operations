import { expect, test } from "@playwright/test";

test("selection presence publishes a cell and displays moving collaborator markers", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "商品档案" })).toBeVisible();
  let peerCell: { editingId: string; editingColumn: string } | null = null;
  await page.route("**/api/v1/style-selections/presence", async route => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const result = await response.json();
    if (peerCell) result.data.push({ userId: "999999", displayName: "协作测试员", activeAt: new Date().toISOString(), ...peerCell });
    await route.fulfill({ response, json: result });
  });
  await page.goto("/style-selections");
  await page.getByText("添加一行", { exact: true }).click();
  const textCell = page.locator('textarea[aria-label="序缇款号"]').last();
  // Blank rows are persisted by autosave before presence can reference their IDs.
  await expect.poll(async () => (await page.request.get("/api/v1/style-selections?pageSize=100")).json().then(result => result.total)).toBeGreaterThan(0);
  const selected = page.waitForRequest(request => request.url().endsWith("/style-selections/presence") && request.method() === "POST" && request.postDataJSON().editingId && request.postDataJSON().editingColumn === "xutiStyleNo");
  await textCell.click();
  peerCell = (await selected).postDataJSON();
  const marker = page.getByLabel("协作测试员正在选中此单元格", { exact: true });
  await expect(marker).toBeVisible({ timeout: 10000 });
  await expect(textCell.locator("xpath=ancestor::td").locator(".selection-remote-cell")).toHaveCount(1);
  peerCell = { ...peerCell!, editingColumn: "supplierStyleNo" };
  await expect(textCell.locator("xpath=ancestor::td").locator(".selection-remote-cell")).toHaveCount(0);
  await expect(marker).toBeVisible();
  peerCell = null;
  await expect(marker).toHaveCount(0);
});

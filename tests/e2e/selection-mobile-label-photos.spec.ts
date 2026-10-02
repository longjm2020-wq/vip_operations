import { test, expect } from "@playwright/test";

test("mobile capture saves wash label photos independently without a color", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "我的工作台" })).toBeVisible();

  await page.goto("/mobile/style-photos");
  await page.getByRole("button", { name: "新增款式" }).click();
  await expect(page.getByRole("dialog", { name: "补充款号与颜色" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const styleId = new URL(page.url()).searchParams.get("id");
  expect(styleId).toBeTruthy();
  const labelSection = page.locator("#mobile-label-photos");
  await expect(labelSection.getByRole("heading", { name: /洗唛\/吊牌图/ })).toBeVisible();
  await expect(labelSection.getByRole("button", { name: "拍照上传" })).toBeEnabled();
  await expect(page.locator(".mobile-photo-current").getByRole("button", { name: "拍照上传" })).toBeDisabled();

  const chooser = page.waitForEvent("filechooser");
  await labelSection.getByRole("button", { name: "相册选择" }).click();
  await (await chooser).setFiles({
    name: "wash-label.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=", "base64"),
  });
  await expect(labelSection.getByAltText("洗唛/吊牌图")).toHaveCount(1);
  const row = await page.evaluate(async id => (await (await fetch("/api/v1/style-selections/" + id)).json()).data, styleId);
  expect(row.images).toHaveLength(0);
  expect(row.labelImages).toHaveLength(1);
  expect(row.labelImages[0].color).toBe("");
});

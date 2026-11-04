import { expect, type Page } from "@playwright/test";

export async function openPersonalAssistant(page: Page) {
  const launcher = page.getByRole("button", {
    name: "打开个人助理",
    exact: true,
  });
  if (!(await launcher.isVisible()))
    await page.getByRole("button", { name: "助理设置", exact: true }).click();
  await launcher.click();
  await expect(page.locator(".assistant-settings:visible")).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: /AI 个人助理/ }),
  ).toBeInViewport({ ratio: 0.99 });
}

export async function selectAssistantPanel(page: Page, name: string) {
  await page
    .getByRole("dialog", { name: /AI 个人助理/ })
    .getByRole("button", { name: "更多助理操作", exact: true })
    .click();
  await page.getByRole("menuitem", { name, exact: true }).click();
  await expect(page.getByRole("menuitem", { name, exact: true })).toBeHidden();
}

export async function setAssistantOption(
  page: Page,
  name: string,
  checked: boolean,
) {
  const settings = page.getByRole("button", {
    name: "助理设置",
    exact: true,
  });
  await page.mouse.move(2, 2);
  await expect(page.locator(".ant-tooltip:visible")).toHaveCount(0);
  await settings.click();
  await page.getByRole("checkbox", { name, exact: true }).setChecked(checked);
  await settings.click();
}

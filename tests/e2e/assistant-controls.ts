import { expect, type Locator, type Page } from "@playwright/test";

export function companionLaunch(scope: Page | Locator) {
  return scope.getByRole("button", {
    name: /与小序语音对话|打断小序并说话|打开 AI 个人助理/,
  });
}

export async function openCompanionMenu(scope: Page | Locator) {
  await companionLaunch(scope).first().click({ button: "right" });
}

export async function openPersonalAssistant(page: Page) {
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  if (await dialog.isVisible()) {
    if (!(await dialog.locator(".ant-drawer-footer textarea").isVisible()))
      await selectAssistantPanel(page, "聊天");
    return;
  }
  const launcher = page.getByRole("button", {
    name: "文字对话",
    exact: true,
  });
  if (!(await launcher.isVisible())) await openCompanionMenu(page);
  await launcher.click();
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
  await page.mouse.move(2, 2);
  await expect(page.locator(".ant-tooltip:visible")).toHaveCount(0);
  await selectAssistantPanel(page, "对话设置");
  await page.getByRole("checkbox", { name, exact: true }).setChecked(checked);
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
}

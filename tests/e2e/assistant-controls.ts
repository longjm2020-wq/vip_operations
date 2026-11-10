import { expect, type Locator, type Page } from "@playwright/test";

export function companionLaunch(scope: Page | Locator) {
  return scope.getByRole("button", {
    name: /打开小序文字对话|打开 AI 个人助理/,
  });
}

export function workspaceVoiceStart(scope: Page | Locator) {
  return scope.getByRole("button", {
    name: "开始与小序语音对话",
    exact: true,
  });
}

export async function startWorkspaceVoice(page: Page) {
  const prompt = workspaceVoiceStart(page);
  if (await prompt.isVisible()) {
    await prompt.click();
    return;
  }
  const composer = page.getByRole("button", {
    name: "开始语音对话",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await composer.click();
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
  const mascot = companionLaunch(page);
  if (await mascot.first().isVisible()) {
    await mascot.first().click();
  } else {
    const launcher = page.getByRole("button", {
      name: "文字对话",
      exact: true,
    });
    if (!(await launcher.isVisible())) await openCompanionMenu(page);
    await launcher.click();
  }
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

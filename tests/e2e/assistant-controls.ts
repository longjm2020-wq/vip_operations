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

async function collapseWorkspaceTools(page: Page) {
  const browserClose = page.getByRole("button", {
    name: "关闭浏览器面板",
    exact: true,
  });
  if (await browserClose.isVisible()) {
    await browserClose.click();
    return;
  }
  const collapse = page.getByRole("button", {
    name: "收起右侧工具栏",
    exact: true,
  });
  if (await collapse.isVisible()) await collapse.click();
}

export async function openPersonalAssistant(page: Page) {
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  if (await dialog.isVisible()) {
    if (!(await dialog.locator(".ant-drawer-footer textarea").isVisible()))
      await selectAssistantPanel(page, "聊天");
    return;
  }
  const mascot = companionLaunch(page);
  if (new URL(page.url()).pathname === "/my-workspace") {
    if ((page.viewportSize()?.width || 1440) <= 1050)
      await collapseWorkspaceTools(page);
    if (await dialog.isVisible()) {
      if (!(await dialog.locator(".ant-drawer-footer textarea").isVisible()))
        await selectAssistantPanel(page, "聊天");
      return;
    }
    await expect(mascot.first()).toBeVisible();
  }
  if (await mascot.first().isVisible()) {
    await mascot.first().focus();
    await mascot.first().press("Enter");
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

async function selectPanelMenuItem(page: Page, name: string) {
  const parents: Record<string, string> = {
    动态反馈: "任务与文件",
    对话设置: "助理设置",
    语音设置: "助理设置",
    个人记忆: "助理设置",
  };
  const group = parents[name] ?? name;
  const item = page.getByRole("menuitem", { name: group, exact: true });
  await item.click();
  await expect(item).toBeHidden();
  if (group !== name)
    await page.getByRole("tab", { name, exact: true }).click();
}

export async function selectAssistantPanel(page: Page, name: string) {
  if (new URL(page.url()).pathname === "/my-workspace") {
    await expect(page.locator(".workspace-columns")).toBeVisible();
    if (name === "聊天") {
      if ((page.viewportSize()?.width || 1440) <= 1050)
        await collapseWorkspaceTools(page);
      if (!(await page.locator(".workspace-inline-chat").isVisible()))
        await companionLaunch(page).first().press("Enter");
      return;
    }
    const browser = page.locator(".assistant-browser-panel");
    if (name === "独立浏览器" && (await browser.isVisible())) return;
    const rail = page.getByRole("navigation", { name: "工作台工具入口" });
    if (!(await rail.isVisible())) {
      await collapseWorkspaceTools(page);
    }
    if (await rail.isVisible()) {
      const shortcuts: Record<string, string> = {
        独立浏览器: "展开独立浏览器",
        我的电脑: "展开我的电脑",
        "AI 员工": "展开 AI 员工",
      };
      const shortcut = shortcuts[name];
      if (shortcut) {
        await rail.getByRole("button", { name: shortcut, exact: true }).click();
      } else {
        await rail
          .getByRole("button", { name: "更多工作台工具", exact: true })
          .click();
        await selectPanelMenuItem(page, name);
      }
      return;
    }
    if (["独立浏览器", "我的电脑"].includes(name)) {
      await page
        .getByRole("navigation", { name: "右栏工具" })
        .getByRole("button", { name, exact: true })
        .click();
    } else {
      await page
        .getByRole("button", { name: "更多右栏工具", exact: true })
        .click();
      await selectPanelMenuItem(page, name);
    }
    return;
  }
  await page
    .getByRole("dialog", { name: /AI 个人助理/ })
    .getByRole("button", { name: "更多助理操作", exact: true })
    .click();
  await selectPanelMenuItem(page, name);
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

export async function selectAssistantExecution(page: Page, name: string) {
  const workspace = page.locator(".workspace-columns");
  if (new URL(page.url()).pathname === "/my-workspace") {
    await expect(workspace).toBeVisible();
    if (name === "小序独立浏览器") {
      await selectAssistantPanel(page, "独立浏览器");
      await page
        .getByRole("button", { name: "云端独立浏览器", exact: true })
        .click();
      await page
        .getByRole("button", { name: "浏览器标签与会话菜单", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "让小序操作当前网页", exact: true })
        .click();
      return;
    }
    if ((page.viewportSize()?.width || 1440) <= 1050)
      await collapseWorkspaceTools(page);
    await page
      .locator(".assistant-compose:visible")
      .getByRole("button", { name: "输入框菜单", exact: true })
      .click();
    await page.getByRole("menuitem", { name, exact: true }).click();
    return;
  }
  await page.getByRole("combobox", { name: "执行位置", exact: true }).click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText(name, { exact: true })
    .click();
}

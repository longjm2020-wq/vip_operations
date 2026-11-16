import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    workspaceToolsMicrophoneRequests: number;
  }
}

async function fixture(
  page: Page,
  permissions = ["analytics.read", "analytics.manage", "project.read"],
  userId = "105",
) {
  const workspace = {
    version: 1,
    note: "原有备忘",
    todos: [],
    schedule: [],
    shortcuts: ["inventory"],
    available: [
      {
        id: "inventory",
        title: "库存明细",
        description: "查看库存",
        group: "运营",
        path: "/operations/vip/inventory",
      },
    ],
    defaults: { name: "个人工作台", description: "", tools: [] },
  };
  const writes: string[] = [];
  await page.addInitScript(() => {
    window.workspaceToolsMicrophoneRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      window.workspaceToolsMicrophoneRequests++;
      throw new DOMException("布局操作不应申请麦克风", "NotAllowedError");
    };
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (request.method() !== "GET") writes.push(path);
    if (path === "/auth/me")
      data = {
        id: userId,
        displayName: "工具菜单测试",
        username: "tools",
        permissions,
        roleCodes: [],
        csrfToken: "fixture",
      };
    if (path === "/my-workspace/appearance")
      data = { mode: "dark", version: 1 };
    if (path === "/my-workspace") {
      if (request.method() === "POST")
        Object.assign(workspace, request.postDataJSON(), {
          version: workspace.version + 1,
        });
      data = workspace;
    }
    if (path === "/my-workspace/assistant")
      data = {
        ready: true,
        version: 0,
        state: "IDLE",
        messages: [],
        model: "openai/gpt-6.1-sol",
      };
    if (path === "/my-workspace/assistant/voice")
      data = {
        ready: true,
        enabled: true,
        voice: "alloy",
        model: "gpt-4o-mini-tts",
        version: 1,
      };
    if (path === "/my-workspace/assistant/memory")
      data = { entries: [], version: 0 };
    if (path === "/my-workspace/assistant/desktop")
      data = { devices: [], tasks: [] };
    if (path === "/my-workspace/assistant/browser")
      data = {
        ready: false,
        workerOnline: false,
        encryptionReady: false,
        note: "",
        profile: null,
        tasks: [],
      };
    if (path === "/my-workspace/activity")
      data = { items: [], serverTime: "2026-11-03T02:00:00Z" };
    if (path === "/my-workspace/content") data = { items: [], hasMore: false };
    await route.fulfill({ json: { data } });
  });
  return { workspace, writes };
}

test("收纳功能后中央保留小序，旧动效偏好不恢复圆形入口或分支开关", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() =>
    localStorage.setItem("xuti-workspace-ring-motion:105", "disabled"),
  );
  await page.goto("/my-workspace");
  await expect(page.locator(".workspace-ai-core")).toBeVisible();
  await expect(
    page.locator(".workspace-dock, .workspace-nest-handle"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /展开工作台分支图|收起工作台分支图/ }),
  ).toHaveCount(0);
  await expect(page.locator(".personal-workspace")).toHaveAttribute(
    "data-workspace-ring-motion",
    "enabled",
  );
  await expect(
    page.getByRole("button", { name: "工作台工具", exact: true }),
  ).toBeEnabled();
  expect(state.writes).toEqual([]);
  expect(
    await page.evaluate(() => window.workspaceToolsMicrophoneRequests),
  ).toBe(0);
});

test("手机普通工作台菜单按权限展示四项，备忘草稿切换保留且保存后写入", async ({
  page,
}) => {
  const state = await fixture(page, ["inventory.read"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-workspace");
  const trigger = page.getByRole("button", { name: "工作台工具", exact: true });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "工作台工具菜单", exact: true });
  await expect(menu.getByRole("menuitem")).toHaveCount(4);
  await expect(
    menu.getByRole("menuitem", { name: "我的内容", exact: true }),
  ).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "私有备忘", exact: true }).click();
  const note = page.getByRole("textbox", { name: "私有备忘", exact: true });
  await note.fill("手机菜单备忘");
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await trigger.click();
  await menu.getByRole("menuitem", { name: "日程", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "日程", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await trigger.click();
  await menu.getByRole("menuitem", { name: "私有备忘", exact: true }).click();
  await expect(note).toHaveValue("手机菜单备忘");
  expect(state.writes).toEqual([]);
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect.poll(() => state.workspace.note).toBe("手机菜单备忘");
  const bounds = (await page
    .getByRole("dialog", { name: "私有备忘", exact: true })
    .boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(11);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(379);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => window.workspaceToolsMicrophoneRequests),
  ).toBe(0);
  await page.screenshot({ path: ".local/workspace-tools-mobile.png" });
});

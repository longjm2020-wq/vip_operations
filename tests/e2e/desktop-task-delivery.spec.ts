import { randomUUID } from "node:crypto";
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { selectAssistantPanel } from "./assistant-controls.js";

async function pairTestReceiver(
  page: Page,
  request: APIRequestContext,
  baseURL: string,
  name: string,
  platform?: "macos",
) {
  const desktop = "/api/v1/my-workspace/assistant/desktop";
  const login = await page.request.post("/api/v1/auth/login", {
    data: { username: "admin", password: process.env.E2E_PASSWORD },
  });
  await expect(login).toBeOK();
  const { csrfToken } = (await login.json()).data;
  const pairing = await page.request.post(desktop + "/pair-code", {
    headers: {
      Origin: baseURL!,
      "X-CSRF-Token": csrfToken,
      "Idempotency-Key": randomUUID(),
    },
  });
  await expect(pairing).toBeOK();
  const paired = await request.post(desktop + "/client/pair", {
    data: { code: (await pairing.json()).data.code, name, platform },
  });
  await expect(paired).toBeOK();
  const { token, deviceId } = (await paired.json()).data;
  const client = async (path: string, data: object) => {
    const res = await request.post(desktop + "/client/" + path, {
      headers: { Authorization: "Bearer " + token },
      data,
    });
    await expect(res).toBeOK();
    return (await res.json()).data;
  };
  const revoke = () =>
    page.request.post(desktop + "/devices/" + deviceId + "/revoke", {
      headers: {
        Origin: baseURL,
        "X-CSRF-Token": csrfToken,
        "Idempotency-Key": randomUUID(),
      },
    });
  return { deviceId, client, revoke };
}

test("工作台自动区分记事本连续输入、普通提问与网页任务，回执绑定原窗口", async ({
  page,
  request,
  baseURL,
}) => {
  const name = "接单回归测试电脑";
  const { client, deviceId, revoke } = await pairTestReceiver(
    page,
    request,
    baseURL!,
    name,
  );
  try {
    const { authorizationId } = await client("authorization", {
      enabled: true,
    });
    const receiving = {
      localBrowser: true,
      nativeActions: true,
      windowContinuations: true,
    };
    await client("poll", receiving);
    await page.goto("/my-workspace");
    await selectAssistantPanel(page, "我的电脑");
    const device = page
      .locator(".assistant-desktop-item")
      .filter({ hasText: name });
    await device.getByRole("button", { name: "设为常用电脑" }).click();
    const composer = page.locator(".assistant-compose:visible");
    const instruction = "在我的电脑上切换到已打开的记事本窗口";
    await expect(composer.getByRole("textbox")).toHaveAttribute(
      "placeholder",
      /在我的电脑上打开记事本/,
    );
    await composer.getByRole("textbox").fill(instruction);
    await client("poll", receiving);
    await composer.getByRole("button", { name: "发送给个人助理" }).click();
    const panel = page.locator(".assistant-desktop-panel");
    await panel.getByText("操作任务", { exact: true }).click();
    const card = panel.getByRole("region", {
      name: "电脑任务：" + instruction,
    });
    await expect(card).toContainText(instruction);
    const { task } = await client("poll", receiving);
    expect(task).toMatchObject({
      status: "WAITING",
      deviceId,
      nativeAction: "focus_notepad",
    });
    const attemptId = randomUUID();
    const control = "tasks/" + task.id + "/control";
    expect(
      (
        await client(control, {
          action: "start_native",
          authorizationId,
          attemptId,
        })
      ).status,
    ).toBe("RUNNING");
    const windowId = randomUUID();
    const retained = { ...receiving, retainedTaskId: task.id };
    await client(control, {
      action: "complete_native",
      authorizationId,
      attemptId,
      windowId,
      retainedWindow: true,
      application: "notepad",
      window: "测试空白窗口 - 记事本",
    });
    await expect(card).toContainText("已完成", { timeout: 15000 });
    await expect(card).toContainText("已确认执行 1 步");
    await expect(card).toContainText("测试空白窗口 - 记事本");
    const textbox = composer.getByRole("textbox");
    await textbox.fill("为什么输不进去？");
    await expect(
      composer.getByRole("button", { name: "本条目标：普通对话", exact: true }),
    ).toBeVisible();
    await textbox.fill("在独立浏览器里点击帮助按钮");
    await expect(
      composer.getByRole("button", {
        name: "本条目标：操作网页 · 云端",
        exact: true,
      }),
    ).toBeVisible();
    await textbox.fill("输入9999999");
    await expect(
      composer.getByRole("button", {
        name: /本条目标：操作我的电脑.*测试空白窗口/,
      }),
    ).toBeVisible();
    await client("poll", retained);
    await composer.getByRole("button", { name: "发送给个人助理" }).click();
    let continuation: typeof task | undefined;
    await expect
      .poll(async () => {
        continuation = (await client("poll", retained)).task;
        return continuation?.nativeAction;
      })
      .toBe("type_notepad");
    expect(continuation).toMatchObject({
      deviceId,
      boundWindowId: windowId,
      previousTaskId: task.id,
      nativeText: "9999999",
      scope: "window",
    });
    const followupControl = "tasks/" + continuation!.id + "/control";
    const followupAttempt = randomUUID();
    await client(followupControl, {
      action: "start_native",
      authorizationId,
      attemptId: followupAttempt,
    });
    await client(followupControl, {
      action: "complete_native",
      authorizationId,
      attemptId: followupAttempt,
      windowId,
      application: "notepad",
      window: "测试空白窗口 - 记事本",
    });
    const followupCard = page
      .locator(".assistant-desktop-panel")
      .getByRole("region", { name: "电脑任务：输入9999999" });
    await expect(followupCard).toContainText("已完成", { timeout: 15000 });
    const files = "在我的电脑桌面新建文件夹，命名为样品资料";
    await textbox.fill(files);
    await client("poll", receiving);
    await composer.getByRole("button", { name: "发送给个人助理" }).click();
    const filesCard = page
      .locator(".assistant-desktop-panel")
      .getByRole("region", { name: "电脑任务：" + files });
    await expect(filesCard).toContainText(files);
    const legacy = (await client("poll", receiving)).task;
    expect(legacy.startLocation).toBeUndefined();
    expect(
      (await client("poll", { ...receiving, desktopExplorer: true })).task,
    ).toMatchObject({
      id: legacy.id,
      deviceId,
      status: "WAITING",
      startLocation: "desktopExplorer",
    });
  } finally {
    await revoke();
  }
});

test("从小序聊天将文件复制交给配对的 Mac，原任务卡显示 Finder 回执", async ({
  page,
  request,
  baseURL,
}) => {
  const name = "Finder 回归测试设备";
  const { client, deviceId, revoke } = await pairTestReceiver(
    page,
    request,
    baseURL!,
    name,
    "macos",
  );
  const receiving = { platform: "macos", fileCopyShortcuts: true };
  try {
    const { authorizationId } = await client("authorization", {
      enabled: true,
    });
    await client("poll", receiving);
    await page.goto("/my-workspace");
    await selectAssistantPanel(page, "我的电脑");
    const panel = page.locator(".assistant-desktop-panel");
    await panel.getByText("其他连接方式与客户端更新", { exact: true }).click();
    await expect(
      panel.getByRole("link", { name: "下载 Mac Finder 助手" }),
    ).toHaveAttribute("href", "/downloads/xuti-finder-macos.zip");
    const device = panel
      .locator(".assistant-desktop-item")
      .filter({ hasText: name });
    await expect(device).toContainText("macOS · Finder");
    await device.getByRole("button", { name: "设为常用电脑" }).click();
    const source = "~/Documents/样品/说明.txt",
      destination = "~/Documents/已核对";
    const instruction = `把「${source}」复制到「${destination}」`;
    const composer = page.locator(".assistant-compose:visible");
    await composer.getByRole("textbox").fill(instruction);
    await client("poll", receiving);
    await composer.getByRole("button", { name: "发送给个人助理" }).click();
    const chatCard = page
      .getByRole("region", { name: "电脑任务：" + instruction })
      .filter({ visible: true })
      .first();
    await expect(chatCard).toContainText(instruction);
    const { task } = await client("poll", receiving);
    expect(task).toMatchObject({
      deviceId,
      nativeAction: "copy_finder_files",
      fileCopy: { source, destination, selection: "file" },
    });
    const attemptId = randomUUID();
    for (const action of [
      "start",
      "permit_copy",
      "copied",
      "permit_paste",
      "complete",
    ])
      await client("tasks/" + task.id + "/file-copy", {
        action,
        authorizationId,
        attemptId,
      });
    await expect(chatCard).toContainText("已核验文件复制到指定的 Finder 目录", {
      timeout: 15000,
    });
  } finally {
    await revoke();
  }
});

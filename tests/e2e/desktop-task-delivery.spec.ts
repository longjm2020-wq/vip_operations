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

test("在工作台指定企业微信后，复合任务从已授权的企业微信窗口开始", async ({
  page,
  request,
  baseURL,
}) => {
  const name = "企业微信定位回归设备";
  const { client, deviceId, revoke } = await pairTestReceiver(
    page,
    request,
    baseURL!,
    name,
  );
  const capabilities = { nativeActions: true, wecomApp: true };
  const instruction =
    "在我的电脑上打开企业微信给我的好友测试联系人准备一句问候";
  try {
    const { authorizationId } = await client("authorization", {
      enabled: true,
    });
    await client("poll", capabilities);
    await page.goto("/my-workspace");
    await selectAssistantPanel(page, "我的电脑");
    await page
      .locator(".assistant-desktop-item")
      .filter({ hasText: name })
      .getByRole("button", { name: "设为常用电脑" })
      .click();
    const composer = page.locator(".assistant-compose:visible");
    const openOnly = "在我的电脑上打开企业微信";
    await composer.getByRole("textbox").fill(openOnly);
    await client("poll", capabilities);
    await composer.getByRole("button", { name: "发送给个人助理" }).click();
    const openCard = page
      .getByRole("region", { name: "电脑任务：" + openOnly, exact: true })
      .filter({ visible: true })
      .first();
    await expect(openCard).toContainText(openOnly);
    const opening = (await client("poll", capabilities)).task;
    expect(opening).toMatchObject({
      deviceId,
      instruction: openOnly,
      startLocation: "wecom",
    });
    const receipt = { authorizationId, attemptId: randomUUID() };
    const control = "tasks/" + opening.id + "/control";
    expect(
      (await client(control, { action: "start_wecom", ...receipt })).status,
    ).toBe("RUNNING");
    expect(
      (
        await client(control, {
          action: "ready_wecom",
          ...receipt,
          windowId: randomUUID(),
          application: "WXWork",
          window: "企业微信",
        })
      ).status,
    ).toBe("DONE");
    await expect(openCard).toContainText("已核验企业微信窗口在前台", {
      timeout: 15000,
    });
    await composer.getByRole("textbox").fill(instruction);
    await client("poll", capabilities);
    await composer.getByRole("button", { name: "发送给个人助理" }).click();
    const card = page
      .getByRole("region", { name: "电脑任务：" + instruction })
      .filter({ visible: true })
      .first();
    await expect(card).toContainText(instruction);
    const { task } = await client("poll", capabilities);
    expect(task).toMatchObject({
      deviceId,
      instruction,
      status: "WAITING",
      startLocation: "wecom",
    });
  } finally {
    await revoke();
  }
});

test("在工作台一句话新建桌面文件夹并复制内容，升级后重试只派一单", async ({
  page,
  request,
  baseURL,
}) => {
  const name = "桌面资料复制回归设备";
  const { client, deviceId, revoke } = await pairTestReceiver(
    page,
    request,
    baseURL!,
    name,
  );
  const receiving = {
    desktopExplorer: true,
    fileCopyShortcuts: true,
    nativeActions: true,
  };
  const source = "D:\\Desktop\\AI0520";
  const instruction = `在我的电脑桌面新建文件夹"自动化112601"，并将路径${source}下的内容复制进来`;
  try {
    await client("authorization", { enabled: true });
    await client("poll", receiving);
    await page.goto("/my-workspace");
    await selectAssistantPanel(page, "我的电脑");
    await page
      .locator(".assistant-desktop-item")
      .filter({ hasText: name })
      .getByRole("button", { name: "设为常用电脑" })
      .click();
    await page
      .locator(".assistant-desktop-panel")
      .getByRole("button", { name: "下达指令", exact: true })
      .click();
    const composer = page.locator(".assistant-compose:visible");
    const draft = composer.getByRole("textbox");
    const send = composer.getByRole("button", { name: "发送给个人助理" });
    await draft.fill(instruction);
    const [firstAttempt] = await Promise.all([
      page.waitForResponse((res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname === "/api/v1/my-workspace/assistant"
      ),
      send.click(),
    ]);
    expect((await firstAttempt.json()).data.state).toBe("FAILED");
    await expect(page.getByText(/请在所选 Windows 电脑下载并启动 1\.2\.13/).first()).toBeVisible();
    await expect(draft).toHaveValue(instruction);
    expect((await client("poll", receiving)).task).toBeNull();

    const updated = { ...receiving, desktopFolderCopy: true };
    await client("poll", updated);
    await send.click();
    const card = page
      .getByRole("region", { name: "电脑任务：" + instruction })
      .filter({ visible: true })
      .first();
    await expect(card).toContainText(instruction);
    const { task } = await client("poll", updated);
    expect(task).toMatchObject({
      deviceId,
      status: "WAITING",
      fileCopy: {
        source,
        destination: "自动化112601",
        selection: "contents",
        destinationKind: "newDesktopFolder",
      },
    });
    const assistant = await page.request.get("/api/v1/my-workspace/assistant");
    const { messages } = (await assistant.json()).data;
    expect(
      messages.filter(
        (m: { role: string; text: string }) =>
          m.role === "user" && m.text === instruction,
      ),
    ).toHaveLength(1);
    expect(
      messages.filter(
        (m: { desktopTaskId?: string }) => m.desktopTaskId === task.id,
      ),
    ).toHaveLength(1);
  } finally {
    await revoke();
  }
});

test("普通复制从聊天默认派给 Windows 后台，用户可同时编辑草稿并查看原任务回执", async ({
  page,
  request,
  baseURL,
}) => {
  const name = "后台文件复制回归设备";
  const { client, deviceId, revoke } = await pairTestReceiver(
    page,
    request,
    baseURL!,
    name,
  );
  const receiving = {
    desktopExplorer: true,
    fileCopyShortcuts: true,
    desktopFolderCopy: true,
    backgroundFileCopy: true,
  };
  const instruction =
    "在我的电脑桌面新建文件夹「后台样品」，并将路径 D:\\测试样品 下的内容复制进来";
  try {
    const { authorizationId } = await client("authorization", {
      enabled: true,
    });
    await client("poll", receiving);
    await page.goto("/my-workspace");
    await selectAssistantPanel(page, "我的电脑");
    await page
      .locator(".assistant-desktop-item")
      .filter({ hasText: name })
      .getByRole("button", { name: "设为常用电脑" })
      .click();
    await page
      .locator(".assistant-desktop-panel")
      .getByRole("button", { name: "下达指令", exact: true })
      .click();
    const composer = page.locator(".assistant-compose:visible");
    const draft = composer.getByRole("textbox");
    await draft.fill(instruction);
    await composer.getByRole("button", { name: "发送给个人助理" }).click();
    const card = page
      .getByRole("region", { name: "电脑任务：" + instruction })
      .filter({ visible: true })
      .first();
    await expect(card).toContainText(instruction);
    const { task } = await client("poll", receiving);
    expect(task).toMatchObject({
      deviceId,
      status: "WAITING",
      fileCopyMode: "background",
      fileCopy: { destination: "后台样品", selection: "contents" },
    });
    const attemptId = randomUUID();
    const report = (action: string) =>
      client("tasks/" + task.id + "/background-copy", {
        action,
        authorizationId,
        attemptId,
      });
    await report("start");
    await report("permit");
    await draft.fill("同时编辑的下一条草稿");
    await report("check");
    expect((await report("complete")).status).toBe("DONE");
    await expect(card).toContainText("已核验后台文件复制结果", {
      timeout: 15000,
    });
    await expect(draft).toHaveValue("同时编辑的下一条草稿");
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

test("聊天将桌面连续编号目录作为一项后台任务下发并显示核验结果", async ({ page, request, baseURL }) => {
  const name = "批量建目录测试电脑";
  const { client, deviceId, revoke } = await pairTestReceiver(page, request, baseURL!, name);
  const receiving = { nativeActions: true, folderCreation: true, folderNotes: true };
  const instruction = '在我的电脑桌面新建文件夹"测试自动化999"，并在文件内新建10个文件夹，命名规则按"XUTI-01......XUTI-n"';
  try {
    const { authorizationId } = await client("authorization", { enabled: true });
    await client("poll", receiving);
    await page.goto("/my-workspace");
    await selectAssistantPanel(page, "我的电脑");
    await page.locator(".assistant-desktop-item").filter({ hasText: name })
      .getByRole("button", { name: "设为常用电脑" }).click();
    const composer = page.locator(".assistant-compose:visible");
    await composer.getByRole("textbox").fill(instruction);
    await client("poll", receiving);
    await composer.getByRole("button", { name: "发送给个人助理" }).click();
    const card = page.getByRole("region", { name: "电脑任务：" + instruction }).filter({ visible: true }).first();
    await expect(card).toContainText("后台批量建文件夹");
    const { task } = await client("poll", receiving);
    expect(task).toMatchObject({
      deviceId, status: "WAITING", nativeAction: "create_desktop_folders",
      folderCreation: {
        parentName: "测试自动化999",
        folderNames: Array.from({ length: 10 }, (_, i) => "XUTI-" + String(i + 1).padStart(2, "0")),
      },
    });
    const claim = { authorizationId, attemptId: task.folderCreationAttemptId };
    const route = "tasks/" + task.id + "/folder-creation";
    await client(route, { ...claim, action: "start" });
    await composer.getByRole("textbox").fill("同时编辑的下一条草稿");
    const done = await client(route, { ...claim, action: "complete", verifiedCount: 10 });
    expect(done.recentSteps).toEqual([{ step: 1, action: "create_folders", result: "ok" }]);
    await expect(card.getByRole("status")).toContainText("10 个指定子文件夹", { timeout: 15000 });
    await expect(composer.getByRole("textbox")).toHaveValue("同时编辑的下一条草稿");

    const followup = "在每个子文件夹内新建一个记事本，命名按文件夹名命名";
    await composer.getByRole("textbox").fill(followup);
    await client("poll", receiving);
    await composer.getByRole("button", { name: "发送给个人助理" }).click();
    const notesCard = page.getByRole("region", { name: "电脑任务：" + followup }).filter({ visible: true }).first();
    await expect(notesCard).toContainText("后台批量建文本");
    const { task: notes } = await client("poll", receiving);
    expect(notes).toMatchObject({ deviceId, nativeAction: "create_folder_notes", folderCreation: task.folderCreation });
    const notesClaim = { authorizationId, attemptId: notes.folderCreationAttemptId };
    const notesRoute = "tasks/" + notes.id + "/folder-creation";
    await client(notesRoute, { ...notesClaim, action: "start" });
    const notesDone = await client(notesRoute, { ...notesClaim, action: "complete", verifiedCount: 10 });
    expect(notesDone.recentSteps).toEqual([{ step: 1, action: "create_notes", result: "ok" }]);
    await expect(notesCard.getByRole("status")).toContainText("10", { timeout: 15000 });
  } finally {
    await revoke();
  }
});

test("整句建父目录、编号子目录和同名文本只投递一个后台任务", async ({ page, request, baseURL }) => {
  const name = "目录和文本合并测试电脑";
  const { client, deviceId, revoke } = await pairTestReceiver(page, request, baseURL!, name);
  const receiving = { nativeActions: true, folderCreation: true, folderNotes: true, folderBatchNotes: true };
  const instruction = '在我的电脑桌面新建父文件夹"测试自动化666"，并在文件内新建100个子文件夹，命名规则按"XUTI-01……XUTI-n"，然后在每个子文件夹内新建一个记事本，命名按子文件夹名命名';
  try {
    const { authorizationId } = await client("authorization", { enabled: true });
    await client("poll", receiving);
    await page.goto("/my-workspace");
    await selectAssistantPanel(page, "我的电脑");
    await page.locator(".assistant-desktop-item").filter({ hasText: name })
      .getByRole("button", { name: "设为常用电脑" }).click();
    const composer = page.locator(".assistant-compose:visible");
    await composer.getByRole("textbox").fill(instruction);
    await client("poll", receiving);
    await composer.getByRole("button", { name: "发送给个人助理" }).click();
    const card = page.getByRole("region", { name: "电脑任务：" + instruction }).filter({ visible: true }).first();
    await expect(card).toContainText("后台批量建目录和文本");
    await card.getByText("后台执行计划", { exact: true }).click();
    await expect(card.locator(".assistant-desktop-plan li")).toHaveText([
      "按名称清单补齐父目录和子目录", "在每个子目录中补齐同名 .txt 文件", "核对清单中的所有目标并返回结果",
    ]);
    const { task } = await client("poll", receiving);
    expect(task).toMatchObject({
      deviceId, nativeAction: "create_folders_with_notes",
      folderSteps: ["ensure_directories", "ensure_same_name_text", "verify"],
      folderCreation: {
        parentName: "测试自动化666",
        folderNames: Array.from({ length: 100 }, (_, index) => "XUTI-" + String(index + 1).padStart(2, "0")),
      },
    });
    const claim = { authorizationId, attemptId: task.folderCreationAttemptId };
    const route = "tasks/" + task.id + "/folder-creation";
    await client(route, { ...claim, action: "start" });
    const done = await client(route, { ...claim, action: "complete", verifiedCount: 100 });
    expect(done.recentSteps).toEqual([{ step: 1, action: "create_folders_and_notes", result: "ok" }]);
    await expect(card.getByRole("status")).toContainText("100", { timeout: 15000 });
  } finally {
    await revoke();
  }
});

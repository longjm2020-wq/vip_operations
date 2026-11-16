import { expect, test, type Page } from "@playwright/test";
import type {
  BrowserFrame,
  BrowserState,
  BrowserTask,
} from "../../packages/contracts/src/assistant-browser.js";
import {
  selectAssistantPanel,
  selectAssistantExecution,
} from "./assistant-controls.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const frameId = "22222222-2222-4222-8222-222222222222";
const historyTaskId = "33333333-3333-4333-8333-333333333333";
const modelId = "engine/aaaaaaaaaaaaaaaaaaaaaaaa";
const makeTask = (): BrowserTask => ({
  id: taskId,
  instruction: "打开示例网站并查找帮助",
  status: "RUNNING",
  stage: "正在查找帮助入口",
  step: 2,
  url: "https://example.com/",
  title: "示例网站",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
async function fixture(page: Page) {
  const state = {
    user: "7",
    ready: true,
    chatReady: true,
    tasks: [] as BrowserTask[],
    requests: [] as Record<string, unknown>[],
    browserRequests: [] as Record<string, unknown>[],
    createError: "",
    controls: [] as string[],
    actions: [] as Record<string, any>[],
    rejectAction: false,
    frame: null as BrowserFrame | null,
    frames: {} as Record<string, BrowserFrame | null>,
    frameRequests: [] as string[],
    saved: true,
    cleared: 0,
  };
  const conversation = {
    ready: true,
    availabilityMessage: "小序已就绪",
    state: "IDLE",
    version: 0,
    error: "",
    messages: [] as Record<string, unknown>[],
  };
  const screenshot = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600"><rect width="1000" height="600" fill="#e9eef4"/><text x="80" y="100" font-size="28">Browser test page</text><rect x="200" y="250" width="600" height="70" fill="white" stroke="#333"/></svg>',
  ).toString("base64");
  const freshFrame = () => {
    state.frame = {
      frameId: crypto.randomUUID(),
      epoch: 3,
      width: 1000,
      height: 600,
      image: `data:image/svg+xml;base64,${screenshot}`,
      url: "https://example.com/login",
      title: "测试登录页",
    };
  };
  freshFrame();
  state.frame!.frameId = frameId;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (path === "/auth/me")
      data = {
        id: state.user,
        username: "test",
        displayName: "测试用户",
        roleCodes: [],
        permissions: ["analytics.read", "analytics.manage"],
        csrfToken: "fixture",
      };
    else if (path === "/my-workspace")
      data = {
        version: 1,
        note: "",
        todos: [],
        schedule: [],
        shortcuts: [],
        available: [],
        defaults: { name: "我的工作台", description: "", tools: [] },
      };
    else if (path === "/my-workspace/appearance")
      data = { mode: "dark", version: 1 };
    else if (path === "/my-workspace/activity")
      data = { items: [], serverTime: new Date().toISOString() };
    else if (path === "/my-workspace/assistant/memory")
      data = { version: 0, entries: [] };
    else if (path === "/my-workspace/assistant/desktop")
      data = { devices: [], tasks: [] };
    else if (path === "/my-workspace/assistant/capabilities")
      data = {
        defaultModel: modelId,
        models: [
          {
            id: modelId,
            name: "通用助手",
            displayName: "测试模型",
            vision: true,
          },
        ],
        imageModels: [],
      };
    else if (
      path === "/my-workspace/assistant/voice" ||
      path === "/my-workspace/assistant/realtime"
    )
      data = {
        ready: false,
        enabled: false,
        canManage: false,
        model: "小序语音",
        message: "语音尚未启用",
      };
    else if (path === "/my-workspace/assistant/browser")
      data = {
        ready: state.ready,
        workerOnline: state.ready,
        encryptionReady: true,
        note: state.ready ? "独立浏览器已连接" : "独立浏览器执行服务尚未连接",
        profile: {
          id: "profile",
          hasSavedSession: state.saved,
          savedAt: state.saved ? new Date().toISOString() : null,
        },
        tasks: state.tasks,
      } satisfies BrowserState;
    else if (path === "/my-workspace/assistant/browser/tasks") {
      const body = request.postDataJSON();
      state.browserRequests.push(body);
      if (state.createError) {
        await route.fulfill({
          status: 503,
          json: {
            error: { code: "BROWSER_UNAVAILABLE", message: state.createError },
          },
        });
        return;
      }
      data = {
        ...makeTask(),
        instruction: body.instruction,
        url: body.url || "",
        status: "QUEUED",
        stage: "等待独立浏览器",
      };
      state.tasks = [data as BrowserTask];
    } else if (
      /^\/my-workspace\/assistant\/browser\/tasks\/[^/]+\/frame$/.test(path)
    ) {
      const selectedTask = path.split("/").at(-2)!;
      state.frameRequests.push(selectedTask);
      data = Object.hasOwn(state.frames, selectedTask)
        ? state.frames[selectedTask]
        : state.frame;
    } else if (
      path === `/my-workspace/assistant/browser/tasks/${taskId}/control`
    ) {
      const action = request.postDataJSON().action;
      state.controls.push(action);
      state.tasks[0].status =
        action === "pause"
          ? "PAUSED"
          : action === "resume"
            ? "RUNNING"
            : "CANCELED";
      state.tasks[0].stage =
        action === "pause"
          ? "已暂停自动操作，可以接管当前页面"
          : action === "resume"
            ? "已继续当前独立浏览器任务"
            : "你已停止独立浏览器任务";
      freshFrame();
      data = state.tasks[0];
    } else if (
      path === `/my-workspace/assistant/browser/tasks/${taskId}/actions`
    ) {
      state.actions.push(request.postDataJSON());
      if (state.rejectAction) {
        freshFrame();
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: "BROWSER_FRAME_CHANGED",
              message: "浏览器画面已变化，请刷新后重新操作",
            },
          },
        });
        return;
      }
      data = { queued: true };
    } else if (path === "/my-workspace/assistant/browser/session/clear") {
      state.cleared++;
      state.saved = false;
      state.tasks.forEach((task) => {
        task.status = "CANCELED";
        task.stage = "你已清除独立浏览器登录状态";
      });
      state.frame = null;
      data = { cleared: true };
    } else if (path === "/my-workspace/assistant") {
      conversation.ready = state.chatReady;
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        state.requests.push(body);
        conversation.version++;
        if (body.browserExecution) {
          state.tasks = [
            {
              ...makeTask(),
              instruction: body.message,
              status: "QUEUED",
              stage: "等待独立浏览器",
            },
          ];
          conversation.messages.push(
            { id: body.requestId, role: "user", text: body.message },
            {
              id: `reply-${body.requestId}`,
              role: "assistant",
              text: "已提交独立浏览器任务。",
              browserTaskId: taskId,
            },
          );
        } else
          conversation.messages.push(
            { id: body.requestId, role: "user", text: body.message },
            {
              id: `reply-${body.requestId}`,
              role: "assistant",
              text: "网站对话回复",
            },
          );
      }
      data = conversation;
    }
    await route.fulfill({ json: { data } });
  });
  return { state, freshFrame };
}
async function chooseBrowser(page: Page) {
  await selectAssistantExecution(page, "小序独立浏览器");
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`完成态在 ${viewport.name} 只保留浏览器工具、地址与只读画面，历史和刷新仍可达`, async ({
    page,
  }) => {
    const { state } = await fixture(page);
    const capture = await page.context().newPage();
    await capture.setViewportSize({ width: 1280, height: 800 });
    await capture.setContent(
      '<html><body style="margin:0;background:#f5f7fa;font:24px Arial"><header style="padding:36px;background:#e5edf3">IANA · Public page fixture</header><main style="padding:48px"><h1>Example Domains</h1><p>This public information page is rendered at 1280 × 800.</p></main></body></html>',
    );
    const jpeg = await capture.screenshot({ type: "jpeg" });
    await capture.close();
    const instruction =
      "打开 https://example.com/，实际点击页面上的 Learn more 链接进入 IANA。不要直接输入 IANA 网址代替点击。核对新页面标题与 Example Domains 内容，再完成任务；只访问这两个公开网站，不登录、不填写表单、不发送、不购买、不下载，也不操作我的电脑。";
    state.tasks = [
      {
        ...makeTask(),
        instruction,
        status: "DONE",
        stage: "已点击 Learn more 进入 IANA，并核对 Example Domains 页面。",
        url: "https://www.iana.org/help/example-domains",
        title: "Example Domains",
      },
    ];
    state.frame = {
      ...state.frame!,
      width: 1280,
      height: 800,
      image: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
      url: state.tasks[0].url,
      title: state.tasks[0].title,
      readOnly: true,
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.goto("/my-workspace?assistant=browser");
    const panel = page.locator(".assistant-browser-panel");
    const image = panel.getByRole("img", { name: "小序独立浏览器当前截图" });
    await expect(image).toBeVisible();
    await expect(image).toHaveJSProperty("naturalWidth", 1280);
    await expect(image).toHaveJSProperty("naturalHeight", 800);
    await expect(
      panel.getByRole("button", { name: "浏览器标签与会话菜单", exact: true }),
    ).toContainText("Example Domains");
    await expect(
      panel.getByLabel("当前网页地址", { exact: true }),
    ).toContainText(state.tasks[0].url);
    await expect(
      panel.getByLabel("最终画面只读", { exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("heading")).toHaveCount(0);
    await expect(
      panel.getByRole("region", {
        name: `浏览器任务：${instruction}`,
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(panel.getByRole("combobox")).toHaveCount(0);
    await expect(panel.getByText(instruction, { exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /刷新/ })).toHaveCount(1);
    await expect(
      panel.getByRole("button", { name: "刷新浏览器状态", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "新建浏览器任务", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "关闭浏览器面板", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator(".workspace-right")
        .getByRole("navigation", { name: "右栏工具", exact: true }),
    ).toBeHidden();
    await expect(
      page
        .locator(".workspace-right")
        .getByRole("combobox", { name: "执行位置", exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByLabel("向当前焦点输入文字", { exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "点击独立浏览器画面", exact: true }),
    ).toBeDisabled();
    const dimensions = await panel.evaluate((element) => {
      const drawer = element.closest<HTMLElement>(
        ".workspace-tools-host, .ant-drawer-body",
      )!;
      const panelRect = element.getBoundingClientRect();
      const drawerRect = drawer.getBoundingClientRect();
      return {
        drawerOverflow: drawer.scrollWidth - drawer.clientWidth,
        panelWidth: element.clientWidth,
        panelRight: panelRect.right,
        drawerRight: drawerRect.left + drawer.clientWidth,
        boxes: [
          element,
          ...element.querySelectorAll(
            ".assistant-browser-tabbar,.assistant-browser-takeover,.assistant-browser-screen,.assistant-browser-screen img",
          ),
        ].map((box) => {
          const rect = box.getBoundingClientRect();
          return {
            className: box.className,
            overflow: box.scrollWidth - box.clientWidth,
            left: rect.left,
            right: rect.right,
            width: rect.width,
          };
        }),
      };
    });
    expect(dimensions.drawerOverflow).toBeLessThanOrEqual(1);
    expect(dimensions.panelRight).toBeLessThanOrEqual(
      dimensions.drawerRight + 1,
    );
    for (const box of dimensions.boxes) {
      expect(box.overflow, `${box.className} overflow`).toBeLessThanOrEqual(1);
      expect(box.width, `${box.className} width`).toBeLessThanOrEqual(
        dimensions.panelWidth + 1,
      );
      expect(box.right, `${box.className} right edge`).toBeLessThanOrEqual(
        dimensions.panelRight + 1,
      );
    }
    const rendered = await image.boundingBox();
    expect(rendered!.width).toBeLessThan(1280);
    expect(rendered!.width / rendered!.height).toBeCloseTo(1280 / 800, 2);
    await image.scrollIntoViewIfNeeded();
    if (viewport.name === "mobile") {
      await expect(page.locator(".workspace-dock-copy").first()).toBeHidden();
      await expect(
        page.locator(".workspace-companion-host .companion-launch"),
      ).toBeHidden();
    }
    await page.screenshot({
      path: `.local/browser-minimal-done-${viewport.name}.png`,
    });
    state.tasks.push({
      ...makeTask(),
      id: historyTaskId,
      status: "DONE",
      instruction: "查看历史帮助页",
      title: "历史帮助页",
      url: "https://example.com/history",
    });
    state.frames[historyTaskId] = {
      ...state.frame!,
      frameId: crypto.randomUUID(),
      url: "https://example.com/history",
      title: "历史帮助页",
    };
    await panel
      .getByRole("button", { name: "刷新浏览器状态", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "浏览器标签与会话菜单", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "清除浏览器登录状态", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("menuitem", { name: "已完成 · 查看历史帮助页", exact: true })
      .click();
    await expect(
      panel.getByRole("button", { name: "浏览器标签与会话菜单", exact: true }),
    ).toContainText("历史帮助页");
    await expect(
      panel.getByLabel("当前网页地址", { exact: true }),
    ).toContainText("https://example.com/history");
    const reads = state.frameRequests.filter(
      (id) => id === historyTaskId,
    ).length;
    state.frames[historyTaskId] = {
      ...state.frames[historyTaskId]!,
      frameId: crypto.randomUUID(),
      url: "https://example.com/history-updated",
    };
    await panel
      .getByRole("button", { name: "刷新浏览器状态", exact: true })
      .click();
    await expect
      .poll(
        () => state.frameRequests.filter((id) => id === historyTaskId).length,
      )
      .toBeGreaterThan(reads);
    await expect(
      panel.getByLabel("当前网页地址", { exact: true }),
    ).toContainText("https://example.com/history-updated");
    expect(state.actions).toEqual([]);
    expect(state.controls).toEqual([]);
    expect(state.browserRequests).toEqual([]);
  });
}

test("独立浏览器未就绪不影响网站对话，显式选择后阻断且不回退主机", async ({
  page,
}) => {
  const { state } = await fixture(page);
  state.ready = false;
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  await expect(composer.locator("textarea")).toBeEnabled();
  await composer.locator("textarea").fill("保留这个网页任务草稿");
  await chooseBrowser(page);
  await expect(
    page.getByRole("button", { name: "浏览器标签与会话菜单", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("complementary", { name: "右侧工具栏" })
      .getByText("独立浏览器执行服务尚未连接", { exact: true })
      .last(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "开始浏览器任务", exact: true }),
  ).toBeDisabled();
  await selectAssistantPanel(page, "聊天");
  await expect(composer.locator("textarea")).toHaveValue(
    "保留这个网页任务草稿",
  );
  await expect(composer.locator("textarea")).toBeDisabled();
  expect(state.requests).toEqual([]);
  await selectAssistantExecution(page, "网站内");
  await expect(composer.locator("textarea")).toBeEnabled();
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect.poll(() => state.requests.length).toBe(1);
  expect(state.requests[0].browserExecution).toBeUndefined();
  expect(state.requests[0].desktopDeviceId).toBeUndefined();
});

test("独立浏览器目标发送、后台进度与跨页面恢复保留同一任务，服务变更不误发", async ({
  page,
}) => {
  const { state } = await fixture(page);
  state.chatReady = false;
  await page.goto("/my-workspace");
  await chooseBrowser(page);
  const composer = page.locator(".assistant-compose:visible");
  await expect(
    composer.getByRole("button", { name: "选择对话模型" }),
  ).toHaveCount(0);
  await composer.locator("textarea").fill("打开百度");
  state.ready = false;
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "独立浏览器执行服务尚未连接" })
      .first(),
  ).toBeVisible();
  expect(state.requests).toEqual([]);
  await expect(composer.locator("textarea")).toHaveValue("打开百度");
  state.ready = true;
  await expect(
    composer.getByRole("button", { name: "发送给个人助理" }),
  ).toBeEnabled({ timeout: 8000 });
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect.poll(() => state.requests.length).toBe(1);
  expect(state.requests[0]).toMatchObject({
    browserExecution: true,
    message: "打开百度",
    includePersonalContext: false,
    includeMemory: false,
  });
  expect(state.requests[0].desktopDeviceId).toBeUndefined();
  expect(state.requests[0].model).toBeUndefined();
  expect(state.requests[0].webOpenResult).toBeUndefined();
  expect(page.context().pages()).toHaveLength(1);
  await expect(
    page.getByRole("img", { name: "小序独立浏览器当前截图", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "浏览器任务：打开百度" }),
  ).toContainText("等待独立浏览器");
  state.tasks[0].status = "NEEDS_USER";
  state.tasks[0].stage = "请接管完成登录";
  await expect(
    page.locator(".assistant-browser-panel").getByRole("status"),
  ).toContainText("请接管完成登录", {
    timeout: 8000,
  });
  await page
    .getByRole("button", { name: "关闭浏览器面板", exact: true })
    .click();
  await composer.locator("textarea").fill("继续查找帮助");
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect(
    page.getByText(
      "已显示当前浏览器任务。指令已保留，请先继续或停止当前任务，无需重复发送。",
      { exact: true },
    ),
  ).toBeVisible();
  expect(state.requests).toHaveLength(1);
  await expect(composer.locator("textarea")).toHaveValue("继续查找帮助");
  await page.reload();
  await expect(
    page.locator(".assistant-compose:visible .assistant-execution-hint"),
  ).toContainText("小序独立浏览器");
  await expect(
    page.locator(".assistant-compose:visible [data-browser-task-id]"),
  ).toContainText("请接管完成登录");
  state.user = "8";
  state.tasks = [];
  await page.reload();
  await expect(
    page.locator(".assistant-compose:visible .assistant-execution-hint"),
  ).toContainText("网站内");
  expect(
    await page.evaluate(() => localStorage.getItem("xuti-assistant-desktop:8")),
  ).toBeNull();
});

test("浏览器截图接管绑定新画面，旧画面不重放，继续与清除会话使用真实控制接口", async ({
  page,
}) => {
  const { state, freshFrame } = await fixture(page);
  state.tasks = [makeTask()];
  await page.goto("/my-workspace?assistant=browser");
  const screen = page.getByRole("button", { name: "点击独立浏览器画面" });
  await expect(screen).toBeVisible();
  await expect(screen).toBeDisabled();
  await page.getByRole("button", { name: "暂停浏览器任务" }).click();
  await expect(screen).toBeEnabled();
  const oldFrame = state.frame!.frameId;
  await screen.scrollIntoViewIfNeeded();
  const bounds = await screen.locator("img").boundingBox();
  if (!bounds) throw Error("No browser screenshot");
  await page.mouse.click(
    bounds.x + bounds.width / 4,
    bounds.y + bounds.height / 2,
  );
  await expect.poll(() => state.actions.length).toBe(1);
  expect(state.actions[0]).toMatchObject({
    frameId: oldFrame,
    epoch: 3,
    action: { kind: "click" },
  });
  expect(Math.abs(state.actions[0].action.x - 250)).toBeLessThanOrEqual(2);
  expect(Math.abs(state.actions[0].action.y - 500)).toBeLessThanOrEqual(2);
  await expect(screen).toBeDisabled();
  freshFrame();
  await expect(screen).toBeEnabled({ timeout: 6000 });
  const input = page.getByLabel("向当前焦点输入文字", { exact: true });
  await input.fill("test-login-value");
  await page.getByRole("button", { name: "输入到浏览器", exact: true }).click();
  await expect.poll(() => state.actions.length).toBe(2);
  expect(state.actions[1].action).toEqual({
    kind: "type",
    text: "test-login-value",
  });
  await expect(input).toHaveValue("");
  freshFrame();
  await expect(screen).toBeEnabled({ timeout: 6000 });
  state.rejectAction = true;
  await page.getByRole("button", { name: "Tab 下一个", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "浏览器画面已变化" }),
  ).toBeVisible();
  await expect.poll(() => state.actions.length).toBe(3);
  state.rejectAction = false;
  await expect(screen).toBeEnabled();
  await page.screenshot({
    path: ".local/browser-takeover.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-workspace?assistant=browser");
  await expect(screen).toBeEnabled();
  await expect
    .poll(() =>
      page
        .locator(".assistant-browser-panel")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    )
    .toBe(true);
  await screen.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: ".local/browser-takeover-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "继续浏览器任务", exact: true })
    .click();
  await expect(screen).toBeDisabled();
  expect(state.controls).toEqual(["pause", "resume"]);
  expect(state.actions).toHaveLength(3);
  state.tasks[0].status = "DONE";
  state.tasks[0].stage = "已完成页面查看";
  state.frame = {
    ...state.frame!,
    readOnly: true,
    capturedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  await expect(page.getByLabel("最终画面只读", { exact: true })).toBeVisible({
    timeout: 8000,
  });
  await expect(screen).toBeDisabled();
  await expect(
    page.getByRole("img", { name: "小序独立浏览器当前截图" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("最终画面只读", { exact: true }),
  ).toHaveAttribute("title", /保留至/);
  await expect(
    page.getByLabel("向当前焦点输入文字", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "浏览器标签与会话菜单", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "清除浏览器登录状态", exact: true })
    .click();
  await page.getByRole("button", { name: "保留", exact: true }).click();
  expect(state.cleared).toBe(0);
  await expect(
    page.getByRole("img", { name: "小序独立浏览器当前截图", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "浏览器标签与会话菜单", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "清除浏览器登录状态", exact: true })
    .click();
  await page.getByRole("button", { name: "清除并停止", exact: true }).click();
  await expect.poll(() => state.cleared).toBe(1);
  await page
    .getByRole("button", { name: "浏览器标签与会话菜单", exact: true })
    .click();
  await expect(page.getByRole("menu")).toContainText("未保存网页登录状态");
  await expect(
    page.getByRole("menuitem", { name: /已停止 · 打开示例网站并查找帮助/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("img", { name: "小序独立浏览器当前截图" }),
  ).toHaveCount(0);
});

test("工作台三栏保留原场景与草稿，左右收起和调宽不提交操作", async ({
  page,
}) => {
  const { state } = await fixture(page);
  await page.goto("/my-workspace");
  const panel = page.locator(".assistant-browser-panel");
  const center = page.getByRole("region", { name: "工作台中栏" });
  const draft = center.locator(".assistant-compose:visible textarea");
  await expect(
    panel.getByRole("textbox", { name: "网址或网页任务" }),
  ).toBeVisible();
  await expect(center.locator(".personal-workspace")).toBeVisible();
  await expect(center.locator(".workspace-world-controls")).toBeVisible();
  await expect(center.locator(".workspace-date")).toHaveCount(0);
  await expect(
    center.getByRole("combobox", { name: "执行位置", exact: true }),
  ).toBeVisible();
  await expect(center.locator(".assistant-desktop-entry")).toHaveCount(0);
  await expect(
    page
      .locator(".workspace-right")
      .getByRole("combobox", { name: "执行位置" }),
  ).toHaveCount(0);
  await expect(center.locator(".assistant-execution-hint")).toContainText(
    "网站内",
  );
  await draft.fill("保留中栏工作台草稿");
  const centerBox = await center.boundingBox();
  const panelBox = await panel.boundingBox();
  expect(centerBox!.x + centerBox!.width).toBeLessThanOrEqual(panelBox!.x + 1);
  const separator = page.getByRole("separator", { name: "调整中栏与右栏宽度" });
  const handle = await separator.boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle!.x - 80, handle!.y + 100);
  await page.mouse.up();
  expect((await panel.boundingBox())!.width).toBeGreaterThan(
    panelBox!.width + 50,
  );
  await separator.focus();
  await separator.press("ArrowRight");
  const savedWidth = await separator.getAttribute("aria-valuenow");
  await page
    .getByRole("button", { name: "收起工作区导航", exact: true })
    .click();
  await page
    .getByRole("button", { name: "关闭浏览器面板", exact: true })
    .click();
  await expect(panel).toBeHidden();
  expect((await center.boundingBox())!.width).toBeGreaterThan(centerBox!.width);
  await expect(draft).toHaveValue("保留中栏工作台草稿");
  await page.getByRole("button", { name: "展开我的电脑", exact: true }).click();
  await expect(
    page.locator(".workspace-right .assistant-desktop-panel"),
  ).toBeVisible();
  await expect(center.locator(".assistant-execution-hint")).toContainText(
    "网站内",
  );
  await expect(draft).toHaveValue("保留中栏工作台草稿");
  await selectAssistantPanel(page, "独立浏览器");
  await expect(panel).toBeVisible();
  await selectAssistantPanel(page, "聊天");
  await expect(center.locator(".workspace-inline-chat")).toBeVisible();
  await expect(draft).toHaveValue("保留中栏工作台草稿");
  await expect(panel).toBeVisible();
  await page.screenshot({ path: ".local/workspace-columns-chat.png" });
  await page.getByRole("button", { name: "收起文字对话", exact: true }).click();
  await expect(draft).toHaveValue("保留中栏工作台草稿");
  await expect(center.locator(".personal-workspace")).toHaveAttribute(
    "data-scene-presence",
    "closed",
  );
  await page.screenshot({ path: ".local/workspace-columns-scene.png" });
  await page
    .getByRole("button", { name: "关闭浏览器面板", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "展开工作区导航", exact: true }),
  ).toBeVisible();
  await expect(panel).toBeHidden();
  await page
    .getByRole("button", { name: "展开独立浏览器", exact: true })
    .click();
  await expect(separator).toHaveAttribute("aria-valuenow", savedWidth!);
  expect(state.requests).toEqual([]);
  expect(state.browserRequests).toEqual([]);
  expect(state.controls).toEqual([]);
  expect(state.actions).toEqual([]);
  state.tasks = [
    makeTask(),
    {
      ...makeTask(),
      id: historyTaskId,
      title: "历史网页",
      instruction: "查看历史网页",
      status: "DONE",
    },
  ];
  await page.goto("/my-workspace?assistant=browser");
  await expect(panel.locator(".assistant-browser-tab")).toContainText(
    "示例网站",
  );
  await panel
    .getByRole("button", { name: "浏览器标签与会话菜单", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "已完成 · 查看历史网页", exact: true })
    .click();
  await expect(panel.locator(".assistant-browser-tab")).toContainText(
    "历史网页",
  );
  await panel.getByRole("button", { name: "新建浏览器任务" }).click();
  await expect(
    panel.getByRole("textbox", { name: "网址或网页任务" }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "查看当前任务" }).click();
  await expect(panel.locator(".assistant-browser-tab")).toContainText(
    "示例网站",
  );
  expect(state.browserRequests).toEqual([]);
  expect(state.controls).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`新任务入口在 ${width}px 校验网址、保留失败输入并提交独立浏览器任务`, async ({
    page,
  }) => {
    const { state } = await fixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/my-workspace?assistant=browser");
    const panel = page.locator(".assistant-browser-panel");
    const input = panel.getByRole("textbox", { name: "网址或网页任务" });
    const submit = panel.getByRole("button", { name: "开始浏览器任务" });
    await expect(input).toBeVisible();
    await expect(panel.getByRole("heading")).toHaveCount(0);
    await expect(panel.getByRole("combobox")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /刷新/ })).toHaveCount(1);
    await page.screenshot({ path: `.local/browser-minimal-new-${width}.png` });
    await input.fill("file:///C:/private");
    await input.press("Enter");
    await expect(panel.getByRole("alert")).toContainText("HTTP/HTTPS");
    expect(state.browserRequests).toHaveLength(0);
    await input.fill("example.com");
    state.createError = "服务刚刚离线，请稍后重试";
    await submit.click();
    await expect(panel.getByRole("alert")).toContainText("服务刚刚离线");
    await expect(input).toHaveValue("example.com");
    state.createError = "";
    await submit.click();
    await expect(
      panel.getByRole("img", { name: "小序独立浏览器当前截图", exact: true }),
    ).toBeVisible();
    expect(state.browserRequests).toHaveLength(2);
    expect(state.browserRequests[1]).toEqual({
      requestId: state.browserRequests[0].requestId,
      instruction: "打开 https://example.com，查看网页标题后完成任务。",
      url: "https://example.com",
    });
    expect(state.requests).toEqual([]);
    expect(state.actions).toEqual([]);
    await expect
      .poll(() =>
        panel.evaluate((element) => element.scrollWidth - element.clientWidth),
      )
      .toBeLessThanOrEqual(1);
    if (width === 390)
      await expect(page.locator(".workspace-center")).toBeHidden();
    await page.screenshot({ path: `.local/browser-created-${width}.png` });
    await panel
      .getByRole("button", { name: "关闭浏览器面板", exact: true })
      .click();
    await expect(
      page.locator(".assistant-compose:visible .assistant-execution-hint"),
    ).toContainText("小序独立浏览器");
    expect(state.controls).toEqual([]);
  });
}

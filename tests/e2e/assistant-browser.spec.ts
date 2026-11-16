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
  mode: "AGENT",
  epoch: 3,
  navigationState: "READY",
});
async function fixture(page: Page) {
  const state = {
    user: "7",
    ready: true,
    canBrowse: undefined as boolean | undefined,
    chatReady: true,
    tasks: [] as BrowserTask[],
    requests: [] as Record<string, unknown>[],
    browserRequests: [] as Record<string, unknown>[],
    navigations: [] as Record<string, any>[],
    autoAcknowledge: true,
    createError: "",
    controls: [] as string[],
    actions: [] as Record<string, any>[],
    rejectAction: false,
    frame: null as BrowserFrame | null,
    frames: {} as Record<string, BrowserFrame | null>,
    frameRequests: [] as string[],
    saved: true,
    cleared: 0,
    closed: 0,
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
  const freshFrame = (appliedRequestId?: string) => {
    state.frame = {
      frameId: crypto.randomUUID(),
      epoch: state.tasks[0]?.epoch ?? 3,
      width: state.frame?.width || 1000,
      height: state.frame?.height || 600,
      image: state.frame?.image || `data:image/svg+xml;base64,${screenshot}`,
      url: state.frame?.url || "https://example.com/login",
      title: "测试登录页",
      canGoBack: true,
      canGoForward: false,
      appliedRequestId,
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
        canBrowse: state.canBrowse ?? state.ready,
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
    else if (
      path === "/my-workspace/assistant/browser/tasks" ||
      path === "/my-workspace/assistant/browser/browse"
    ) {
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
        instruction: body.instruction || `浏览 ${body.url}`,
        url: body.url || "",
        status: body.instruction ? "QUEUED" : "PAUSED",
        mode: body.instruction ? "AGENT" : "BROWSE",
        viewport: body.viewport,
        stage: body.instruction ? "等待独立浏览器" : "可直接浏览网页",
      };
      state.tasks = [data as BrowserTask];
      if (!body.instruction) freshFrame();
    } else if (
      path === `/my-workspace/assistant/browser/tasks/${taskId}/navigation`
    ) {
      const body = request.postDataJSON();
      state.navigations.push(body);
      state.tasks[0].epoch = (state.tasks[0].epoch ?? 3) + 1;
      if (body.action.kind === "resize")
        state.tasks[0].viewport = body.action.viewport;
      if (body.action.kind === "goto") state.tasks[0].url = body.action.url;
      freshFrame(body.requestId);
      state.frame!.url = state.tasks[0].url;
      state.frame!.canGoBack = body.action.kind !== "back";
      state.frame!.canGoForward = body.action.kind === "back";
      const viewport = state.tasks[0].viewport;
      if (viewport) {
        state.frame!.width = viewport.width;
        state.frame!.height = viewport.height;
        const content = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewport.width}" height="${viewport.height}"><rect width="100%" height="100%" fill="#e9eef4"/><text x="30" y="80" font-size="20">Browser viewport ${viewport.width} x ${viewport.height}</text></svg>`;
        state.frame!.image = `data:image/svg+xml;base64,${Buffer.from(content).toString("base64")}`;
      }
      data = state.tasks[0];
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
      if (state.autoAcknowledge) freshFrame(request.postDataJSON().requestId);
    } else if (
      path === `/my-workspace/assistant/browser/tasks/${taskId}/close`
    ) {
      state.closed++;
      state.tasks[0].status = "DONE";
      state.frame = state.frame ? { ...state.frame, readOnly: true } : null;
      data = state.tasks[0];
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
    await expect(panel.getByLabel("网页地址", { exact: true })).toHaveValue(
      state.tasks[0].url,
    );
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
      panel.getByRole("button", { name: "刷新历史画面", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "打开新网址", exact: true }),
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
      .getByRole("button", { name: "刷新历史画面", exact: true })
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
    await expect(panel.getByLabel("网页地址", { exact: true })).toHaveValue(
      "https://example.com/history",
    );
    const reads = state.frameRequests.filter(
      (id) => id === historyTaskId,
    ).length;
    state.frames[historyTaskId] = {
      ...state.frames[historyTaskId]!,
      frameId: crypto.randomUUID(),
      url: "https://example.com/history-updated",
    };
    await panel
      .getByRole("button", { name: "刷新历史画面", exact: true })
      .click();
    await expect
      .poll(
        () => state.frameRequests.filter((id) => id === historyTaskId).length,
      )
      .toBeGreaterThan(reads);
    await expect(panel.getByLabel("网页地址", { exact: true })).toHaveValue(
      "https://example.com/history-updated",
    );
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
    page.getByRole("button", { name: "打开网址", exact: true }),
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
    page.locator(".assistant-browser-panel .assistant-browser-status-text"),
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
    page.locator(".assistant-compose:visible [aria-label='输入框菜单']"),
  ).toHaveAttribute("title", /小序独立浏览器/);
  await expect(
    page.locator(".assistant-compose:visible [data-browser-task-id]"),
  ).toContainText("请接管完成登录");
  state.user = "8";
  state.tasks = [];
  await page.reload();
  await expect(
    page.locator(".assistant-compose:visible [aria-label='输入框菜单']"),
  ).toHaveAttribute("title", /网站内/);
  expect(
    await page.evaluate(() => localStorage.getItem("xuti-assistant-desktop:8")),
  ).toBeNull();
});

test("网页内键盘、中文与粘贴串行等待执行回执，旧画面不重放，停止与清除独立生效", async ({
  page,
}) => {
  const { state, freshFrame } = await fixture(page);
  state.tasks = [makeTask()];
  await page.goto("/my-workspace?assistant=browser");
  const panel = page.locator(".assistant-browser-panel");
  const screen = panel.getByRole("button", { name: "点击独立浏览器画面" });
  await expect(screen).toBeDisabled();
  await page.getByRole("button", { name: "暂停浏览器任务" }).click();
  await expect(screen).toBeEnabled();
  await expect
    .poll(() => state.navigations.some((item) => item.action.kind === "resize"))
    .toBe(true);
  await expect(screen).toHaveAttribute("aria-busy", "false");
  state.autoAcknowledge = false;
  const oldFrame = state.frame!.frameId;
  const bounds = await screen.locator("img").boundingBox();
  if (!bounds) throw Error("No browser screenshot");
  await page.mouse.click(
    bounds.x + bounds.width / 4,
    bounds.y + bounds.height / 2,
  );
  await expect.poll(() => state.actions.length).toBe(1);
  await expect(screen).toBeDisabled();
  await expect(screen).toHaveCSS("cursor", "progress");
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  expect(state.actions).toHaveLength(1);
  expect(state.actions[0]).toMatchObject({
    frameId: oldFrame,
    action: { kind: "click" },
  });
  expect(Math.abs(state.actions[0].action.x - 250)).toBeLessThanOrEqual(2);
  expect(Math.abs(state.actions[0].action.y - 500)).toBeLessThanOrEqual(2);
  const keyboard = panel.getByLabel("网页键盘输入", { exact: true });
  await expect(keyboard).toBeFocused();
  await page.keyboard.insertText("queued-text");
  freshFrame(); // A different screenshot alone does not acknowledge the click.
  await expect(screen).toHaveAttribute("aria-busy", "true");
  await page.waitForTimeout(350);
  expect(state.actions).toHaveLength(1);
  freshFrame(state.actions[0].requestId);
  await expect.poll(() => state.actions.length).toBe(2);
  expect(state.actions[1].action).toEqual({
    kind: "type",
    text: "queued-text",
  });
  expect(state.actions[1].frameId).not.toBe(oldFrame);
  freshFrame(state.actions[1].requestId);
  await expect(screen).toHaveAttribute("aria-busy", "false");
  state.autoAcknowledge = true;
  await keyboard.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    input.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
    );
    input.value = "中文输入";
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "中文输入",
        isComposing: true,
      }),
    );
  });
  await page.waitForTimeout(150);
  expect(state.actions).toHaveLength(2);
  await keyboard.dispatchEvent("compositionend", { data: "中文输入" });
  await expect.poll(() => state.actions.length).toBe(3);
  expect(state.actions[2].action).toEqual({ kind: "type", text: "中文输入" });
  await expect(screen).toHaveAttribute("aria-busy", "false");
  await keyboard.evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "粘贴内容\n第二行");
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  });
  await expect.poll(() => state.actions.length).toBe(4);
  expect(state.actions[3].action).toEqual({
    kind: "type",
    text: "粘贴内容\n第二行",
  });
  await expect(screen).toHaveAttribute("aria-busy", "false");
  state.rejectAction = true;
  await keyboard.press("Tab");
  await expect(
    page
      .getByText("浏览器画面已变化，请刷新后重新操作", { exact: true })
      .first(),
  ).toBeVisible();
  await expect.poll(() => state.actions.length).toBe(5);
  state.rejectAction = false;
  await expect(screen).toHaveAttribute("aria-busy", "false");
  await page.waitForTimeout(200);
  expect(state.actions).toHaveLength(5);
  await screen.hover();
  await page.mouse.wheel(0, 360);
  await expect.poll(() => state.actions.length).toBe(6);
  expect(state.actions[5].action).toEqual({
    kind: "scroll",
    direction: "down",
    amount: 3,
  });
  await expect(screen).toHaveAttribute("aria-busy", "false");
  await expect(panel.locator(".assistant-browser-manual")).toHaveCount(0);
  state.autoAcknowledge = false;
  await keyboard.focus();
  await keyboard.press("ArrowRight");
  await expect.poll(() => state.actions.length).toBe(7);
  await page.keyboard.insertText("must-not-replay-after-reload");
  state.tasks[0].epoch!++;
  freshFrame(state.actions[6].requestId);
  await expect(
    page
      .getByText("网页已在其他操作中变化，请核对画面后继续", { exact: true })
      .first(),
  ).toBeVisible();
  await expect(screen).toHaveAttribute("aria-busy", "false");
  expect(state.actions).toHaveLength(7);
  await expect(panel.getByRole("button", { name: "Tab 下一个" })).toHaveCount(
    0,
  );
  await expect(
    page
      .getByText("浏览器画面已变化，请刷新后重新操作", { exact: true })
      .first(),
  ).toBeHidden();
  await expect(
    page
      .getByText("网页已在其他操作中变化，请核对画面后继续", { exact: true })
      .first(),
  ).toBeHidden();
  await page.screenshot({ path: ".local/browser-direct-input.png" });
  await page
    .getByRole("button", { name: "继续浏览器任务", exact: true })
    .click();
  await expect(screen).toBeDisabled();
  expect(state.controls).toEqual(["pause", "resume"]);
  await panel
    .getByRole("button", { name: "关闭浏览器面板", exact: true })
    .click();
  expect(state.controls).toEqual(["pause", "resume"]);
  await page
    .getByRole("button", { name: "展开独立浏览器", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "关闭当前网页", exact: true })
    .click();
  await expect.poll(() => state.closed).toBe(1);
  expect(state.controls).toEqual(["pause", "resume"]);
  await expect(panel.getByRole("textbox", { name: "网页地址" })).toHaveValue(
    "",
  );
  await panel.getByRole("button", { name: "浏览器标签与会话菜单" }).click();
  await page
    .getByRole("menuitem", { name: "清除浏览器登录状态", exact: true })
    .click();
  await page.getByRole("button", { name: "保留", exact: true }).click();
  expect(state.cleared).toBe(0);
  await panel.getByRole("button", { name: "浏览器标签与会话菜单" }).click();
  await page
    .getByRole("menuitem", { name: "清除浏览器登录状态", exact: true })
    .click();
  await page.getByRole("button", { name: "清除并停止", exact: true }).click();
  await expect.poll(() => state.cleared).toBe(1);
  expect(state.actions).toHaveLength(7);
});

test("工作台三栏保留原场景与草稿，左右收起和调宽不提交操作", async ({
  page,
}) => {
  const { state } = await fixture(page);
  await page.goto("/my-workspace");
  const panel = page.locator(".assistant-browser-panel");
  const center = page.getByRole("region", { name: "工作台中栏" });
  const draft = center.locator(".assistant-compose:visible textarea");
  await expect(panel.getByRole("textbox", { name: "网页地址" })).toBeVisible();
  await expect(center.locator(".personal-workspace")).toBeVisible();
  await expect(center.locator(".workspace-world-controls")).toBeVisible();
  await expect(center.locator(".workspace-date")).toHaveCount(0);
  await expect(
    center.getByRole("button", { name: "输入框菜单", exact: true }),
  ).toBeVisible();
  await expect(center.locator(".assistant-desktop-entry")).toHaveCount(0);
  await expect(
    page
      .locator(".workspace-right")
      .getByRole("combobox", { name: "执行位置" }),
  ).toHaveCount(0);
  await expect(center.locator("[aria-label='输入框菜单']")).toHaveAttribute(
    "title",
    /网站内/,
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
  await expect(center.locator("[aria-label='输入框菜单']")).toHaveAttribute(
    "title",
    /网站内/,
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
  await panel.getByRole("button", { name: "打开新网址" }).click();
  await expect(panel.getByRole("textbox", { name: "网页地址" })).toBeEnabled();
  await panel.getByRole("button", { name: "浏览器标签与会话菜单" }).click();
  await page
    .getByRole("menuitem", { name: /浏览器操作中 · 打开示例网站/ })
    .click();
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
    const input = panel.getByRole("textbox", { name: "网页地址" });
    const submit = panel.getByRole("button", { name: "打开网址" });
    await expect(input).toBeVisible();
    await expect(panel.getByRole("heading")).toHaveCount(0);
    await expect(panel.getByRole("combobox")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /刷新/ })).toHaveCount(1);
    await page.screenshot({ path: `.local/browser-minimal-new-${width}.png` });
    await input.fill("file:///C:/private");
    await input.press("Enter");
    await expect(
      page.getByText(/请填写不含账号密码的公开 HTTP\/HTTPS/).first(),
    ).toBeVisible();
    expect(state.browserRequests).toHaveLength(0);
    await input.fill("example.com");
    state.createError = "服务刚刚离线，请稍后重试";
    await submit.click();
    await expect(
      page.getByText("服务刚刚离线，请稍后重试", { exact: true }).first(),
    ).toBeVisible();
    await expect(input).toHaveValue("example.com");
    state.createError = "";
    await submit.click();
    await expect(
      panel.getByRole("img", { name: "小序独立浏览器当前截图", exact: true }),
    ).toBeVisible();
    expect(state.browserRequests).toHaveLength(2);
    expect(state.browserRequests[1]).toMatchObject({
      requestId: state.browserRequests[0].requestId,
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
      page.locator(".assistant-compose:visible [aria-label='输入框菜单']"),
    ).toHaveAttribute("title", /小序独立浏览器/);
    expect(state.controls).toEqual([]);
  });
}

test("直接浏览不依赖模型，真实导航和视口随面板变化，地址草稿不被轮询覆盖", async ({
  page,
}) => {
  const { state } = await fixture(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  state.ready = false;
  state.canBrowse = true;
  state.tasks = [
    {
      ...makeTask(),
      mode: "BROWSE",
      status: "PAUSED",
      automationStatus: "IDLE",
    },
  ];
  await page.goto("/my-workspace?assistant=browser");
  const panel = page.locator(".assistant-browser-panel");
  const address = panel.getByRole("textbox", { name: "网页地址" });
  const screen = panel.getByRole("button", { name: "点击独立浏览器画面" });
  await expect(address).toBeEnabled();
  await expect(panel.locator(".assistant-browser-status")).toHaveCount(0);
  await expect
    .poll(() => state.navigations.some((item) => item.action.kind === "resize"))
    .toBe(true);
  await expect(screen).toHaveAttribute("aria-busy", "false");
  const viewport = state.navigations.at(-1)!.action.viewport;
  const region = await panel.locator(".assistant-browser-page").boundingBox();
  expect(viewport.width).toBe(
    Math.max(320, Math.min(2560, Math.round(region!.width))),
  );
  expect(viewport.height).toBe(
    Math.max(240, Math.min(1600, Math.round(region!.height))),
  );
  const panelBounds = await panel.boundingBox();
  expect(region!.y + region!.height).toBeGreaterThan(
    panelBounds!.y + panelBounds!.height - 2,
  );
  await address.fill("https://example.org/new");
  state.frame!.url = "https://example.com/background";
  await page.waitForTimeout(1200);
  await expect(address).toHaveValue("https://example.org/new");
  await address.press("Enter");
  await expect
    .poll(
      () =>
        state.navigations.filter((item) => item.action.kind === "goto").length,
    )
    .toBe(1);
  expect(state.navigations.at(-1)!.action).toEqual({
    kind: "goto",
    url: "https://example.org/new",
  });
  await expect(screen).toHaveAttribute("aria-busy", "false");
  await panel.getByRole("button", { name: "后退", exact: true }).click();
  await expect(screen).toHaveAttribute("aria-busy", "false");
  await expect(
    panel.getByRole("button", { name: "后退", exact: true }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "前进", exact: true }).click();
  await expect(screen).toHaveAttribute("aria-busy", "false");
  await panel.getByRole("button", { name: "刷新网页", exact: true }).click();
  await expect(screen).toHaveAttribute("aria-busy", "false");
  expect(
    state.navigations
      .filter((item) => item.action.kind !== "resize")
      .map((item) => item.action.kind),
  ).toEqual(["goto", "back", "forward", "reload"]);
  expect(state.browserRequests).toEqual([]);
  expect(state.requests).toEqual([]);
  expect(state.controls).toEqual([]);
  const originalWidth = (await panel.boundingBox())!.width;
  await panel.getByRole("button", { name: "全屏查看", exact: true }).click();
  await expect(panel).toHaveAttribute("data-browser-fullscreen", "true");
  await expect
    .poll(() =>
      panel.evaluate((element) => document.fullscreenElement === element),
    )
    .toBe(true);
  await expect
    .poll(async () => (await panel.boundingBox())!.width)
    .toBeGreaterThan(originalWidth + 200);
  await expect
    .poll(() => state.navigations.at(-1)!.action.viewport?.width)
    .toBe(1920);
  await expect(screen).toHaveAttribute("aria-busy", "false");
  await page.screenshot({ path: ".local/browser-fullscreen.png" });
  await panel
    .getByRole("button", { name: "浏览器标签与会话菜单", exact: true })
    .click();
  await expect(panel.locator(".assistant-browser-menu")).toBeVisible();
  await expect(panel.locator(".assistant-browser-menu")).toBeInViewport();
  await panel
    .getByRole("menuitem", { name: "清除浏览器登录状态", exact: true })
    .click();
  await expect(panel).toHaveAttribute("data-browser-fullscreen", "false");
  await expect(
    page.getByRole("button", { name: "清除并停止", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保留", exact: true }).click();
  expect(state.cleared).toBe(0);
  await expect
    .poll(async () =>
      Math.abs((await panel.boundingBox())!.width - originalWidth),
    )
    .toBeLessThan(2);
  await expect
    .poll(() => state.navigations.at(-1)!.action.viewport?.width)
    .toBeLessThan(originalWidth + 2);
  await expect(screen).toHaveAttribute("aria-busy", "false");
  await panel.evaluate((element) =>
    Object.defineProperty(element, "requestFullscreen", {
      value: undefined,
      configurable: true,
    }),
  );
  await panel.getByRole("button", { name: "全屏查看", exact: true }).click();
  await expect(panel).toHaveClass(/assistant-browser-page-fullscreen/);
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(1920);
  await expect
    .poll(() => state.navigations.at(-1)!.action.viewport?.width)
    .toBe(1920);
  await expect(screen).toHaveAttribute("aria-busy", "false");
  await panel.getByLabel("网页键盘输入", { exact: true }).focus();
  const actionsBeforeEscape = state.actions.length;
  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("data-browser-fullscreen", "false");
  expect(state.actions).toHaveLength(actionsBeforeEscape);
  state.tasks[0].mode = "AGENT";
  state.tasks[0].status = "RUNNING";
  state.tasks[0].automationStatus = "RUNNING";
  await expect(
    panel.getByRole("button", { name: "暂停浏览器任务", exact: true }),
  ).toBeVisible({ timeout: 8000 });
  await expect
    .poll(() => state.navigations.at(-1)!.action.viewport?.width)
    .toBeLessThan(originalWidth + 2);
  await expect(screen).toHaveAttribute("aria-busy", "false");
  const beforeAgentFullscreen = state.navigations.length;
  await panel.getByRole("button", { name: "全屏查看", exact: true }).click();
  await expect
    .poll(() => state.navigations.length)
    .toBeGreaterThan(beforeAgentFullscreen);
  await expect
    .poll(() => state.navigations.at(-1)!.action.viewport?.width)
    .toBe(1920);
  await expect(screen).toHaveAttribute("aria-busy", "false");
  expect(state.tasks[0]).toMatchObject({
    mode: "AGENT",
    status: "RUNNING",
    automationStatus: "RUNNING",
  });
  expect(state.controls).toEqual([]);
  expect(state.actions).toEqual([]);
  await panel.getByRole("button", { name: "退出全屏", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => state.navigations.at(-1)!.action.viewport?.width)
    .toBeLessThan(500);
  await expect(screen).toHaveAttribute("aria-busy", "false");
  await expect
    .poll(() =>
      panel.evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeLessThanOrEqual(1);
  await expect(
    panel.getByRole("button", { name: "后退", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: ".local/browser-direct-mobile.png" });
});

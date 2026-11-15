import { expect, test, type Page } from "@playwright/test";
import type {
  BrowserFrame,
  BrowserState,
  BrowserTask,
} from "../../packages/contracts/src/assistant-browser.js";
import { selectAssistantPanel } from "./assistant-controls.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const frameId = "22222222-2222-4222-8222-222222222222";
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
    controls: [] as string[],
    actions: [] as Record<string, any>[],
    rejectAction: false,
    frame: null as BrowserFrame | null,
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
    else if (path === `/my-workspace/assistant/browser/tasks/${taskId}/frame`)
      data = state.frame;
    else if (
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
  const composer = page.locator(".assistant-compose:visible");
  await composer.getByRole("combobox", { name: "执行位置" }).click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("小序独立浏览器", { exact: true })
    .click();
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
    page.getByRole("heading", { name: "小序独立浏览器" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("dialog", { name: "AI 个人助理" })
      .getByText("独立浏览器执行服务尚未连接", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "使用小序独立浏览器", exact: true }),
  ).toBeDisabled();
  await selectAssistantPanel(page, "聊天");
  await expect(composer.locator("textarea")).toHaveValue(
    "保留这个网页任务草稿",
  );
  await expect(composer.locator("textarea")).toBeDisabled();
  expect(state.requests).toEqual([]);
  await composer.getByRole("button", { name: "返回网站对话" }).click();
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
    composer.getByRole("region", { name: "浏览器任务：打开百度" }),
  ).toContainText("等待独立浏览器");
  state.tasks[0].status = "NEEDS_USER";
  state.tasks[0].stage = "请接管完成登录";
  await expect(composer.getByRole("status")).toContainText("请接管完成登录", {
    timeout: 8000,
  });
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
    page.locator(".assistant-compose:visible .assistant-desktop-note"),
  ).toContainText("小序独立浏览器");
  await expect(
    page.locator(".assistant-compose:visible [data-browser-task-id]"),
  ).toContainText("请接管完成登录");
  state.user = "8";
  state.tasks = [];
  await page.reload();
  await expect(
    page.locator(".assistant-compose:visible .assistant-desktop-note"),
  ).toHaveCount(0);
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
  await page
    .getByRole("button", { name: "清除浏览器登录状态", exact: true })
    .click();
  await page.getByRole("button", { name: "保留", exact: true }).click();
  expect(state.cleared).toBe(0);
  await page
    .getByRole("button", { name: "清除浏览器登录状态", exact: true })
    .click();
  await page.getByRole("button", { name: "清除并停止", exact: true }).click();
  await expect.poll(() => state.cleared).toBe(1);
  await expect(
    page.getByText("尚未保存网页登录状态；需要时可在画面中自行登录。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("[data-browser-task-id]")).toContainText("已停止");
  await expect(
    page.getByRole("img", { name: "小序独立浏览器当前截图" }),
  ).toHaveCount(0);
});

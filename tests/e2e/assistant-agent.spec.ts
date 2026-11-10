import {
  openCompanionMenu,
  openPersonalAssistant,
  selectAssistantPanel,
} from "./assistant-controls.js";
import { expect, test, type Page } from "@playwright/test";
const fileId = "11111111-1111-4111-8111-111111111111";
const resultId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const previewId = "44444444-4444-4444-8444-444444444444";
async function setup(
  page: Page,
  mode = "dark",
  lookup?: { wait?: Promise<void>; ambiguous?: boolean },
) {
  const requests: Record<string, any>[] = [];
  const file = {
    id: fileId,
    name: "资料.txt",
    mime: "text/plain",
    size: 30,
    source: "upload",
    createdAt: new Date().toISOString(),
  };
  const result = {
    ...file,
    id: resultId,
    name: "周报.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    source: "generated",
  };
  const preview = {
    ...file,
    id: previewId,
    name: "预览图.png",
    mime: "image/png",
    source: "generated",
  };
  const assistant = {
    ready: true,
    availabilityMessage: "小序已就绪",
    state: "IDLE",
    version: 0,
    error: "",
    messages: [
      {
        id: "old",
        role: "assistant",
        text: "可以使用 GPT 语音。服务是 OpenRouter 和 DeepSeek。",
        responseModel: "openai/gpt-6.1-sol",
        createdAt: new Date().toISOString(),
      },
    ] as Record<string, any>[],
  };
  let uploaded = false,
    done = false;
  await page.context().route("**/api/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (path === "/auth/me")
      data = {
        id: "7",
        username: "test",
        displayName: "测试用户",
        roleCodes: [],
        permissions: ["analytics.manage", "analytics.read"],
        csrfToken: "fixture",
      };
    else if (path === "/my-workspace/appearance") data = { mode, version: 1 };
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
    else if (path === "/my-workspace/activity")
      data = { items: [], serverTime: new Date().toISOString() };
    else if (path === "/my-workspace/assistant/memory")
      data = { version: 0, entries: [] };
    else if (path === "/my-workspace/assistant/desktop")
      data = { devices: [], tasks: [] };
    else if (path === "/my-workspace/assistant/voice")
      data = {
        ready: false,
        enabled: false,
        canManage: false,
        model: "小序语音",
        message: "语音尚未启用",
      };
    else if (path === "/my-workspace/assistant/capabilities")
      data = {
        defaultModel: "engine/default",
        models: [
          {
            id: "engine/default",
            name: "通用助手",
            displayName: "GPT-6.1 Sol",
            vision: true,
          },
          {
            id: "engine/vision",
            name: "深度思考",
            displayName: "Gemini 2.5 Pro",
            vision: true,
          },
          {
            id: "engine/text-only",
            name: "纯文本旧型号",
            displayName: "Text Only",
            vision: false,
          },
        ],
        imageModels: [
          { id: "engine/image", name: "图像创作", reference: true },
        ],
      };
    else if (path === "/my-workspace/assistant/files") {
      if (request.method() === "POST") {
        expect(request.headers()["content-type"]).toContain(
          "multipart/form-data",
        );
        uploaded = true;
        data = file;
      } else data = uploaded ? [file, ...(done ? [result, preview] : [])] : [];
    } else if (path === "/my-workspace/assistant/jobs")
      data = done
        ? [
            {
              id: jobId,
              requestId: requests[0].requestId,
              kind: "document",
              title: "周报",
              status: "DONE",
              stage: "已完成",
              progress: 100,
              error: "",
              files: [result, preview],
            },
          ]
        : [];
    else if (path === "/my-workspace/assistant") {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        requests.push(body);
        if (body.webOpenResult) {
          const resolving = body.message === "打开示例文库";
          const title = resolving
            ? "示例文库"
            : body.message === "打开腾讯网"
              ? "腾讯网"
              : "百度";
          const url = resolving
            ? "https://docs.example.com/"
            : title === "腾讯网"
              ? "https://www.qq.com/"
              : "https://www.baidu.com/";
          assistant.version++;
          assistant.messages.push({
            id: body.requestId,
            role: "user",
            text: body.message,
          });
          if (resolving) {
            assistant.state = "PENDING";
            await lookup?.wait;
            assistant.state = "IDLE";
          }
          assistant.messages.push({
            id: `reply-${body.requestId}`,
            role: "assistant",
            text: lookup?.ambiguous
              ? "暂时不能唯一确认网站，请补充完整网站或品牌名称。"
              : body.webOpenResult === "blocked"
                ? `浏览器阻止了新窗口，请点击下方“打开${title}”继续。`
                : resolving
                  ? `已找到${title}，正在刚才的新窗口中打开。`
                  : `已在新标签页打开${title}，当前对话保留。`,
            ...(lookup?.ambiguous ? {} : { webNavigation: { title, url } }),
          });
          await route.fulfill({ json: { data: assistant } });
          return;
        }
        done = true;
        assistant.version++;
        assistant.messages.push(
          {
            id: body.requestId,
            role: "user",
            text: body.message,
            attachments: [file],
          },
          {
            id: "reply",
            role: "assistant",
            text: "已提交整理任务，结果显示在任务卡片。",
            jobIds: [jobId],
            schedules: [],
            tools: [],
            citations: [
              { url: "https://example.com/report", title: "资料来源" },
            ],
          },
        );
      }
      data = assistant;
    } else if (path === `/my-workspace/assistant/files/${previewId}/content`) {
      await route.fulfill({
        path: "tests/fixtures/selection-care-label.png",
        contentType: "image/png",
      });
      return;
    } else if (path.endsWith("/content")) {
      await route.fulfill({
        body: "fixture file",
        contentType: "application/octet-stream",
      });
      return;
    }
    await route.fulfill({ json: { data } });
  });
  return requests;
}
test("模型菜单只显示多模态型号、发送所选模型并在重开对话后保留", async ({
  page,
}) => {
  const requests = await setup(page);
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  await expect(
    composer.getByRole("button", { name: "选择对话模型" }),
  ).toContainText("GPT-6.1 Sol");
  await composer.getByRole("button", { name: "选择对话模型" }).click();
  await expect(page.getByRole("menuitem", { name: /Text Only/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("menuitem", { name: /Gemini 2.5 Pro/ }),
  ).toContainText("多模态");
  await page.getByRole("menuitem", { name: /Gemini 2.5 Pro/ }).click();
  await expect(
    composer.getByRole("button", { name: "选择对话模型" }),
  ).toContainText("Gemini 2.5 Pro");
  expect(requests).toHaveLength(0);
  await openPersonalAssistant(page);
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(
    dialog.getByRole("button", { name: "选择对话模型" }),
  ).toContainText("Gemini 2.5 Pro");
  await dialog.getByPlaceholder(/告诉我你想完成什么/).fill("整理两条建议");
  await dialog.getByRole("button", { name: "发送给个人助理" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].model).toBe("engine/vision");
  expect(requests[0]).not.toHaveProperty("webSearch");
});

for (const disconnected of [false, true]) {
  test(`选中模型${disconnected ? "未接通" : "失去多模态能力"}后自动改用已接通模型并保留草稿`, async ({
    page,
  }) => {
    const requests = await setup(page);
    await page.goto("/my-workspace");
    const composer = page.locator(".assistant-compose:visible");
    await composer.getByRole("button", { name: "选择对话模型" }).click();
    await page.getByRole("menuitem", { name: /Gemini 2.5 Pro/ }).click();
    await composer.getByPlaceholder(/告诉我你想完成什么/).fill("保留我的草稿");
    await page.route("**/api/v1/my-workspace/assistant/capabilities", (route) =>
      route.fulfill({
        json: {
          data: {
            defaultModel: "engine/default",
            models: [
              {
                id: "engine/default",
                name: "通用助手",
                displayName: "GPT-6.1 Sol",
                vision: true,
              },
              ...(!disconnected
                ? [
                    {
                      id: "engine/vision",
                      name: "深度思考",
                      displayName: "Gemini 2.5 Pro",
                      vision: false,
                    },
                  ]
                : []),
            ],
            imageModels: [],
            notice: "",
          },
        },
      }),
    );
    await composer.getByRole("button", { name: "选择对话模型" }).click();
    await page.getByRole("menuitem", { name: "刷新模型列表" }).click();
    await expect(composer.getByRole("status")).toContainText("已自动切换到");
    await expect(
      composer.getByRole("button", { name: "选择对话模型" }),
    ).toContainText("GPT-6.1 Sol");
    await expect(
      composer.getByRole("button", { name: "发送给个人助理" }),
    ).toBeEnabled();
    await expect(composer.locator("textarea")).toHaveValue("保留我的草稿");
    expect(requests).toHaveLength(0);
    await composer.getByRole("button", { name: "选择对话模型" }).click();
    await expect(
      page.getByRole("menuitem", { name: /Gemini 2.5 Pro/ }),
    ).toHaveCount(0);
  });
}

for (const missingModels of [false, true]) {
  test(`没有已接通模型时菜单显示空状态并保留草稿${missingModels ? "（兼容旧响应）" : ""}`, async ({
    page,
  }) => {
    const requests = await setup(page);
    await page.goto("/my-workspace");
    const composer = page.locator(".assistant-compose:visible");
    await composer
      .getByPlaceholder(/告诉我你想完成什么/)
      .fill("等待连接后继续");
    await page.route("**/api/v1/my-workspace/assistant/capabilities", (route) =>
      route.fulfill({
        json: {
          data: {
            defaultModel: "engine/default",
            ...(missingModels ? {} : { models: [] }),
            imageModels: [],
            notice: "暂无已接通模型",
          },
        },
      }),
    );
    await composer.getByRole("button", { name: "选择对话模型" }).click();
    await page.getByRole("menuitem", { name: "刷新模型列表" }).click();
    await expect(composer.getByRole("alert")).toContainText("暂无已接通");
    await expect(
      composer.getByRole("button", { name: "发送给个人助理" }),
    ).toBeDisabled();
    await composer.getByRole("button", { name: "选择对话模型" }).click();
    await expect(
      page.getByRole("menuitem", { name: "暂无已接通模型" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: /GPT-6.1 Sol|Gemini 2.5 Pro/ }),
    ).toHaveCount(0);
    await expect(composer.locator("textarea")).toHaveValue("等待连接后继续");
    expect(requests).toHaveLength(0);
  });
}

test("简洁输入区直接发送附件并下载任务结果，历史回复隐藏型号", async ({
  page,
}) => {
  const requests = await setup(page);
  await page.goto("/my-workspace");
  const noteEntry = page.getByRole("button", {
    name: "打开私有备忘",
    exact: true,
  });
  await noteEntry.focus();
  await noteEntry.press("Enter");
  await page
    .getByRole("textbox", { name: "私有备忘", exact: true })
    .fill("同页投影保留未保存备忘");
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await openPersonalAssistant(page);
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".assistant-messages")).not.toContainText(
    /GPT|OpenRouter|DeepSeek|openai\//i,
  );
  await dialog.getByLabel("上传助理附件").setInputFiles({
    name: "资料.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("测试库存：条码001234567890123456789 数量12"),
  });
  await expect(dialog.locator(".agent-attachments")).toContainText("资料.txt");
  await expect(dialog.locator(".agent-composer-tools button")).toHaveCount(4);
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await dialog
    .getByPlaceholder(/告诉我你想完成什么/)
    .fill("将附件整理成Word周报");
  await dialog.getByRole("button", { name: "发送给个人助理" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({
    attachmentIds: [fileId],
  });
  expect(requests[0]).not.toHaveProperty("model");
  expect(requests[0]).not.toHaveProperty("webSearch");
  await expect(dialog.getByRole("link", { name: /周报.docx/ })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "资料来源" })).toHaveAttribute(
    "href",
    "https://example.com/report",
  );
  await selectAssistantPanel(page, "任务与文件");
  await expect(dialog.getByRole("heading", { name: "我的文件" })).toBeVisible();
  await expect(dialog).toContainText("已完成");
  await page.screenshot({ path: ".local/assistant-agent-dark.png" });
  const currentUrl = page.url();
  await dialog
    .locator(".agent-job")
    .getByRole("button", { name: "在全息屏展示" })
    .click();
  const screen = page.getByRole("dialog", { name: "全息影像屏", exact: true });
  await expect(screen).toBeVisible();
  await expect(dialog).toBeHidden();
  expect(page.url()).toBe(currentUrl);
  await expect(
    screen.getByRole("img", { name: "预览图.png", exact: true }),
  ).toHaveAttribute(
    "src",
    `/api/v1/my-workspace/assistant/files/${previewId}/content`,
  );
  await screen
    .getByRole("button", { name: "关闭全息影像屏", exact: true })
    .click();
  await expect(screen).toBeHidden();
  await expect(page.locator(".workspace-ai-core-stage")).not.toHaveAttribute(
    "inert",
  );
  await noteEntry.focus();
  await noteEntry.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "私有备忘", exact: true }),
  ).toHaveValue("同页投影保留未保存备忘");
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await openPersonalAssistant(page);
  const draft = "跨页全息预览后继续编辑的草稿";
  await dialog.getByPlaceholder(/告诉我你想完成什么/).fill(draft);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "运营中心", exact: true })
    .click();
  await expect(page).toHaveURL(/operations$/);
  await openCompanionMenu(page);
  await page.getByRole("button", { name: "文字对话", exact: true }).click();
  await selectAssistantPanel(page, "任务与文件");
  await dialog
    .locator(".agent-job")
    .getByRole("button", { name: "在全息屏展示" })
    .click();
  await expect(page).toHaveURL(/my-workspace$/);
  await expect(screen).toBeVisible();
  await expect(
    page.locator(".personal-assistant-drawer .ant-drawer-content-wrapper"),
  ).toBeHidden();
  await expect(
    screen.getByRole("img", { name: "预览图.png", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: ".local/workspace-hologram-assistant-file.png",
  });
  await screen
    .getByRole("button", { name: "关闭全息影像屏", exact: true })
    .click();
  await openPersonalAssistant(page);
  await expect(dialog.getByPlaceholder(/告诉我你想完成什么/)).toHaveValue(
    draft,
  );
  expect(requests).toHaveLength(1);
});
test("窄屏模型听写语音布局不溢出，输入后原位切换发送", async ({ page }) => {
  await setup(page, "light");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-workspace?assistant=tasks");
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(dialog).toBeVisible();
  await selectAssistantPanel(page, "聊天");
  await expect(
    dialog.getByRole("button", { name: "附件", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "选择对话模型" }),
  ).toContainText("GPT-6.1 Sol");
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.width).toBeLessThanOrEqual(390);
  const sender = dialog.locator(".ant-sender");
  await expect(sender.locator("button")).toHaveCount(4);
  const send = sender.getByRole("button", { name: "发送给个人助理" });
  await expect(
    sender.getByRole("button", { name: "开始语音对话", exact: true }),
  ).toBeVisible();
  await expect(send).toHaveCount(0);
  await dialog.getByPlaceholder(/告诉我你想完成什么/).fill("直接输入");
  await expect(send).toBeEnabled();
  await dialog.getByPlaceholder(/告诉我你想完成什么/).clear();
  await expect(
    sender.getByRole("button", { name: "开始语音对话", exact: true }),
  ).toBeVisible();
  await expect(send).toHaveCount(0);
  expect(
    await sender.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({ path: ".local/assistant-agent-light-mobile.png" });
});

test("桌面端从电脑操作面板一次连接并唤起本机确认，自动选中电脑", async ({
  page,
}) => {
  await setup(page);
  const deviceId = "55555555-5555-4555-8555-555555555555";
  await page.addInitScript(
    ({ deviceId }) => {
      let connected = false,
        authorized = false;
      const events = new EventTarget();
      const actions: string[] = [];
      Object.defineProperty(window, "xutiDesktop", {
        value: { version: "1.2.1" },
      });
      Object.assign(window.chrome || (window.chrome = {}), {
        webview: {
          addEventListener: events.addEventListener.bind(events),
          removeEventListener: events.removeEventListener.bind(events),
          postMessage(request: {
            action: string;
            id: string;
            deviceId?: string;
          }) {
            actions.push(request.action);
            if (request.action === "pair") connected = true;
            if (
              request.action === "authorize" &&
              connected &&
              request.deviceId === deviceId
            )
              authorized = true;
            queueMicrotask(() =>
              events.dispatchEvent(
                new MessageEvent("message", {
                  data: {
                    channel: "xuti-desktop",
                    id: request.id,
                    ok: true,
                    data: {
                      version: "1.2.1",
                      connected,
                      deviceId: connected ? deviceId : "",
                      authorized,
                    },
                  },
                }),
              ),
            );
          },
        },
      });
      Object.assign(window, {
        desktopTestState: () => ({ connected, authorized, actions }),
      });
    },
    { deviceId },
  );
  let pairCodes = 0;
  await page.route(
    "**/api/v1/my-workspace/assistant/desktop**",
    async (route) => {
      if (route.request().method() === "POST") {
        expect(route.request().url()).toContain("/pair-code");
        pairCodes++;
        await route.fulfill({ json: { data: { code: "a".repeat(32) } } });
        return;
      }
      const state = await page.evaluate(() =>
        (window as any).desktopTestState(),
      );
      await route.fulfill({
        json: {
          data: {
            devices: state.connected
              ? [
                  {
                    id: deviceId,
                    name: "本机测试电脑",
                    online: true,
                    crossWindowAuthorized: state.authorized,
                    lastSeenAt: new Date().toISOString(),
                  },
                ]
              : [],
            tasks: [],
          },
        },
      });
    },
  );
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  await openPersonalAssistant(page);
  await selectAssistantPanel(page, "电脑操作");
  await page
    .getByRole("button", { name: "连接并授权本机", exact: true })
    .click();
  await expect(composer.locator(".assistant-desktop-note")).toContainText(
    "电脑操作",
  );
  await expect(composer.getByPlaceholder(/描述电脑任务/)).toBeVisible();
  expect(pairCodes).toBe(1);
  const state = await page.evaluate(() => (window as any).desktopTestState());
  expect(state.actions.filter((a: string) => a === "pair")).toHaveLength(1);
  expect(state.actions.filter((a: string) => a === "authorize")).toHaveLength(
    1,
  );
  expect(state.actions).not.toContain("show-tasks");
  await selectAssistantPanel(page, "电脑操作");
  await expect(
    page.getByRole("button", { name: "撤销跨窗口授权", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "连接并授权本机", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: ".local/desktop-simple-authorization.png" });
});

test("电脑操作面板选择设备并撤销授权，输入区仅显示当前目标", async ({
  page,
}) => {
  const requests = await setup(page);
  const desktopId = "55555555-5555-4555-8555-555555555555";
  let granted = true;
  const mutations: string[] = [];
  await page.route(
    "**/api/v1/my-workspace/assistant/desktop**",
    async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        mutations.push(new URL(request.url()).pathname);
        expect(request.url()).toContain(
          `/devices/${desktopId}/authorization/revoke`,
        );
        granted = false;
        await route.fulfill({ json: { data: { revoked: true } } });
        return;
      }
      await route.fulfill({
        json: {
          data: {
            devices: [
              {
                id: desktopId,
                name: "测试电脑",
                online: true,
                crossWindowAuthorized: granted,
                lastSeenAt: new Date().toISOString(),
                expiresAt: "2026-12-01T00:00:00Z",
              },
              {
                id: "66666666-6666-4666-8666-666666666666",
                name: "离线电脑",
                online: false,
                crossWindowAuthorized: false,
                lastSeenAt: null,
                expiresAt: "2026-12-01T00:00:00Z",
              },
            ],
            tasks: [],
          },
        },
      });
    },
  );
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  await expect(
    composer.getByRole("button", { name: "附件", exact: true }),
  ).toBeVisible();
  await expect(composer.locator(".agent-composer-tools button")).toHaveCount(4);
  await page.screenshot({ path: ".local/assistant-composer-home.png" });
  await openPersonalAssistant(page);
  await selectAssistantPanel(page, "电脑操作");
  const device = page
    .locator(".assistant-desktop-item")
    .filter({ hasText: "测试电脑" });
  const offline = page
    .locator(".assistant-desktop-item")
    .filter({ hasText: "离线电脑" });
  await expect(
    offline.getByRole("button", { name: "在这台电脑执行" }),
  ).toBeDisabled();
  await expect(device).toContainText("已记住跨窗口授权");
  expect(mutations).toHaveLength(0);
  await page.screenshot({
    path: ".local/assistant-composer-authorization.png",
  });
  await page
    .getByRole("button", { name: "撤销跨窗口授权", exact: true })
    .click();
  await expect(device).toContainText("逐次允许");
  await device.getByRole("button", { name: "在这台电脑执行" }).click();
  await expect(composer.locator(".assistant-desktop-note")).toContainText(
    "测试电脑",
  );
  expect(mutations).toHaveLength(1);
  const input = composer.getByPlaceholder(/描述电脑任务/);
  await input.fill("打开百度");
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].desktopDeviceId).toBe(desktopId);
  expect(requests[0]).not.toHaveProperty("authorizationId");
  expect(requests[0]).not.toHaveProperty("webOpenResult");
  expect(page.context().pages()).toHaveLength(1);
  await composer.getByRole("button", { name: "返回网站对话" }).click();
  await expect(composer.getByPlaceholder(/告诉我你想完成什么/)).toBeVisible();
});

test("发送打开百度立即新建网页，保留工作台，查看历史不会重复打开", async ({
  page,
  context,
}) => {
  const requests = await setup(page);
  await context.route("https://www.baidu.com/**", (route) =>
    route.fulfill({ body: "百度测试页", contentType: "text/html" }),
  );
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  await composer.getByPlaceholder(/告诉我你想完成什么/).fill("打开百度");
  const opened = context.waitForEvent("page");
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  const target = await opened;
  await expect(target).toHaveURL("https://www.baidu.com/");
  expect(await target.evaluate(() => window.opener)).toBeNull();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].webOpenResult).toBe("opened");
  await expect(page).toHaveURL(/\/my-workspace$/);
  await expect(
    page.getByText("已在新标签页打开百度，当前对话保留。", { exact: true }),
  ).toBeVisible();
  await target.close();
  await page.bringToFront();
  await page.reload();
  await openPersonalAssistant(page);
  await expect(page.getByRole("link", { name: "打开百度" })).toBeVisible();
  expect(context.pages()).toHaveLength(1);
});

test("回车发送时提示弹窗拦截，并提供可直接点击的打开网页入口", async ({
  page,
  context,
}) => {
  const requests = await setup(page);
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await context.route("https://www.baidu.com/**", (route) =>
    route.fulfill({ body: "百度测试页", contentType: "text/html" }),
  );
  await page.goto("/my-workspace");
  const input = page
    .locator(".assistant-compose:visible")
    .getByPlaceholder(/告诉我你想完成什么/);
  await input.fill("打开百度");
  await input.press("Enter");
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].webOpenResult).toBe("blocked");
  await expect(
    page.getByText("浏览器阻止了新窗口，请点击下方“打开百度”继续。", {
      exact: true,
    }),
  ).toBeVisible();
  expect(context.pages()).toHaveLength(1);
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "打开百度" }).click();
  await expect(await opened).toHaveURL("https://www.baidu.com/");
  expect(requests).toHaveLength(1);
});

test("直接发送打开腾讯网即可进入，不要求再次发送网址", async ({
  page,
  context,
}) => {
  const requests = await setup(page);
  await context.route("https://www.qq.com/**", (route) =>
    route.fulfill({ body: "腾讯网测试页", contentType: "text/html" }),
  );
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  await composer.getByPlaceholder(/告诉我你想完成什么/).fill("打开腾讯网");
  const opened = context.waitForEvent("page");
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  const target = await opened;
  await expect(target).toHaveURL("https://www.qq.com/");
  await expect(page.getByRole("link", { name: "打开腾讯网" })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0].message).toBe("打开腾讯网");
});

test("未知网站名称先开等待页，查询完成后在同一窗口自动进入官网", async ({
  page,
  context,
}) => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests = await setup(page, "dark", { wait });
  await context.route("https://docs.example.com/**", (route) =>
    route.fulfill({ body: "示例文库官网", contentType: "text/html" }),
  );
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  await composer.getByPlaceholder(/告诉我你想完成什么/).fill("打开示例文库");
  const opened = context.waitForEvent("page");
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  const target = await opened;
  try {
    await expect(target).toHaveURL(/\/assistant\/open-website\?requestId=/);
    await expect(target.getByRole("status")).toContainText("正在查找网站");
    expect(requests[0].webOpenResult).toBe("pending");
    expect(await target.evaluate(() => window.opener)).toBeNull();
  } finally {
    release();
  }
  await expect(target).toHaveURL("https://docs.example.com/");
  expect(context.pages()).toHaveLength(2);
  expect(requests).toHaveLength(1);
});

test("名称有歧义时等待页说明原因，不跳转到猜测的网址", async ({
  page,
  context,
}) => {
  await setup(page, "dark", { ambiguous: true });
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  await composer.getByPlaceholder(/告诉我你想完成什么/).fill("打开示例文库");
  const opened = context.waitForEvent("page");
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  const target = await opened;
  await expect(target.getByRole("status")).toContainText(
    "补充完整网站或品牌名称",
  );
  await expect(target).toHaveURL(/\/assistant\/open-website\?requestId=/);
  await expect(page.getByRole("link", { name: "打开示例文库" })).toHaveCount(0);
  expect(context.pages()).toHaveLength(2);
});

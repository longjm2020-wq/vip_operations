import {
  openPersonalAssistant,
  selectAssistantPanel,
  selectAssistantExecution,
  setAssistantOption,
} from "./assistant-controls.js";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { defaultTeamSettings } from "../../packages/contracts/src/assistant-team.js";
import type { DesktopTask } from "../../packages/contracts/src/assistant-desktop.js";
const fileId = "11111111-1111-4111-8111-111111111111";
const resultId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const previewId = "44444444-4444-4444-8444-444444444444";
const desktopFixtureId = "55555555-5555-4555-8555-555555555555";
const otherDesktopFixtureId = "99999999-9999-4999-8999-999999999999";
const publicSearchPrompt = "搜索 GitHub 开源项目";
const searchCitation = {
  title: "GitHub 仓库搜索文档",
  url: "https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories",
};
async function desktopScenario(page: Page, native = true, chatReady = true) {
  const requests = await setup(page, "dark", { chatReady });
  const state = {
    connected: true,
    authorized: false,
    accept: true,
    online: true,
    engineReady: undefined as boolean | undefined,
    engineError: "",
    owned: true,
    userId: "7",
    actions: [] as string[],
    pairCodes: 0,
    statusWait: undefined as Promise<void> | undefined,
    completedStatus: 0,
    tasks: [] as DesktopTask[],
    taskControls: [] as { id: string; action: string }[],
    devicesOverride: undefined as
      | import("../../packages/contracts/src/assistant-desktop.js").DesktopDevice[]
      | undefined,
    preferredDedicatedDeviceId: undefined as string | null | undefined,
    purposeMutations: [] as { id: string; purpose: string }[],
  };
  if (native) {
    await page.exposeFunction(
      "desktopFixtureRequest",
      async (request: { action: string; deviceId?: string }) => {
        state.actions.push(request.action);
        if (request.action === "status") {
          await state.statusWait;
          state.completedStatus++;
        }
        if (request.action === "pair") state.connected = true;
        if (
          request.action === "authorize" &&
          request.deviceId === desktopFixtureId &&
          state.accept
        )
          state.authorized = true;
        return {
          version: "1.2.2",
          connected: state.connected,
          authorized: state.authorized,
          engineReady: state.engineReady,
          engineError: state.engineError,
          deviceId: state.connected ? desktopFixtureId : "",
        };
      },
    );
    await page.addInitScript(() => {
      const events = new EventTarget();
      Object.defineProperty(window, "xutiDesktop", {
        value: { version: "1.2.2" },
      });
      Object.assign(window.chrome || (window.chrome = {}), {
        webview: {
          addEventListener: events.addEventListener.bind(events),
          removeEventListener: events.removeEventListener.bind(events),
          postMessage(request: { id: string }) {
            void (window as any)
              .desktopFixtureRequest(request)
              .then((data: unknown) =>
                events.dispatchEvent(
                  new MessageEvent("message", {
                    data: {
                      channel: "xuti-desktop",
                      id: request.id,
                      ok: true,
                      data,
                    },
                  }),
                ),
              );
          },
        },
      });
    });
  }
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      json: {
        data: {
          id: state.userId,
          username: "test",
          displayName: "测试用户",
          roleCodes: [],
          permissions: ["analytics.read", "analytics.manage"],
          csrfToken: "fixture",
        },
      },
    }),
  );
  await page.route(
    "**/api/v1/my-workspace/assistant/desktop**",
    async (route) => {
      if (route.request().method() === "POST") {
        const purposeChange = new URL(route.request().url()).pathname.match(
          /\/devices\/([^/]+)\/purpose$/,
        );
        if (purposeChange) {
          const { purpose } = route.request().postDataJSON();
          const device = state.devicesOverride!.find(
            (entry) => entry.id === purposeChange[1],
          )!;
          device.purpose = purpose;
          state.purposeMutations.push({ id: device.id, purpose });
          if (purpose === "dedicated")
            state.preferredDedicatedDeviceId = device.id;
          else if (state.preferredDedicatedDeviceId === device.id)
            state.preferredDedicatedDeviceId = null;
          await route.fulfill({
            json: {
              data: {
                devices: state.devicesOverride,
                tasks: state.tasks,
                preferredDedicatedDeviceId: state.preferredDedicatedDeviceId,
              },
            },
          });
          return;
        }
        const taskControl = new URL(route.request().url()).pathname.match(
          /\/tasks\/([^/]+)\/control$/,
        );
        if (taskControl) {
          const { action } = route.request().postDataJSON();
          state.taskControls.push({ id: taskControl[1], action });
          const task = state.tasks.find(
            (entry) => entry.id === taskControl[1],
          )!;
          task.status =
            action === "resume"
              ? "WAITING"
              : action === "pause"
                ? "PAUSED"
                : "CANCELED";
          task.stage =
            action === "resume"
              ? "等待本机继续当前任务"
              : action === "pause"
                ? "你已暂停当前任务"
                : "你已停止当前任务";
          task.updatedAt = new Date().toISOString();
          await route.fulfill({ json: { data: task } });
          return;
        }
        if (route.request().url().endsWith("/pair-code")) state.pairCodes++;
        if (route.request().url().endsWith("/authorization/revoke"))
          state.authorized = false;
        else if (route.request().url().endsWith("/revoke")) state.owned = false;
        await route.fulfill({
          json: { data: { code: "a".repeat(32), revoked: true } },
        });
        return;
      }
      await route.fulfill({
        json: {
          data: {
            devices:
              state.devicesOverride ||
              (state.connected && state.owned
                ? [
                    {
                      id: desktopFixtureId,
                      name: "本机测试电脑",
                      online: state.online,
                      engineReady: state.engineReady,
                      crossWindowAuthorized: state.authorized,
                    },
                  ]
                : []),
            tasks: state.tasks,
            preferredDedicatedDeviceId: state.preferredDedicatedDeviceId,
          },
        },
      });
    },
  );
  await page.route("**/api/v1/my-workspace/assistant/team", (route) =>
    route.fulfill({
      json: {
        data: {
          ...defaultTeamSettings(),
          ready: true,
          version: 1,
          notice: "",
          models: [],
          imageModels: [],
        },
      },
    }),
  );
  return { state, requests };
}
async function setup(
  page: Page,
  mode = "dark",
  options?: { wait?: Promise<void>; ambiguous?: boolean; chatReady?: boolean },
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
    ready: options?.chatReady ?? true,
    availabilityMessage: options?.chatReady === false ? "对话模型未就绪" : "小序已就绪",
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
        if (body.message === publicSearchPrompt && !body.attachmentIds?.length) {
          assistant.version++;
          const createdAt = new Date().toISOString();
          assistant.messages.push(
            { id: body.requestId, role: "user", text: body.message, createdAt },
            {
              id: `reply-${body.requestId}`,
              role: "assistant",
              text: "已查询 GitHub 开源仓库的公开资料。",
              citations: [searchCitation],
              createdAt,
            },
          );
          await route.fulfill({ json: { data: assistant } });
          return;
        }
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
            await options?.wait;
            assistant.state = "IDLE";
          }
          assistant.messages.push({
            id: `reply-${body.requestId}`,
            role: "assistant",
            text: options?.ambiguous
              ? "暂时不能唯一确认网站，请补充完整网站或品牌名称。"
              : body.webOpenResult === "blocked"
                ? `浏览器阻止了新窗口，请点击下方“打开${title}”继续。`
                : resolving
                  ? `已找到${title}，正在刚才的新窗口中打开。`
                  : `已在新标签页打开${title}，当前对话保留。`,
            ...(options?.ambiguous ? {} : { webNavigation: { title, url } }),
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
test("已验证 AgentAI 纯文字模型可选择并发送，验证失效不改投其他线路", async ({
  page,
}) => {
  const requests = await setup(page);
  let verified = true;
  await page.route("**/api/v1/my-workspace/assistant/capabilities", (route) =>
    route.fulfill({
      json: {
        data: {
          defaultModel: "engine/default",
          imageModels: [],
          models: [
            {
              id: "engine/default",
              name: "通用助手",
              displayName: "GPT-6.1 Sol",
              vision: true,
            },
            {
              id: "engine/text-only",
              name: "旧文本",
              displayName: "Legacy Text",
              vision: false,
              chatVerifiedAt: "2026-11-16T12:00:00Z",
            },
            {
              id: "agentai/text-model",
              name: "AgentAI Text",
              displayName: "AgentAI Text",
              vision: false,
              chatVerifiedAt: verified ? "2026-11-16T12:00:00Z" : null,
            },
          ],
        },
      },
    }),
  );
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  await composer.getByRole("button", { name: "选择对话模型" }).click();
  await expect(page.getByRole("menuitem", { name: /Legacy Text/ })).toHaveCount(
    0,
  );
  const textModel = page.getByRole("menuitem", { name: /AgentAI Text/ });
  await expect(textModel).toContainText("仅文字");
  await textModel.click();
  await expect(
    composer.getByRole("button", { name: "选择对话模型" }),
  ).toContainText("AgentAI Text");
  await composer.locator("textarea").fill("整理两条建议");
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].model).toBe("agentai/text-model");
  await composer.locator("textarea").fill("保留这份草稿");
  verified = false;
  await composer.getByRole("button", { name: "选择对话模型" }).click();
  await page.getByRole("menuitem", { name: "刷新模型列表" }).click();
  await expect(
    composer.getByRole("button", { name: "选择对话模型" }),
  ).toContainText("所选 AgentAI 型号不可用");
  await expect(
    composer.getByRole("button", { name: "发送给个人助理" }),
  ).toBeDisabled();
  await expect(composer.locator("textarea")).toHaveValue("保留这份草稿");
  expect(requests).toHaveLength(1);
});

test("AgentAI 发送失败后刷新可用型号，保留草稿直到用户另选型号", async ({
  page,
}) => {
  await setup(page);
  const opus = "agentai/claude-opus-5-5";
  const fallback = "engine/default";
  const prompt = "生成一份 SVG 骑行动画 HTML 源码文件";
  const failure =
    "当前型号暂时无法完成本次生成，请选择另一个已验证模型后重新发送。";
  const requests: { model: string; message: string; requestId: string }[] = [];
  const messages: { id: string; role: string; text: string }[] = [];
  let failed = false;
  await page.route("**/api/v1/my-workspace/assistant/capabilities", (route) =>
    route.fulfill({
      json: {
        data: {
          defaultModel: fallback,
          imageModels: [],
          models: [
            {
              id: fallback,
              name: "通用助手",
              displayName: "GPT-6.1 Sol",
              vision: true,
            },
            ...(!failed
              ? [
                  {
                    id: opus,
                    name: "CL Opus 5.5 · AgentAI",
                    vision: true,
                    chatVerifiedAt: "2026-11-21T12:00:00Z",
                  },
                ]
              : []),
          ],
        },
      },
    }),
  );
  await page.route("**/api/v1/my-workspace/assistant", (route) => {
    if (route.request().method() === "POST") {
      const request = route.request().postDataJSON();
      requests.push(request);
      messages.push({
        id: request.requestId,
        role: "user",
        text: request.message,
      });
      failed = request.model === opus;
      if (!failed)
        messages.push({
          id: "alternate-model-reply",
          role: "assistant",
          text: "收到文件生成要求。",
        });
    }
    return route.fulfill({
      json: {
        data: {
          ready: true,
          version: requests.length,
          state: failed ? "FAILED" : "IDLE",
          error: failed ? failure : "",
          messages,
        },
      },
    });
  });

  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  const picker = composer.getByRole("button", { name: "选择对话模型" });
  const send = composer.getByRole("button", { name: "发送给个人助理" });
  await picker.click();
  await page.getByRole("menuitem", { name: /CL Opus 5.5/ }).click();
  await composer.locator("textarea").fill(prompt);
  await send.click();

  await expect(page.getByText(failure, { exact: true })).toBeVisible();
  await expect(picker).toContainText("所选 AgentAI 型号不可用");
  await expect(composer.locator("textarea")).toHaveValue(prompt);
  await expect(send).toBeDisabled();
  expect(requests.map(({ model, message }) => ({ model, message }))).toEqual([
    { model: opus, message: prompt },
  ]);

  await picker.click();
  await expect(page.getByRole("menuitem", { name: /CL Opus 5.5/ })).toHaveCount(
    0,
  );
  await page.getByRole("menuitem", { name: /GPT-6.1 Sol/ }).click();
  await expect(send).toBeEnabled();
  expect(requests).toHaveLength(1);
  await send.click();
  await expect(
    page.getByText("收到文件生成要求。", { exact: true }),
  ).toBeVisible();
  expect(requests.map(({ model }) => model)).toEqual([opus, fallback]);
});

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

test("公开问题从普通输入框直接搜索并显示来源，后续消息仍按各自目标发送", async ({
  page,
}) => {
  const requests = await setup(page);
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  await expect(composer.getByRole("button", { name: "本条目标：自动识别" })).toBeVisible();
  await expect(
    composer.getByRole("button", { name: "联网搜索", exact: true }),
  ).toHaveCount(0);
  await openPersonalAssistant(page);
  await setAssistantOption(page, "附带已保存日程与待办", true);
  await setAssistantOption(page, "使用个人记忆", true);
  await composer.getByRole("button", { name: "选择对话模型" }).click();
  await page.getByRole("menuitem", { name: /Gemini 2.5 Pro/ }).click();
  const input = composer.locator("textarea");
  const send = composer.getByRole("button", { name: "发送给个人助理" });
  await input.fill(publicSearchPrompt);
  await send.click();
  await expect(page.getByText("参考来源", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: searchCitation.title, exact: true }),
  ).toHaveAttribute("href", searchCitation.url);
  expect(requests).toMatchObject([
    {
      message: publicSearchPrompt,
      autoExecution: true,
      includePersonalContext: false,
      includeMemory: false,
    },
  ]);
  expect(requests[0]).not.toHaveProperty("webSearch");
  expect(requests[0]).not.toHaveProperty("model");

  await input.fill("把上面的说明写得更简短");
  await send.click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({
    includePersonalContext: true,
    includeMemory: true,
    model: "engine/vision",
  });
  expect(requests[1]).not.toHaveProperty("webSearch");

  const instruction = "在独立浏览器里点击网页帮助";
  await input.fill(instruction);
  await send.click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]).toMatchObject({
    message: instruction,
    autoExecution: true,
  });
  expect(requests[2]).not.toHaveProperty("webSearch");
});

test("普通对话模型未就绪时，仍可发送明确的公开搜索问题", async ({ page }) => {
  const requests = await setup(page, "dark", { chatReady: false });
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  const input = composer.locator("textarea");
  const send = composer.getByRole("button", { name: "发送给个人助理" });
  await input.fill("把上面的说明写得更简短");
  await expect(send).toBeDisabled();
  await input.fill(publicSearchPrompt);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(
    page.getByRole("link", { name: searchCitation.title, exact: true }),
  ).toHaveAttribute("href", searchCitation.url);
  expect(requests).toMatchObject([{ message: publicSearchPrompt }]);
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

async function pasteIntoComposer(
  textbox: Locator,
  files: { name: string; type: string; content: string }[],
  text = "",
) {
  await textbox.focus();
  return textbox.evaluate(
    (element, clipboard) => {
      const data = new DataTransfer();
      for (const file of clipboard.files)
        data.items.add(new File([file.content], file.name, { type: file.type }));
      if (clipboard.text) data.setData("text/plain", clipboard.text);
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { files, text },
  );
}

test("工作台粘贴多份文件只上传一次，聊天面板保留草稿和附件并沿用数量限制", async ({
  page,
}) => {
  const requests = await setup(page);
  const uploads: { name: string; type: string; content: string }[] = [];
  let fileServiceAvailable = true;
  await page.route("**/api/v1/my-workspace/assistant/files", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const form = await new Response(new Uint8Array(request.postDataBuffer()!), {
      headers: { "Content-Type": request.headers()["content-type"] },
    }).formData();
    const file = form.get("file");
    if (!file || typeof file === "string") throw Error("缺少上传文件");
    uploads.push({
      name: file.name,
      type: file.type,
      content: await file.text(),
    });
    if (!fileServiceAvailable) {
      await route.fulfill({
        status: 503,
        json: { error: { message: "文件服务暂不可用" } },
      });
      return;
    }
    await route.fulfill({
      json: {
        data: {
          id: crypto.randomUUID(),
          name: file.name,
          mime: file.type,
          size: file.size,
          source: "upload",
          createdAt: new Date().toISOString(),
        },
      },
    });
  });
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  const textbox = composer.getByRole("textbox");
  const files = [
    { name: "款式说明.txt", type: "text/plain", content: "保留内袋" },
    { name: "商品清单.csv", type: "text/csv", content: "款号,数量\nA01,1" },
  ];
  await textbox.fill("暂存草稿");
  await textbox.press("Control+a");
  await textbox.press("Control+c");
  await textbox.fill("请根据资料核对，");
  await textbox.press("End");
  await textbox.press("Control+v");
  const draft = "请根据资料核对，暂存草稿";
  await expect(textbox).toHaveValue(draft);
  expect(uploads).toEqual([]);
  expect(await pasteIntoComposer(textbox, files, "复制文件时附带的路径")).toBe(true);
  const tags = composer.locator(".agent-attachments .ant-tag");
  const names = files.map((file) => file.name);
  await expect(tags).toHaveText(names);
  await expect(textbox).toHaveValue(draft);
  expect(uploads).toEqual(files);

  await openPersonalAssistant(page);
  await expect(textbox).toHaveValue(draft);
  await expect(tags).toHaveText(names);
  const overflow = Array.from({ length: 5 }, (_, i) => ({
    ...files[0], name: `资料${i}.txt`,
  }));
  expect(await pasteIntoComposer(textbox, overflow)).toBe(true);
  await expect(page.getByText("每次最多附加6个文件", { exact: true })).toBeVisible();
  expect(uploads).toEqual(files);

  const retry = { ...files[0], name: "补充资料.txt" };
  fileServiceAvailable = false;
  expect(await pasteIntoComposer(textbox, [retry])).toBe(true);
  await expect(page.getByText("文件服务暂不可用", { exact: true })).toBeVisible();
  await expect(tags).toHaveText(names);
  await expect(textbox).toHaveValue(draft);
  fileServiceAvailable = true;
  expect(await pasteIntoComposer(textbox, [retry])).toBe(true);
  await expect(tags).toHaveText([...names, retry.name]);
  await expect(textbox).toHaveValue(draft);
  expect(uploads).toEqual([...files, retry, retry]);
  expect(requests).toEqual([]);
});

test("简洁输入区直接发送附件并下载任务结果，历史回复隐藏型号", async ({
  page,
}) => {
  const requests = await setup(page);
  const openFromKeyboard = async () => {
    const launcher = page
      .getByRole("button", {
        name: "打开小序文字对话",
        exact: true,
      })
      .first();
    await launcher.focus();
    await launcher.press("Enter");
  };
  await page.goto("/my-workspace");
  await openFromKeyboard();
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
  await expect(dialog.locator(".agent-composer-tools button")).toHaveCount(5);
  await expect(dialog.getByRole("combobox", { name: "执行位置" })).toHaveCount(
    0,
  );
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
  const pendingMessage = "同页预览后继续编辑本条消息";
  await dialog.getByPlaceholder(/告诉我你想完成什么/).fill(pendingMessage);
  await selectAssistantPanel(page, "任务与文件");
  const filesPanel = page.locator(".workspace-tool-panels");
  await expect(
    filesPanel.getByRole("heading", { name: "我的文件" }),
  ).toBeVisible();
  await expect(filesPanel).toContainText("已完成");
  await page.screenshot({ path: ".local/assistant-agent-dark.png" });
  const currentUrl = page.url();
  await filesPanel
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
  await expect(
    page.locator(".assistant-compose:visible textarea"),
  ).toHaveValue(pendingMessage);
  await openFromKeyboard();
  const draft = "跨页全息预览后继续编辑的草稿";
  await dialog.getByPlaceholder(/告诉我你想完成什么/).fill(draft);
  await dialog
    .getByRole("button", { name: "收起文字对话", exact: true })
    .click();
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "运营中心", exact: true })
    .click();
  await expect(page).toHaveURL(/operations$/);
  await openFromKeyboard();
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
  await openFromKeyboard();
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
  await expect(page.locator(".workspace-tool-panels")).toBeVisible();
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
  await expect(sender.locator("button")).toHaveCount(5);
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

test("当前桌面壳与已选本机一致时，微信简写只发一次原文；问句、创作和指名其他电脑不使用简写", async ({
  page,
}) => {
  const { state, requests } = await desktopScenario(page);
  state.authorized = true;
  const device = {
    id: desktopFixtureId,
    name: "本机测试电脑",
    online: true,
    crossWindowAuthorized: true,
    lastSeenAt: new Date().toISOString(),
    expiresAt: "2099-01-01T00:00:00Z",
  };
  state.devicesOverride = [
    { ...device, id: otherDesktopFixtureId, name: "办公室电脑" },
    device,
  ];
  await page.addInitScript(
    (id) => localStorage.setItem("xuti-assistant-preferred-desktop:7", id),
    desktopFixtureId,
  );
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  const inbox = composer.getByPlaceholder(/告诉我你想完成什么/);
  const send = composer.getByRole("button", { name: "发送给个人助理" });
  const commands = [
    "打开微信，给好友阿龙发句问候",
    "打开企业微信给我的好友测试联系人准备一句问候",
    "打开微信会占用多少内存？",
    "写一句给微信好友阿龙的问候",
    "在办公室电脑上打开微信，给好友阿龙发句问候",
  ];
  for (const [index, message] of commands.entries()) {
    await inbox.fill(message);
    await send.click();
    await expect.poll(() => requests.length).toBe(index + 1);
    expect(requests[index]).toMatchObject({ message, autoExecution: true });
    if (index < 2) {
      expect(requests[index]).toMatchObject({
        desktopDeviceId: desktopFixtureId,
        nativeDesktopDeviceId: desktopFixtureId,
      });
      expect(requests[index]).not.toHaveProperty("authorizationId");
    } else {
      expect(requests[index]).not.toHaveProperty("nativeDesktopDeviceId");
    }
  }
  expect(state.actions).not.toContain("authorize");
  expect(state.actions).not.toContain("pair");
  expect(state.pairCodes).toBe(0);
  expect(requests).toHaveLength(commands.length);
});

test("普通浏览器即使保存了常用电脑，也不会把微信简写标为当前桌面客户端操作", async ({
  page,
}) => {
  const { state, requests } = await desktopScenario(page, false);
  state.authorized = true;
  await page.addInitScript(
    (id) => localStorage.setItem("xuti-assistant-preferred-desktop:7", id),
    desktopFixtureId,
  );
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  const message = "打开微信，给好友阿龙发句问候";
  await composer.getByPlaceholder(/告诉我你想完成什么/).fill(message);
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ message, autoExecution: true });
  expect(requests[0]).not.toHaveProperty("nativeDesktopDeviceId");
  expect(state.actions).toEqual([]);
});

for (const condition of [
  "本机已离线",
  "本机没有授权",
  "网站已撤销授权",
  "常用电脑是另一台",
] as const) {
  test(
    "当前桌面客户端" + condition + "时不会派发微信简写",
    async ({ page }) => {
      const { state, requests } = await desktopScenario(page);
      state.online = condition !== "本机已离线";
      state.authorized = condition !== "本机没有授权";
      const current = {
        id: desktopFixtureId,
        name: "本机测试电脑",
        online: state.online,
        crossWindowAuthorized: condition !== "网站已撤销授权",
        lastSeenAt: new Date().toISOString(),
        expiresAt: "2099-01-01T00:00:00Z",
      };
      state.devicesOverride = [
        current,
        {
          ...current,
          id: otherDesktopFixtureId,
          name: "办公室电脑",
          online: true,
          crossWindowAuthorized: true,
        },
      ];
      const preferred =
        condition === "常用电脑是另一台"
          ? otherDesktopFixtureId
          : desktopFixtureId;
      await page.addInitScript(
        (id) => localStorage.setItem("xuti-assistant-preferred-desktop:7", id),
        preferred,
      );
      await page.goto("/my-workspace");
      const composer = page.locator(".assistant-compose:visible");
      const input = composer.getByPlaceholder(/告诉我你想完成什么/);
      const message = "打开微信，给好友阿龙发句问候";
      await input.fill(message);
      await composer.getByRole("button", { name: "发送给个人助理" }).click();
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: /本机|电脑|授权/ })
          .first(),
      ).toBeVisible();
      await expect(input).toHaveValue(message);
      expect(requests).toHaveLength(0);
      expect(state.actions).not.toContain("authorize");
      expect(state.actions).not.toContain("pair");
    },
  );
}

test("桌面端已授权本机无需设置常用或打开面板，即可从小序输入框下达指令", async ({
  page,
}) => {
  const { state, requests } = await desktopScenario(page);
  state.authorized = true;
  state.engineReady = true;
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  for (const instruction of [
    "在我的电脑上切换到已打开的记事本窗口",
    "打开记事本",
  ]) {
    await composer.getByPlaceholder(/告诉我你想完成什么/).fill(instruction);
    await composer.getByRole("button", { name: "发送给个人助理" }).click();
    await expect.poll(() => requests.at(-1)?.message).toBe(instruction);
    expect(requests.at(-1)?.desktopDeviceId).toBe(desktopFixtureId);
  }
  expect(requests.at(-1)?.nativeDesktopDeviceId).toBe(desktopFixtureId);
  expect(state.actions).not.toContain("authorize");
  expect(state.actions).not.toContain("pair");
});

test("工作台识别上条已核验的窗口，普通问句与公开搜索仍按本条判断", async ({
  page,
}) => {
  const { state } = await desktopScenario(page);
  state.authorized = true;
  state.engineReady = true;
  const timestamp = new Date().toISOString();
  state.tasks = [
    {
      id: jobId,
      deviceId: desktopFixtureId,
      instruction: "切换到已打开的记事本窗口",
      status: "DONE",
      stage: "已核验记事本窗口在前台",
      step: 1,
      scope: "window",
      window: "无标题 - 记事本",
      nativeAction: "focus_notepad",
      canContinueTyping: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  let previousSurface: "desktop" | "browser" = "desktop";
  let cloudPageReady = true;
  await page.route("**/api/v1/my-workspace/assistant/browser", (route) =>
    route.fulfill({
      json: {
        data: {
          ready: true,
          tasks: [
            {
              id: jobId,
              mode: "BROWSE",
              status: "PAUSED",
              automationStatus: "DONE",
              title: "帮助页",
              instruction: "在网页查看帮助",
              url: "https://example.com/help",
              navigationState: cloudPageReady ? "READY" : "LOADING",
              step: 1,
              updatedAt: timestamp,
            },
          ],
          profile: null,
        },
      },
    }),
  );
  await page.route("**/api/v1/my-workspace/assistant", (route) =>
    route.fulfill({
      json: {
        data: {
          version: 1,
          ready: true,
          state: "IDLE",
          messages: [
            {
              id: fileId,
              role: "user",
              text: state.tasks[0].instruction,
              createdAt: timestamp,
            },
            {
              id: resultId,
              role: "assistant",
              text: "已提交",
              createdAt: timestamp,
              ...(previousSurface === "desktop"
                ? { desktopTaskId: jobId }
                : { browserTaskId: jobId }),
            },
          ],
        },
      },
    }),
  );
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  const input = composer.locator("textarea");
  const target = composer.getByRole("button", { name: /^本条目标/ });
  await input.fill("输入9999999");
  await expect(target).toHaveText(
    "操作我的电脑 · 无标题 - 记事本 · 本机测试电脑",
  );
  await input.fill("在记事本中输入9999999");
  await expect(target).toHaveText(
    "操作我的电脑 · 无标题 - 记事本 · 本机测试电脑",
  );
  await input.fill("怎么在记事本输入数字？");
  await expect(target).toHaveText("普通对话");
  await input.fill("在独立浏览器中点击帮助按钮");
  await expect(target).toHaveText("操作网页 · 云端");
  await input.fill(publicSearchPrompt);
  await expect(target).toHaveText("普通对话 · 联网搜索");
  state.tasks[0].canContinueTyping = false;
  await page.reload();
  await input.fill("输入9999999");
  await expect(target).toHaveText("待确认操作位置");
  state.tasks[0].canContinueTyping = true;
  state.tasks[0].localBrowser = true;
  await page.reload();
  await input.fill("点开帮助按钮");
  await expect(target).toHaveText("操作网页 · 本地");
  previousSurface = "browser";
  await page.reload();
  await input.fill("点开帮助按钮");
  await expect(target).toHaveText("操作网页 · 云端");
  await input.fill("在记事本中输入9999999");
  await expect(target).toHaveText("待确认操作位置");
  cloudPageReady = false;
  await page.reload();
  await input.fill("点开帮助按钮");
  await expect(target).toHaveText("待确认操作位置");
});

test("本条可改成普通对话，打开网页的草稿不弹窗，发送后恢复自动识别", async ({
  page,
}) => {
  const { state, requests } = await desktopScenario(page);
  state.authorized = true;
  state.engineReady = true;
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  const input = composer.locator("textarea");
  const target = composer.getByRole("button", { name: /^本条目标/ });
  await input.fill("打开百度");
  await expect(target).toHaveText("打开网页");
  await target.click();
  await page.getByRole("menuitem", { name: "普通对话", exact: true }).click();
  await expect(target).toHaveText("普通对话");
  await expect(input).toHaveValue("打开百度");
  await input.press("Enter");
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({
    explicitChat: true,
    message: "打开百度",
  });
  for (const field of [
    "autoExecution",
    "desktopDeviceId",
    "browserExecution",
    "webOpenResult",
  ])
    expect(requests[0]).not.toHaveProperty(field);
  expect(page.context().pages()).toHaveLength(1);
  await expect(target).toHaveText("自动识别");
  await input.fill("在我的电脑上打开记事本");
  await expect(target).toHaveText("操作我的电脑 · 本机测试电脑");
  await input.press("Enter");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({
    autoExecution: true,
    desktopDeviceId: desktopFixtureId,
  });
  expect(requests[1]).not.toHaveProperty("explicitChat");
});

test("原本转到导演台的短视频要求留在小序对话", async ({ page }) => {
  const requests = await setup(page);
  const retiredRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/v1/my-workspace/director"))
      retiredRequests.push(request.url());
  });
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  const brief = "做一条短视频";
  await composer.locator("textarea").fill(brief);
  await expect(composer.getByRole("button", { name: "本条目标：普通对话" })).toBeVisible();
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect.poll(() => requests.map((request) => request.message)).toEqual([brief]);
  await expect(page).toHaveURL(/\/my-workspace$/);
  expect(retiredRequests).toEqual([]);
});

test("首条浏览器指令默认走本地，尚未连接时可发送并获得连接指引", async ({ page }) => {
  const { state, requests } = await desktopScenario(page, false, false);
  state.connected = false;
  const message = "操作浏览器，搜索 GitHub 上的开源项目";
  const note = "请在右侧「我的电脑」连接并选择运行小序桌面端的设备，再在右侧浏览器打开本地网页。";
  const conversation = { ready: false, state: "IDLE", version: 0, messages: [] as Record<string, unknown>[] };
  await page.route("**/api/v1/my-workspace/assistant", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      requests.push(body);
      conversation.version++;
      conversation.messages.push(
        { id: body.requestId, role: "user", text: body.message },
        { id: resultId, role: "assistant", text: note },
      );
    }
    return route.fulfill({ json: { data: conversation } });
  });
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  await composer.locator("textarea").fill(message);
  await expect(composer.getByRole("button", { name: "本条目标：操作网页 · 本地" })).toBeVisible();
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect(page.getByText(note, { exact: true })).toBeVisible();
  expect(requests[0]).toMatchObject({ message, autoExecution: true });
  expect(requests[0]).not.toHaveProperty("desktopDeviceId");
  expect(requests[0]).not.toHaveProperty("browserExecution");
  expect(requests[0]).not.toHaveProperty("model");
  await expect(composer.locator("textarea")).toHaveValue(message);
});

test("本条明确选择电脑后忠于所选设备，离线时保留草稿", async ({ page }) => {
  const { state, requests } = await desktopScenario(page, false);
  state.engineReady = true;
  state.authorized = true;
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  const input = composer.locator("textarea");
  const target = composer.getByRole("button", { name: /^本条目标/ });
  await input.fill("打开记事本");
  await target.click();
  await page
    .getByRole("menuitem", { name: "操作我的电脑", exact: true })
    .click();
  await expect(target).toHaveText("操作我的电脑 · 请选择设备");
  await expect(
    composer.getByRole("button", { name: "发送给个人助理" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "设为常用电脑", exact: true }).click();
  await expect(target).toHaveText("操作我的电脑 · 本机测试电脑");
  state.online = false;
  await input.press("Enter");
  await expect(
    page.getByRole("alert").filter({ hasText: "所选电脑离线" }).first(),
  ).toBeVisible();
  await expect(input).toHaveValue("打开记事本");
  expect(requests).toHaveLength(0);
  state.online = true;
  await input.press("Enter");
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({
    desktopDeviceId: desktopFixtureId,
    message: "打开记事本",
  });
  expect(requests[0]).not.toHaveProperty("autoExecution");
});

test("本机已记住授权但无法接单时显示本机原因，保留草稿", async ({ page }) => {
  const { state, requests } = await desktopScenario(page);
  state.authorized = true;
  state.engineReady = false;
  state.engineError = "无法注册紧急停止快捷键";
  await page.goto("/my-workspace");
  await selectAssistantPanel(page, "我的电脑");
  const panel = page.locator(".assistant-desktop-panel");
  await expect(
    panel.getByText("本机暂时无法接收任务", { exact: true }),
  ).toBeVisible();
  await expect(panel).toContainText(state.engineError);
  await expect(panel.getByRole("button", { name: "下达指令" })).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "打开电脑任务" }),
  ).toBeEnabled();
  const composer = page.locator(".assistant-compose:visible");
  await composer.getByPlaceholder(/告诉我你想完成什么/).fill("打开记事本");
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect(composer.getByPlaceholder(/告诉我你想完成什么/)).toHaveValue(
    "打开记事本",
  );
  await expect(
    page.getByRole("alert").filter({ hasText: state.engineError }).first(),
  ).toBeVisible();
  expect(requests).toHaveLength(0);
});

test("工作台聊天模型未配置时，已接单电脑显示可用指令，普通聊天仍提示模型状态", async ({
  page,
}) => {
  const { state, requests } = await desktopScenario(page, false, false);
  state.engineReady = true;
  state.authorized = true;
  await page.route("**/api/v1/my-workspace/assistant/capabilities", (route) =>
    route.fulfill({ json: { data: { models: [], imageModels: [] } } }),
  );
  await page.goto("/my-workspace");
  await selectAssistantPanel(page, "我的电脑");
  await page.getByRole("button", { name: "设为常用电脑" }).click();
  const composer = page.locator(".assistant-compose:visible");
  const input = composer.getByRole("textbox");
  const chat = page.getByRole("dialog", { name: "AI 个人助理" });
  await expect(input).toHaveAttribute("placeholder", /在我的电脑上打开记事本/);
  await expect(chat).toContainText("电脑可接收任务");
  await expect(chat).not.toContainText("对话模型未就绪");
  await expect(composer).not.toContainText("暂无已接通的聊天模型");
  await input.fill("帮我写一段春季活动介绍");
  await expect(composer.getByRole("alert")).toContainText(
    "暂无已接通的聊天模型",
  );
  await expect(
    composer.getByRole("button", { name: "发送给个人助理" }),
  ).toBeDisabled();
  await input.fill("在我的电脑上切换到已打开的记事本窗口");
  await expect(chat).toContainText("电脑可接收任务");
  await expect(chat).not.toContainText("对话模型未就绪");
  await expect(composer.getByRole("alert")).toHaveCount(0);
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ desktopDeviceId: desktopFixtureId });
});

test("业务页选择已连接电脑后，聊天模型未就绪也能提交打开记事本", async ({
  page,
}) => {
  const { state, requests } = await desktopScenario(page, false, false);
  state.authorized = true;
  state.engineReady = true;
  await page.addInitScript(
    (id) => localStorage.setItem("xuti-assistant-desktop:7", id),
    desktopFixtureId,
  );
  await page.goto("/analytics/compass");
  await openPersonalAssistant(page);
  const composer = page.locator(".assistant-compose:visible");
  await composer.getByPlaceholder(/描述电脑任务/).fill("打开记事本");
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({
    message: "打开记事本",
    desktopDeviceId: desktopFixtureId,
  });
});

test("我的电脑无设备只显示连接入口，旧专用偏好不自动选机", async ({ page }) => {
  const { state, requests } = await desktopScenario(page, false);
  state.connected = false;
  await page.addInitScript(() =>
    localStorage.setItem(
      "xuti-assistant-desktop:7",
      JSON.stringify({
        mode: "dedicated",
        deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ),
  );
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  await expect(composer.getByPlaceholder(/告诉我你想完成什么/)).toBeEnabled();
  await selectAssistantPanel(page, "我的电脑");
  const panel = page.locator(".assistant-desktop-panel");
  await expect(
    panel.getByRole("link", { name: /下载 Windows 桌面端/ }),
  ).toBeVisible();
  await expect(panel.getByRole("link", { name: "下载 Mac Finder 助手" }))
    .toHaveAttribute("href", "/downloads/xuti-finder-macos.zip");
  await expect(panel.getByText("尚未配置小序专用电脑")).toHaveCount(0);
  await expect(panel.getByText("选择我的电脑", { exact: true })).toHaveCount(0);
  await expect(panel.locator(".assistant-desktop-management")).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem("xuti-assistant-desktop:7")),
  ).toBeNull();
  expect(requests).toEqual([]);
  await page.screenshot({ path: ".local/my-computer-empty.png" });
  state.connected = true;
  state.authorized = true;
  await panel.getByRole("button", { name: /刷新/ }).click();
  await expect(panel.getByText("选择我的电脑", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("在线 · 接单待确认", { exact: true }),
  ).toBeVisible();
  await panel.getByText("其他连接方式与客户端更新", { exact: true }).click();
  await expect(
    panel.getByRole("link", { name: /下载新版桌面端/ }),
  ).toHaveAttribute("href", "/downloads/xuti-desktop.zip");
  await panel
    .getByRole("button", { name: "设为常用电脑", exact: true })
    .click();
  await expect(panel.getByText("常用电脑", { exact: true })).toBeVisible();
  await expect(composer.getByPlaceholder(/告诉我你想完成什么/)).toBeEnabled();
});

test("桌面端一键操作本机，首次确认后刷新仍记住目标且不重复授权", async ({
  page,
}) => {
  await setup(page);
  const deviceId = "55555555-5555-4555-8555-555555555555";
  await page.addInitScript(
    ({ deviceId }) => {
      let connected = localStorage.getItem("desktop-fixture-connected") === "1",
        authorized = localStorage.getItem("desktop-fixture-authorized") === "1";
      const events = new EventTarget();
      const actions: string[] = JSON.parse(
        localStorage.getItem("desktop-fixture-actions") || "[]",
      );
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
            localStorage.setItem(
              "desktop-fixture-connected",
              connected ? "1" : "0",
            );
            localStorage.setItem(
              "desktop-fixture-authorized",
              authorized ? "1" : "0",
            );
            localStorage.setItem(
              "desktop-fixture-actions",
              JSON.stringify(actions),
            );
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
  await selectAssistantPanel(page, "我的电脑");
  const panel = page.locator(".assistant-desktop-panel");
  await panel
    .getByRole("button", { name: "使用我的电脑", exact: true })
    .click();
  await expect(panel.getByText("常用电脑", { exact: true })).toBeVisible();
  await expect(composer.getByPlaceholder(/告诉我你想完成什么/)).toBeVisible();
  expect(pairCodes).toBe(1);
  const state = await page.evaluate(() => (window as any).desktopTestState());
  expect(state.actions.filter((a: string) => a === "pair")).toHaveLength(1);
  expect(state.actions.filter((a: string) => a === "authorize")).toHaveLength(
    1,
  );
  expect(state.actions).not.toContain("show-tasks");
  await page.reload();
  await expect(composer.getByPlaceholder(/告诉我你想完成什么/)).toBeVisible();
  await selectAssistantPanel(page, "我的电脑");
  await expect(panel.getByText("常用电脑", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "下达指令", exact: true }).click();
  await expect(composer.getByPlaceholder(/告诉我你想完成什么/)).toBeFocused();
  expect(pairCodes).toBe(1);
  expect(
    (
      await page.evaluate(() => (window as any).desktopTestState())
    ).actions.filter((action: string) => action === "authorize"),
  ).toHaveLength(1);
  await selectAssistantPanel(page, "我的电脑");
  await page.getByText("管理连接与授权", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "撤销跨窗口授权", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "连接并授权本机", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: ".local/desktop-simple-authorization.png" });
});

test("电脑操作面板撤销授权并设置常用电脑，输入区按原话提交电脑任务", async ({
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
  await expect(composer.locator(".agent-composer-tools button")).toHaveCount(5);
  await page.screenshot({ path: ".local/assistant-composer-home.png" });
  await openPersonalAssistant(page);
  await selectAssistantPanel(page, "我的电脑");
  const device = page
    .locator(".assistant-desktop-item")
    .filter({ hasText: "测试电脑" });
  const offline = page
    .locator(".assistant-desktop-item")
    .filter({ hasText: "离线电脑" });
  await expect(
    offline.getByRole("button", { name: "设为常用电脑" }),
  ).toBeDisabled();
  await expect(device).toContainText("已记住跨窗口授权");
  expect(mutations).toHaveLength(0);
  await page.screenshot({
    path: ".local/assistant-composer-authorization.png",
  });
  await device.getByText("管理连接与授权", { exact: true }).click();
  await page
    .getByRole("button", { name: "撤销跨窗口授权", exact: true })
    .click();
  await expect(device).toContainText("逐次允许");
  await device.getByRole("button", { name: "设为常用电脑" }).click();
  await expect(device.getByText("常用电脑", { exact: true })).toBeVisible();
  expect(mutations).toHaveLength(1);
  const input = composer.getByPlaceholder(/告诉我你想完成什么/);
  const instruction = "在我的电脑上打开记事本";
  await input.fill(instruction);
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({
    autoExecution: true,
    desktopDeviceId: desktopId,
    message: instruction,
  });
  expect(requests[0]).not.toHaveProperty("authorizationId");
  expect(requests[0]).not.toHaveProperty("webOpenResult");
  expect(page.context().pages()).toHaveLength(1);
  await expect(composer.getByPlaceholder(/告诉我你想完成什么/)).toBeVisible();
});

test("业务页的电脑任务实时显示暂停原因，重复发送保留草稿并可继续原任务", async ({
  page,
}) => {
  const { state } = await desktopScenario(page, false);
  state.authorized = true;
  const taskId = "77777777-7777-4777-8777-777777777777";
  const sent: Record<string, unknown>[] = [];
  const conversation = {
    ready: true,
    state: "IDLE",
    version: 0,
    error: "",
    messages: [] as Record<string, unknown>[],
  };
  await page.route("**/api/v1/my-workspace/assistant", async (route) => {
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON();
      sent.push(input);
      expect(input.desktopDeviceId).toBe(desktopFixtureId);
      state.tasks = [
        {
          id: taskId,
          deviceId: desktopFixtureId,
          deviceName: "本机测试电脑",
          instruction: input.message,
          status: "WAITING",
          stage: "等待本机按设备授权开始",
          step: 0,
          window: "",
          scope: "window",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
      conversation.messages.push(
        { id: input.requestId, role: "user", text: input.message },
        {
          id: "desktop-reply",
          role: "assistant",
          text: "电脑任务已创建。",
          desktopTaskId: taskId,
        },
      );
      conversation.version++;
    }
    await route.fulfill({ json: { data: conversation } });
  });
  await page.addInitScript(
    (id) => localStorage.setItem("xuti-assistant-desktop:7", id),
    desktopFixtureId,
  );
  await page.goto("/analytics/compass");
  await openPersonalAssistant(page);
  const composer = page.locator(".assistant-compose:visible");
  await composer
    .getByPlaceholder(/描述电脑任务/)
    .fill("整理记事本中的测试文字");
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  const card = composer.locator(".assistant-desktop-task");
  await expect(card).toContainText("等待本机执行");
  await expect(page.locator(".assistant-desktop-panel")).toHaveCount(0);
  state.tasks[0].status = "PAUSED";
  state.tasks[0].stage = "检测到你的手动操作，已暂停";
  await expect(card.getByRole("status")).toHaveText(state.tasks[0].stage, {
    timeout: 10000,
  });
  await expect(card).toContainText("步骤回执 0 次");
  await expect(card).not.toContainText("授权尚未开启");
  expect(state.taskControls).toEqual([]);
  await composer.getByPlaceholder(/描述电脑任务/).fill("现在进度如何");
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect(
    composer.getByRole("button", { name: "发送给个人助理" }),
  ).toBeEnabled();
  expect(sent).toHaveLength(1);
  await expect(composer.getByPlaceholder(/描述电脑任务/)).toHaveValue(
    "现在进度如何",
  );
  await page.screenshot({ path: ".local/desktop-task-live-paused.png" });

  await card.getByRole("button", { name: "继续当前任务", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("等待本机继续当前任务");
  expect(state.taskControls).toEqual([{ id: taskId, action: "resume" }]);
  state.tasks[0].status = "RUNNING";
  state.tasks[0].stage = "已识别测试文档，正在整理";
  state.tasks[0].step = 2;
  state.tasks[0].window = "测试文档 - 记事本";
  await expect(card).toContainText("步骤回执 2 次", { timeout: 10000 });
  await expect(card).not.toContainText("已确认执行");
  await card.getByRole("button", { name: "暂停任务", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("你已暂停当前任务");
  await card.getByRole("button", { name: "停止任务", exact: true }).click();
  await expect(card).toHaveCount(0);
  const historyCard = page.locator(
    ".assistant-messages .assistant-desktop-task",
  );
  await expect(historyCard).toContainText("已停止");
  await expect(historyCard).toContainText("你已停止当前任务");
  expect(state.taskControls).toEqual([
    { id: taskId, action: "resume" },
    { id: taskId, action: "pause" },
    { id: taskId, action: "stop" },
  ]);
  expect(sent).toHaveLength(1);
});

test("文件复制任务区分自动核验、按键回执和人工暂停", async ({ page }) => {
  const { state } = await desktopScenario(page, false);
  state.authorized = true;
  state.engineReady = true;
  const now = new Date().toISOString();
  const task: DesktopTask = {
    id: jobId, deviceId: desktopFixtureId, instruction: "将指定文件复制到桌面新目录",
    status: "NEEDS_USER", stage: "操作已中止，请核对窗口。", fileCopyProgress: "awaiting_verification",
    step: 6, confirmedSteps: 4, window: "自动化112601", scope: "device",
    recentSteps: [
      { step: 3, action: "key", result: "ok" },
      { step: 4, action: "key", fileShortcut: "copy", result: "ok" },
      { step: 5, action: "switch_window", result: "ok" },
      { step: 6, action: "key", fileShortcut: "paste", result: "uncertain" },
    ], createdAt: now, updatedAt: now,
  };
  state.tasks = [task];
  await page.goto("/my-workspace");
  await selectAssistantPanel(page, "我的电脑");
  const panel = page.locator(".assistant-desktop-panel");
  await panel.getByText("操作任务", { exact: true }).click();
  const card = panel.locator(`[data-desktop-task-id="${jobId}"]`);
  const refresh = () => panel.getByRole("button", { name: /刷新/ }).click();
  await expect(card).toContainText("等待自动核验");
  await expect(card).not.toContainText(/需要你接手|操作已中止/);
  await expect(card.getByRole("button", { name: "继续当前任务" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "暂停任务" })).toBeVisible();
  await expect(card.getByRole("button", { name: "停止任务" })).toBeVisible();
  await card.getByText("最近步骤回执", { exact: true }).click();
  const rows = card.getByRole("list", { name: "最近步骤回执" }).getByRole("listitem");
  await expect(rows).toHaveText(["第 3 步按键已执行", "第 4 步复制文件已执行", "第 5 步切换窗口已执行", "第 6 步粘贴文件未确认"]);

  task.status = "PAUSED";
  task.stage = "用户已暂停任务";
  await refresh();
  await expect(card.getByRole("status")).toHaveText(task.stage);
  await expect(card).not.toContainText("等待自动核验");
  await expect(card.getByRole("button", { name: "继续当前任务" })).toBeVisible();
  task.status = "NEEDS_USER";
  task.stage = "目标已有同名文件，请核对目标目录。";
  delete task.fileCopyProgress;
  await refresh();
  await expect(card.getByRole("status")).toHaveText(task.stage);
  await expect(card).toContainText("需要你接手");

  task.status = "WAITING";
  task.stage = "本机已确认此前没有发送粘贴，正在等待自动重试";
  task.fileCopyProgress = "retrying";
  task.recentSteps![3].result = "blocked";
  await refresh();
  await expect(card).toContainText("等待自动重试");
  await expect(rows.last()).toHaveText("第 6 步粘贴文件未执行");
  await expect(card.getByRole("button", { name: "继续当前任务" })).toHaveCount(0);

  task.status = "DONE";
  task.stage = "已核验指定目录的复制结果";
  task.fileCopyProgress = "verified";
  task.recentSteps![3] = { step: 6, action: "key", fileShortcut: "paste", result: "ok", verifiedAfterPaste: true };
  await refresh();
  await expect(card).toContainText("复制已核验");
  await expect(rows.last()).toHaveText("第 6 步粘贴文件事后已核验");
  await expect(card.getByRole("button", { name: "继续当前任务" })).toHaveCount(0);
  delete task.fileCopyProgress;
  task.fileCopyMode = "background";
  task.recentSteps = [{ step: 1, action: "file_copy", result: "ok" }];
  await refresh();
  await expect(rows).toHaveText(["第 1 步后台复制文件已核验"]);
  await expect(card).not.toContainText("粘贴文件");

  delete task.fileCopyMode;
  task.nativeAction = "create_desktop_folders";
  task.stage = "已在桌面核验 10 个子文件夹";
  task.recentSteps = [{ step: 1, action: "create_folders", result: "ok" }];
  await refresh();
  await expect(card.getByRole("status")).toHaveText(task.stage);
  await expect(card).toContainText("后台批量建文件夹");
  await expect(rows).toHaveText(["第 1 步批量创建文件夹已核验"]);
  await expect(card).not.toContainText("暂无窗口记录");
  expect(state.taskControls).toEqual([]);
});

test("桌面文件任务受遮挡时核对回执并继续原任务，旧记录和其他窗口按实际状态展示", async ({
  page,
}) => {
  const { state, requests } = await desktopScenario(page, false);
  state.authorized = true;
  state.engineReady = true;
  const now = new Date().toISOString();
  const task: DesktopTask = {
    id: jobId,
    deviceId: desktopFixtureId,
    instruction:
      "在我的电脑桌面新建文件夹命名“自动化测试1126”，并在文件夹内新建两个子文件夹和1个记事本，在记事本内写入“自动化测试666”",
    status: "NEEDS_USER",
    stage: "操作已中止，请核对窗口。目标位置被其他窗口遮挡，请核对后继续",
    step: 3,
    confirmedSteps: 1,
    recentSteps: [
      { step: 1, action: "key", result: "ok" },
      { step: 2, action: "type", result: "uncertain" },
      { step: 3, action: "click", result: "blocked" },
    ],
    window: "桌面 - 文件资源管理器",
    scope: "device",
    createdAt: now,
    updatedAt: now,
  };
  state.tasks = [task];
  await page.goto("/my-workspace");
  await selectAssistantPanel(page, "我的电脑");
  const panel = page.locator(".assistant-desktop-panel");
  const card = panel.locator(`[data-desktop-task-id="${task.id}"]`);
  const taskListToggle = panel.getByText("操作任务", { exact: true });
  const chatCard = page.locator(".assistant-compose:visible").getByRole("region", {
    name: "电脑任务：" + task.instruction,
  });
  await expect(taskListToggle).toBeVisible();
  await expect(card.getByRole("button", { name: "继续当前任务" })).toBeHidden();
  await expect(chatCard.getByRole("button", { name: "继续当前任务" })).toBeVisible();
  await taskListToggle.focus();
  await taskListToggle.press("Enter");
  await expect(card.getByRole("button", { name: "继续当前任务" })).toBeVisible();
  await taskListToggle.press("Space");
  await expect(card.getByRole("button", { name: "继续当前任务" })).toBeHidden();
  await expect(chatCard.getByRole("button", { name: "继续当前任务" })).toBeVisible();
  await taskListToggle.click();
  await expect(card).toContainText("步骤回执 3 次 · 已确认执行 1 步");
  await expect(card).toContainText("核对已有的文件夹和文件");
  await expect(card).toContainText(
    "选择这个资源管理器窗口，点击「从此窗口继续」",
  );
  const receipts = card.getByRole("list", { name: "最近步骤回执" });
  await expect(receipts).toBeHidden();
  await card.locator("summary").click();
  await expect(receipts.getByRole("listitem")).toHaveText([
    "第 1 步按键已执行",
    "第 2 步输入文字未确认",
    "第 3 步点击未执行",
  ]);
  expect(state.taskControls).toEqual([]);
  await card.getByRole("button", { name: "继续当前任务", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("等待本机继续当前任务");
  expect(state.taskControls).toEqual([{ id: task.id, action: "resume" }]);
  expect(requests).toEqual([]);

  task.instruction = "在我的电脑上点击计算器中的数字";
  task.window = "计算器";
  task.status = "NEEDS_USER";
  task.stage = "目标位置被其他窗口遮挡，请核对后继续";
  task.step = 15;
  delete task.confirmedSteps;
  task.recentSteps = [{ step: 15, action: "click", result: "uncertain" }];
  await panel.getByRole("button", { name: /刷新/ }).click();
  await expect(card).toContainText("切回「计算器」，移开遮挡窗口");
  await expect(card).toContainText("步骤回执 15 次");
  await expect(card).not.toContainText(/文件夹|已确认执行/);
  await expect(receipts.getByRole("listitem")).toHaveText([
    "第 15 步点击未确认",
  ]);
  delete task.recentSteps;
  await panel.getByRole("button", { name: /刷新/ }).click();
  await expect(card.locator("summary")).toHaveCount(0);
});

test("业务页发送前核对已有电脑任务，直接显示暂停任务且不重复提交", async ({
  page,
}) => {
  const { state, requests } = await desktopScenario(page, false);
  state.authorized = true;
  await page.addInitScript(
    (id) => localStorage.setItem("xuti-assistant-desktop:7", id),
    desktopFixtureId,
  );
  await page.goto("/analytics/compass");
  await openPersonalAssistant(page);
  const composer = page.locator(".assistant-compose:visible");
  const input = composer.getByPlaceholder(/描述电脑任务/);
  await expect(input).toBeEnabled();
  await expect(composer.locator(".assistant-desktop-task")).toHaveCount(0);
  state.tasks = [
    {
      id: "88888888-8888-4888-8888-888888888888",
      deviceId: desktopFixtureId,
      deviceName: "本机测试电脑",
      instruction: "另一页面已有的测试任务",
      status: "PAUSED",
      stage: "检测到你的手动操作，已暂停",
      step: 0,
      window: "",
      scope: "window",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  await input.fill("再次整理测试文字");
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect(
    composer.getByRole("button", { name: "发送给个人助理" }),
  ).toBeEnabled();
  await expect(composer.locator(".assistant-desktop-task")).toContainText(
    "另一页面已有的测试任务",
  );
  await expect(input).toHaveValue("再次整理测试文字");
  expect(requests).toHaveLength(0);
  expect(state.taskControls).toEqual([]);
});

test("工作台电脑任务卡在后台继续刷新，返回前台立即显示最新原因", async ({
  page,
}) => {
  const { state, requests } = await desktopScenario(page, false);
  state.authorized = true;
  state.tasks = [
    {
      id: "99999999-9999-4999-8999-999999999999",
      deviceId: desktopFixtureId,
      deviceName: "本机测试电脑",
      instruction: "测试后台状态刷新",
      status: "WAITING",
      stage: "等待本机按设备授权开始",
      step: 0,
      window: "",
      scope: "window",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  await page.addInitScript(
    (id) => localStorage.setItem("xuti-assistant-desktop:7", id),
    desktopFixtureId,
  );
  await page.goto("/my-workspace");
  const card = page.locator(
    ".assistant-compose:visible .assistant-desktop-task",
  );
  await expect(card.getByRole("status")).toHaveText("等待本机按设备授权开始");
  await expect(page.getByRole("dialog", { name: /AI 个人助理/ })).toBeHidden();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  });
  state.tasks[0].status = "NEEDS_USER";
  state.tasks[0].stage = "连接或智能服务异常，请检查网站任务状态";
  await expect(card.getByRole("status")).toHaveText(state.tasks[0].stage, {
    timeout: 10000,
  });
  await expect(card).toContainText("需要你接手");
  // The last poll is fresh; returning must still fetch the newly changed state.
  state.tasks[0].status = "PAUSED";
  state.tasks[0].stage = "已核对窗口，等待你继续";
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  });
  await expect(card.getByRole("status")).toHaveText(state.tasks[0].stage, {
    timeout: 2000,
  });
  await expect(page.getByRole("dialog", { name: /AI 个人助理/ })).toBeHidden();
  expect(requests).toHaveLength(0);
  expect(state.taskControls).toEqual([]);
});

test("长聊天打开电脑面板从顶部显示连接入口，刷新任务保留手动滚动", async ({
  page,
}) => {
  await desktopScenario(page, false);
  await page.route("**/api/v1/my-workspace/assistant", (route) =>
    route.fulfill({
      json: {
        data: {
          ready: true,
          state: "IDLE",
          version: 1,
          error: "",
          messages: Array.from({ length: 30 }, (_, index) => ({
            id: `history-${index}`,
            role: index % 2 ? "assistant" : "user",
            text: `第 ${index + 1} 条历史对话：核对库存与供应商更新情况。\n${"这是保留的聊天内容。".repeat(20)}`,
            createdAt: new Date().toISOString(),
          })),
        },
      },
    }),
  );
  let stage = "已完成历史电脑操作";
  await page.route("**/api/v1/my-workspace/assistant/desktop", (route) =>
    route.fulfill({
      json: {
        data: {
          devices: [],
          tasks: Array.from({ length: 10 }, (_, index) => ({
            id: `desktop-history-${index}`,
            status: "DONE",
            scope: "device",
            instruction: `历史电脑任务 ${index + 1}`,
            deviceName: "本机测试电脑",
            window: "测试文档",
            step: 3,
            updatedAt: new Date().toISOString(),
            stage,
          })),
        },
      },
    }),
  );
  await page.goto("/my-workspace");
  await openPersonalAssistant(page);
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  const chatBody = dialog.locator(".ant-drawer-body");
  await expect
    .poll(() => chatBody.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(500);
  await selectAssistantPanel(page, "我的电脑");
  const panel = page.locator(".workspace-right .assistant-desktop-panel");
  const body = page.locator(".workspace-tool-panels");
  await expect(panel.getByText("操作任务", { exact: true })).toBeVisible();
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(panel.getByRole("heading", { name: /我的电脑/ })).toBeInViewport(
    { ratio: 1 },
  );
  await expect(
    panel.getByRole("link", { name: "下载 Windows 桌面端" }),
  ).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: ".local/desktop-panel-scroll-top.png" });

  await panel.getByText("操作任务", { exact: true }).click();
  await expect(panel.getByRole("status")).toHaveCount(10);
  await body.evaluate((el) => {
    el.scrollTop = 360;
  });
  stage = "任务状态已刷新";
  await page.evaluate(async () => {
    const modulePath = "/src/api.ts";
    const { queryClient } = await import(modulePath);
    await queryClient.invalidateQueries({ queryKey: ["assistant-desktop"] });
  });
  await expect(panel.getByRole("status").first()).toHaveText(stage);
  expect(await body.evaluate((el) => el.scrollTop)).toBe(360);

  await page
    .getByRole("button", { name: "收起右侧工具栏", exact: true })
    .click();
  await expect(panel).toBeHidden();
  await selectAssistantPanel(page, "我的电脑");
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(
    panel.getByRole("link", { name: "下载 Windows 桌面端" }),
  ).toBeInViewport({ ratio: 1 });
});

test("业务页取消本机授权保留普通对话草稿和附件，重试成功才切换电脑", async ({
  page,
}) => {
  const { state, requests } = await desktopScenario(page);
  state.accept = false;
  await page.goto("/analytics/compass");
  await openPersonalAssistant(page);
  const composer = page.locator(".assistant-compose:visible");
  await composer
    .getByPlaceholder(/告诉我你想完成什么/)
    .fill("保留这份尚未发送的草稿");
  await composer.getByLabel("上传助理附件").setInputFiles({
    name: "资料.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("资料"),
  });
  await expect(composer.locator(".agent-attachments")).toContainText(
    "资料.txt",
  );
  await selectAssistantExecution(page, "我的电脑");
  await expect(
    page.getByText("已取消授权，可点击「使用我的电脑」重新授权", {
      exact: true,
    }),
  ).toBeVisible();
  expect(state.actions.filter((action) => action === "authorize")).toHaveLength(
    1,
  );
  expect(state.pairCodes).toBe(0);
  expect(
    await page.evaluate(() => localStorage.getItem("xuti-assistant-desktop:7")),
  ).toBeNull();
  await selectAssistantPanel(page, "聊天");
  await expect(composer.getByPlaceholder(/告诉我你想完成什么/)).toHaveValue(
    "保留这份尚未发送的草稿",
  );
  await expect(composer.locator(".agent-attachments")).toContainText(
    "资料.txt",
  );
  state.accept = true;
  await selectAssistantExecution(page, "我的电脑");
  await expect(composer.getByPlaceholder(/描述电脑任务/)).toHaveValue(
    "保留这份尚未发送的草稿",
  );
  await expect(
    composer.getByRole("button", { name: "发送给个人助理", exact: true }),
  ).toBeVisible();
  await expect(
    composer.getByRole("button", { name: "提交团队任务", exact: true }),
  ).toHaveCount(0);
  await expect(composer.locator(".agent-attachments")).toContainText(
    "资料.txt",
  );
  expect(requests).toHaveLength(0);
  await page.screenshot({ path: ".local/desktop-draft-preserved.png" });
});

test("业务页指定的电脑离线或归属失效时不改发网站，不同账号不继承选择", async ({
  page,
}) => {
  const { state, requests } = await desktopScenario(page, false);
  state.authorized = true;
  state.online = false;
  await page.goto("/analytics/compass");
  await page.evaluate(
    (id) => localStorage.setItem("xuti-assistant-desktop:7", id),
    desktopFixtureId,
  );
  await page.reload();
  await openPersonalAssistant(page);
  const composer = page.locator(".assistant-compose:visible");
  await expect(
    composer.getByText("所选电脑离线，请打开该电脑的小序桌面端。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(composer.getByPlaceholder(/描述电脑任务/)).toBeDisabled();
  await expect(
    composer.getByRole("button", { name: "开始语音对话", exact: true }),
  ).toBeDisabled();
  state.owned = false;
  await page.reload();
  await openPersonalAssistant(page);
  await expect(
    composer.getByText(
      "上次选择的电脑连接已失效，请重新连接或主动返回网站对话。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(composer.getByPlaceholder(/描述电脑任务/)).toBeDisabled();
  state.userId = "8";
  await page.reload();
  await openPersonalAssistant(page);
  await expect(composer.getByPlaceholder(/告诉我你想完成什么/)).toBeEnabled();
  await expect(composer.locator(".assistant-desktop-entry")).toContainText(
    "网站内",
  );
  state.userId = "7";
  await page.reload();
  await openPersonalAssistant(page);
  await expect(composer.getByPlaceholder(/描述电脑任务/)).toBeDisabled();
  await selectAssistantExecution(page, "网站内");
  expect(
    await page.evaluate(() => localStorage.getItem("xuti-assistant-desktop:7")),
  ).toBeNull();
  await page.reload();
  await openPersonalAssistant(page);
  await expect(composer.getByPlaceholder(/告诉我你想完成什么/)).toBeEnabled();
  expect(requests).toHaveLength(0);
});

test("原生操作本机链接消费一次，重复点击不重复配对或确认", async ({ page }) => {
  const { state } = await desktopScenario(page);
  state.connected = false;
  await page.goto(
    "/my-workspace?assistant=desktop&connect=1&keep=fixture#position",
  );
  const composer = page.locator(".assistant-compose:visible");
  const panel = page.locator(".assistant-desktop-panel");
  await expect(panel.getByText("常用电脑", { exact: true })).toBeVisible();
  await expect(composer.getByPlaceholder(/告诉我你想完成什么/)).toBeVisible();
  await expect(page).toHaveURL(/\/my-workspace\?keep=fixture#position$/);
  expect(state.pairCodes).toBe(1);
  expect(state.actions.filter((action) => action === "authorize")).toHaveLength(
    1,
  );
  await page
    .getByRole("button", { name: "下达指令", exact: true })
    .evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
  await expect(
    page.getByRole("button", { name: "下达指令", exact: true }),
  ).toBeEnabled();
  expect(state.pairCodes).toBe(1);
  expect(state.actions.filter((action) => action === "authorize")).toHaveLength(
    1,
  );
  await page.reload();
  await expect(composer.getByPlaceholder(/告诉我你想完成什么/)).toBeVisible();
  await selectAssistantPanel(page, "我的电脑");
  await expect(panel.getByText("常用电脑", { exact: true })).toBeVisible();
  expect(state.actions.filter((action) => action === "authorize")).toHaveLength(
    1,
  );
});

test("已有任务处理中原生事件不会刷新页面或改变目标，完成后需主动点击", async ({
  page,
}) => {
  const { state } = await desktopScenario(page);
  let pending = true;
  await page.route("**/api/v1/my-workspace/assistant", (route) =>
    route.fulfill({
      json: {
        data: {
          ready: true,
          state: pending ? "PENDING" : "IDLE",
          version: 0,
          messages: [],
          error: "",
        },
      },
    }),
  );
  await page.goto("/my-workspace");
  await selectAssistantPanel(page, "我的电脑");
  await expect(
    page.getByRole("button", { name: "使用我的电脑", exact: true }),
  ).toBeDisabled();
  const locationBefore = page.url();
  const navigationBefore = await page.evaluate(() => performance.timeOrigin);
  expect(
    await page.evaluate(() =>
      window.dispatchEvent(
        new Event("xuti-desktop-setup", { cancelable: true }),
      ),
    ),
  ).toBe(false);
  await expect(
    page.getByText("请先结束当前语音或等待发送完成，再选择操作电脑。", {
      exact: true,
    }),
  ).toBeVisible();
  expect(page.url()).toBe(locationBefore);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(
    navigationBefore,
  );
  expect(state.actions).not.toContain("authorize");
  expect(state.actions).not.toContain("pair");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("xuti-assistant-preferred-desktop:7"),
    ),
  ).toBeNull();
  pending = false;
  await selectAssistantPanel(page, "我的电脑");
  const button = page.getByRole("button", {
    name: "使用我的电脑",
    exact: true,
  });
  await expect(button).toBeEnabled({ timeout: 10000 });
  expect(state.actions).not.toContain("authorize");
  await button.click();
  await expect(
    page
      .locator(".assistant-desktop-panel")
      .getByText("常用电脑", { exact: true }),
  ).toBeVisible();
});

test("本机连接等待期间切换账号会中止旧授权流程，不继续配对或记住选择", async ({
  page,
}) => {
  const { state } = await desktopScenario(page);
  state.connected = false;
  let releaseStatus!: () => void;
  state.statusWait = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  await page.goto("/my-workspace");
  await selectAssistantPanel(page, "我的电脑");
  const button = page.getByRole("button", {
    name: "使用我的电脑",
    exact: true,
  });
  await button.click();
  await expect.poll(() => state.actions.includes("status")).toBe(true);
  const navigationBefore = await page.evaluate(() => performance.timeOrigin);
  state.userId = "8";
  await page.evaluate(async () => {
    const modulePath = "/src/api.ts";
    const { queryClient } = await import(modulePath);
    await queryClient.invalidateQueries({ queryKey: ["me"] });
  });
  await expect(
    page.getByRole("button", { name: "附件", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(
    navigationBefore,
  );
  releaseStatus();
  await expect.poll(() => state.completedStatus).toBeGreaterThan(0);
  // Let the bridge response and both async continuations settle after unmount.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(state.pairCodes).toBe(0);
  expect(state.actions).not.toContain("pair");
  expect(state.actions).not.toContain("authorize");
  expect(
    await page.evaluate(() => [
      localStorage.getItem("xuti-assistant-desktop:7"),
      localStorage.getItem("xuti-assistant-desktop:8"),
      localStorage.getItem("xuti-assistant-preferred-desktop:7"),
      localStorage.getItem("xuti-assistant-preferred-desktop:8"),
    ]),
  ).toEqual([null, null, null, null]);
  await expect(
    page
      .locator(".assistant-compose:visible")
      .getByPlaceholder(/告诉我你想完成什么/),
  ).toBeEnabled();
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

test("历史 HTML 源码 TXT 可在右栏运行隔离的骑行动画和控件", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  const path = "**/api/v1/my-workspace/assistant";
  const title = "pelican-bike.html 源码";
  const script = `<script>
    const wheel = document.getElementById("wheel");
    const [leg, foot] = document.getElementById("leg-group").children;
    const toggle = document.getElementById("toggle");
    const speedControl = document.getElementById("speed");
    const speedDisplay = document.querySelector("#speed-display");
    document.getElementById("isolation").textContent = typeof fetch + "/" + typeof parent;
    try {
      document.getElementById("network-probe").setAttribute("href", "https://artifact-preview.invalid/program.png");
      foot.setAttribute("href", "https://artifact-preview.invalid/anonymous.svg");
    } catch {}

    let distance = 0;
    let speed = 1;
    let riding = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    let queued = false;

    function scheduleRide() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(advanceRide);
    }

    function advanceRide() {
      queued = false;
      if (!riding) return;
      distance = (distance + speed) % 60;
      wheel.setAttribute("cx", String(20 + distance));
      leg.setAttribute("d", "M0 30L" + (20 + distance) + " 5");
      foot.setAttribute("transform", "translate(" + (20 + distance) + " 5)");
      scheduleRide();
    }

    toggle.addEventListener("click", () => {
      riding = !riding;
      toggle.textContent = riding ? "暂停动画" : "播放";
      if (riding) scheduleRide();
    });
    speedControl.addEventListener("input", () => {
      speed = Number(speedControl.value);
      speedDisplay.textContent = speed + " 倍速";
    });
    if (riding) scheduleRide();
  </script>`;
  const source = [
    "骑行示例",
    "```html",
    "<!doctype html><html><body><h1>骑行预览</h1>",
    '<svg viewBox="0 0 100 40"><circle id="wheel" cx="20" cy="20" r="10" /><g id="leg-group"><path d="M0 30L20 5" /><path d="M0 0L5 0" transform="translate(20 5)" /></g><image id="network-probe" width="1" height="1" /></svg>',
    "<button id=\"toggle\" onclick=\"document.getElementById('isolation').textContent = 'unsafe'\">播放</button>",
    '<label for="speed">骑行速度</label><input id="speed" type="range" min="1" max="3" step="1" value="1">',
    '<output id="speed-display">1 倍速</output><p id="isolation"></p>',
    '<img src="https://artifact-preview.invalid/image.png" alt="测试资源">',
    script,
    "</body></html>",
    "```",
  ].join("\n");
  const file = {
    id: resultId,
    name: `${title}.txt`,
    mime: "text/plain",
    size: Buffer.byteLength(source),
    source: "generated",
    createdAt: "2026-11-21T00:00:00Z",
  };
  await page.route(path, (route) =>
    route.fulfill({
      json: {
        data: {
          ready: true,
          version: 1,
          state: "IDLE",
          messages: [
            {
              id: "artifact-history",
              role: "assistant",
              text: "文件已生成。",
              jobIds: [jobId],
            },
          ],
        },
      },
    }),
  );
  await page.route(`${path}/jobs`, (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: jobId,
            kind: "document",
            title,
            status: "DONE",
            stage: "已完成",
            progress: 100,
            files: [file],
          },
        ],
      },
    }),
  );
  await page.route(`${path}/files/${resultId}/content`, (route) =>
    route.fulfill({ body: source, contentType: "text/plain; charset=utf-8" }),
  );
  const outgoing: string[] = [];
  await page.route("https://artifact-preview.invalid/**", (route) => {
    outgoing.push(route.request().url());
    return route.abort();
  });

  await page.goto("/my-workspace");
  await selectAssistantPanel(page, "聊天");
  const task = page.getByRole("region", { name: `任务：${title}` });
  await task.getByRole("button", { name: `预览 ${file.name}` }).click();
  const panel = page
    .getByRole("complementary", { name: "右侧工具栏" })
    .getByRole("region", { name: "文件预览" });
  const iframe = panel.getByTitle(`${file.name} 的预览`);
  const preview = iframe.contentFrame();
  await expect(
    preview.getByRole("heading", { name: "骑行预览" }),
  ).toBeVisible();
  await expect(iframe).toHaveAttribute("sandbox", "allow-same-origin");
  await expect(panel.getByRole("status")).toHaveText(
    "交互在当前浏览器中隔离运行。",
    { timeout: 12_000 },
  );
  await expect(preview.locator("#isolation")).toHaveText("undefined/undefined");
  const networkProbe = preview.locator("#network-probe");
  await expect(networkProbe).toHaveCount(1);
  await expect(networkProbe).not.toHaveAttribute("href");

  const wheel = preview.locator("#wheel");
  const leg = preview.locator("#leg-group > path").nth(0);
  const foot = preview.locator("#leg-group > path").nth(1);
  await expect(wheel).toBeVisible();
  await expect(wheel).toHaveAttribute("cx", "20");
  await expect(foot).not.toHaveAttribute("href");
  await preview.getByRole("button", { name: "播放" }).click();
  await expect(wheel).toHaveAttribute("cx", /^(2[1-9]|[3-7][0-9])$/);
  await expect(leg).not.toHaveAttribute("d", "M0 30L20 5");
  await expect(foot).not.toHaveAttribute("transform", "translate(20 5)");
  await preview.getByRole("button", { name: "暂停动画" }).click();
  await expect(preview.getByRole("button", { name: "播放" })).toBeVisible();
  const stoppedAt = (await wheel.getAttribute("cx")) ?? "";
  const stoppedLeg = (await leg.getAttribute("d")) ?? "";
  const stoppedFoot = (await foot.getAttribute("transform")) ?? "";
  await page.evaluate(async () => {
    for (let frame = 0; frame < 5; frame++) {
      await new Promise<number>((resolve) => requestAnimationFrame(resolve));
    }
  });
  expect(await wheel.getAttribute("cx")).toBe(stoppedAt);
  expect(await leg.getAttribute("d")).toBe(stoppedLeg);
  expect(await foot.getAttribute("transform")).toBe(stoppedFoot);

  await preview.getByRole("slider", { name: "骑行速度" }).press("End");
  await expect(preview.locator("#speed-display")).toHaveText("3 倍速");
  await preview.getByRole("button", { name: "播放" }).click();
  await expect(preview.getByRole("button", { name: "暂停动画" })).toBeVisible();
  await expect(wheel).not.toHaveAttribute("cx", stoppedAt);
  await expect(leg).not.toHaveAttribute("d", stoppedLeg);
  await expect(foot).not.toHaveAttribute("transform", stoppedFoot);
  await expect(preview.locator("#isolation")).toHaveText("undefined/undefined");

  await panel.getByRole("button", { name: "源码", exact: true }).click();
  await expect(panel.locator("pre")).toContainText("requestAnimationFrame");
  await expect(iframe).toHaveCount(0);
  await expect(task.getByRole("link", { name: file.name })).toHaveAttribute(
    "download",
    file.name,
  );
  expect(outgoing).toEqual([]);
});

test("网关超时后核对已收取的小序消息并恢复成果，不重复发送", async ({
  page,
}) => {
  await setup(page);
  const prompt = "请生成带 SVG 动画的 HTML 文件。";
  const reply = "已完成 SVG 动画文件。";
  const requests: string[] = [];
  let finished = false;
  await page.route("**/api/v1/my-workspace/assistant", (route) => {
    if (route.request().method() === "POST") {
      const { requestId } = route.request().postDataJSON();
      requests.push(requestId);
      return route.fulfill({
        status: 504,
        contentType: "text/html",
        body: "<h1>Gateway Timeout</h1>",
      });
    }
    return route.fulfill({
      json: {
        data: {
          ready: true,
          version: finished ? 2 : requests.length,
          state: finished || !requests.length ? "IDLE" : "PENDING",
          messages: requests
            .map((id) => ({ id, role: "user", text: prompt }))
            .concat(
              finished ? [{ id: "reply", role: "assistant", text: reply }] : [],
            ),
        },
      },
    });
  });
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  const textbox = composer.getByPlaceholder(/告诉我你想完成什么/);
  await textbox.fill(prompt);
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  const chat = page.getByRole("dialog", { name: "AI 个人助理" });
  const error = chat.getByText("服务暂时不可用，请重试。", { exact: true });
  await expect(chat.getByText("正在核对发送结果…")).toBeVisible();
  await expect(error).toHaveCount(0);
  finished = true;
  await expect(chat.getByText(reply, { exact: true })).toBeVisible();
  await expect(textbox).toHaveValue("");
  await expect(error).toHaveCount(0);
  expect(requests).toHaveLength(1);
});

test("服务未收取消息时保留错误及草稿，同文旧回复不能当作成功", async ({
  page,
}) => {
  await setup(page);
  const prompt = "请生成带 SVG 动画的 HTML 文件。";
  let posts = 0;
  await page.route("**/api/v1/my-workspace/assistant", (route) => {
    if (route.request().method() === "POST") {
      posts++;
      return route.fulfill({
        status: 503,
        contentType: "text/html",
        body: "<h1>Service Unavailable</h1>",
      });
    }
    return route.fulfill({
      json: {
        data: {
          ready: true,
          version: 2,
          state: "IDLE",
          messages: [
            { id: "old-request", role: "user", text: prompt },
            { id: "old-reply", role: "assistant", text: "上一次已完成。" },
          ],
        },
      },
    });
  });
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  const textbox = composer.getByPlaceholder(/告诉我你想完成什么/);
  await textbox.fill(prompt);
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  const chat = page.getByRole("dialog", { name: "AI 个人助理" });
  await expect(chat.getByText("服务暂时不可用，请重试。")).toBeVisible();
  await expect(textbox).toHaveValue(prompt);
  expect(posts).toBe(1);
});

test("核对发现已接收消息但模型失败时，保留服务器原因和原稿", async ({
  page,
}) => {
  await setup(page);
  const prompt = "请生成带 SVG 动画的 HTML 文件。";
  const reason = "模型请求失败，请稍后再试。";
  const requests: string[] = [];
  await page.route("**/api/v1/my-workspace/assistant", (route) => {
    if (route.request().method() === "POST") {
      const { requestId } = route.request().postDataJSON();
      requests.push(requestId);
      return route.fulfill({
        status: 504,
        contentType: "text/html",
        body: "<h1>Gateway Timeout</h1>",
      });
    }
    return route.fulfill({
      json: {
        data: {
          ready: true,
          version: requests.length ? 2 : 0,
          state: requests.length ? "FAILED" : "IDLE",
          error: requests.length ? reason : "",
          messages: requests.map((id) => ({ id, role: "user", text: prompt })),
        },
      },
    });
  });
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  const textbox = composer.getByPlaceholder(/告诉我你想完成什么/);
  await textbox.fill(prompt);
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  const chat = page.getByRole("dialog", { name: "AI 个人助理" });
  await expect(chat.getByText(reason)).toBeVisible();
  await expect(textbox).toHaveValue(prompt);
  expect(requests).toHaveLength(1);
});

import {
  openPersonalAssistant,
  selectAssistantPanel,
} from "./assistant-controls.js";
import { expect, test, type Page } from "@playwright/test";
const fileId = "11111111-1111-4111-8111-111111111111";
const resultId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const previewId = "44444444-4444-4444-8444-444444444444";
async function setup(page: Page, mode = "dark") {
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
  await page.route("**/api/v1/**", async (route) => {
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
          { id: "engine/default", name: "通用助手", vision: true },
          { id: "engine/deep", name: "深度思考", vision: false },
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
          assistant.version++;
          assistant.messages.push(
            { id: body.requestId, role: "user", text: body.message },
            {
              id: `reply-${body.requestId}`,
              role: "assistant",
              text:
                body.webOpenResult === "blocked"
                  ? "浏览器阻止了新窗口，请点击下方“打开百度”继续。"
                  : "已在新标签页打开百度，当前对话保留。",
              webNavigation: { title: "百度", url: "https://www.baidu.com/" },
            },
          );
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
test("附件、能力、联网与任务下载形成完整流程，历史回复隐藏型号", async ({
  page,
}) => {
  const requests = await setup(page);
  await page.goto("/my-workspace");
  await page
    .locator(".workspace-ai-core-stage")
    .hover({ position: { x: 20, y: 20 } });
  await page.getByRole("button", { name: "打开私有备忘", exact: true }).click();
  await page
    .getByRole("textbox", { name: "私有备忘", exact: true })
    .fill("同页投影保留未保存备忘");
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await openPersonalAssistant(page);
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText(/GPT|OpenRouter|DeepSeek|openai\//i);
  await dialog.getByLabel("上传助理附件").setInputFiles({
    name: "资料.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("测试库存：条码001234567890123456789 数量12"),
  });
  await expect(dialog.locator(".agent-attachments")).toContainText("资料.txt");
  await dialog.getByRole("combobox", { name: "助理能力" }).click();
  await page.getByText("深度分析", { exact: true }).last().click();
  await dialog.getByRole("checkbox", { name: "联网", exact: true }).check();
  await dialog
    .getByPlaceholder(/告诉我你想完成什么/)
    .fill("将附件整理成Word周报，并核查公开参考资料");
  await dialog.getByRole("button", { name: "发送给个人助理" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({
    model: "engine/deep",
    attachmentIds: [fileId],
    webSearch: true,
  });
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
  await page
    .locator(".workspace-ai-core-stage")
    .hover({ position: { x: 20, y: 20 } });
  await page.getByRole("button", { name: "打开私有备忘", exact: true }).click();
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
  await page
    .getByRole("button", { name: "展开小序状态与动态", exact: true })
    .click();
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
test("亮色窄屏保留附件入口和中性能力名称", async ({ page }) => {
  await setup(page, "light");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-workspace?assistant=tasks");
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(dialog).toBeVisible();
  await selectAssistantPanel(page, "互动对话");
  await expect(
    dialog.getByRole("button", { name: "附件", exact: true }),
  ).toBeVisible();
  await expect(dialog).not.toContainText(/GPT|OpenRouter|DeepSeek|openai\//i);
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.width).toBeLessThanOrEqual(390);
  const sender = dialog.locator(".ant-sender");
  await expect(
    sender.getByRole("button", { name: "电脑授权：网站内" }),
  ).toBeVisible();
  await expect(
    sender.getByRole("button", { name: "开始智能语音对话" }),
  ).toBeVisible();
  expect(
    await sender.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({ path: ".local/assistant-agent-light-mobile.png" });
});

test("输入框内选择电脑、显示真实授权并撤销，不从网页开启设备授权", async ({
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
  await expect(
    composer.getByRole("button", { name: "开始智能语音对话" }),
  ).toBeVisible();
  await page.screenshot({ path: ".local/assistant-composer-home.png" });
  await composer.getByRole("button", { name: "电脑授权：网站内" }).click();
  await page.getByRole("combobox", { name: "执行位置" }).click();
  await expect(page.getByTitle("离线电脑 · 离线")).toHaveClass(/disabled/);
  await page.getByText("测试电脑", { exact: true }).last().click();
  await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
  await expect(
    composer.getByRole("button", { name: "电脑授权：跨窗口授权" }),
  ).toBeVisible();
  await expect(page.locator(".assistant-access-menu")).toContainText(
    "已记住此设备授权",
  );
  expect(mutations).toHaveLength(0);
  await page.screenshot({
    path: ".local/assistant-composer-authorization.png",
  });
  await page
    .getByRole("button", { name: "撤销跨窗口授权", exact: true })
    .click();
  await expect(
    composer.getByRole("button", { name: "电脑授权：逐次允许" }),
  ).toBeVisible();
  expect(mutations).toHaveLength(1);
  const input = composer.getByPlaceholder(/描述电脑任务/);
  await input.fill("打开百度");
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].desktopDeviceId).toBe(desktopId);
  expect(requests[0]).not.toHaveProperty("authorizationId");
  expect(requests[0]).not.toHaveProperty("webOpenResult");
  expect(page.context().pages()).toHaveLength(1);
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

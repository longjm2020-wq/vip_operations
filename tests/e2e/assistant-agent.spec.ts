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
  await page.screenshot({ path: ".local/assistant-agent-light-mobile.png" });
});

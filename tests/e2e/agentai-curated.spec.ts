import { test, expect, type Page } from "@playwright/test";
import { agentaiAllowedModels } from "../../packages/contracts/src/agentai-policy.js";

async function fixture(page: Page) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const tasks: Record<string, unknown>[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (request.method() === "POST")
      writes.push({ path, body: request.postDataJSON() });
    if (path === "/auth/me")
      data = {
        id: "1",
        username: "test",
        displayName: "测试管理员",
        roleCodes: ["SUPER_ADMIN"],
        permissions: [
          "analytics.manage",
          "analytics.read",
          "aigc.use",
          "aigc.manage",
        ],
        csrfToken: "fixture",
      };
    if (path === "/my-workspace/appearance")
      data = { version: 0, mode: "dark" };
    if (path === "/my-workspace/assistant")
      data = {
        ready: true,
        state: "IDLE",
        messages: [],
        model: "openai/test",
        version: 0,
      };
    if (path === "/my-workspace/assistant/memory")
      data = { version: 0, entries: [] };
    if (path === "/my-workspace/assistant/desktop")
      data = { devices: [], tasks: [] };
    if (path === "/my-workspace/assistant/realtime")
      data = {
        ready: false,
        enabled: false,
        provider: "qwen",
        version: 0,
        profiles: {},
      };
    if (path === "/my-workspace/assistant/voice")
      data = { ready: false, enabled: false, version: 0, maxSeconds: 25 };
    if (path === "/ai-model-management")
      data = { features: [], days: 30, generatedAt: new Date().toISOString() };
    if (
      path === "/ai-model-management/agentai" ||
      path === "/ai-model-management/agentai/prices"
    )
      data = {
        enabled: true,
        endpoint: "https://agentai.token6688.com/v1",
        apiKeyConfigured: true,
        encryptionReady: true,
        version: 1,
        verifiedAt: "2026-11-18T00:00:00Z",
        catalogAt: "2026-11-18T00:00:00Z",
        pricesAt: "2026-11-18T00:00:00Z",
        errorNote: "",
        strategy: "balanced",
        models: agentaiAllowedModels.map((m) => ({
          ...m,
          id: "agentai/" + m.model,
          vision: m.type === "chat",
          available: true,
          parameters: [],
          pdf: false,
          chatVerifiedAt: null,
          toolsVerifiedAt: null,
          structuredVerifiedAt: null,
          pricing: {
            currency: "CNY",
            generatedAt: "2026-11-18T00:00:00Z",
            channels: [
              {
                vendor: "channel-a",
                laneNo: 1,
                billingUnit: m.type === "chat" ? "token" : "per_second",
                billingMethod: m.type === "chat" ? "按Token" : "按秒",
                defaultTotalRmb: 3,
                inputPerMillionRmb: m.type === "chat" ? 1.25 : null,
                outputPerMillionRmb: m.type === "chat" ? 5 : null,
                successRate24h: 95,
                avgResponseSeconds: 0,
                statsSource: "estimate",
              },
            ],
          },
        })),
      };
    if (path === "/ai-model-management/agentai/audio")
      data = {
        ready: true,
        maxCharacters: 5000,
        consentStatementVersion: "voice-v1",
        voices: [
          {
            id: "female-tianmei",
            name: "甜美女声",
            model: "speech-2.8",
            status: "ready",
            custom: false,
          },
        ],
        tasks,
      };
    if (path === "/ai-model-management/agentai/audio/estimate")
      data = {
        quoteId: "104f91f3-a5df-4ab9-b18a-26cb4c5f2b05",
        model: "speech-2.8",
        characters: 4,
        estimatedCny: 0.03,
        maxCny: 0.05,
        freezeCny: 0.05,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
    if (path === "/ai-model-management/agentai/audio/speech") {
      const task = {
        id: "e5669073-dfd4-483c-a43f-6124fbcd4bfb",
        kind: "speech",
        model: "speech-2.8",
        name: "语音制作测试",
        status: "processing",
        providerTaskId: "provider-test",
        voiceId: null,
        characters: 4,
        estimatedCny: 0.03,
        maxCny: 0.05,
        errorNote: "",
        resultHref: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      tasks.push(task);
      data = task;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/settings/ai");
  await page.getByRole("button", { name: "AgentAI 连接", exact: true }).click();
  return { writes };
}

test("curated models display account prices without mislabelling whole-job estimates or fabricated live stats", async ({
  page,
}) => {
  await fixture(page);
  const dialog = page.getByRole("dialog", { name: "AgentAI 模型连接" });
  await expect(dialog.getByText("20 个模型", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("输入 ¥1.25 / 百万 Token", { exact: true }).first(),
  ).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "搜索 AgentAI 模型" })
    .fill("seedance-2-5-special");
  const row = dialog.locator('tr[data-row-key="agentai/seedance-2-5-special"]');
  await expect(row.getByText("¥3", { exact: true })).toBeVisible();
  await expect(row.getByText("默认参数整单参考价")).toBeVisible();
  await row.locator(".ant-table-row-expand-icon").click();
  await expect(
    dialog.getByText("默认参数整单 ¥3", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("估测数据，暂无实测表现")).toBeVisible();
  await expect(dialog.getByText("成功率 95%", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("平均耗时 0 秒", { exact: true })).toHaveCount(
    0,
  );
});

test("speech requires a current parameter quote and explicit cost confirmation; cloning requires unchecked consent", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  const connection = page.getByRole("dialog", { name: "AgentAI 模型连接" });
  await connection
    .getByRole("button", { name: "语音制作", exact: true })
    .first()
    .click();
  const audio = page.getByRole("dialog", { name: "语音制作", exact: true });
  await audio.getByRole("textbox", { name: "待合成文字" }).fill("连接测试");
  await audio.getByRole("button", { name: "查看本次价格" }).click();
  await expect(
    audio.getByText("本次预估 ¥0.03，备用渠道上界 ¥0.05"),
  ).toBeVisible();
  expect(writes.filter((w) => w.path.endsWith("/speech"))).toHaveLength(0);
  await audio.getByRole("textbox", { name: "待合成文字" }).fill("修改后的文字");
  await expect(
    audio.getByRole("button", { name: "确认费用并生成语音" }),
  ).toHaveCount(0);
  await audio.getByRole("button", { name: "查看本次价格" }).click();
  await audio.getByRole("button", { name: "确认费用并生成语音" }).click();
  await expect(audio.getByText("语音制作测试", { exact: true })).toBeVisible();
  const submissions = writes.filter((w) => w.path.endsWith("/speech"));
  expect(submissions).toHaveLength(1);
  expect(submissions[0].body).toMatchObject({
    quoteId: "104f91f3-a5df-4ab9-b18a-26cb4c5f2b05",
    requestId: expect.any(String),
  });
  await audio.getByRole("tab", { name: "克隆音色" }).click();
  await expect(audio.getByRole("checkbox")).not.toBeChecked();
  await expect(
    audio.getByRole("button", { name: "确认授权并创建音色" }),
  ).toBeDisabled();
  await page.screenshot({
    path: test.info().outputPath("agentai-audio-consent.png"),
    fullPage: true,
  });
});

test("a delayed quote cannot be attached to text edited while the quote was loading", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole("dialog", { name: "AgentAI 模型连接" })
    .getByRole("button", { name: "语音制作", exact: true })
    .first()
    .click();
  const audio = page.getByRole("dialog", { name: "语音制作", exact: true });
  let release!: () => void, requested!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route(
    "**/api/v1/ai-model-management/agentai/audio/estimate",
    async (route) => {
      requested();
      await pending;
      await route.fulfill({
        json: {
          data: {
            quoteId: "104f91f3-a5df-4ab9-b18a-26cb4c5f2b05",
            model: "speech-2.8",
            characters: 4,
            estimatedCny: 0.03,
            maxCny: 0.05,
            freezeCny: 0.05,
            expiresAt: new Date(Date.now() + 300000).toISOString(),
          },
        },
      });
    },
  );
  await audio.getByRole("textbox", { name: "待合成文字" }).fill("原来的文字");
  await audio.getByRole("button", { name: "查看本次价格" }).click();
  await started;
  await audio.getByRole("textbox", { name: "待合成文字" }).fill("新的文字");
  release();
  await expect(
    audio.getByRole("button", { name: "查看本次价格" }),
  ).toBeEnabled();
  await expect(
    audio.getByRole("button", { name: "确认费用并生成语音" }),
  ).toHaveCount(0);
});

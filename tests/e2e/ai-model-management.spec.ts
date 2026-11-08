import { test, expect, type Page } from "@playwright/test";
import {
  aiFeatures,
  type AiManagementRow,
} from "../../packages/contracts/src/ai-management.js";

async function fixture(page: Page, superAdmin = true) {
  const changes: Record<string, unknown>[] = [],
    connectionChanges: Record<string, unknown>[] = [],
    verifications: string[] = [],
    sessions: string[] = [];
  const connection = {
    enabled: true,
    model: "openai/gpt-6.1-sol",
    encryptionReady: true,
    apiKeyConfigured: true,
    verifiedAt: null as string | null,
  };
  const usage = {
    requests: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    amounts: [],
    firstRecordedAt: null,
    lastSuccessAt: null,
    lastModel: null,
    lastError: null,
  };
  const currentFeatures = aiFeatures.filter((f) => f.id !== "deerflow_team");
  const features: AiManagementRow[] = currentFeatures.map((f) => ({
    ...f,
    model: f.kind === "fixed" ? "浏览器服务" : "openai/gpt-6.1-sol",
    selection: "",
    revision: 0,
    source:
      f.kind === "realtime"
        ? "阿里云百炼 · 北京业务空间 / WebRTC"
        : "OpenRouter · https://openrouter.ai/api/v1",
    status: f.kind === "fixed" ? "local" : "configured",
    statusText: f.kind === "fixed" ? "浏览器支持" : "已配置；当前型号待验证",
    choices: [
      {
        value: "",
        label: "系统默认",
        available: true,
        source: "OpenRouter",
        boundary: "默认",
      },
      {
        value: "fixture-b",
        label: "视觉模型 B",
        available: true,
        source: "OpenRouter",
        boundary: "图片和结构化输出",
      },
    ],
    mode:
      f.kind === "fixed"
        ? "fixed"
        : f.group === "语音"
          ? "voice"
          : f.kind === "external"
            ? "aigc"
            : "select",
    usage: { ...usage },
    usageNote: "只统计供应商真实回执；未返回的消耗为未知。",
  }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: () => {
        throw new Error("Settings must not start the microphone");
      },
    });
  });
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (path.includes("/sessions")) sessions.push(path);
    if (path === "/auth/me")
      data = {
        id: "1",
        username: "test",
        displayName: "管理测试",
        roleCodes: superAdmin ? ["SUPER_ADMIN"] : ["ADMIN"],
        permissions: [
          "analytics.manage",
          "analytics.read",
          "product.read",
          "aigc.use",
          "aigc.manage",
        ],
        csrfToken: "fixture",
      };
    if (path === "/my-workspace/appearance")
      data = { version: 0, mode: "dark" };
    if (path === "/my-workspace")
      data = {
        version: 0,
        note: "",
        todos: [],
        schedule: [],
        shortcuts: [],
        available: [],
        defaults: { name: "工作台", description: "", tools: [] },
      };
    if (path === "/my-workspace/content") data = { items: [], hasMore: false };
    if (path === "/my-workspace/activity")
      data = { items: [], serverTime: new Date().toISOString() };
    if (path === "/my-workspace/assistant")
      data = {
        ready: true,
        model: "openai/gpt-6.1-sol",
        version: 0,
        state: "IDLE",
        error: "",
        messages: [],
      };
    if (path === "/my-workspace/assistant/memory")
      data = { version: 0, entries: [] };
    if (path === "/my-workspace/assistant/desktop")
      data = { devices: [], tasks: [] };
    if (path === "/my-workspace/assistant/voice")
      data = {
        ready: false,
        enabled: false,
        model: "openai/gpt-audio",
        voice: "coral",
        canManage: true,
        version: 0,
        maxSeconds: 25,
        assistantReady: true,
        encryptionReady: true,
        apiKeyConfigured: false,
      };
    if (path === "/my-workspace/assistant/realtime")
      data = {
        provider: "openai",
        enabled: false,
        ready: false,
        voice: "marin",
        canManage: true,
        version: 0,
        encryptionReady: true,
        apiKeyConfigured: false,
        verifiedAt: null,
        error: "",
      };
    if (path === "/analytics/compass/ai-settings") {
      if (req.method() === "POST") {
        const input = req.postDataJSON();
        connectionChanges.push(input);
        connection.enabled = input.enabled;
        if (input.clearKey) {
          connection.apiKeyConfigured = false;
          connection.verifiedAt = null;
        }
      }
      data = connection;
    }
    if (path === "/analytics/compass/ai-test") {
      verifications.push(path);
      connection.verifiedAt = new Date().toISOString();
      data = { model: connection.model };
    }
    if (path === "/ai-model-management") {
      if (req.method() === "POST") {
        const input = req.postDataJSON();
        changes.push(input);
        const row = features.find((f) => f.id === input.feature)!;
        row.selection = input.model;
        row.model = "provider/vision-b";
        row.revision++;
        data = { revision: row.revision };
      } else
        data = {
          features,
          days: Number(url.searchParams.get("days")),
          generatedAt: new Date().toISOString(),
          recordingSince: "2026-11-08T00:00:00Z",
          catalogNotice: "目录列出不代表密钥均能调用；未知用量不记为零。",
        };
    }
    await route.fulfill({ json: { data } });
  });
  return { changes, sessions, connectionChanges, verifications };
}

test("Bailian chat copies a saved connection without changing the default and verifies only on request", async ({
  page,
}) => {
  const existing = await fixture(page);
  let value: any = {
    enabled: false,
    workspaceId: "",
    model: "deepseek-v4.1-flash-1017",
    endpoint: "",
    apiKeyConfigured: false,
    encryptionReady: true,
    verifiedAt: null,
    errorNote: "",
    version: 0,
    reuseAvailable: true,
    reuseWorkspaceId: "ws-fixture12345678",
  };
  let saved: any,
    calls = 0;
  await page.route(
    "**/api/v1/ai-model-management/bailian-chat",
    async (route) => {
      if (route.request().method() === "POST") {
        saved = route.request().postDataJSON();
        value = {
          ...value,
          enabled: saved.enabled,
          workspaceId: saved.workspaceId,
          apiKeyConfigured: true,
          version: 1,
        };
      }
      await route.fulfill({ json: { data: value } });
    },
  );
  await page.route(
    "**/api/v1/ai-model-management/bailian-chat/test",
    async (route) => {
      calls++;
      value = { ...value, verifiedAt: new Date().toISOString() };
      await route.fulfill({ json: { data: value } });
    },
  );
  await page.goto("/settings/ai");
  await page
    .getByRole("button", { name: "百炼聊天连接", exact: true })
    .first()
    .click();
  const drawer = page.getByRole("dialog", {
    name: "百炼聊天连接",
    exact: true,
  });
  await drawer.getByText("使用已保存的百炼语音连接", { exact: true }).click();
  await expect(drawer.getByLabel("百炼北京业务空间 ID")).toHaveValue(
    "ws-fixture12345678",
  );
  await drawer.getByRole("switch", { name: "启用百炼聊天" }).click();
  await drawer
    .getByRole("button", { name: "保存聊天连接", exact: true })
    .click();
  await expect(
    drawer.getByRole("button", { name: "验证 DeepSeek 连接" }),
  ).toBeEnabled();
  expect(saved).toMatchObject({
    enabled: true,
    workspaceId: "ws-fixture12345678",
    useSavedQwenConnection: true,
    apiKey: "",
  });
  expect(calls).toBe(0);
  expect(existing.changes).toEqual([]);
  await drawer.getByRole("button", { name: "验证 DeepSeek 连接" }).click();
  await expect(
    drawer.getByText("聊天连接已验证", { exact: true }),
  ).toBeVisible();
  expect(calls).toBe(1);
  expect(existing.changes).toEqual([]);
});

test("shared connection preserves the saved key and does not verify a disabled service", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/settings/ai");
  await page
    .getByRole("button", { name: "OpenRouter 连接配置", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "OpenRouter 连接",
    exact: true,
  });
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveValue("");
  await dialog.getByRole("button", { name: "保存并验证", exact: true }).click();
  await expect(dialog.getByText("连接已验证", { exact: true })).toBeVisible();
  expect(f.connectionChanges).toEqual([{ enabled: true }]);
  expect(f.verifications).toHaveLength(1);
  await dialog.getByRole("switch", { name: "启用连接" }).click();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByText("已关闭", { exact: true })).toBeVisible();
  expect(f.connectionChanges).toEqual([{ enabled: true }, { enabled: false }]);
  expect(f.verifications).toHaveLength(1);
  await dialog.getByRole("button", { name: "清除密钥", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByRole("dialog", {
      name: "清除 OpenRouter API Key？",
      exact: true,
    }),
  ).toBeHidden();
  expect(f.connectionChanges).toHaveLength(2);
  await page.screenshot({
    path: test.info().outputPath("compact-connection.png"),
  });
});

test("management lists actual sources, persists a per-feature model and filters entries", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/settings/ai");
  await expect(
    page.getByRole("heading", { name: "AI 模型管理", exact: true }),
  ).toBeVisible();
  await expect(page.locator("tr[data-row-key]")).toHaveCount(19);
  await expect(page.getByText("已配置；当前型号待验证").first()).toBeVisible();
  await page.getByRole("combobox", { name: "小序互动对话的默认模型" }).click();
  await page.getByText("视觉模型 B", { exact: true }).click();
  await expect
    .poll(() => f.changes)
    .toEqual([{ feature: "assistant_chat", model: "fixture-b", revision: 0 }]);
  await expect(
    page.getByText("provider/vision-b", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator('tr[data-row-key="assistant_team"]')
      .getByText("智能体团队", { exact: true }),
  ).toBeVisible();
  await expect(page.locator('tr[data-row-key="deerflow_team"]')).toHaveCount(0);
  await page.getByRole("textbox", { name: "搜索 AI 功能" }).fill("商品");
  await expect(page.locator("tr[data-row-key]")).toHaveCount(2);
  await expect(page.getByText("积分 / 金额：未知").first()).toBeVisible();
  await page.getByRole("textbox", { name: "搜索 AI 功能" }).fill("");
  await page.screenshot({
    path: test.info().outputPath("ai-management-desktop.png"),
    fullPage: true,
  });
});

test("voice configuration and direct links do not start a call", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/settings/ai");
  await page
    .locator('tr[data-row-key="voice_realtime"]')
    .getByRole("button", { name: "切换 / 配置" })
    .click();
  await expect(
    page.getByRole("dialog").getByText("实时通话", { exact: true }),
  ).toBeVisible();
  expect(f.sessions).toEqual([]);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .locator('tr[data-row-key="browser_dictation"]')
    .getByRole("button", { name: "切换 / 配置" })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("combobox", { name: "语音模型", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText(
    "麦克风听写与分段语音使用同一识别模型",
  );
  expect(f.sessions).toEqual([]);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("link", { name: "打开小序实时语音通话" }).click();
  await expect(page).toHaveURL(/assistant=voice/);
  await expect(page.getByText("小序的声音", { exact: false })).toBeVisible();
  expect(f.sessions).toEqual([]);
});

test("mobile keeps the wide comparison inside a scrollable table", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.goto("/settings/ai");
  await expect(
    page.getByRole("heading", { name: "AI 模型管理", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(
    await page
      .locator(".ai-management .ant-table-content")
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("ai-management-mobile.png"),
    fullPage: true,
  });
});

test("non-super-admin cannot access the management interface", async ({
  page,
}) => {
  await fixture(page, false);
  await page.goto("/settings/ai");
  await expect(
    page.getByText("仅超级管理员可以配置 AI 模型", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".ai-management")).toHaveCount(0);
});

test("Qwen audio configuration reuses the saved connection without exposing a credential or starting a call", async ({
  page,
}) => {
  const f = await fixture(page);
  const writes: Record<string, unknown>[] = [];
  let version = 0;
  await page.route("**/api/v1/my-workspace/assistant/realtime", (route) =>
    route.fulfill({
      json: {
        data: {
          provider: "qwen",
          enabled: true,
          ready: true,
          canManage: true,
          version: 2,
          voice: "Mia",
          apiKeyConfigured: true,
          encryptionReady: true,
          verifiedAt: "2026-11-08T00:00:00Z",
          error: "",
          profiles: {
            qwen: {
              voice: "Mia",
              apiKeyConfigured: true,
              workspaceId: "ws-test",
              verifiedAt: "2026-11-08T00:00:00Z",
              error: "",
            },
          },
        },
      },
    }),
  );
  await page.route(
    "**/api/v1/my-workspace/assistant/voice**",
    async (route) => {
      if (route.request().method() === "POST") {
        writes.push(route.request().postDataJSON());
        version++;
      }
      await route.fulfill({
        json: {
          data: {
            provider: version ? "qwen" : "openrouter",
            enabled: !!version,
            ready: false,
            canManage: true,
            version,
            model: version ? "qwen3.8-omni-flash" : "openai/gpt-audio",
            voice: version ? "Serena" : "coral",
            speechModel: version ? "qwen3-tts-flash" : "openai/gpt-audio",
            workspaceId: version ? "ws-test" : undefined,
            apiKeyConfigured: !!version,
            encryptionReady: true,
            verifiedAt: null,
            error: "",
            maxSeconds: 25,
            assistantReady: true,
          },
        },
      });
    },
  );
  await page.goto("/settings/ai");
  await page
    .locator('tr[data-row-key="browser_dictation"]')
    .getByRole("button", { name: "切换 / 配置" })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "音频服务", exact: true }).click();
  await page.getByText("千问 · 北京", { exact: true }).click();
  await expect(
    dialog.getByText("qwen3.8-omni-flash", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "朗读模型" })).toHaveValue(
    "qwen3-tts-flash",
  );
  await dialog
    .getByRole("checkbox", { name: "使用已保存的千问实时语音连接" })
    .check();
  await dialog.getByRole("switch", { name: "启用分段语音与听写" }).click();
  await expect(
    dialog.getByRole("button", { name: "验证并试听" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "保存语音设置" }).click();
  await expect
    .poll(() => writes)
    .toEqual([
      {
        version: 0,
        provider: "qwen",
        enabled: true,
        model: "qwen3.8-omni-flash",
        voice: "Serena",
        workspaceId: "ws-test",
        useRealtimeCredentials: true,
        clearKey: false,
      },
    ]);
  await expect(
    dialog.getByRole("button", { name: "验证并试听" }),
  ).toBeEnabled();
  await expect(
    dialog.getByLabel("千问北京 API Key", { exact: true }),
  ).toHaveValue("");
  expect(f.sessions).toEqual([]);
});

import { expect, test, type Page } from "@playwright/test";
import { agentaiAllowedModels } from "../../packages/contracts/src/agentai-policy.js";
import {
  evaluateAndAllocateSmartModels,
  smartPresetWeights,
  defaultSmartFilterPolicy,
  type RawChannelCandidate,
  type RelayStationView,
  type SmartModelsSettingsState,
} from "../../packages/contracts/src/smart-models.js";

async function setupSmartMock(page: Page) {
  const settings: SmartModelsSettingsState = {
    enabled: true,
    preset: "balanced",
    weights: smartPresetWeights.balanced,
    filterPolicy: defaultSmartFilterPolicy,
    rolePolicies: {},
    channelOverrides: [],
    version: 1,
  };
  const stations: RelayStationView[] = [];
  const baseRaw: RawChannelCandidate[] = [
    {
      channelKey: "agentai:gpt-6.1-sol:good:1",
      stationId: "agentai",
      stationName: "AgentAI",
      stationKind: "agentai",
      modelId: "gpt-6.1-sol",
      modelRef: "agentai/gpt-6.1-sol",
      modelName: "GT-6.1 Sol",
      category: "chat",
      available: true,
      vision: true,
      tools: true,
      structured: true,
      verified: true,
      vendor: "channel-good",
      laneNo: 1,
      billingUnit: "token",
      billingMethod: "按Token",
      defaultTotalRmb: null,
      inputPerMillionRmb: 1.5,
      outputPerMillionRmb: 6,
      successRate24h: 98.8,
      avgResponseSeconds: 2.5,
      statsSource: "live",
      localTelemetry: null,
    },
    {
      channelKey: "agentai:gpt-6.1-sol:bad:2",
      stationId: "agentai",
      stationName: "AgentAI",
      stationKind: "agentai",
      modelId: "gpt-6.1-sol",
      modelRef: "agentai/gpt-6.1-sol",
      modelName: "GT-6.1 Sol",
      category: "chat",
      available: true,
      vision: true,
      tools: true,
      structured: true,
      verified: true,
      vendor: "channel-bad",
      laneNo: 2,
      billingUnit: "token",
      billingMethod: "按Token",
      defaultTotalRmb: null,
      inputPerMillionRmb: 1.4,
      outputPerMillionRmb: 5.5,
      successRate24h: 65,
      avgResponseSeconds: 12,
      statsSource: "live",
      localTelemetry: null,
    },
  ];

  const overview = () => {
    const stationRaw: RawChannelCandidate[] = stations.flatMap((st) =>
      st.models.flatMap((m) =>
        m.channels.map((ch, idx) => ({
          channelKey: `relay:${st.id}:${m.model}:${ch.vendor}:${idx}`,
          stationId: st.id,
          stationName: st.name,
          stationKind: "relay" as const,
          modelId: m.model,
          modelRef: `relay/${st.id}/${m.model}`,
          modelName: m.name,
          category: m.category,
          available: true,
          vision: m.vision,
          tools: m.tools,
          structured: m.structured,
          verified: Boolean(m.verifiedAt),
          vendor: ch.vendor,
          laneNo: ch.laneNo,
          billingUnit: ch.billingUnit,
          billingMethod: ch.billingMethod,
          defaultTotalRmb: ch.defaultTotalRmb,
          inputPerMillionRmb: ch.inputPerMillionRmb,
          outputPerMillionRmb: ch.outputPerMillionRmb,
          successRate24h: ch.successRate24h,
          avgResponseSeconds: ch.avgResponseSeconds,
          statsSource: ch.statsSource,
          localTelemetry: null,
        })),
      ),
    );
    const evaluated = evaluateAndAllocateSmartModels(
      [...baseRaw, ...stationRaw],
      settings,
    );
    return {
      settings,
      encryptionReady: true,
      stations,
      ...evaluated,
      generatedAt: new Date().toISOString(),
    };
  };

  await page.route("**/api/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api/v1", "");
    let data: unknown = [];

    if (path === "/auth/me") {
      data = {
        id: "1",
        username: "test",
        displayName: "测试管理员",
        roleCodes: ["SUPER_ADMIN"],
        permissions: ["analytics.manage", "analytics.read", "aigc.use", "aigc.manage"],
        csrfToken: "fixture",
      };
    } else if (path === "/my-workspace/appearance") {
      data = { version: 0, mode: "dark" };
    } else if (path === "/my-workspace/assistant") {
      data = { ready: true, state: "IDLE", messages: [], model: "openai/test", version: 0 };
    } else if (path === "/my-workspace/assistant/memory") {
      data = { version: 0, entries: [] };
    } else if (path === "/my-workspace/assistant/desktop") {
      data = { devices: [], tasks: [] };
    } else if (path === "/my-workspace/assistant/realtime") {
      data = { ready: false, enabled: false, provider: "qwen", version: 0, profiles: {} };
    } else if (path === "/my-workspace/assistant/voice") {
      data = { ready: false, enabled: false, version: 0, maxSeconds: 25 };
    } else if (path === "/ai-model-management") {
      data = { features: [], days: 30, generatedAt: new Date().toISOString() };
    } else if (path === "/ai-model-management/agentai") {
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
            channels:
              m.model === "gpt-6.1-sol"
                ? [
                    {
                      vendor: "channel-good",
                      laneNo: 1,
                      billingUnit: "token",
                      billingMethod: "按Token",
                      defaultTotalRmb: null,
                      inputPerMillionRmb: 1.5,
                      outputPerMillionRmb: 6,
                      billedSeconds: null,
                      successRate24h: 98.8,
                      avgResponseSeconds: 2.5,
                      statsSource: "live",
                    },
                    {
                      vendor: "channel-bad",
                      laneNo: 2,
                      billingUnit: "token",
                      billingMethod: "按Token",
                      defaultTotalRmb: null,
                      inputPerMillionRmb: 1.4,
                      outputPerMillionRmb: 5.5,
                      billedSeconds: null,
                      successRate24h: 65,
                      avgResponseSeconds: 12,
                      statsSource: "live",
                    },
                  ]
                : [],
          },
        })),
      };
    } else if (path === "/ai-model-management/smart") {
      data = overview();
    } else if (path === "/ai-model-management/smart/stations") {
      const body = req.postDataJSON();
      const created: RelayStationView = {
        id: "11111111-1111-4111-8111-111111111111",
        name: body.name || "relay.test",
        baseUrl: body.baseUrl,
        protocol: "auto",
        enabled: true,
        apiKeyConfigured: true,
        verifiedAt: null,
        catalogAt: null,
        pricesAt: null,
        errorNote: "",
        version: 1,
        modelCount: 0,
        categoryCounts: { chat: 0, image: 0, video: 0, audio: 0, other: 0 },
        models: [],
      };
      stations.push(created);
      data = created;
    } else if (path.endsWith("/sync")) {
      const st = stations[0];
      st.protocol = "openai";
      st.verifiedAt = new Date().toISOString();
      st.catalogAt = new Date().toISOString();
      st.models = [
        {
          model: "deepseek-v4.1-flash-1017",
          name: "DeepSeek V4.1 Flash",
          category: "chat",
          available: true,
          vision: true,
          tools: true,
          structured: true,
          verifiedAt: new Date().toISOString(),
          channels: [
            {
              vendor: "极速通道",
              laneNo: 1,
              billingUnit: "token",
              billingMethod: "按Token",
              defaultTotalRmb: null,
              billedSeconds: null,
              inputPerMillionRmb: 0.3,
              outputPerMillionRmb: 1.2,
              successRate24h: 99,
              avgResponseSeconds: 1.5,
              statsSource: "live",
            },
          ],
        },
        {
          model: "gpt-image-2.6-sunburst",
          name: "ChatGPT Image 2.6",
          category: "image",
          available: true,
          vision: true,
          tools: false,
          structured: false,
          channels: [
            {
              vendor: "官方直连",
              laneNo: 1,
              billingUnit: "per_call",
              billingMethod: "按次",
              defaultTotalRmb: 0.25,
              billedSeconds: null,
              inputPerMillionRmb: null,
              outputPerMillionRmb: null,
              successRate24h: 98.5,
              avgResponseSeconds: 11,
              statsSource: "live",
            },
          ],
        },
      ];
      st.modelCount = 2;
      st.categoryCounts = { chat: 1, image: 1, video: 0, audio: 0, other: 0 };
      data = st;
    } else if (path === "/ai-model-management/smart/apply") {
      data = {
        applied: [{ feature: "assistant_chat", model: "relay/1/deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash", reason: "智选最优" }],
        skipped: [],
      };
    }

    await route.fulfill({ json: { data } });
  });

  await page.goto("/settings/ai");
}

test("AgentAI channel table filters low-scoring channels and smart model hub connects relay stations", async ({
  page,
}) => {
  await setupSmartMock(page);

  // 1. Verify AgentAI auto-shielding hides low-success channel by default and allows inspecting it.
  await page.getByRole("button", { name: "AgentAI 连接", exact: true }).click();
  const agentDialog = page.getByRole("dialog", { name: "AgentAI 模型连接" });
  const solRow = agentDialog.locator('tr[data-row-key="agentai/gpt-6.1-sol"]');
  await expect(solRow.getByText("已屏蔽 1")).toBeVisible();
  await solRow.locator(".ant-table-row-expand-icon").click();
  await expect(agentDialog.getByText("channel-good · 1")).toBeVisible();
  await expect(agentDialog.getByText("channel-bad · 2")).toHaveCount(0);
  await agentDialog.getByRole("button", { name: /查看已屏蔽渠道/ }).click();
  await expect(agentDialog.getByText("channel-bad · 2")).toBeVisible();
  await agentDialog.getByRole("button", { name: "关闭", exact: true }).click();

  // 2. Verify Smart Model Hub connects a new relay station, classifies models, and applies allocations.
  await page.getByRole("button", { name: /智选模型/ }).click();
  const smartDialog = page.getByRole("dialog", { name: "智选模型与算力中转站" });
  await smartDialog.getByRole("textbox", { name: "中转站名称" }).fill("测试极速中转站");
  await smartDialog
    .getByRole("textbox", { name: "中转站链接" })
    .fill("https://relay.example.com/v1");
  await smartDialog
    .getByRole("textbox", { name: "中转站 API Key" })
    .fill("sk-test-relay-key-123456");
  await smartDialog.getByRole("button", { name: /接入并智能解析/ }).click();

  await expect(smartDialog.getByText("测试极速中转站").first()).toBeVisible();
  await expect(smartDialog.getByText("已解析 2 模型")).toBeVisible();
  await expect(smartDialog.getByText("DeepSeek V4.1 Flash").first()).toBeVisible();
  await expect(smartDialog.getByText("ChatGPT Image 2.6").first()).toBeVisible();

  await smartDialog.getByRole("button", { name: /一键应用智选方案/ }).click();
  await expect(page.getByText(/已应用 1 项默认配置/)).toBeVisible();
});

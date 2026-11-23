import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import type { Context } from "../../apps/api/src/core.js";
import type { Tx } from "../../packages/database/src/index.js";
import { installAiManagementSchema } from "../fixtures/ai-management-schema.js";

const fixture = vi.hoisted(() => ({ db: null as PGlite | null }));

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === "private-dns.test") {
      return [{ address: "10.0.0.5", family: 4 }];
    }
    return [{ address: "93.184.216.34", family: 4 }];
  }),
}));

vi.mock("../../packages/database/src/index.js", async (original) => {
  const real =
    await original<typeof import("../../packages/database/src/index.js")>();
  const wrap = (db: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) =>
      sql.includes("pg_advisory_xact_lock")
        ? []
        : (await db.query(sql, args)).rows,
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) =>
      (await db.query(sql, args)).affectedRows || 0,
  });
  return {
    ...real,
    db: {
      $queryRawUnsafe: (sql: string, ...args: unknown[]) =>
        wrap(fixture.db!).$queryRawUnsafe(sql, ...args),
      $executeRawUnsafe: (sql: string, ...args: unknown[]) =>
        wrap(fixture.db!).$executeRawUnsafe(sql, ...args),
      $transaction: (fn: (tx: Tx) => Promise<unknown>) =>
        fixture.db!.transaction((tx) => fn(wrap(tx) as unknown as Tx)),
    },
  };
});

import {
  classifySmartModel,
  defaultSmartFilterPolicy,
  evaluateAgentAiPricingChannels,
  evaluateAndAllocateSmartModels,
  smartPresetWeights,
  type RawChannelCandidate,
  type SmartModelsSettingsState,
} from "../../packages/contracts/src/smart-models.js";
import {
  applySmartAllocations,
  deleteRelayStation,
  normalizeRelayBaseUrl,
  probeRelayStationModel,
  readSmartModelsOverview,
  relayModelCandidates,
  saveRelayStation,
  saveSmartModelPolicy,
  syncRelayStation,
} from "../../apps/api/src/modules/workspace/smart-models.js";
import { connectedModelRefs } from "../../apps/api/src/ai-model-connections.js";
import {
  agentModelCandidates,
  resolveChatModel,
} from "../../apps/api/src/modules/workspace/agent-models.js";
import { resolveTeamModel } from "../../apps/api/src/modules/workspace/team-models.js";
import { aiModelManagement } from "../../apps/api/src/ai-model-management.js";

const admin = (): Context => ({
  actor: {
    id: "7",
    username: "admin",
    displayName: "Admin",
    permissions: ["analytics.manage", "aigc.use", "aigc.manage"],
    roleCodes: ["SUPER_ADMIN"],
  },
  requestId: randomUUID(),
  key: randomUUID(),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const defaultSettings = (): SmartModelsSettingsState => ({
  enabled: true,
  preset: "balanced",
  weights: smartPresetWeights.balanced,
  filterPolicy: defaultSmartFilterPolicy,
  rolePolicies: {},
  channelOverrides: [],
  version: 1,
});

describe("smart models evaluation and allocation engine", () => {
  it("classifies models accurately into chat, image, video, audio, and other", () => {
    expect(classifySmartModel("gpt-6.1-sol")).toBe("chat");
    expect(classifySmartModel("gpt-image-2.6-sunburst")).toBe("image");
    expect(classifySmartModel("gemini-nano-banana-2.1-image")).toBe("image");
    expect(classifySmartModel("seedance-2-5-promo")).toBe("video");
    expect(classifySmartModel("speech-2.8")).toBe("audio");
    expect(classifySmartModel("doubao-tts-2.0")).toBe("audio");
    expect(classifySmartModel("text-embedding-3-large")).toBe("other");
    expect(classifySmartModel("bge-reranker-v2")).toBe("other");
  });

  it("shields low-success, slow, and overpriced channels while keeping optimal channels", () => {
    const channels = evaluateAgentAiPricingChannels(
      "gpt-6.1-sol",
      "GT-6.1 Sol",
      "chat",
      [
        {
          vendor: "healthy-direct",
          laneNo: 1,
          billingUnit: "token",
          billingMethod: "按Token",
          defaultTotalRmb: null,
          billedSeconds: null,
          inputPerMillionRmb: 1.5,
          outputPerMillionRmb: 6,
          successRate24h: 99.1,
          avgResponseSeconds: 2.1,
          statsSource: "live",
        },
        {
          vendor: "unstable-lane",
          laneNo: 2,
          billingUnit: "token",
          billingMethod: "按Token",
          defaultTotalRmb: null,
          billedSeconds: null,
          inputPerMillionRmb: 1.4,
          outputPerMillionRmb: 5.5,
          successRate24h: 71.5,
          avgResponseSeconds: 3.0,
          statsSource: "live",
        },
        {
          vendor: "overpriced-lane",
          laneNo: 3,
          billingUnit: "token",
          billingMethod: "按Token",
          defaultTotalRmb: null,
          billedSeconds: null,
          inputPerMillionRmb: 15,
          outputPerMillionRmb: 60,
          successRate24h: 98.5,
          avgResponseSeconds: 4.0,
          statsSource: "live",
        },
        {
          vendor: "ultra-slow-lane",
          laneNo: 4,
          billingUnit: "token",
          billingMethod: "按Token",
          defaultTotalRmb: null,
          billedSeconds: null,
          inputPerMillionRmb: 1.5,
          outputPerMillionRmb: 6,
          successRate24h: 95,
          avgResponseSeconds: 80,
          statsSource: "live",
        },
      ],
      { vision: true, tools: true, structured: true, verified: true },
    );

    const healthy = channels.find((c) => c.vendor === "healthy-direct")!;
    const unstable = channels.find((c) => c.vendor === "unstable-lane")!;
    const overpriced = channels.find((c) => c.vendor === "overpriced-lane")!;
    const slow = channels.find((c) => c.vendor === "ultra-slow-lane")!;

    expect(healthy.shielded).toBe(false);
    expect(healthy.recommended).toBe(true);
    expect(unstable.shielded).toBe(true);
    expect(unstable.shieldReasons.some((r) => r.includes("成功率"))).toBe(true);
    expect(overpriced.shielded).toBe(true);
    expect(overpriced.shieldReasons.some((r) => r.includes("溢价"))).toBe(true);
    expect(slow.shielded).toBe(true);
    expect(slow.shieldReasons.some((r) => r.includes("超过上限"))).toBe(true);
  });

  it("allocates strong models to orchestrator, fast/cheap to executor, and latest image models to image_design", () => {
    const raw: RawChannelCandidate[] = [
      {
        channelKey: "c-flagship",
        stationId: "st1",
        stationName: "主力站",
        stationKind: "relay",
        modelId: "gpt-6.1-sol",
        modelRef: "relay/st1/gpt-6.1-sol",
        modelName: "GT-6.1 Sol",
        category: "chat",
        available: true,
        vision: true,
        tools: true,
        structured: true,
        verified: true,
        vendor: "official",
        laneNo: 1,
        billingUnit: "token",
        billingMethod: "按Token",
        defaultTotalRmb: null,
        inputPerMillionRmb: 12,
        outputPerMillionRmb: 48,
        successRate24h: 99.2,
        avgResponseSeconds: 6.5,
        statsSource: "live",
        localTelemetry: null,
      },
      {
        channelKey: "c-fast",
        stationId: "st1",
        stationName: "主力站",
        stationKind: "relay",
        modelId: "deepseek-v4.1-flash-1017",
        modelRef: "relay/st1/deepseek-v4.1-flash-1017",
        modelName: "DeepSeek V4.1 Flash",
        category: "chat",
        available: true,
        vision: true,
        tools: true,
        structured: true,
        verified: true,
        vendor: "direct",
        laneNo: 1,
        billingUnit: "token",
        billingMethod: "按Token",
        defaultTotalRmb: null,
        inputPerMillionRmb: 0.3,
        outputPerMillionRmb: 1.2,
        successRate24h: 98.8,
        avgResponseSeconds: 1.6,
        statsSource: "live",
        localTelemetry: null,
      },
      {
        channelKey: "c-img-old",
        stationId: "st1",
        stationName: "主力站",
        stationKind: "relay",
        modelId: "flux-schnell",
        modelRef: "relay/st1/flux-schnell",
        modelName: "Flux Schnell",
        category: "image",
        available: true,
        vision: false,
        tools: false,
        structured: false,
        verified: true,
        vendor: "fast",
        laneNo: 1,
        billingUnit: "per_call",
        billingMethod: "按次",
        defaultTotalRmb: 0.05,
        inputPerMillionRmb: null,
        outputPerMillionRmb: null,
        successRate24h: 97,
        avgResponseSeconds: 5,
        statsSource: "live",
        localTelemetry: null,
      },
      {
        channelKey: "c-img-26",
        stationId: "st1",
        stationName: "主力站",
        stationKind: "relay",
        modelId: "gpt-image-2.6-sunburst",
        modelRef: "relay/st1/gpt-image-2.6-sunburst",
        modelName: "ChatGPT Image 2.6",
        category: "image",
        available: true,
        vision: true,
        tools: false,
        structured: false,
        verified: true,
        vendor: "official",
        laneNo: 1,
        billingUnit: "per_call",
        billingMethod: "按次",
        defaultTotalRmb: 0.25,
        inputPerMillionRmb: null,
        outputPerMillionRmb: null,
        successRate24h: 98.5,
        avgResponseSeconds: 14,
        statsSource: "live",
        localTelemetry: null,
      },
      {
        channelKey: "c-vid-bad",
        stationId: "st1",
        stationName: "主力站",
        stationKind: "relay",
        modelId: "legacy-vid",
        modelRef: "relay/st1/legacy-vid",
        modelName: "Legacy Video",
        category: "video",
        available: true,
        vision: false,
        tools: false,
        structured: false,
        verified: true,
        vendor: "bad",
        laneNo: 1,
        billingUnit: "per_call",
        billingMethod: "按次",
        defaultTotalRmb: 2,
        inputPerMillionRmb: null,
        outputPerMillionRmb: null,
        successRate24h: 55,
        avgResponseSeconds: 40,
        statsSource: "live",
        localTelemetry: null,
      },
      {
        channelKey: "c-vid-25",
        stationId: "st1",
        stationName: "主力站",
        stationKind: "relay",
        modelId: "seedance-2-5",
        modelRef: "relay/st1/seedance-2-5",
        modelName: "Seedance 2.5 · 官方直连",
        category: "video",
        available: true,
        vision: false,
        tools: false,
        structured: false,
        verified: true,
        vendor: "official",
        laneNo: 1,
        billingUnit: "per_second",
        billingMethod: "按秒",
        defaultTotalRmb: 4.2,
        inputPerMillionRmb: null,
        outputPerMillionRmb: null,
        successRate24h: 97.5,
        avgResponseSeconds: 45,
        statsSource: "live",
        localTelemetry: null,
      },
    ];

    const result = evaluateAndAllocateSmartModels(raw, defaultSettings());
    const byRole = Object.fromEntries(
      result.roleAllocations.map((r) => [r.role, r]),
    );
    expect(byRole.orchestrator.primary?.modelId).toBe("gpt-6.1-sol");
    expect(byRole.executor.primary?.modelId).toBe("deepseek-v4.1-flash-1017");
    expect(byRole.image_design.primary?.modelId).toBe("gpt-image-2.6-sunburst");
    expect(byRole.video_production.primary?.modelId).toBe("seedance-2-5");
    expect(byRole.video_production.shieldedCount).toBe(1);
  });
});

describe("relay stations and smart routing DB integration", () => {
  beforeAll(async () => {
    fixture.db = new PGlite();
    await fixture.db.exec(`
      CREATE TABLE users(id bigint PRIMARY KEY);
      INSERT INTO users VALUES(7);
      CREATE TABLE compass_ai_settings(id int PRIMARY KEY,enabled bool,api_key_encrypted text,verified_at timestamptz,updated_at timestamptz DEFAULT now());
      INSERT INTO compass_ai_settings VALUES(1,false,NULL,NULL,now());
      CREATE TABLE assistant_voice_settings(id int PRIMARY KEY,enabled bool,provider text,model text,api_key_encrypted text,verified_at timestamptz,qwen_api_key_encrypted text,qwen_verified_at timestamptz,qwen_workspace_id text,updated_at timestamptz DEFAULT now());
      INSERT INTO assistant_voice_settings(id,enabled,provider,model) VALUES(1,false,'openrouter','openai/gpt-audio');
      CREATE TABLE assistant_realtime_settings(id int PRIMARY KEY,enabled bool,provider text,api_key_encrypted text,verified_at timestamptz,qwen_api_key_encrypted text,qwen_verified_at timestamptz,qwen_workspace_id text,qwen_free_only_confirmed bool,doubao_api_key_encrypted text,doubao_verified_at timestamptz,updated_at timestamptz DEFAULT now());
      INSERT INTO assistant_realtime_settings(id,enabled,provider) VALUES(1,false,'openai');
      CREATE TABLE aigc_settings(id int PRIMARY KEY,config jsonb,secrets_encrypted text,revision int,updated_at timestamptz DEFAULT now());
      INSERT INTO aigc_settings VALUES(1,'{}',NULL,1,now());
      CREATE TABLE aigc_state(id int PRIMARY KEY,document jsonb);
      INSERT INTO aigc_state VALUES(1,'{}');
      CREATE TABLE idempotency_records(id bigserial,actor_id bigint,operation text,idempotency_key text,request_hash text,response_status int,response_body jsonb);
      CREATE TABLE audit_logs(id bigserial,actor_id bigint,actor_label text,action text,entity_type text,entity_id text,request_id text,before_data jsonb,after_data jsonb,reason text);
    `);
    await installAiManagementSchema(fixture.db);
  }, 30000);

  afterAll(async () => {
    await fixture.db?.close();
  });

  beforeEach(async () => {
    vi.stubEnv("COMPASS_MAIL_KEY", "11".repeat(32));
    await fixture.db!.exec(
      "TRUNCATE ai_relay_stations,ai_feature_models,ai_model_usage,idempotency_records,audit_logs; UPDATE smart_model_settings SET enabled=true,preset='balanced',weights='{\"stability\":30,\"price\":25,\"speed\":20,\"quality\":25}',filter_policy='{\"minSuccessRate\":85,\"minScore\":60,\"maxPriceMultiplier\":2.5,\"maxChatLatencySeconds\":45,\"maxImageLatencySeconds\":120,\"maxVideoLatencySeconds\":300,\"maxAudioLatencySeconds\":90,\"hideShielded\":true,\"requireLiveStats\":false,\"autoShieldOnConsecutiveFailures\":2}',role_policies='{}',channel_overrides='[]',version=1;",
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("blocks private/unsafe relay URLs before network access", async () => {
    expect(() => normalizeRelayBaseUrl("http://relay.example.com/v1")).toThrow();
    expect(() => normalizeRelayBaseUrl("https://user:pass@relay.example.com/v1")).toThrow();
    expect(() => normalizeRelayBaseUrl("https://127.0.0.1/v1")).toThrow();
    expect(() => normalizeRelayBaseUrl("https://10.0.0.5/v1")).toThrow();
    expect(() => normalizeRelayBaseUrl("https://localhost/v1")).toThrow();
    expect(normalizeRelayBaseUrl("https://relay.example.com")).toBe(
      "https://relay.example.com/v1",
    );

    const st = await saveRelayStation(admin(), {
      name: "私网拦截站",
      baseUrl: "https://private-dns.test/v1",
      apiKey: "sk-relay-secret-1234567890",
      enabled: true,
    });
    await expect(syncRelayStation(admin(), st.id)).rejects.toMatchObject({
      response: { error: { code: "RELAY_HOST_BLOCKED" } },
    });
  });

  it("syncs relay station, auto-classifies 5 categories, probes chat model, and wires smart runtime routing", async () => {
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.startsWith("https://openrouter.ai/api/v1/")) {
        return json({ data: [] });
      }
      if (target === "https://relay.example.com/v1/models") {
        return json({
          data: [
            {
              id: "gpt-6.1-sol",
              name: "GT-6.1 Sol",
              supported_parameters: ["tools", "structured_outputs"],
              architecture: {
                input_modalities: ["text", "image"],
                output_modalities: ["text"],
              },
              channel_groups: [
                {
                  is_active: true,
                  vendor: "relay-official",
                  lane_no: 1,
                  billing_unit: "token",
                  billing_method: "按Token",
                  user_price_per_million_input_rmb: 10,
                  user_price_per_million_output_rmb: 40,
                  stats_source: "live",
                  success_rate_24h: 99,
                  avg_response_seconds: 5,
                },
                {
                  is_active: true,
                  vendor: "relay-bad",
                  lane_no: 2,
                  billing_unit: "token",
                  billing_method: "按Token",
                  user_price_per_million_input_rmb: 9,
                  user_price_per_million_output_rmb: 38,
                  stats_source: "live",
                  success_rate_24h: 60,
                  avg_response_seconds: 8,
                },
              ],
            },
            {
              id: "deepseek-v4.1-flash-1017",
              name: "DeepSeek V4.1 Flash",
              supported_parameters: ["tools", "structured_outputs"],
              architecture: {
                input_modalities: ["text"],
                output_modalities: ["text"],
              },
              channel_groups: [
                {
                  is_active: true,
                  vendor: "relay-fast",
                  lane_no: 1,
                  billing_unit: "token",
                  billing_method: "按Token",
                  user_price_per_million_input_rmb: 0.4,
                  user_price_per_million_output_rmb: 1.6,
                  stats_source: "live",
                  success_rate_24h: 98.5,
                  avg_response_seconds: 1.8,
                },
              ],
            },
            {
              id: "gemini-nano-banana-2.1-image",
              name: "Google Nano Banana 2.1",
              architecture: { output_modalities: ["image"] },
              user_price_rmb: 0.2,
              stats_source: "live",
              success_rate_24h: 98,
              avg_response_seconds: 9,
            },
            {
              id: "seedance-2-5",
              name: "Seedance 2.5",
              architecture: { output_modalities: ["video"] },
              user_price_rmb: 4.5,
              stats_source: "live",
              success_rate_24h: 96,
              avg_response_seconds: 40,
            },
            {
              id: "speech-2.8",
              name: "MMX Speech 2.8",
              architecture: { output_modalities: ["audio"] },
              user_price_rmb: 0.04,
              stats_source: "live",
              success_rate_24h: 97,
              avg_response_seconds: 4,
            },
            {
              id: "text-embedding-3-large",
              name: "Embedding 3 Large",
            },
          ],
        });
      }
      if (target === "https://relay.example.com/v1/logical-models") {
        return json({ detail: "not found" }, 404);
      }
      if (target === "https://relay.example.com/v1/skills/pricing?status=active") {
        return json({ detail: "not found" }, 404);
      }
      if (target === "https://relay.example.com/v1/chat/completions") {
        const body = JSON.parse(String(init?.body));
        const msg = String(body.messages?.[0]?.content || "");
        const token = msg.split(":").at(-1)?.trim() || "ok";
        return json({
          id: "chat-" + randomUUID(),
          model: body.model,
          choices: [{ finish_reason: "stop", message: { content: token } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }
      return json({}, 404);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const created = await saveRelayStation(admin(), {
      name: "极速聚合站",
      baseUrl: "https://relay.example.com",
      apiKey: "sk-relay-secret-token-12345",
      enabled: true,
    });
    expect(created.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(created)).not.toContain("sk-relay-secret-token");

    const synced = await syncRelayStation(admin(), created.id);
    expect(synced.protocol).toBe("openai");
    expect(synced.categoryCounts).toEqual({
      chat: 2,
      image: 1,
      video: 1,
      audio: 1,
      other: 1,
    });

    const candidatesBeforeProbe = await relayModelCandidates();
    expect(candidatesBeforeProbe.every((m) => !m.chatVerifiedAt)).toBe(true);
    expect((await connectedModelRefs(candidatesBeforeProbe)).size).toBe(0);

    await probeRelayStationModel(admin(), created.id, { model: "gpt-6.1-sol" });
    await probeRelayStationModel(admin(), created.id, {
      model: "deepseek-v4.1-flash-1017",
    });

    const candidatesAfterProbe = await relayModelCandidates();
    expect(candidatesAfterProbe.every((m) => !!m.chatVerifiedAt)).toBe(true);
    const connected = await connectedModelRefs(candidatesAfterProbe);
    expect(connected.size).toBe(2);

    const overview = await readSmartModelsOverview(admin());
    expect(overview.summary.shieldedChannels).toBe(1);
    const sol = overview.models.find((m) => m.modelId === "gpt-6.1-sol")!;
    expect(sol.activeChannels).toBe(1);
    expect(sol.shieldedChannels).toBe(1);

    const orch = overview.roleAllocations.find((r) => r.role === "orchestrator")!;
    const exec = overview.roleAllocations.find((r) => r.role === "executor")!;
    const img = overview.roleAllocations.find((r) => r.role === "image_design")!;
    expect(orch.primary?.modelId).toBe("gpt-6.1-sol");
    expect(exec.primary?.modelId).toBe("deepseek-v4.1-flash-1017");
    expect(img.primary?.modelId).toBe("gemini-nano-banana-2.1-image");

    const orchPicked = await resolveTeamModel({ orchestrator: true });
    const execPicked = await resolveTeamModel({ difficulty: "simple" });
    expect(orchPicked.actual).toBe("gpt-6.1-sol");
    expect(execPicked.actual).toBe("deepseek-v4.1-flash-1017");
    expect(orchPicked.selectionReason).toContain("智选模型");

    const applied = await applySmartAllocations(admin(), {
      roles: ["orchestrator", "executor"],
    });
    expect(applied.applied.some((a) => a.feature === "assistant_chat")).toBe(
      true,
    );

    const chatResolved = await resolveChatModel(undefined);
    expect(chatResolved.model.provider).toBe("relay");
    expect(chatResolved.model.actual).toBe("deepseek-v4.1-flash-1017");

    const mgmt = await aiModelManagement(admin());
    expect(
      mgmt.features.find((f) => f.id === "assistant_chat")?.source,
    ).toContain("relay.example.com");

    const updatedPolicy = await saveSmartModelPolicy(admin(), {
      ...overview.settings,
      preset: "cost_first",
      weights: smartPresetWeights.cost_first,
    });
    expect(updatedPolicy.settings.version).toBe(2);
    await expect(
      saveSmartModelPolicy(admin(), {
        ...overview.settings,
        version: 1,
      }),
    ).rejects.toMatchObject({
      response: { error: { code: "VERSION_CONFLICT" } },
    });

    await deleteRelayStation(admin(), created.id);
    expect(
      (await agentModelCandidates()).models.some((m) => m.provider === "relay"),
    ).toBe(false);
  });
});

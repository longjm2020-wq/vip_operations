import { bailianChatModel } from "../../packages/contracts/src/bailian-chat.js";
import {
  readBailianChat,
  saveBailianChat,
  testBailianChat,
  bailianChatEndpoint,
  bailianChatBody,
} from "../../apps/api/src/modules/workspace/bailian-chat.js";
import { askAssistantModel } from "../../apps/api/src/modules/workspace/assistant-model.js";
import {
  agentModelCandidates,
  publicAgentCatalog,
} from "../../apps/api/src/modules/workspace/agent-models.js";
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
import { readFile } from "node:fs/promises";
import { installAiManagementSchema } from "../fixtures/ai-management-schema.js";
import type { Context } from "../../apps/api/src/core.js";
import type { Tx } from "../../packages/database/src/index.js";

const fixture = vi.hoisted(() => ({ db: null as PGlite | null }));
vi.mock("../../packages/database/src/index.js", async (original) => {
  const real =
    await original<typeof import("../../packages/database/src/index.js")>();
  const wrap = (db: Pick<PGlite, "query">) => ({
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) =>
      sql.includes("pg_advisory_xact_lock")
        ? []
        : (await db.query(sql, params)).rows,
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) =>
      (await db.query(sql, params)).affectedRows || 0,
  });
  return {
    ...real,
    db: {
      $queryRawUnsafe: (sql: string, ...params: unknown[]) =>
        wrap(fixture.db!).$queryRawUnsafe(sql, ...params),
      $executeRawUnsafe: (sql: string, ...params: unknown[]) =>
        wrap(fixture.db!).$executeRawUnsafe(sql, ...params),
      $transaction: (work: (tx: Tx) => Promise<unknown>) =>
        fixture.db!.transaction((tx) => work(wrap(tx) as unknown as Tx)),
    },
  };
});
vi.mock("../../apps/api/src/modules/analytics/secrets.js", () => ({
  encryptionReady: () => true,
  decryptSecret: (key: string) =>
    key === "media-keys"
      ? JSON.stringify({
          XAI_API_KEY: "fixture-xai",
          XYLP_IMAGE_TT25_KEY: "fixture-image",
        })
      : "fixture-secret",
  encryptSecret: () => "encrypted",
}));
import {
  aiModelManagement,
  saveAiFeatureModel,
} from "../../apps/api/src/ai-model-management.js";
import {
  aiFetch,
  providerUsage,
  recordAiReceipt,
} from "../../apps/api/src/ai-metering.js";
import { featureModelRef } from "../../apps/api/src/ai-model-routing.js";
import { connectedModelRefs } from "../../apps/api/src/ai-model-connections.js";
import {
  modelRef,
  resolveFeatureModel,
} from "../../apps/api/src/modules/workspace/agent-models.js";
import { searchAgentWeb } from "../../apps/api/src/modules/workspace/agent-search.js";
import { resolveTeamModel } from "../../apps/api/src/modules/workspace/team-models.js";
import { engineConfig } from "../../apps/api/src/modules/aigc/config.js";

const admin = (): Context => ({
  actor: {
    id: "7",
    username: "admin",
    displayName: "Admin",
    permissions: [
      "analytics.read",
      "analytics.manage",
      "aigc.use",
      "aigc.manage",
    ],
    roleCodes: ["SUPER_ADMIN"],
  },
  requestId: randomUUID(),
  key: randomUUID(),
});
const errorCode = (code: string) => ({ response: { error: { code } } });
const query = async (sql: string) =>
  (await fixture.db!.query<Record<string, any>>(sql)).rows;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const vision = "google/test-vision",
  plain = "deepseek/test-text";
const catalogFetch = async (url: string | URL, init?: RequestInit) => {
  if (String(url).endsWith("/models"))
    return json({
      data: String(url).includes("images/")
        ? [
            {
              id: "openai/test-image",
              architecture: {
                output_modalities: ["image"],
                input_modalities: ["text", "image"],
              },
              supported_parameters: { aspect_ratio: { values: ["1:1"] } },
            },
          ]
        : [
            {
              id: vision,
              name: "Vision",
              created: 1,
              architecture: {
                output_modalities: ["text"],
                input_modalities: ["text", "image"],
              },
              supported_parameters: ["tools", "structured_outputs"],
            },
            {
              id: plain,
              name: "Plain",
              created: 2,
              architecture: {
                output_modalities: ["text"],
                input_modalities: ["text"],
              },
              supported_parameters: ["tools"],
            },
          ],
    });
  const body = JSON.parse(String(init?.body));
  return json({
    id: randomUUID(),
    model: body.model,
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: "公开信息",
          annotations: [
            {
              type: "url_citation",
              url_citation: { url: "https://example.com", title: "公开来源" },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15,
      cost: 0.00000123,
    },
  });
};
beforeAll(async () => {
  fixture.db = new PGlite();
  await fixture.db.exec(`
    CREATE TABLE users(id bigint PRIMARY KEY); INSERT INTO users VALUES(7);
    CREATE TABLE compass_ai_settings(id int PRIMARY KEY,enabled bool,api_key_encrypted text,verified_at timestamptz,updated_at timestamptz DEFAULT now());
    INSERT INTO compass_ai_settings(id,enabled,api_key_encrypted,verified_at) VALUES(1,true,'shared-key',now()-interval '1 day');
    CREATE TABLE assistant_voice_settings(id int PRIMARY KEY,enabled bool,model text,api_key_encrypted text,verified_at timestamptz,updated_at timestamptz DEFAULT now());
    INSERT INTO assistant_voice_settings(id,enabled,model) VALUES(1,false,'openai/gpt-audio');
    CREATE TABLE assistant_realtime_settings(id int PRIMARY KEY,enabled bool,provider text,api_key_encrypted text,verified_at timestamptz,qwen_api_key_encrypted text,qwen_verified_at timestamptz,qwen_workspace_id text,qwen_free_only_confirmed bool,doubao_api_key_encrypted text,doubao_verified_at timestamptz,updated_at timestamptz DEFAULT now());
    INSERT INTO assistant_realtime_settings(id,enabled,provider) VALUES(1,false,'openai');
    CREATE TABLE aigc_settings(id int PRIMARY KEY,config jsonb,secrets_encrypted text,revision int,updated_at timestamptz DEFAULT now()); INSERT INTO aigc_settings(id,config,secrets_encrypted,revision) VALUES(1,'{}','media-keys',1);
    CREATE TABLE aigc_state(id int PRIMARY KEY,document jsonb); INSERT INTO aigc_state VALUES(1,'{}');
    CREATE TABLE idempotency_records(id bigserial,actor_id bigint,operation text,idempotency_key text,request_hash text,response_status int,response_body jsonb);
    CREATE TABLE audit_logs(id bigserial,actor_id bigint,actor_label text,action text,entity_type text,entity_id text,request_id text,before_data jsonb,after_data jsonb,reason text);
  `);
  await installAiManagementSchema(fixture.db);
  await fixture.db.exec(
    await readFile(
      "packages/database/migrations/092_qwen_segmented_voice.sql",
      "utf8",
    ),
  );
}, 30000);
beforeEach(async () => {
  await fixture.db!.exec(
    "UPDATE bailian_chat_settings SET enabled=false,workspace_id='',api_key_encrypted=NULL,verified_at=NULL,last_test_at=NULL,error_note='',version=0,updated_at=now(); UPDATE assistant_realtime_settings SET qwen_api_key_encrypted=NULL,qwen_workspace_id=''",
  );
  await fixture.db!.exec(
    "UPDATE assistant_voice_settings SET provider='openrouter',enabled=false,qwen_api_key_encrypted=NULL,qwen_verified_at=NULL,qwen_workspace_id=''",
  );
  await fixture.db!.exec(
    "TRUNCATE ai_feature_models,ai_model_usage,idempotency_records,audit_logs; UPDATE compass_ai_settings SET enabled=true,api_key_encrypted='shared-key',verified_at=now()-interval '1 day',updated_at=now()",
  );
  vi.stubGlobal("fetch", vi.fn(catalogFetch));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await fixture.db?.close();
});

it("tracks H3 by task id without inventing tokens or currency and does not double count polling", async () => {
  const source = "ws-fixture12345678.cn-beijing.maas.aliyuncs.com";
  vi.stubGlobal("fetch", async () =>
    json({
      request_id: "submission",
      output: { task_id: "h3-task", task_status: "PENDING" },
    }),
  );
  await (
    await aiFetch(
      "aigc_video",
      `https://${source}/api/v1/services/aigc/video-generation/video-synthesis`,
      { method: "POST", body: JSON.stringify({ model: "MiniMax/MiniMax-H3" }) },
    )
  ).json();
  const receipt = {
    request_id: "poll-different-id",
    output: {
      task_id: "h3-task",
      task_status: "SUCCEEDED",
      video_url: "https://media.example.test/video.mp4",
    },
    usage: {
      input_seconds: 3,
      output_seconds: 4,
      image_count: 2,
      total_seconds: 7,
    },
  };
  await recordAiReceipt("aigc_video", source, "MiniMax/MiniMax-H3", receipt);
  await recordAiReceipt("aigc_video", source, "MiniMax/MiniMax-H3", receipt);
  const records = await query(
    "SELECT * FROM ai_model_usage WHERE feature_id='aigc_video'",
  );
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    provider_request_id: "h3-task",
    status: "success",
    amount: null,
    total_tokens: null,
    response_model: null,
  });
  expect(Number(records[0].input_video_seconds)).toBe(3);
  expect(Number(records[0].output_video_seconds)).toBe(4);
  expect(Number(records[0].billable_images)).toBe(2);
  vi.stubGlobal("fetch", vi.fn(catalogFetch));
  const video = (await aiModelManagement(admin())).features.find(
    (feature) => feature.id === "aigc_video",
  )!;
  expect(video.choices.map((choice) => choice.value)).toEqual([
    "bailian|minimax-h3",
  ]);
  expect(video.usage).toMatchObject({
    requests: 1,
    unknown: 0,
    inputVideoSeconds: 3,
    outputVideoSeconds: 4,
    billableImages: 2,
    totalTokens: null,
    amounts: [],
  });
});
it("separates engine usage and defaults without merging historical receipts", async () => {
  await fixture.db!.exec(`
    INSERT INTO ai_model_usage(id,feature_id,source,model,response_model,status,total_tokens,amount,amount_unit,completed_at) VALUES
    (gen_random_uuid(),'deerflow_team','openrouter.ai','legacy/model','legacy/model','success',10,0.2,'USD',now()),
    (gen_random_uuid(),'mastra_team','openrouter.ai','mastra/model','mastra/model','success',25,0.3,'OpenRouter credits',now());
    INSERT INTO ai_model_usage(id,feature_id,source,status) VALUES(gen_random_uuid(),'mastra_team','openrouter.ai','failed');
  `);
  const features = (await aiModelManagement(admin())).features;
  expect(features.find((f) => f.id === "assistant_team")!.usage.requests).toBe(
    0,
  );
  expect(features.find((f) => f.id === "deerflow_team")!.usage).toMatchObject({
    requests: 1,
    totalTokens: 10,
    amounts: [{ unit: "USD", amount: 0.2 }],
  });
  const mastra = features.find((f) => f.id === "mastra_team")!;
  expect(mastra.source).toContain("Mastra");
  expect(mastra.usage).toMatchObject({
    requests: 2,
    failed: 1,
    unknown: 1,
    totalTokens: 25,
    amounts: [{ unit: "OpenRouter credits", amount: 0.3 }],
  });
  for (const feature of ["mastra_team", "deerflow_team"] as const) {
    await saveAiFeatureModel(admin(), {
      feature,
      model: modelRef(vision),
      revision: 0,
    });
    expect(
      (await resolveTeamModel({ feature, orchestrator: true })).actual,
    ).toBe(vision);
  }
  expect(
    (await aiModelManagement(admin())).features.find(
      (f) => f.id === "assistant_team",
    )!.selection,
  ).toBe("");
});

describe("connected models in the public chat menu", () => {
  const models = [
    { id: "engine/connected", actual: "google/connected" },
    { id: "engine/other", actual: "openai/other" },
  ];
  beforeEach(async () => {
    await query(
      "UPDATE compass_ai_settings SET api_key_encrypted='shared-key',updated_at=now()-interval '1 day'",
    );
  });
  const receipt = async (
    model: string,
    status: string,
    minutes = 1,
    feature = "assistant_chat",
    source = "openrouter.ai",
  ) => {
    await fixture.db!.query(
      `INSERT INTO ai_model_usage(id,feature_id,source,model,response_model,status,started_at,completed_at)
       VALUES($1::uuid,$2,$3,$4,$4,$5,now()-($6::int*interval '1 minute'),now())`,
      [randomUUID(), feature, source, model, status, minutes],
    );
  };
  it("hides untested models and uses real receipts without sending verification requests", async () => {
    expect(await connectedModelRefs(models)).toEqual(new Set());
    await receipt(models[0].actual, "success");
    expect(await connectedModelRefs(models)).toEqual(new Set([models[0].id]));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("hides a model after its latest failed or unverified response and restores it after success", async () => {
    await receipt(models[0].actual, "success", 5);
    await receipt(models[0].actual, "failed", 3);
    await receipt(models[1].actual, "responded", 1);
    expect(await connectedModelRefs(models)).toEqual(new Set());
    await receipt(models[0].actual, "success", 1);
    expect(await connectedModelRefs(models)).toEqual(new Set([models[0].id]));
  });
  it("rejects stale credentials and receipts from independent audio, AIGC or provider connections", async () => {
    await receipt(models[0].actual, "success", 1500);
    await receipt(models[0].actual, "success", 3, "browser_dictation");
    await receipt(models[0].actual, "success", 2, "aigc_compile");
    await receipt(
      models[0].actual,
      "success",
      1,
      "assistant_chat",
      "api.openai.com",
    );
    await receipt(models[1].actual, "started");
    expect(await connectedModelRefs(models)).toEqual(new Set());
    await receipt(models[0].actual, "success", 1, "compass_analysis");
    expect(await connectedModelRefs(models)).toEqual(new Set([models[0].id]));
    await query("UPDATE compass_ai_settings SET updated_at=now()");
    expect(await connectedModelRefs(models)).toEqual(new Set());
  });
  it.each(["enabled=false", "api_key_encrypted=NULL", "verified_at=NULL"])(
    "hides every model when the shared connection has %s",
    async (setting) => {
      await receipt(models[0].actual, "success");
      await query(`UPDATE compass_ai_settings SET ${setting}`);
      expect(await connectedModelRefs(models)).toEqual(new Set());
    },
  );
});

describe("AI model administration and real routing", () => {
  it("requires both super admin and analytics management before reading settings", async () => {
    for (const actor of [
      { ...admin().actor, roleCodes: [] },
      { ...admin().actor, permissions: [] },
    ]) {
      await expect(
        aiModelManagement({ ...admin(), actor }),
      ).rejects.toMatchObject(errorCode("FORBIDDEN"));
      await expect(
        saveAiFeatureModel({ ...admin(), actor }, {}),
      ).rejects.toMatchObject(errorCode("FORBIDDEN"));
    }
  });
  it("registers all actual capabilities, exposes safe API sources and distinguishes unknown from zero", async () => {
    const view = await aiModelManagement(admin());
    expect(view.features).toHaveLength(21);
    expect(view.features.filter((row) => row.group === "团队")).toMatchObject([
      { id: "assistant_team", name: "网站智能体团队" },
      { id: "deerflow_team", name: "DeerFlow 智能体团队" },
      { id: "mastra_team", name: "Mastra 智能体团队" },
    ]);
    expect(view.features.find((f) => f.id === "compass_analysis")?.href).toBe(
      "/analytics/compass",
    );
    const title = view.features.find((f) => f.id === "product_titles")!;
    expect(title.choices.map((c) => c.value)).toContain(modelRef(vision));
    expect(title.choices.map((c) => c.value)).not.toContain(modelRef(plain));
    const chat = view.features.find((f) => f.id === "assistant_chat")!;
    expect(chat.choices.map((c) => c.value)).toContain(modelRef(vision));
    expect(chat.choices.map((c) => c.value)).not.toContain(modelRef(plain));
    expect(chat.boundary).toContain("多模态");
    expect(title.status).toBe("configured");
    expect(title.usage.totalTokens).toBeNull();
    expect(title.usage.amounts).toEqual([]);
    expect(JSON.stringify(view)).not.toMatch(
      /fixture-secret|fixture-xai|fixture-image|shared-key|media-keys/,
    );
    expect(view.features.find((f) => f.id === "browser_dictation")?.mode).toBe(
      "voice",
    );
    expect(
      view.features.find((f) => f.id === "browser_dictation"),
    ).toMatchObject({
      model: "openai/gpt-audio",
      source: "OpenRouter · 独立音频密钥",
      status: "disabled",
    });
    await expect(
      saveAiFeatureModel(admin(), {
        feature: "product_titles",
        model: modelRef(plain),
        revision: 0,
      }),
    ).rejects.toMatchObject(errorCode("AI_MODEL_UNAVAILABLE"));
    await expect(
      saveAiFeatureModel(admin(), {
        feature: "assistant_chat",
        model: modelRef(plain),
        revision: 0,
      }),
    ).rejects.toMatchObject(errorCode("AI_MODEL_UNAVAILABLE"));
  });
  it("shows Qwen recognition and speech models separately with actual character usage", async () => {
    await fixture.db!.exec(
      "UPDATE assistant_voice_settings SET enabled=true,provider='qwen',qwen_api_key_encrypted='qwen-key',qwen_workspace_id='ws-test',qwen_verified_at=now()",
    );
    await fixture.db!.query(
      "INSERT INTO ai_model_usage(id,feature_id,source,model,status,input_characters) VALUES($1::uuid,'voice_audio','ws-test.cn-beijing.maas.aliyuncs.com','qwen3-tts-flash','responded',8)",
      [randomUUID()],
    );
    const view = await aiModelManagement(admin());
    expect(
      view.features.find((f) => f.id === "browser_dictation"),
    ).toMatchObject({ model: "qwen3.8-omni-flash", status: "ready" });
    const voice = view.features.find((f) => f.id === "voice_audio")!;
    expect(voice.model).toContain("识别：qwen3.8-omni-flash");
    expect(voice.model).toContain("朗读：qwen3-tts-flash");
    expect(voice.source).toContain("阿里云百炼");
    expect(voice.usage).toMatchObject({
      inputCharacters: 8,
      unknown: 0,
      amounts: [],
    });
    expect(JSON.stringify(view)).not.toContain("qwen-key");
  });
  it("changes persisted defaults, enforces compare-and-save, and does not rewrite other functions", async () => {
    const c = admin();
    const input = {
      feature: "product_titles",
      model: modelRef(vision),
      revision: 0,
    };
    const saved = await saveAiFeatureModel(c, input);
    expect((await resolveFeatureModel("product_titles")).actual).toBe(vision);
    expect(await featureModelRef("compass_analysis")).toBeUndefined();
    expect(await saveAiFeatureModel(c, input)).toEqual(saved);
    await expect(
      saveAiFeatureModel(admin(), { ...input, model: "" }),
    ).rejects.toMatchObject(errorCode("VERSION_CONFLICT"));
    await saveAiFeatureModel(admin(), {
      ...input,
      model: "",
      revision: saved.revision,
    });
    expect((await resolveFeatureModel("product_titles")).actual).toBe(
      "openai/gpt-6.1-sol",
    );
    expect(await query("SELECT * FROM audit_logs")).toHaveLength(2);
  });
  it("uses the managed search model in the outgoing API body and keeps team defaults independent", async () => {
    await saveAiFeatureModel(admin(), {
      feature: "assistant_search",
      model: modelRef(vision),
      revision: 0,
    });
    await searchAgentWeb(
      { api_key_encrypted: "key" },
      "openai/gpt-6.1-sol",
      '{"query":"公开产品信息"}',
      new AbortController().signal,
      () => false,
    );
    const recorded = await query(
      "SELECT model,total_tokens::text AS total,amount::text AS amount FROM ai_model_usage",
    );
    expect(recorded[0]).toMatchObject({
      model: vision,
      total: "15",
      amount: "0.00000123",
    });
    await saveAiFeatureModel(admin(), {
      feature: "assistant_team",
      model: modelRef(vision),
      revision: 0,
    });
    expect((await resolveTeamModel({})).actual).toBe(vision);
    await query(
      "INSERT INTO ai_model_usage(id,feature_id,source,model,response_model,status,started_at,completed_at) VALUES(gen_random_uuid(),'assistant_team','openrouter.ai','openai/gpt-6.1-sol','openai/gpt-6.1-sol','success',now(),now())",
    );
    expect(
      (await resolveTeamModel({ feature: "deerflow_team", orchestrator: true }))
        .actual,
    ).toBe("openai/gpt-6.1-sol");
    const row = (await aiModelManagement(admin())).features.find(
      (f) => f.id === "assistant_search",
    )!;
    expect(row.status).toBe("ready");
    expect(row.usage.amounts).toEqual([
      { unit: "OpenRouter credits", amount: 0.00000123 },
    ]);
  });
  it("passes AIGC choices into the running engine configuration and rejects missing provider keys", async () => {
    await saveAiFeatureModel(admin(), {
      feature: "aigc_compile",
      model: `openrouter|${vision}`,
      revision: 0,
    });
    await saveAiFeatureModel(admin(), {
      feature: "aigc_image",
      model: "tt-image-2.5-token",
      revision: 0,
    });
    const config = await engineConfig();
    expect(config.managedCompiler).toEqual({
      providerId: "openrouter",
      model: vision,
    });
    expect(config.keyframeImageModel).toBe("tt-image-2.5-token");
    await expect(
      saveAiFeatureModel(admin(), {
        feature: "aigc_compile",
        model: "xhai|gt-6-astra",
        revision: 2,
      }),
    ).rejects.toMatchObject(errorCode("AI_MODEL_UNAVAILABLE"));
  });
});

describe("provider receipts and metering", () => {
  it("passes SSE chunks unchanged and accounts only the final cumulative receipt", async () => {
    const raw =
      'data: {"id":"stream-1","model":"openai/gpt-6.1-sol","usage":{"prompt_tokens":10,"completion_tokens":1,"cost":0.1}}\n\ndata: {"id":"stream-1","usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"cost":0.15}}\n\ndata: [DONE]\n\n';
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const piece of [
                raw.slice(0, 41),
                raw.slice(41, 172),
                raw.slice(172),
              ])
                controller.enqueue(new TextEncoder().encode(piece));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const response = await aiFetch(
      "assistant_chat",
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "openai/gpt-6.1-sol",
          messages: [{ content: "private prompt" }],
        }),
      },
    );
    expect(await response.text()).toBe(raw);
    const saved = (await query("SELECT * FROM ai_model_usage"))[0];
    expect(Number(saved.total_tokens)).toBe(15);
    expect(Number(saved.amount)).toBe(0.15);
    expect(saved.status).toBe("success");
    expect(JSON.stringify(saved)).not.toContain("private prompt");
  });
  it("counts a duplicate provider receipt once and updates an asynchronous terminal bill", async () => {
    vi.stubGlobal("fetch", async () =>
      json({
        id: "same-receipt",
        model: "a",
        usage: { total_tokens: 3, cost: 0.02 },
      }),
    );
    for (let i = 0; i < 2; i++)
      await (
        await aiFetch(
          "assistant_chat",
          "https://openrouter.ai/api/v1/chat/completions",
          { body: '{"model":"a"}' },
        )
      ).json();
    expect(
      Number(
        (await query("SELECT sum(amount) AS amount FROM ai_model_usage"))[0]
          .amount,
      ),
    ).toBe(0.02);
    vi.stubGlobal("fetch", async () =>
      json({ task_id: "async-1", state: "pending" }),
    );
    await (
      await aiFetch("aigc_image", "https://media.test/generate", {
        body: '{"model":"image"}',
      })
    ).json();
    await recordAiReceipt("aigc_image", "media.test", "image", {
      task_id: "async-1",
      status: "completed",
      actual_cost_micro_usd: 14000,
    });
    await recordAiReceipt("aigc_image", "media.test", "image", {
      task_id: "async-1",
      status: "completed",
      actual_cost_micro_usd: 14000,
    });
    const rows = await query(
      "SELECT amount::text AS amount,amount_unit FROM ai_model_usage WHERE feature_id='aigc_image'",
    );
    expect(rows).toEqual([{ amount: "0.014", amount_unit: "USD" }]);
  });
  it("keeps unknown, zero, failed, and model mismatches distinct without storing raw errors", async () => {
    expect(
      providerUsage({ usage: { cost: 10 } }, "unknown.test").amount,
    ).toBeNull();
    expect(
      providerUsage({ usage: { total_tokens: 0, cost: 0 } }, "openrouter.ai"),
    ).toMatchObject({ total: 0, amount: 0 });
    vi.stubGlobal("fetch", async () =>
      json({ model: "different", usage: { total_tokens: 2 } }),
    );
    await (
      await aiFetch(
        "assistant_chat",
        "https://openrouter.ai/api/v1/chat/completions",
        { body: '{"model":"requested"}' },
      )
    ).json();
    expect((await query("SELECT status FROM ai_model_usage"))[0].status).toBe(
      "responded",
    );
    vi.stubGlobal(
      "fetch",
      async () => new Response("secret provider error", { status: 401 }),
    );
    await aiFetch(
      "assistant_chat",
      "https://openrouter.ai/api/v1/chat/completions",
    );
    const saved = (
      await query("SELECT * FROM ai_model_usage WHERE status='failed'")
    )[0];
    expect(saved.error_code).toBe("HTTP_401");
    expect(saved.total_tokens).toBeNull();
    expect(JSON.stringify(saved)).not.toContain("secret provider error");
  });
});

describe("Bailian DeepSeek chat", () => {
  const workspace = "ws-fixture12345678";
  const modelId = modelRef("bailian/" + bailianChatModel);
  const source = workspace + ".cn-beijing.maas.aliyuncs.com";
  const configure = async (verified = false) => {
    await fixture.db!.query(
      "UPDATE bailian_chat_settings SET enabled=true,workspace_id=$1,api_key_encrypted='bailian-key',verified_at=CASE WHEN $2 THEN now() ELSE NULL END,updated_at=now()-interval '1 minute'",
      [workspace, verified],
    );
  };
  it("isolates credentials, fixes Beijing endpoint and strips OpenRouter-only request fields", () => {
    expect(bailianChatEndpoint(workspace)).toBe(
      "https://" + source + "/compatible-mode/v1/chat/completions",
    );
    expect(() => bailianChatEndpoint("ws-test.evil.test")).toThrow();
    expect(
      bailianChatBody({
        model: "wrong",
        stream: true,
        provider: {},
        plugins: [{}],
        reasoning: {},
        messages: [],
        response_format: { type: "json_schema" },
        tools: [],
      }),
    ).toEqual({
      model: bailianChatModel,
      stream: false,
      enable_thinking: false,
      messages: [],
      response_format: { type: "json_object" },
      tools: [],
    });
  });
  it("copies the saved Qwen key server-side, invalidates verification and preserves the default and voice profile", async () => {
    await fixture.db!.query(
      "UPDATE assistant_realtime_settings SET qwen_api_key_encrypted='qwen-key',qwen_workspace_id=$1",
      [workspace],
    );
    const before = (
      await query("SELECT * FROM assistant_realtime_settings")
    )[0];
    const saved = await saveBailianChat(admin(), {
      version: 0,
      enabled: true,
      workspaceId: workspace,
      useSavedQwenConnection: true,
    });
    expect(saved).toMatchObject({
      apiKeyConfigured: true,
      verifiedAt: null,
      version: 1,
      reuseAvailable: true,
    });
    expect(JSON.stringify(saved)).not.toMatch(
      /fixture-secret|qwen-key|encrypted/,
    );
    expect(
      (await query("SELECT * FROM assistant_realtime_settings"))[0],
    ).toEqual(before);
    expect(await featureModelRef("assistant_chat")).toBeUndefined();
    expect(
      (await publicAgentCatalog()).models.some((m) => m.id === modelId),
    ).toBe(false);
    await expect(
      saveBailianChat(admin(), {
        version: 0,
        enabled: true,
        workspaceId: workspace,
      }),
    ).rejects.toMatchObject(errorCode("VERSION_CONFLICT"));
    await expect(
      readBailianChat({
        ...admin(),
        actor: { ...admin().actor, roleCodes: [] },
      }),
    ).rejects.toMatchObject(errorCode("FORBIDDEN"));
  });
  it("verifies vision, tool response and JSON using two real transport calls then lists only this provider receipt", async () => {
    await configure();
    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).includes("openrouter.ai"))
          return catalogFetch(url, init);
        expect(String(url)).toBe(bailianChatEndpoint(workspace));
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer fixture-secret",
        );
        return json({
          id: randomUUID(),
          model: bailianChatModel,
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
          choices: [
            bodies.length === 1
              ? {
                  finish_reason: "tool_calls",
                  message: {
                    tool_calls: [
                      {
                        id: "call-probe",
                        type: "function",
                        function: {
                          name: "connection_probe",
                          arguments: '{"color":"blue"}',
                        },
                      },
                    ],
                  },
                }
              : { finish_reason: "stop", message: { content: '{"ok":true}' } },
          ],
        });
      }),
    );
    const result = await testBailianChat(admin());
    expect(result.verifiedAt).toBeTruthy();
    expect(bodies).toHaveLength(2);
    expect(bodies[0].messages[0].content[1].image_url.url).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(bodies[1].messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call-probe",
    });
    expect(bodies[1].response_format).toEqual({ type: "json_object" });
    const catalog = await publicAgentCatalog();
    expect(catalog.models.map((m) => m.id)).toContain(modelId);
    expect(catalog.defaultModel).toBe(modelId);
    expect(catalog.fallbackNotice).toContain("已自动切换到");
    expect(catalog.models.find((m) => m.id === modelId)).toMatchObject({
      vision: true,
      structured: false,
      chatOnly: true,
    });
    const usage = await query(
      "SELECT source,model,total_tokens,amount FROM ai_model_usage ORDER BY started_at",
    );
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      source,
      model: bailianChatModel,
      total_tokens: "12",
      amount: null,
    });
    await expect(testBailianChat(admin())).rejects.toMatchObject(
      errorCode("BAILIAN_CHAT_TEST_BUSY"),
    );
    expect(bodies).toHaveLength(2);
    await saveBailianChat(admin(), {
      version: 0,
      enabled: true,
      workspaceId: workspace,
    });
    expect(
      (await publicAgentCatalog()).models.some((m) => m.id === modelId),
    ).toBe(false);
  });
  it("does not accept an OpenRouter receipt, incorrect returned model, or failed latest response as a Bailian connection", async () => {
    await configure(true);
    await fixture.db!.query(
      "INSERT INTO ai_model_usage(id,feature_id,source,model,response_model,status,started_at,completed_at) VALUES($1,'assistant_chat','openrouter.ai',$2,$2,'success',now(),now())",
      [randomUUID(), bailianChatModel],
    );
    expect(
      (await connectedModelRefs((await agentModelCandidates()).models)).has(
        modelId,
      ),
    ).toBe(false);
    vi.stubGlobal("fetch", async () =>
      json({
        id: randomUUID(),
        model: "wrong-model",
        choices: [{ message: { content: '{"ok":true}' } }],
      }),
    );
    await expect(testBailianChat(admin())).rejects.toMatchObject(
      errorCode("BAILIAN_CHAT_TEST_FAILED"),
    );
    expect((await readBailianChat(admin())).verifiedAt).toBeNull();
    expect(
      (await publicAgentCatalog()).models.some((m) => m.id === modelId),
    ).toBe(false);
  });
  it("routes selected chat to Bailian with JSON Object and does not require or send the shared key", async () => {
    await configure(true);
    const call = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("openrouter.ai")) return catalogFetch(url, init);
      expect(String(url)).toBe(bailianChatEndpoint(workspace));
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: bailianChatModel,
        response_format: { type: "json_object" },
        enable_thinking: false,
      });
      expect(body.provider).toBeUndefined();
      expect(body.reasoning).toBeUndefined();
      expect(body.tools.length).toBeGreaterThan(0);
      return json({
        id: randomUUID(),
        model: bailianChatModel,
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: '{"text":"连接正常","schedules":[],"tools":[]}',
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", call);
    const answer = await askAssistantModel(
      admin(),
      {},
      [
        {
          id: randomUUID(),
          role: "user",
          text: "你好",
          createdAt: new Date().toISOString(),
        },
      ],
      undefined,
      "2026-11-08",
      undefined,
      false,
      { model: modelId },
    );
    expect(answer.text).toBe("连接正常");
    expect(
      call.mock.calls.filter(
        ([url]) => String(url) === bailianChatEndpoint(workspace),
      ),
    ).toHaveLength(1);
    const current = (await aiModelManagement(admin())).features.find(
      (f) => f.id === "assistant_chat",
    )!;
    expect(current.model).toBe("openai/gpt-6.1-sol");
    expect(current.choices.some((c) => c.value === modelId)).toBe(true);
    const view = await aiModelManagement(admin());
    expect(
      view.features
        .filter((f) => f.id !== "assistant_chat")
        .every((f) => !f.choices.some((c) => c.value === modelId)),
    ).toBe(true);
    await saveAiFeatureModel(admin(), {
      feature: "assistant_chat",
      model: modelId,
      revision: 0,
    });
    const selected = (await aiModelManagement(admin())).features.find(
      (f) => f.id === "assistant_chat",
    )!;
    expect(selected.source).toContain(source);
    expect(selected.model).toBe(bailianChatModel);
    await expect(
      resolveTeamModel({ taskModel: modelId }),
    ).rejects.toMatchObject(errorCode("TEAM_MODEL_CAPABILITY"));
  });
  const askGreeting = () =>
    askAssistantModel(
      admin(),
      {},
      [
        {
          id: randomUUID(),
          role: "assistant",
          text: "我在这儿呢。",
          source: "voice",
          createdAt: new Date().toISOString(),
        },
        {
          id: randomUUID(),
          role: "user",
          text: "你好呀！",
          createdAt: new Date().toISOString(),
        },
      ],
      undefined,
      "2026-11-08",
      undefined,
      false,
      { model: modelId },
    );
  const completion = (
    content: string,
    finishReason = "stop",
    returnedModel = bailianChatModel,
  ) =>
    json({
      id: randomUUID(),
      model: returnedModel,
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      choices: [{ finish_reason: finishReason, message: { content } }],
    });
  it("repairs a plain greeting once without tools and meters both actual calls", async () => {
    await configure(true);
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("openrouter.ai")) return catalogFetch(url, init);
      expect(String(url)).toBe(bailianChatEndpoint(workspace));
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (bodies.length === 1) {
        expect(body.tools.length).toBeGreaterThan(0);
        expect(
          body.messages.find((m: any) => m.role === "assistant").content,
        ).toBe('{"text":"我在这儿呢。","schedules":[],"tools":[]}');
        expect(body.messages.at(-1).content).toContain(
          '"required":["text","schedules","tools"]',
        );
        return completion("你好呀！有什么可以帮你？");
      }
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.messages).toHaveLength(2);
      expect(JSON.parse(body.messages[1].content)).toEqual({
        draft: "你好呀！有什么可以帮你？",
      });
      return completion(
        '{"text":"你好呀！有什么可以帮你？","schedules":[],"tools":[]}',
      );
    });
    expect(await askGreeting()).toMatchObject({
      text: "你好呀！有什么可以帮你？",
      schedules: [],
      tools: [],
      jobIds: [],
    });
    expect(bodies).toHaveLength(2);
    const receipts = await query(
      "SELECT source,model,total_tokens,amount FROM ai_model_usage",
    );
    expect(receipts).toHaveLength(2);
    expect(
      receipts.every(
        (r) =>
          r.source === source &&
          r.model === bailianChatModel &&
          r.total_tokens === "12" &&
          r.amount === null,
      ),
    ).toBe(true);
  });
  it.each([
    {
      name: "malformed again",
      content: "仍是普通文字",
      finish: "stop",
      model: bailianChatModel,
    },
    {
      name: "invalid schedule",
      content: JSON.stringify({
        text: "草稿",
        tools: [],
        schedules: [
          {
            title: "会",
            date: "invalid",
            startTime: "",
            endTime: "",
            note: "",
          },
        ],
      }),
      finish: "stop",
      model: bailianChatModel,
    },
    {
      name: "unauthorized entry",
      content: '{"text":"你好","schedules":[],"tools":["forbidden-tool"]}',
      finish: "stop",
      model: bailianChatModel,
    },
    {
      name: "truncated",
      content: '{"text":"你好","schedules":[],"tools":[]}',
      finish: "length",
      model: bailianChatModel,
    },
    {
      name: "wrong model",
      content: '{"text":"你好","schedules":[],"tools":[]}',
      finish: "stop",
      model: "wrong-model",
    },
  ])("rejects $name after one format repair", async (sample) => {
    await configure(true);
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("openrouter.ai")) return catalogFetch(url, init);
      calls++;
      return calls === 1
        ? completion("你好呀！")
        : completion(sample.content, sample.finish, sample.model);
    });
    await expect(askGreeting()).rejects.toMatchObject(
      errorCode("AI_RESPONSE_INVALID"),
    );
    expect(calls).toBe(2);
  });
  it("preserves a completed tool result and never repeats it during final format repair", async () => {
    await configure(true);
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("openrouter.ai")) return catalogFetch(url, init);
      const body = JSON.parse(String(init?.body));
      calls++;
      if (calls === 1)
        return json({
          id: randomUUID(),
          model: bailianChatModel,
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "memory-once",
                    type: "function",
                    function: {
                      name: "propose_memory",
                      arguments:
                        '{"title":"回复偏好","content":"喜欢简洁回复"}',
                    },
                  },
                ],
              },
            },
          ],
        });
      if (calls === 2) {
        expect(body.messages.at(-1).tool_call_id).toBe("memory-once");
        return completion("已整理成记忆草稿，请确认后保存。");
      }
      expect(body.tools).toBeUndefined();
      expect(
        body.messages.some((m: any) => m.role === "tool" || m.tool_calls),
      ).toBe(false);
      return completion(
        '{"text":"已整理成记忆草稿，请确认后保存。","schedules":[],"tools":[]}',
      );
    });
    const answer = await askAssistantModel(
      admin(),
      {},
      [
        {
          id: randomUUID(),
          role: "user",
          text: "记住我喜欢简洁回复",
          createdAt: new Date().toISOString(),
        },
      ],
      undefined,
      "2026-11-08",
      undefined,
      false,
      { model: modelId },
    );
    expect(answer.memorySuggestions).toEqual([
      { title: "回复偏好", content: "喜欢简洁回复" },
    ]);
    expect(calls).toBe(3);
  });
});

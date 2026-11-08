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
    permissions: ["analytics.manage", "aigc.use", "aigc.manage"],
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
}, 30000);
beforeEach(async () => {
  await fixture.db!.exec(
    "TRUNCATE ai_feature_models,ai_model_usage,idempotency_records,audit_logs; UPDATE compass_ai_settings SET enabled=true,api_key_encrypted='shared-key',verified_at=now()-interval '1 day',updated_at=now()",
  );
  vi.stubGlobal("fetch", vi.fn(catalogFetch));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await fixture.db?.close();
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
    expect(view.features).toHaveLength(20);
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

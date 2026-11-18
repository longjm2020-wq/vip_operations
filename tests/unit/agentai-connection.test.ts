import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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
  agentaiBaseUrl,
  agentaiEndpoint,
  agentaiReady,
  agentaiConnection,
  readAgentAi,
  saveAgentAi,
  syncAgentAiModels,
  testAgentAiModel,
  postAgentAiChat,
  agentaiChatBody,
  normalizeAgentAiCatalog,
  normalizeAgentAiPrices,
  refreshAgentAiPrices,
} from "../../apps/api/src/modules/workspace/agentai-connection.js";
import { connectedModelRefs } from "../../apps/api/src/ai-model-connections.js";
import {
  agentaiAllowedModels,
  canonicalAgentAiModel,
} from "../../packages/contracts/src/agentai-policy.js";
import {
  publicAgentCatalog,
  resolveAgentModel,
  resolveChatModel,
} from "../../apps/api/src/modules/workspace/agent-models.js";
const key = "fixture-agentai-key-not-a-real-key";
const admin = (): Context => ({
  actor: {
    id: "7",
    username: "admin",
    displayName: "Admin",
    permissions: ["analytics.manage"],
    roleCodes: ["SUPER_ADMIN"],
  },
  requestId: randomUUID(),
  key: randomUUID(),
});
const error = (code: string) => ({ response: { error: { code } } });
const query = async (sql: string) =>
  (await fixture.db!.query<Record<string, any>>(sql)).rows;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const logical = {
  models: [
    {
      id: "gpt-6.1-sol",
      public_id: "gt-6.1-sol",
      display_name: "Text Model",
      category: "chat",
      available: true,
      capabilities: ["text"],
      param_schema: {
        reasoning_effort: { type: "enum", enum: ["low", "high"] },
      },
    },
    {
      id: "gpt-6-astra",
      display_name: "Vision Model",
      category: "chat",
      available: true,
      capabilities: ["text", "vision"],
      supported_parameters: ["tools", "structured_outputs"],
    },
    {
      id: "gpt-image-2.6-flare",
      category: "image",
      available: true,
      capabilities: ["image"],
      param_schema: {
        images: {
          type: "upload",
          max_items: 2,
          min_edge_px: 256,
          available_when: { mode: ["reference"] },
        },
      },
    },
    {
      id: "retired-model",
      category: "chat",
      available: true,
      deprecated: true,
      capabilities: ["text"],
    },
  ],
};
let posted: Record<string, any>[];
let completion: (body: Record<string, any>) => Promise<Response>;
async function network(url: string | URL, init?: RequestInit) {
  const target = String(url);
  if (target.startsWith("https://openrouter.ai/api/v1/"))
    return json({ data: [] });
  expect(init?.redirect).toBe("error");
  if (target === agentaiBaseUrl + "/models") {
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer " + key,
    );
    return json({
      data: logical.models.map((m) => ({ id: m.id, public_id: m.public_id })),
    });
  }
  if (target === agentaiBaseUrl + "/logical-models") {
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    return json(logical);
  }
  if (target === agentaiBaseUrl + "/skills/pricing?status=active")
    return json({
      generated_at: "2026-11-18T12:00:00Z",
      models: [
        {
          name: "gt-6.1-sol",
          channel_groups: [
            {
              is_active: true,
              billing_unit: "token",
              user_price_rmb: 0.02,
              user_price_per_million_input_rmb: 1.5,
              user_price_per_million_output_rmb: 4,
              stats_source: "estimate",
              success_rate_24h: 95,
              avg_response_seconds: 0,
            },
          ],
        },
      ],
    });
  expect(target).toBe(agentaiEndpoint);
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + key);
  const body = JSON.parse(String(init?.body));
  posted.push(body);
  return completion(body);
}
async function validResponse(body: Record<string, any>) {
  const token = body.messages[0].content.match(/[a-f0-9-]{36}/)?.[0];
  return json({
    id: randomUUID(),
    model: body.model,
    choices: [
      {
        finish_reason: body.tools ? "tool_calls" : "stop",
        message: body.tools
          ? {
              tool_calls: [
                {
                  id: "call-probe",
                  type: "function",
                  function: {
                    name: "capability_probe",
                    arguments: JSON.stringify({ token }),
                  },
                },
              ],
            }
          : {
              content: body.response_format ? JSON.stringify({ token }) : token,
            },
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  });
}
async function ready() {
  await saveAgentAi(admin(), { version: 0, enabled: true, apiKey: key });
  return syncAgentAiModels(admin());
}
async function probe(
  capability: "chat" | "tools" | "structured",
  model = "gpt-6.1-sol",
) {
  await fixture.db!.exec("UPDATE agentai_settings SET last_test_at=NULL");
  return testAgentAiModel(admin(), { model, capability });
}
beforeAll(async () => {
  fixture.db = new PGlite();
  await fixture.db
    .exec(`CREATE TABLE users(id bigint PRIMARY KEY); INSERT INTO users VALUES(7);
    CREATE TABLE compass_ai_settings(id int PRIMARY KEY,enabled bool,api_key_encrypted text,verified_at timestamptz,updated_at timestamptz DEFAULT now());
    INSERT INTO compass_ai_settings VALUES(1,true,'unrelated-credential',now(),now());
    CREATE TABLE idempotency_records(id bigserial,actor_id bigint,operation text,idempotency_key text,request_hash text,response_status int,response_body jsonb);
    CREATE TABLE audit_logs(id bigserial,actor_id bigint,actor_label text,action text,entity_type text,entity_id text,request_id text,before_data jsonb,after_data jsonb,reason text);`);
  await installAiManagementSchema(fixture.db);
}, 30000);
beforeEach(async () => {
  vi.stubEnv("COMPASS_MAIL_KEY", "11".repeat(32));
  posted = [];
  completion = validResponse;
  vi.stubGlobal("fetch", vi.fn(network));
  await fixture.db!.exec(
    "TRUNCATE agentai_model_verifications,ai_model_usage,idempotency_records,audit_logs; UPDATE agentai_settings SET enabled=false,api_key_encrypted=NULL,verified_at=NULL,version=0,error_note='',catalog_at=NULL,model_catalog='[]',last_test_at=NULL,model_prices='[]',prices_at=NULL,prices_etag=NULL,prices_generated_at=NULL,prices_error_note='',prices_refresh_started_at=NULL,updated_at=now()",
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await fixture.db?.close();
});

it("saves a separate encrypted credential with version checks, never marks a save verified or returns credentials", async () => {
  const c = admin();
  const saved = await saveAgentAi(c, {
    version: 0,
    enabled: true,
    apiKey: key,
  });
  expect(saved).toMatchObject({
    version: 1,
    enabled: true,
    apiKeyConfigured: true,
    verifiedAt: null,
  });
  expect(saved.models.some((m) => m.type === "chat")).toBe(true);
  expect(JSON.stringify(saved)).not.toContain(key);
  const [stored] = await query(
    "SELECT api_key_encrypted FROM agentai_settings",
  );
  expect(stored.api_key_encrypted).not.toBe(key);
  expect(JSON.stringify(await query("SELECT * FROM audit_logs"))).not.toContain(
    key,
  );
  expect(
    (await query("SELECT api_key_encrypted FROM compass_ai_settings"))[0]
      .api_key_encrypted,
  ).toBe("unrelated-credential");
  expect(
    await saveAgentAi(c, { version: 0, enabled: true, apiKey: key }),
  ).toEqual(saved);
  await expect(
    saveAgentAi(admin(), { version: 0, enabled: true }),
  ).rejects.toMatchObject(error("VERSION_CONFLICT"));
  await expect(
    readAgentAi({ ...admin(), actor: { ...admin().actor, roleCodes: [] } }),
  ).rejects.toMatchObject(error("FORBIDDEN"));
  expect(posted).toEqual([]);
});
it("authenticated catalog sync is not a model capability probe and preserves exact public media constraints", async () => {
  const saved = await ready();
  expect(saved.verifiedAt).toBeTruthy();
  expect(saved.models.map((m) => m.model)).toEqual([
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-image-2.6-flare",
  ]);
  expect(
    saved.models.every(
      (m) => !m.chatVerifiedAt && !m.toolsVerifiedAt && !m.structuredVerifiedAt,
    ),
  ).toBe(true);
  expect(saved.models.find((m) => m.model === "gpt-6-astra")).toMatchObject({
    vision: true,
    parameters: [],
  });
  expect(
    saved.models.find((m) => m.model === "gpt-image-2.6-flare")?.paramSchema,
  ).toMatchObject({
    images: { min_edge_px: 256, available_when: { mode: ["reference"] } },
  });
  expect(await query("SELECT * FROM ai_model_usage")).toEqual([]);
  expect(agentaiReady(await agentaiConnection())).toBe(true);
  await expect(resolveChatModel("agentai/gpt-6.1-sol")).rejects.toMatchObject(
    error("AGENTAI_MODEL_UNVERIFIED"),
  );
  await expect(resolveChatModel("agentai/missing-model")).rejects.toMatchObject(
    error("AGENTAI_MODEL_UNAVAILABLE"),
  );
  expect(posted).toEqual([]);
});
it("validates chat, tools and strict JSON independently with one real request each and returns text-only chat models", async () => {
  await ready();
  const chat = await probe("chat");
  expect(chat.models[0]).toMatchObject({
    chatVerifiedAt: expect.any(String),
    toolsVerifiedAt: null,
    structuredVerifiedAt: null,
  });
  const tools = await probe("tools");
  expect(tools.models[0].parameters).toEqual(["tools", "tool_choice"]);
  const strict = await probe("structured");
  expect(strict.models[0].parameters).toContain("structured_outputs");
  expect(posted).toHaveLength(3);
  expect(
    posted.every(
      (p) =>
        p.max_tokens === 256 && p.stream === false && !p.provider && !p.plugins,
    ),
  ).toBe(true);
  const catalog = await publicAgentCatalog();
  expect(
    catalog.models.find((m) => m.id === "agentai/gpt-6.1-sol"),
  ).toMatchObject({ vision: false, structured: true });
  expect(await resolveChatModel("agentai/gpt-6.1-sol")).toMatchObject({
    model: { provider: "agentai", actual: "gpt-6.1-sol" },
  });
  await expect(
    resolveChatModel("agentai/gpt-6.1-sol", { vision: true }),
  ).rejects.toMatchObject(error("AI_MODEL_CAPABILITY"));
  await expect(
    resolveAgentModel("agentai/gpt-6.1-sol", "compass_analysis"),
  ).rejects.toMatchObject(error("AI_MODEL_CAPABILITY"));
  const usage = await query(
    "SELECT source,model,status,total_tokens FROM ai_model_usage",
  );
  expect(usage).toHaveLength(3);
  expect(
    usage.every(
      (u) =>
        u.source === "agentai.token6688.com" &&
        u.model === "gpt-6.1-sol" &&
        u.status === "success",
    ),
  ).toBe(true);
});
it("does not turn a plain answer into tool verification or accept a different response model", async () => {
  await ready();
  completion = async (body) =>
    json({
      id: randomUUID(),
      model: body.model,
      choices: [{ message: { content: "I can use tools" } }],
    });
  await expect(probe("tools")).rejects.toMatchObject(
    error("AGENTAI_CAPABILITY_UNVERIFIED"),
  );
  expect((await readAgentAi(admin())).models[0].toolsVerifiedAt).toBeNull();
  completion = async () =>
    json({
      id: randomUUID(),
      model: "another-model",
      choices: [{ message: { content: "ok" } }],
    });
  await expect(probe("chat")).rejects.toMatchObject(
    error("AGENTAI_MODEL_MISMATCH"),
  );
  expect((await readAgentAi(admin())).models[0].chatVerifiedAt).toBeNull();
  expect(posted).toHaveLength(2);
});
it("isolates identical names by provider receipts and invalidates capabilities when the key changes", async () => {
  await ready();
  await probe("tools");
  const variants = [
    {
      id: "agentai/gpt-6.1-sol",
      actual: "gpt-6.1-sol",
      provider: "agentai" as const,
    },
    { id: "engine/or-text", actual: "gpt-6.1-sol" },
  ];
  expect([...(await connectedModelRefs(variants))]).toEqual([
    "agentai/gpt-6.1-sol",
  ]);
  await saveAgentAi(admin(), {
    version: 1,
    enabled: true,
    apiKey: "fixture-new-agentai-key-not-real",
  });
  const state = await readAgentAi(admin());
  expect(state.verifiedAt).toBeNull();
  expect(state.models[0].chatVerifiedAt).toBeNull();
  expect([...(await connectedModelRefs(variants))]).toEqual([]);
});
it("a late successful verification cannot certify a replacement credential", async () => {
  await ready();
  completion = async (body) => {
    await saveAgentAi(admin(), {
      version: 1,
      enabled: true,
      apiKey: "fixture-replaced-agentai-key",
    });
    return validResponse(body);
  };
  await expect(probe("structured")).rejects.toMatchObject(
    error("VERSION_CONFLICT"),
  );
  expect(
    (await readAgentAi(admin())).models.every((m) => !m.structuredVerifiedAt),
  ).toBe(true);
  expect(await query("SELECT * FROM agentai_model_verifications")).toEqual([]);
});
it("rejects unverified capabilities and unsupported feature routes before submission; strips provider-specific fields", async () => {
  await ready();
  await probe("chat");
  const s = await agentaiConnection(),
    signal = new AbortController().signal;
  const body = {
    model: "gpt-6.1-sol",
    messages: [{ role: "user", content: "hello" }],
    provider: { secret: "never" },
    plugins: ["web"],
    reasoning: { effort: "high" },
    strategy: "expensive",
    stream: true,
  };
  expect(agentaiChatBody(body)).toEqual({
    model: "gpt-6.1-sol",
    messages: body.messages,
    stream: false,
    strategy: "balanced",
  });
  await expect(
    postAgentAiChat(s, { ...body, tools: [{}] }, signal),
  ).rejects.toMatchObject(error("AGENTAI_CAPABILITY_UNVERIFIED"));
  await expect(
    postAgentAiChat(s, body, signal, "assistant_browser"),
  ).rejects.toMatchObject(error("AI_MODEL_CAPABILITY"));
  expect(posted).toHaveLength(1);
  const response = await postAgentAiChat(s, body, signal);
  await response.json();
  expect(posted).toHaveLength(2);
  expect(posted[1]).toEqual({
    model: "gpt-6.1-sol",
    messages: body.messages,
    stream: false,
    strategy: "balanced",
  });
});
it("returns safe errors without provider body or secret and does not retry paid probes", async () => {
  await ready();
  completion = async () =>
    json({ error: { message: "private-provider-body " + key } }, 403);
  let caught: unknown;
  try {
    await probe("chat");
  } catch (e) {
    caught = e;
  }
  expect(caught).toMatchObject(error("AGENTAI_REQUEST_FAILED"));
  expect(JSON.stringify(caught)).not.toContain("private-provider-body");
  expect(JSON.stringify(await readAgentAi(admin()))).not.toContain(key);
  expect(posted).toHaveLength(1);
});
it("imports catalog names without guessing capabilities or accepting URL-like identifiers", () => {
  expect(
    normalizeAgentAiCatalog({
      models: [
        ...logical.models,
        { id: "https://evil.test", category: "chat", available: true },
      ],
    }).map((m) => m.model),
  ).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-image-2.6-flare"]);
});

it("enforces the exact twenty-model policy for cached catalogs and direct paid/test submissions", async () => {
  expect(agentaiAllowedModels).toHaveLength(20);
  expect(new Set(agentaiAllowedModels.map((m) => m.model)).size).toBe(20);
  expect(canonicalAgentAiModel("agentai/mu-video")).toBe("muse-video");
  expect(canonicalAgentAiModel("agentai/gm-nb-2.1-image")).toBe(
    "gemini-nano-banana-2.1-image",
  );
  const initial = await readAgentAi(admin());
  expect(initial.models).toHaveLength(20);
  await ready();
  await fixture.db!.query(
    "UPDATE agentai_settings SET model_catalog=model_catalog || $1::jsonb",
    [
      JSON.stringify([
        {
          model: "retired-extra",
          name: "Old cached entry",
          type: "chat",
          available: true,
          vision: true,
        },
        {
          model: "gpt-6-astra",
          name: "Wrong modality",
          type: "audio",
          available: true,
        },
      ]),
    ],
  );
  expect((await readAgentAi(admin())).models.map((m) => m.model)).toEqual([
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-image-2.6-flare",
  ]);
  await expect(
    testAgentAiModel(admin(), { model: "retired-extra" }),
  ).rejects.toMatchObject(error("AGENTAI_MODEL_UNAVAILABLE"));
  await expect(
    postAgentAiChat(
      await agentaiConnection(),
      { model: "retired-extra", messages: [] },
      AbortSignal.timeout(1000),
    ),
  ).rejects.toMatchObject(error("AGENTAI_MODEL_UNAVAILABLE"));
  expect(posted).toHaveLength(0);
});

it("keeps conditional schema choices and mode/quality limits intact", () => {
  const schema = {
    size: {
      type: "enum",
      enum: ["1K", "2K"],
      options: [{ value: "2K", available_when: { aspect_ratio: ["1:1"] } }],
    },
    quality: {
      type: "multi_enum",
      enum_values_by_quality: { flash: ["720p"] },
      exclusive_options: ["fast", "full"],
    },
  };
  const normalized = normalizeAgentAiCatalog({
    models: [
      {
        id: "gt-image-2.6-sunburst",
        category: "image",
        available: true,
        param_schema: schema,
        capabilities: [],
      },
    ],
  });
  expect(normalized[0]).toMatchObject({
    model: "gpt-image-2.6-sunburst",
    paramSchema: schema,
  });
});

it("parses account prices by channel billing instead of modality and labels unmeasured statistics honestly", () => {
  const models = normalizeAgentAiPrices({
    generated_at: "2026-11-18T12:00:00Z",
    models: [
      {
        name: "gt-image-2.6-sunburst",
        channel_groups: [
          {
            is_active: true,
            billing_unit: "token",
            billing_method: "按token",
            user_price_rmb: 0.02,
            user_price_per_million_input_rmb: 2,
            user_price_per_million_output_rmb: 10,
            stats_source: "estimate",
            success_rate_24h: 95,
            avg_response_seconds: 0,
          },
          {
            is_active: true,
            billing_unit: "per_call",
            user_price_rmb: 0,
            stats_source: "live",
            success_rate_24h: 97,
            avg_response_seconds: 12,
          },
          { is_active: false, billing_unit: "per_call", user_price_rmb: 0.001 },
        ],
      },
      {
        name: "speech-2.8",
        channel_groups: [
          {
            is_active: true,
            billing_unit: "token",
            user_price_per_million_output_rmb: 500,
            stats_source: "live",
            success_rate_24h: 200,
            avg_response_seconds: -1,
          },
        ],
      },
      {
        name: "seedance-2-5-promo",
        channel_groups: [
          {
            is_active: true,
            billing_unit: "per_second",
            user_price_rmb: 10,
            billed_seconds: 20,
          },
        ],
      },
      { name: "not-selected", channel_groups: [] },
    ],
  });
  expect(models).toHaveLength(3);
  expect(models[0].pricing.channels).toHaveLength(2);
  expect(models[0].pricing.channels[0]).toMatchObject({
    billingUnit: "token",
    inputPerMillionRmb: 2,
    outputPerMillionRmb: 10,
    defaultTotalRmb: 0.02,
    statsSource: "estimate",
    successRate24h: null,
    avgResponseSeconds: null,
  });
  expect(models[0].pricing.channels[1]).toMatchObject({
    defaultTotalRmb: 0,
    statsSource: "live",
    successRate24h: 97,
    avgResponseSeconds: 12,
  });
  expect(models[1].pricing.channels[0]).toMatchObject({
    billingUnit: "token",
    inputPerMillionRmb: null,
    successRate24h: null,
    avgResponseSeconds: null,
  });
  expect(models[2].pricing.channels[0]).toMatchObject({
    defaultTotalRmb: 10,
    billedSeconds: 20,
  });
});

it("uses the private five-minute price cache and ETag without generating content", async () => {
  const saved = await ready();
  expect(saved.models[0].pricing?.channels[0]).toMatchObject({
    inputPerMillionRmb: 1.5,
    statsSource: "estimate",
    successRate24h: null,
  });
  const fetcher = vi.mocked(fetch);
  const calls = fetcher.mock.calls.length;
  await refreshAgentAiPrices(admin());
  expect(fetcher.mock.calls).toHaveLength(calls);
  await fixture.db!.exec(
    `UPDATE agentai_settings SET prices_at=now()-interval '6 minutes',prices_refresh_started_at=now()-interval '6 minutes',prices_etag='"private-version"'`,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get("if-none-match")).toBe(
        '"private-version"',
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer " + key,
      );
      return new Response(null, { status: 304 });
    }),
  );
  const refreshed = await refreshAgentAiPrices(admin());
  expect(refreshed.models[0].pricing).toEqual(saved.models[0].pricing);
  expect(refreshed.pricesErrorNote).toBe("");
  expect(posted).toHaveLength(0);
});

it("a failed price refresh preserves verified capabilities, and a late response cannot attach prices to a new key", async () => {
  await ready();
  await probe("chat");
  const stale = async () =>
    fixture.db!.exec(
      "UPDATE agentai_settings SET prices_at=now()-interval '6 minutes',prices_refresh_started_at=now()-interval '6 minutes'",
    );
  await stale();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ error: { message: key } }, 503)),
  );
  await expect(refreshAgentAiPrices(admin())).rejects.toMatchObject(
    error("AGENTAI_REQUEST_FAILED"),
  );
  const state = await readAgentAi(admin());
  expect(state.verifiedAt).toBeTruthy();
  expect(state.models[0].chatVerifiedAt).toBeTruthy();
  expect(state.pricesErrorNote).toBeTruthy();
  expect(JSON.stringify(state)).not.toContain(key);
  await stale();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await saveAgentAi(admin(), {
        version: 1,
        enabled: true,
        apiKey: "fixture-replacement-key-no-real-secret",
      });
      return json({
        models: [
          {
            name: "gt-6.1-sol",
            channel_groups: [{ is_active: true, user_price_rmb: 1 }],
          },
        ],
      });
    }),
  );
  await expect(refreshAgentAiPrices(admin())).rejects.toMatchObject(
    error("VERSION_CONFLICT"),
  );
  const replaced = await readAgentAi(admin());
  expect(replaced.pricesAt).toBeNull();
  expect(replaced.models.every((m) => !m.pricing)).toBe(true);
  expect(replaced.verifiedAt).toBeNull();
});

it("uses only a model-declared low thinking_budget for the Argon probe and preserves ordinary user effort", async () => {
  await ready();
  await fixture.db!.query(
    "UPDATE agentai_settings SET model_catalog=model_catalog || $1::jsonb",
    [
      JSON.stringify([
        {
          model: "gemini-4-argon",
          name: "GM-4 Argon",
          type: "chat",
          available: true,
          vision: true,
          paramSchema: {
            thinking_budget: {
              type: "enum",
              enum: ["low", "medium", "high"],
              default: "high",
            },
          },
        },
      ]),
    ],
  );
  const state = await probe("chat", "agentai/gm-4-argon");
  expect(
    state.models.find((m) => m.model === "gemini-4-argon")?.chatVerifiedAt,
  ).toBeTruthy();
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({
    model: "gemini-4-argon",
    thinking_budget: "low",
    max_tokens: 256,
    strategy: "balanced",
  });
  expect(posted[0]).not.toHaveProperty("reasoning_effort");
  expect(
    agentaiChatBody({
      model: "gemini-4-argon",
      messages: [],
      thinking_budget: "high",
    }),
  ).toMatchObject({ thinking_budget: "high" });
  await probe("chat", "gpt-6.1-sol");
  expect(posted[1]).toMatchObject({ reasoning_effort: "low" });
  expect(posted[1]).not.toHaveProperty("thinking_budget");
});

it.each(["TimeoutError", "AbortError"])(
  "returns a safe 502 for %s without retrying or certifying a failed probe",
  async (name) => {
    await ready();
    completion = async () => {
      throw new DOMException("private-provider-timeout " + key, name);
    };
    let caught: unknown;
    try {
      await probe("chat");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      status: 502,
      ...error("AGENTAI_TEST_TIMEOUT"),
    });
    expect(JSON.stringify(caught)).not.toContain(key);
    expect(JSON.stringify(caught)).not.toContain("private-provider-timeout");
    expect(posted).toHaveLength(1);
    expect(
      (await readAgentAi(admin())).models.every((m) => !m.chatVerifiedAt),
    ).toBe(true);
    expect(await query("SELECT * FROM agentai_model_verifications")).toEqual(
      [],
    );
  },
);

it("allows ninety seconds for one capability probe without changing its output budget or retrying", async () => {
  await ready();
  const timeout = vi.spyOn(AbortSignal, "timeout");
  try {
    await probe("chat");
    expect(timeout.mock.calls).toEqual([[90000]]);
    expect(posted).toHaveLength(1);
    expect(posted[0].max_tokens).toBe(256);
  } finally {
    timeout.mockRestore();
  }
});

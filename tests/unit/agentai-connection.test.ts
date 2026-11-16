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
} from "../../apps/api/src/modules/workspace/agentai-connection.js";
import { connectedModelRefs } from "../../apps/api/src/ai-model-connections.js";
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
      id: "text-model",
      public_id: "public-text",
      display_name: "Text Model",
      category: "chat",
      available: true,
      capabilities: ["text"],
      param_schema: {
        reasoning_effort: { type: "enum", enum: ["low", "high"] },
      },
    },
    {
      id: "vision-model",
      display_name: "Vision Model",
      category: "chat",
      available: true,
      capabilities: ["text", "vision"],
      supported_parameters: ["tools", "structured_outputs"],
    },
    {
      id: "media-model",
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
  model = "text-model",
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
    "TRUNCATE agentai_model_verifications,ai_model_usage,idempotency_records,audit_logs; UPDATE agentai_settings SET enabled=false,api_key_encrypted=NULL,verified_at=NULL,version=0,error_note='',catalog_at=NULL,model_catalog='[]',last_test_at=NULL,updated_at=now()",
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
    "text-model",
    "vision-model",
    "media-model",
  ]);
  expect(
    saved.models.every(
      (m) => !m.chatVerifiedAt && !m.toolsVerifiedAt && !m.structuredVerifiedAt,
    ),
  ).toBe(true);
  expect(saved.models.find((m) => m.model === "vision-model")).toMatchObject({
    vision: true,
    parameters: [],
  });
  expect(
    saved.models.find((m) => m.model === "media-model")?.paramSchema,
  ).toMatchObject({
    images: { min_edge_px: 256, available_when: { mode: ["reference"] } },
  });
  expect(await query("SELECT * FROM ai_model_usage")).toEqual([]);
  expect(agentaiReady(await agentaiConnection())).toBe(true);
  await expect(resolveChatModel("agentai/text-model")).rejects.toMatchObject(
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
    catalog.models.find((m) => m.id === "agentai/text-model"),
  ).toMatchObject({ vision: false, structured: true });
  expect(await resolveChatModel("agentai/text-model")).toMatchObject({
    model: { provider: "agentai", actual: "text-model" },
  });
  await expect(
    resolveChatModel("agentai/text-model", { vision: true }),
  ).rejects.toMatchObject(error("AI_MODEL_CAPABILITY"));
  await expect(
    resolveAgentModel("agentai/text-model", "compass_analysis"),
  ).rejects.toMatchObject(error("AI_MODEL_CAPABILITY"));
  const usage = await query(
    "SELECT source,model,status,total_tokens FROM ai_model_usage",
  );
  expect(usage).toHaveLength(3);
  expect(
    usage.every(
      (u) =>
        u.source === "agentai.token6688.com" &&
        u.model === "text-model" &&
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
      id: "agentai/text-model",
      actual: "text-model",
      provider: "agentai" as const,
    },
    { id: "engine/or-text", actual: "text-model" },
  ];
  expect([...(await connectedModelRefs(variants))]).toEqual([
    "agentai/text-model",
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
    model: "text-model",
    messages: [{ role: "user", content: "hello" }],
    provider: { secret: "never" },
    plugins: ["web"],
    reasoning: { effort: "high" },
    strategy: "expensive",
    stream: true,
  };
  expect(agentaiChatBody(body)).toEqual({
    model: "text-model",
    messages: body.messages,
    stream: false,
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
    model: "text-model",
    messages: body.messages,
    stream: false,
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
  ).toEqual(["text-model", "vision-model", "media-model"]);
});

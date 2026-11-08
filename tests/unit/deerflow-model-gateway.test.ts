import { EventEmitter } from "node:events";
import type { Request, Response as ExpressResponse } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ one: vi.fn(), model: vi.fn(), decrypt: vi.fn() }));
vi.mock("../../packages/database/src/index.js", () => ({ db: {}, one: mocks.one }));
vi.mock("../../apps/api/src/modules/analytics/ai.js", () => ({ COMPASS_AI_ENDPOINT: "https://models.example.test/chat/completions" }));
vi.mock("../../apps/api/src/modules/analytics/secrets.js", () => ({ decryptSecret: mocks.decrypt }));
vi.mock("../../apps/api/src/modules/workspace/team-models.js", () => ({ resolveTeamModel: mocks.model }));
// The route decorator itself is exercised by the application's registered controller.
vi.mock("../../apps/api/src/http.js", () => ({ Public: () => () => undefined }));
import { proxyDeerFlowModel, validDeerFlowModelToken } from "../../apps/api/src/deerflow-model-gateway.js";

class Reply extends EventEmitter {
  code = 0;
  body: unknown;
  chunks: Buffer[] = [];
  headers: Record<string, string> = {};
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  status(value: number) { this.code = value; return this; }
  json(body: unknown) { this.body = body; this.writableEnded = true; return this; }
  setHeader(name: string, value: string) { this.headers[name] = value; }
  flushHeaders() { this.headersSent = true; }
  write(value: string | Uint8Array) { this.chunks.push(Buffer.from(value)); return true; }
  end() { this.writableEnded = true; }
}
function incoming(token = "a".repeat(64)) {
  const request = new EventEmitter() as EventEmitter & { get: (name: string) => string | undefined };
  request.get = name => name === "Authorization" ? `Bearer ${token}` : undefined;
  return request as Request;
}
const body = { model: "erp-default", messages: [{ role: "user", content: "研究这份公开资料" }] };
const run = (input: unknown = body, request = incoming(), reply = new Reply()) => proxyDeerFlowModel(request, reply as unknown as ExpressResponse, input).then(() => reply);

describe("private DeerFlow model gateway", () => {
  beforeEach(() => {
    vi.stubEnv("DEER_FLOW_MODEL_PROXY_TOKEN", "a".repeat(64));
    mocks.one.mockResolvedValue({ enabled: true, verified_at: "2026-11-08", api_key_encrypted: "encrypted-value" });
    mocks.decrypt.mockReturnValue("supplier-secret");
    mocks.model.mockResolvedValue({ actual: "provider/verified-model", parameters: ["tools", "reasoning"], reasoningEffort: "low" });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it("requires a configured, distinct-format service credential before database access", async () => {
    expect(validDeerFlowModelToken(undefined)).toBe(false);
    expect(validDeerFlowModelToken("Bearer " + "a".repeat(64))).toBe(true);
    const reply = await run(body, incoming("b".repeat(64)));
    expect(reply.code).toBe(401);
    expect(mocks.one).not.toHaveBeenCalled();
    vi.stubEnv("DEER_FLOW_MODEL_PROXY_TOKEN", "");
    expect(validDeerFlowModelToken("Bearer ")).toBe(false);
  });

  it("rejects caller-selected models, endpoint overrides and excessive budgets", async () => {
    for (const input of [{ ...body, model: "expensive-other-model" }, { ...body, base_url: "https://other.test" }, { ...body, max_tokens: 100000 }]) {
      expect((await run(input)).code).toBe(400);
    }
    expect((await run({ ...body, messages: [{ role: "user", content: "a".repeat(2 * 1024 * 1024) }] })).code).toBe(413);
    expect(mocks.one).not.toHaveBeenCalled();
  });

  it("keeps disabled/unverified model service closed", async () => {
    mocks.one.mockResolvedValue({ enabled: true, verified_at: null, api_key_encrypted: "encrypted" });
    expect((await run()).code).toBe(503);
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });

  it("maps the fixed alias and forwards function tools without exposing the supplier credential", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "completion", choices: [{ message: { role: "assistant", content: "完成" } }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const tools = [{ type: "function", function: { name: "web_search", parameters: { type: "object" } } }];
    const reply = await run({ ...body, tools, max_tokens: 2000 });
    expect(reply.code).toBe(200);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("https://models.example.test/chat/completions");
    expect(options.redirect).toBe("error");
    expect(options.headers.Authorization).toBe("Bearer supplier-secret");
    expect(JSON.parse(options.body)).toMatchObject({ model: "provider/verified-model", tools, max_tokens: 2000, provider: { data_collection: "deny" } });
    expect(JSON.stringify(reply.body)).not.toContain("supplier-secret");
    expect(JSON.stringify(reply.body)).not.toContain("data\":");
  });

  it("forwards SSE bytes and terminates the stream without an ERP response envelope", async () => {
    const stream = 'data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { headers: { "content-type": "text/event-stream" } })));
    const reply = await run({ ...body, stream: true, stream_options: { include_usage: true } });
    expect(reply.code).toBe(200);
    expect(Buffer.concat(reply.chunks).toString()).toBe(stream);
    expect(reply.body).toBeUndefined();
    expect(reply.writableEnded).toBe(true);
  });

  it("discards upstream error bodies and never retries a paid request", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("upstream echoed supplier-secret", { status: 429 }));
    vi.stubGlobal("fetch", fetcher);
    const reply = await run();
    expect(reply.code).toBe(429);
    expect(JSON.stringify(reply.body)).not.toContain("supplier-secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized upstream responses before exposing their content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private upstream content", { headers: { "content-type": "application/json", "content-length": "20000000" } })));
    const reply = await run();
    expect(reply.code).toBe(502);
    expect(JSON.stringify(reply.body)).not.toContain("private upstream content");
  });

  it("aborts the supplier request when the private caller disconnects", async () => {
    const request = incoming();
    const reply = new Reply();
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn((_url, options) => {
      signal = options.signal;
      started();
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }));
    const pending = run(body, request, reply);
    await ready;
    reply.destroyed = true;
    reply.emit("close");
    await pending;
    expect(signal!.aborted).toBe(true);
    expect(reply.body).toBeUndefined();
    expect(reply.listenerCount("close")).toBe(0);
  });
});

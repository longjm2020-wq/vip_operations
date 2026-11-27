import { afterEach, describe, expect, it, vi } from "vitest";
const writes = vi.hoisted(() => [] as unknown[][]);
vi.mock("../../packages/database/src/index.js", () => ({
  db: {
    $queryRawUnsafe: async (...args: unknown[]) => {
      writes.push(args);
      return [];
    },
  },
  one: async () => undefined,
}));
import {
  aiFetch,
  providerUsage,
  recordAiReceipt,
  withProviderBillingHeaders,
} from "../../apps/api/src/ai-metering.js";
import { agentAiChatError } from "../../apps/api/src/agentai-chat-error.js";
import { FAL_LIP_SYNC_MODEL } from "../../packages/aigc-engine/vendor/cloud/fal-lip-sync.mjs";
const source = "agentai.token6688.com";
afterEach(() => {
  vi.unstubAllGlobals();
  writes.length = 0;
});
describe("fal lip sync metering", () => {
  const host = "queue.fal.run";
  const requestId = "30e4ef65-490f-4e04-b0f0-f77a3043a865";

  it("records the fixed model when the queue requests omit the model field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ request_id: requestId, status: "IN_QUEUE" })),
    );
    const response = await aiFetch("aigc_lip_sync", `https://${host}/${FAL_LIP_SYNC_MODEL}`, {
      method: "POST",
      body: JSON.stringify({ resolution: "768P" }),
    });
    await response.json();
    expect(writes[0]?.slice(2, 5)).toEqual(["aigc_lip_sync", host, FAL_LIP_SYNC_MODEL]);
    expect(writes.at(-1)?.[2]).toBe("responded");
    expect(writes.at(-1)?.[11]).toBe(requestId);
  });

  it("uses reported seconds and keeps unreported costs and tokens unknown", async () => {
    const result = { request_id: requestId, model: FAL_LIP_SYNC_MODEL, duration: 5.72 };
    expect(providerUsage(result, host)).toMatchObject({
      outputVideoSeconds: 5.72,
      total: null,
      amount: null,
      unit: null,
    });
    expect(providerUsage(result, "other.example").outputVideoSeconds).toBeNull();
    await recordAiReceipt("aigc_lip_sync", host, FAL_LIP_SYNC_MODEL, result);
    expect(writes.at(-1)?.[2]).toBe("success");
    expect(writes.at(-1)?.[14]).toBe(5.72);
  });
});
describe("AgentAI actual usage", () => {
  it("keeps provider CNY receipts distinct from credits and estimates", () => {
    expect(
      providerUsage(
        {
          usage: {
            prompt_tokens: 8,
            completion_tokens: 3,
            cost_rmb: 0.0012,
            cost_currency: "CNY",
            balance_rmb: 20,
          },
        },
        source,
      ),
    ).toMatchObject({ total: 11, amount: 0.0012, unit: "CNY", credits: null });
    expect(
      providerUsage({ effective_total_rmb: 2, required_freeze_rmb: 3 }, source),
    ).toMatchObject({ amount: null, credits: null });
    expect(
      providerUsage({ actual_cost_micro_usd: 12000 }, source),
    ).toMatchObject({ amount: 0.012, unit: "USD" });
    expect(providerUsage({ usage: { cost_rmb: 1 } }, source).amount).toBeNull();
    expect(
      providerUsage(
        { usage: { cost_rmb: 1, cost_currency: "CNY" } },
        "other.example",
      ).amount,
    ).toBeNull();
  });
  it("uses only valid documented headers and preserves missing versus zero", () => {
    expect(
      providerUsage(
        withProviderBillingHeaders({}, source, new Headers()),
        source,
      ).amount,
    ).toBeNull();
    expect(
      providerUsage(
        withProviderBillingHeaders(
          {},
          source,
          new Headers({ "X-TokenGo-Cost-RMB": "0" }),
        ),
        source,
      ),
    ).toMatchObject({ amount: 0, unit: "CNY" });
    expect(
      providerUsage(
        withProviderBillingHeaders(
          {},
          source,
          new Headers({ "X-TokenGo-Cost-Micro-USD": "125" }),
        ),
        source,
      ),
    ).toMatchObject({ amount: 0.000125, unit: "USD" });
    expect(
      providerUsage(
        withProviderBillingHeaders(
          {},
          source,
          new Headers({ "X-TokenGo-Cost-RMB": "" }),
        ),
        source,
      ).amount,
    ).toBeNull();
    expect(
      withProviderBillingHeaders(
        {},
        "other.example",
        new Headers({ "X-TokenGo-Cost-RMB": "12" }),
      ),
    ).toEqual({});
  });
  it.each([
    {
      label: "uses the AgentAI chat response header when the body has no ID",
      host: source,
      path: "/v1/chat/completions",
      feature: "assistant_chat",
      bodyId: undefined,
      taskId: undefined,
      headerId: "provider-request-1",
      requestId: "provider-request-1",
    },
    {
      label: "keeps the AgentAI chat body ID when the header is also present",
      host: source,
      path: "/v1/chat/completions",
      feature: "assistant_chat",
      bodyId: "completion-1",
      taskId: undefined,
      headerId: "provider-request-1",
      requestId: "completion-1",
    },
    {
      label: "ignores an oversized AgentAI chat header receipt",
      host: source,
      path: "/v1/chat/completions",
      feature: "assistant_chat",
      bodyId: undefined,
      taskId: undefined,
      headerId: "x".repeat(201),
      requestId: null,
    },
    {
      label: "keeps the canonical AgentAI media task ID",
      host: source,
      path: "/v1/audio/voices",
      feature: "agentai_voice_clone",
      bodyId: "voice-1",
      taskId: "audio-task-1",
      headerId: "provider-request-1",
      requestId: "audio-task-1",
    },
    {
      label: "ignores the AgentAI header on other providers",
      host: "another.example",
      path: "/v1/chat/completions",
      feature: "assistant_chat",
      bodyId: undefined,
      taskId: undefined,
      headerId: "provider-request-1",
      requestId: null,
    },
  ] as const)(
    "$label",
    async ({ host, path, feature, bodyId, taskId, headerId, requestId }) => {
      const model = "claude-opus-5-5";
      const data = {
        ...(bodyId !== undefined ? { id: bodyId } : {}),
        ...(taskId !== undefined ? { task_id: taskId } : {}),
        model,
        usage: { prompt_tokens: 8, completion_tokens: 3 },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(data, {
            headers: {
              "X-Request-Id": headerId,
              "X-TokenGo-Cost-RMB": "0.0123",
            },
          }),
        ),
      );
      const response = await aiFetch(feature, `https://${host}${path}`, {
        method: "POST",
        body: JSON.stringify({ model }),
      });
      expect(await response.json()).toEqual(data);
      const bill = writes.find((row) =>
        String(row[0]).includes("input_tokens=COALESCE"),
      );
      expect(bill?.slice(2, 7)).toEqual(["success", model, 8, 3, 11]);
      expect(bill?.slice(7, 9)).toEqual(
        host === source ? [0.0123, "CNY"] : [null, null],
      );
      expect(bill?.[11]).toBe(requestId);
    },
  );
  it("merges the final SSE cost chunk without losing earlier token usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            [
              'data: {"id":"call-1","model":"deepseek-v4.1-flash","choices":[],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}',
              'data: {"choices":[],"usage":{"cost_rmb":0.0012,"cost_currency":"CNY","balance_rmb":20}}',
              "data: [DONE]",
              "",
            ].join("\n\n"),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      ),
    );
    const r = await aiFetch(
      "assistant_chat",
      `https://${source}/v1/chat/completions`,
      {
        method: "POST",
        body: JSON.stringify({ model: "deepseek-v4.1-flash" }),
      },
    );
    await r.text();
    const bill = writes.find((row) =>
      String(row[0]).includes("input_tokens=COALESCE"),
    );
    expect(bill?.slice(2, 9)).toEqual([
      "success",
      "deepseek-v4.1-flash",
      8,
      3,
      11,
      0.0012,
      "CNY",
    ]);
  });
  it.each([
    {
      label: "classifies a model-less HTTP 200 provider failure",
      path: "/v1/chat/completions",
      feature: "assistant_chat",
      body: {
        error: { code: "all_vendors_failed", message: "private vendor detail" },
      },
      model: null,
      receiptId: "req_failed",
      code: "AGENTAI_ALL_VENDORS_FAILED",
    },
    {
      label:
        "keeps a top-level AgentAI error authoritative over nested metadata",
      path: "/v1/chat/completions",
      feature: "assistant_chat",
      body: {
        error: { type: "insufficient_funds", message: "private vendor detail" },
        response: { model: "claude-opus-5-5" },
      },
      model: "claude-opus-5-5",
      receiptId: "req_failed",
      code: "AGENTAI_INSUFFICIENT_FUNDS",
    },
    {
      label:
        "records a generic code without passing through unknown provider data",
      path: "/v1/chat/completions",
      feature: "assistant_chat",
      body: {
        data: {
          error: {
            code: "private vendor code",
            message: "private vendor detail",
          },
        },
      },
      model: null,
      receiptId: "req_failed",
      code: "AGENTAI_PROVIDER_ERROR",
    },
    {
      label: "keeps ordinary media failure metering and its task ID",
      path: "/v1/audio/voices",
      feature: "agentai_voice_clone",
      body: {
        id: "voice-1",
        task_id: "audio-task-1",
        error: { code: "all_vendors_failed", message: "private vendor detail" },
      },
      model: null,
      receiptId: "audio-task-1",
      code: null,
    },
  ] as const)(
    "$label",
    async ({ path, feature, body, model, receiptId, code }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(body, {
            status: 200,
            headers: { "X-Request-Id": "req_failed" },
          }),
        ),
      );
      const response = await aiFetch(feature, `https://${source}${path}`, {
        method: "POST",
        body: JSON.stringify({ model: "claude-opus-5-5" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(body);
      const bill = writes.find((row) =>
        String(row[0]).includes("input_tokens=COALESCE"),
      );
      expect(bill?.slice(2, 9)).toEqual([
        "failed",
        model,
        null,
        null,
        null,
        null,
        null,
      ]);
      expect(bill?.[11]).toBe(receiptId);
      expect(bill?.[16]).toBe(code);
      expect(JSON.stringify(writes)).not.toContain("private vendor");
    },
  );
  it("distinguishes an inner numeric failure status from a successful envelope", () => {
    expect(
      agentAiChatError({ response: { state: "failed", code: 429 } }),
    ).toMatchObject({
      code: "AGENTAI_STATUS_429",
    });
    expect(
      agentAiChatError({
        code: 0,
        status: 200,
        response: {
          model: "claude-opus-5-5",
          status: "completed",
          error: null,
        },
      }),
    ).toBeUndefined();
  });
  it("does not mark downloading as a completed model call", () => {
    expect(
      providerUsage({ model: "video", status: "downloading" }, source).pending,
    ).toBe(true);
  });
});

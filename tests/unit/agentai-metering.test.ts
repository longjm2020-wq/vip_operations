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
  withProviderBillingHeaders,
} from "../../apps/api/src/ai-metering.js";
const source = "agentai.token6688.com";
afterEach(() => {
  vi.unstubAllGlobals();
  writes.length = 0;
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
  it("does not mark downloading as a completed model call", () => {
    expect(
      providerUsage({ model: "video", status: "downloading" }, source).pending,
    ).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
// Model routing and metering are covered by ai-model-management.test.ts.
// Keep these provider-response checks independent of a configured database.
vi.mock("../../apps/api/src/ai-model-routing.js", () => ({
  featureModelRef: async () => undefined,
}));
vi.mock("../../apps/api/src/ai-metering.js", () => ({
  aiFetch: (_feature: string, url: string | URL, options: RequestInit) =>
    fetch(url, options),
}));
vi.mock("../../apps/api/src/modules/analytics/secrets.js", () => ({
  decryptSecret: () => "test-only-key",
}));
import { searchAgentWeb } from "../../apps/api/src/modules/workspace/agent-search.js";
afterEach(() => vi.unstubAllGlobals());
const payload = (model?: string) => ({
  model,
  choices: [
    {
      message: {
        content: "可核验公开内容",
        annotations: [
          {
            type: "url_citation",
            url_citation: { title: "来源", url: "https://example.com/public" },
          },
        ],
      },
    },
  ],
});
describe("team search model identity", () => {
  it("rejects an unexpected returned model without retrying or exposing provider content", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json(payload("unexpected/model")));
    vi.stubGlobal("fetch", fetch);
    const error = await searchAgentWeb(
      { api_key_encrypted: "test" },
      "requested/model",
      '{"query":"公开趋势"}',
      new AbortController().signal,
      (actual) => actual === "requested/model",
    ).catch((error) => error);
    expect(error.getResponse()).toMatchObject({
      error: {
        code: "SEARCH_MODEL_MISMATCH",
        message: expect.stringContaining("非指定型号"),
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("accepts the exact model with verified citation links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json(payload("requested/model"))),
    );
    const result = await searchAgentWeb(
      { api_key_encrypted: "test" },
      "requested/model",
      '{"query":"公开趋势"}',
      new AbortController().signal,
      (actual) => actual === "requested/model",
    );
    expect(result.citations).toEqual([
      { title: "来源", url: "https://example.com/public" },
    ]);
  });
  it("preserves existing search callers that do not request identity validation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload())));
    await expect(
      searchAgentWeb(
        { api_key_encrypted: "test" },
        "requested/model",
        '{"query":"公开趋势"}',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ text: "可核验公开内容" });
  });
});

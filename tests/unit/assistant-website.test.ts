vi.mock("../../apps/api/src/ai-metering.js", () => ({ aiFetch: (_feature: string, url: string | URL, options: RequestInit) => fetch(url, options), recordAiReceipt: async () => {} }));
vi.mock("../../apps/api/src/ai-model-routing.js", () => ({ featureModelRef: async () => undefined }));
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../apps/api/src/modules/analytics/secrets.js", () => ({
  decryptSecret: () => "test-only",
}));
import { resolveAssistantWebsite } from "../../apps/api/src/modules/workspace/assistant-website.js";
import { resolveAgentModel } from "../../apps/api/src/modules/workspace/agent-models.js";
afterEach(() => vi.unstubAllGlobals());
const response = (
  url: string,
  sources: string[],
  status = "resolved",
  model = "openai/gpt-6.1-sol",
) =>
  new Response(
    JSON.stringify({
      model,
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({ status, url }),
            annotations: sources.map((url) => ({
              type: "url_citation",
              url_citation: { url, title: "官网" },
            })),
          },
        },
      ],
    }),
  );
describe("website name resolution", () => {
  it("uses one bounded public lookup containing only the name, and requires a cited destination", async () => {
    const fetch = vi.fn(async () =>
      response("https://docs.example.com/", ["https://docs.example.com/about"]),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await resolveAssistantWebsite(
      { api_key_encrypted: "test" },
      await resolveAgentModel(),
      "示例文库",
    );
    expect(result.destination).toEqual({
      title: "示例文库",
      url: "https://docs.example.com/",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.messages).toHaveLength(2);
    expect(JSON.parse(body.messages[1].content)).toEqual({
      websiteName: "示例文库",
      task: "查找官方网站首页",
    });
    expect(body.plugins).toEqual([
      { id: "web", engine: "exa", max_results: 4 },
    ]);
    expect(body.max_tokens).toBe(1000);
  });
  it("does not navigate on ambiguity, missing citations, executable URLs or action paths", async () => {
    const model = await resolveAgentModel();
    for (const [url, sources, status] of [
      ["", [], "ambiguous"],
      ["", [], "not_found"],
      [
        "https://unverified.example/",
        ["https://different.example/"],
        "resolved",
      ],
      ["javascript:alert(1)", [], "resolved"],
      ["https://user:pass@example.com/", ["https://example.com/"], "resolved"],
      ["https://example.com/delete", ["https://example.com/"], "resolved"],
      [
        "https://example.com/?action=delete",
        ["https://example.com/"],
        "resolved",
      ],
      ["https://example.com:8443/", ["https://example.com:8443/"], "resolved"],
    ] as [string, string[], string][]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response(url, sources, status)),
      );
      const result = await resolveAssistantWebsite(
        { api_key_encrypted: "test" },
        model,
        "示例网站",
      );
      expect(result.destination, url).toBeUndefined();
      expect(result.text).toContain("补充完整网站或品牌名称");
    }
  });
  it("rejects mismatched model responses and provider errors without exposing response bodies", async () => {
    const model = await resolveAgentModel();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          "https://example.com/",
          ["https://example.com/"],
          "resolved",
          "wrong/model",
        ),
      ),
    );
    await expect(
      resolveAssistantWebsite({ api_key_encrypted: "test" }, model, "示例网站"),
    ).rejects.toMatchObject({
      response: { error: { code: "WEBSITE_LOOKUP_FAILED" } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("private provider error", { status: 503 }),
      ),
    );
    await expect(
      resolveAssistantWebsite({ api_key_encrypted: "test" }, model, "示例网站"),
    ).rejects.toMatchObject({
      response: { error: { message: "网站名称查询暂不可用，请稍后重试" } },
    });
  });
});

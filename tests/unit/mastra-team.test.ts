import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../apps/api/src/ai-metering.js", () => ({
  aiFetch: network.fetch,
}));
import {
  generateMastraTeamResponse,
  mastraMessages,
} from "../../apps/api/src/modules/workspace/mastra-team.js";

const endpoint = "https://openrouter.ai/api/v1/chat/completions";
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=";
const pdf =
  "data:application/pdf;base64," +
  Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF").toString(
    "base64",
  );
const schema = z
  .object({ status: z.literal("completed"), content: z.string() })
  .strict();
const options = () => ({
  endpoint,
  apiKey: "test-only-key",
  memberId: "writer",
  memberName: "文案",
  signal: new AbortController().signal,
  schema,
  body: {
    model: "provider/test-model",
    max_tokens: 120,
    provider: { require_parameters: true, data_collection: "deny" },
    reasoning: { effort: "low" },
    parallel_tool_calls: false,
    messages: [
      { role: "system", content: "只完成已委派工作" },
      { role: "user", content: "写一句新品介绍" },
    ],
    response_format: { type: "json_schema" },
  } as Record<string, any>,
});
const receipt = (
  message = {
    role: "assistant",
    content: '{"status":"completed","content":"新品上市"}',
  },
  finish_reason = "stop",
) => ({
  id: "request-1",
  object: "chat.completion",
  created: 1,
  model: "provider/test-model",
  choices: [{ index: 0, finish_reason, message }],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 8,
    total_tokens: 18,
    cost: 0.01,
  },
});
afterEach(() => {
  network.fetch.mockReset();
});
describe("real Mastra Agent through the metered website provider", () => {
  it("sends inline images, PDF bytes and tool evidence through the real SDK without external downloads", async () => {
    const input = options();
    input.body.messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "根据附件核对真实工具文件" },
          { type: "image_url", image_url: { url: png } },
          { type: "file", file: { filename: "说明.pdf", file_data: pdf } },
        ],
      },
      {
        role: "assistant",
        content: null,
        reasoning_details: [
          { type: "reasoning.encrypted", data: "opaque-test" },
        ],
        tool_calls: [
          {
            id: "previous-doc",
            type: "function",
            function: {
              name: "create_document",
              arguments: '{"title":"说明"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "previous-doc",
        content: '{"files":["owned-doc"]}',
      },
    ];
    network.fetch.mockResolvedValue(Response.json(receipt()));
    await generateMastraTeamResponse(input);
    expect(network.fetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(network.fetch.mock.calls[0][2].body);
    const parts = sent.messages.find((m: any) => m.role === "user").content;
    expect(parts).toEqual(
      expect.arrayContaining([
        { type: "image_url", image_url: { url: png } },
        { type: "file", file: { filename: "说明.pdf", file_data: pdf } },
      ]),
    );
    expect(sent.messages.find((m: any) => m.role === "tool")).toMatchObject({
      tool_call_id: "previous-doc",
      content: '{"files":["owned-doc"]}',
    });
    expect(
      sent.messages.find((m: any) => m.role === "assistant").reasoning_details,
    ).toEqual(input.body.messages[1].reasoning_details);
  });
  it("uses the chosen model, JSON schema and provider policy through one metered request", async () => {
    network.fetch.mockResolvedValue(Response.json(receipt()));
    const result = await (await generateMastraTeamResponse(options())).json();
    expect(JSON.parse(result.choices[0].message.content)).toEqual({
      status: "completed",
      content: "新品上市",
    });
    expect(result.usage.total_tokens).toBe(18);
    expect(network.fetch).toHaveBeenCalledTimes(1);
    const [feature, url, init] = network.fetch.mock.calls[0];
    const sent = JSON.parse(init.body);
    expect(feature).toBe("mastra_team");
    expect(url).toBe(endpoint);
    expect(sent).toMatchObject({
      model: "provider/test-model",
      stream: false,
      max_tokens: 120,
      provider: { require_parameters: true, data_collection: "deny" },
      reasoning: { effort: "low" },
      response_format: { type: "json_schema" },
      parallel_tool_calls: false,
    });
    expect(JSON.stringify(sent.messages)).toContain("写一句新品介绍");
    expect(init.redirect).toBe("error");
  });
  it("stops before charging when the framework cannot preserve an attachment", async () => {
    const input = options();
    input.body.messages = [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aGVsbG8=" },
          },
        ],
      },
    ];
    await expect(generateMastraTeamResponse(input)).rejects.toThrow(
      "未自动重试",
    );
    expect(network.fetch).not.toHaveBeenCalled();
  });
  it("returns actual tool calls for the permission and lease guarded executor, without running them twice", async () => {
    const input = options();
    delete input.body.response_format;
    input.body.tool_choice = {
      type: "function",
      function: { name: "create_document" },
    };
    input.body.tools = [
      {
        type: "function",
        function: {
          name: "create_document",
          description: "生成文档",
          parameters: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
    ];
    network.fetch.mockResolvedValue(
      Response.json(
        receipt(
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tool-1",
                type: "function",
                function: {
                  name: "create_document",
                  arguments: '{"title":"新品"}',
                },
              },
            ],
          } as any,
          "tool_calls",
        ),
      ),
    );
    const result = await (await generateMastraTeamResponse(input)).json();
    expect(result.choices[0].message.tool_calls).toEqual([
      {
        id: "tool-1",
        type: "function",
        function: { name: "create_document", arguments: '{"title":"新品"}' },
      },
    ]);
    expect(network.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(network.fetch.mock.calls[0][2].body).tool_choice).toEqual(
      input.body.tool_choice,
    );
  });
  it("keeps attachment and tool-result context and rejects remote attachment downloads", () => {
    const messages = mastraMessages([
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aGVsbG8=" },
          },
          {
            type: "file",
            file: {
              file_data: "data:application/pdf;base64,aGVsbG8=",
              filename: "说明.pdf",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "doc",
            function: {
              name: "create_document",
              arguments: '{"title":"标题"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "doc",
        content: '{"files":["owned-file"]}',
      },
    ]);
    expect(messages[0]).toMatchObject({
      content: [
        { type: "image" },
        { type: "file", mediaType: "application/pdf", filename: "说明.pdf" },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: "tool",
      content: [
        {
          toolCallId: "doc",
          toolName: "create_document",
          output: { value: '{"files":["owned-file"]}' },
        },
      ],
    });
    expect(() =>
      mastraMessages([
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "http://127.0.0.1/private" },
            },
          ],
        },
      ]),
    ).toThrow("内联图片");
  });
  it("does not retry provider failures or a pre-aborted run", async () => {
    network.fetch.mockResolvedValue(
      Response.json(
        { error: { message: "rate limited", code: 429 } },
        { status: 429 },
      ),
    );
    expect(
      await (await generateMastraTeamResponse(options())).json(),
    ).toMatchObject({ error: { code: 429 } });
    expect(network.fetch).toHaveBeenCalledTimes(1);
    network.fetch.mockClear();
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateMastraTeamResponse({ ...options(), signal: controller.signal }),
    ).rejects.toThrow();
    expect(network.fetch).not.toHaveBeenCalled();
  });
});

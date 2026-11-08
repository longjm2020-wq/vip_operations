import { Agent } from "@mastra/core/agent";
import type { MessageInput } from "@mastra/core/agent/message-list";
import { createTool } from "@mastra/core/tools";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import type { Row } from "../../../../../packages/database/src/index.js";
import { aiFetch } from "../../ai-metering.js";

async function readReceipt(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) throw new Error("Mastra 模型返回空响应");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 300 * 1024) throw new Error("Mastra 模型响应超过大小限制");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Mastra controls each member's generation. The website remains the authority
// for tool execution, owner/lease checks, evidence, bounded rounds and review.
// No Mastra memory/telemetry/cloud service is configured; history stays in ERP.
export function mastraMessages(messages: Row[]): MessageInput[] {
  const toolNames = new Map<string, string>();
  return messages.map((message): MessageInput => {
    if (message.role === "tool")
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.tool_call_id,
            toolName: toolNames.get(message.tool_call_id) || "unknown",
            output: { type: "text", value: String(message.content) },
          },
        ],
      };
    if (message.role === "assistant" && message.tool_calls?.length)
      return {
        role: "assistant",
        content: [
          ...(message.content
            ? [{ type: "text" as const, text: String(message.content) }]
            : []),
          ...message.tool_calls.map((tool: Row) => {
            toolNames.set(tool.id, tool.function.name);
            return {
              type: "tool-call" as const,
              toolCallId: tool.id,
              toolName: tool.function.name,
              input: JSON.parse(tool.function.arguments),
            };
          }),
        ],
      };
    if (message.role === "user" && Array.isArray(message.content))
      return {
        role: "user",
        content: message.content.map((part: Row) => {
          if (part.type === "image_url") {
            if (!String(part.image_url.url).startsWith("data:image/"))
              throw new Error("Mastra 仅接收已授权附件的内联图片");
            return {
              type: "image" as const,
              image: new URL(part.image_url.url),
              mediaType: String(part.image_url.url).slice(5).split(";")[0],
            };
          }
          if (part.type === "file") {
            if (
              !String(part.file.file_data).startsWith(
                "data:application/pdf;base64,",
              )
            )
              throw new Error("Mastra 附件格式不受支持");
            return {
              type: "file" as const,
              data: Buffer.from(part.file.file_data.split(",")[1], "base64"),
              mediaType: "application/pdf",
              filename: part.file.filename,
            };
          }
          if (part.type !== "text") throw new Error("Mastra 消息内容不受支持");
          return { type: "text" as const, text: String(part.text) };
        }),
      };
    if (!["system", "user", "assistant"].includes(message.role))
      throw new Error("Mastra 消息角色无效");
    return { role: message.role, content: String(message.content || "") };
  });
}

export async function generateMastraTeamResponse(options: {
  endpoint: string;
  apiKey: string;
  memberId: string;
  memberName: string;
  body: Row;
  schema: z.ZodType;
  signal: AbortSignal;
}): Promise<Response> {
  const { body, signal } = options;
  signal.throwIfAborted();
  const messages = mastraMessages(body.messages);
  let receipt: Row | undefined;
  let status = 200;
  let calls = 0;
  const provider = createOpenAICompatible({
    name: "erp-openrouter",
    baseURL: options.endpoint.replace(/\/chat\/completions\/?$/, ""),
    apiKey: options.apiKey,
    supportsStructuredOutputs: true,
    // All content is inline; never let SDK attachment downloading make requests.
    supportedUrls: () => ({
      "image/*": [/^data:/],
      "application/pdf": [/^data:/],
    }),
    transformRequestBody: (request) => ({
      ...request,
      stream: false,
      messages: request.messages.map((message: Row) => {
        const original = body.messages.find(
          (m: Row) =>
            m.role === "assistant" &&
            m.tool_calls?.[0]?.id &&
            m.tool_calls[0].id === message.tool_calls?.[0]?.id,
        );
        return original?.reasoning_details
          ? { ...message, reasoning_details: original.reasoning_details }
          : message;
      }),
      provider: body.provider,
      ...(body.reasoning ? { reasoning: body.reasoning } : {}),
      ...(body.parallel_tool_calls !== undefined
        ? { parallel_tool_calls: false }
        : {}),
    }),
    fetch: async (url, init) => {
      signal.throwIfAborted();
      if (String(url) !== options.endpoint || ++calls !== 1)
        throw new Error("Mastra 请求超出本轮执行范围，未重复调用");
      const attachmentCount = (messages: Row[]) =>
        messages.reduce(
          (count, message) =>
            count +
            (Array.isArray(message.content)
              ? message.content.filter(
                  (part: Row) =>
                    part.type === "image_url" || part.type === "file",
                ).length
              : 0),
          0,
        );
      if (
        attachmentCount(body.messages) !==
        attachmentCount(JSON.parse(String(init?.body)).messages)
      )
        throw new Error("Mastra 未完整传递附件，已在模型调用前停止");
      const response = await aiFetch("mastra_team", options.endpoint, {
        ...init,
        redirect: "error",
        signal,
      });
      // Preserve the original metered receipt and bounded payload validation in
      // the existing executor. No raw provider errors/credentials reach the UI.
      status = response.status;
      const text = await readReceipt(response, signal);
      try {
        receipt = JSON.parse(text);
      } catch {
        /* handled below */
      }
      return new Response(text, {
        status: response.status,
        headers: response.headers,
      });
    },
  });
  const tools = Object.fromEntries(
    (body.tools || []).map((definition: Row) => [
      definition.function.name,
      createTool({
        id: definition.function.name,
        description: definition.function.description,
        inputSchema: definition.function.parameters,
        // Omitted execute: authorized website runner handles these tool calls.
      }),
    ]),
  );
  const agent = new Agent({
    id: `team-${options.memberId}`,
    name: options.memberName,
    instructions: "按当前委派与工具证据完成本轮团队工作。",
    model: provider.chatModel(body.model),
    tools,
    maxRetries: 0,
  });
  try {
    const generation = {
      abortSignal: signal,
      maxSteps: 1,
      maxProcessorRetries: 0,
      modelSettings: { maxOutputTokens: body.max_tokens, maxRetries: 0 },
      toolChoice:
        typeof body.tool_choice === "object"
          ? { type: "tool", toolName: body.tool_choice.function.name }
          : body.tool_choice || "none",
    };
    const result = body.response_format
      ? await agent.generate(messages, {
          ...generation,
          structuredOutput: { schema: options.schema, errorStrategy: "strict" },
        })
      : await agent.generate(messages, generation);
    signal.throwIfAborted();
    if (!receipt) throw new Error("Mastra 未取得模型回执");
    const toolCalls = result.toolCalls.map(({ payload }) => ({
      id: payload.toolCallId,
      type: "function",
      function: {
        name: payload.toolName,
        arguments: JSON.stringify(payload.args),
      },
    }));
    return Response.json({
      ...receipt,
      choices: [
        {
          ...receipt.choices?.[0],
          message: {
            ...receipt.choices?.[0]?.message,
            content: result.text,
            tool_calls: toolCalls,
          },
        },
      ],
    });
  } catch {
    signal.throwIfAborted();
    // Keep provider failure/length/refusal/malformed JSON semantics identical;
    // never fall back to another engine or automatically replay paid work.
    if (receipt?.error || receipt?.choices?.[0]?.error)
      return Response.json(receipt, { status });
    if (receipt?.choices?.[0]?.finish_reason === "length")
      return Response.json(receipt);
    throw new Error(
      "Mastra 未返回有效结果，请检查模型服务与任务要求；未自动重试",
    );
  }
}

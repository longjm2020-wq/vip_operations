import { z } from "zod";
import {
  db,
  one,
  type Row,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import {
  bailianChatModel,
  type BailianChatStatus,
} from "../../../../../packages/contracts/src/bailian-chat.js";
import { audit, command, fail, parse, type Context } from "../../core.js";
import { aiFetch } from "../../ai-metering.js";
import { requireAIConfiguration } from "../analytics/ai.js";
import {
  decryptSecret,
  encryptSecret,
  encryptionReady,
} from "../analytics/secrets.js";

export function bailianChatEndpoint(workspace: string) {
  if (!/^ws-[a-z0-9]{8,64}$/.test(workspace))
    fail(
      "BAILIAN_WORKSPACE_INVALID",
      "请填写百炼北京业务空间 ID（ws- 开头）",
      400,
    );
  return `https://${workspace}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
}
export const bailianChatReady = (s?: Row) =>
  Boolean(
    encryptionReady() &&
    s?.enabled &&
    s.api_key_encrypted &&
    s.verified_at &&
    /^ws-[a-z0-9]{8,64}$/.test(s.workspace_id),
  );
export async function bailianChatConnection() {
  const s = await one(
    db,
    "SELECT * FROM public.bailian_chat_settings WHERE id=1",
  );
  if (!bailianChatReady(s))
    fail("AI_NOT_READY", "请管理员先启用并验证百炼聊天连接", 503);
  return s!;
}
const schema = z
  .object({
    version: z.number().int().nonnegative(),
    enabled: z.boolean(),
    workspaceId: z
      .string()
      .trim()
      .regex(/^ws-[a-z0-9]{8,64}$/),
    apiKey: z
      .union([
        z.literal(""),
        z
          .string()
          .trim()
          .min(20)
          .max(512)
          .regex(/^sk-[A-Za-z0-9._-]+$/),
      ])
      .optional(),
    useSavedQwenConnection: z.boolean().default(false),
    clearKey: z.boolean().default(false),
  })
  .strict();
async function savedQwen(connection: Tx = db) {
  return one(
    connection,
    "SELECT qwen_workspace_id,qwen_api_key_encrypted FROM public.assistant_realtime_settings WHERE id=1",
  );
}
async function view(s: Row, connection: Tx = db): Promise<BailianChatStatus> {
  const reusable = await savedQwen(connection);
  return {
    enabled: s.enabled,
    workspaceId: s.workspace_id,
    model: bailianChatModel,
    endpoint: s.workspace_id ? bailianChatEndpoint(s.workspace_id) : "",
    apiKeyConfigured: Boolean(s.api_key_encrypted),
    encryptionReady: encryptionReady(),
    verifiedAt: s.verified_at ? new Date(s.verified_at).toISOString() : null,
    errorNote: s.error_note,
    version: s.version,
    reuseAvailable: Boolean(
      encryptionReady() &&
      reusable?.qwen_api_key_encrypted &&
      /^ws-[a-z0-9]{8,64}$/.test(reusable.qwen_workspace_id),
    ),
    reuseWorkspaceId: reusable?.qwen_workspace_id || "",
  };
}
export async function readBailianChat(c: Context) {
  requireAIConfiguration(c);
  return view(
    (await one(db, "SELECT * FROM public.bailian_chat_settings WHERE id=1"))!,
  );
}
export async function saveBailianChat(c: Context, input: unknown) {
  requireAIConfiguration(c);
  const b = parse(schema, input);
  if (
    [Boolean(b.apiKey), b.useSavedQwenConnection, b.clearKey].filter(Boolean)
      .length > 1
  )
    fail("BAILIAN_KEY_INVALID", "填写、复用或清除密钥只能选择一种", 400);
  return command(c, "bailian-chat.settings", b, async (tx) => {
    const old = (await one(
      tx,
      "SELECT * FROM public.bailian_chat_settings WHERE id=1 FOR UPDATE",
    ))!;
    if (old.version !== b.version)
      fail("VERSION_CONFLICT", "连接已被更新，请刷新后重试", 409);
    let key = b.apiKey;
    if (b.useSavedQwenConnection) {
      const qwen = await one(
        tx,
        "SELECT qwen_workspace_id,qwen_api_key_encrypted FROM public.assistant_realtime_settings WHERE id=1",
      );
      if (
        !qwen?.qwen_api_key_encrypted ||
        qwen.qwen_workspace_id !== b.workspaceId
      )
        fail(
          "BAILIAN_REUSE_UNAVAILABLE",
          "已保存的百炼连接不可复用，请刷新并核对业务空间",
          409,
        );
      key = decryptSecret(qwen.qwen_api_key_encrypted);
    }
    if (key?.startsWith("sk-or-"))
      fail("BAILIAN_KEY_INVALID", "请使用百炼 API Key", 400);
    const encrypted = b.clearKey
      ? null
      : key
        ? encryptSecret(key)
        : old.api_key_encrypted;
    if (b.enabled && !encrypted)
      fail("BAILIAN_KEY_MISSING", "请先保存百炼 API Key", 400);
    const saved = (await one(
      tx,
      `UPDATE public.bailian_chat_settings SET enabled=$1,workspace_id=$2,api_key_encrypted=$3,
      verified_at=NULL,error_note='',last_test_at=NULL,version=version+1,updated_by=$4::bigint,updated_at=now() WHERE id=1 RETURNING *`,
      b.enabled && !b.clearKey,
      b.workspaceId,
      encrypted,
      c.actor.id,
    ))!;
    await audit(
      tx,
      c,
      "BAILIAN_CHAT_SETTINGS",
      "bailian_chat_settings",
      1,
      {
        enabled: old.enabled,
        workspaceId: old.workspace_id,
        configured: !!old.api_key_encrypted,
      },
      {
        enabled: saved.enabled,
        workspaceId: saved.workspace_id,
        configured: !!saved.api_key_encrypted,
      },
    );
    return view(saved, tx);
  });
}
/** Only provider-supported fields cross this boundary; OpenRouter directives never do. */
export function bailianChatBody(body: Row) {
  const {
    provider: _provider,
    reasoning: _reasoning,
    plugins: _plugins,
    ...request
  } = body;
  return {
    ...request,
    model: bailianChatModel,
    stream: false,
    enable_thinking: false,
    ...(request.response_format
      ? { response_format: { type: "json_object" } }
      : {}),
  };
}
export function postBailianChat(s: Row, body: Row, signal: AbortSignal) {
  return aiFetch("assistant_chat", bailianChatEndpoint(s.workspace_id), {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      Authorization: "Bearer " + decryptSecret(s.api_key_encrypted),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bailianChatBody(body)),
  });
}
async function probe(s: Row, body: Row) {
  const response = await postBailianChat(s, body, AbortSignal.timeout(60000));
  if (!response.ok) {
    await response.body?.cancel();
    fail(
      "BAILIAN_CHAT_TEST_FAILED",
      `百炼聊天验证失败（HTTP ${response.status}），请核对模型授权与额度`,
      502,
    );
  }
  const payload = await response.json();
  if (
    payload.model !== bailianChatModel ||
    !payload.id ||
    !payload.choices?.[0]?.message ||
    payload.choices[0].message.refusal
  )
    fail(
      "BAILIAN_CHAT_TEST_FAILED",
      "百炼未返回指定型号的有效响应，未标记接通",
      502,
    );
  return payload.choices[0];
}
export async function testBailianChat(c: Context) {
  requireAIConfiguration(c);
  const s = await one(
    db,
    `UPDATE public.bailian_chat_settings SET last_test_at=now() WHERE id=1 AND enabled
    AND api_key_encrypted IS NOT NULL AND (last_test_at IS NULL OR last_test_at<now()-interval '1 minute') RETURNING *`,
  );
  if (!s)
    fail(
      "BAILIAN_CHAT_TEST_BUSY",
      "请先保存并启用连接；重复验证至少间隔一分钟",
      409,
    );
  try {
    // A fixed synthetic image tests vision without sending business or personal data.
    const image =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAlklEQVRoge2SwQkAMBCD3H9pu0M/chBwACMBPA65gRtAXtFdiLuQG7gB5BXdhbgLuYEbQF7RXYi7kBu4AeQV3YW4C7mBG0Be0V2Iu5AbuAHkFd2FuAu5gRtAXtFdiLuQG7gB5BXdhbgLuYEbQF7RXYi7kBu4AeQV3YW4C7mBG0Be0V2Iu5AbuAHkFd2FuAu5gRtAXvGfB8f88OLUsm3FAAAAAElFTkSuQmCC";
    const first = await probe(s, {
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Identify the solid image color. Call connection_probe with color blue, red or other. This is a connection test.",
            },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "connection_probe",
            description: "Report the color of the test image",
            parameters: {
              type: "object",
              properties: {
                color: { type: "string", enum: ["blue", "red", "other"] },
              },
              required: ["color"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "connection_probe" } },
    });
    const calls = first.message.tool_calls;
    if (
      first.finish_reason !== "tool_calls" ||
      calls?.length !== 1 ||
      !calls[0].id ||
      calls[0].function?.name !== "connection_probe" ||
      JSON.parse(calls[0].function.arguments).color !== "blue"
    )
      throw Error("视觉或工具调用验证未通过");
    const second = await probe(s, {
      max_tokens: 128,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'Return a JSON object with only {"ok":true} after the test tool reports success.',
        },
        { role: "user", content: "Test the tool result and JSON response." },
        { role: "assistant", content: null, tool_calls: calls },
        {
          role: "tool",
          tool_call_id: calls[0].id,
          content: '{"success":true}',
        },
      ],
    });
    if (
      second.finish_reason !== "stop" ||
      JSON.parse(second.message.content).ok !== true
    )
      throw Error("JSON 回复验证未通过");
    const saved = await one(
      db,
      "UPDATE public.bailian_chat_settings SET verified_at=now(),error_note='' WHERE id=1 AND version=$1 RETURNING *",
      s.version,
    );
    if (!saved)
      fail("VERSION_CONFLICT", "验证期间连接已更新，请重新验证当前连接", 409);
    return view(saved);
  } catch (error) {
    const note =
      "验证失败，请核对北京业务空间、DeepSeek 型号权限与额度后重试。";
    await db.$executeRawUnsafe(
      "UPDATE public.bailian_chat_settings SET verified_at=NULL,error_note=$2 WHERE id=1 AND version=$1",
      s.version,
      note,
    );
    if (error && typeof error === "object" && "getStatus" in error) throw error;
    fail("BAILIAN_CHAT_TEST_FAILED", note, 502);
  }
}

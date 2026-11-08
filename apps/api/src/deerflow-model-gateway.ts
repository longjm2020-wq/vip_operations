import { aiFetch } from "./ai-metering.js";
import { Body, Controller, Post, Req, Res } from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import type { Request, Response } from "express";
import { z } from "zod";
import { db, one } from "../../../packages/database/src/index.js";
import { Public } from "./http.js";
import { COMPASS_AI_ENDPOINT } from "./modules/analytics/ai.js";
import { decryptSecret } from "./modules/analytics/secrets.js";
import { resolveTeamModel } from "./modules/workspace/team-models.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const messageSchema = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: z
      .union([
        z.string(),
        z.array(z.record(z.string(), z.unknown())).max(100),
        z.null(),
      ])
      .optional(),
    name: z.string().max(128).optional(),
    tool_call_id: z.string().max(256).optional(),
    tool_calls: z
      .array(
        z.object({
          id: z.string().max(256),
          type: z.literal("function"),
          function: z.object({
            name: z.string().max(128),
            arguments: z.string(),
          }),
        }),
      )
      .max(64)
      .optional(),
    reasoning_content: z.string().optional(),
    reasoning_details: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict();
const requestSchema = z
  .object({
    model: z.literal("erp-default"),
    messages: z.array(messageSchema).min(1).max(256),
    stream: z.boolean().default(false),
    stream_options: z.object({ include_usage: z.boolean() }).optional(),
    tools: z
      .array(
        z
          .object({
            type: z.literal("function"),
            function: z
              .object({
                name: z.string().min(1).max(128),
                description: z.string().max(20000).optional(),
                parameters: z.record(z.string(), z.unknown()).optional(),
                strict: z.boolean().optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    tool_choice: z
      .union([
        z.enum(["auto", "none", "required"]),
        z.object({
          type: z.literal("function"),
          function: z.object({ name: z.string().max(128) }),
        }),
      ])
      .optional(),
    parallel_tool_calls: z.boolean().optional(),
    max_tokens: z.number().int().min(1).max(8192).optional(),
    max_completion_tokens: z.number().int().min(1).max(8192).optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    stop: z
      .union([z.string().max(128), z.array(z.string().max(128)).max(4)])
      .optional(),
    response_format: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

function errorResponse(response: Response, status: number, code: string) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.write(
      `data: ${JSON.stringify({ error: { code, message: "团队模型请求未完成" } })}\n\ndata: [DONE]\n\n`,
    );
    response.end();
    return;
  }
  response
    .status(status)
    .json({ error: { code, message: "团队模型请求未完成" } });
}

/** Only the private DeerFlow Gateway receives this distinct credential. */
export function validDeerFlowModelToken(
  authorization: string | undefined,
): boolean {
  const expected = process.env.DEER_FLOW_MODEL_PROXY_TOKEN || "";
  if (!/^[a-f0-9]{64}$/i.test(expected)) return false;
  const actual = authorization?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
  if (!actual) return false;
  return timingSafeEqual(
    createHash("sha256").update(expected).digest(),
    createHash("sha256").update(actual).digest(),
  );
}

export async function proxyDeerFlowModel(
  request: Request,
  response: Response,
  input: unknown,
) {
  response.setHeader("Cache-Control", "no-store");
  if (!validDeerFlowModelToken(request.get("Authorization"))) {
    errorResponse(response, 401, "UNAUTHORIZED");
    return;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    errorResponse(response, 400, "INVALID_REQUEST");
    return;
  }
  if (!serialized || Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) {
    errorResponse(response, 413, "REQUEST_TOO_LARGE");
    return;
  }
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    errorResponse(response, 400, "INVALID_REQUEST");
    return;
  }
  const disconnected = new AbortController();
  const abort = () => disconnected.abort();
  request.once("aborted", abort);
  response.once("close", abort);
  const signal = AbortSignal.any([
    disconnected.signal,
    AbortSignal.timeout(180000),
  ]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const settings = await one(
      db,
      "SELECT enabled,verified_at,api_key_encrypted FROM public.compass_ai_settings WHERE id=1",
    );
    if (
      !settings?.enabled ||
      !settings.verified_at ||
      !settings.api_key_encrypted
    ) {
      errorResponse(response, 503, "MODEL_NOT_CONFIGURED");
      return;
    }
    const body = parsed.data;
    const vision = body.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "image_url"),
    );
    const model = await resolveTeamModel({
      feature: "deerflow_team",
      orchestrator: true,
      vision,
      structured: !!body.response_format,
    });
    signal.throwIfAborted();
    const { max_completion_tokens, ...forwarded } = body;
    const upstream = await aiFetch("deerflow_team", COMPASS_AI_ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + decryptSecret(settings.api_key_encrypted),
      },
      body: JSON.stringify({
        ...forwarded,
        model: model.actual,
        max_tokens: body.max_tokens ?? max_completion_tokens ?? 8192,
        provider: { require_parameters: true, data_collection: "deny" },
        ...(model.parameters.includes("reasoning")
          ? { reasoning: { effort: model.reasoningEffort || "low" } }
          : {}),
      }),
    });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      errorResponse(
        response,
        upstream.status === 429 ? 429 : 502,
        "MODEL_UPSTREAM_ERROR",
      );
      return;
    }
    if (Number(upstream.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      await upstream.body.cancel();
      errorResponse(response, 502, "MODEL_RESPONSE_TOO_LARGE");
      return;
    }
    const contentType = upstream.headers.get("content-type") || "";
    if (
      !contentType.includes(
        body.stream ? "text/event-stream" : "application/json",
      )
    ) {
      await upstream.body.cancel();
      errorResponse(response, 502, "MODEL_INVALID_RESPONSE");
      return;
    }
    reader = upstream.body.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    if (body.stream) {
      response.status(200);
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders();
    }
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("Response limit");
      if (body.stream) {
        if (!response.write(value)) await once(response, "drain", { signal });
      } else chunks.push(value);
    }
    if (body.stream) response.end();
    else {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!payload || payload.error || !Array.isArray(payload.choices)) {
        errorResponse(response, 502, "MODEL_INVALID_RESPONSE");
        return;
      }
      response.status(200).json(payload);
    }
  } catch {
    errorResponse(
      response,
      502,
      signal.aborted ? "MODEL_REQUEST_INTERRUPTED" : "MODEL_UPSTREAM_ERROR",
    );
  } finally {
    await reader?.cancel().catch(() => undefined);
    request.off("aborted", abort);
    response.off("close", abort);
  }
}

@Controller("internal/deerflow/v1")
export class DeerFlowModelGatewayController {
  @Public()
  @Post("chat/completions")
  async complete(
    @Req() request: Request,
    @Res() response: Response,
    @Body() body: unknown,
  ) {
    await proxyDeerFlowModel(request, response, body);
  }
}

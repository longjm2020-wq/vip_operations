import { randomUUID } from "node:crypto";
import { db, one } from "../../../packages/database/src/index.js";
import {
  aiFeatures,
  type AiFeatureId,
} from "../../../packages/contracts/src/ai-management.js";

const validFeatures = new Set<string>(aiFeatures.map((feature) => feature.id));
const number = (value: unknown): number | null =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1e15
    ? value
    : null;
const text = (value: unknown, limit = 200) =>
  typeof value === "string" ? value.slice(0, limit) : null;
type Receipt = {
  characters: number | null;
  input: number | null;
  output: number | null;
  total: number | null;
  amount: number | null;
  unit: string | null;
  credits: number | null;
  creditUnit: string | null;
  model: string | null;
  requestId: string | null;
  failed: boolean;
  pending: boolean;
};
export function providerUsage(payload: unknown, source: string): Receipt {
  const data =
    payload && typeof payload === "object"
      ? (payload as Record<string, any>)
      : {};
  const response =
    data.response && typeof data.response === "object"
      ? data.response
      : data.data && typeof data.data === "object"
        ? { ...data, ...data.data }
        : data;
  const usage =
    response.usage && typeof response.usage === "object" ? response.usage : {};
  const input = number(usage.prompt_tokens ?? usage.input_tokens),
    output = number(usage.completion_tokens ?? usage.output_tokens);
  const microUsd = number(response.actual_cost_micro_usd);
  const amount =
    microUsd !== null
      ? microUsd / 1_000_000
      : number(usage.cost ?? usage.total_cost);
  const currency = text(usage.currency, 12);
  const unit =
    amount === null
      ? null
      : microUsd !== null
        ? "USD"
        : source === "openrouter.ai"
          ? "OpenRouter credits"
          : currency && /^[A-Z]{3}$/.test(currency)
            ? currency
            : null;
  const credits = number(usage.credits ?? usage.points);
  return {
    characters: number(usage.characters),
    input,
    output,
    total:
      number(usage.total_tokens) ??
      (input !== null && output !== null ? input + output : null),
    amount: unit ? amount : null,
    unit,
    credits,
    creditUnit: credits === null ? null : `${source}:credits`,
    model: text(response.model),
    requestId: text(
      response.id ?? response.request_id ?? response.task_id ?? response.taskId,
    ),
    failed:
      !!response.error ||
      (source.endsWith(".maas.aliyuncs.com") &&
        (Boolean(response.code) ||
          Number(response.status_code || 200) >= 400)) ||
      response.status === "failed" ||
      response.state === "failed" ||
      (typeof response.code === "number" && ![0, 200].includes(response.code)),
    pending: [
      "pending",
      "queued",
      "running",
      "processing",
      "in_progress",
      "created",
      "submitted",
    ].includes(response.status || response.state),
  };
}

async function finish(
  id: string,
  source: string,
  requestedModel: string,
  payload?: unknown,
) {
  const value = providerUsage(payload, source);
  const previous = value.requestId
    ? await one(
        db,
        "SELECT id,model FROM public.ai_model_usage WHERE source=$1 AND provider_request_id=$2 AND id<>$3::uuid",
        source,
        value.requestId,
        id,
      )
    : undefined;
  if (previous) {
    // One provider receipt is billed once, including later asynchronous results.
    await finish(String(previous.id), source, previous.model, payload);
    await db.$queryRawUnsafe(
      "UPDATE public.ai_model_usage SET completed_at=now() WHERE id=$1::uuid",
      id,
    );
    return;
  }
  // Successful HTTP alone does not establish that a selected model ran.
  const confirmed =
    !value.pending &&
    value.model &&
    (!requestedModel ||
      value.model === requestedModel ||
      value.model.startsWith(requestedModel + "-20") ||
      (requestedModel === "deepseek/deepseek-v4.1-flash-1017" &&
        value.model === "deepseek/deepseek-v4.1-flash-20261017"));
  await db.$queryRawUnsafe(
    `UPDATE public.ai_model_usage SET status=$2,response_model=$3,
    input_tokens=COALESCE($4,input_tokens),output_tokens=COALESCE($5,output_tokens),total_tokens=COALESCE($6,total_tokens),amount=COALESCE($7,amount),amount_unit=COALESCE($8,amount_unit),credits=COALESCE($9,credits),credit_unit=COALESCE($10,credit_unit),
    provider_request_id=COALESCE($11,provider_request_id),input_characters=COALESCE($12,input_characters),
    completed_at=now() WHERE id=$1::uuid`,
    id,
    value.failed ? "failed" : confirmed ? "success" : "responded",
    value.model,
    value.input,
    value.output,
    value.total,
    value.amount,
    value.unit,
    value.credits,
    value.creditUnit,
    value.requestId,
    value.characters,
  );
}

/** Trusted server-side terminal receipts only, never browser-provided bills. */
export async function recordAiReceipt(
  feature: AiFeatureId,
  source: string,
  model: string,
  payload: unknown,
) {
  if (!validFeatures.has(feature)) throw Error("Unknown AI feature");
  const receipt = providerUsage(payload, source);
  if (!receipt.requestId) return;
  let row = await one(
    db,
    "SELECT id FROM public.ai_model_usage WHERE source=$1 AND provider_request_id=$2",
    source,
    receipt.requestId,
  );
  if (!row) {
    row = { id: randomUUID() };
    await db.$queryRawUnsafe(
      "INSERT INTO public.ai_model_usage(id,feature_id,source,model,status) VALUES($1::uuid,$2,$3,$4,'responded')",
      row.id,
      feature,
      source,
      model,
    );
  }
  await finish(String(row.id), source, model, payload);
}

/** No prompts, media, headers, credentials or raw provider errors are stored. */
export async function aiFetch(
  feature: AiFeatureId,
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  if (!validFeatures.has(feature))
    throw Error("AI feature must be registered before calling a model");
  const source = new URL(url).hostname;
  let model = "";
  if (typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body);
      model =
        text(
          body.model ?? body.model_id ?? body.workflowId ?? body.session?.model,
        ) || "";
    } catch {
      /* multipart/non-JSON provider body */
    }
  } else if (init.body instanceof FormData) {
    model = text(init.body.get("model")) || "";
  }
  const id = randomUUID();
  await db.$queryRawUnsafe(
    "INSERT INTO public.ai_model_usage(id,feature_id,source,model) VALUES($1::uuid,$2,$3,$4)",
    id,
    feature,
    source,
    model,
  );
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    await db
      .$queryRawUnsafe(
        "UPDATE public.ai_model_usage SET status='failed',error_code='NETWORK_OR_ABORT',completed_at=now() WHERE id=$1::uuid",
        id,
      )
      .catch(() => {});
    throw cause;
  }
  await db
    .$queryRawUnsafe(
      "UPDATE public.ai_model_usage SET status=$2,http_status=$3,error_code=$4,completed_at=now() WHERE id=$1::uuid",
      id,
      response.ok ? "responded" : "failed",
      response.status,
      response.ok ? null : `HTTP_${response.status}`,
    )
    .catch(() => {});
  if (!response.ok || !response.body) return response;
  const streaming = (response.headers.get("content-type") || "").includes(
    "text/event-stream",
  );
  let buffer = "",
    oversized = false,
    receipt: unknown,
    seen: Record<string, unknown> = {};
  const decoder = new TextDecoder();
  const observe = (data: string) => {
    for (const line of data.split(/\r?\n/)) {
      if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]")
        continue;
      try {
        const event = JSON.parse(line.slice(5));
        const value = event.response || event;
        if (value.model || value.id || value.request_id)
          seen = {
            ...seen,
            ...(value.model ? { model: value.model } : {}),
            ...(value.id ? { id: value.id } : {}),
            ...(value.request_id ? { request_id: value.request_id } : {}),
          };
        if (
          value.usage ||
          value.error ||
          value.status === "failed" ||
          (source.endsWith(".maas.aliyuncs.com") &&
            (value.code || Number(value.status_code || 200) >= 400))
        )
          receipt = { ...((receipt as object) || {}), ...seen, ...value };
      } catch {
        /* Incomplete or non-JSON event; never infer usage. */
      }
    }
  };
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        if (oversized) return;
        buffer += decoder.decode(chunk, { stream: true });
        if (streaming) {
          const end = buffer.lastIndexOf("\n");
          if (end >= 0) {
            observe(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
          }
        }
        if (buffer.length > 2_000_000) {
          oversized = true;
          buffer = "";
        }
      },
      async flush() {
        if (!oversized) {
          buffer += decoder.decode();
          if (streaming) {
            observe(buffer);
            receipt ||= seen;
          } else {
            try {
              receipt = JSON.parse(buffer);
            } catch {
              /* Binary or unavailable receipt. */
            }
          }
        }
        // Accounting failure must not discard an already-paid, valid response.
        await finish(id, source, model, receipt).catch(() => {});
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

import { connectedModelRefs } from "../../ai-model-connections.js";
import type { Row } from "../../../../../packages/database/src/index.js";

/** Auth, permission and quota failures may retry once on another connected model. */
export function isModelAccessFallbackError(status: number, payload?: unknown) {
  if (status === 401 || status === 402 || status === 403) return true;
  const raw =
    payload && typeof payload === "object"
      ? ((payload as Row).error as Row | undefined)
      : undefined;
  const code = raw?.code;
  if (code === 401 || code === 402 || code === 403) return true;
  if (status !== 429 && code !== 429) return false;
  const type = raw?.metadata?.error_type;
  return type === "payment_required" || type === "token_limit_exceeded";
}

export function publicModelLabel(model: {
  displayName?: string;
  name: string;
}) {
  return (model.displayName || model.name).trim() || "已接通模型";
}

export function modelFallbackNotice(toLabel: string, reason: string) {
  return `已自动切换到 ${toLabel}（${reason}）`;
}

export function firstEligibleConnected<T extends { id: string }>(
  models: T[],
  connected: Set<string>,
  eligible: (model: T) => boolean,
  excluded: Iterable<string> = [],
) {
  const skip = new Set(excluded);
  return models.find(
    (model) =>
      connected.has(model.id) && !skip.has(model.id) && eligible(model),
  );
}

export async function safeConnectedModelRefs(
  models: { id: string; actual: string; provider?: "bailian" }[],
) {
  try {
    return await connectedModelRefs(models);
  } catch {
    return new Set<string>();
  }
}

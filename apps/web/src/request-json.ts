import { assistantPublicText } from "../../../packages/contracts/src/ai-presentation.js";

const readTimeoutMs = 20_000;
const retryDelayMs = 300;
const transientStatuses = new Set([502, 503, 504]);

function requestError(message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), extra);
}

function abortReason(signal: AbortSignal) {
  return signal.reason || new DOMException("请求已取消", "AbortError");
}

function waitToRetry(signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const cancel = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, retryDelayMs);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

async function requestOnce(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const external = init.signal;
  if (external?.aborted) throw abortReason(external);
  const cancel = () => controller.abort(abortReason(external!));
  external?.addEventListener("abort", cancel, { once: true });
  const timer =
    timeoutMs > 0
      ? setTimeout(
          () =>
            controller.abort(
              requestError("读取超时，请重试。", { code: "REQUEST_TIMEOUT" }),
            ),
          timeoutMs,
        )
      : undefined;
  try {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      if (
        error instanceof TypeError ||
        (error as Error)?.name === "NetworkError"
      )
        throw requestError("网络连接暂时中断，请重试。", {
          code: "NETWORK_ERROR",
        });
      throw error;
    }
    if (response.status === 204) return { data: null };
    let value;
    try {
      value = await response.json();
    } catch {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      // Reverse proxies can return HTML on failure; retain the HTTP status.
      if (response.ok)
        throw requestError("服务器返回的数据未能完整读取，请重试。", {
          status: response.status,
          code: "INVALID_RESPONSE",
        });
    }
    if (!response.ok) {
      const detail = value?.error;
      const message = typeof detail === "string" ? detail : detail?.message;
      const fallback =
        response.status === 401
          ? "登录状态已失效，请重新登录。"
          : transientStatuses.has(response.status)
            ? "服务暂时不可用，请重试。"
            : "请求失败，请重试。";
      throw requestError(assistantPublicText(message || fallback), {
        status: response.status,
        details: detail?.details,
      });
    }
    return value;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", cancel);
  }
}

/** Retry only reads. Writes and model submissions must never be replayed here. */
export async function requestJson(
  url: string,
  init: RequestInit = {},
  options: { readTimeoutMs?: number } = {},
) {
  const read = (init.method || "GET").toUpperCase() === "GET";
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce(
        url,
        init,
        read ? (options.readTimeoutMs ?? readTimeoutMs) : 0,
      );
    } catch (error) {
      if (init.signal?.aborted) throw abortReason(init.signal);
      const failure = error as { status?: number; code?: string };
      const transient =
        transientStatuses.has(failure.status || 0) ||
        ["NETWORK_ERROR", "REQUEST_TIMEOUT", "INVALID_RESPONSE"].includes(
          failure.code || "",
        );
      if (!read || attempt > 0 || !transient) throw error;
      await waitToRetry(init.signal);
    }
  }
}

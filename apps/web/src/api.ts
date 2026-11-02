import { QueryClient } from "@tanstack/react-query";
import { assistantPublicText } from "../../../packages/contracts/src/ai-presentation.js";
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 10000 },
    mutations: { retry: false },
  },
});
export let csrf = "";
export function setCsrf(v: string) {
  csrf = v;
}
export async function api(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
  options?: { keepalive?: boolean; signal?: AbortSignal },
) {
  const response = await fetch("/api/v1" + path, {
    method,
    credentials: "include",
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.keepalive ? { keepalive: true } : {}),
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(method === "GET"
        ? {}
        : {
            "X-CSRF-Token": csrf,
            "Idempotency-Key": key || crypto.randomUUID(),
          }),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return { data: null };
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "/auth/login")
      queryClient.setQueryData(["me"], null);
    throw Object.assign(new Error(assistantPublicText(result.error?.message || "请求失败")), {
      status: response.status,
      details: result.error?.details,
    });
  }
  return result;
}

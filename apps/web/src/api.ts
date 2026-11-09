import { QueryClient } from "@tanstack/react-query";
import { requestJson } from "./request-json";
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
  options?: {
    keepalive?: boolean;
    signal?: AbortSignal;
    readTimeoutMs?: number;
  },
) {
  try {
    return await requestJson(
      "/api/v1" + path,
      {
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
      },
      { readTimeoutMs: options?.readTimeoutMs },
    );
  } catch (error) {
    if ((error as { status?: number }).status === 401 && path !== "/auth/login")
      queryClient.setQueryData(["me"], null);
    throw error;
  }
}

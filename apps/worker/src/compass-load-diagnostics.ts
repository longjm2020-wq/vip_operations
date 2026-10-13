import type { BrowserContext } from "@playwright/test";

type LoadFailure = { hostname: string; resource: string; status?: number; category?: string; count: number };
const observations = new WeakMap<BrowserContext, { failures: Map<string, LoadFailure>; scriptErrors: number }>();

/** Bounded metadata only: never retain URLs, request/response bodies or error messages. */
export function observeCompassLoads(context: BrowserContext) {
  if (observations.has(context)) return;
  const state = { failures: new Map<string, LoadFailure>(), scriptErrors: 0 };
  observations.set(context, state);
  const record = (url: string, resource: string, detail: { status?: number; category?: string }) => {
    let hostname: string;
    try { hostname = new URL(url).hostname; } catch { return; }
    if (!/^(?:[a-z0-9-]+\.)*(?:vip\.com|vipstatic\.com)$/.test(hostname)) return;
    const key = `${hostname}|${resource}|${detail.status ?? detail.category}`;
    const previous = state.failures.get(key);
    if (previous) previous.count = Math.min(1000, previous.count + 1);
    else if (state.failures.size < 20) state.failures.set(key, { hostname, resource, ...detail, count: 1 });
  };
  context.on("response", response => {
    if (response.status() >= 400) record(response.url(), response.request().resourceType(), { status: response.status() });
  });
  context.on("requestfailed", request => {
    const raw = request.failure()?.errorText ?? "";
    const category = /ERR_ABORTED/.test(raw) ? "ABORTED" : /ERR_TIMED_OUT/.test(raw) ? "TIMEOUT" : /ERR_NAME_NOT_RESOLVED/.test(raw) ? "DNS" : /ERR_CERT_/.test(raw) ? "CERTIFICATE" : "NETWORK";
    record(request.url(), request.resourceType(), { category });
  });
  const watch = (page: ReturnType<BrowserContext["pages"]>[number]) => page.on("pageerror", () => { state.scriptErrors = Math.min(1000, state.scriptErrors + 1); });
  context.pages().forEach(watch);
  context.on("page", watch);
}

export function compassLoadDiagnostics(context: BrowserContext) {
  const state = observations.get(context);
  return { failures: state ? [...state.failures.values()].map(item => ({ ...item })) : [], scriptErrors: state?.scriptErrors ?? 0 };
}

import { EventEmitter } from "node:events";
import type { BrowserContext } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { compassLoadDiagnostics, observeCompassLoads } from "../../apps/worker/src/compass-load-diagnostics.js";

describe("Compass load diagnostics privacy", () => {
  it("retains only bounded metadata and excludes credentials, paths, bodies and script messages", () => {
    const page = new EventEmitter();
    const context = Object.assign(new EventEmitter(), { pages: () => [page] });
    const browserContext = context as unknown as BrowserContext;
    observeCompassLoads(browserContext);
    observeCompassLoads(browserContext);
    context.emit("response", { status: () => 920, url: () => "https://vis.vip.com/private?token=SECRET", request: () => ({ resourceType: () => "xhr" }) });
    context.emit("response", { status: () => 403, url: () => "https://other.example/?password=SECRET", request: () => ({ resourceType: () => "document" }) });
    context.emit("requestfailed", { url: () => "https://vis.vip.com/SECRET.js", resourceType: () => "script", failure: () => ({ errorText: "net::ERR_TIMED_OUT SECRET" }) });
    page.emit("pageerror", Error("SECRET response body"));
    expect(compassLoadDiagnostics(browserContext)).toEqual({ scriptErrors: 1, failures: [
      { hostname: "vis.vip.com", resource: "xhr", status: 920, count: 1 },
      { hostname: "vis.vip.com", resource: "script", category: "TIMEOUT", count: 1 },
    ] });
    expect(JSON.stringify(compassLoadDiagnostics(browserContext))).not.toMatch(/SECRET|private|token|other\.example|https:/);
    for (let index = 0; index < 30; index++) context.emit("response", { status: () => 400 + index, url: () => "https://vis.vip.com/secret", request: () => ({ resourceType: () => "xhr" }) });
    expect(compassLoadDiagnostics(browserContext).failures).toHaveLength(20);
    expect(context.listenerCount("response")).toBe(1);
  });
});

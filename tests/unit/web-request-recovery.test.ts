import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, queryClient, setCsrf } from "../../apps/web/src/api.js";
import { studioApi } from "../../apps/web/src/aigc/api.js";
import { requestJson } from "../../apps/web/src/request-json.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  queryClient.clear();
  setCsrf("");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("shared browser request recovery", () => {
  it("recovers a transient network read without replaying indefinitely", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(json({ data: ["loaded"] }));
    vi.stubGlobal("fetch", fetcher);
    const request = requestJson("/api/v1/items");
    await vi.advanceTimersByTimeAsync(300);
    await expect(request).resolves.toEqual({ data: ["loaded"] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([502, 503, 504])(
    "bounds recovery and preserves HTTP %s when a proxy returns HTML",
    async (status) => {
      const fetcher = vi.fn(() =>
        Promise.resolve(
          new Response("<html>gateway unavailable</html>", { status }),
        ),
      );
      vi.stubGlobal("fetch", fetcher);
      const checked = expect(
        requestJson("/api/v1/items"),
      ).rejects.toMatchObject({ status, message: "服务暂时不可用，请重试。" });
      await vi.advanceTimersByTimeAsync(300);
      await checked;
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it.each([400, 401, 403, 404, 429, 500])(
    "does not retry a non-transient HTTP %s",
    async (status) => {
      const fetcher = vi.fn(() =>
        Promise.resolve(
          json(
            { error: { message: "不能读取", details: { reason: "policy" } } },
            status,
          ),
        ),
      );
      vi.stubGlobal("fetch", fetcher);
      await expect(requestJson("/api/v1/items")).rejects.toMatchObject({
        status,
        message: "不能读取",
        details: { reason: "policy" },
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("reports invalid success data clearly after one read recovery attempt", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(new Response("<html>not an API response</html>")),
    );
    vi.stubGlobal("fetch", fetcher);
    const checked = expect(requestJson("/api/v1/items")).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE",
    });
    await vi.advanceTimersByTimeAsync(300);
    await checked;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("ends stalled headers after the read deadlines instead of spinning forever", async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signals.push(init.signal!);
          init.signal!.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const checked = expect(requestJson("/api/v1/items")).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(40_300);
    await checked;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the deadline active while waiting for the JSON response body", async () => {
    const fetcher = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve({
        status: 200,
        ok: true,
        json: () =>
          new Promise((_resolve, reject) =>
            init.signal!.addEventListener(
              "abort",
              () => reject(init.signal!.reason),
              { once: true },
            ),
          ),
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const checked = expect(requestJson("/api/v1/items")).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(40_300);
    await checked;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("allows a long read to choose a longer deadline", async () => {
    let finish: (value: Response) => void = () => undefined;
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          finish = resolve;
          init.signal!.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const request = api("/analytics/compass", "GET", undefined, undefined, {
      readTimeoutMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(false);
    finish(json({ data: "complete report" }));
    await expect(request).resolves.toEqual({ data: "complete report" });
  });

  it("cancels an in-flight read without another attempt", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const checked = expect(
      requestJson("/api/v1/items", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await checked;
    await vi.advanceTimersByTimeAsync(40_300);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restart a superseded read during its recovery delay", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetcher);
    const checked = expect(
      requestJson("/api/v1/items", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await checked;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not dispatch a read that was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      requestJson("/api/v1/items", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["POST", "PATCH", "DELETE"])(
    "never replays a failed %s",
    async (method) => {
      const fetcher = vi.fn(() =>
        Promise.resolve(new Response("Bad gateway", { status: 502 })),
      );
      vi.stubGlobal("fetch", fetcher);
      await expect(
        requestJson("/api/v1/action", { method, body: "{}" }),
      ).rejects.toMatchObject({ status: 502 });
      await vi.advanceTimersByTimeAsync(40_300);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("does not impose a read timeout or replay a long model submission", async () => {
    let finish: (value: Response) => void = () => undefined;
    const fetcher = vi.fn(
      (_url: string, _init: RequestInit) =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    setCsrf("csrf-fixture");
    const request = api(
      "/my-workspace/assistant",
      "POST",
      { text: "request" },
      "request-fixture",
    );
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(false);
    expect(fetcher.mock.calls[0][1].headers).toMatchObject({
      "X-CSRF-Token": "csrf-fixture",
      "Idempotency-Key": "request-fixture",
    });
    finish(json({ data: "done" }));
    await expect(request).resolves.toEqual({ data: "done" });
  });

  it("preserves the known session on an outage, but clears it on a real HTML 401", async () => {
    queryClient.setQueryData(["me"], { id: "known-user" });
    const fetcher = vi.fn(() =>
      Promise.resolve(new Response("Unavailable", { status: 503 })),
    );
    vi.stubGlobal("fetch", fetcher);
    const checked = expect(api("/auth/me")).rejects.toMatchObject({
      status: 503,
    });
    await vi.advanceTimersByTimeAsync(300);
    await checked;
    expect(queryClient.getQueryData(["me"])).toEqual({ id: "known-user" });
    fetcher.mockImplementation(() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 })),
    );
    await expect(api("/auth/me")).rejects.toMatchObject({ status: 401 });
    expect(queryClient.getQueryData(["me"])).toBeNull();
  });

  it("shares read recovery with AIGC while preserving form uploads and no-content replies", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(json({ data: ["project"] }));
    vi.stubGlobal("fetch", fetcher);
    const read = studioApi("/projects");
    await vi.advanceTimersByTimeAsync(300);
    await expect(read).resolves.toEqual({ data: ["project"] });
    const form = new FormData();
    form.set("name", "file");
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(studioApi("/assets", "POST", form)).resolves.toEqual({
      data: null,
    });
    expect(fetcher.mock.calls[2][1].body).toBe(form);
    expect(fetcher.mock.calls[2][1].headers).not.toHaveProperty("Content-Type");
  });
});

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  isPageResourceError,
  loadPageResource,
} from "../../apps/web/src/page-resource-loader.js";

afterEach(() => vi.useRealTimers());

describe("page resource retry", () => {
  test("successful loads resolve immediately without an extra request", async () => {
    const page = { default: "page" };
    const load = vi.fn().mockResolvedValue(page);
    await expect(loadPageResource(load)).resolves.toBe(page);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("one transient module failure recovers after a bounded delay", async () => {
    vi.useFakeTimers();
    const page = { default: "page" };
    const load = vi
      .fn()
      .mockRejectedValueOnce(
        new TypeError(
          "Failed to fetch dynamically imported module: /assets/system-old.js",
        ),
      )
      .mockResolvedValue(page);
    const pending = loadPageResource(load);
    await vi.advanceTimersByTimeAsync(349);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(page);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("a missing deployed chunk stops after two attempts for explicit recovery", async () => {
    vi.useFakeTimers();
    const error = new TypeError(
      "Failed to fetch dynamically imported module: /assets/missing.js",
    );
    const load = vi.fn().mockRejectedValue(error);
    const assertion = expect(loadPageResource(load)).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(load).toHaveBeenCalledTimes(2);
    expect(isPageResourceError(error)).toBe(true);
  });

  test("module evaluation errors are not replayed", async () => {
    const error = new SyntaxError("Unexpected token");
    const load = vi.fn().mockRejectedValue(error);
    await expect(loadPageResource(load)).rejects.toBe(error);
    expect(load).toHaveBeenCalledTimes(1);
    expect(isPageResourceError(error)).toBe(false);
  });

  test("a failed CSS preload goes to recovery instead of skipping required styles", async () => {
    const error = new Error("Unable to preload CSS for /assets/styles-old.css");
    const load = vi.fn().mockRejectedValue(error);
    await expect(loadPageResource(load)).rejects.toBe(error);
    expect(load).toHaveBeenCalledTimes(1);
    expect(isPageResourceError(error)).toBe(true);
  });
});

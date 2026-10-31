import { expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import {
  captureJstLoginFrame,
  JstLoginInputTracker,
} from "../../apps/worker/src/jushuitan-login-input.js";

it("keeps the login alive after a navigation-time screenshot failure and retries only masked captures", async () => {
  const screenshot = vi
    .fn()
    .mockRejectedValueOnce(new Error("Frame detached"))
    .mockResolvedValue(Buffer.from("fixture-jpeg"));
  const mask = { fixture: "credentials" };
  const page = {
    screenshot,
    frames: () => [
      {
        isDetached: () => false,
        url: () => "https://www.erp321.com/login",
        locator: () => mask,
      },
    ],
  } as unknown as Page;
  const inputs = new JstLoginInputTracker();
  vi.spyOn(inputs, "current").mockResolvedValue(null);
  expect(await captureJstLoginFrame(page, inputs)).toBeNull();
  expect(screenshot).toHaveBeenCalledTimes(1);
  expect(await captureJstLoginFrame(page, inputs)).toEqual({
    frameInput: null,
    jpg: Buffer.from("fixture-jpeg"),
  });
  expect(screenshot).toHaveBeenCalledTimes(2);
  for (const [options] of screenshot.mock.calls)
    expect(options.mask).toEqual([mask]);
});

it("never sends a frame or a stale input token when focus inspection fails during login navigation", async () => {
  const screenshot = vi.fn();
  const page = { screenshot } as unknown as Page;
  const inputs = new JstLoginInputTracker();
  vi.spyOn(inputs, "current").mockRejectedValue(
    new Error("Execution context was destroyed"),
  );
  expect(await captureJstLoginFrame(page, inputs)).toBeNull();
  expect(screenshot).not.toHaveBeenCalled();
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  heartbeat: vi.fn(),
  claim: vi.fn(),
  open: vi.fn(),
}));
vi.mock("../../apps/api/src/modules/workspace/assistant-browser.js", () => ({
  heartbeatBrowserWorker: fixture.heartbeat,
  claimBrowserTask: fixture.claim,
}));
vi.mock("../../apps/worker/src/assistant-browser-page.js", () => ({
  openIndependentBrowser: fixture.open,
}));
vi.mock("../../apps/worker/src/assistant-browser-runner.js", () => ({
  runIndependentBrowser: vi.fn(),
}));
import { startAssistantBrowserJobs } from "../../apps/worker/src/assistant-browser-jobs.js";

let stop: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  fixture.heartbeat.mockReset().mockResolvedValue(undefined);
  fixture.claim.mockReset().mockResolvedValue(null);
  fixture.open.mockReset();
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("browser startup diagnostic heartbeat", () => {
  it("keeps the sanitized reason during periodic heartbeats, retries safely and clears it through readiness", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    fixture.open.mockRejectedValueOnce(
      new Error(
        "[FATAL:sandbox/linux/services/credentials.cc:131] Check failed: . : Permission denied (13)\nDATABASE_URL=private-secret",
      ),
    );
    const close = vi.fn(async () => {});
    fixture.open.mockResolvedValue({ close });
    stop = startAssistantBrowserJobs();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.heartbeat).toHaveBeenLastCalledWith(
      false,
      "BROWSER_SANDBOX_UNAVAILABLE",
    );
    await vi.advanceTimersByTimeAsync(12000);
    expect(fixture.heartbeat).toHaveBeenLastCalledWith(
      false,
      "BROWSER_SANDBOX_UNAVAILABLE",
    );
    expect(fixture.open).toHaveBeenCalledTimes(1);
    expect(fixture.claim).not.toHaveBeenCalled();
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(
      /private-secret|DATABASE_URL|credentials\.cc/,
    );
    await vi.advanceTimersByTimeAsync(31000);
    expect(close).toHaveBeenCalledTimes(1);
    expect(fixture.heartbeat.mock.calls.some((call) => call[0] === true)).toBe(
      true,
    );
    expect(fixture.claim).toHaveBeenCalled();
  });
});

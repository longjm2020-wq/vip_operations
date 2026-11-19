import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserRun } from "../../apps/api/src/modules/workspace/assistant-browser.js";
import type { runIndependentBrowser } from "../../apps/worker/src/assistant-browser-runner.js";
const fixture = vi.hoisted(() => ({
  heartbeat: vi.fn(),
  claim: vi.fn(),
  open: vi.fn(),
  runner: vi.fn<typeof runIndependentBrowser>(),
  config: vi.fn(),
  construct: vi.fn(),
  probe: vi.fn(),
  cleanup: vi.fn(),
  remoteOpen: vi.fn(),
}));
vi.mock("../../apps/api/src/modules/workspace/assistant-browser.js", () => ({
  heartbeatBrowserWorker: fixture.heartbeat,
  claimBrowserTask: fixture.claim,
}));
vi.mock("../../apps/worker/src/assistant-browser-page.js", () => ({
  openIndependentBrowser: fixture.open,
}));
vi.mock("../../apps/worker/src/assistant-browser-runner.js", () => ({
  runIndependentBrowser: fixture.runner,
}));
vi.mock("../../apps/worker/src/assistant-browser-railway.js", () => ({
  railwayBrowserConfig: fixture.config,
  RailwayBrowserRuntime: class {
    constructor(config: unknown) {
      fixture.construct(config);
    }
    probe(signal: AbortSignal) {
      return fixture.probe(signal);
    }
    cleanup(signal: AbortSignal) {
      return fixture.cleanup(signal);
    }
    open(run: BrowserRun, saved: unknown, signal: AbortSignal, viewport?: BrowserRun["viewport"]) {
      return fixture.remoteOpen(run, saved, signal, viewport);
    }
  },
}));
import { startAssistantBrowserJobs } from "../../apps/worker/src/assistant-browser-jobs.js";

let stop: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T00:00:00Z"));
  vi.stubEnv("ASSISTANT_BROWSER_RUNTIME", "local");
  fixture.heartbeat.mockReset().mockResolvedValue(undefined);
  fixture.claim.mockReset().mockResolvedValue(null);
  fixture.open.mockReset();
  fixture.runner.mockReset().mockResolvedValue(undefined);
  fixture.config.mockReset().mockReturnValue({
    token: "fake-read-only-token",
    environmentId: "fake-environment",
  });
  fixture.construct.mockReset();
  fixture.probe.mockReset().mockResolvedValue(undefined);
  fixture.cleanup.mockReset().mockResolvedValue(undefined);
  fixture.remoteOpen.mockReset();
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
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
    expect(fixture.construct).not.toHaveBeenCalled();
    expect(fixture.remoteOpen).not.toHaveBeenCalled();
  });
});

const run = (id: string): BrowserRun => ({
  id,
  userId: "7",
  profileId: "profile-7",
  profileVersion: 1,
  leaseId: `lease-${id}`,
  epoch: 0,
  instruction: "Open a public example page",
  initialUrl: "https://example.com/",
  url: "",
  status: "RUNNING",
  step: 0,
  expiresAt: "2026-11-16T01:00:00Z",
});

describe("Railway browser job scheduling", () => {
  beforeEach(() => {
    vi.stubEnv("ASSISTANT_BROWSER_RUNTIME", "railway");
  });

  it("uses read-only readiness and reconciliation without allocating a browser while idle", async () => {
    stop = startAssistantBrowserJobs();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.construct).toHaveBeenCalledOnce();
    expect(fixture.probe).toHaveBeenCalledOnce();
    expect(fixture.heartbeat).toHaveBeenCalledWith(true, expect.any(String));
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    expect(fixture.heartbeat.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.cleanup.mock.invocationCallOrder[0],
    );
    await vi.advanceTimersByTimeAsync(20000);
    expect(fixture.claim).toHaveBeenCalled();
    expect(fixture.probe).toHaveBeenCalledOnce();
    expect(fixture.cleanup).toHaveBeenCalledTimes(2);
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.remoteOpen).not.toHaveBeenCalled();
    expect(fixture.runner).not.toHaveBeenCalled();
  });

  it("keeps cleanup running after failed readiness and never exposes raw authentication errors", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    fixture.probe.mockRejectedValue(
      new Error("Railway rejected API_TOKEN=private-token for private-project"),
    );
    fixture.cleanup.mockRejectedValueOnce(
      new Error("cleanup is temporarily unavailable"),
    );
    stop = startAssistantBrowserJobs();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.heartbeat).toHaveBeenLastCalledWith(
      false,
      "BROWSER_RUNTIME_UNAVAILABLE",
    );
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(16000);
    expect(fixture.cleanup).toHaveBeenCalledTimes(2);
    expect(fixture.probe).toHaveBeenCalledOnce();
    expect(fixture.claim).not.toHaveBeenCalled();
    expect(fixture.remoteOpen).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(
      /private-token|private-project|API_TOKEN/,
    );
  });

  it("rechecks authorization periodically, stops claiming after revocation and resumes only after a new successful probe", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fixture.probe
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("BROWSER_RUNTIME_UNAVAILABLE"))
      .mockResolvedValue(undefined);
    stop = startAssistantBrowserJobs();
    await vi.advanceTimersByTimeAsync(61000);
    expect(fixture.probe).toHaveBeenCalledTimes(2);
    expect(fixture.heartbeat).toHaveBeenLastCalledWith(
      false,
      "BROWSER_RUNTIME_UNAVAILABLE",
    );
    const claimsBeforeRecovery = fixture.claim.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(fixture.claim).toHaveBeenCalledTimes(claimsBeforeRecovery);
    expect(fixture.probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.probe).toHaveBeenCalledTimes(3);
    expect(fixture.claim.mock.calls.length).toBeGreaterThan(
      claimsBeforeRecovery,
    );
    await vi.advanceTimersByTimeAsync(11000);
    expect(fixture.heartbeat).toHaveBeenLastCalledWith(
      true,
      expect.any(String),
    );
    expect(fixture.construct).toHaveBeenCalledOnce();
    expect(fixture.remoteOpen).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("binds only claimed tasks to remote drivers, limits concurrency and waits for driver cleanup when stopping", async () => {
    const tasks = [run("a"), run("b"), run("c")];
    const saved = { cookies: [], origins: [] };
    const viewport = { width: 720, height: 960 };
    const finished = new Map<string, () => void>();
    const closed: string[] = [];
    fixture.claim
      .mockResolvedValueOnce(tasks[0])
      .mockResolvedValueOnce(tasks[1])
      .mockResolvedValueOnce(tasks[2]);
    fixture.remoteOpen.mockImplementation(async (task: BrowserRun) => ({
      close: async () => {
        closed.push(task.id);
      },
    }));
    fixture.runner.mockImplementation(async (task, _store, signal, open) => {
      if (!open) throw Error("Remote opener was not supplied");
      const driver = await open(saved, signal, viewport);
      await new Promise<void>((resolve) => {
        finished.set(task.id, resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await driver.close();
    });
    stop = startAssistantBrowserJobs();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fixture.claim).toHaveBeenCalledTimes(2);
    expect(fixture.remoteOpen).toHaveBeenCalledTimes(2);
    const signal = fixture.remoteOpen.mock.calls[0][2] as AbortSignal;
    expect(fixture.remoteOpen).toHaveBeenNthCalledWith(
      1,
      tasks[0],
      saved,
      signal,
      viewport,
    );
    expect(fixture.remoteOpen).toHaveBeenNthCalledWith(
      2,
      tasks[1],
      saved,
      signal,
      viewport,
    );
    expect(signal.aborted).toBe(false);
    finished.get("a")!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.remoteOpen).toHaveBeenNthCalledWith(
      3,
      tasks[2],
      saved,
      signal,
      viewport,
    );
    expect(closed).toEqual(["a"]);
    await stop();
    stop = undefined;
    expect(signal.aborted).toBe(true);
    expect(closed.sort()).toEqual(["a", "b", "c"]);
    expect(fixture.heartbeat).toHaveBeenLastCalledWith(false);
    const claimsAtStop = fixture.claim.mock.calls.length;
    const cleanupAtStop = fixture.cleanup.mock.calls.length;
    await vi.advanceTimersByTimeAsync(70000);
    expect(fixture.claim).toHaveBeenCalledTimes(claimsAtStop);
    expect(fixture.cleanup).toHaveBeenCalledTimes(cleanupAtStop);
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("aborts an in-flight readiness check without starting a task or local fallback", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let signal: AbortSignal | undefined;
    fixture.probe.mockImplementation((current: AbortSignal) => {
      signal = current;
      return new Promise<void>((_resolve, reject) => {
        current.addEventListener("abort", () => reject(new Error("Aborted")), {
          once: true,
        });
      });
    });
    stop = startAssistantBrowserJobs();
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(false);
    await stop();
    stop = undefined;
    expect(signal?.aborted).toBe(true);
    expect(fixture.heartbeat).toHaveBeenLastCalledWith(false);
    expect(fixture.claim).not.toHaveBeenCalled();
    expect(fixture.runner).not.toHaveBeenCalled();
    expect(fixture.remoteOpen).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(65000);
    expect(fixture.probe).toHaveBeenCalledOnce();
  });
});

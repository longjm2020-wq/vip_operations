import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "railway";
import type { BrowserRun } from "../../apps/api/src/modules/workspace/assistant-browser.js";
import type * as Environments from "../../apps/worker/src/assistant-browser-environments.js";
import type { BrowserRpcTransport } from "../../apps/worker/src/assistant-browser-remote.js";

const remote = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../../apps/worker/src/assistant-browser-remote.js", () => ({
  openRemoteBrowser: remote.open,
}));
import {
  RailwayBrowserRuntime,
  browserRuntimeCommand,
  browserRuntimeFiles,
} from "../../apps/worker/src/assistant-browser-railway.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type ClientOptions = {
  fetch: typeof fetch;
  environmentId: string;
  token: string;
};
function fixture() {
  const environmentId = randomUUID(),
    sandboxId = randomUUID(),
    intentId = randomUUID();
  const controller = new AbortController();
  const run: BrowserRun = {
    id: randomUUID(),
    userId: "7",
    profileId: randomUUID(),
    profileVersion: 1,
    leaseId: randomUUID(),
    epoch: 0,
    instruction: "Read the public example page",
    initialUrl: "https://example.com/",
    url: "",
    status: "RUNNING",
    step: 0,
    expiresAt: new Date(Date.now() + 90000).toISOString(),
  };
  const events: string[] = [];
  let reserved = false,
    recorded: string | undefined,
    released = false,
    destroyed = false;
  const started = deferred<void>(),
    receiptRead = deferred<void>(),
    finished = deferred<void>();
  const behavior: {
    receipt?: Promise<Response>;
    ready?: Promise<void>;
    resolvedId?: string;
    resolvedEnvironment?: string;
    connectedEnvironment?: string;
    cleanupConfirmed: boolean;
  } = { cleanupConfirmed: true };
  const response = () =>
    new Response(
      JSON.stringify({
        data: {
          sandboxCreate: { id: sandboxId, environmentId, status: "CREATING" },
        },
      }),
      { status: 200 },
    );
  const request = vi.fn<typeof fetch>(
    async () => behavior.receipt || response(),
  );
  const reserve = vi.fn(async () => {
    events.push("reserve");
    if (reserved) return null;
    reserved = true;
    return intentId;
  });
  const record = vi.fn(async (_id: string, id: string) => {
    events.push("record");
    recorded = id;
    return true;
  });
  const release = vi.fn(async (_id: string, id: string | null) => {
    events.push("release");
    if ((recorded || null) === id) released = true;
  });
  const cleanup = vi.fn(async () =>
    recorded && !released
      ? [{ id: intentId, sandboxId: recorded, environmentId }]
      : [],
  );
  const store = {
    reserveBrowserEnvironment: reserve,
    recordBrowserEnvironment: record,
    releaseBrowserEnvironment: release,
    browserEnvironmentsToCleanup: cleanup,
  } as unknown as typeof Environments;
  const write = vi.fn(async () => {
    events.push("file");
  });
  const destroy = vi.fn(async () => {
    events.push("destroy");
    destroyed = true;
  });
  const execHttp = vi.fn(async () => ({
    exitCode: 0,
    timedOut: false,
    stdout: "XUTI_BROWSER_RUNTIME_READY\n",
    stderr: "",
  }));
  const execution = Object.assign(finished.promise, {
    kill: vi.fn(async () => {
      finished.resolve();
      return true;
    }),
    stdin: { write: vi.fn(async () => {}) },
  });
  const exec = vi.fn(
    (_command: string, _options: { timeoutSec: number }) => execution,
  );
  const vm = {
    id: sandboxId,
    environmentId,
    networkIsolation: "ISOLATED",
    domains: [],
    status: "RUNNING",
    files: { write },
    destroy,
    execHttp,
    exec,
  };
  const create = vi.fn(async (options: ClientOptions) => {
    events.push("create");
    started.resolve();
    await options.fetch("https://backboard.railway.com/graphql/v2", {
      method: "POST",
      body: JSON.stringify({
        query: "mutation { sandboxCreate(input: {}) { id environmentId } }",
      }),
    });
    events.push("sdk_receipt");
    receiptRead.resolve();
    if (behavior.ready) await behavior.ready;
    events.push("sdk_ready");
    return {
      ...vm,
      id: behavior.resolvedId || sandboxId,
      environmentId: behavior.resolvedEnvironment || environmentId,
    };
  });
  const connect = vi.fn(async () => ({
    ...vm,
    environmentId: behavior.connectedEnvironment || environmentId,
    status: destroyed
      ? behavior.cleanupConfirmed
        ? "DESTROYED"
        : "DESTROYING"
      : "RUNNING",
  }));
  const list = vi.fn(async () => []);
  const sdk = { create, connect, list } as unknown as Pick<
    typeof Sandbox,
    "create" | "connect" | "list"
  >;
  const assets = vi.fn(async () =>
    browserRuntimeFiles.map((path) => ({ path, content: "export {};\n" })),
  );
  const runtime = new RailwayBrowserRuntime(
    { token: "controller-only-secret", environmentId },
    {
      sdk,
      store,
      fetch: request,
      assets,
      versions: { playwright: "1.63.0", zod: "4.3.6" },
      cleanupMs: 30,
    },
  );
  return {
    runtime,
    run,
    controller,
    behavior,
    response,
    started,
    receiptRead,
    events,
    environmentId,
    sandboxId,
    intentId,
    request,
    reserve,
    record,
    release,
    cleanup,
    create,
    connect,
    list,
    assets,
    write,
    destroy,
    execHttp,
    exec,
    execution,
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  remote.open
    .mockReset()
    .mockImplementation(async (transport: BrowserRpcTransport) => ({
      close: () => transport.close(),
    }));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Railway independent browser lifecycle (no real resources)", () => {
  it("performs only read-only health checks and never reserves or creates a probe VM", async () => {
    const f = fixture();
    await f.runtime.probe(f.controller.signal);
    await f.runtime.probe(f.controller.signal);
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.list).toHaveBeenCalledWith(
      expect.objectContaining({
        first: 1,
        environmentId: f.environmentId,
        authType: "project-token",
      }),
    );
  });
  it("records the create receipt before SDK readiness and uses one bounded isolated runtime without controller secrets", async () => {
    const f = fixture(),
      gate = deferred<void>();
    f.behavior.ready = gate.promise;
    const saved = {
      cookies: [{ name: "session", value: "owned-cookie-secret" }],
      origins: [],
    };
    const opening = f.runtime.open(f.run, saved, f.controller.signal);
    await f.receiptRead.promise;
    expect(f.record).toHaveBeenCalledWith(f.intentId, f.sandboxId);
    expect(f.write).not.toHaveBeenCalled();
    gate.resolve();
    const driver = await opening;
    expect(f.events.indexOf("record")).toBeLessThan(
      f.events.indexOf("sdk_ready"),
    );
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: { cpu: 1, memoryGB: 2 },
        networkIsolation: "ISOLATED",
        domains: [],
        env: {},
        idleTimeoutMinutes: 1,
      }),
    );
    expect(f.write).toHaveBeenCalledTimes(browserRuntimeFiles.length + 2);
    expect(JSON.stringify(f.write.mock.calls)).not.toMatch(
      /controller-only-secret|owned-cookie-secret|DATABASE_URL|COMPASS_MAIL_KEY/,
    );
    expect(remote.open).toHaveBeenCalledWith(
      expect.any(Object),
      saved,
      expect.any(AbortSignal),
    );
    expect(f.exec).toHaveBeenCalledWith(
      browserRuntimeCommand,
      expect.objectContaining({
        stdin: true,
        ephemeral: true,
        captureOutput: false,
        timeoutSec: expect.any(Number),
      }),
    );
    const timeout = f.exec.mock.calls[0][1] as unknown as {
      timeoutSec: number;
    };
    expect(timeout.timeoutSec).toBeGreaterThan(0);
    expect(timeout.timeoutSec).toBeLessThanOrEqual(90);
    await driver.close();
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledWith(f.intentId, f.sandboxId);
    expect(f.events.indexOf("release")).toBeGreaterThan(
      f.events.indexOf("destroy"),
    );
  });
  it("keeps an already sent create receipt alive after cancellation, records its late ID and destroys it without setup", async () => {
    const f = fixture(),
      receipt = deferred<Response>();
    f.behavior.receipt = receipt.promise;
    const opening = f.runtime.open(f.run, null, f.controller.signal);
    await f.started.promise;
    f.controller.abort();
    await expect(opening).rejects.toThrow();
    const createSignal = f.request.mock.calls[0][1]?.signal;
    expect(createSignal?.aborted).toBe(false);
    expect(f.release).not.toHaveBeenCalled();
    receipt.resolve(f.response());
    await f.receiptRead.promise;
    expect(f.record).toHaveBeenCalledWith(f.intentId, f.sandboxId);
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledWith(f.intentId, f.sandboxId);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it("rejects a different SDK resource ID before transferring files or login state", async () => {
    const f = fixture();
    f.behavior.resolvedId = randomUUID();
    await expect(
      f.runtime.open(f.run, { cookies: [], origins: [] }, f.controller.signal),
    ).rejects.toThrow();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.execHttp).not.toHaveBeenCalled();
    expect(remote.open).not.toHaveBeenCalled();
    expect(
      f.connect.mock.calls.every(
        (call) => (call as unknown[])[0] === f.sandboxId,
      ),
    ).toBe(true);
    expect(f.release).toHaveBeenCalledWith(f.intentId, f.sandboxId);
  });
  it("never destroys a sandbox returned from another environment or releases its unresolved reservation", async () => {
    const f = fixture();
    f.behavior.resolvedEnvironment = f.behavior.connectedEnvironment =
      randomUUID();
    await expect(
      f.runtime.open(f.run, null, f.controller.signal),
    ).rejects.toThrow();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.destroy).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    await f.runtime.cleanup(new AbortController().signal);
    expect(f.cleanup).toHaveBeenCalledWith(f.environmentId);
    expect(f.destroy).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });
  it("keeps the ledger occupied until destruction is confirmed, then allows the cleanup reaper to release it", async () => {
    const f = fixture();
    f.behavior.cleanupConfirmed = false;
    const driver = await f.runtime.open(f.run, null, f.controller.signal);
    await expect(driver.close()).rejects.toThrow();
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.release).not.toHaveBeenCalled();
    f.behavior.cleanupConfirmed = true;
    await f.runtime.cleanup(new AbortController().signal);
    expect(f.release).toHaveBeenCalledWith(f.intentId, f.sandboxId);
  });
  it("cleans up a created sandbox after installation fails without opening an RPC browser", async () => {
    const f = fixture();
    f.execHttp.mockResolvedValue({
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "private setup diagnostic",
    });
    await expect(
      f.runtime.open(f.run, null, f.controller.signal),
    ).rejects.toThrow();
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledWith(f.intentId, f.sandboxId);
    expect(f.exec).not.toHaveBeenCalled();
    expect(remote.open).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "private setup diagnostic",
    );
  });
  it("never retries an unknown create outcome or frees its unresolved global slot", async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error("provider response was lost"));
    await expect(
      f.runtime.open(f.run, null, f.controller.signal),
    ).rejects.toThrow();
    await expect(
      f.runtime.open(f.run, null, new AbortController().signal),
    ).rejects.toThrow();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.record).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
});

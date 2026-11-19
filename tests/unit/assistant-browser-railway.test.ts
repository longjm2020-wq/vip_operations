import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox, SandboxCheckpointInfo } from "railway";
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
  browserRuntimeUnpackScript,
  browserRuntimeVerify,
  browserTemplatePrefix,
  railwayBrowserConfig,
  validBrowserCheckpointId,
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
function fixture(configuredTemplate?: string) {
  const environmentId = randomUUID(),
    sandboxId = randomUUID(),
    intentId = randomUUID();
  const template =
    configuredTemplate ??
    browserTemplatePrefix({ playwright: "1.63.0", zod: "4.3.6" }) +
      randomUUID();
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
  const write = vi.fn(async (_path: string, _content: string) => {
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
  const heartbeat = vi.fn(async () => ({
    id: sandboxId,
    environmentId,
    networkIsolation: "ISOLATED",
    domains: [],
    status: "RUNNING",
  }));
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
    heartbeat,
  };
  const create = vi.fn(async (_template: string, options: ClientOptions) => {
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
  const checkpoints = vi.fn(async (): Promise<SandboxCheckpointInfo[]> => [
    {
      id: randomUUID(),
      key: template,
      environmentId,
      createdAt: new Date().toISOString(),
    },
  ]);
  const sdk = { create, connect, checkpoints } as unknown as Pick<
    typeof Sandbox,
    "create" | "connect" | "checkpoints"
  >;
  const assets = vi.fn(async () =>
    browserRuntimeFiles.map((path) => ({ path, content: "export {};\n" })),
  );
  const runtime = new RailwayBrowserRuntime(
    { token: "controller-only-secret", environmentId, template },
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
    template,
    sandboxId,
    intentId,
    request,
    reserve,
    record,
    release,
    cleanup,
    create,
    connect,
    checkpoints,
    assets,
    write,
    destroy,
    execHttp,
    exec,
    execution,
    heartbeat,
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  remote.open
    .mockReset()
    .mockImplementation(async (transport: BrowserRpcTransport) => ({
      close: () => transport.close(),
    }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Railway independent browser lifecycle (no real resources)", () => {
  it("uploads one fixed bundle and verifies it only after the upload finishes", async () => {
    const f = fixture();
    const upload = deferred<void>();
    f.write.mockReturnValue(upload.promise);
    const opening = f.runtime.open(f.run, null, f.controller.signal);
    await vi.waitFor(() => expect(f.write).toHaveBeenCalledTimes(1));
    expect(f.execHttp).not.toHaveBeenCalled();
    expect(f.exec).not.toHaveBeenCalled();
    const [path, content] = f.write.mock.calls[0];
    expect(path).toBe("/tmp/xuti-browser-runtime/runtime-bundle.json");
    expect(JSON.parse(content)).toEqual(
      Object.fromEntries(
        browserRuntimeFiles.map((name) => [name, "export {};\n"]),
      ),
    );
    upload.resolve();
    const driver = await opening;
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.execHttp).toHaveBeenCalledTimes(1);
    await driver.close();
  });
  it("never verifies or executes a partial bundle after upload failure", async () => {
    const f = fixture();
    f.write.mockRejectedValue(Error("upload failed"));
    await expect(
      f.runtime.open(f.run, null, f.controller.signal),
    ).rejects.toThrow();
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.execHttp).not.toHaveBeenCalled();
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledWith(f.intentId, f.sandboxId);
  });
  it("drains a submitted bundle on cancellation before destruction", async () => {
    const f = fixture();
    const upload = deferred<void>();
    f.write.mockReturnValue(upload.promise);
    const opening = f.runtime.open(f.run, null, f.controller.signal);
    const failed = expect(opening).rejects.toThrow();
    await vi.waitFor(() => expect(f.write).toHaveBeenCalledTimes(1));
    f.controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.destroy).not.toHaveBeenCalled();
    upload.resolve();
    await failed;
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.execHttp).not.toHaveBeenCalled();
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledWith(f.intentId, f.sandboxId);
  });
  it("checks the digest and exact fixed paths before unpacking any runtime code", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "xuti-runtime-bundle-test-"),
    );
    const bundleFile = join(directory, "runtime-bundle.json");
    const files = Object.fromEntries(
      browserRuntimeFiles.map((path) => [path, "export {};\n"]),
    );
    const digest = (content: string) =>
      createHash("sha256").update(content).digest("hex");
    const unpack = (hash: string) =>
      spawnSync(
        process.execPath,
        ["-e", browserRuntimeUnpackScript, directory, hash],
        { timeout: 5000 },
      );
    try {
      const untrusted: Record<string, string> = {
        ...files,
        "../outside.js": "unexpected",
      };
      delete untrusted[browserRuntimeFiles[0]];
      const invalid = JSON.stringify(untrusted);
      await writeFile(bundleFile, invalid);
      expect(unpack(digest(invalid)).status).toBe(2);
      expect(await readdir(directory)).toEqual(["runtime-bundle.json"]);
      const valid = JSON.stringify(files);
      await writeFile(bundleFile, valid);
      expect(unpack(digest(invalid)).status).toBe(2);
      expect(await readdir(directory)).toEqual(["runtime-bundle.json"]);
      expect(unpack(digest(valid)).status).toBe(0);
      expect((await readdir(directory)).sort()).toEqual([
        "apps",
        "package.json",
        "packages",
      ]);
      expect(await readFile(join(directory, "package.json"), "utf8")).toBe(
        '{"type":"module","private":true}',
      );
      for (const path of browserRuntimeFiles)
        expect(await readFile(join(directory, path), "utf8")).toBe(files[path]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("keeps only the live VM alive past its provider idle timeout and stops at close", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.run.expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const driver = await f.runtime.open(f.run, null, f.controller.signal);
    expect(f.heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100000);
    expect(f.heartbeat).toHaveBeenCalledTimes(6);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.destroy).not.toHaveBeenCalled();
    await driver.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.heartbeat).toHaveBeenCalledTimes(6);
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledWith(f.intentId, f.sandboxId);
  });
  it("does not overlap slow heartbeats or continue them after task cancellation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const driver = await f.runtime.open(f.run, null, f.controller.signal);
    const slow = deferred<Awaited<ReturnType<typeof f.heartbeat>>>();
    f.heartbeat.mockImplementationOnce(() => slow.promise);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.heartbeat).toHaveBeenCalledTimes(2);
    f.controller.abort();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.heartbeat).toHaveBeenCalledTimes(2);
    slow.reject(Error("provider-private-detail"));
    await driver.close();
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "provider-private-detail",
    );
  });
  it("closes once on a heartbeat failure without reconnecting or logging provider data", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let transport: BrowserRpcTransport;
    remote.open.mockImplementationOnce(
      async (
        value: BrowserRpcTransport,
        _saved: unknown,
        signal: AbortSignal,
      ) => {
        transport = value;
        signal.addEventListener(
          "abort",
          () => {
            void value.close();
          },
          { once: true },
        );
        return { close: () => value.close() };
      },
    );
    const driver = await f.runtime.open(f.run, null, f.controller.signal);
    f.heartbeat.mockRejectedValueOnce(Error("provider-secret-token"));
    await vi.advanceTimersByTimeAsync(20000);
    await transport!.close();
    await driver.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.heartbeat).toHaveBeenCalledTimes(2);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).toContain(
      "BROWSER_VM_HEARTBEAT_FAILED",
    );
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "provider-secret-token",
    );
  });
  it("accepts real opaque checkpoint IDs while bounding malformed metadata", async () => {
    const f = fixture();
    f.checkpoints.mockResolvedValue([
      {
        id: f.template,
        key: f.template,
        environmentId: f.environmentId,
        createdAt: new Date().toISOString(),
      },
    ]);
    await f.runtime.probe(f.controller.signal);
    const driver = await f.runtime.open(f.run, null, f.controller.signal);
    expect(f.create).toHaveBeenCalledWith(f.template, expect.any(Object));
    await driver.close();
    expect(validBrowserCheckpointId(f.template)).toBe(true);
    for (const invalid of [
      undefined,
      null,
      42,
      "",
      "bad\nidentifier",
      "bad identifier",
      "x".repeat(513),
    ])
      expect(validBrowserCheckpointId(invalid)).toBe(false);
  });
  it("performs only read-only health checks and never reserves or creates a probe VM", async () => {
    const f = fixture();
    await f.runtime.probe(f.controller.signal);
    await f.runtime.probe(f.controller.signal);
    expect(f.checkpoints).toHaveBeenCalledTimes(2);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.checkpoints).toHaveBeenCalledWith(
      expect.objectContaining({
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
      f.template,
      expect.objectContaining({
        resources: { cpu: 1, memoryGB: 2 },
        networkIsolation: "ISOLATED",
        domains: [],
        env: {},
        idleTimeoutMinutes: 1,
      }),
    );
    expect(f.write).toHaveBeenCalledTimes(1);
    const digest = createHash("sha256")
      .update(f.write.mock.calls[0][1])
      .digest("hex");
    expect(f.execHttp).toHaveBeenCalledWith(
      browserRuntimeVerify({ playwright: "1.63.0", zod: "4.3.6" }, digest),
      { timeoutSec: 15 },
    );
    expect(
      JSON.stringify(f.write.mock.calls) +
        JSON.stringify(f.execHttp.mock.calls),
    ).not.toMatch(/npm install|--with-deps|setup\.sh|playwright\/cli/);
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
    const stages = vi
      .mocked(console.info)
      .mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(stages.map((value) => value.stage)).toEqual([
      "CREATING",
      "UPLOADING",
      "VERIFYING",
      "CONNECTING",
      "READY",
      "CLEANUP",
    ]);
    expect(
      stages.every(
        (value) =>
          Number.isFinite(value.elapsedMs) &&
          Number.isFinite(value.sincePreviousMs) &&
          value.elapsedMs >= 0 &&
          value.sincePreviousMs >= 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(stages)).not.toMatch(
      /controller-only-secret|owned-cookie-secret|https?:/,
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
  it("cleans up an incompatible base without installing or opening an RPC browser", async () => {
    const f = fixture();
    f.execHttp.mockResolvedValue({
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "private setup diagnostic",
    });
    await expect(
      f.runtime.open(f.run, null, f.controller.signal),
    ).rejects.toThrow("BROWSER_TEMPLATE_UNAVAILABLE");
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledWith(f.intentId, f.sandboxId);
    expect(f.exec).not.toHaveBeenCalled();
    expect(remote.open).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "private setup diagnostic",
    );
  });
  it("requires explicit prebuilt configuration and never falls back to an empty VM", async () => {
    expect(
      railwayBrowserConfig({
        ASSISTANT_BROWSER_RAILWAY_TOKEN: "secret",
        ASSISTANT_BROWSER_RAILWAY_ENVIRONMENT_ID: randomUUID(),
      }),
    ).toMatchObject({ template: "" });
    for (const name of ["", "untrusted-personal-checkpoint"]) {
      const invalid = fixture(name);
      await expect(
        invalid.runtime.probe(invalid.controller.signal),
      ).rejects.toThrow("BROWSER_TEMPLATE_UNAVAILABLE");
      expect(invalid.checkpoints).not.toHaveBeenCalled();
      await invalid.runtime.cleanup(invalid.controller.signal);
      expect(invalid.cleanup).toHaveBeenCalled();
    }
    const f = fixture();
    f.checkpoints.mockResolvedValue([]);
    await expect(f.runtime.probe(f.controller.signal)).rejects.toThrow(
      "BROWSER_TEMPLATE_UNAVAILABLE",
    );
    await expect(
      f.runtime.open(f.run, null, f.controller.signal),
    ).rejects.toThrow("BROWSER_TEMPLATE_UNAVAILABLE");
    expect(f.create).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
  });
  it("rejects checkpoint metadata from another environment before allocation", async () => {
    const f = fixture();
    f.checkpoints.mockResolvedValue([
      {
        id: randomUUID(),
        key: f.template,
        environmentId: randomUUID(),
        createdAt: new Date().toISOString(),
      },
    ]);
    await expect(
      f.runtime.open(f.run, null, f.controller.signal),
    ).rejects.toThrow("BROWSER_TEMPLATE_UNAVAILABLE");
    expect(f.reserve).not.toHaveBeenCalled();
    expect(remote.open).not.toHaveBeenCalled();
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

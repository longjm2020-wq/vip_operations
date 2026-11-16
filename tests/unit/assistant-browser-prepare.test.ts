import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Sandbox } from "railway";
import {
  browserPreparationPlan,
  prepareBrowserRuntime,
  type BrowserPreparationReceipt,
} from "../../scripts/prepare-assistant-browser-runtime.js";
import {
  browserRuntimeSetup,
  browserRuntimeVerify,
  browserTemplatePrefix,
} from "../../apps/worker/src/assistant-browser-railway.js";

function fixture() {
  const environmentId = randomUUID(),
    sandboxId = randomUUID(),
    id = randomUUID(),
    checkpointId = randomUUID();
  const versions = { playwright: "1.63.0", zod: "4.3.6" };
  const template = browserTemplatePrefix(versions) + id;
  const receipts: BrowserPreparationReceipt[] = [],
    events: string[] = [];
  let destroyed = false;
  const persist = vi.fn(async (value: BrowserPreparationReceipt) => {
    receipts.push({ ...value });
    if (value.sandboxId) events.push("record");
  });
  const response = () =>
    new Response(
      JSON.stringify({
        data: {
          sandboxCreate: { id: sandboxId, environmentId, status: "CREATING" },
        },
      }),
    );
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
  const destroy = vi.fn(async () => {
    destroyed = true;
    events.push("destroy");
  });
  const execHttp = vi.fn(async (command: string) => ({
    exitCode: 0,
    timedOut: false,
    truncated: false,
    stdout: command.includes("npm install")
      ? "XUTI_BROWSER_BASE_READY"
      : "XUTI_BROWSER_BASE_VERIFIED",
    stderr: "",
  }));
  const checkpoint = vi.fn(async (key: string) => ({
    id: checkpointId,
    key,
    environmentId,
    createdAt: new Date().toISOString(),
  }));
  const vm = {
    id: sandboxId,
    environmentId,
    networkIsolation: "ISOLATED",
    domains: [],
    status: "RUNNING",
    destroy,
    execHttp,
    checkpoint,
  };
  const create = vi.fn(async (options: { fetch: typeof globalThis.fetch }) => {
    await options.fetch("https://backboard.railway.com/graphql/v2", {
      method: "POST",
      body: JSON.stringify({
        query: "mutation { sandboxCreate(input: {}) { id environmentId } }",
      }),
    });
    events.push("ready");
    return vm;
  });
  const connect = vi.fn(async () => ({
    ...vm,
    status: destroyed ? "DESTROYED" : "RUNNING",
  }));
  const checkpoints = vi.fn(
    async () =>
      [] as {
        id: string;
        key: string;
        environmentId: string;
        createdAt: string;
      }[],
  );
  return {
    environmentId,
    sandboxId,
    id,
    template,
    receipts,
    events,
    persist,
    response,
    fetch,
    destroy,
    execHttp,
    checkpoint,
    create,
    connect,
    checkpoints,
    options: {
      build: true,
      token: "controller-private-token",
      environmentId,
      receipt: persist,
    },
    deps: {
      sdk: { create, connect, checkpoints } as unknown as Pick<
        typeof Sandbox,
        "create" | "connect" | "checkpoints"
      >,
      fetch,
      versions,
      id: () => id,
      cleanupMs: 50,
      workMs: 5000,
    },
  };
}

describe("clean browser base preparation without real resources", () => {
  it("defaults to a pure resource plan without network, receipts or SDK calls", async () => {
    const f = fixture();
    expect(await prepareBrowserRuntime({ receipt: f.persist }, f.deps)).toBe(
      browserPreparationPlan,
    );
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.checkpoints).not.toHaveBeenCalled();
  });
  it("records one clean preparation VM before setup, creates a unique checkpoint and confirms cleanup", async () => {
    const f = fixture();
    const result = await prepareBrowserRuntime(f.options, f.deps);
    expect(result).toMatchObject({
      stage: "READY",
      prepared: true,
      destroyConfirmed: true,
      template: f.template,
    });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({
        networkIsolation: "ISOLATED",
        resources: { cpu: 1, memoryGB: 2 },
        env: {},
        domains: [],
        idleTimeoutMinutes: 1,
      }),
    );
    expect(f.events.indexOf("record")).toBeLessThan(f.events.indexOf("ready"));
    expect(f.execHttp).toHaveBeenCalledTimes(2);
    expect(f.execHttp.mock.calls[1][0]).toContain("chromiumSandbox:true");
    expect(f.execHttp.mock.calls[1][0]).not.toMatch(
      /goto\(|https?:\/\/|--no-sandbox/,
    );
    expect(
      JSON.stringify(f.execHttp.mock.calls) + JSON.stringify(f.receipts),
    ).not.toMatch(
      /controller-private-token|DATABASE_URL|COMPASS_MAIL_KEY|owned-cookie/,
    );
    expect(f.checkpoint).toHaveBeenCalledOnce();
    expect(f.checkpoint).toHaveBeenCalledWith(f.template);
    expect(f.destroy).toHaveBeenCalledOnce();
  });
  it("refuses an existing checkpoint instead of overwriting it or allocating another VM", async () => {
    const f = fixture();
    f.checkpoints.mockResolvedValue([
      {
        id: randomUUID(),
        key: f.template,
        environmentId: f.environmentId,
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(await prepareBrowserRuntime(f.options, f.deps)).toMatchObject({
      stage: "FAILED",
      code: "BROWSER_PREPARE_NAME_EXISTS",
      createAttempted: false,
    });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.checkpoint).not.toHaveBeenCalled();
  });
  it("does not checkpoint a failed sandbox verification and discards raw provider output", async () => {
    const f = fixture();
    f.execHttp.mockImplementation(async (command) => ({
      exitCode: command.includes("npm install") ? 0 : 1,
      timedOut: false,
      truncated: false,
      stdout: command.includes("npm install")
        ? "XUTI_BROWSER_BASE_READY"
        : "private raw diagnostics",
      stderr: "private raw diagnostics",
    }));
    expect(await prepareBrowserRuntime(f.options, f.deps)).toMatchObject({
      stage: "FAILED",
      code: "BROWSER_PREPARE_VERIFY_FAILED",
      destroyConfirmed: true,
    });
    expect(f.checkpoint).not.toHaveBeenCalled();
    expect(JSON.stringify(f.receipts)).not.toContain("private raw diagnostics");
  });
  it("preserves an unknown create outcome without retries or guessing a cleanup target", async () => {
    const f = fixture();
    f.fetch.mockRejectedValue(Error("private provider failure"));
    expect(await prepareBrowserRuntime(f.options, f.deps)).toMatchObject({
      stage: "FAILED",
      code: "BROWSER_PREPARE_CREATE_OUTCOME_UNKNOWN",
      destroyConfirmed: false,
    });
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.destroy).not.toHaveBeenCalled();
  });
  it("never cleans up a resource that resolves into a different environment", async () => {
    const f = fixture();
    f.connect.mockImplementation(async () => ({
      id: f.sandboxId,
      environmentId: randomUUID(),
      networkIsolation: "ISOLATED",
      domains: [],
      status: "RUNNING",
      destroy: f.destroy,
      execHttp: f.execHttp,
      checkpoint: f.checkpoint,
    }));
    expect(await prepareBrowserRuntime(f.options, f.deps)).toMatchObject({
      stage: "FAILED",
      code: "BROWSER_PREPARE_CLEANUP_UNCONFIRMED",
      destroyConfirmed: false,
    });
    expect(f.destroy).not.toHaveBeenCalled();
  });
  it("captures and destroys a late creation receipt after cancellation without installing", async () => {
    const f = fixture(),
      controller = new AbortController();
    let deliver!: (value: Response) => void;
    f.fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
        }),
    );
    const preparing = prepareBrowserRuntime(
      { ...f.options, signal: controller.signal },
      f.deps,
    );
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    controller.abort();
    expect(await preparing).toMatchObject({
      stage: "FAILED",
      code: "BROWSER_PREPARE_CREATE_OUTCOME_UNKNOWN",
      destroyConfirmed: false,
    });
    expect(f.fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
    deliver(f.response());
    await vi.waitFor(() =>
      expect(f.receipts.at(-1)).toMatchObject({
        stage: "FAILED",
        code: "BROWSER_PREPARE_CANCELED",
        sandboxId: f.sandboxId,
        destroyConfirmed: true,
      }),
    );
    expect(f.destroy).toHaveBeenCalledOnce();
    expect(f.execHttp).not.toHaveBeenCalled();
    expect(f.checkpoint).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledOnce();
  });
  it("keeps version checking and user startup completely free of install commands", () => {
    const check = browserRuntimeVerify({ playwright: "1.63.0", zod: "4.3.6" });
    expect(check).toContain("manifest.json");
    expect(check).toContain("chromium_headless_shell");
    expect(check).toContain("chmod -R a+rX /tmp/xuti-browser-runtime");
    expect(check.indexOf("chmod -R a+rX")).toBeLessThan(check.indexOf("ln -s"));
    expect(check).toContain("require.resolve(name,{paths:");
    expect(check).toContain("assistant-browser-vm-main.js");
    expect(check).toContain("process.getuid()===0");
    expect(check).not.toMatch(
      /npm install|apt-get|--with-deps|playwright\/cli/,
    );
    expect(browserRuntimeSetup("1.63.0", "4.3.6")).toContain(
      "--save-exact @playwright/test@1.63.0 zod@4.3.6",
    );
    expect(() => browserRuntimeSetup("1.63.0; echo unsafe", "4.3.6")).toThrow();
  });
});

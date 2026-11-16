import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Sandbox } from "railway";
import type { BrowserRun } from "../../api/src/modules/workspace/assistant-browser.js";
import type * as environments from "./assistant-browser-environments.js";
import {
  openRemoteBrowser,
  type BrowserRpcTransport,
} from "./assistant-browser-remote.js";
import { BrowserUnavailable } from "./assistant-browser-page.js";

const endpoint = "https://backboard.railway.com/graphql/v2";
const vmRoot = "/tmp/xuti-browser-runtime";
export const browserBaseRoot = "/opt/xuti-browser-base";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const require = createRequire(import.meta.url);
const defaultStore: typeof environments = {
  reserveBrowserEnvironment: async (...args) =>
    (
      await import("./assistant-browser-environments.js")
    ).reserveBrowserEnvironment(...args),
  recordBrowserEnvironment: async (...args) =>
    (
      await import("./assistant-browser-environments.js")
    ).recordBrowserEnvironment(...args),
  releaseBrowserEnvironment: async (...args) =>
    (
      await import("./assistant-browser-environments.js")
    ).releaseBrowserEnvironment(...args),
  browserEnvironmentsToCleanup: async (...args) =>
    (
      await import("./assistant-browser-environments.js")
    ).browserEnvironmentsToCleanup(...args),
};
export type RailwayBrowserConfig = {
  token: string;
  environmentId: string;
  template: string;
};
export type BrowserRuntimeVersions = { playwright: string; zod: string };
/** Railway GraphQL checkpoint IDs are opaque; a named checkpoint can use its name as ID. */
export function validBrowserCheckpointId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u0020\u007f]/u.test(value)
  );
}
export function browserTemplatePrefix(versions: BrowserRuntimeVersions) {
  if (!Object.values(versions).every((value) => /^\d+\.\d+\.\d+$/.test(value)))
    throw Error("BROWSER_TEMPLATE_UNAVAILABLE");
  return `xuti-browser-v1-pw${versions.playwright}-z${versions.zod}-`;
}
const templatePattern =
  /^xuti-browser-v1-pw\d+\.\d+\.\d+-z\d+\.\d+\.\d+-[0-9a-f-]{36}$/;
export function railwayBrowserConfig(
  env: NodeJS.ProcessEnv = process.env,
): RailwayBrowserConfig {
  const token = env.ASSISTANT_BROWSER_RAILWAY_TOKEN,
    environmentId = env.ASSISTANT_BROWSER_RAILWAY_ENVIRONMENT_ID;
  if (!token || !environmentId || !uuid.test(environmentId))
    throw Error("BROWSER_RUNTIME_UNAVAILABLE");
  // Invalid/missing base blocks probe/open, but must not disable cleanup of old VMs.
  const template = env.ASSISTANT_BROWSER_RAILWAY_TEMPLATE || "";
  return { token, environmentId, template };
}
export const browserRuntimeFiles = [
  "apps/worker/src/assistant-browser-vm-main.js",
  "apps/worker/src/assistant-browser-bridge.js",
  "apps/worker/src/assistant-browser-page.js",
  "apps/worker/src/assistant-browser-proxy.js",
  "apps/worker/src/assistant-browser-rpc.js",
  "apps/worker/src/assistant-browser-diagnostics.js",
  "apps/worker/src/assistant-browser-isolation.js",
  "packages/contracts/src/assistant-browser.js",
] as const;
export async function browserRuntimeAssets() {
  const base = new URL("../../../", import.meta.url);
  return Promise.all(
    browserRuntimeFiles.map(async (path) => {
      const content = await readFile(new URL(path, base), "utf8");
      if (Buffer.byteLength(content) > 1024 * 1024)
        throw Error("BROWSER_RUNTIME_UNAVAILABLE");
      return { path, content };
    }),
  );
}
export function browserRuntimeSetup(playwright: string, zod: string) {
  if (![playwright, zod].every((value) => /^\d+\.\d+\.\d+$/.test(value)))
    throw Error("BROWSER_RUNTIME_UNAVAILABLE");
  const marker = JSON.stringify({ schema: 1, playwright, zod });
  return `#!/bin/sh
set -eu
umask 022
export DEBIAN_FRONTEND=noninteractive
export PLAYWRIGHT_BROWSERS_PATH=${browserBaseRoot}/browsers
test "$(id -u)" = 0
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(2)'
NODE_SOURCE="$(node -p 'process.execPath')"
mkdir -p ${browserBaseRoot}/runtime
install -m 0755 "$NODE_SOURCE" ${browserBaseRoot}/runtime/node
npm install --prefix ${browserBaseRoot} --ignore-scripts --no-audit --no-fund --save-exact @playwright/test@${playwright} zod@${zod} >${browserBaseRoot}/install.log 2>&1
node ${browserBaseRoot}/node_modules/playwright/cli.js install --with-deps chromium --only-shell >>${browserBaseRoot}/install.log 2>&1
id xutibrowser >/dev/null 2>&1 || useradd --create-home --shell /bin/sh xutibrowser
printf '%s' '${marker}' >${browserBaseRoot}/manifest.json
chmod -R a+rX ${browserBaseRoot}
runuser -u xutibrowser -- /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/xutibrowser LANG=C.UTF-8 ${browserBaseRoot}/runtime/node -e 'if(process.getuid()===0)process.exit(2)'
echo XUTI_BROWSER_BASE_READY
`;
}
/** Fixed code permissions, dependency checks and one symlink; never installs on a user request. */
export function browserRuntimeVerify(versions: BrowserRuntimeVersions) {
  browserTemplatePrefix(versions);
  const expected = JSON.stringify({ schema: 1, ...versions });
  return `set -eu
test -x ${browserBaseRoot}/runtime/node
test -r ${browserBaseRoot}/manifest.json
test ! -e ${vmRoot}/node_modules
chmod -R a+rX ${vmRoot}
ln -s ${browserBaseRoot}/node_modules ${vmRoot}/node_modules
runuser -u xutibrowser -- /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/xutibrowser LANG=C.UTF-8 PLAYWRIGHT_BROWSERS_PATH=${browserBaseRoot}/browsers ${browserBaseRoot}/runtime/node -e 'const fs=require("node:fs");const expected=${expected};const actual=JSON.parse(fs.readFileSync("${browserBaseRoot}/manifest.json","utf8"));if(process.getuid()===0||Number(process.versions.node.split(".")[0])<22||Object.keys(expected).some(k=>actual[k]!==expected[k]))process.exit(2);fs.accessSync("${vmRoot}/apps/worker/src/assistant-browser-vm-main.js",fs.constants.R_OK);for(const name of ["@playwright/test","zod"]){require.resolve(name,{paths:["${vmRoot}"]});const p=require("${browserBaseRoot}/node_modules/"+name+"/package.json");if(p.version!==expected[name==="zod"?"zod":"playwright"])process.exit(2)}const root="${browserBaseRoot}/browsers";const found=fs.readdirSync(root).filter(n=>/^chromium_headless_shell-[0-9]+$/.test(n)).some(n=>["chrome-headless-shell-linux64/chrome-headless-shell","chrome-linux/headless_shell"].some(p=>{try{fs.accessSync(root+"/"+n+"/"+p,fs.constants.X_OK);return true}catch{return false}}));if(!found)process.exit(2);'
echo XUTI_BROWSER_RUNTIME_READY`;
}
export const browserRuntimeCommand = `runuser -u xutibrowser -- /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/xutibrowser LANG=C.UTF-8 PLAYWRIGHT_BROWSERS_PATH=${browserBaseRoot}/browsers ${browserBaseRoot}/runtime/node ${vmRoot}/apps/worker/src/assistant-browser-vm-main.js`;

type Dependencies = {
  sdk: Pick<typeof Sandbox, "create" | "connect" | "checkpoints">;
  store: typeof environments;
  fetch: typeof fetch;
  assets: typeof browserRuntimeAssets;
  versions: BrowserRuntimeVersions;
  cleanupMs: number;
  onStage: (
    stage: BrowserRuntimeStage,
    timing?: { elapsedMs: number; sincePreviousMs: number },
  ) => void | Promise<void>;
};
export type BrowserRuntimeStage =
  "CREATING" | "UPLOADING" | "VERIFYING" | "CONNECTING" | "READY" | "CLEANUP";
function safeLog(code: string) {
  console.warn(JSON.stringify({ event: "assistant_browser_runtime", code }));
}
function canceled(signal: AbortSignal) {
  if (signal.aborted) throw new BrowserUnavailable();
}
function bounded<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new BrowserUnavailable());
    if (signal.aborted) {
      Promise.resolve(promise).catch(() => {});
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** A task allocates one isolated VM. Probes and reconciliation never create resources. */
export class RailwayBrowserRuntime {
  private readonly deps: Dependencies;
  constructor(
    private readonly config: RailwayBrowserConfig,
    dependencies: Partial<Dependencies> = {},
  ) {
    this.deps = {
      sdk: Sandbox,
      store: defaultStore,
      fetch: globalThis.fetch,
      assets: browserRuntimeAssets,
      versions: {
        playwright: require("@playwright/test/package.json").version,
        zod: require("zod/package.json").version,
      },
      cleanupMs: 20000,
      onStage: (stage, timing) =>
        console.info(
          JSON.stringify({
            event: "assistant_browser_runtime_stage",
            stage,
            ...timing,
          }),
        ),
      ...dependencies,
    };
  }
  private async stage(
    stage: BrowserRuntimeStage,
    timing?: { elapsedMs: number; sincePreviousMs: number },
  ) {
    try {
      await this.deps.onStage(stage, timing);
    } catch {
      /* Diagnostics cannot prevent cleanup. */
    }
  }
  private client(request: typeof fetch) {
    return {
      token: this.config.token,
      authType: "project-token" as const,
      environmentId: this.config.environmentId,
      endpoint,
      verbose: false,
      fetch: request,
    };
  }
  private request(signal: AbortSignal, maximum = 15000): typeof fetch {
    return (url, init = {}) => {
      if (String(url) !== endpoint) throw Error("BROWSER_CONTROL_ENDPOINT");
      return this.deps.fetch(url, {
        ...init,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(maximum),
          ...(init.signal ? [init.signal] : []),
        ]),
      });
    };
  }
  async probe(signal: AbortSignal) {
    await this.deps.assets();
    canceled(signal);
    await this.checkTemplate(signal);
  }
  private async checkTemplate(signal: AbortSignal) {
    if (
      !templatePattern.test(this.config.template) ||
      !this.config.template.startsWith(
        browserTemplatePrefix(this.deps.versions),
      )
    )
      throw Error("BROWSER_TEMPLATE_UNAVAILABLE");
    // Checkpoint metadata is read-only. Never build a missing template implicitly.
    const available = await bounded(
      this.deps.sdk.checkpoints(this.client(this.request(signal))),
      signal,
    );
    if (
      !available.some(
        (item) =>
          item.key === this.config.template &&
          item.environmentId === this.config.environmentId &&
          validBrowserCheckpointId(item.id),
      )
    )
      throw Error("BROWSER_TEMPLATE_UNAVAILABLE");
  }
  async cleanup(signal: AbortSignal) {
    const pending = await this.deps.store.browserEnvironmentsToCleanup(
      this.config.environmentId,
    );
    for (const item of pending.slice(0, 1)) {
      if (signal.aborted) return;
      await this.stage("CLEANUP");
      await this.destroy(item.id, item.sandboxId).catch(() =>
        safeLog("BROWSER_VM_CLEANUP_UNCONFIRMED"),
      );
    }
  }
  private async destroy(intentId: string, sandboxId: string) {
    const signal = AbortSignal.timeout(this.deps.cleanupMs),
      client = this.client(this.request(signal, 10000));
    try {
      const target = await bounded(
        this.deps.sdk.connect(sandboxId, client),
        signal,
      );
      if (
        target.environmentId !== this.config.environmentId ||
        target.id !== sandboxId
      )
        throw Error("BROWSER_VM_SCOPE");
      if (target.status !== "DESTROYED")
        await bounded(target.destroy(), signal);
      while (!signal.aborted) {
        const latest = await bounded(
          this.deps.sdk.connect(sandboxId, client),
          signal,
        );
        if (
          latest.environmentId !== this.config.environmentId ||
          latest.id !== sandboxId
        )
          throw Error("BROWSER_VM_SCOPE");
        if (latest.status === "DESTROYED") {
          await this.deps.store.releaseBrowserEnvironment(intentId, sandboxId);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw Error("BROWSER_VM_CLEANUP_UNCONFIRMED");
    } catch (error) {
      if (error instanceof Error && error.name === "SandboxNotFoundError") {
        await this.deps.store.releaseBrowserEnvironment(intentId, sandboxId);
        return;
      }
      throw Error("BROWSER_VM_CLEANUP_UNCONFIRMED");
    }
  }
  async open(run: BrowserRun, saved: unknown, parent: AbortSignal) {
    const started = performance.now();
    let previous = started;
    const stage = async (value: BrowserRuntimeStage) => {
      const now = performance.now();
      await this.stage(value, {
        elapsedMs: Math.round(now - started),
        sincePreviousMs: Math.round(now - previous),
      });
      previous = now;
    };
    const deadline = Math.min(
      Date.parse(run.expiresAt),
      Date.now() + 30 * 60 * 1000,
    );
    if (!Number.isFinite(deadline) || deadline <= Date.now())
      throw new BrowserUnavailable();
    const lifetime = new AbortController(),
      signal = AbortSignal.any([
        parent,
        lifetime.signal,
        AbortSignal.timeout(deadline - Date.now()),
      ]);
    const assets = await this.deps.assets();
    canceled(signal);
    await this.checkTemplate(signal);
    canceled(signal);
    const intentId = await this.deps.store.reserveBrowserEnvironment(
      run,
      this.config.environmentId,
    );
    if (!intentId) throw new BrowserUnavailable();
    let sandboxId: string | undefined,
      attempted = false,
      closing: Promise<void> | undefined;
    let execution: ReturnType<Sandbox["exec"]> | undefined;
    let stopHeartbeat = () => {};
    const close = () =>
      (closing ??= Promise.resolve().then(async () => {
        stopHeartbeat();
        lifetime.abort();
        await stage("CLEANUP");
        if (execution)
          await bounded(
            execution.kill("TERM"),
            AbortSignal.timeout(5000),
          ).catch(() => false);
        if (sandboxId) await this.destroy(intentId, sandboxId);
        else if (!attempted)
          await this.deps.store.releaseBrowserEnvironment(intentId, null);
        else safeLog("BROWSER_VM_CREATE_OUTCOME_UNKNOWN");
      }));
    const controlFetch: typeof fetch = async (url, init = {}) => {
      if (String(url) !== endpoint) throw Error("BROWSER_CONTROL_ENDPOINT");
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      const query = String(body.query || ""),
        creating = /\bsandboxCreate\s*\(/.test(query);
      if (creating) {
        canceled(signal);
        if (attempted) throw Error("BROWSER_VM_DUPLICATE_CREATE");
        attempted = true;
      }
      // Once sent, keep the bounded CREATE receipt alive across user cancellation.
      // Work still stops immediately; a late ID is recorded and destroyed below.
      const response = creating
        ? await this.deps.fetch(url, {
            ...init,
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(15000, deadline - Date.now())),
            ),
          })
        : await this.request(
            signal,
            /\bsandboxExec\s*\(/.test(query)
              ? Math.max(1, Math.min(300000, deadline - Date.now()))
              : 15000,
          )(url, init);
      if (creating) {
        const data = await response
            .clone()
            .json()
            .catch(() => null),
          info = data?.data?.sandboxCreate;
        if (typeof info?.id === "string" && uuid.test(info.id)) {
          const capturedId: string = info.id;
          sandboxId = capturedId;
          if (
            !(await this.deps.store.recordBrowserEnvironment(
              intentId,
              capturedId,
            ))
          )
            throw Error("BROWSER_VM_LEDGER");
          if (info.environmentId !== this.config.environmentId)
            throw Error("BROWSER_VM_SCOPE");
          if (signal.aborted)
            await this.destroy(intentId, capturedId).catch(() =>
              safeLog("BROWSER_VM_CLEANUP_UNCONFIRMED"),
            );
        }
      }
      return response;
    };
    try {
      canceled(signal);
      await stage("CREATING");
      const vm = await bounded(
        this.deps.sdk.create(this.config.template, {
          ...this.client(controlFetch),
          resources: { cpu: 1, memoryGB: 2 },
          networkIsolation: "ISOLATED",
          idleTimeoutMinutes: 1,
          domains: [],
          env: {},
        }),
        signal,
      );
      if (!sandboxId) {
        sandboxId = vm.id;
        if (
          !uuid.test(sandboxId) ||
          !(await this.deps.store.recordBrowserEnvironment(intentId, sandboxId))
        )
          throw Error("BROWSER_VM_LEDGER");
      }
      if (
        vm.id !== sandboxId ||
        vm.environmentId !== this.config.environmentId ||
        vm.networkIsolation !== "ISOLATED" ||
        vm.domains.length
      )
        throw Error("BROWSER_VM_SCOPE");
      canceled(signal);
      // An open ephemeral exec does not reset the provider's VM idle countdown.
      // Keep only this live lease's VM alive; the runner owns user-idle/total expiry.
      const heartbeat = async () => {
        canceled(signal);
        const current = await bounded(vm.heartbeat(), signal);
        canceled(signal);
        if (
          current.id !== sandboxId ||
          current.environmentId !== this.config.environmentId ||
          current.networkIsolation !== "ISOLATED" ||
          current.domains.length ||
          current.status !== "RUNNING"
        )
          throw Error("BROWSER_VM_SCOPE");
      };
      await heartbeat().catch(() => {
        if (!signal.aborted) safeLog("BROWSER_VM_HEARTBEAT_FAILED");
        throw new BrowserUnavailable();
      });
      let heartbeating = false;
      const heartbeatTimer = setInterval(() => {
        if (signal.aborted || heartbeating) return;
        heartbeating = true;
        void heartbeat()
          .catch(async () => {
            if (signal.aborted) return;
            safeLog("BROWSER_VM_HEARTBEAT_FAILED");
            await close().catch(() =>
              safeLog("BROWSER_VM_CLEANUP_UNCONFIRMED"),
            );
          })
          .finally(() => {
            heartbeating = false;
          });
      }, 20000);
      stopHeartbeat = () => {
        clearInterval(heartbeatTimer);
        signal.removeEventListener("abort", stopHeartbeat);
      };
      signal.addEventListener("abort", stopHeartbeat, { once: true });
      await stage("UPLOADING");
      for (const asset of assets) {
        if (!(browserRuntimeFiles as readonly string[]).includes(asset.path))
          throw Error("BROWSER_RUNTIME_UNAVAILABLE");
      }
      const files = [
        { path: "package.json", content: '{"type":"module","private":true}' },
        ...assets,
      ];
      const uploads = new AbortController();
      const uploadSignal = AbortSignal.any([signal, uploads.signal]);
      const dispatchedWrites: Promise<void>[] = [];
      let nextFile = 0;
      // SDK writes use independent connections and create missing parents.
      // Its default 0644 avoids a redundant remote chmod exec for each file;
      // VERIFYING still applies the required permissions before any code runs.
      await Promise.all(
        Array.from({ length: Math.min(3, files.length) }, async () => {
          while (nextFile < files.length) {
            canceled(uploadSignal);
            const file = files[nextFile++];
            const writing = vm.files.write(
              vmRoot + "/" + file.path,
              file.content,
            );
            dispatchedWrites.push(writing);
            await bounded(writing, uploadSignal);
          }
        }),
      ).catch(async (error) => {
        uploads.abort();
        // SDK file writes cannot be aborted. Drain already dispatched writes
        // before destroying their VM, with a bound for a stalled connection.
        await bounded(
          Promise.allSettled(dispatchedWrites),
          AbortSignal.timeout(10000),
        ).catch(() => safeLog("BROWSER_VM_UPLOAD_DRAIN_TIMEOUT"));
        throw error;
      });
      const remaining = () =>
        Math.max(1, Math.floor((deadline - Date.now()) / 1000));
      await stage("VERIFYING");
      const setup = await bounded(
        vm.execHttp(browserRuntimeVerify(this.deps.versions), {
          timeoutSec: Math.min(15, remaining()),
        }),
        signal,
      );
      if (
        setup.exitCode !== 0 ||
        setup.timedOut ||
        !setup.stdout.includes("XUTI_BROWSER_RUNTIME_READY")
      )
        throw Error("BROWSER_TEMPLATE_UNAVAILABLE");
      canceled(signal);
      await stage("CONNECTING");
      let onChunk: (chunk: string) => void = () => {},
        onClose: () => void = () => {},
        finished = false;
      execution = vm.exec(browserRuntimeCommand, {
        stdin: true,
        ephemeral: true,
        captureOutput: false,
        timeoutSec: remaining(),
        signal,
        onStdout: (chunk) => onChunk(chunk),
        onStderr: () => {},
      });
      void Promise.resolve(execution).then(
        () => {
          finished = true;
          onClose();
        },
        () => {
          finished = true;
          onClose();
        },
      );
      const transport: BrowserRpcTransport = {
        write: (line) => execution!.stdin.write(line),
        subscribe: (chunk, closed) => {
          onChunk = chunk;
          onClose = closed;
          if (finished) queueMicrotask(closed);
          return () => {
            onChunk = () => {};
            onClose = () => {};
          };
        },
        close,
      };
      const driver = await openRemoteBrowser(transport, saved, signal);
      await stage("READY");
      return driver;
    } catch (error) {
      await close().catch(() => safeLog("BROWSER_VM_CLEANUP_UNCONFIRMED"));
      throw error;
    }
  }
}

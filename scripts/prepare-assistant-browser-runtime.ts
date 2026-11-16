import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Sandbox } from "railway";
import {
  browserBaseRoot,
  browserRuntimeSetup,
  browserTemplatePrefix,
  validBrowserCheckpointId,
  type BrowserRuntimeVersions,
} from "../apps/worker/src/assistant-browser-railway.js";

const require = createRequire(import.meta.url);
const versions: BrowserRuntimeVersions = {
  playwright: require("@playwright/test/package.json").version,
  zod: require("zod/package.json").version,
};
const endpoint = "https://backboard.railway.com/graphql/v2";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const browserPreparationPlan = {
  mode: "dry-run",
  resources: { cpu: 1, memoryGB: 2 },
  networkIsolation: "ISOLATED",
  domains: [],
  workDeadlineSeconds: 300,
  cleanupDeadlineSeconds: 60,
  idleTimeoutMinutes: 1,
  versions,
  actions: [
    "Create exactly one clean isolated preparation VM, recording its ID immediately",
    "Install pinned Node copy, Playwright/Chromium dependencies and non-root account",
    "Verify a real sandboxed blank renderer without visiting any website",
    "Save one uniquely named clean checkpoint; never reuse or overwrite an existing name",
    "Destroy the preparation VM and confirm destruction in finally",
  ],
  retained:
    "One versioned checkpoint; no user storage, page content, RPC process or credentials",
  billing:
    "An explicit --build uses up to five minutes of 1 vCPU / 2 GB work plus cleanup, downloads and retained checkpoint storage. Deadlines are not a billing cap if provider/network cleanup fails. No automatic retry, warm VM or new subscription.",
  cleanup:
    "Keep the previous configured checkpoint for rollback. After the replacement is verified and no service refers to the old name, delete only the exact old checkpoint ID in the same environment. This script never deletes other checkpoints or VMs.",
} as const;

type Stage =
  | "PREFLIGHT"
  | "CREATING"
  | "INSTALLING"
  | "VERIFYING"
  | "CHECKPOINT"
  | "CLEANUP"
  | "READY"
  | "FAILED";
export type BrowserPreparationReceipt = {
  id: string;
  environmentId: string;
  template: string;
  stage: Stage;
  failedStage?: Stage;
  startedAt: string;
  finishedAt?: string;
  sandboxId?: string;
  checkpointId?: string;
  prepared: boolean;
  destroyConfirmed: boolean;
  createAttempted: boolean;
  code?: string;
};
type Dependencies = {
  sdk: Pick<typeof Sandbox, "create" | "connect" | "checkpoints">;
  fetch: typeof fetch;
  versions: BrowserRuntimeVersions;
  id: () => string;
  workMs: number;
  cleanupMs: number;
};
type Options = {
  build?: boolean;
  token?: string;
  environmentId?: string;
  signal?: AbortSignal;
  receipt?: (value: BrowserPreparationReceipt) => Promise<void>;
};
const bounded = <T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    const abort = () => reject(Error("BROWSER_PREPARE_DEADLINE"));
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

/** Dry-run does not read credentials, call the SDK or create a receipt directory. */
export async function prepareBrowserRuntime(
  options: Options = {},
  overrides: Partial<Dependencies> = {},
) {
  if (!options.build) return browserPreparationPlan;
  const deps: Dependencies = {
    sdk: Sandbox,
    fetch: globalThis.fetch,
    versions,
    id: randomUUID,
    workMs: 300000,
    cleanupMs: 60000,
    ...overrides,
  };
  if (
    !options.token ||
    !options.environmentId ||
    !uuid.test(options.environmentId) ||
    !options.receipt
  )
    throw Error("BROWSER_PREPARE_CONFIGURATION");
  const id = deps.id();
  if (!uuid.test(id)) throw Error("BROWSER_PREPARE_CONFIGURATION");
  const receipt: BrowserPreparationReceipt = {
    id,
    environmentId: options.environmentId,
    template: browserTemplatePrefix(deps.versions) + id,
    stage: "PREFLIGHT",
    startedAt: new Date().toISOString(),
    prepared: false,
    destroyConfirmed: false,
    createAttempted: false,
  };
  const persist = () => options.receipt!({ ...receipt });
  await persist();
  const deadline = Date.now() + deps.workMs;
  const signal = AbortSignal.any([
    AbortSignal.timeout(deps.workMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  const request =
    (useSignal: AbortSignal, maximum = 15000): typeof fetch =>
    (url, init = {}) => {
      if (String(url) !== endpoint) throw Error("BROWSER_PREPARE_ENDPOINT");
      return deps.fetch(url, {
        ...init,
        signal: AbortSignal.any([useSignal, AbortSignal.timeout(maximum)]),
      });
    };
  const client = (fetch: typeof globalThis.fetch) => ({
    token: options.token!,
    environmentId: options.environmentId!,
    authType: "project-token" as const,
    endpoint,
    verbose: false,
    fetch,
  });
  const stage = async (value: Stage) => {
    receipt.stage = value;
    await persist();
  };
  let closing: Promise<void> | undefined;
  const destroy = () => {
    if (!receipt.sandboxId) return Promise.resolve();
    return (closing ??= (async () => {
      // Local diagnostic storage must never prevent resource cleanup.
      await stage("CLEANUP").catch(() => {});
      const cleanup = AbortSignal.timeout(deps.cleanupMs);
      const cleanupClient = client(request(cleanup));
      try {
        const vm = await bounded(
          deps.sdk.connect(receipt.sandboxId!, cleanupClient),
          cleanup,
        );
        if (
          vm.id !== receipt.sandboxId ||
          vm.environmentId !== receipt.environmentId
        )
          throw Error("BROWSER_PREPARE_SCOPE");
        if (vm.status !== "DESTROYED") await bounded(vm.destroy(), cleanup);
        while (!cleanup.aborted) {
          const state: Sandbox = await bounded(
            deps.sdk.connect(receipt.sandboxId!, cleanupClient),
            cleanup,
          );
          if (
            state.id !== receipt.sandboxId ||
            state.environmentId !== receipt.environmentId
          )
            throw Error("BROWSER_PREPARE_SCOPE");
          if (state.status === "DESTROYED") {
            receipt.destroyConfirmed = true;
            await persist();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw Error("BROWSER_PREPARE_CLEANUP_UNCONFIRMED");
      } catch (error) {
        if (error instanceof Error && error.name === "SandboxNotFoundError") {
          receipt.destroyConfirmed = true;
          await persist();
          return;
        }
        throw Error("BROWSER_PREPARE_CLEANUP_UNCONFIRMED");
      }
    })());
  };
  let finished = false;
  const controlFetch: typeof fetch = async (url, init = {}) => {
    if (String(url) !== endpoint) throw Error("BROWSER_PREPARE_ENDPOINT");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const creating = /\bsandboxCreate\s*\(/.test(String(body.query || ""));
    if (creating) {
      signal.throwIfAborted();
      if (receipt.createAttempted)
        throw Error("BROWSER_PREPARE_DUPLICATE_CREATE");
      receipt.createAttempted = true;
      await persist();
    }
    // Keep a sent create receipt alive across cancellation so its ID can be cleaned up.
    const response = creating
      ? await deps.fetch(url, { ...init, signal: AbortSignal.timeout(15000) })
      : await request(
          signal,
          /\bsandboxExec\s*\(/.test(String(body.query || ""))
            ? Math.max(1, deadline - Date.now())
            : 15000,
        )(url, init);
    if (creating) {
      const data = await response
          .clone()
          .json()
          .catch(() => null),
        created = data?.data?.sandboxCreate;
      if (typeof created?.id === "string" && uuid.test(created.id)) {
        receipt.sandboxId = created.id;
        try {
          await persist();
        } catch {
          await destroy().catch(() => {});
          throw Error("BROWSER_PREPARE_RECEIPT_FAILED");
        }
        if (created.environmentId !== receipt.environmentId)
          throw Error("BROWSER_PREPARE_SCOPE");
        if (finished || signal.aborted) {
          await destroy().catch(() => {
            receipt.code = "BROWSER_PREPARE_CLEANUP_UNCONFIRMED";
          });
          if (finished) {
            receipt.stage = "FAILED";
            if (receipt.destroyConfirmed)
              receipt.code = "BROWSER_PREPARE_CANCELED";
            await persist();
          }
        }
      }
    }
    return response;
  };
  try {
    const existing = await bounded(
      deps.sdk.checkpoints(client(request(signal))),
      signal,
    );
    if (
      existing.some(
        (entry) =>
          entry.environmentId === receipt.environmentId &&
          entry.key === receipt.template,
      )
    )
      throw Error("BROWSER_PREPARE_NAME_EXISTS");
    await stage("CREATING");
    const vm = await bounded(
      deps.sdk.create({
        ...client(controlFetch),
        resources: { cpu: 1, memoryGB: 2 },
        networkIsolation: "ISOLATED",
        domains: [],
        idleTimeoutMinutes: 1,
        env: {},
      }),
      signal,
    );
    if (
      !receipt.sandboxId ||
      vm.id !== receipt.sandboxId ||
      vm.environmentId !== receipt.environmentId ||
      vm.networkIsolation !== "ISOLATED" ||
      vm.domains.length
    )
      throw Error("BROWSER_PREPARE_SCOPE");
    signal.throwIfAborted();
    await stage("INSTALLING");
    const result = await bounded(
      vm.execHttp(
        browserRuntimeSetup(deps.versions.playwright, deps.versions.zod),
        {
          timeoutSec: Math.max(
            1,
            Math.min(300, Math.floor((deadline - Date.now()) / 1000)),
          ),
        },
      ),
      signal,
    );
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      !result.stdout.includes("XUTI_BROWSER_BASE_READY")
    )
      throw Error("BROWSER_PREPARE_INSTALL_FAILED");
    await stage("VERIFYING");
    const verify = `runuser -u xutibrowser -- /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/xutibrowser LANG=C.UTF-8 PLAYWRIGHT_BROWSERS_PATH=${browserBaseRoot}/browsers ${browserBaseRoot}/runtime/node --input-type=module -e 'import {chromium} from "${browserBaseRoot}/node_modules/playwright/index.mjs";if(process.getuid()===0)process.exit(2);const b=await chromium.launch({headless:true,chromiumSandbox:true,timeout:20000});try{const p=await b.newPage();await p.setContent("<title>Clean browser base</title>");if(await p.title()!=="Clean browser base")process.exitCode=2;}finally{await b.close()}console.log("XUTI_BROWSER_BASE_VERIFIED");'`;
    const checked = await bounded(
      vm.execHttp(verify, {
        timeoutSec: Math.max(
          1,
          Math.min(30, Math.floor((deadline - Date.now()) / 1000)),
        ),
      }),
      signal,
    );
    if (
      checked.exitCode !== 0 ||
      checked.timedOut ||
      !checked.stdout.includes("XUTI_BROWSER_BASE_VERIFIED")
    )
      throw Error("BROWSER_PREPARE_VERIFY_FAILED");
    signal.throwIfAborted();
    await stage("CHECKPOINT");
    const checkpoint = await bounded(vm.checkpoint(receipt.template), signal);
    if (
      checkpoint.key !== receipt.template ||
      checkpoint.environmentId !== receipt.environmentId ||
      !validBrowserCheckpointId(checkpoint.id)
    )
      throw Error("BROWSER_PREPARE_CHECKPOINT_IDENTITY");
    receipt.checkpointId = checkpoint.id;
    receipt.prepared = true;
    await persist();
  } catch (error) {
    receipt.failedStage = receipt.stage;
    const message = error instanceof Error ? error.message : "";
    receipt.code =
      /^BROWSER_PREPARE_(?:CONFIGURATION|SCOPE|ENDPOINT|CHECKPOINT_IDENTITY|DEADLINE|NAME_EXISTS|INSTALL_FAILED|VERIFY_FAILED|DUPLICATE_CREATE|RECEIPT_FAILED)$/.test(
        message,
      )
        ? message
        : signal.aborted
          ? "BROWSER_PREPARE_CANCELED"
          : "BROWSER_PREPARE_FAILED";
  } finally {
    finished = true;
    await destroy().catch(() => {
      receipt.code = "BROWSER_PREPARE_CLEANUP_UNCONFIRMED";
    });
    if (receipt.createAttempted && !receipt.sandboxId)
      receipt.code = "BROWSER_PREPARE_CREATE_OUTCOME_UNKNOWN";
    receipt.stage =
      receipt.prepared && receipt.destroyConfirmed ? "READY" : "FAILED";
    receipt.finishedAt = new Date().toISOString();
    await persist();
  }
  return receipt;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (
    args.some((arg) => !["--build", "--dry-run"].includes(arg)) ||
    (args.includes("--build") && args.includes("--dry-run"))
  )
    throw Error(
      "Use --dry-run (default), or explicit --build after reviewing the resource plan",
    );
  const result = await prepareBrowserRuntime({
    build: args.includes("--build"),
    token: args.includes("--build")
      ? process.env.ASSISTANT_BROWSER_RAILWAY_TOKEN
      : undefined,
    environmentId: args.includes("--build")
      ? process.env.ASSISTANT_BROWSER_RAILWAY_ENVIRONMENT_ID
      : undefined,
    receipt: async (value) => {
      const directory = resolve(".local", "browser-runtime-builds");
      await mkdir(directory, { recursive: true });
      await writeFile(
        resolve(directory, `${value.id}.json`),
        JSON.stringify(value, null, 2) + "\n",
        { mode: 0o600 },
      );
    },
  });
  console.log(JSON.stringify(result, null, 2));
  if ("stage" in result && result.stage !== "READY") process.exitCode = 1;
}

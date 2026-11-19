import * as store from "../../api/src/modules/workspace/assistant-browser.js";
import { openIndependentBrowser } from "./assistant-browser-page.js";
import { runIndependentBrowser } from "./assistant-browser-runner.js";
import { classifyBrowserStartupFailure } from "./assistant-browser-diagnostics.js";
import type { BrowserRuntimeIssue } from "../../../packages/contracts/src/assistant-browser.js";
import { RailwayBrowserRuntime, railwayBrowserConfig } from "./assistant-browser-railway.js";

/** Browser work has its own bounded pool and cannot block media/report workers. */
export function startAssistantBrowserJobs() {
  const controller = new AbortController();
  const active = new Set<Promise<void>>();
  let checking = false,
    ready = false,
    testedAt = 0,
    heartbeatAt = 0;
  let polling: Promise<void> | undefined;
  let remote: RailwayBrowserRuntime | undefined;
  let cleanupAt = 0;
  let issue: BrowserRuntimeIssue = "BROWSER_RUNTIME_UNAVAILABLE";
  const tick = async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      if ((!ready && Date.now() - testedAt > 30000) || (remote && Date.now() - testedAt > 60000)) {
        testedAt = Date.now();
        // Probe the real Chromium sandbox. An unavailable sandbox is never disabled.
        try {
          const mode = process.env.ASSISTANT_BROWSER_RUNTIME || 'local';
          if (mode === 'railway') {
            remote ||= new RailwayBrowserRuntime(railwayBrowserConfig());
            await remote.probe(controller.signal);
          } else if (mode === 'local') {
            const browser = await openIndependentBrowser(undefined, controller.signal);
            await browser.close();
          } else throw Error('BROWSER_RUNTIME_UNAVAILABLE');
          ready = true;
        } catch (error) {
          ready = false;
          issue = classifyBrowserStartupFailure(error);
          throw error;
        }
      }
      if (Date.now() - heartbeatAt > 10000) {
        await store.heartbeatBrowserWorker(ready, issue);
        heartbeatAt = Date.now();
      }
      if (!ready || active.size >= 2) return;
      const run = await store.claimBrowserTask();
      if (!run) return;
      const running = runIndependentBrowser(run, store, controller.signal,
        remote ? (saved, signal, viewport) => remote!.open(run, saved, signal, viewport) : openIndependentBrowser)
        .catch(() => {})
        .finally(() => active.delete(running));
      active.add(running);
    } catch {
      if (!ready)
        await store.heartbeatBrowserWorker(false, issue).catch(() => {});
      // Diagnostics never contain page URLs, cookies, model responses or manual inputs.
      console.warn(
        JSON.stringify({
          event: "assistant_browser_runtime_unavailable",
          code: ready ? "BROWSER_RUNTIME_UNAVAILABLE" : issue,
        }),
      );
    } finally {
      if (remote && !controller.signal.aborted && Date.now() - cleanupAt > 15000) {
        cleanupAt = Date.now();
        await remote.cleanup(controller.signal).catch(() => {});
      }
      checking = false;
    }
  };
  const schedule = () => {
    if (!polling && !controller.signal.aborted)
      polling = tick().finally(() => {
        polling = undefined;
      });
  };
  const timer = setInterval(schedule, 1000);
  schedule();
  return async () => {
    clearInterval(timer);
    controller.abort();
    await polling;
    await Promise.allSettled([...active]);
    await store.heartbeatBrowserWorker(false).catch(() => {});
  };
}

import type { BrowserContext } from "@playwright/test";
import { compassOnlyState, compassSessionStorageLimits, type CompassBrowserState, type CompassSessionStorage } from "./compass-browser-state.js";
import { isCompassBrowserOrigin } from "../../../packages/contracts/src/compass-update.js";
import type { CloudBrowserState } from "./competitor-cloud-state.js";

/** Keep custom authentication state outside Playwright's storageState option. */
export function compassPlaywrightState(snapshot: unknown): CloudBrowserState {
  const { cookies, origins } = compassOnlyState(snapshot);
  return { cookies, origins };
}

/** In a context with several tabs, the latest live official document wins. */
export async function collectCompassBrowserState(context: BrowserContext): Promise<CompassBrowserState> {
  const snapshot = await context.storageState({ indexedDB: true });
  const byOrigin = new Map<string, CompassSessionStorage[number]>();
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    for (const frame of page.frames()) {
      if (frame.isDetached() || !isCompassBrowserOrigin(frame.url())) continue;
      const origin = new URL(frame.url()).origin;
      try {
        const entries = await frame.evaluate(({ expectedOrigin, limits }) => {
          // Sandboxed documents can have an opaque origin despite their URL.
          if (location.origin !== expectedOrigin) return null;
          if (sessionStorage.length > limits.entries) throw Error("COMPASS_SESSION_STORAGE_LIMIT");
          const values: { name: string; value: string }[] = [];
          for (let index = 0; index < sessionStorage.length; index++) {
            const name = sessionStorage.key(index)!;
            const value = sessionStorage.getItem(name)!;
            if (name.length > limits.nameLength || value.length > limits.valueLength) throw Error("COMPASS_SESSION_STORAGE_LIMIT");
            values.push({ name, value });
          }
          return values;
        }, { expectedOrigin: origin, limits: compassSessionStorageLimits });
        if (entries !== null) byOrigin.set(origin, { origin, entries });
      } catch (error) {
        if (frame.isDetached() || page.isClosed() || (error instanceof Error && /frame.{0,30}detach|execution context.{0,30}destroy|cannot find context|Target closed/i.test(error.message))) continue;
        throw Error("罗盘当前会话存储无法读取或超过限制，请重新打开登录");
      }
    }
  }
  return compassOnlyState({ ...snapshot, sessionStorage: [...byOrigin.values()] });
}

/** Must run before newPage/navigation so application boot can read its tokens. */
export async function restoreCompassBrowserState(context: BrowserContext, snapshot: unknown): Promise<void> {
  const state = compassOnlyState(snapshot);
  if (!state.sessionStorage?.length) return;
  await context.addInitScript(({ sessions }) => {
    const values = sessions.find(value => value.origin === location.origin);
    if (!values) return;
    try {
      for (const entry of values.entries) {
        // Later navigation may have refreshed a token. Keep every existing key.
        if (sessionStorage.getItem(entry.name) === null) sessionStorage.setItem(entry.name, entry.value);
      }
    } catch { /* Storage may be inaccessible in a sandboxed official iframe. */ }
  }, { sessions: state.sessionStorage });
}

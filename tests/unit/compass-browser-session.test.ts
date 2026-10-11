import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { collectCompassBrowserState, compassPlaywrightState, restoreCompassBrowserState } from "../../apps/worker/src/compass-browser-session.js";
import { compassOnlyState, decryptCompassLoginDraft, decryptCompassState, encryptCompassLoginDraft, encryptCompassState } from "../../apps/worker/src/compass-browser-state.js";

let browser: Browser;
const contexts: BrowserContext[] = [];
const origin = "https://vis.vip.com";
const otherOrigin = "https://untrusted.example";
const bootHtml = '<script>window.bootToken=sessionStorage.getItem("fixture-auth");</script><body>synthetic supplier</body>';
beforeAll(async () => {
  const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
}, 30000);
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  vi.unstubAllEnvs();
});
afterAll(async () => { await browser?.close(); });
async function context(snapshot?: unknown) {
  const result = await browser.newContext(snapshot ? { storageState: compassPlaywrightState(snapshot) } : {});
  contexts.push(result);
  await result.route("**/*", route => route.fulfill({ status: 200, contentType: "text/html", body: bootHtml }));
  if (snapshot) await restoreCompassBrowserState(result, snapshot);
  return result;
}
const synthetic = (value = "synthetic-session") => ({ cookies: [], origins: [], sessionStorage: [{ origin, entries: [{ name: "fixture-auth", value }] }] });

describe("encrypted official sessionStorage snapshots", () => {
  it("restores session authentication before application boot in a fresh context and preserves IndexedDB", async () => {
    vi.stubEnv("COMPASS_BROWSER_KEY", randomBytes(32).toString("hex"));
    const original = await context(), page = await original.newPage();
    await page.goto(origin + "/homepage");
    await page.evaluate(async () => {
      sessionStorage.setItem("fixture-auth", "synthetic-session");
      localStorage.setItem("fixture-local", "synthetic-local");
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("fixture-db", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("auth");
        request.onerror = () => reject(Error("synthetic IndexedDB setup failed"));
        request.onsuccess = () => {
          const database = request.result, transaction = database.transaction("auth", "readwrite");
          transaction.objectStore("auth").put("synthetic-indexed", "fixture-key");
          transaction.oncomplete = () => { database.close(); resolve(); };
          transaction.onerror = () => { database.close(); reject(Error("synthetic IndexedDB write failed")); };
        };
      });
    });
    const captured = await collectCompassBrowserState(original);
    expect(captured.sessionStorage).toEqual(synthetic().sessionStorage);
    expect(captured.origins[0].indexedDB).toBeDefined();
    const encrypted = encryptCompassState(captured);
    expect(encrypted).not.toContain("synthetic-session");
    const snapshot = decryptCompassState(encrypted), restored = await context(snapshot), fresh = await restored.newPage();
    await fresh.goto(origin + "/homepage");
    expect(await fresh.evaluate(() => (window as unknown as { bootToken: string }).bootToken)).toBe("synthetic-session");
    expect(await fresh.evaluate(() => localStorage.getItem("fixture-local"))).toBe("synthetic-local");
    expect((await collectCompassBrowserState(restored)).origins[0].indexedDB).toEqual(captured.origins[0].indexedDB);
    expect(compassPlaywrightState(snapshot)).not.toHaveProperty("sessionStorage");
  }, 20000);

  it("never restores or collects storage from an unrelated iframe", async () => {
    const contaminated = synthetic();
    contaminated.sessionStorage.push({ origin: otherOrigin, entries: [{ name: "fixture-auth", value: "external-must-not-restore" }] });
    const restored = await context(contaminated), page = await restored.newPage();
    await page.goto(origin + "/homepage");
    const navigation = page.waitForEvent("framenavigated", { predicate: frame => frame.url().startsWith(otherOrigin) });
    await page.evaluate(url => { const iframe = document.createElement("iframe"); iframe.src = url; document.body.append(iframe); }, otherOrigin + "/frame");
    const external = await navigation;
    expect(await external.evaluate(() => sessionStorage.getItem("fixture-auth"))).toBeNull();
    await external.evaluate(() => sessionStorage.setItem("private-external", "must-not-collect"));
    const captured = await collectCompassBrowserState(restored);
    expect(captured.sessionStorage?.map(value => value.origin)).toEqual([origin]);
    expect(JSON.stringify(captured)).not.toContain("must-not-collect");
    expect(compassOnlyState(contaminated).sessionStorage).toEqual(synthetic().sessionStorage);
  }, 15000);

  it("preserves a refreshed token on later navigation and uses the latest live same-origin tab", async () => {
    const restored = await context(synthetic()), first = await restored.newPage();
    await first.goto(origin + "/one");
    await first.evaluate(() => sessionStorage.setItem("fixture-auth", "fresh-token"));
    await first.goto(origin + "/two");
    expect(await first.evaluate(() => (window as unknown as { bootToken: string }).bootToken)).toBe("fresh-token");
    const latest = await restored.newPage(); await latest.goto(origin + "/three");
    await latest.evaluate(() => sessionStorage.setItem("fixture-auth", "latest-live-token"));
    expect((await collectCompassBrowserState(restored)).sessionStorage).toEqual(synthetic("latest-live-token").sessionStorage);
    await latest.close();
    expect((await collectCompassBrowserState(restored)).sessionStorage).toEqual(synthetic("fresh-token").sessionStorage);
  }, 15000);

  it("supports old encrypted blobs and retains draft actor binding with the extended snapshot", async () => {
    vi.stubEnv("COMPASS_BROWSER_KEY", randomBytes(32).toString("hex"));
    const legacy = { cookies: [], origins: [] };
    expect(decryptCompassState(encryptCompassState(legacy))).toEqual(legacy);
    const draft = encryptCompassLoginDraft(synthetic(), "17");
    expect(decryptCompassLoginDraft(draft, "17")).toEqual(synthetic());
    expect(() => decryptCompassLoginDraft(draft, "18")).toThrow();
    expect(() => decryptCompassState(draft)).toThrow();
    const restored = await context(legacy), page = await restored.newPage();
    await page.goto(origin + "/homepage");
    expect(await page.evaluate(() => sessionStorage.getItem("fixture-auth"))).toBeNull();
  });

  it("rejects malformed and oversized session storage before restoring it", async () => {
    expect(() => compassOnlyState({ ...synthetic(), sessionStorage: [{ origin, entries: [{ name: "fixture", value: "x".repeat(65537) }] }] })).toThrow();
    expect(() => compassOnlyState({ ...synthetic(), sessionStorage: [{ origin, entries: Array.from({ length: 257 }, (_, index) => ({ name: String(index), value: "fixture" })) }] })).toThrow();
    expect(() => compassOnlyState({ ...synthetic(), sessionStorage: [{ origin, entries: Array.from({ length: 9 }, (_, index) => ({ name: String(index), value: "x".repeat(65536) })) }] })).toThrow("存储限制");
    const invalid = { ...synthetic(), sessionStorage: [{ origin, entries: [{ name: "fixture", value: 17 }] }] };
    await expect(restoreCompassBrowserState(await context(), invalid)).rejects.toThrow();
  });
});

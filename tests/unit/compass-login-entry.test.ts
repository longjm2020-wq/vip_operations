import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openFreshCompassLogin } from "../../apps/worker/src/compass-login-entry.js";
import { compassSourceUrl } from "../../apps/worker/src/compass-report-browser.js";

let browser: Browser;
const retained: BrowserContext[] = [];
beforeAll(async () => {
  const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
}, 30000);
afterEach(async () => { for (const context of retained.splice(0)) await context.close(); });
afterAll(async () => { await browser?.close(); });
async function fixture(page: Page) {
  await page.context().route("**/*", route => route.fulfill({ status: 200, contentType: "text/html", body: route.request().headers().cookie?.includes("stale-login")
    ? '<body>supplier watermark only</body>' : '<body><img alt="synthetic login QR" src="data:image/svg+xml,&lt;svg xmlns=\"http://www.w3.org/2000/svg\"/&gt;"></body>' }));
}
describe("fresh Compass supplier sign-in", () => {
  it("recovers the login entry without restoring stale credentials or changing the previous context", async () => {
    const old = await browser.newContext(); retained.push(old);
    await old.addCookies([{ name: "stale-login", value: "synthetic-invalid", domain: "vis.vip.com", path: "/", secure: true }]);
    const page = await old.newPage(); await fixture(page); await page.goto(compassSourceUrl);
    expect(await page.locator("body").innerText()).toBe("supplier watermark only");
    const fresh = await openFreshCompassLogin(browser, fixture); retained.push(fresh.context);
    expect(await fresh.page.getByRole("img", { name: "synthetic login QR" }).count()).toBe(1);
    expect(fresh.page.url()).toBe(compassSourceUrl);
    expect(await fresh.context.cookies()).toEqual([]);
    expect(await old.cookies()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "stale-login", value: "synthetic-invalid" })]));
    expect(page.isClosed()).toBe(false);
  });
  it("closes a failed replacement while retaining the previous login browser", async () => {
    const old = await browser.newContext(); retained.push(old);
    await expect(openFreshCompassLogin(browser, async () => { throw Error("synthetic configuration failure"); })).rejects.toThrow("synthetic configuration failure");
    expect(browser.contexts()).toEqual([old]);
  });
  it("does not retain an entry that navigates outside the official sites", async () => {
    await expect(openFreshCompassLogin(browser, async page => {
      await page.context().route("**/*", route => route.fulfill({ status: 200, contentType: "text/html", body: new URL(route.request().url()).hostname === "vis.vip.com"
        ? '<script>location.replace("https://unrelated.example/")</script>' : '<body>synthetic unrelated destination</body>' }));
    })).rejects.toThrow();
    expect(browser.contexts()).toEqual([]);
  });
});

import type { Browser, BrowserContext, Page } from "@playwright/test";
import { compassBrowserViewport, isCompassBrowserOrigin } from "../../../packages/contracts/src/compass-update.js";
import { compassSourceUrl } from "./compass-report-browser.js";

/** Restart only the temporary login browser; verified persisted sessions are untouched. */
export async function openFreshCompassLogin(browser: Browser, configure: (page: Page) => Promise<void>): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ locale: "zh-CN", timezoneId: "Asia/Shanghai", viewport: compassBrowserViewport, acceptDownloads: false });
  try {
    let page = await context.newPage();
    await configure(page);
    try { await page.goto(compassSourceUrl, { waitUntil: "domcontentloaded", timeout: 30000 }); }
    catch (error) {
      // An official asynchronous redirect may replace the initial navigation.
      if (!(error instanceof Error) || !/net::ERR_ABORTED|navigation.{0,25}(?:interrupt|supersed)|page.{0,25}navigating/i.test(error.message)) throw error;
      const target = context.pages().filter(candidate => !candidate.isClosed() && isCompassBrowserOrigin(candidate.url())).at(-1);
      if (!target) throw error;
      page = target;
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
    }
    if (!isCompassBrowserOrigin(page.url())) throw Error("重新扫码入口离开了官方站点");
    return { context, page };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  checkCompassLogin,
  cleanupCompassDownloads,
  compassReportTitles,
  compassVisibleRange,
  downloadCompassReports,
} from "../../apps/worker/src/compass-report-browser.js";
import { compassDimensions } from "../../packages/contracts/src/compass-analytics.js";

const targetStart = "2026-09-11",
  targetEnd = "2026-10-10";
const originalCsv = "日期,款号,销售额\n2026-10-10,000123,12.30\n";
let browser: Browser;
const pages: Page[] = [];
const servers: Server[] = [];
beforeAll(async () => {
  const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  browser = await chromium.launch({
    headless: true,
    ...(existsSync(chrome) ? { executablePath: chrome } : {}),
  });
}, 30000);
afterEach(async () => {
  for (const page of pages.splice(0)) await page.context().close();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
afterAll(async () => {
  await browser?.close();
});

function reportPage(
  options: { pending?: boolean; range?: string; generate?: boolean } = {},
) {
  return `<!doctype html><html lang="zh"><body>
  <button>自助报表</button><button>下载中心</button>
  <table>${compassDimensions.map((dimension) => `<tr id="${dimension}"><td>${compassReportTitles[dimension]}</td><td class="range">${options.range ?? `${targetStart} — ${targetEnd}`}</td><td class="state">${options.pending ? "生成中" : "已完成"}</td><td>${options.pending ? "" : `<a download href="/${dimension}.csv">下载</a>`}${options.generate ? `<button onclick="document.querySelector('#${dimension} .range').textContent='${targetStart} — ${targetEnd}'">生成报表</button>` : ""}</td></tr>`).join("")}</table>
  </body></html>`;
}
async function fixture(html: string, download = originalCsv) {
  // Chromium downloads can bypass Playwright routing. These fixtures serve
  // synthetic file bytes locally and never contact a real report endpoint.
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${request.url?.slice(1)}"`,
    });
    response.end(download);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Fixture server unavailable");
  const fixtureHtml = html.replaceAll(
    'href="/',
    `href="http://127.0.0.1:${address.port}/`,
  );
  const context = await browser.newContext({ acceptDownloads: true });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(".csv")) {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${url.pathname.slice(1)}"`,
        },
        body: download,
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body:
          url.hostname === "passport.vip.com" ? "<p>扫码登录</p>" : fixtureHtml,
      });
    }
  });
  const page = await context.newPage();
  pages.push(page);
  await page.goto("https://compass.vip.com/");
  return page;
}

describe("Compass official browser reports", () => {
  it("does not verify a supplier watermark or an embedded passport login", async () => {
    const watermark = await fixture("<div>供应商平台 水印</div>");
    expect(
      await checkCompassLogin(watermark, { alreadyLoaded: true }),
    ).toMatchObject({ verified: false, reason: "UNKNOWN_PAGE" });
    const login = await fixture(
      '<h1>供应商平台</h1><iframe src="https://passport.vip.com/login/bLogin"></iframe>',
    );
    expect(
      await checkCompassLogin(login, { alreadyLoaded: true }),
    ).toMatchObject({ verified: false, reason: "LOGIN_REQUIRED" });
  }, 15000);
  it("requires the actual three report names, and stops for a visible human challenge", async () => {
    const page = await fixture(reportPage());
    expect(
      await checkCompassLogin(page, { alreadyLoaded: true }),
    ).toMatchObject({ verified: true, reason: "READY" });
    await page.setContent(`${reportPage()}<p>请完成安全验证</p>`);
    expect(
      await checkCompassLogin(page, { alreadyLoaded: true }),
    ).toMatchObject({ verified: false, reason: "HUMAN_VERIFICATION" });
    await page.setContent("<p>下载中心</p><p>按款号（近7天）</p>");
    expect(
      (await checkCompassLogin(page, { alreadyLoaded: true })).verified,
    ).toBe(false);
  }, 20000);
  it("downloads three original files unchanged and cleans only its own temporary directory", async () => {
    const page = await fixture(reportPage());
    const notes: string[] = [];
    const files = await downloadCompassReports(
      page,
      compassDimensions,
      targetStart,
      targetEnd,
      (note) => {
        notes.push(note);
      },
    );
    try {
      expect(files.map((file) => file.dimension)).toEqual(compassDimensions);
      for (const file of files) {
        expect(await readFile(file.path, "utf8")).toBe(originalCsv);
        expect(file.fileName).toBe(`${file.dimension}.csv`);
      }
      expect(notes.filter((note) => note.includes("已下载"))).toHaveLength(3);
      await cleanupCompassDownloads([{ ...files[0], tempDirectory: tmpdir() }]);
      expect(existsSync(files[0].path)).toBe(true);
    } finally {
      await cleanupCompassDownloads(files);
    }
    expect(existsSync(files[0].tempDirectory)).toBe(false);
  }, 30000);
  it("skips visibly stale dates, generates the named report once and downloads the new range", async () => {
    const page = await fixture(
      reportPage({ range: "2026-09-10 至 2026-10-09", generate: true }),
    );
    const files = await downloadCompassReports(
      page,
      ["style"],
      targetStart,
      targetEnd,
      () => {},
      undefined,
      { maxWaitMs: 12000 },
    );
    try {
      expect(files).toHaveLength(1);
      expect(await page.locator("#style .range").innerText()).toBe(
        `${targetStart} — ${targetEnd}`,
      );
    } finally {
      await cleanupCompassDownloads(files);
    }
  }, 30000);
  it("reports pending generation as not ready and removes unsuccessful download directories", async () => {
    const before = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("compass-reports-"),
    );
    const page = await fixture(reportPage({ pending: true }));
    await expect(
      downloadCompassReports(
        page,
        ["style"],
        targetStart,
        targetEnd,
        () => {},
        undefined,
        { maxWaitMs: 1000 },
      ),
    ).rejects.toMatchObject({ code: "REPORT_NOT_READY" });
    expect(
      (await readdir(tmpdir()))
        .filter((name) => name.startsWith("compass-reports-"))
        .sort(),
    ).toEqual(before.sort());
  }, 15000);
  it("does not reuse an unchanged completed task after a forced generation", async () => {
    const page = await fixture(reportPage({ generate: true }));
    await expect(
      downloadCompassReports(
        page,
        ["style"],
        targetStart,
        targetEnd,
        () => {},
        undefined,
        { maxWaitMs: 1000, forceGenerate: true },
      ),
    ).rejects.toMatchObject({ code: "REPORT_NOT_READY" });
  }, 15000);
  it("rejects an HTML login response named CSV instead of treating it as an imported report", async () => {
    const page = await fixture(
      reportPage(),
      "<!doctype html><html><p>请登录</p></html>",
    );
    await expect(
      downloadCompassReports(page, ["style"], targetStart, targetEnd, () => {}),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
  }, 15000);
  it("recognizes only explicit visible date ranges and respects cancellation", async () => {
    expect(compassVisibleRange("统计时间 2026/9/11 至 2026/10/10")).toEqual({
      start: targetStart,
      end: targetEnd,
    });
    expect(compassVisibleRange("创建时间 2026-10-11 08:00:00")).toBeNull();
    const page = await fixture(reportPage());
    const controller = new AbortController();
    controller.abort();
    await expect(
      downloadCompassReports(
        page,
        ["style"],
        targetStart,
        targetEnd,
        () => {},
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

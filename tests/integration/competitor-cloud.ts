import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "@playwright/test";
import {
  cloudWorkerHeartbeat,
  processCloudLogin,
} from "../../apps/worker/src/competitor-cloud-login.js";
import { cloudLoginView } from "../../apps/api/src/modules/competitors/cloud-session.js";
import { loadCloudState } from "../../apps/worker/src/competitor-cloud-state.js";
import { processCrawlJob } from "../../apps/worker/src/competitor-crawler.js";
import { competitorCloudViewport } from "../../packages/contracts/src/competitor-cloud.js";

export async function testCompetitorCloud(h: Record<string, any>) {
  const { ok, request, db, one, check } = h,
    base = "/analytics/competitors";
  const previousKey = process.env.COMPETITOR_SESSION_KEY;
  process.env.COMPETITOR_SESSION_KEY = randomBytes(32).toString("hex");
  const initial = (await ok(base)).brands[0];
  const pause = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 160; i++) {
      if (await fn()) return;
      await pause(100);
    }
    throw Error("Cloud fixture timed out");
  };
  const created: Browser[] = [];
  let running: Promise<void> | undefined;
  try {
    assert.equal(
      (await request(base + "/cloud-login", "POST", {})).status,
      503,
      "missing worker configuration is explicit",
    );
    await cloudWorkerHeartbeat();
    assert.equal((await ok(base + "/cloud-session")).workerOnline, true);
    const login = await ok(base + "/cloud-login", "POST", {});
    assert.equal(
      (await ok(base + "/cloud-login", "POST", {})).id,
      login.id,
      "one owned window is reused",
    );
    const owner = await one(
      db,
      "SELECT id::text FROM users WHERE username='admin'",
    );
    await assert.rejects(
      () =>
        cloudLoginView(
          {
            actor: {
              id: String(Number(owner.id) + 100),
              username: "other",
              displayName: "other",
              permissions: ["analytics.manage"],
            },
            requestId: "test-owner",
          },
          login.id,
        ),
      (e: any) =>
        e.getStatus?.() === 403 && e.getResponse?.().error.code === "FORBIDDEN",
    );
    assert.equal((await request(base + "/cloud-login/not-a-uuid")).status, 400);
    assert.equal(
      (
        await request(base + "/cloud-login/" + login.id + "/actions", "POST", {
          kind: "GOTO",
          url: "http://localhost",
        })
      ).status,
      400,
    );
    let launched = false;
    await db.$executeRawUnsafe(
      "UPDATE competitor_crawl_jobs SET status='FAILED',completed_at=now() WHERE status IN ('QUEUED','RUNNING')",
    );
    await db.$executeRawUnsafe(
      "UPDATE competitor_crawl_jobs SET requested_at=now()-interval '6 minutes' WHERE brand_id=$1::bigint",
      initial.id,
    );
    await ok(base + "/crawl", "POST", { brandIds: [initial.id] });
    await processCrawlJob(async () => {
      launched = true;
      throw Error("must not launch during login");
    });
    assert.equal(
      launched,
      false,
      "interactive login excludes the crawler browser",
    );
    const launch = async () => {
      const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
      const browser = await chromium.launch({
        headless: true,
        ...(existsSync(chrome) ? { executablePath: chrome } : {}),
      });
      created.push(browser);
      const original = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const context = await original(options);
        await context.route("https://**.vip.com/**", async (route) => {
          const hostname = new URL(route.request().url()).hostname;
          const signedIn = (route.request().headers()["cookie"] || "").includes(
            "cloud_test_session=synthetic-session",
          );
          let html = "";
          if (hostname === "passport.vip.com")
            html = `<button style="position:absolute;left:100px;top:100px;width:100px;height:50px" onclick="document.cookie='cloud_test_session=synthetic-session;domain=.vip.com;path=/;secure;samesite=lax'">Synthetic QR consent</button>`;
          else if (hostname === "category.vip.com")
            html = `${signedIn ? '<a href="https://myi.vip.com/index.html">已登录</a>' : ""}<a href="https://detail.vip.com/detail-1-100000001.html"><span class="c-goods-item__name">合成测试羊毛针织衫</span><span class="J-goods-item__sale-price">100</span></a>`;
          else
            html = `<span class="J_brandName">${initial.name}</span><span class="pib-title-detail">合成测试羊毛针织衫</span><span id="J_detail_barCode">商品编码：CLOUD-TEST</span><table><tr><td class="dc-table-tit">详细材质信息</td><td>100%羊毛</td></tr><tr><td class="dc-table-tit">适用季节</td><td>冬季</td></tr></table>`;
          await route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: html,
          });
        });
        return context;
      };
      return browser;
    };
    running = processCloudLogin(launch);
    await until(
      async () => !!(await ok(base + "/cloud-login/" + login.id)).frame,
    );
    await ok(base + "/cloud-login/" + login.id + "/actions", "POST", {
      kind: "CHECK",
    });
    await until(async () =>
      (await ok(base + "/cloud-login/" + login.id)).note.includes("尚未确认"),
    );
    assert.notEqual(
      (await ok(base + "/cloud-session")).status,
      "READY",
      "public products alone never imply login",
    );
    await ok(base + "/cloud-login/" + login.id + "/actions", "POST", {
      kind: "REFRESH",
    });
    await until(async () =>
      (await ok(base + "/cloud-login/" + login.id)).note.includes(
        "二维码已刷新",
      ),
    );
    await until(
      async () => !!(await ok(base + "/cloud-login/" + login.id)).frame,
    );
    const frame = await ok(base + "/cloud-login/" + login.id);
    await ok(base + "/cloud-login/" + login.id + "/actions", "POST", {
      kind: "CLICK",
      frameId: frame.frameId,
      point: {
        x: 150 / competitorCloudViewport.width,
        y: 125 / competitorCloudViewport.height,
      },
    });
    await until(
      async () =>
        (await ok(base + "/cloud-login/" + login.id)).frameId !== frame.frameId,
    );
    await ok(base + "/cloud-login/" + login.id + "/actions", "POST", {
      kind: "CHECK",
    });
    await running;
    running = undefined;
    const saved = await ok(base + "/cloud-login/" + login.id);
    assert.equal(saved.status, "SAVED");
    assert.equal(saved.frame, null);
    assert.equal((await ok(base + "/cloud-session")).status, "READY");
    const encoded = await one(
      db,
      "SELECT encrypted_state FROM competitor_cloud_session WHERE id=1",
    );
    assert.ok(encoded.encrypted_state);
    assert.equal(encoded.encrypted_state.includes("synthetic-session"), false);
    assert.equal(
      JSON.stringify(await ok(base + "/cloud-session")).includes("encrypted"),
      false,
    );
    assert.equal(
      (await loadCloudState())!.state.cookies[0].value,
      "synthetic-session",
    );
    await processCrawlJob(launch);
    const job = (await ok(base)).crawl.jobs.find(
      (j: any) => j.brandId === initial.id,
    );
    assert.equal(job.status, "READY", JSON.stringify(job));
    assert.equal(job.capturedCount, 1);
    assert.equal(job.detailCount, 1);
    await ok(base + "/cloud-session/disconnect", "POST", {});
    assert.equal(
      (
        await one(
          db,
          "SELECT encrypted_state FROM competitor_cloud_session WHERE id=1",
        )
      ).encrypted_state,
      null,
    );
    await assert.rejects(() => loadCloudState(), /login is required/);
    const expired = await ok(base + "/cloud-login", "POST", {});
    await db.$executeRawUnsafe(
      "UPDATE competitor_cloud_logins SET expires_at=now()-interval '1 second',frame_jpeg='temporary' WHERE id=$1::uuid",
      expired.id,
    );
    const ended = await ok(base + "/cloud-login/" + expired.id);
    assert.equal(ended.status, "EXPIRED");
    assert.equal(ended.frame, null);
    check(
      "Cloud QR login ownership, exclusive browser lease, verified reusable encrypted session, actual crawl, disconnect and temporary frame cleanup",
    );
  } finally {
    await db.$executeRawUnsafe(
      "UPDATE competitor_cloud_logins SET status='CANCELLED',frame_jpeg=NULL WHERE status IN ('QUEUED','RUNNING','WAITING','CHECKING')",
    );
    for (const browser of created) await browser.close().catch(() => {});
    await running?.catch(() => {});
    await db.$executeRawUnsafe(
      "UPDATE competitor_cloud_session SET enabled=false,status='DISCONNECTED',encrypted_state=NULL WHERE id=1",
    );
    if (previousKey === undefined) delete process.env.COMPETITOR_SESSION_KEY;
    else process.env.COMPETITOR_SESSION_KEY = previousKey;
  }
}

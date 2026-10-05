import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "@playwright/test";
import { db, one, rows } from "../../../packages/database/src/index.js";
import { expireCloudLogins } from "../../api/src/modules/competitors/cloud-session.js";
import {
  cloudActionSchema,
  competitorCloudViewport,
  isVipOrigin,
} from "../../../packages/contracts/src/competitor-cloud.js";
import { vipSearchUrl } from "../../../packages/contracts/src/competitor-analysis.js";
import {
  cloudEncryptionReady,
  decryptCloudState,
  encryptCloudState,
} from "./competitor-cloud-state.js";

const active = "('QUEUED','RUNNING','WAITING','CHECKING')";
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function cloudWorkerHeartbeat() {
  await db.$executeRawUnsafe(
    "UPDATE competitor_cloud_session SET encryption_ready=$1,worker_heartbeat_at=now() WHERE id=1",
    cloudEncryptionReady(),
  );
  await expireCloudLogins();
  // Login images and mouse commands are temporary, including abandoned windows.
  await db.$executeRawUnsafe(
    "DELETE FROM competitor_cloud_actions WHERE completed_at<now()-interval '10 minutes'",
  );
  await db.$executeRawUnsafe(
    `DELETE FROM competitor_cloud_logins WHERE status NOT IN ${active} AND requested_at<now()-interval '1 day'`,
  );
}
export async function configureVipContext(page: Page) {
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    // Public assets may use VIP's CDN. Top-level navigation must stay on VIP.
    if (
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame() &&
      !isVipOrigin(request.url())
    )
      await route.abort();
    else await route.fallback();
  });
  page.on("popup", (popup) => void popup.close());
}
export async function checkCloudLogin(page: Page, sourceUrl: string) {
  await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  if (
    !isVipOrigin(page.url()) ||
    new URL(page.url()).hostname === "passport.vip.com"
  )
    return { verified: false, note: "尚未完成云端登录，请扫码后再次核验" };
  try {
    await page
      .locator(".c-goods-item__name")
      .first()
      .waitFor({ state: "visible", timeout: 15000 });
  } catch {
    return {
      verified: false,
      note: "尚未读到品牌商品，请在云端画面处理登录或验证后再次核验",
    };
  }
  try {
    // VIP loads its account header asynchronously, separately from products.
    // Hidden account links also exist for signed-out visitors; wait for a
    // visible account link rather than accepting its presence in the DOM.
    await page
      .locator(
        'a[href="//myi.vip.com/index.html"],a[href="https://myi.vip.com/index.html"]',
      )
      .filter({ visible: true })
      .first()
      .waitFor({ state: "visible", timeout: 15000 });
    return { verified: true, note: "云端登录已核验并保存" };
  } catch {
    return {
      verified: false,
      note: "品牌页面可以访问，但尚未确认账号登录；请查看云端画面，已登录可再次核验，未登录请刷新二维码扫码",
    };
  }
}
export async function processCloudLogin(
  launch: () => Promise<Browser> = () => chromium.launch({ headless: true }),
  signal?: AbortSignal,
) {
  if (signal?.aborted || !cloudEncryptionReady()) return;
  await expireCloudLogins();
  const token = randomUUID();
  const job = await db.$transaction(async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(2026100341)::text");
    if (
      await one(
        tx,
        "SELECT 1 FROM competitor_crawl_jobs WHERE status='RUNNING'",
      )
    )
      return null;
    if (
      await one(
        tx,
        `SELECT 1 FROM competitor_cloud_logins WHERE status IN ('RUNNING','WAITING','CHECKING')`,
      )
    )
      return null;
    const next = await one(
      tx,
      "SELECT id FROM competitor_cloud_logins WHERE status='QUEUED' AND expires_at>now() ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED",
    );
    if (!next) return null;
    return one(
      tx,
      "UPDATE competitor_cloud_logins SET status='RUNNING',claim_token=$2::uuid,heartbeat_at=now(),note='正在打开唯品会云端登录页面' WHERE id=$1::uuid RETURNING *, (extract(epoch FROM expires_at)*1000)::bigint AS expires_ms",
      next.id,
      token,
    );
  });
  if (!job) return;
  let browser: Browser | undefined;
  const close = () => void browser?.close().catch(() => {});
  const deadline = setTimeout(
    close,
    Math.max(1, Number(job.expires_ms) - Date.now()),
  );
  deadline.unref();
  signal?.addEventListener("abort", close, { once: true });
  const heartbeat = setInterval(
    () =>
      void db
        .$executeRawUnsafe(
          `UPDATE competitor_cloud_logins SET heartbeat_at=now()
    WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${active}`,
          job.id,
          token,
        )
        .catch(() => {}),
    10000,
  );
  heartbeat.unref();
  const update = async (note: string, status = "WAITING") =>
    db.$executeRawUnsafe(
      `UPDATE competitor_cloud_logins SET note=$3,status=$4
    WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${active} AND expires_at>now()`,
      job.id,
      token,
      note,
      status,
    );
  try {
    const actor = await one(
      db,
      `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_id=ur.role_id
      JOIN permissions p ON p.id=rp.permission_id WHERE u.id=$1::bigint AND u.status='ACTIVE' AND p.code='analytics.manage' LIMIT 1`,
      job.actor_id,
    );
    if (!actor) throw Error("Login owner is no longer authorized");
    const brand = await one(
      db,
      "SELECT name,brand_sn FROM competitor_brands ORDER BY is_own DESC,id LIMIT 1",
    );
    const sourceUrl = vipSearchUrl(brand!.name, brand!.brand_sn);
    const saved = await one(
      db,
      "SELECT encrypted_state FROM competitor_cloud_session WHERE id=1",
    );
    let storageState;
    try {
      if (saved?.encrypted_state)
        storageState = decryptCloudState(saved.encrypted_state);
    } catch {
      /* Reconnecting repairs expired or unreadable state. */
    }
    browser = await launch();
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: competitorCloudViewport,
      acceptDownloads: false,
      ...(storageState ? { storageState } : {}),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await configureVipContext(page);
    await page.goto("https://passport.vip.com/login", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await update(
      "请使用唯品会 App 扫描云端画面中的二维码，再点击「核验并保存」",
    );
    let frameId = randomUUID(),
      lastUrl = page.url(),
      lastFrame = 0;
    while (!signal?.aborted && Date.now() < Number(job.expires_ms)) {
      const current = await one(
        db,
        `SELECT status,frame_id FROM competitor_cloud_logins WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${active}`,
        job.id,
        token,
      );
      if (!current) break;
      if (!isVipOrigin(page.url()))
        throw Error("Cloud browser left official VIP pages");
      const action = await one(
        db,
        "SELECT id,payload FROM competitor_cloud_actions WHERE login_id=$1::uuid AND completed_at IS NULL ORDER BY id LIMIT 1",
        job.id,
      );
      if (action) {
        await db.$executeRawUnsafe(
          "UPDATE competitor_cloud_actions SET completed_at=now() WHERE id=$1::bigint",
          action.id,
        );
        await db.$executeRawUnsafe(
          `UPDATE competitor_cloud_logins SET frame_jpeg=NULL,frame_id=NULL WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${active}`,
          job.id,
          token,
        );
        const b = cloudActionSchema.parse(action.payload);
        if (
          (b.kind === "CLICK" || b.kind === "DRAG") &&
          b.frameId !== current.frame_id
        ) {
          await update("云端画面已变化，请等待刷新后重新操作");
        } else if (b.kind === "CHECK") {
          await update("正在核验云端登录与品牌商品访问", "CHECKING");
          const result = await checkCloudLogin(page, sourceUrl);
          if (result.verified) {
            const state = await context.storageState({ indexedDB: true });
            const probe = await browser.newContext({
              locale: "zh-CN",
              viewport: competitorCloudViewport,
              acceptDownloads: false,
              storageState: state,
            });
            let reusable = false;
            try {
              const probePage = await probe.newPage();
              await configureVipContext(probePage);
              reusable = (await checkCloudLogin(probePage, sourceUrl)).verified;
            } finally {
              await probe.close();
            }
            if (!reusable) {
              await update(
                "当前登录尚不能在新的云端浏览器中复用，请刷新二维码重新扫码",
              );
              continue;
            }
            const encrypted = encryptCloudState(state);
            const stored = await db.$transaction(async (tx) => {
              await rows(tx, "SELECT pg_advisory_xact_lock(2026100341)::text");
              const valid = await one(
                tx,
                `SELECT id FROM competitor_cloud_logins WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${active} AND expires_at>now() FOR UPDATE`,
                job.id,
                token,
              );
              if (!valid) return false;
              // Recheck permissions immediately before replacing the shared account.
              if (
                !(await one(
                  tx,
                  `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.id=rp.permission_id WHERE u.id=$1::bigint AND u.status='ACTIVE' AND p.code='analytics.manage' LIMIT 1`,
                  job.actor_id,
                ))
              )
                return false;
              await tx.$executeRawUnsafe(
                "UPDATE competitor_cloud_session SET enabled=true,status='READY',encrypted_state=$1,state_version=state_version+1,saved_at=now(),checked_at=now(),updated_by=$2::bigint,note='' WHERE id=1",
                encrypted,
                job.actor_id,
              );
              await tx.$executeRawUnsafe(
                "UPDATE competitor_cloud_logins SET status='SAVED',frame_jpeg=NULL,frame_id=NULL,completed_at=now(),note='云端登录已核验并保存，可以开始采集' WHERE id=$1::uuid",
                job.id,
              );
              await tx.$executeRawUnsafe(
                "DELETE FROM competitor_cloud_actions WHERE login_id=$1::uuid",
                job.id,
              );
              return true;
            });
            if (stored) return;
            break;
          }
          await update(result.note);
        } else if (b.kind === "REFRESH") {
          await page.goto("https://passport.vip.com/login", {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await update("二维码已刷新，请扫码后核验并保存");
        } else if (b.kind === "CLICK") {
          await page.mouse.click(
            b.point.x * competitorCloudViewport.width,
            b.point.y * competitorCloudViewport.height,
          );
        } else if (b.kind === "DRAG") {
          const first = b.points[0];
          await page.mouse.move(
            first.x * competitorCloudViewport.width,
            first.y * competitorCloudViewport.height,
          );
          await page.mouse.down();
          try {
            for (const point of b.points.slice(1)) {
              await page.mouse.move(
                point.x * competitorCloudViewport.width,
                point.y * competitorCloudViewport.height,
              );
              await pause(20);
            }
          } finally {
            await page.mouse.up();
          }
        }
        frameId = randomUUID();
        lastFrame = 0;
      }
      if (page.url() !== lastUrl) {
        lastUrl = page.url();
        frameId = randomUUID();
      }
      if (Date.now() - lastFrame >= 3000) {
        // Password/text inputs are never exposed in the remote image. Screens
        // exist only for the owner during this ten-minute interactive window.
        const frame = await page.screenshot({
          type: "jpeg",
          quality: 65,
          mask: [
            page.locator('input:not([type="checkbox"]):not([type="radio"])'),
          ],
        });
        await db.$executeRawUnsafe(
          `UPDATE competitor_cloud_logins SET frame_jpeg=$3,frame_id=$4::uuid,heartbeat_at=now()
          WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${active} AND expires_at>now()`,
          job.id,
          token,
          frame.toString("base64"),
          frameId,
        );
        lastFrame = Date.now();
      }
      await pause(500);
    }
    await db.$executeRawUnsafe(
      `UPDATE competitor_cloud_logins SET status='EXPIRED',frame_jpeg=NULL,frame_id=NULL,completed_at=now(),note='云端登录已过期或进程重启，请重新打开'
      WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${active}`,
      job.id,
      token,
    );
  } catch {
    await db.$executeRawUnsafe(
      `UPDATE competitor_cloud_logins SET status='FAILED',frame_jpeg=NULL,frame_id=NULL,completed_at=now(),note='云端登录页面未能打开或读取，请稍后重新打开'
      WHERE id=$1::uuid AND claim_token=$2::uuid AND status IN ${active}`,
      job.id,
      token,
    );
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", close);
    await browser?.close().catch(() => {});
  }
}
export function startCompetitorCloudLogin() {
  let busy = false,
    stopped = false,
    activeJob: Promise<void> | undefined;
  const controller = new AbortController();
  const beat = () => void cloudWorkerHeartbeat().catch(() => {});
  const tick = () => {
    if (busy || stopped) return;
    busy = true;
    activeJob = processCloudLogin(undefined, controller.signal)
      .catch(() => console.warn("Competitor cloud login unavailable"))
      .finally(() => {
        busy = false;
      });
  };
  beat();
  tick();
  const heartbeat = setInterval(beat, 15000),
    timer = setInterval(tick, 2000);
  heartbeat.unref();
  timer.unref();
  return async () => {
    stopped = true;
    controller.abort();
    clearInterval(heartbeat);
    clearInterval(timer);
    await activeJob;
  };
}

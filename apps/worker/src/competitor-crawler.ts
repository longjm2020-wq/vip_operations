import { randomUUID } from "node:crypto";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { loadCloudState, refreshCloudState } from "./competitor-cloud-state.js";
import { configureVipContext } from "./competitor-cloud-login.js";
import { competitorCloudViewport } from "../../../packages/contracts/src/competitor-cloud.js";
import { db, one, rows } from "../../../packages/database/src/index.js";
import { type Context } from "../../api/src/core.js";
import { scheduleCrawls } from "../../api/src/modules/competitors/crawl-jobs.js";
import {
  importSnapshot,
  enrichDetails,
} from "../../api/src/modules/competitors/service.js";
import {
  captureVipPage,
  captureVipScript,
} from "../../../packages/contracts/src/competitor-capture.js";
import {
  competitorProductSchema,
  vipListUrl,
  vipSearchUrl,
  type CompetitorProduct,
} from "../../../packages/contracts/src/competitor-analysis.js";

export class CrawlIssue extends Error {
  constructor(
    public readonly verification: boolean,
    message: string,
    public readonly login = false,
  ) {
    super(message);
  }
}
async function guard(page: Page) {
  const url = new URL(page.url());
  if (
    url.hostname === "passport.vip.com" ||
    (await page
      .getByText("扫码登录", { exact: true })
      .filter({ visible: true })
      .count()) ||
    (await page
      .getByText("账户登录", { exact: true })
      .filter({ visible: true })
      .count())
  )
    throw new CrawlIssue(
      false,
      "唯品会要求登录，后台采集已停止；保留上次有效数据。请打开「云端登录」重新扫码并核验，再更新竞品数据",
      true,
    );
  if (
    (await page.locator('input[placeholder*="验证码"]:visible').count()) ||
    /验证|captcha/i.test(new URL(page.url()).pathname) ||
    (await page
      .getByText(/请输入图中的.*字符|请完成.*验证|拖动.*滑块/)
      .filter({ visible: true })
      .count())
  )
    throw new CrawlIssue(
      true,
      "唯品会要求验证，后台采集已暂停；保留上次有效数据，请打开「云端登录」处理验证并重新核验",
    );
}
async function waitForProduct(page: Page, selector: string) {
  await guard(page);
  try {
    await page
      .locator(selector)
      .first()
      .waitFor({ state: "visible", timeout: 15000 });
  } catch {
    await guard(page);
    // Only public page structure is logged; never account text, query strings,
    // cookies, storage state or response bodies from the authenticated session.
    const location = new URL(page.url());
    console.warn(
      JSON.stringify({
        event: "competitor-page-empty",
        host: location.hostname,
        path: location.pathname,
        selector,
        matches: await page.locator(selector).count(),
        frames: page.frames().length,
        pageErrorVisible: await page
          .getByText(
            /access denied|页面出错|服务异常|网络异常|网络错误|没有找到|暂无商品/i,
          )
          .filter({ visible: true })
          .count(),
        accountVisible: await page.locator("#J_user_logined:visible").count(),
        signInVisible: await page
          .locator("#J_user_noId:visible,#J_user_unLogin:visible")
          .count(),
      }),
    );
    throw new CrawlIssue(
      false,
      "唯品会没有返回有效商品数据，保留上次数据，请稍后重试",
    );
  }
  await guard(page);
}
export async function crawlPublicBrand(
  page: Page,
  brand: { id: string; name: string; brandSn: string | null },
  hooks: {
    check?: () => Promise<void>;
    list: (data: any) => Promise<void>;
    detail: (products: CompetitorProduct[]) => Promise<void>;
  },
) {
  await hooks.check?.();
  let url = vipSearchUrl(brand.name, brand.brandSn);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForProduct(page, ".c-goods-item__name");
  if (!brand.brandSn) {
    const matches = await page.locator('a[href*="brand_sn="]').evaluateAll(
      (links, name) =>
        links
          .map((a) => ({
            name: a.textContent?.trim(),
            url: (a as HTMLAnchorElement).href,
          }))
          .filter((a) => a.name === name),
      brand.name,
    );
    const brandSns = [
      ...new Set(
        matches
          .filter((x) => vipListUrl(x.url))
          .map((x) => new URL(x.url).searchParams.get("brand_sn"))
          .filter(Boolean),
      ),
    ];
    if (brandSns.length !== 1)
      throw new CrawlIssue(
        false,
        "未能确定唯一品牌，请在新增品牌时填写唯品会品牌ID，或通过浏览器补充准确品牌排名",
      );
    url = vipSearchUrl(brand.name, brandSns[0]);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForProduct(page, ".c-goods-item__name");
  }
  // Bound each run to the first loaded sales page. All comparisons disclose this
  // sample scope instead of claiming a complete market catalogue.
  for (let scroll = 0; scroll < 4; scroll++) {
    const count = await page.locator(".c-goods-item__name").count();
    if (count >= 50) break;
    await page.locator(".c-goods-item__name").last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);
    await guard(page);
  }
  const captured = await page.evaluate<ReturnType<typeof captureVipPage>>(
    captureVipScript({
      href: page.url(),
      observedAt: new Date().toISOString(),
    }),
  );
  if (captured.kind !== "LIST")
    throw new CrawlIssue(false, "排名页面格式变化，未替换原数据");
  const products = captured.products
    .slice(0, 50)
    .map((p) => competitorProductSchema.parse(p));
  const { kind: _kind, ...data } = captured;
  await hooks.list({
    ...data,
    products,
    scope: `后台采集品牌销量榜前${products.length}款商品（最多50款，非全品牌目录）`,
  });
  let buffered: CompetitorProduct[] = [];
  let skipped = 0,
    consecutiveFailures = 0;
  try {
    for (const product of products) {
      await hooks.check?.();
      let verified: CompetitorProduct;
      try {
        await page.waitForTimeout(2000);
        await page.goto(product.productUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await waitForProduct(page, ".J_brandName");
        await page
          .locator(".dc-table-tit")
          .first()
          .waitFor({ state: "attached", timeout: 15000 });
        const detail = await page.evaluate<ReturnType<typeof captureVipPage>>(
          captureVipScript({
            href: page.url(),
            observedAt: new Date().toISOString(),
          }),
        );
        if (
          detail.kind !== "DETAILS" ||
          !detail.brandName.includes(brand.name) ||
          detail.products[0]?.productId !== product.productId
        )
          throw new CrawlIssue(
            false,
            "商品详情与榜单商品不一致，未采用该商品的材质信息",
          );
        verified = competitorProductSchema.parse(detail.products[0]);
      } catch (error) {
        await guard(page);
        if (error instanceof CrawlIssue && error.verification) throw error;
        skipped++;
        if (++consecutiveFailures >= 3)
          throw new CrawlIssue(
            false,
            "连续3款商品详情未能读取，已保留核对完成的数据，可稍后补充",
          );
        continue;
      }
      consecutiveFailures = 0;
      buffered.push(verified);
      if (buffered.length >= 5) {
        const batch = buffered;
        buffered = [];
        await hooks.detail(batch);
      }
    }
  } finally {
    // Keep verified details even when the next page requires verification.
    if (buffered.length) await hooks.detail(buffered);
  }
  if (skipped)
    throw new CrawlIssue(
      false,
      `${skipped}款商品详情未能核对，已保留榜单和核对完成的材质信息，可稍后补充`,
    );
}

async function jobContext(job: any): Promise<Context> {
  const actor = await one(
    db,
    `SELECT u.id::text,u.username,u.display_name,array_agg(DISTINCT p.code) AS permissions,array_agg(DISTINCT r.code) AS role_codes FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id WHERE u.status='ACTIVE' AND ($1::bigint IS NULL OR u.id=$1::bigint) GROUP BY u.id HAVING bool_or(p.code='analytics.manage') ORDER BY u.id LIMIT 1`,
    job.requested_by,
  );
  if (!actor)
    throw new CrawlIssue(false, "采集发起者没有经营分析管理权限，任务未执行");
  return {
    actor: {
      id: actor.id,
      username: actor.username,
      displayName: actor.display_name,
      permissions: actor.permissions,
      roleCodes: actor.role_codes,
    },
    requestId: "competitor-worker-" + job.id,
  };
}
export async function processCrawlJob(
  launch: () => Promise<Browser> = () => chromium.launch({ headless: true }),
  signal?: AbortSignal,
) {
  if (signal?.aborted) return;
  const token = randomUUID();
  const job = await db.$transaction(async (tx) => {
    // One browser per deployment even if multiple Worker replicas are running.
    await rows(tx, "SELECT pg_advisory_xact_lock(2026100341)::text");
    if (
      await one(
        tx,
        "SELECT 1 FROM competitor_cloud_logins WHERE status IN ('QUEUED','RUNNING','WAITING','CHECKING') AND expires_at>now()",
      )
    )
      return null;
    if (
      await one(
        tx,
        "SELECT 1 FROM competitor_crawl_jobs WHERE status='RUNNING'",
      )
    )
      return null;
    const next = await one(
      tx,
      "SELECT j.* FROM competitor_crawl_jobs j CROSS JOIN competitor_crawl_settings s WHERE j.status='QUEUED' AND (j.trigger='MANUAL' OR s.enabled) ORDER BY j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED",
    );
    if (!next) return null;
    return one(
      tx,
      "UPDATE competitor_crawl_jobs SET status='RUNNING',claim_token=$2,started_at=now(),heartbeat_at=now(),note='' WHERE id=$1::bigint RETURNING *",
      next.id,
      token,
    );
  });
  if (!job) return;
  let browser: Browser | undefined,
    browserContext: BrowserContext | undefined,
    cloud: Awaited<ReturnType<typeof loadCloudState>> = null,
    capturedCount = 0,
    detailCount = 0,
    snapshotId: string | undefined,
    timedOut = false;
  const closeBrowser = () => {
    void browser?.close().catch(() => {});
  };
  const deadline = setTimeout(
    () => {
      timedOut = true;
      closeBrowser();
    },
    20 * 60 * 1000,
  );
  deadline.unref();
  signal?.addEventListener("abort", closeBrowser, { once: true });
  const heartbeat = setInterval(() => {
    void db
      .$executeRawUnsafe(
        "UPDATE competitor_crawl_jobs SET heartbeat_at=now() WHERE id=$1::bigint AND claim_token=$2 AND status='RUNNING'",
        job.id,
        token,
      )
      .catch(() => {});
  }, 30000);
  heartbeat.unref();
  const saveProgress = () =>
    db.$executeRawUnsafe(
      "UPDATE competitor_crawl_jobs SET captured_count=$3,detail_count=$4,heartbeat_at=now() WHERE id=$1::bigint AND claim_token=$2 AND status='RUNNING'",
      job.id,
      token,
      capturedCount,
      detailCount,
    );
  const requireLease = async () => {
    if (
      await one(
        db,
        "SELECT 1 FROM competitor_cloud_logins WHERE status='QUEUED' AND expires_at>now()",
      )
    )
      throw new CrawlIssue(
        false,
        "正在准备云端登录，本次采集暂停；已保留完成的数据，登录后可重新采集",
      );
    if (
      cloud &&
      !(await one(
        db,
        "SELECT 1 FROM competitor_cloud_session WHERE id=1 AND enabled AND status='READY' AND state_version=$1",
        cloud.version,
      ))
    )
      throw new CrawlIssue(
        false,
        "云端会话已变更或断开，采集停止；已保留完成的数据",
      );
    if (signal?.aborted)
      throw new CrawlIssue(
        false,
        "采集进程正在重启，已保留完成的数据，可重新采集",
      );
    if (timedOut)
      throw new CrawlIssue(
        false,
        "本次采集已达到20分钟时限，已保留完成的数据，可稍后补充",
      );
    if (
      !(await one(
        db,
        "SELECT id FROM competitor_crawl_jobs WHERE id=$1::bigint AND claim_token=$2 AND status='RUNNING'",
        job.id,
        token,
      ))
    )
      throw new CrawlIssue(false, "采集任务已失效，保留已完成的数据");
  };
  try {
    const c = await jobContext(job),
      brand = await one(
        db,
        "SELECT id::text,name,brand_sn FROM competitor_brands WHERE id=$1::bigint",
        job.brand_id,
      );
    try {
      cloud = await loadCloudState();
    } catch {
      throw new CrawlIssue(
        false,
        "云端会话未就绪或无法读取，请打开「云端登录」扫码并核验后重新采集",
        true,
      );
    }
    browser = await launch();
    await requireLease();
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: competitorCloudViewport,
      acceptDownloads: false,
      ...(cloud ? { storageState: cloud.state } : {}),
    });
    browserContext = context;
    const page = await context.newPage();
    if (cloud) await configureVipContext(page);
    page.setDefaultTimeout(15000);
    await crawlPublicBrand(
      page,
      { id: brand!.id, name: brand!.name, brandSn: brand!.brand_sn },
      {
        check: requireLease,
        list: async (data) => {
          await requireLease();
          const saved = await importSnapshot(
            { ...c, key: `competitor-list-${job.id}` },
            { ...data, brandId: brand!.id, brandName: brand!.name },
          );
          snapshotId = String(saved.id);
          capturedCount = data.products.length;
          await saveProgress();
        },
        detail: async (products) => {
          await requireLease();
          await enrichDetails(
            { ...c, key: `competitor-detail-${job.id}-${detailCount}` },
            {
              brandId: brand!.id,
              brandName: brand!.name,
              snapshotId,
              products,
            },
          );
          detailCount += products.length;
          await saveProgress();
        },
      },
    );
    await requireLease();
    if (cloud)
      await refreshCloudState(
        await context.storageState({ indexedDB: true }),
        cloud.version,
      );
    await db.$executeRawUnsafe(
      "UPDATE competitor_crawl_jobs SET status='READY',completed_at=now(),note='后台采集完成' WHERE id=$1::bigint AND claim_token=$2 AND status='RUNNING'",
      job.id,
      token,
    );
  } catch (error) {
    const verification = error instanceof CrawlIssue && error.verification;
    const login = error instanceof CrawlIssue && error.login;
    if (cloud && (login || verification))
      await db.$executeRawUnsafe(
        "UPDATE competitor_cloud_session SET status=$1,note=$2 WHERE id=1 AND state_version=$3",
        login ? "LOGIN_REQUIRED" : "VERIFICATION_REQUIRED",
        login
          ? "唯品会要求重新登录，请在云端扫码核验"
          : "唯品会要求验证，请打开云端登录处理后核验",
        cloud.version,
      );
    else if (
      cloud &&
      browserContext &&
      capturedCount &&
      !signal?.aborted &&
      !timedOut
    )
      await refreshCloudState(
        await browserContext.storageState({ indexedDB: true }),
        cloud.version,
      ).catch(() => {});
    const note = signal?.aborted
      ? "采集进程正在重启，已保留完成的数据，可重新采集"
      : timedOut
        ? "本次采集已达到20分钟时限，已保留完成的数据，可稍后补充"
        : error instanceof CrawlIssue
          ? error.message
          : "后台采集未完成，已保留有效数据；请稍后重试或通过浏览器补充";
    await db.$executeRawUnsafe(
      "UPDATE competitor_crawl_jobs SET status=$3,note=$4,completed_at=now() WHERE id=$1::bigint AND claim_token=$2 AND status='RUNNING'",
      job.id,
      token,
      login
        ? "LOGIN_REQUIRED"
        : verification
          ? "VERIFICATION_REQUIRED"
          : capturedCount
            ? "PARTIAL"
            : "FAILED",
      note,
    );
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
    signal?.removeEventListener("abort", closeBrowser);
    await browser?.close().catch(() => {});
  }
}
export function startCompetitorCrawler() {
  let busy = false,
    stopped = false,
    active: Promise<void> | undefined;
  const controller = new AbortController();
  const tick = () => {
    if (busy || stopped) return;
    busy = true;
    active = (async () => {
      try {
        await scheduleCrawls();
        await processCrawlJob(undefined, controller.signal);
      } catch {
        console.warn("Competitor background task unavailable");
      } finally {
        busy = false;
      }
    })();
  };
  const timer = setInterval(tick, 15000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    controller.abort();
    clearInterval(timer);
    await active;
  };
}

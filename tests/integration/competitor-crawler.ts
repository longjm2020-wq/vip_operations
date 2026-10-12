import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { encryptCloudState } from "../../apps/worker/src/competitor-cloud-state.js";
import { scheduleCrawls } from "../../apps/api/src/modules/competitors/crawl-jobs.js";
import {
  CrawlIssue,
  processCrawlJob,
} from "../../apps/worker/src/competitor-crawler.js";
import { shanghaiDate } from "../../packages/contracts/src/compass-analytics.js";

export async function testCompetitorCrawler(h: Record<string, any>) {
  const { ok, request, db, one, check, buyer } = h,
    endpoint = "/analytics/competitors";
  const initial = await ok(endpoint),
    brand = initial.brands[0];
  const previousKey = process.env.COMPETITOR_SESSION_KEY;
  process.env.COMPETITOR_SESSION_KEY = randomBytes(32).toString("hex");
  await db.$executeRawUnsafe(
    `UPDATE competitor_cloud_session SET enabled=true,status='READY',
    encrypted_state=$1,encryption_ready=true,worker_heartbeat_at=now(),saved_at=now()-interval '1 hour' WHERE id=1`,
    encryptCloudState({ cookies: [], origins: [] }),
  );
  assert.equal(
    (
      await request(
        endpoint + "/crawl",
        "POST",
        { brandIds: [brand.id] },
        undefined,
        buyer,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        endpoint + "/crawl-settings",
        "POST",
        { enabled: false, dailyHour: 8, version: 1 },
        undefined,
        buyer,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request(endpoint + "/crawl", "POST", { brandIds: ["999999999"] }))
      .status,
    400,
  );
  const key = randomUUID(),
    queued = await ok(
      endpoint + "/crawl",
      "POST",
      { brandIds: [brand.id, brand.id] },
      key,
    );
  assert.equal(queued.jobs.length, 1);
  const visibleStatus = (await ok(endpoint)).crawl;
  assert.equal(visibleStatus.settings.dailyHour, 8);
  assert.equal(
    visibleStatus.jobs.find((job: any) => job.brandId === brand.id)?.status,
    "QUEUED",
  );
  assert.equal(
    (
      await ok(
        endpoint + "/crawl",
        "POST",
        { brandIds: [brand.id, brand.id] },
        key,
      )
    ).jobs[0].id,
    queued.jobs[0].id,
  );
  assert.equal(
    (await ok(endpoint + "/crawl", "POST", { brandIds: [brand.id] })).jobs[0]
      .id,
    queued.jobs[0].id,
  );
  const snapshotCount = (
    await one(
      db,
      "SELECT count(*)::int AS n FROM competitor_snapshots WHERE brand_id=$1::bigint",
      brand.id,
    )
  ).n;
  await processCrawlJob(async () => {
    throw new CrawlIssue(true, "平台要求验证，本次采集停止");
  });
  const done = (await ok(endpoint)).crawl;
  assert.equal(
    done.jobs.find((j: any) => j.id === queued.jobs[0].id).status,
    "VERIFICATION_REQUIRED",
  );
  assert.equal(JSON.stringify(done).includes("claim_token"), false);
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM competitor_snapshots WHERE brand_id=$1::bigint",
        brand.id,
      )
    ).n,
    snapshotCount,
  );
  const blocked = await request(endpoint + "/crawl", "POST", {
    brandIds: [brand.id],
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.details.recovery, "CLOUD_LOGIN");
  await db.$executeRawUnsafe(
    "UPDATE competitor_cloud_session SET status='READY',note='' WHERE id=1",
  );
  await ok(endpoint + "/crawl-settings", "POST", {
    enabled: false,
    dailyHour: 9,
    version: done.settings.version,
  });
  assert.equal(
    (
      await request(endpoint + "/crawl-settings", "POST", {
        enabled: true,
        dailyHour: 8,
        version: done.settings.version,
      })
    ).status,
    409,
  );
  await scheduleCrawls();
  assert.equal(
    (await one(db, "SELECT count(*)::int AS n FROM competitor_crawl_jobs")).n,
    1,
  );
  await db.$executeRawUnsafe(
    "INSERT INTO competitor_crawl_jobs(brand_id,trigger) VALUES($1::bigint,'SCHEDULED')",
    initial.brands[1].id,
  );
  let launched = false;
  await processCrawlJob(async () => {
    launched = true;
    throw Error("test");
  });
  assert.equal(launched, false, "paused schedules must not start browsers");
  // Manual requests still execute while automatic updates are paused. Replicas
  // must not launch a second browser while one lease is already active.
  await db.$executeRawUnsafe(
    "UPDATE competitor_crawl_jobs SET status='FAILED',completed_at=now() WHERE status='QUEUED'",
  );
  await ok(endpoint + "/crawl", "POST", {
    brandIds: [initial.brands[2].id, initial.brands[3].id],
  });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    began = new Promise<void>((r) => (started = r));
  const first = processCrawlJob(async () => {
    started();
    await gate;
    throw Error("PRIVATE_COOKIE_DO_NOT_LOG");
  });
  await began;
  await processCrawlJob(async () => {
    launched = true;
    throw Error("unexpected replica");
  });
  assert.equal(launched, false);
  release();
  await first;
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM competitor_crawl_jobs WHERE status='RUNNING'",
      )
    ).n,
    0,
  );
  assert.equal(
    JSON.stringify((await ok(endpoint)).crawl).includes(
      "PRIVATE_COOKIE_DO_NOT_LOG",
    ),
    false,
  );
  await db.$executeRawUnsafe(
    "UPDATE competitor_crawl_jobs SET status='RUNNING',heartbeat_at=now()-interval '11 minutes' WHERE status='QUEUED'",
  );
  await scheduleCrawls();
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM competitor_crawl_jobs WHERE status='RUNNING'",
      )
    ).n,
    0,
    "stale leases are recovered even while schedules are paused",
  );
  const settings = (await ok(endpoint)).crawl.settings;
  const loginJob = await ok(endpoint + "/crawl", "POST", {
    brandIds: [initial.brands[4].id],
  });
  await processCrawlJob(
    async () =>
      ({
        newContext: async () => ({
          newPage: async () => ({
            setDefaultTimeout() {},
            on() {},
            context: () => ({ route: async () => {} }),
            goto: async () => {},
            url: () => "https://passport.vip.com/login?src=public-product-list",
          }),
        }),
        close: async () => {},
      }) as any,
  );
  const loginResult = (await ok(endpoint)).crawl.jobs.find(
    (job: any) => job.id === loginJob.jobs[0].id,
  );
  assert.equal(loginResult.status, "LOGIN_REQUIRED");
  assert.equal(loginResult.capturedCount, 0);
  assert.match(loginResult.note, /要求登录/);
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM competitor_snapshots WHERE brand_id=$1::bigint",
        initial.brands[4].id,
      )
    ).n,
    0,
  );
  await ok(endpoint + "/crawl-settings", "POST", {
    enabled: true,
    dailyHour: 0,
    brandIds: initial.brands.map((b: any) => b.id),
    version: settings.version,
  });
  const afterMidnight = new Date(shanghaiDate() + "T00:30:00+08:00");
  await db.$executeRawUnsafe(
    "UPDATE competitor_cloud_session SET status='READY',worker_heartbeat_at=now() WHERE id=1",
  );
  await scheduleCrawls(afterMidnight);
  await scheduleCrawls(afterMidnight);
  const total = (
    await one(db, "SELECT count(*)::int AS n FROM competitor_crawl_jobs")
  ).n;
  assert.equal(
    total,
    initial.brands.length,
    "one daily attempt per selected brand including selected new brands",
  );
  await db.$executeRawUnsafe(
    "UPDATE competitor_cloud_session SET saved_at=now() WHERE id=1",
  );
  const recovered = await ok(endpoint + "/crawl", "POST", {
    brandIds: [brand.id],
  });
  assert.notEqual(
    recovered.jobs[0].id,
    queued.jobs[0].id,
    "fresh verification releases a recent blocked task",
  );
  assert.equal(
    (await ok(endpoint + "/crawl", "POST", { brandIds: [brand.id] })).jobs[0]
      .id,
    recovered.jobs[0].id,
    "active recovered task is not duplicated",
  );
  await db.$executeRawUnsafe(
    "UPDATE competitor_crawl_jobs SET status='FAILED',completed_at=now() WHERE status='QUEUED'",
  );
  const a = await ok(endpoint + "/brands", "POST", {
    name: "定时范围甲",
    brandSn: "10101",
  });
  const b = await ok(endpoint + "/brands", "POST", {
    name: "定时范围乙",
    brandSn: "10102",
  });
  let configured = (await ok(endpoint)).crawl.settings;
  assert.equal(
    (
      await request(endpoint + "/crawl-settings", "POST", {
        enabled: true,
        dailyHour: 0,
        brandIds: [],
        version: configured.version,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(endpoint + "/crawl-settings", "POST", {
        enabled: true,
        dailyHour: 0,
        brandIds: ["999999999"],
        version: configured.version,
      })
    ).status,
    400,
  );
  configured = await ok(endpoint + "/crawl-settings", "POST", {
    enabled: true,
    dailyHour: 0,
    brandIds: [a.id],
    version: configured.version,
  });
  assert.deepEqual(configured.brandIds, [a.id]);
  await scheduleCrawls();
  await scheduleCrawls();
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM competitor_crawl_jobs WHERE brand_id=$1::bigint AND status='QUEUED'",
        a.id,
      )
    ).n,
    1,
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM competitor_crawl_jobs WHERE brand_id=$1::bigint",
        b.id,
      )
    ).n,
    0,
  );
  configured = await ok(endpoint + "/crawl-settings", "POST", {
    enabled: true,
    dailyHour: 0,
    brandIds: [b.id],
    version: configured.version,
  });
  assert.equal(
    (
      await one(
        db,
        "SELECT status FROM competitor_crawl_jobs WHERE brand_id=$1::bigint ORDER BY id DESC LIMIT 1",
        a.id,
      )
    ).status,
    "CANCELLED",
  );
  // Even a queued scheduled job left by an older worker must not claim an excluded brand.
  await db.$executeRawUnsafe(
    "INSERT INTO competitor_crawl_jobs(brand_id,trigger) VALUES($1::bigint,'SCHEDULED')",
    a.id,
  );
  let excludedLaunched = false;
  await processCrawlJob(async () => {
    excludedLaunched = true;
    throw Error("unexpected excluded brand");
  });
  assert.equal(excludedLaunched, false);
  configured = await ok(endpoint + "/crawl-settings", "POST", {
    enabled: true,
    dailyHour: 0,
    brandIds: [b.id],
    version: configured.version,
  });
  const manualOutsideScope = await ok(endpoint + "/crawl", "POST", {
    brandIds: [a.id],
  });
  assert.equal(manualOutsideScope.jobs[0].status, "QUEUED");
  await scheduleCrawls();
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*)::int AS n FROM competitor_crawl_jobs WHERE brand_id=$1::bigint AND status='QUEUED'",
        b.id,
      )
    ).n,
    1,
  );
  // Clearing an inactive schedule cancels pending scheduled jobs, never explicit manual requests.
  configured = await ok(endpoint + "/crawl-settings", "POST", {
    enabled: false,
    dailyHour: 0,
    brandIds: [],
    version: configured.version,
  });
  assert.deepEqual((await ok(endpoint)).crawl.settings.brandIds, []);
  assert.equal(
    (
      await one(
        db,
        "SELECT status FROM competitor_crawl_jobs WHERE id=$1::bigint",
        manualOutsideScope.jobs[0].id,
      )
    ).status,
    "QUEUED",
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT status FROM competitor_crawl_jobs WHERE brand_id=$1::bigint ORDER BY id DESC LIMIT 1",
        b.id,
      )
    ).status,
    "CANCELLED",
  );
  await db.$executeRawUnsafe(
    "UPDATE competitor_crawl_jobs SET status='FAILED',completed_at=now() WHERE status='QUEUED'",
  );
  check(
    "Competitor single/multiple schedule scope, unknown/empty validation, exclusion on claim, cancellation and independent manual requests",
  );
  await db.$executeRawUnsafe(
    "UPDATE competitor_crawl_settings SET enabled=false WHERE id=1",
  );
  check(
    "Competitor silent queue permissions, idempotency, cooldown, pause, one browser lease, recovery and preserved snapshots",
  );
  await db.$executeRawUnsafe(
    "UPDATE competitor_cloud_session SET enabled=false,status='DISCONNECTED',encrypted_state=NULL,encryption_ready=false WHERE id=1",
  );
  if (previousKey === undefined) delete process.env.COMPETITOR_SESSION_KEY;
  else process.env.COMPETITOR_SESSION_KEY = previousKey;
}

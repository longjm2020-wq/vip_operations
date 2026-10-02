import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  assert.equal(
    (await ok(endpoint + "/crawl", "POST", { brandIds: [brand.id] })).jobs[0]
      .id,
    queued.jobs[0].id,
    "cooldown avoids repeated verification requests",
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
  await ok(endpoint + "/crawl-settings", "POST", {
    enabled: true,
    dailyHour: 0,
    version: settings.version,
  });
  const afterMidnight = new Date(shanghaiDate() + "T00:30:00+08:00");
  await scheduleCrawls(afterMidnight);
  await scheduleCrawls(afterMidnight);
  const total = (
    await one(db, "SELECT count(*)::int AS n FROM competitor_crawl_jobs")
  ).n;
  assert.equal(
    total,
    initial.brands.length,
    "one daily attempt per brand including new brands",
  );
  await db.$executeRawUnsafe(
    "UPDATE competitor_crawl_settings SET enabled=false WHERE id=1",
  );
  check(
    "Competitor silent queue permissions, idempotency, cooldown, pause, one browser lease, recovery and preserved snapshots",
  );
}

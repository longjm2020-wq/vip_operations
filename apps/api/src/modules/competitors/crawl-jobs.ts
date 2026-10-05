import { z } from "zod";
import { db, one, rows } from "../../../../../packages/database/src/index.js";
import {
  audit,
  command,
  Context,
  fail,
  parse,
  requirePermission,
} from "../../core.js";
import { shanghaiDate } from "../../../../../packages/contracts/src/compass-analytics.js";

export async function crawlStatus() {
  const settings = await one(
    db,
    "SELECT enabled,daily_hour,version FROM competitor_crawl_settings WHERE id=1",
  );
  const jobs = await rows(
    db,
    "SELECT DISTINCT ON(j.brand_id) j.id::text,j.brand_id::text,j.status,j.requested_at,j.started_at,j.completed_at,j.captured_count,j.detail_count,j.note FROM competitor_crawl_jobs j ORDER BY j.brand_id,j.id DESC",
  );
  return { settings, jobs };
}
export async function requestCrawl(c: Context, input: unknown) {
  requirePermission(c.actor, "analytics.manage");
  const b = parse(
    z
      .object({
        brandIds: z
          .array(z.string().regex(/^[1-9]\d{0,18}$/))
          .min(1)
          .max(40),
      })
      .strict(),
    input,
  );
  return command(c, "competitor.crawl.request", b, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(2026100340)::text");
    const brands = await rows(
      tx,
      "SELECT id::text FROM competitor_brands WHERE id=ANY($1::bigint[])",
      b.brandIds,
    );
    if (brands.length !== new Set(b.brandIds).size)
      fail("UNKNOWN_BRAND", "品牌不存在", 400);
    const jobs = [];
    for (const brand of brands) {
      const active = await one(
        tx,
        "SELECT id::text,status FROM competitor_crawl_jobs WHERE brand_id=$1::bigint AND status IN('QUEUED','RUNNING')",
        brand.id,
      );
      if (active) {
        jobs.push(active);
        continue;
      }
      const recent = await one(
        tx,
        "SELECT j.id::text,j.status FROM competitor_crawl_jobs j WHERE j.brand_id=$1::bigint AND j.requested_at>now()-interval '5 minutes' ORDER BY j.id DESC LIMIT 1",
        brand.id,
      );
      if (recent) {
        jobs.push(recent);
        continue;
      }
      jobs.push(
        await one(
          tx,
          "INSERT INTO competitor_crawl_jobs(brand_id,requested_by) VALUES($1::bigint,$2::bigint) RETURNING id::text,status",
          brand.id,
          c.actor.id,
        ),
      );
    }
    await audit(
      tx,
      c,
      "competitor.crawl.request",
      "competitor_crawl",
      null,
      null,
      { brandIds: b.brandIds },
    );
    return { jobs };
  });
}
export async function saveCrawlSettings(c: Context, input: unknown) {
  requirePermission(c.actor, "analytics.manage");
  const b = parse(
    z
      .object({
        enabled: z.boolean(),
        dailyHour: z.number().int().min(0).max(23),
        version: z.number().int().min(1),
      })
      .strict(),
    input,
  );
  return command(c, "competitor.crawl.settings", b, async (tx) => {
    const saved = await one(
      tx,
      "UPDATE competitor_crawl_settings SET enabled=$1,daily_hour=$2,updated_by=$3::bigint,version=version+1,updated_at=now() WHERE id=1 AND version=$4 RETURNING enabled,daily_hour,version",
      b.enabled,
      b.dailyHour,
      c.actor.id,
      b.version,
    );
    if (!saved) fail("STALE_SETTINGS", "采集设置已更新，请刷新后重试", 409);
    await audit(
      tx,
      c,
      "competitor.crawl.settings",
      "competitor_crawl_settings",
      "1",
      null,
      { enabled: b.enabled, dailyHour: b.dailyHour },
    );
    return saved;
  });
}
export async function scheduleCrawls(now = new Date()) {
  const today = shanghaiDate(now),
    hour = (now.getUTCHours() + 8) % 24;
  return db.$transaction(async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(2026100340)::text");
    // A stopped worker must never leave a brand permanently in RUNNING.
    await tx.$executeRawUnsafe(
      "UPDATE competitor_crawl_jobs SET status='FAILED',note='上次采集进程已中断；保留已完成数据，可重新采集',completed_at=now() WHERE status='RUNNING' AND heartbeat_at<now()-interval '10 minutes'",
    );
    const settings = await one(
      tx,
      "SELECT * FROM competitor_crawl_settings WHERE id=1",
    );
    if (!settings?.enabled) return;
    const list = await rows(
      tx,
      "SELECT b.id::text,(SELECT count(*)::int FROM competitor_snapshots s WHERE s.brand_id=b.id AND source='PUBLIC_RANK') AS snapshots FROM competitor_brands b WHERE NOT EXISTS(SELECT 1 FROM competitor_crawl_jobs j WHERE j.brand_id=b.id AND (j.status IN('QUEUED','RUNNING') OR (j.requested_at AT TIME ZONE 'Asia/Shanghai')::date=$1::date))",
      today,
    );
    for (const brand of list)
      if (brand.snapshots === 0 || hour >= settings.daily_hour)
        await tx.$executeRawUnsafe(
          "INSERT INTO competitor_crawl_jobs(brand_id,requested_by,trigger) VALUES($1::bigint,$2::bigint,'SCHEDULED')",
          brand.id,
          settings.updated_by,
        );
  });
}

import { z } from "zod";
import {
  db,
  one,
  rows,
  type Tx,
} from "../../../../../packages/database/src/index.js";
import {
  audit,
  command,
  Context,
  fail,
  parse,
  requirePermission,
} from "../../core.js";
import { shanghaiDate } from "../../../../../packages/contracts/src/compass-analytics.js";
import {
  competitorCloudReadiness,
  type CompetitorCloudStatus,
} from "../../../../../packages/contracts/src/competitor-cloud.js";

export async function crawlConnectionIssue(tx: Tx = db) {
  const row = await one(
    tx,
    `SELECT enabled,status,note,encryption_ready,
    coalesce(worker_heartbeat_at>now()-interval '1 minute',false) AS worker_online
    FROM competitor_cloud_session WHERE id=1`,
  );
  return competitorCloudReadiness({
    enabled: !!row?.enabled,
    status: (row?.status || "DISCONNECTED") as CompetitorCloudStatus["status"],
    note: row?.note || "",
    encryptionReady: !!row?.encryption_ready,
    workerOnline: !!row?.worker_online,
  });
}

export async function crawlStatus() {
  const settings = await one(
    db,
    "SELECT enabled,daily_hour,brand_ids,version FROM competitor_crawl_settings WHERE id=1",
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
    const connection = await crawlConnectionIssue(tx);
    if (connection)
      fail("CLOUD_NOT_READY", connection.note, 409, {
        recovery: connection.action,
      });
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
        `SELECT j.id::text,j.status FROM competitor_crawl_jobs j WHERE j.brand_id=$1::bigint
        AND j.requested_at>now()-interval '5 minutes' AND j.status<>'CANCELLED'
        AND NOT (j.status IN ('LOGIN_REQUIRED','VERIFICATION_REQUIRED') AND EXISTS (
          SELECT 1 FROM competitor_cloud_session s WHERE s.id=1 AND s.status='READY' AND s.saved_at>j.completed_at
        )) ORDER BY j.id DESC LIMIT 1`,
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
        brandIds: z
          .array(z.string().regex(/^[1-9]\d{0,18}$/))
          .max(40)
          .optional(),
        version: z.number().int().min(1),
      })
      .strict(),
    input,
  );
  return command(c, "competitor.crawl.settings", b, async (tx) => {
    await rows(tx, "SELECT pg_advisory_xact_lock(2026100340)::text");
    await rows(tx, "SELECT pg_advisory_xact_lock(2026100341)::text");
    const previous = await one(
      tx,
      "SELECT brand_ids FROM competitor_crawl_settings WHERE id=1",
    );
    // Older clients may save the time or pause switch without changing the selected brands.
    const brandIds: string[] = [
      ...new Set<string>(b.brandIds ?? previous?.brand_ids ?? []),
    ];
    if (b.enabled && !brandIds.length)
      fail("BRAND_REQUIRED", "请至少选择一个自动采集品牌", 400);
    const brands = await rows(
      tx,
      "SELECT id::text FROM competitor_brands WHERE id=ANY($1::bigint[])",
      brandIds,
    );
    if (brands.length !== brandIds.length)
      fail("UNKNOWN_BRAND", "品牌不存在，请刷新后重新选择", 400);
    const saved = await one(
      tx,
      "UPDATE competitor_crawl_settings SET enabled=$1,daily_hour=$2,updated_by=$3::bigint,brand_ids=$5::jsonb,version=version+1,updated_at=now() WHERE id=1 AND version=$4 RETURNING enabled,daily_hour,brand_ids,version",
      b.enabled,
      b.dailyHour,
      c.actor.id,
      b.version,
      JSON.stringify(brandIds),
    );
    if (!saved) fail("STALE_SETTINGS", "采集设置已更新，请刷新后重试", 409);
    await tx.$executeRawUnsafe(
      "UPDATE competitor_crawl_jobs SET status='CANCELLED',note='该品牌已移出自动采集范围，已取消尚未开始的定时任务',completed_at=now() WHERE status='QUEUED' AND trigger='SCHEDULED' AND NOT (brand_id=ANY($1::bigint[]))",
      brandIds,
    );
    await audit(
      tx,
      c,
      "competitor.crawl.settings",
      "competitor_crawl_settings",
      "1",
      null,
      { enabled: b.enabled, dailyHour: b.dailyHour, brandIds },
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
    if (await crawlConnectionIssue(tx)) return;
    const list = await rows(
      tx,
      "SELECT b.id::text,(SELECT count(*)::int FROM competitor_snapshots s WHERE s.brand_id=b.id AND source='PUBLIC_RANK') AS snapshots FROM competitor_brands b WHERE b.id=ANY($2::bigint[]) AND NOT EXISTS(SELECT 1 FROM competitor_crawl_jobs j WHERE j.brand_id=b.id AND (j.status IN('QUEUED','RUNNING') OR (j.status<>'CANCELLED' AND (j.requested_at AT TIME ZONE 'Asia/Shanghai')::date=$1::date)))",
      today,
      settings.brand_ids,
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

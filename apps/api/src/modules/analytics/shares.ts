import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db, one, rows } from "../../../../../packages/database/src/index.js";
import {
  audit,
  command,
  Context,
  fail,
  hash,
  id,
  parse,
  requirePermission,
} from "../../core.js";
import { getAIReport } from "./ai.js";

export async function createShare(c: Context, input: unknown) {
  requirePermission(c.actor, "analytics.manage");
  const b = parse(
    z
      .object({
        days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
        reportId: id,
      })
      .strict(),
    input,
  );
  return command(c, "compass.share.create", b, async (tx) => {
    const report = await getAIReport();
    if (report.state !== "READY" || !report.content)
      fail("REPORT_NOT_READY", "请先生成经营分析，再创建分享链接", 409);
    if (report.id !== b.reportId)
      fail("REPORT_CHANGED", "分析报告已更新，请刷新分析后重新创建分享", 409);
    // Explicit allowlist: never expose model settings, provider, keys or source files.
    const snapshot = {
      reportDate: report.reportDate,
      generatedAt: report.generatedAt,
      content: {
        summary: report.content.summary,
        actions: report.content.actions,
        observations: report.content.observations,
        risks: report.content.risks,
      },
      visuals: report.visuals,
    };
    const token = randomBytes(32).toString("hex");
    const saved = await one(
      tx,
      "INSERT INTO compass_report_shares(token_hash,report_date,snapshot,expires_at,created_by) VALUES($1,$2::date,$3::jsonb,now()+make_interval(days=>$4::int),$5::bigint) RETURNING id,expires_at",
      hash(token),
      report.reportDate,
      JSON.stringify(snapshot),
      b.days,
      c.actor.id,
    );
    await audit(
      tx,
      c,
      "compass.share.create",
      "compass_report_share",
      saved!.id,
      null,
      { reportDate: report.reportDate, days: b.days },
    );
    return {
      id: String(saved!.id),
      path: "/share/compass/" + token,
      expiresAt: saved!.expires_at,
    };
  });
}
export async function listShares(c: Context) {
  requirePermission(c.actor, "analytics.manage");
  return rows(
    db,
    "SELECT id::text,report_date::text,expires_at,revoked_at,created_at FROM compass_report_shares WHERE created_by=$1::bigint ORDER BY id DESC LIMIT 30",
    c.actor.id,
  );
}
export async function revokeShare(c: Context, shareId: string) {
  requirePermission(c.actor, "analytics.manage");
  parse(id, shareId);
  return command(c, "compass.share.revoke", { id: shareId }, async (tx) => {
    const share = await one(
      tx,
      "SELECT * FROM compass_report_shares WHERE id=$1::bigint FOR UPDATE",
      shareId,
    );
    if (
      !share ||
      (String(share.created_by) !== c.actor.id &&
        !c.actor.roleCodes?.includes("SUPER_ADMIN"))
    )
      fail("SHARE_NOT_FOUND", "分享不存在或无权撤销", 404);
    if (!share.revoked_at) {
      await tx.$executeRawUnsafe(
        "UPDATE compass_report_shares SET revoked_at=now() WHERE id=$1::bigint",
        shareId,
      );
      await audit(
        tx,
        c,
        "compass.share.revoke",
        "compass_report_share",
        shareId,
        null,
        { revoked: true },
      );
    }
    return { revoked: true };
  });
}
export async function publicShare(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token))
    fail("SHARE_UNAVAILABLE", "分享链接不存在、已过期或已撤销", 404);
  const record = await one(
    db,
    "SELECT snapshot,expires_at FROM compass_report_shares WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()",
    hash(token),
  );
  if (!record) fail("SHARE_UNAVAILABLE", "分享链接不存在、已过期或已撤销", 404);
  return { ...record.snapshot, expiresAt: record.expires_at };
}

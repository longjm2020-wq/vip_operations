import { db, one, rows } from "../../../../../packages/database/src/index.js";
import type { Context } from "../../core.js";
import { libraryAdmin, readableSql } from "../projects/library.js";
import { workspaceScheduleSchema } from "../../../../../packages/contracts/src/personal-workspace.js";
import {
  shanghaiDate,
  shiftCompassDate,
} from "../../../../../packages/contracts/src/compass-analytics.js";
import type {
  AssistantActivity,
  AssistantActivityFeed,
} from "../../../../../packages/contracts/src/assistant-activity.js";

// A private, read-only projection. It neither starts jobs nor reads credentials.
export async function assistantActivity(
  c: Context,
  now = new Date(),
): Promise<AssistantActivityFeed> {
  const items: AssistantActivity[] = [];
  const today = shanghaiDate(now),
    lastDay = shiftCompassDate(today, 7);
  const workspace = await one(
    db,
    "SELECT config->'schedule' AS schedule FROM personal_workspaces WHERE user_id=$1::bigint",
    c.actor.id,
  );
  for (const raw of Array.isArray(workspace?.schedule)
    ? workspace.schedule
    : []) {
    const parsed = workspaceScheduleSchema.safeParse(raw);
    if (!parsed.success) continue;
    const event = parsed.data;
    if (event.date < today || event.date > lastDay) continue;
    const start = new Date(
      `${event.date}T${event.startTime || "00:00"}:00+08:00`,
    );
    const end = new Date(`${event.date}T${event.endTime || "23:59"}:00+08:00`);
    const due = start.getTime() - now.getTime();
    items.push({
      id: `schedule:${event.id}`,
      kind: "schedule",
      title: event.title,
      detail: `${event.date} · ${event.startTime ? `${event.startTime}${event.endTime ? `–${event.endTime}` : ""}` : "全天"}`,
      href: "/my-workspace",
      at: start.toISOString(),
      status:
        now > end
          ? "completed"
          : due <= 0
            ? "running"
            : due <= 30 * 60000
              ? "attention"
              : "upcoming",
    });
  }
  if (c.actor.permissions.includes("project.read")) {
    const notices = await rows(
      db,
      `SELECT n.id::text,n.body,n.created_at::text,p.id::text AS project_id,p.name
      FROM project_notifications n JOIN projects p ON p.id=n.project_id
      WHERE n.user_id=$2::bigint AND p.deleted_at IS NULL AND ${readableSql("project", "p")}
      AND n.created_at>now()-interval '7 days' ORDER BY n.id DESC LIMIT 15`,
      libraryAdmin(c.actor),
      c.actor.id,
    );
    for (const n of notices)
      items.push({
        id: `notice:${n.id}`,
        kind: "project",
        title: n.name,
        detail: n.body,
        href: `/projects/${n.project_id}`,
        at: new Date(n.created_at).toISOString(),
        status: "info",
      });
    const projects = await rows(
      db,
      `SELECT p.id::text,p.name,p.status,p.updated_at::text,
      (SELECT count(*)::int FROM jsonb_array_elements(COALESCE(p.document->'tasks','[]')) t) AS total,
      (SELECT count(*)::int FROM jsonb_array_elements(COALESCE(p.document->'tasks','[]')) t WHERE t->>'status'='DONE') AS done,
      EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p.document->'tasks','[]')) t WHERE t->>'status'='DISPUTED') AS disputed
      FROM projects p WHERE p.deleted_at IS NULL AND p.status<>'DRAFT' AND ${readableSql("project", "p")}
      AND (p.owner_id=$2::bigint OR EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=$2::bigint))
      ORDER BY p.updated_at DESC LIMIT 10`,
      libraryAdmin(c.actor),
      c.actor.id,
    );
    for (const p of projects)
      items.push({
        id: `project:${p.id}`,
        kind: "project",
        title: p.name,
        detail:
          p.status === "VOID"
            ? "项目已作废"
            : `已验收 ${p.done} / ${p.total} 项任务${p.disputed ? " · 存在待处理异议" : ""}`,
        href: `/projects/${p.id}`,
        at: new Date(p.updated_at).toISOString(),
        progress: { done: p.done, total: p.total },
        status:
          p.status === "VOID"
            ? "info"
            : p.disputed
              ? "attention"
              : p.status === "DONE"
                ? "completed"
                : "info",
      });
  }
  if (c.actor.permissions.includes("analytics.read")) {
    const jobs = await rows(
      db,
      `SELECT id::text,status,target_end_date::text,requested_at::text,completed_at::text,
      heartbeat_at::text,deadline_at::text,completed_dimensions FROM compass_update_jobs
      WHERE requested_at>now()-interval '7 days' ORDER BY id DESC LIMIT 5`,
    );
    for (const job of jobs) {
      const active = ["QUEUED", "RUNNING"].includes(job.status);
      const stale =
        active &&
        (now > new Date(job.deadline_at) ||
          now.getTime() -
            new Date(job.heartbeat_at || job.requested_at).getTime() >
            (job.status === "QUEUED" ? 2 : 5) * 60000);
      const status =
        job.status === "COMPLETE"
          ? "completed"
          : active && !stale
            ? "running"
            : "attention";
      const labels: Record<string, string> = {
        QUEUED: "排队中",
        RUNNING: "采集中",
        COMPLETE: "已完成",
        PARTIAL: "部分完成",
        FAILED: "失败",
        LOGIN_REQUIRED: "需要登录",
        VERIFICATION_REQUIRED: "需要验证",
      };
      items.push({
        id: `compass:${job.id}`,
        kind: "task",
        title: "罗盘报表更新",
        detail: `截至 ${job.target_end_date} · ${stale ? "进度中断，请查看任务" : labels[job.status] || job.status}`,
        href: "/analytics/compass",
        at: new Date(job.completed_at || job.requested_at).toISOString(),
        status,
        progress: {
          done: Array.isArray(job.completed_dimensions)
            ? job.completed_dimensions.length
            : 0,
          total: 3,
        },
      });
    }
  }
  if (c.actor.permissions.includes("analytics.manage")) {
    const runs = await rows(
      db,
      `SELECT report_date::text,status,count(*)::int AS recipients,
      max(COALESCE(sent_at,started_at))::text AS at FROM compass_mail_runs
      WHERE started_at>now()-interval '7 days' GROUP BY report_date,status ORDER BY report_date DESC LIMIT 15`,
    );
    for (const run of runs) {
      const stale =
        run.status === "SENDING" &&
        now.getTime() - new Date(run.at).getTime() > 15 * 60000;
      const label =
        run.status === "ACCEPTED"
          ? "邮件服务器已接收"
          : run.status === "SENDING" && !stale
            ? "发送中"
            : run.status === "FAILED"
              ? "发送失败"
              : "发送结果待核对";
      items.push({
        id: `mail:${run.report_date}:${run.status}`,
        kind: "task",
        title: "每日经营日报",
        detail: `${run.report_date} · ${run.recipients} 个地址 · ${label}`,
        href: "/analytics/compass",
        at: new Date(run.at).toISOString(),
        status:
          run.status === "ACCEPTED"
            ? "completed"
            : run.status === "SENDING" && !stale
              ? "running"
              : "attention",
      });
    }
  }
  const rank = (item: AssistantActivity) =>
    item.status === "attention"
      ? 0
      : item.status === "running"
        ? 1
        : item.status === "upcoming"
          ? 2
          : 3;
  items.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.status === "upcoming" && b.status === "upcoming"
        ? a.at.localeCompare(b.at)
        : b.at.localeCompare(a.at)),
  );
  return { items: items.slice(0, 60), serverTime: now.toISOString() };
}

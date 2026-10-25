import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Context } from "../../apps/api/src/core.js";

const fixture = vi.hoisted(() => ({ database: null as PGlite | null }));
vi.mock("../../packages/database/src/index.js", async (original) => ({
  ...(await original<typeof import("../../packages/database/src/index.js")>()),
  db: {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) =>
      (await fixture.database!.query(sql, params)).rows,
  },
}));
import { assistantActivity } from "../../apps/api/src/modules/workspace/activity.js";

const context = (permissions: string[] = [], id = "7"): Context => ({
  actor: {
    id,
    username: "test",
    displayName: "Test",
    permissions,
    roleCodes: [],
  },
  requestId: "activity-test",
});
const now = new Date("2026-10-26T02:00:00Z");
const sql = (query: string, params?: unknown[]) =>
  fixture.database!.query(query, params);
beforeAll(async () => {
  fixture.database = new PGlite();
  await fixture.database.exec(`
    CREATE TABLE personal_workspaces(user_id bigint PRIMARY KEY, config jsonb);
    CREATE TABLE projects(id bigint PRIMARY KEY,name text,status text,owner_id bigint,visibility text,
      deleted_at timestamptz,document jsonb,updated_at timestamptz DEFAULT now());
    CREATE TABLE project_members(project_id bigint,user_id bigint);
    CREATE TABLE project_library_acl(kind text,resource_id bigint,user_id bigint,access text);
    CREATE TABLE project_notifications(id bigint,user_id bigint,project_id bigint,body text,created_at timestamptz DEFAULT now());
    CREATE TABLE compass_update_jobs(id bigint,status text,target_end_date date,requested_at timestamptz DEFAULT now(),
      completed_at timestamptz,heartbeat_at timestamptz,deadline_at timestamptz,completed_dimensions jsonb);
    CREATE TABLE compass_mail_runs(report_date date,status text,sent_at timestamptz,started_at timestamptz DEFAULT now(),
      recipient text);
  `);
});
beforeEach(async () => {
  await fixture.database!.exec(
    "TRUNCATE personal_workspaces,projects,project_members,project_library_acl,project_notifications,compass_update_jobs,compass_mail_runs",
  );
});
afterAll(async () => {
  await fixture.database?.close();
});

describe("personal assistant read-only activity feed", () => {
  it("keeps schedules private, uses Shanghai reminder times and ignores invalid or out-of-range entries", async () => {
    const event = (
      n: number,
      title: string,
      date: string,
      startTime = "",
      endTime = "",
    ) => ({
      id: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`,
      title,
      date,
      startTime,
      endTime,
      note: "private note omitted",
    });
    await sql(
      "INSERT INTO personal_workspaces VALUES(7,$1::jsonb),(8,$2::jsonb)",
      [
        JSON.stringify({
          schedule: [
            event(1, "due soon", "2026-10-26", "10:20", "11:00"),
            event(2, "in progress", "2026-10-26", "09:50", "10:30"),
            event(3, "ended", "2026-10-26", "08:00", "09:00"),
            event(4, "next week", "2026-11-02"),
            event(5, "too far", "2026-11-03"),
            event(6, "yesterday", "2026-10-25"),
            { title: "invalid" },
          ],
          note: "private workspace note",
        }),
        JSON.stringify({
          schedule: [event(7, "other user's schedule", "2026-10-26")],
        }),
      ],
    );
    const feed = await assistantActivity(context(), now);
    expect(feed.items.map((i) => [i.title, i.status])).toEqual([
      ["due soon", "attention"],
      ["in progress", "running"],
      ["next week", "upcoming"],
      ["ended", "completed"],
    ]);
    expect(feed.items[0].at).toBe("2026-10-26T02:20:00.000Z");
    expect(feed.items[0].detail).toContain("10:20–11:00");
    expect(JSON.stringify(feed)).not.toMatch(/private|other user/);
    expect(feed.serverTime).toBe(now.toISOString());
  });

  it("honors project ownership, membership, denial, deletion and notification recipients", async () => {
    await fixture.database!.exec(`
      INSERT INTO projects(id,name,status,owner_id,visibility,document) VALUES
      (1,'own','ACTIVE',7,'PRIVATE','{"tasks":[{"status":"DONE"},{"status":"ACTIVE"}]}'),
      (2,'member','ACTIVE',8,'PRIVATE','{"tasks":[{"status":"DISPUTED"}]}'),
      (3,'denied','ACTIVE',8,'PUBLIC','{"tasks":[]}'),
      (4,'private','ACTIVE',8,'PRIVATE','{"tasks":[]}'),
      (5,'deleted','ACTIVE',7,'PRIVATE','{"tasks":[]}'),
      (6,'draft','DRAFT',7,'PRIVATE','{"tasks":[]}'),
      (7,'public unrelated','ACTIVE',8,'PUBLIC','{"tasks":[]}'),
      (8,'void','VOID',7,'PRIVATE','{"tasks":[{"status":"DISPUTED"}]}');
      UPDATE projects SET deleted_at=now() WHERE id=5;
      INSERT INTO project_members VALUES(2,7),(3,7);
      INSERT INTO project_library_acl VALUES('project',3,7,'DENY');
      INSERT INTO project_notifications(id,user_id,project_id,body) VALUES
      (1,7,1,'own notice'),(2,8,1,'another user notice'),(3,7,3,'denied notice'),(4,7,4,'private notice'),(5,7,5,'deleted notice');
    `);
    expect((await assistantActivity(context(), now)).items).toHaveLength(0);
    const feed = await assistantActivity(context(["project.read"]), now);
    expect(feed.items.map((i) => i.id).sort()).toEqual([
      "notice:1",
      "project:1",
      "project:2",
      "project:8",
    ]);
    expect(feed.items.find((i) => i.id === "project:1")?.progress).toEqual({
      done: 1,
      total: 2,
    });
    expect(feed.items.find((i) => i.id === "project:2")?.status).toBe(
      "attention",
    );
    expect(feed.items.find((i) => i.id === "project:8")).toMatchObject({
      status: "info",
      detail: "项目已作废",
    });
  });

  it("gates report and mail feedback separately, distinguishes stale jobs and SMTP acceptance without exposing recipients", async () => {
    await fixture.database!.exec(`
      INSERT INTO compass_update_jobs(id,status,target_end_date,heartbeat_at,deadline_at,completed_dimensions) VALUES
      (1,'RUNNING','2026-10-25','2026-10-26T01:59:00Z','2026-10-26T03:00:00Z','["STYLE"]'),
      (2,'RUNNING','2026-10-25','2026-10-26T01:00:00Z','2026-10-26T03:00:00Z','[]'),
      (3,'COMPLETE','2026-10-25',NULL,'2026-10-26T03:00:00Z','["STYLE","GOODS","BARCODE"]');
      INSERT INTO compass_mail_runs(report_date,status,sent_at,recipient) VALUES
      ('2026-10-26','ACCEPTED','2026-10-26T01:50:00Z','private@example.test'),
      ('2026-10-26','FAILED','2026-10-26T01:51:00Z','other@example.test');
    `);
    expect((await assistantActivity(context(), now)).items).toHaveLength(0);
    const reader = await assistantActivity(context(["analytics.read"]), now);
    expect(reader.items).toHaveLength(3);
    expect(reader.items.find((i) => i.id === "compass:1")).toMatchObject({
      status: "running",
      progress: { done: 1, total: 3 },
    });
    expect(reader.items.find((i) => i.id === "compass:2")).toMatchObject({
      status: "attention",
      detail: expect.stringContaining("进度中断"),
    });
    expect(reader.items.find((i) => i.id === "compass:3")?.status).toBe(
      "completed",
    );
    const manager = await assistantActivity(
      context(["analytics.read", "analytics.manage"]),
      now,
    );
    expect(manager.items).toHaveLength(5);
    expect(
      manager.items.find((i) => i.id === "mail:2026-10-26:ACCEPTED")?.detail,
    ).toContain("邮件服务器已接收");
    expect(JSON.stringify(manager)).not.toMatch(
      /example.test|recipient|secret/i,
    );
    expect(
      (await sql("SELECT status FROM compass_update_jobs WHERE id=2")).rows[0],
    ).toEqual({ status: "RUNNING" });
  });
});

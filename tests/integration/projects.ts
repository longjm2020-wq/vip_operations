import "dotenv/config";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
const url = new URL(process.env.DATABASE_URL!);
const database = "project_test_" + Date.now();
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query("CREATE DATABASE " + database);
url.pathname = "/" + database;
process.env.DATABASE_URL = url.toString();
process.env.ADMIN_PASSWORD = "test-only-" + randomUUID();
process.env.PORT = "3102";
process.env.APP_ORIGIN = "http://localhost:5175";
process.env.VIP_MODE = "disabled";
await migrate();
const { seed } = await import("../../scripts/seed.js");
await seed();
const { db, one, rows } = await import("../../packages/database/src/index.js");
const { passwordHash } = await import("../../apps/api/src/core.js");
const child = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "apps/api/src/main.ts"],
  { env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
);
const log = createWriteStream(".local/projects-test-api.log");
child.stdout.pipe(log);
child.stderr.pipe(log);
type User = { cookie: string; csrf: string; id: string };
const empty: User = { cookie: "", csrf: "", id: "" };
const request = async (
  u: User,
  path: string,
  method = "GET",
  body?: unknown,
  key: string = randomUUID(),
) => {
  const r = await fetch("http://127.0.0.1:3102/api/v1" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: u.cookie,
      Origin: process.env.APP_ORIGIN!,
      "X-CSRF-Token": u.csrf,
      "Idempotency-Key": key,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    data: await r.json(),
    cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
  };
};
const ok = async (
  u: User,
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
) => {
  const r = await request(u, path, method, body, key);
  assert.ok(r.status < 300, `${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.data;
};
const login = async (name: string) => {
  const r = await request(empty, "/auth/login", "POST", {
    username: name,
    password: process.env.ADMIN_PASSWORD,
  });
  assert.equal(r.status, 200);
  return { cookie: r.cookie, csrf: r.data.data.csrfToken, id: r.data.data.id };
};
let checks = 0;
const pass = (s: string) => {
  checks++;
  console.log("PASS", s);
};
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch("http://127.0.0.1:3102/api/v1/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await request(empty, "/projects")).status, 401);
  const owner = await login("admin");
  for (const [name, role] of [
    ["buyer", "BUYER"],
    ["reviewer", "OPERATOR"],
    ["outsider", "STOCK"],
  ]) {
    const u = await one(
      db,
      "INSERT INTO users(username,display_name,password_hash) VALUES($1,$1,$2) RETURNING id",
      name,
      passwordHash(process.env.ADMIN_PASSWORD!),
    );
    await rows(
      db,
      "INSERT INTO user_roles(user_id,role_id) SELECT $1::bigint,id FROM roles WHERE code=$2 RETURNING user_id",
      String(u!.id),
      role,
    );
  }
  const buyer = await login("buyer"),
    reviewer = await login("reviewer"),
    outsider = await login("outsider");
  const template = {
    name: "验收流程",
    department: "运营",
    description: "测试",
    steps: [
      { id: "a", name: "计划", description: "计划交付" },
      { id: "b", name: "找品", description: "选品交付" },
    ],
  };
  assert.equal(
    (await request(buyer, "/projects/sops", "POST", template)).status,
    403,
  );
  const sop = await ok(owner, "/projects/sops", "POST", template);
  pass("岗位 SOP 创建权限及模板保存");
  const task = (id: string, stage: string) => ({
    id,
    stage: sop.id + ":" + stage,
    title: "任务" + id,
    assignee: buyer.id,
    receiver: reviewer.id,
    start: "2026-09-15",
    end: "2026-09-19",
    role: "买手",
    status: "DONE",
    reason: "",
    delivery: "",
  });
  const body = {
    name: "项目测试",
    tag: "周上新",
    description: "**目标**\n安全文本<script>alert(1)</script>",
    start: "2026-09-15",
    end: "2026-09-19",
    sopIds: [sop.id],
    collaborators: [buyer.id, reviewer.id],
    tasks: [task("1", "a"), task("2", "b")],
    requirements: [],
  };
  let p = await ok(owner, "/projects", "POST", body);
  assert.equal(p.document.tasks[0].status, "PENDING");
  assert.equal((await request(buyer, "/projects/" + p.id)).status, 403);
  assert.equal((await ok(outsider, "/projects")).length, 0);
  pass("草稿隔离与伪造任务完成状态防护");
  const action = async (
    u: User,
    a: string,
    extra: Record<string, unknown> = {},
    key?: string,
  ) => {
    const r = await ok(
      u,
      `/projects/${p.id}/actions`,
      "POST",
      { action: a, version: p.version, ...extra },
      key,
    );
    p = r;
    return r;
  };
  await action(owner, "publish");
  assert.equal(p.status, "ACTIVE");
  assert.equal((await ok(reviewer, "/projects/notifications")).length, 1);
  assert.equal((await request(outsider, "/projects/" + p.id)).status, 403);
  assert.equal(
    (await request(outsider, `/projects/${p.id}/messages`)).status,
    403,
  );
  pass("项目发布通知与非成员读取隔离");
  assert.equal(
    (
      await request(buyer, `/projects/${p.id}/actions`, "POST", {
        action: "submit",
        version: p.version,
        taskId: "2",
        reason: "提前提交",
      })
    ).status,
    409,
  );
  await action(buyer, "submit", { taskId: "1", reason: "计划已交付" });
  assert.equal(
    (
      await request(buyer, `/projects/${p.id}/actions`, "POST", {
        action: "approve",
        version: p.version,
        taskId: "1",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(reviewer, `/projects/${p.id}/actions`, "POST", {
        action: "reject",
        version: p.version,
        taskId: "1",
      })
    ).status,
    400,
  );
  await action(reviewer, "reject", { taskId: "1", reason: "请补充需求" });
  assert.equal(p.document.tasks[0].status, "DISPUTED");
  assert.equal((await ok(owner, "/projects?objection=yes")).length, 1);
  pass("前序环节门禁、验收角色与驳回原因必填");
  await action(buyer, "submit", { taskId: "1", reason: "已补充" });
  const versionBefore = p.version;
  await action(reviewer, "approve", { taskId: "1" });
  assert.equal(p.document.tasks[0].status, "DONE");
  assert.equal(
    (
      await request(owner, "/projects/" + p.id, "PATCH", {
        ...body,
        version: versionBefore,
      })
    ).status,
    409,
  );
  const editable = await ok(owner, "/projects/" + p.id);
  p = await ok(owner, "/projects/" + p.id, "PATCH", {
    ...editable.document,
    name: "更新标题",
    version: editable.version,
  });
  assert.equal(p.document.tasks[0].status, "DONE");
  pass("驳回重提、并发版本冲突与已完成任务保护");
  const messageKey = randomUUID();
  const msg = { body: "请核对关联任务", taskIds: ["1", "2"], mentions: [] };
  const m1 = await ok(
      buyer,
      `/projects/${p.id}/messages`,
      "POST",
      msg,
      messageKey,
    ),
    m2 = await ok(buyer, `/projects/${p.id}/messages`, "POST", msg, messageKey);
  assert.equal(m1.id, m2.id);
  assert.deepEqual(m1.mentions.sort(), [buyer.id, reviewer.id].sort());
  assert.equal(
    (
      await request(buyer, `/projects/${p.id}/messages`, "POST", {
        body: "无权@外部人员",
        mentions: [outsider.id],
      })
    ).status,
    403,
  );
  pass("多任务消息自动@、成员边界及消息幂等");
  await action(buyer, "invite", { users: [outsider.id] });
  assert.equal((await ok(outsider, "/projects/" + p.id)).id, p.id);
  await ok(outsider, `/projects/${p.id}/read`, "POST", {});
  assert.ok(
    (await ok(outsider, "/projects/notifications")).every((n: any) => n.readAt),
  );
  pass("协作人邀请、项目卡片通知与已读状态");
  await action(buyer, "submit", { taskId: "2", reason: "产品已到样" });
  await action(reviewer, "approve", { taskId: "2" });
  assert.equal(p.status, "DONE");
  assert.equal(
    (
      await request(owner, `/projects/${p.id}/actions`, "POST", {
        action: "void",
        version: p.version,
        reason: "不可作废已完成",
      })
    ).status,
    409,
  );
  pass("全部环节验收后自动完成及终态保护");
  const draft = await ok(owner, "/projects", "POST", {
    ...body,
    name: "",
    tasks: [],
    sopIds: [],
  });
  assert.equal(
    (
      await request(owner, `/projects/${draft.id}/actions`, "POST", {
        action: "publish",
        version: draft.version,
      })
    ).status,
    400,
  );
  await ok(owner, `/projects/${draft.id}/actions`, "POST", {
    action: "void",
    version: draft.version,
    reason: "测试草稿作废",
  });
  assert.equal((await ok(owner, "/projects/" + draft.id)).status, "VOID");
  pass("草稿宽松保存、发布完整性与可追溯作废");
  await migrate();
  assert.equal((await ok(owner, "/projects/" + p.id)).status, "DONE");
  assert.ok(
    Number(
      (await one(
        db,
        "SELECT count(*) AS n FROM audit_logs WHERE entity_type='project'",
      ))!.n,
    ) > 5,
  );
  pass("迁移幂等、数据持久化与操作审计");
  const branching = {
    ...template,
    name: "并行分支验收",
    steps: [
      { id: "a", name: "起点", dependsOn: [], position: { x: -300, y: 10 } },
      {
        id: "b",
        name: "并行一",
        dependsOn: ["a"],
        position: { x: 40, y: -200 },
      },
      {
        id: "c",
        name: "并行二",
        dependsOn: ["a"],
        position: { x: 40, y: 200 },
      },
      {
        id: "d",
        name: "汇合",
        dependsOn: ["b", "c"],
        position: { x: 400, y: 10 },
      },
    ],
  };
  for (const steps of [
    [{ id: "a", name: "循环", dependsOn: ["a"] }],
    [{ id: "a", name: "丢失", dependsOn: ["missing"] }],
    [
      { id: "a", name: "A", dependsOn: ["b"] },
      { id: "b", name: "B", dependsOn: ["a"] },
    ],
  ])
    assert.equal(
      (await request(owner, "/projects/sops", "POST", { ...template, steps }))
        .status,
      400,
    );
  const graph = await ok(owner, "/projects/sops", "POST", branching);
  assert.deepEqual(graph.steps[0].position, { x: -300, y: 10 });
  p = await ok(owner, "/projects", "POST", {
    ...body,
    sopIds: [graph.id],
    tasks: branching.steps.map((s) => ({
      ...task(s.id, s.id),
      stage: graph.id + ":" + s.id,
    })),
  });
  await action(owner, "publish");
  await action(buyer, "submit", { taskId: "a", reason: "起点交付" });
  await action(reviewer, "approve", { taskId: "a" });
  // C may complete while B is pending, regardless of array order.
  await action(buyer, "submit", { taskId: "c", reason: "并行二交付" });
  await action(reviewer, "approve", { taskId: "c" });
  assert.equal(
    (
      await request(buyer, `/projects/${p.id}/actions`, "POST", {
        action: "submit",
        version: p.version,
        taskId: "d",
        reason: "提前汇合",
      })
    ).status,
    409,
  );
  await action(buyer, "submit", { taskId: "b", reason: "并行一交付" });
  await action(reviewer, "approve", { taskId: "b" });
  await action(buyer, "submit", { taskId: "d", reason: "汇合交付" });
  await action(reviewer, "approve", { taskId: "d" });
  assert.equal(p.status, "DONE");
  assert.deepEqual(p.document.stages[3].dependsOn, [
    graph.id + ":b",
    graph.id + ":c",
  ]);
  pass("分支并行、汇合依赖、非法循环拒绝及画布位置持久化");
  console.log("Project integration:", checks, "scenarios passed.");
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill();
    await exited;
  }
  log.end();
  await db.$disconnect();
  await admin.query("DROP DATABASE " + database + " WITH (FORCE)");
  await admin.end();
}

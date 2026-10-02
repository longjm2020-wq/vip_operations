import "dotenv/config";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createWriteStream, mkdirSync } from "node:fs";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";

const root = new URL(process.env.DATABASE_URL!);
assert.ok(
  ["localhost", "127.0.0.1"].includes(root.hostname),
  "Use a disposable localhost database",
);
const database = "project_library_test_" + Date.now(),
  adminDb = new pg.Client({ connectionString: root.toString() });
await adminDb.connect();
await adminDb.query(`CREATE DATABASE ${database}`);
const isolated = new URL(root);
isolated.pathname = "/" + database;
Object.assign(process.env, {
  DATABASE_URL: isolated.toString(),
  ADMIN_PASSWORD: randomUUID(),
  PORT: "3114",
  APP_ORIGIN: "http://localhost:5174",
  VIP_MODE: "disabled",
  PROJECT_RECYCLE_CLEANUP: "off",
});
const objects = new Map<string, Buffer>();
let unavailable = false;
const store = createServer(async (req, res) => {
  const key = new URL(req.url!, "http://localhost").pathname;
  if (unavailable) {
    res.writeHead(503);
    res.end();
    return;
  }
  if (req.method === "PUT") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    objects.set(key, Buffer.concat(chunks));
    res.writeHead(200);
    res.end();
  } else if (req.method === "DELETE") {
    objects.delete(key);
    res.writeHead(204);
    res.end();
  } else {
    res.writeHead(objects.has(key) ? 200 : 404);
    res.end(objects.get(key));
  }
});
await new Promise<void>((resolve) => store.listen(0, "127.0.0.1", resolve));
Object.assign(process.env, {
  AWS_ENDPOINT_URL: `http://127.0.0.1:${(store.address() as { port: number }).port}`,
  AWS_S3_BUCKET_NAME: "test",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  AWS_DEFAULT_REGION: "auto",
});
await migrate();
const { seed } = await import("../../scripts/seed.js");
await seed();
const { db, rows, one } = await import("../../packages/database/src/index.js");
const { passwordHash } = await import("../../apps/api/src/core.js");
const { purgeExpiredContent, cleanRecycledObjects } =
  await import("../../apps/api/src/modules/projects/recycle.js");
mkdirSync(".local", { recursive: true });
const log = createWriteStream(".local/project-library-api.log");
const child = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "apps/api/src/main.ts"],
  { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.pipe(log);
child.stderr.pipe(log);
type Session = { cookie: string; csrf: string; id: string };
const empty: Session = { cookie: "", csrf: "", id: "" };
const base = "http://127.0.0.1:3114/api/v1";
async function request(
  user: Session,
  path: string,
  method = "GET",
  body?: unknown,
  key: string = randomUUID(),
) {
  const response = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      Cookie: user.cookie,
      Origin: process.env.APP_ORIGIN!,
      "X-CSRF-Token": user.csrf,
      "Idempotency-Key": key,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = response.headers
    .get("content-type")
    ?.includes("application/json")
    ? await response.json()
    : null;
  return { status: response.status, result, response };
}
async function ok(
  user: Session,
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
) {
  const r = await request(user, path, method, body, key);
  assert.ok(r.status < 300, `${path}: ${r.status} ${JSON.stringify(r.result)}`);
  return r.result.data;
}
async function login(username: string) {
  const r = await request(empty, "/auth/login", "POST", {
    username,
    password: process.env.ADMIN_PASSWORD,
  });
  assert.equal(r.status, 200);
  return {
    id: r.result.data.id,
    cookie: r.response.headers.get("set-cookie")!.split(";")[0],
    csrf: r.result.data.csrfToken,
  } as Session;
}
const projectBody = {
  name: "私有协作项目",
  tag: "其他",
  start: "",
  end: "",
  sopIds: [],
  collaborators: [],
  tasks: [],
  requirements: [],
};
let checks = 0;
function pass(label: string) {
  console.log("PASS", label);
  checks++;
}
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(base + "/health")).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const admin = await login("admin");
  const role = await one(
    db,
    "INSERT INTO roles(code,name) VALUES('LIBRARY_USER','运营协作用户') RETURNING id",
  );
  await rows(
    db,
    "INSERT INTO role_permissions(role_id,permission_id) SELECT $1::bigint,id FROM permissions WHERE code=ANY($2::text[])",
    role!.id,
    [
      "project.read",
      "project.create",
      "sop.manage",
      "selection.read",
      "selection.manage",
    ],
  );
  for (const username of ["library-owner", "library-outsider"]) {
    const user = await one(
      db,
      "INSERT INTO users(username,display_name,password_hash) VALUES($1,$1,$2) RETURNING id",
      username,
      passwordHash(process.env.ADMIN_PASSWORD!),
    );
    await rows(
      db,
      "INSERT INTO user_roles(user_id,role_id) VALUES($1::bigint,$2::bigint)",
      user!.id,
      role!.id,
    );
  }
  const owner = await login("library-owner"),
    outsider = await login("library-outsider");
  const sop = await ok(owner, "/projects/sops", "POST", {
    name: "私有SOP",
    department: "运营",
    description: "私有说明",
    steps: [{ id: "plan", name: "计划" }],
  });
  const project = await ok(owner, "/projects", "POST", projectBody);
  const table = await ok(owner, "/project-tables", "POST", {
    name: "私有表格",
  });
  for (const item of [sop, project, table])
    assert.equal(item.visibility, "PRIVATE");
  assert.ok(
    !(await ok(outsider, "/projects/sops")).some(
      (row: any) => row.id === sop.id,
    ),
  );
  assert.ok(
    !(await ok(outsider, "/projects")).some(
      (row: any) => row.id === project.id,
    ),
  );
  assert.equal(
    (await request(outsider, `/projects/${project.id}`)).status,
    403,
  );
  assert.ok(
    !(await ok(outsider, "/project-tables")).some(
      (row: any) => row.id === table.id,
    ),
  );
  for (const path of [
    `/project-tables/${table.id}`,
    `/style-selections?tableId=${table.id}`,
    `/style-selections/sync?tableId=${table.id}`,
    `/style-selections/shared-view?tableId=${table.id}`,
    `/style-selections/presence?tableId=${table.id}`,
  ])
    assert.equal(
      (
        await request(
          outsider,
          path,
          path.includes("/sync") ? "POST" : "GET",
          path.includes("/sync") ? {} : undefined,
        )
      ).status,
      404,
      path,
    );
  pass("默认私有；列表、详情、同步、共享视图及在线协作拒绝旁观者");
  for (const [kind, item] of [
    ["sop", sop],
    ["project", project],
    ["table", table],
  ] as const) {
    assert.equal(
      (
        await request(
          outsider,
          `/project-library/${kind}/${item.id}/visibility`,
          "PATCH",
          { visibility: "PUBLIC", version: item.version },
        )
      ).status,
      403,
    );
    const visible = await ok(
      owner,
      `/project-library/${kind}/${item.id}/visibility`,
      "PATCH",
      { visibility: "PUBLIC", version: item.version },
    );
    item.version = visible.version;
  }
  assert.ok(
    (await ok(outsider, "/projects/sops")).some(
      (row: any) => row.id === sop.id,
    ),
  );
  assert.equal(
    (await ok(outsider, `/projects/${project.id}`)).canCollaborate,
    false,
  );
  assert.equal(
    (
      await request(outsider, `/projects/${project.id}/actions`, "POST", {
        action: "invite",
        users: [outsider.id],
        version: project.version,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(outsider, `/projects/${project.id}/messages`, "POST", {
        body: "旁观者不能发言",
      })
    ).status,
    403,
  );
  assert.equal(
    (await ok(outsider, `/project-tables/${table.id}`)).canManage,
    false,
  );
  assert.equal(
    (await ok(outsider, `/style-selections?tableId=${table.id}`)).length,
    3,
  );
  const stale = await request(
    owner,
    `/project-library/table/${table.id}/visibility`,
    "PATCH",
    { visibility: "PRIVATE", version: 1 },
  );
  assert.equal(stale.status, 409);
  await ok(admin, `/project-library/table/${table.id}/visibility`, "PATCH", {
    visibility: "PRIVATE",
    version: table.version,
  });
  pass(
    "公开内容可按模块权限查看；管理仅限创建者/管理员，公开项目旁观者不能参与协作，旧版本冲突拒绝",
  );
  const { defaultProtection } =
    await import("../../packages/contracts/src/selection-protection.js");
  await ok(admin, `/style-selections/protection?tableId=${table.id}`, "POST", {
    revision: 0,
    settings: {
      ...defaultProtection,
      enabled: true,
      regions: [
        {
          id: randomUUID(),
          name: "指定协作人",
          scope: "sheet",
          rowIds: [],
          columnKeys: [],
          users: { [outsider.id]: "read" },
          others: "deny",
        },
      ],
    },
  });
  assert.equal(
    (await ok(outsider, `/style-selections?tableId=${table.id}`)).length,
    3,
  );
  assert.equal(
    (
      await request(outsider, `/style-selections?tableId=${table.id}`, "POST", {
        material: "绕过保护",
      })
    ).status,
    403,
  );
  await ok(admin, `/style-selections/protection?tableId=${table.id}`, "POST", {
    revision: 1,
    settings: defaultProtection,
  });
  assert.equal(
    (await request(outsider, `/style-selections?tableId=${table.id}`)).status,
    404,
  );
  pass("私有表格指定区域权限仍可访问，撤销授权立即生效");
  const row = await ok(owner, `/style-selections?tableId=${table.id}`, "POST", {
    xutiStyleNo: "LIBRARY-STYLE",
    material: "恢复后保留",
    color: "白",
  });
  const image = await ok(
    owner,
    `/style-selections/images?tableId=${table.id}`,
    "POST",
    { data: "data:image/jpeg;base64,/9j/AA==" },
  );
  await ok(owner, `/style-selections/${row.id}?tableId=${table.id}`, "PATCH", {
    images: [{ id: "photo", url: image.url, color: "白" }],
  });
  const collection = await ok(
    owner,
    `/selection-collections?tableId=${table.id}`,
    "POST",
    { title: "指定外部收集表", ids: [row.id], days: 7 },
  );
  async function external() {
    return fetch(base + "/public/selection-collection", {
      headers: { "X-Collection-Token": collection.token },
    });
  }
  assert.equal((await external()).status, 200);
  for (const [kind, item] of [
    ["sop", sop],
    ["project", project],
    ["table", table],
  ] as const) {
    assert.equal(
      (
        await request(
          outsider,
          `/project-library/${kind}/${item.id}`,
          "DELETE",
          {},
        )
      ).status,
      403,
    );
    const key = randomUUID();
    const deleted = await ok(
      owner,
      `/project-library/${kind}/${item.id}`,
      "DELETE",
      {},
      key,
    );
    assert.deepEqual(
      await ok(owner, `/project-library/${kind}/${item.id}`, "DELETE", {}, key),
      deleted,
    );
    const bin = await ok(owner, `/project-library/trash?kind=${kind}`);
    assert.ok(bin.some((record: any) => record.id === item.id));
    assert.equal(
      Date.parse(deleted.expiresAt) - Date.parse(deleted.deletedAt),
      30 * 86400000,
    );
  }
  assert.equal(
    (await request(admin, `/project-tables/${table.id}`)).status,
    404,
  );
  assert.equal(
    (
      await request(
        owner,
        `/style-selections/images/${image.url.match(/images\/([^?]+)/)[1]}?tableId=${table.id}`,
      )
    ).status,
    404,
  );
  assert.equal((await external()).status, 404);
  assert.equal(
    (await request(admin, `/projects/${project.id}/messages`)).status,
    404,
  );
  assert.equal(
    (await request(outsider, "/project-library/trash?kind=table")).result.data
      .length,
    0,
  );
  for (const [kind, item] of [
    ["sop", sop],
    ["project", project],
    ["table", table],
  ] as const) {
    const bin = await ok(admin, `/project-library/trash?kind=${kind}`);
    const trashed = bin.find((entry: any) => entry.id === item.id);
    await ok(owner, `/project-library/${kind}/${item.id}/restore`, "POST", {
      version: trashed.version,
    });
  }
  assert.equal(
    (await ok(owner, `/style-selections/${row.id}?tableId=${table.id}`))
      .material,
    "恢复后保留",
  );
  assert.equal((await external()).status, 200);
  assert.equal((await ok(owner, `/projects/${project.id}`)).status, "DRAFT");
  pass(
    "回收站按所有权隔离，删除阻止图片/收集链接/消息访问，幂等删除及恢复完整数据",
  );
  const sopAudit = await one(
    db,
    "SELECT id FROM audit_logs WHERE entity_type='sop' AND entity_id=$1::bigint LIMIT 1",
    sop.id,
  );
  assert.ok(sopAudit);
  await assert.rejects(
    () =>
      rows(
        db,
        "UPDATE audit_logs SET after_data=NULL WHERE id=$1::bigint",
        sopAudit.id,
      ),
    /History is immutable/,
  );
  const snapshot = await ok(owner, "/projects", "POST", {
    ...projectBody,
    sopIds: [sop.id],
    collaborators: [outsider.id],
    start: "2026-10-02",
    end: "2026-10-03",
    tasks: [
      {
        id: randomUUID(),
        stage: `${sop.id}:plan`,
        title: "快照任务",
        assignee: owner.id,
        receiver: owner.id,
        start: "2026-10-02",
        end: "2026-10-03",
      },
    ],
  });
  await ok(owner, `/projects/${snapshot.id}/actions`, "POST", {
    action: "publish",
    version: snapshot.version,
  });
  assert.equal(
    (await ok(outsider, `/projects/${snapshot.id}`)).canCollaborate,
    true,
  );
  const fileId = randomUUID(),
    bytes = Buffer.from("项目附件");
  const upload = await ok(owner, "/projects/uploads", "POST", {
    id: fileId,
    name: "说明.txt",
    type: "text/plain",
    size: bytes.length,
    data: `data:text/plain;base64,${bytes.toString("base64")}`,
  });
  const first = await ok(owner, "/projects", "POST", {
    ...projectBody,
    attachments: [upload],
  });
  const second = await ok(owner, "/projects", "POST", {
    ...projectBody,
    attachments: [upload],
  });
  await ok(owner, `/project-library/project/${first.id}`, "DELETE", {});
  await rows(
    db,
    "UPDATE projects SET deleted_at=now()-interval '31 days' WHERE id=$1::bigint",
    first.id,
  );
  assert.equal(
    (
      await request(
        owner,
        `/project-library/project/${first.id}/restore`,
        "POST",
        {},
      )
    ).status,
    410,
  );
  assert.ok(
    !(await ok(owner, "/project-library/trash?kind=project")).some(
      (item: any) => item.id === first.id,
    ),
  );
  assert.equal((await purgeExpiredContent()).project, 1);
  await cleanRecycledObjects();
  assert.equal(
    (await request(owner, `/projects/${second.id}/attachments/${fileId}`))
      .status,
    302,
  );
  assert.ok(objects.has(`/test/${upload.storageKey}`));
  pass("超过30天不可恢复，清理项目保留其他项目共用附件");
  await ok(owner, `/project-library/project/${second.id}`, "DELETE", {});
  assert.equal(
    (await request(owner, `/projects/uploads/${fileId}`)).status,
    404,
  );
  await ok(owner, `/project-library/sop/${sop.id}`, "DELETE", {});
  await ok(owner, `/project-library/table/${table.id}`, "DELETE", {});
  await rows(
    db,
    "UPDATE projects SET deleted_at=now()-interval '30 days' WHERE id=$1::bigint",
    second.id,
  );
  await rows(
    db,
    "UPDATE project_sops SET deleted_at=now()-interval '30 days' WHERE id=$1::bigint",
    sop.id,
  );
  await rows(
    db,
    "UPDATE project_tables SET deleted_at=now()-interval '30 days' WHERE id=$1::bigint",
    table.id,
  );
  await assert.rejects(
    () =>
      rows(
        db,
        "UPDATE audit_logs SET actor_label='改写历史' WHERE id=$1::bigint",
        sopAudit.id,
      ),
    /History is immutable/,
  );
  await assert.rejects(
    () => rows(db, "DELETE FROM audit_logs WHERE id=$1::bigint", sopAudit.id),
    /History is immutable/,
  );
  const purged = await purgeExpiredContent();
  assert.deepEqual(purged, { sop: 1, project: 1, table: 1 });
  assert.equal(
    (await ok(owner, `/projects/${snapshot.id}`)).document.stages[0].name,
    "计划",
  );
  assert.equal(
    (await ok(outsider, `/projects/${snapshot.id}`)).document.tasks[0].title,
    "快照任务",
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*) AS count FROM audit_logs WHERE action<>'LIBRARY_PURGE' AND (selection_table_id=$1::bigint OR (entity_type='sop' AND entity_id=$2::bigint)) AND (before_data IS NOT NULL OR after_data IS NOT NULL OR reason IS NOT NULL)",
        table.id,
        sop.id,
      )
    )?.count,
    0n,
  );
  assert.equal(
    (
      await one(
        db,
        "SELECT count(*) AS count FROM idempotency_records WHERE operation LIKE $1 OR operation='project.message/' || $2",
        `table:${table.id}/%`,
        second.id,
      )
    )?.count,
    0n,
  );
  assert.equal(
    await one(
      db,
      "SELECT 1 FROM pg_namespace WHERE nspname=$1",
      "selection_table_" + table.id,
    ),
    undefined,
  );
  assert.equal(
    await one(
      db,
      "SELECT 1 FROM project_table_collection_tokens WHERE table_id=$1::bigint",
      table.id,
    ),
    undefined,
  );
  assert.equal(
    await one(db, "SELECT 1 FROM project_uploads WHERE id=$1::uuid", fileId),
    undefined,
  );
  assert.equal((await external()).status, 404);
  unavailable = true;
  await assert.rejects(() => cleanRecycledObjects());
  assert.ok(
    (await rows(db, "SELECT storage_key FROM project_library_object_gc"))
      .length >= 2,
  );
  unavailable = false;
  await cleanRecycledObjects();
  assert.equal(objects.size, 0);
  assert.equal(
    (await rows(db, "SELECT storage_key FROM project_library_object_gc"))
      .length,
    0,
  );
  assert.deepEqual(await purgeExpiredContent(), {
    sop: 0,
    project: 0,
    table: 0,
  });
  pass("30天边界自动彻底清理表格隔离数据、令牌、附件和缓存；存储故障可重试");
  console.log(`Project library integration: ${checks} scenarios passed`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const ended = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill();
    await ended;
  }
  log.end();
  await db.$disconnect();
  await new Promise<void>((resolve) => store.close(() => resolve()));
  await adminDb.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await adminDb.end();
}

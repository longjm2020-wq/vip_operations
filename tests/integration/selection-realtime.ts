// Synthetic data in a disposable localhost database. Never targets application data.
import "dotenv/config";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
const root = new URL(process.env.DATABASE_URL!);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(root.hostname));
root.pathname = "/postgres";
const name = "selection_realtime_test_" + Date.now();
const adminDb = new pg.Client({ connectionString: root.toString() });
await adminDb.connect();
await adminDb.query(`CREATE DATABASE ${name}`);
await adminDb.end();
const url = new URL(root);
url.pathname = "/" + name;
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  ADMIN_PASSWORD: randomUUID(),
  SALES_SOURCE: "fixture",
  AWS_S3_BUCKET_NAME: "",
  PORT: "3104",
  APP_ORIGIN: "http://localhost:5174",
});
await migrate();
const { seed } = await import("../../scripts/seed.js");
await seed();
const { db, one, rows } = await import("../../packages/database/src/index.js");
const { passwordHash } = await import("../../apps/api/src/core.js");
const child = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "apps/api/src/main.ts"],
  { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
const log = createWriteStream(".local/selection-realtime-api.log");
child.stdout.pipe(log);
child.stderr.pipe(log);
const base = "http://127.0.0.1:3104/api/v1";
type Session = { cookie: string; csrf: string };
async function request(
  session: Session,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Cookie: session.cookie,
      Origin: process.env.APP_ORIGIN!,
      "X-CSRF-Token": session.csrf,
      "Idempotency-Key": randomUUID(),
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    json: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
  };
}
async function login(username: string, password: string) {
  const result = await request(
    { cookie: "", csrf: "" },
    "/auth/login",
    "POST",
    { username, password },
  );
  assert.equal(result.status, 200);
  return { cookie: result.cookie, csrf: result.json.data.csrfToken } as Session;
}
async function ok(
  session: Session,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const result = await request(session, path, method, body);
  assert.ok(result.status < 300, JSON.stringify(result.json));
  return result.json.data;
}
const streams: AbortController[] = [];
async function stream(session: Session, path = "/style-selections/events") {
  const abort = new AbortController();
  streams.push(abort);
  const response = await fetch(base + path, {
    headers: { Cookie: session.cookie },
    signal: abort.signal,
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") || "",
    /text\/event-stream/,
  );
  const events: { type: string; data: unknown }[] = [];
  const reader = response.body!.getReader();
  const done = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1],
            data = /^data: (.+)$/m.exec(block)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  })();
  const wait = async (type: string, after = 0) => {
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      const event = events.slice(after).find((event) => event.type === type);
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`No ${type} event`);
  };
  await wait("ready");
  return { events, wait, done, abort };
}
let passed = 0;
const check = (name: string) => {
  passed++;
  console.log("PASS", name);
};
try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(base + "/health")).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const admin = await login("admin", process.env.ADMIN_PASSWORD!);
  const password = randomUUID();
  const viewer = await one(
    db,
    "INSERT INTO users(username,display_name,password_hash) VALUES('realtime-viewer','查看者',$1) RETURNING id",
    passwordHash(password),
  );
  const role = await one(
    db,
    "INSERT INTO roles(code,name) VALUES('REALTIME_VIEWER','实时查看测试') RETURNING id",
  );
  await rows(
    db,
    "INSERT INTO role_permissions(role_id,permission_id) SELECT $1::bigint,id FROM permissions WHERE code IN ('selection.read','project.read','product.read')",
    role!.id,
  );
  await rows(
    db,
    "INSERT INTO user_roles(user_id,role_id) VALUES($1::bigint,$2::bigint)",
    viewer!.id,
    role!.id,
  );
  const reader = await login("realtime-viewer", password);
  const live = await stream(reader);
  const row = await ok(admin, "/style-selections", "POST", {
    xutiStyleNo: "REALTIME-ONE",
    material: "public",
  });
  await live.wait("refresh");
  assert.equal(
    (await ok(reader, "/style-selections/sync", "POST", {})).data[0].material,
    "public",
  );
  check("read-only user receives committed changes and reads the saved value");
  assert.equal(
    (
      await request(reader, "/style-selections/" + row.id, "PATCH", {
        material: "forbidden",
        expectedUpdatedAt: row.updatedAt,
      })
    ).status,
    403,
  );
  const policy = await ok(admin, "/style-selections/protection");
  await ok(admin, "/style-selections/protection", "POST", {
    revision: policy.revision,
    settings: {
      enabled: true,
      claimsEnabled: false,
      autoHide: false,
      hiddenReaders: [],
      regions: [
        {
          id: randomUUID(),
          name: "secret",
          scope: "columns",
          rowIds: [],
          columnKeys: ["material"],
          users: {},
          others: "deny",
        },
      ],
    },
  });
  const protectedRow = await ok(admin, "/style-selections/" + row.id);
  const after = live.events.length;
  await ok(admin, "/style-selections/" + row.id, "PATCH", {
    material: "DO-NOT-BROADCAST",
    expectedUpdatedAt: protectedRow.updatedAt,
  });
  await live.wait("refresh", after);
  const projected = (await ok(reader, "/style-selections/sync", "POST", {}))
    .data[0];
  assert.equal(projected.material, null);
  assert.equal(projected.cellAccess.material, "deny");
  assert.ok(!JSON.stringify(live.events).includes("DO-NOT-BROADCAST"));
  assert.ok(!JSON.stringify(projected).includes("DO-NOT-BROADCAST"));
  check(
    "forbidden cell content is absent from both events and synchronized rows",
  );
  const first = await ok(admin, "/project-tables", "POST", {
    name: "Realtime public",
    visibility: "PUBLIC",
  });
  const second = await ok(admin, "/project-tables", "POST", {
    name: "Realtime other",
    visibility: "PUBLIC",
  });
  const scoped = await stream(
    reader,
    `/style-selections/events?tableId=${first.id}`,
  );
  await ok(admin, `/style-selections?tableId=${second.id}`, "POST", {
    xutiStyleNo: "OTHER-TABLE",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    scoped.events.filter((event) => event.type === "refresh").length,
    0,
  );
  await ok(admin, `/style-selections?tableId=${first.id}`, "POST", {
    xutiStyleNo: "THIS-TABLE",
  });
  await scoped.wait("refresh");
  check(
    "new tables get triggers and notifications stay in the correct workspace",
  );
  const revoked = scoped.events.length;
  await rows(
    db,
    "UPDATE project_tables SET visibility='PRIVATE' WHERE id=$1::bigint",
    first.id,
  );
  await scoped.wait("access-revoked", revoked);
  await scoped.done;
  assert.equal(
    (
      await fetch(base + `/style-selections/events?tableId=${first.id}`, {
        headers: { Cookie: reader.cookie },
      })
    ).status,
    404,
  );
  check("revoking table access closes the live stream and blocks reconnection");
  const pgListener = new pg.Client({ connectionString: url.toString() });
  await pgListener.connect();
  const notifications: string[] = [];
  pgListener.on("notification", (message) =>
    notifications.push(message.payload || ""),
  );
  await pgListener.query("LISTEN selection_changes");
  const writer = new pg.Client({ connectionString: url.toString() });
  await writer.connect();
  await writer.query("BEGIN");
  await writer.query(
    "UPDATE public.style_selections SET material='rolled back' WHERE id=$1",
    [row.id],
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(notifications.length, 0);
  await writer.query("ROLLBACK");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(notifications.length, 0);
  await writer.query("BEGIN");
  await writer.query(
    "UPDATE public.style_selections SET material='committed' WHERE id=$1",
    [row.id],
  );
  await writer.query("COMMIT");
  for (let i = 0; i < 100 && !notifications.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(notifications.length, 1);
  assert.deepEqual(JSON.parse(notifications[0]), {
    tableId: "",
    kind: "records",
  });
  await pgListener.end();
  await writer.end();
  check(
    "rollback emits nothing and commit emits only a content-free invalidation",
  );
  const archive = await ok(admin, "/product-archive-table");
  const archiveLive = await stream(
    reader,
    `/style-selections/events?tableId=${archive.id}`,
  );
  const category = await one(
    db,
    "INSERT INTO categories(code,name) VALUES('REALTIME-CATEGORY','synthetic category') RETURNING id",
  );
  await rows(
    db,
    "INSERT INTO products(style_no,name,category_id) VALUES('REALTIME-PRODUCT','synthetic product',$1::bigint)",
    category!.id,
  );
  await archiveLive.wait("refresh");
  check("product mirror changes notify the product archive workspace");
  const before = live.events.length;
  await rows(
    db,
    "DELETE FROM role_permissions WHERE role_id=$1::bigint AND permission_id=(SELECT id FROM permissions WHERE code='selection.read')",
    role!.id,
  );
  await live.wait("access-revoked", before);
  await live.done;
  assert.equal(
    (
      await fetch(base + "/style-selections/events", {
        headers: { Cookie: reader.cookie },
      })
    ).status,
    403,
  );
  check("revoked module permissions terminate existing streams");
  console.log(`Passed ${passed} realtime integration scenarios`);
} finally {
  for (const stream of streams) stream.abort();
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  log.end();
  await db.$disconnect();
  const cleanup = new pg.Client({ connectionString: root.toString() });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await cleanup.end();
}

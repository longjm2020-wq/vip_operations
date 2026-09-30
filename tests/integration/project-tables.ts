// Disposable localhost database; never use the application DATABASE_URL.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
const root = "postgresql://postgres@127.0.0.1:55433/postgres",
  name = "project_tables_test_" + Date.now();
const adminDb = new pg.Client({ connectionString: root });
await adminDb.connect();
await adminDb.query(`CREATE DATABASE ${name}`);
await adminDb.end();
const url = new URL(root);
url.pathname = "/" + name;
process.env.DATABASE_URL = url.toString();
process.env.ADMIN_PASSWORD = "test-" + randomUUID();
process.env.SALES_SOURCE = "fixture";
process.env.AWS_S3_BUCKET_NAME = "";
process.env.PORT = "3102";
process.env.APP_ORIGIN = "http://localhost:5174";
await migrate();
const { seed } = await import("../../scripts/seed.js");
await seed();
const { db, one, rows } = await import("../../packages/database/src/index.js");
const { passwordHash } = await import("../../apps/api/src/core.js");
const { defaultProtection } =
  await import("../../packages/contracts/src/selection-protection.js");
const child = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "apps/api/src/main.ts"],
  { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
const log = createWriteStream(".local/project-tables-api.log");
child.stdout.pipe(log);
child.stderr.pipe(log);
const base = "http://127.0.0.1:3102/api/v1";
type Session = { cookie: string; csrf: string };
let session: Session = { cookie: "", csrf: "" };
let passed = 0;
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  key: string = randomUUID(),
  user = session,
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: user.cookie,
      Origin: process.env.APP_ORIGIN!,
      "X-CSRF-Token": user.csrf,
      "Idempotency-Key": key,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result =
    response.status === 204
      ? null
      : response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : await response.arrayBuffer();
  return { status: response.status, result, response };
}
async function ok(path: string, method = "GET", body?: unknown, key?: string) {
  const r = await request(path, method, body, key);
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.result));
  return r.result.data;
}
async function login(username: string, password: string): Promise<Session> {
  const r = await request("/auth/login", "POST", { username, password });
  assert.equal(r.status, 200, JSON.stringify(r.result));
  return {
    cookie: r.response.headers.get("set-cookie")!.split(";")[0],
    csrf: r.result.data.csrfToken,
  };
}
function check(label: string) {
  passed++;
  console.log("PASS", label);
}
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(base + "/health")).ok) break;
    } catch {}
    if (child.exitCode !== null)
      throw Error("API exited; see .local/project-tables-api.log");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  session = await login("admin", process.env.ADMIN_PASSWORD!);
  const original = await ok("/style-selections", "POST", {
    xutiStyleNo: "SAME-STYLE",
  });
  const key = randomUUID();
  const a = await ok("/project-tables", "POST", { name: "项目 A" }, key),
    aAgain = await ok("/project-tables", "POST", { name: "项目 A" }, key);
  assert.equal(a.id, aAgain.id);
  const b = await ok("/project-tables", "POST", { name: "项目 B" });
  const path = (table: any, endpoint = "") =>
    `/style-selections${endpoint}${endpoint.includes("?") ? "&" : "?"}tableId=${table.id}`;
  assert.equal((await ok(path(a))).length, 0);
  assert.equal((await ok(path(b))).length, 0);
  assert.equal((await ok("/project-tables")).length, 2);
  assert.equal((await ok(`/project-tables/${a.id}`)).name, "项目 A");
  check(
    "new tables are empty, named, discoverable and creation retries are idempotent",
  );
  const sharedKey = randomUUID();
  const first = await ok(
      path(a),
      "POST",
      { xutiStyleNo: "SAME-STYLE", material: "TABLE-A" },
      sharedKey,
    ),
    second = await ok(
      path(b),
      "POST",
      { xutiStyleNo: "SAME-STYLE", material: "TABLE-B" },
      sharedKey,
    );
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.id, original.id);
  assert.equal(
    (await request(path(a), "POST", { xutiStyleNo: "SAME-STYLE" })).status,
    400,
  );
  assert.equal((await request(path(a, "/" + second.id))).status, 404);
  assert.equal(
    (await request(path(a, "/" + second.id), "PATCH", { material: "bypass" }))
      .status,
    404,
  );
  assert.equal((await request(path(a, "/" + second.id), "DELETE")).status, 404);
  assert.equal((await ok("/style-selections")).length, 1);
  const snapshots = await Promise.all([
    ok(path(a, "/sync"), "POST", {}),
    ok(path(b, "/sync"), "POST", {}),
  ]);
  assert.equal(snapshots[0].data[0].material, "TABLE-A");
  assert.equal(snapshots[1].data[0].material, "TABLE-B");
  const counts = await ok(path(a, "/style-counts"));
  assert.ok(JSON.stringify(counts).includes("SAME-STYLE"));
  const preview = await ok(path(a, "/import/preview"), "POST", {
    rows: [{ xutiStyleNo: "B-ONLY" }],
  });
  assert.ok(preview);
  const imported = await ok(path(a, "/import"), "POST", { rows: preview.rows });
  assert.equal(imported.created, 1);
  assert.equal((await ok(path(b))).length, 1);
  check(
    "row IDs, duplicate guards, idempotency, direct writes and concurrent sync stay in the requested table",
  );
  await ok(path(a, "/shared-view"), "POST", {
    revision: 0,
    view: { filters: { material: { values: ["TABLE-A"] } }, sort: null },
  });
  assert.equal((await ok(path(b, "/shared-view"))).revision, 0);
  await ok(path(a, "/presence"), "POST", {
    editingId: first.id,
    editingColumn: "material",
  });
  assert.equal((await ok(path(a, "/presence"))).length, 1);
  assert.equal((await ok(path(b, "/presence"))).length, 0);
  const policy = {
    ...defaultProtection,
    enabled: true,
    regions: [
      {
        id: randomUUID(),
        name: "本表只读",
        scope: "sheet",
        rowIds: [],
        columnKeys: [],
        users: {},
        others: "read",
      },
    ],
  };
  await ok(path(a, "/protection"), "POST", { revision: 0, settings: policy });
  assert.equal((await ok(path(b, "/protection"))).settings.enabled, false);
  check(
    "shared filters, collaborator presence and protection settings are independent",
  );
  const image = await ok(path(a, "/images"), "POST", {
    data: "data:image/jpeg;base64,/9j/AA==",
  });
  assert.ok(image.url.endsWith(`?tableId=${a.id}`));
  await ok(path(a, "/" + first.id), "PATCH", {
    images: [{ id: "photo", url: image.url, color: "白" }],
    color: "白",
  });
  const imageId = image.url.match(/images\/([^?]+)/)![1];
  assert.equal((await request(path(a, "/images/" + imageId))).status, 200);
  assert.equal((await request(path(b, "/images/" + imageId))).status, 404);
  const share = await ok(`/selection-collections?tableId=${a.id}`, "POST", {
    title: "A 收集表",
    ids: [first.id],
    days: 7,
  });
  const token = share.token;
  const response = await fetch(
    base + "/public/selection-collection?tableId=" + b.id,
    { headers: { "X-Collection-Token": token } },
  );
  const external = await response.json();
  assert.equal(response.status, 200, JSON.stringify(external));
  assert.equal(external.data.items[0].xutiStyleNo, "SAME-STYLE");
  assert.equal((await ok(`/selection-collections?tableId=${b.id}`)).length, 0);
  assert.equal(
    (await request(`/selection-collections/${share.id}?tableId=${b.id}`))
      .status,
    404,
  );
  const publicImage = await fetch(
    base + `/public/selection-collection/${first.id}/images/photo`,
    { headers: { "X-Collection-Token": token } },
  );
  assert.equal(publicImage.status, 200);
  const renewed = await ok(
    `/selection-collections/${share.id}/review?tableId=${a.id}`,
    "POST",
    { action: "renew", revision: 0, days: 7 },
  );
  assert.equal(
    (
      await fetch(base + "/public/selection-collection", {
        headers: { "X-Collection-Token": token },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(base + "/public/selection-collection", {
        headers: { "X-Collection-Token": renewed.token },
      })
    ).status,
    200,
  );
  check(
    "uploads, image access and anonymous collection tokens resolve their source table",
  );
  const password = randomUUID();
  const buyer = await one(
    db,
    "INSERT INTO users(username,display_name,password_hash) VALUES('table-buyer','协作者',$1) RETURNING id",
    passwordHash(password),
  );
  await rows(
    db,
    "INSERT INTO user_roles(user_id,role_id) SELECT $1::bigint,id FROM roles WHERE code='BUYER'",
    buyer!.id,
  );
  const operator = await login("table-buyer", password);
  const denied = await request(
    path(a, "/" + first.id),
    "PATCH",
    { material: "forbidden" },
    randomUUID(),
    operator,
  );
  assert.equal(denied.status, 403);
  assert.equal(
    (
      await request(
        path(b, "/" + second.id),
        "PATCH",
        { material: "allowed" },
        randomUUID(),
        operator,
      )
    ).status,
    200,
  );
  for (const table of [a, b]) {
    const current = await ok(path(table, "/protection"));
    await ok(path(table, "/protection"), "POST", {
      revision: current.revision,
      settings: { ...defaultProtection, claimsEnabled: true },
    });
  }
  const claims = await Promise.all([
    request(
      path(a, "/" + first.id + "/claim"),
      "POST",
      { action: "claim" },
      randomUUID(),
      operator,
    ),
    request(
      path(b, "/" + second.id + "/claim"),
      "POST",
      { action: "claim" },
      randomUUID(),
      operator,
    ),
  ]);
  assert.ok(
    claims.every((value) => value.status === 201),
    JSON.stringify(claims.map((value) => value.result)),
  );
  check(
    "imports and token rotation stay scoped; a collaborator can claim one row in each table",
  );
  const readonly = await one(
    db,
    "INSERT INTO users(username,display_name,password_hash) VALUES('table-reader','只读',$1) RETURNING id",
    passwordHash(password),
  );
  await rows(
    db,
    "INSERT INTO user_roles(user_id,role_id) SELECT $1::bigint,id FROM roles WHERE code='ANALYST'",
    readonly!.id,
  );
  const reader = await login("table-reader", password);
  assert.equal(
    (
      await request(
        "/project-tables",
        "POST",
        { name: "bypass" },
        randomUUID(),
        reader,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("/project-tables", "GET", undefined, randomUUID(), reader))
      .status,
    200,
  );
  assert.equal((await request(path({ id: "999999" }))).status, 404);
  assert.equal(
    (await request("/style-selections?tableId=1%3BDROP%20TABLE%20users"))
      .status,
    400,
  );
  const orphan = await one(
    db,
    "INSERT INTO project_tables(name,created_by) SELECT 'unavailable workspace',id FROM users WHERE username='admin' RETURNING id",
  );
  assert.equal((await request(path(orphan))).status, 404);
  check(
    "inherited account and regional permissions enforce read-only access; invalid or missing workspaces fail closed",
  );
  console.log(`Passed ${passed} project table integration scenarios`);
} finally {
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  log.end();
  await db.$disconnect();
  const cleanup = new pg.Client({ connectionString: root });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await cleanup.end();
}

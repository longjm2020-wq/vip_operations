import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";

const url = new URL(process.env.DATABASE_URL!);
if (!["localhost", "127.0.0.1"].includes(url.hostname))
  throw Error("Local disposable database required");
const databaseName = "vip_control_test_" + Date.now();
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query("CREATE DATABASE " + databaseName);
url.pathname = "/" + databaseName;
process.env.DATABASE_URL = url.toString();
process.env.ADMIN_PASSWORD = "test-" + randomUUID();
process.env.ADMIN_USERNAME = "admin";
process.env.APP_ORIGIN = "http://localhost:5192";
process.env.PORT = "3192";
process.env.VIP_MODE = "disabled";
const base = "http://127.0.0.1:3192/api/v1";
await mkdir(".local", { recursive: true });
const log = createWriteStream(".local/vip-control-api.log");
let child: ReturnType<typeof spawn> | undefined;
let disconnect: (() => Promise<void>) | undefined;
let cookie = "",
  csrf = "";
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  key = randomUUID(),
  headers: Record<string, string> = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: process.env.APP_ORIGIN!,
      "X-CSRF-Token": csrf,
      "Idempotency-Key": key,
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
  };
}
try {
  await migrate();
  const { seed } = await import("../../scripts/seed.js");
  await seed();
  const { db, rows, one } =
    await import("../../packages/database/src/index.js");
  disconnect = () => db.$disconnect();
  await rows(
    db,
    "INSERT INTO vop_connections(namespace,vendor_id,token_cipher,token_expires_at) VALUES('a',1,'fixture-only',now()) RETURNING namespace",
  );
  child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/main.ts"], {
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  for (let i = 0; i < 60; i++) {
    if (
      await fetch(base + "/health")
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(
    (await request("/integrations/vip/control?namespace=a")).status,
    401,
  );
  const login = await request("/auth/login", "POST", {
    username: "admin",
    password: process.env.ADMIN_PASSWORD,
  });
  assert.equal(login.status, 200);
  cookie = login.cookie;
  csrf = login.data.data.csrfToken;
  const record = {
    productId: "000692201234567890123",
    productName: "测试商品",
    platformSpu: "SPU-1",
    articleNo: "0012301",
    styleNo: "00123",
    color: "白",
    productStatus: "商品上线",
    issueType: null,
    lastOffShelfReason: "站内价高管控",
  };
  const input = {
    namespace: "a",
    fileName: "fixture.xlsx",
    exportedAt: "2026-10-31T14:32:42+08:00",
    rows: [record],
  };
  assert.equal(
    (
      await request(
        "/integrations/vip/control/import",
        "POST",
        input,
        randomUUID(),
        { "X-CSRF-Token": "invalid" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/integrations/vip/control/import", "POST", {
        ...input,
        rows: [record, record],
      })
    ).status,
    400,
  );
  const key = randomUUID();
  assert.equal(
    (await request("/integrations/vip/control/import", "POST", input, key)).data
      .data.saved,
    1,
  );
  assert.equal(
    (await request("/integrations/vip/control/import", "POST", input, key)).data
      .data.saved,
    1,
  );
  assert.equal(
    Number(
      (await one(
        db,
        "SELECT count(*) AS count FROM audit_logs WHERE action='VIP_CONTROL_IMPORT'",
      ))!.count,
    ),
    1,
  );
  const list = await request("/integrations/vip/control?namespace=a");
  assert.equal(list.data.data.total, 1);
  assert.equal(list.data.data.items[0].issueType, null);
  assert.equal(
    list.data.data.items[0].lastOffShelfReason,
    record.lastOffShelfReason,
  );
  assert.equal(list.data.data.items[0].productId, record.productId);
  assert.equal(JSON.stringify(list.data).includes("fixture-only"), false);
  assert.equal(list.data.data.items[0].exportedAt, "2026-10-31T06:32:42.000Z");
  assert.equal(
    (
      await request("/integrations/vip/control/import", "POST", {
        ...input,
        exportedAt: "2026-10-31T06:32:42Z",
      })
    ).data.data.unchanged,
    1,
  );
  assert.equal(
    (
      await request("/integrations/vip/control/import", "POST", {
        ...input,
        rows: [{ ...record, issueType: "价格问题" }],
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/integrations/vip/control/import", "POST", {
        ...input,
        exportedAt: "2026-10-30T00:00:00Z",
      })
    ).data.data.stale,
    1,
  );
  assert.equal(
    (
      await request("/integrations/vip/control/import", "POST", {
        ...input,
        exportedAt: "2026-10-31T15:32:42+08:00",
        rows: [{ ...record, lastOffShelfReason: null }],
      })
    ).data.data.saved,
    1,
  );
  assert.equal(
    (await request("/integrations/vip/control?namespace=a")).data.data.items[0]
      .lastOffShelfReason,
    null,
  );
  await rows(
    db,
    "DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code='vip.settings') RETURNING role_id",
  );
  assert.equal(
    (await request("/integrations/vip/control?namespace=a")).status,
    403,
  );
  assert.equal(
    (await request("/integrations/vip/control/import", "POST", input)).status,
    403,
  );
  console.log(
    "PASS VC import HTTP: authentication, permissions, CSRF, validation, idempotency, audit, raw fields, conflicts and stale exports",
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => {
      child!.once("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }
  log.end();
  await disconnect?.();
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
    [databaseName],
  );
  await admin.query("DROP DATABASE " + databaseName);
  await admin.end();
}

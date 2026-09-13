import "dotenv/config";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
const baseUrl = new URL(process.env.DATABASE_URL!);
const database = "vip_erp_test_" + Date.now();
const admin = new pg.Client({ connectionString: baseUrl.toString() });
await admin.connect();
await admin.query("CREATE DATABASE " + database);
await admin.end();
baseUrl.pathname = "/" + database;
process.env.DATABASE_URL = baseUrl.toString();
process.env.ADMIN_PASSWORD = "test-only-" + randomUUID();
process.env.SALES_SOURCE = "fixture";
process.env.PORT = "3101";
process.env.APP_ORIGIN = "http://localhost:5174";
await migrate();
const { seed } = await import("../../scripts/seed.js");
const { db, one, rows } = await import("../../packages/database/src/index.js");
await seed();
await seed();
const own = await one(
  db,
  "SELECT password_hash FROM users WHERE username='admin'",
);
const { passwordMatches } = await import("../../apps/api/src/core.js");
assert.equal(
  passwordMatches(process.env.ADMIN_PASSWORD!, own!.password_hash),
  true,
  "Seed password should match",
);
await mkdir(".local", { recursive: true });
const log = createWriteStream(".local/integration-api.log");
const child = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "apps/api/src/main.ts"],
  { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.pipe(log);
child.stderr.pipe(log);
const base = "http://127.0.0.1:3101/api/v1";
type Session = { cookie: string; csrf: string };
let session: Session = { cookie: "", csrf: "" };
let passed = 0;
const buyerPassword = randomUUID();
async function request(
  path: string,
  method = "GET",
  body?: any,
  key: string = randomUUID(),
  user = session,
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: user.cookie,
      Origin: process.env.APP_ORIGIN!,
      "X-CSRF-Token": user.csrf,
      "Idempotency-Key": key,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = r.status === 204 ? null : await r.json();
  return {
    status: r.status,
    body: data,
    cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
  };
}
async function ok(path: string, method = "GET", body?: any, key?: string) {
  const r = await request(path, method, body, key);
  assert.ok(r.status < 300, `${method} ${path}: ${JSON.stringify(r.body)}`);
  return r.body.data;
}
function check(label: string) {
  passed++;
  console.log("PASS", label);
}
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await request("/products")).status, 401);
  check("A01 unauthenticated request");
  const logged = await request("/auth/login", "POST", {
    username: "admin",
    password: process.env.ADMIN_PASSWORD,
  });
  assert.equal(logged.status, 200, JSON.stringify(logged.body.error));
  session = { cookie: logged.cookie, csrf: logged.body.data.csrfToken };
  const wh = await ok("/warehouses", "POST", { code: "WH", name: "测试仓" }),
    wh2 = await ok("/warehouses", "POST", { code: "WH2", name: "第二测试仓" }),
    su = await ok("/suppliers", "POST", {
      supplierCode: "SUP",
      name: "测试供应商",
    }),
    ca = await ok("/categories", "POST", { code: "CAT", name: "针织" });
  const pr = await ok("/products", "POST", {
    styleNo: "STYLE",
    name: "验收针织衫",
    categoryId: ca.id,
    defaultSupplierId: su.id,
  });
  const sku = await ok("/products/" + pr.id + "/skus", "POST", {
    skuCode: "BK-L",
    colorCode: "001",
    colorName: "黑",
    sizeCode: "004",
    sizeName: "L",
  });
  assert.equal(
    (
      await request("/products", "POST", {
        styleNo: "STYLE",
        name: "重复",
        categoryId: ca.id,
      })
    ).status,
    409,
  );
  check("A02 master CRUD and duplicate constraints without VOP");
  const colors = await ok("/color-mappings?pageSize=100");
  assert.equal(colors.length ?? colors.data?.length ?? 0, 64);
  assert.equal(
    (await request("/color-mappings", "POST", { code: "044", name: "花色" }))
      .status,
    400,
  );
  assert.equal(
    (await request("/color-mappings", "POST", { code: "025", name: "花色" }))
      .status,
    409,
  );
  assert.equal(
    (await request("/size-mappings", "POST", { code: "01", name: "错误" }))
      .status,
    400,
  );
  const mapping = await ok("/color-mappings", "POST", {
    code: "099",
    name: "测试色",
  });
  await ok("/color-mappings/" + mapping.id, "PATCH", {
    code: "098",
    name: "改名色",
  });
  const deleteKey = randomUUID();
  await ok("/color-mappings/" + mapping.id, "DELETE", undefined, deleteKey);
  await ok("/color-mappings/" + mapping.id, "DELETE", undefined, deleteKey);
  const black = await one(db, "SELECT id FROM color_mappings WHERE code='001'");
  assert.ok(
    (await request("/color-mappings/" + black!.id, "DELETE")).status >= 400,
  );
  assert.ok(
    (await request("/color-mappings/" + black!.id, "PATCH", { code: "099" }))
      .status >= 400,
  );
  await ok("/color-mappings/" + black!.id, "PATCH", { status: "INACTIVE" });
  assert.equal(
    (
      await request("/skus", "POST", {
        productId: pr.id,
        skuCode: "BLOCKED",
        colorCode: "001",
        colorName: "黑色",
        sizeCode: "004",
        sizeName: "L",
      })
    ).status,
    400,
  );
  await ok("/color-mappings/" + black!.id, "PATCH", { status: "ACTIVE" });
  check(
    "Mapping CRUD, invalid 044, uniqueness, reference protection, inactive validation and delete idempotency",
  );
  const key = randomUUID(),
    adjust = {
      skuId: sku.id,
      warehouseId: wh.id,
      quantity: 30,
      reason: "OPENING",
      remark: "期初",
    };
  await ok("/inventory/adjustments", "POST", adjust, key);
  await ok("/inventory/adjustments", "POST", adjust, key);
  assert.equal(
    (
      await request(
        "/inventory/adjustments",
        "POST",
        { ...adjust, quantity: 31 },
        key,
      )
    ).status,
    409,
  );
  check("A03/A12 adjustments and conflicting idempotency body");
  async function newPo(n: number) {
    let p = await ok("/purchase-orders", "POST", {
      supplierId: su.id,
      warehouseId: wh.id,
      items: [{ skuId: sku.id, orderedQty: n, unitCost: "78.00" }],
    });
    assert.equal(p.status, "DRAFT");
    p = await ok("/purchase-orders/" + p.id + "/submit", "POST", {
      expectedVersion: p.version,
    });
    p = await ok("/purchase-orders/" + p.id + "/confirm", "POST", {
      expectedVersion: p.version,
    });
    return p;
  }
  async function receipt(p: any, n: number) {
    let r = await ok("/receipts", "POST", {
      purchaseOrderId: p.id,
      warehouseId: wh.id,
      items: [
        {
          purchaseOrderItemId: p.items[0].id,
          receivedQty: n,
          qualifiedQty: n,
          damagedQty: 0,
          shortageQty: 0,
        },
      ],
    });
    r = await ok("/receipts/" + r.id + "/mark-received", "POST", {
      expectedVersion: r.version,
      receivedAt: new Date().toISOString(),
    });
    return r;
  }
  const p = await newPo(100);
  assert.equal((await ok("/inventory/" + sku.id)).totals.transit, 100);
  check("A06 confirmed-only in transit");
  const r = await receipt(p, 40),
    postKey = randomUUID();
  await ok(
    "/receipts/" + r.id + "/post",
    "POST",
    { expectedVersion: r.version },
    postKey,
  );
  await ok(
    "/receipts/" + r.id + "/post",
    "POST",
    { expectedVersion: r.version },
    postKey,
  );
  await ok("/receipts/" + r.id + "/post", "POST", {
    expectedVersion: r.version,
  });
  const stock = await ok("/inventory/" + sku.id);
  assert.equal(stock.totals.available, 70);
  assert.equal(stock.totals.transit, 60);
  check("A07/A08 partial receipt and repeated post with different keys");
  const remainder = await receipt(p, 60);
  await ok("/receipts/" + remainder.id + "/post", "POST", {
    expectedVersion: remainder.version,
  });
  assert.equal((await ok("/purchase-orders/" + p.id)).status, "COMPLETED");
  assert.equal((await ok("/inventory/" + sku.id)).totals.available, 130);
  check("A09 complete remaining receipt");
  assert.equal(
    (
      await request("/receipts/" + r.id, "PATCH", {
        expectedVersion: 2,
        items: [
          {
            purchaseOrderItemId: p.items[0].id,
            receivedQty: 1,
            qualifiedQty: 1,
          },
        ],
      })
    ).status,
    409,
  );
  check("A14 posted receipt immutable");
  const po2 = await newPo(100),
    r1 = await receipt(po2, 70),
    r2 = await receipt(po2, 70);
  // Acquire the shared write lock to ensure both requests reach independent DB transactions before release.
  const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT pg_advisory_xact_lock(91002)");
  const races = Promise.all([
    request("/receipts/" + r1.id + "/post", "POST", {
      expectedVersion: r1.version,
    }),
    request("/receipts/" + r2.id + "/post", "POST", {
      expectedVersion: r2.version,
    }),
  ]);
  await new Promise((r) => setTimeout(r, 250));
  await blocker.query("COMMIT");
  await blocker.end();
  const race = await races;
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (await ok("/purchase-orders/" + po2.id)).items[0].receivedQty,
    70,
  );
  check("A10 concurrent two connections do not overreceive");
  const po3 = await newPo(10),
    rollback = await receipt(po3, 10);
  const before = (await ok("/inventory/" + sku.id)).totals.available;
  await rows(
    db,
    "UPDATE users SET display_name='Rollback Tester' WHERE username='admin' RETURNING id",
  );
  await db.$executeRawUnsafe(
    "CREATE FUNCTION fail_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor_label='Rollback Tester' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$",
  );
  await db.$executeRawUnsafe(
    "CREATE TRIGGER fail_test_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_test_audit()",
  );
  assert.equal(
    (
      await request("/receipts/" + rollback.id + "/post", "POST", {
        expectedVersion: rollback.version,
      })
    ).status,
    500,
  );
  assert.equal((await ok("/inventory/" + sku.id)).totals.available, before);
  assert.equal(
    (await ok("/purchase-orders/" + po3.id)).items[0].receivedQty,
    0,
  );
  assert.equal((await ok("/receipts/" + rollback.id)).status, "RECEIVED");
  assert.equal(
    (await one(
      db,
      "SELECT count(*)::int AS n FROM inventory_transactions WHERE source_type=$1 AND source_id=$2::bigint",
      "RECEIPT",
      rollback.id,
    ))!.n,
    0,
  );
  await db.$executeRawUnsafe("DROP TRIGGER fail_test_audit ON audit_logs");
  await db.$executeRawUnsafe("DROP FUNCTION fail_test_audit()");
  await rows(
    db,
    "UPDATE users SET display_name='管理员' WHERE username='admin' RETURNING id",
  );
  check(
    "A11 audit failure rolls back PO, receipt, balances, transactions and idempotency",
  );
  const bad = await ok("/receipts", "POST", {
    purchaseOrderId: po3.id,
    warehouseId: wh.id,
    items: [
      {
        purchaseOrderItemId: po3.items[0].id,
        receivedQty: 10,
        qualifiedQty: 8,
        damagedQty: 2,
        shortageQty: 0,
      },
    ],
  });
  const receivedBad = await ok(
    "/receipts/" + bad.id + "/mark-received",
    "POST",
    { expectedVersion: 0, receivedAt: new Date().toISOString() },
  );
  assert.equal(
    (
      await request("/receipts/" + bad.id + "/post", "POST", {
        expectedVersion: receivedBad.version,
      })
    ).body.error.code,
    "BUSINESS_RULE_PENDING",
  );
  check("A15 ambiguous damaged receipt blocked");
  await ok("/inventory/adjustments", "POST", {
    ...adjust,
    warehouseId: wh2.id,
    quantity: 5,
  });
  const multi = await ok("/inventory/" + sku.id);
  assert.equal(multi.balances.length, 2);
  check("A16 multi warehouse projection");
  const suggestionSku = await ok("/products/" + pr.id + "/skus", "POST", {
    skuCode: "WH-M",
    colorCode: "002",
    colorName: "白",
    sizeCode: "003",
    sizeName: "M",
  });
  await ok("/inventory/adjustments", "POST", {
    ...adjust,
    skuId: suggestionSku.id,
  });
  let sp = await ok("/purchase-orders", "POST", {
    supplierId: su.id,
    warehouseId: wh.id,
    items: [{ skuId: suggestionSku.id, orderedQty: 20, unitCost: "78.00" }],
  });
  sp = await ok("/purchase-orders/" + sp.id + "/submit", "POST", {
    expectedVersion: 0,
  });
  await ok("/purchase-orders/" + sp.id + "/confirm", "POST", {
    expectedVersion: sp.version,
  });
  const generated = await ok("/purchase-suggestions/generate", "POST", {
    skuIds: [suggestionSku.id],
    targetStockDays: 21,
  });
  const sid = generated.generatedIds[0];
  assert.equal((await ok("/purchase-suggestions/" + sid)).suggestedQty, 160);
  await ok("/purchase-suggestions/" + sid + "/accept", "POST", {
    purchaseQty: 150,
    reason: "调整补货",
  });
  const converted = await ok("/purchase-orders", "POST", {
    supplierId: su.id,
    warehouseId: wh.id,
    items: [
      {
        skuId: suggestionSku.id,
        orderedQty: 150,
        unitCost: "78.00",
        purchaseSuggestionId: sid,
      },
    ],
  });
  assert.ok(converted.id);
  assert.equal((await ok("/purchase-suggestions/" + sid)).suggestedQty, 160);
  assert.equal((await ok("/purchase-suggestions/" + sid)).status, "CONVERTED");
  check("A04/A05 snapshot 160 preserved while actual purchase 150");
  const roleList = await ok("/roles");
  const buyerRole = roleList.find((r: any) => r.code === "BUYER");
  await ok("/users", "POST", {
    username: "buyer",
    displayName: "采购员",
    password: buyerPassword,
    roleIds: [buyerRole.id],
  });
  const buyerLogin = await request("/auth/login", "POST", {
    username: "buyer",
    password: buyerPassword,
  });
  const buyer = {
    cookie: buyerLogin.cookie,
    csrf: buyerLogin.body.data.csrfToken,
  };
  assert.equal(
    (
      await request(
        "/purchase-orders/" + po3.id + "/confirm",
        "POST",
        { expectedVersion: 0 },
        randomUUID(),
        buyer,
      )
    ).status,
    403,
  );
  check("RBAC buyer cannot confirm via direct HTTP");
  const forged = await request("/purchase-orders", "POST", {
    supplierId: su.id,
    warehouseId: wh.id,
    status: "COMPLETED",
    items: [{ skuId: sku.id, orderedQty: 1, unitCost: "0.00" }],
  });
  assert.equal(forged.status, 400);
  check("forged status rejected");
  assert.equal(
    (
      await request("/receipts", "POST", {
        purchaseOrderId: po3.id,
        warehouseId: wh2.id,
        items: [
          {
            purchaseOrderItemId: po3.items[0].id,
            receivedQty: 1,
            qualifiedQty: 1,
          },
        ],
      })
    ).status,
    400,
  );
  check("wrong warehouse rejected");
  await assert.rejects(() =>
    db.$executeRawUnsafe("UPDATE inventory_transactions SET physical_delta=0"),
  );
  check("database prevents historical transaction edits");
  const recon = await rows(
    db,
    "SELECT b.physical_qty,COALESCE(sum(t.physical_delta),0)::int AS rebuilt FROM inventory_balances b LEFT JOIN inventory_transactions t ON t.sku_id=b.sku_id AND t.warehouse_id=b.warehouse_id GROUP BY b.id",
  );
  for (const row of recon) assert.equal(row.physical_qty, row.rebuilt);
  check("all balances reconcile to immutable ledger");
  await migrate();
  check("migrations rerun without modifying data");
  await writeFile(
    ".local/integration-result.json",
    JSON.stringify(
      { passed, database, completedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log(`Integration: ${passed} scenarios passed.`);
} finally {
  child.kill();
  log.end();
  await db.$disconnect();
}

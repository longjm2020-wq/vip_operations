import "dotenv/config";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
import { imageStore } from "./image-store.js";
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
const objectStore = await imageStore();
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
  const initialized = await ok("/categories/initialize", "POST", {});
  assert.deepEqual(initialized, { cleared: 0, created: 35 });
  const templateLeaves = await ok("/categories?forProduct=true&pageSize=100");
  assert.ok(
    templateLeaves.some(
      (category: any) =>
        category.code === "WOMEN-TOPS-KNIT" &&
        category.pathName === "女装 / 女上装 / 女式针织衫",
    ),
    "初始化应建立可供商品选择的三级品类",
  );
  const wh = await ok("/warehouses", "POST", { code: "WH", name: "测试仓" }),
    wh2 = await ok("/warehouses", "POST", { code: "WH2", name: "第二测试仓" }),
    su = await ok("/suppliers", "POST", {
      supplierCode: "SUP",
      name: "测试供应商",
    }),
    _ca = await ok("/categories", "POST", { code: "CAT", name: "女装" });
  const ca2 = await ok("/categories", "POST", {
      code: "CAT-TOP",
      name: "女上装",
      parentCode: "CAT",
    }),
    ca3 = await ok("/categories", "POST", {
      code: "CAT-KNIT",
      name: "女式针织衫",
      parentCode: "CAT-TOP",
    });
  assert.equal(
    (await request("/categories", "POST", {
      code: "CAT-LEVEL-4",
      name: "不允许的四级品类",
      parentId: ca3.id,
    })).status,
    400,
  );
  const categoryList = await ok("/categories?forProduct=true&pageSize=100");
  assert.ok(
    categoryList.some(
      (category: any) =>
        category.id === ca3.id && category.pathName === "女装 / 女上装 / 女式针织衫",
    ),
    "末级品类应返回完整三级路径",
  );
  assert.equal(
    categoryList.some((category: any) => category.id === ca2.id),
    false,
    "有下级的二级品类不应出现在商品品类选项中",
  );
  const pr = await ok("/products", "POST", {
    styleNo: "STYLE",
    name: "验收针织衫",
    categoryId: ca3.id,
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
        categoryId: ca3.id,
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
  const selection = await ok("/style-selections", "POST", {
    registrationBatch: "2026-10-01",
    images: [{ id: randomUUID(), url: "https://example.com/style/select-001.jpg", color: "奶油白" }],
    labelImages: [{ id: randomUUID(), url: "https://example.com/style/wash-label.jpg", color: "" }, { id: randomUUID(), url: "https://example.com/style/hang-tag.jpg", color: "" }],
    xutiStyleNo: "XUTI-SELECT-001",
    supplierStyleNo: "SUP-SELECT-001",
    supplierCode: "SUP-001",
    color: "奶油白/烟灰",
    sizeRange: "L/S/M",
    material: "100% 羊毛",
    supplyPriceExclTax: "88.50",
    vipPrice: "199.00",
    livePrice: "179.00",
    tagPrice: "399.00",
    cellColors: { vipPrice: "YELLOW" },
    cellAlignments: { vipPrice: "right", material: "center" },
    cellVerticalAlignments: { material: "bottom" },
    cellTextColors: { material: "#cf1322" },
    cellNumberFormats: { vipPrice: { type: "currency", decimals: 2, pattern: "0.00" } },
    extraFields: { "custom:test": "样衣已确认" },
    sortOrder: 3,
    rowColor: "BLUE",
  });
  const initialView = await ok("/style-selections/shared-view");
  assert.equal(initialView.revision, 0);
  const sharedSelectionView = { filters: { vipPrice: { mode: "gte", value: "100", colors: ["YELLOW"], colorType: "fill" } }, sort: { key: "vipPrice", direction: "desc" } };
  const savedView = await ok("/style-selections/shared-view", "POST", { view: sharedSelectionView, revision: initialView.revision });
  assert.equal(savedView.revision, 1);
  assert.deepEqual((await ok("/style-selections/shared-view")).view, sharedSelectionView);
  assert.equal((await request("/style-selections/shared-view", "POST", { view: sharedSelectionView, revision: 0 })).status, 409);
  assert.equal((await request("/style-selections/shared-view", "POST", { view: { filters: { vipPrice: { mode: "invalid" } }, sort: null }, revision: 1 })).status, 400);
  assert.equal(selection.xutiStyleNo, "XUTI-SELECT-001");
  assert.equal(selection.sizeRange, "S/M/L");
  assert.equal(selection.registrationBatch, "2026-10-01");
  assert.equal(selection.images[0].color, "奶油白");
  assert.equal(selection.labelImages.length, 2);
  assert.equal(selection.labelImages[1].url, "https://example.com/style/hang-tag.jpg");
  assert.equal(selection.cellColors.vipPrice, "YELLOW");
  assert.equal(selection.cellAlignments.material, "center");
  assert.equal(selection.cellVerticalAlignments.material, "bottom");
  assert.equal(selection.cellTextColors.material, "#cf1322");
  assert.equal(selection.cellNumberFormats.vipPrice.type, "currency");
  assert.equal((await request("/style-selections/" + selection.id, "PATCH", { cellNumberFormats: { vipPrice: { type: "number", decimals: 99 } } })).status, 400);
  assert.equal((await request("/style-selections/" + selection.id, "PATCH", { cellTextColors: { material: "invalid" } })).status, 400);
  assert.equal((await request("/style-selections/" + selection.id, "PATCH", { cellVerticalAlignments: { material: "invalid" } })).status, 400);
  assert.equal((await request("/style-selections/" + selection.id, "PATCH", { cellAlignments: { material: "invalid" } })).status, 400);
  await ok("/style-selections/presence", "POST", { editingId: selection.id, editingColumn: "supplierStyleNo" });
  assert.ok((await ok("/style-selections/presence")).some((person: any) => person.editingId === selection.id && person.editingColumn === "supplierStyleNo"));
  await ok("/style-selections/presence", "POST", { editingId: selection.id, editingColumn: "labelImages" });
  assert.ok((await ok("/style-selections/presence")).some((person: any) => person.editingId === selection.id && person.editingColumn === "labelImages"));
  assert.equal((await request("/style-selections/presence", "POST", { editingId: selection.id, editingColumn: "x".repeat(101) })).status, 400);
  await ok("/style-selections/presence", "POST", { editingId: null, editingColumn: "labelImages" });
  assert.ok(!(await ok("/style-selections/presence")).some((person: any) => person.editingColumn));
  const selectionList = await ok("/style-selections?q=SUP-SELECT-001&pageSize=100");
  assert.equal(selectionList.length, 1);
  assert.equal(selectionList[0].supplierCode, "SUP-001");
  assert.equal(selectionList[0].labelImages.length, 2);
  assert.equal((await request("/style-selections/" + selection.id, "PATCH", { labelImages: [{ id: randomUUID(), url: "https://example.com/invalid.jpg", color: "红" }] })).status, 400);
  const beforeRevision = (await ok("/style-selections/revision")).revision;
  assert.equal((await ok("/style-selections/revision")).revision, beforeRevision);
  const selectedStyle = await ok("/style-selections/" + selection.id, "PATCH", {
    vipPrice: "209.00",
    cellColors: { vipPrice: "GREEN" },
    expectedUpdatedAt: selection.updatedAt,
  });
  assert.equal(selectedStyle.vipPrice, "209");
  assert.notEqual((await ok("/style-selections/revision")).revision, beforeRevision);
  assert.equal(selectedStyle.registrationBatch, "2026-10-01");
  assert.deepEqual(selectedStyle.cellAlignments, selection.cellAlignments);
  assert.deepEqual(selectedStyle.cellVerticalAlignments, selection.cellVerticalAlignments);
  assert.deepEqual(selectedStyle.cellTextColors, selection.cellTextColors);
  assert.deepEqual(selectedStyle.cellNumberFormats, selection.cellNumberFormats);
  const savedAgain = await ok("/style-selections/" + selection.id, "PATCH", {
    registrationBatch: selectedStyle.registrationBatch,
    material: "连续编辑",
    expectedUpdatedAt: selectedStyle.updatedAt,
  });
  assert.equal(savedAgain.material, "连续编辑");
  const imageData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTAAAAABJRU5ErkJggg==";
  const uploadKey = randomUUID();
  const uploadedImage = await ok("/style-selections/images", "POST", { data: imageData }, uploadKey);
  assert.deepEqual(await ok("/style-selections/images", "POST", { data: imageData }, uploadKey), uploadedImage);
  const imagePath = uploadedImage.url.replace("/api/v1", "");
  const storedImage = await one(db, "SELECT content,storage_key,byte_size FROM style_selection_images WHERE id=$1::uuid", uploadedImage.url.split("/").at(-1));
  assert.equal(storedImage!.content, null, "New uploads must not store image bytes in PostgreSQL");
  assert.ok(storedImage!.storage_key);
  assert.ok(objectStore.objects.size > 0);
  assert.equal((await request(imagePath, "GET", undefined, randomUUID(), { cookie: "", csrf: "" })).status, 401);
  const downloadedImage = await fetch(base + imagePath, { headers: { Cookie: session.cookie } });
  assert.equal(downloadedImage.headers.get("content-type"), "image/png");
  assert.equal(downloadedImage.headers.get("cache-control"), "private, no-cache");
  const imageEtag = downloadedImage.headers.get("etag")!;
  const cachedImage = await fetch(base + imagePath, { headers: { Cookie: session.cookie, "If-None-Match": imageEtag } });
  assert.equal(cachedImage.status, 304);
  assert.equal((await cachedImage.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(base + imagePath, { headers: { "If-None-Match": imageEtag } })).status, 401);
  assert.deepEqual(Buffer.from(await downloadedImage.arrayBuffer()), Buffer.from(imageData.split(",")[1], "base64"));
  assert.equal((await request("/style-selections/images", "POST", { data: "data:image/png;base64,YWJj" })).status, 400);
  const oversizedImage = Buffer.alloc(1024 * 1024);
  Buffer.from("89504e470d0a1a0a", "hex").copy(oversizedImage);
  assert.equal((await request("/style-selections/images", "POST", { data: `data:image/png;base64,${oversizedImage.toString("base64")}` })).status, 400);
  const manyImages = Array.from({ length: 12 }, () => ({ id: randomUUID(), url: uploadedImage.url, color: "奶油白" }));
  const manySaved = await ok("/style-selections/" + selection.id, "PATCH", { images: manyImages, expectedUpdatedAt: savedAgain.updatedAt });
  assert.equal(manySaved.images.length, 12);
  check("selection images upload independently, enforce size and access, and allow more than five images");
  const legacyId = randomUUID();
  const legacyBytes = Buffer.from(imageData.split(",")[1], "base64");
  await rows(db, "INSERT INTO style_selection_images(id,content_type,content,created_by) SELECT $1::uuid,'image/png',$2,id FROM users WHERE username='admin'", legacyId, legacyBytes);
  const { migrateImageBatch, readStoredImage } = await import("../../apps/api/src/modules/style-selections/image-storage.js");
  await migrateImageBatch();
  const migratedImage = await one(db, "SELECT storage_key,storage_verified_at,content FROM style_selection_images WHERE id=$1::uuid", legacyId);
  assert.ok(migratedImage!.storage_verified_at);
  assert.deepEqual(Buffer.from(migratedImage!.content), legacyBytes, "Migration must retain the recovery copy");
  const readsBefore = objectStore.reads();
  const parallelReads = await Promise.all(Array.from({ length: 20 }, () => readStoredImage(legacyId)));
  assert.ok(parallelReads.every(file => Buffer.from(file.content).equals(legacyBytes)));
  assert.equal(objectStore.reads() - readsBefore, 1, "Concurrent reads should share one object request");
  assert.equal((await migrateImageBatch()).migrated, 0, "Migration can safely resume without copying completed objects");
  const recoveryId = randomUUID();
  await rows(db, "INSERT INTO style_selection_images(id,content_type,content,created_by) SELECT $1::uuid,'image/png',$2,id FROM users WHERE username='admin'", recoveryId, legacyBytes);
  objectStore.setUnavailable(true);
  try {
    assert.equal((await request("/style-selections/images", "POST", { data: imageData })).status, 503);
    await assert.rejects(() => migrateImageBatch());
    assert.equal((await one(db, "SELECT storage_key FROM style_selection_images WHERE id=$1::uuid", recoveryId))!.storage_key, null);
  } finally { objectStore.setUnavailable(false); }
  await migrateImageBatch();
  objectStore.setUnavailable(true);
  try { assert.deepEqual(Buffer.from((await readStoredImage(recoveryId)).content), legacyBytes, "Verified legacy copies remain readable during an object-store outage"); }
  finally { objectStore.setUnavailable(false); }
  check("object storage uploads, verified legacy migration, retained recovery copies and coalesced reads");
  const occupiedText = await ok("/style-selections", "POST", { xutiStyleNo: "OCCUPIED-TEXT", sortOrder: 0 });
  const duplicateNumber = await request("/style-selections", "POST", { xutiStyleNo: " OCCUPIED-TEXT ", sortOrder: 0 });
  assert.equal(duplicateNumber.status, 400);
  assert.match(duplicateNumber.body.error.message, /序缇款号已存在/);
  assert.equal((await ok("/style-selections/style-counts")).find((item:any) => item.xutiStyleNo === "OCCUPIED-TEXT")?.count, 1);
  const concurrentNumbers = await Promise.all([request("/style-selections", "POST", { xutiStyleNo: "UNIQUE-RACE" }), request("/style-selections", "POST", { xutiStyleNo: "UNIQUE-RACE" })]);
  assert.equal(concurrentNumbers.filter(result => result.status < 300).length, 1);
  assert.equal(concurrentNumbers.filter(result => result.status === 400).length, 1);
  const uniqueOwner = concurrentNumbers.find(result => result.status < 300)!.body.data;
  await ok(`/style-selections/${uniqueOwner.id}`, "DELETE");
  await ok("/style-selections", "POST", { xutiStyleNo: "UNIQUE-RACE" });
  const occupiedImage = await ok("/style-selections", "POST", { images: [{ id: randomUUID(), url: uploadedImage.url, color: "" }], sortOrder: 0 });
  const occupiedLabel = await ok("/style-selections", "POST", { labelImages: [{ id: randomUUID(), url: uploadedImage.url, color: "" }], sortOrder: 0 });
  const firstEmpty = await ok("/style-selections", "POST", { cellColors: { xutiStyleNo: "PINK" }, sortOrder: 0 });
  const firstKey = randomUUID();
  assert.equal((await ok("/style-selections/photo-next-blank", "POST", {}, firstKey)).id, firstEmpty.id);
  assert.equal((await ok("/style-selections/photo-next-blank", "POST", {}, firstKey)).id, firstEmpty.id);
  await ok(`/style-selections/${firstEmpty.id}`, "PATCH", { supplierCode: "OCCUPIED-CODE" });
  const secondEmpty = await ok("/style-selections", "POST", { sortOrder: 0 });
  assert.equal((await ok("/style-selections/photo-next-blank", "POST", {})).id, secondEmpty.id);
  await ok(`/style-selections/${secondEmpty.id}`, "PATCH", { supplierStyleNo: "OCCUPIED-SUPPLIER" });
  const nextAfterOccupied = await ok("/style-selections/photo-next-blank", "POST", {});
  for (const occupied of [occupiedText, occupiedImage, occupiedLabel, firstEmpty, secondEmpty])
    assert.notEqual(nextAfterOccupied.id, occupied.id);
  assert.equal((await request("/style-selections/photo-next-blank", "POST", {}, randomUUID(), { cookie: "", csrf: "" })).status, 401);
  check("mobile add style reuses the first unoccupied row and skips text and both image fields");
  const photoStyle = await ok("/style-selections", "POST", { xutiStyleNo:"PHOTO-QA-001", supplierStyleNo:"CAMERA-SUP-1", supplierCode:"CAMERA-CODE-1", color:"红/蓝", sortOrder:9000, material:"PHOTO-SEARCH-EXCLUDED" });
  const photoStyleNext = await ok("/style-selections", "POST", { xutiStyleNo:"PHOTO-QA-002", color:"黑", sortOrder:9001 });
  const photoBodyA = {action:"add",image:{id:randomUUID(),url:uploadedImage.url,color:"红"}};
  const photoBodyB = {action:"add",image:{id:randomUUID(),url:uploadedImage.url,color:"蓝"}};
  const photoKey = randomUUID();
  await Promise.all([ok(`/style-selections/${photoStyle.id}/photos`,"POST",photoBodyA,photoKey),ok(`/style-selections/${photoStyle.id}/photos`,"POST",photoBodyB)]);
  await ok(`/style-selections/${photoStyle.id}/photos`,"POST",photoBodyA,photoKey);
  await ok(`/style-selections/${photoStyle.id}/photos`,"POST",photoBodyA);
  const photoRead = await ok(`/style-selections/${photoStyle.id}`);
  assert.equal(photoRead.images.length,2);
  assert.equal(photoRead.material,"PHOTO-SEARCH-EXCLUDED");
  const labelPhotoA = {action:"add",field:"labelImages",image:{id:randomUUID(),url:uploadedImage.url,color:""}};
  const labelPhotoB = {action:"add",field:"labelImages",image:{id:randomUUID(),url:uploadedImage.url,color:""}};
  const labelPhotoKey = randomUUID();
  await Promise.all([ok(`/style-selections/${photoStyle.id}/photos`,"POST",labelPhotoA,labelPhotoKey),ok(`/style-selections/${photoStyle.id}/photos`,"POST",labelPhotoB)]);
  await ok(`/style-selections/${photoStyle.id}/photos`,"POST",labelPhotoA,labelPhotoKey);
  assert.equal((await ok(`/style-selections/${photoStyle.id}`)).labelImages.length,2);
  assert.equal((await request(`/style-selections/${photoStyle.id}/photos`,"POST",{action:"add",field:"labelImages",image:{id:randomUUID(),url:uploadedImage.url,color:"红"}})).status,400);
  const labelRemoved = await ok(`/style-selections/${photoStyle.id}/photos`,"POST",{action:"remove",field:"labelImages",imageId:labelPhotoA.image.id});
  assert.deepEqual(labelRemoved.labelImages.map((image:any)=>image.id),[labelPhotoB.image.id]);
  assert.equal(labelRemoved.images.length,2);
  assert.equal((await request(`/style-selections/${photoStyle.id}/photos`,"POST",{action:"add",image:{id:randomUUID(),url:uploadedImage.url,color:"不存在"}})).status,400);
  assert.equal((await request(`/style-selections/${photoStyle.id}/photos`,"POST",photoBodyA,randomUUID(),{cookie:"",csrf:""})).status,401);
  assert.equal((await ok("/style-selections?photoSearch=true&q=CAMERA-CODE-1"))[0].id,photoStyle.id);
  assert.equal((await ok("/style-selections?photoSearch=true&q=CAMERA-SUP-1"))[0].id,photoStyle.id);
  assert.equal((await ok("/style-selections?photoSearch=true&q=PHOTO-SEARCH-EXCLUDED")).length,0);
  assert.equal((await ok(`/style-selections/${photoStyle.id}/photo-next?q=PHOTO-QA`)).id,photoStyleNext.id);
  assert.equal(await ok(`/style-selections/${photoStyleNext.id}/photo-next?q=PHOTO-QA`),null);
  const removedPhoto = await ok(`/style-selections/${photoStyle.id}/photos`,"POST",{action:"remove",imageId:photoBodyA.image.id});
  assert.deepEqual(removedPhoto.images.map((image:any)=>image.id),[photoBodyB.image.id]);
  assert.equal((await request(`/style-selections/${photoStyle.id}`,"PATCH",{material:"过期手机编辑",expectedUpdatedAt:photoRead.updatedAt})).status,409);
  const blankPhotoStyle = await ok("/style-selections","POST",{color:"红"});
  assert.equal((await ok(`/style-selections/${blankPhotoStyle.id}/photos`,"POST",photoBodyA)).images.length,1);
  check("mobile photo search, next style, concurrent append, retries, color validation and image deletion");

  assert.equal(
    (
      await request("/style-selections/" + selection.id, "PATCH", {
        material: "过期编辑",
        expectedUpdatedAt: selection.updatedAt,
      })
    ).status,
    409,
  );

  const collectSource = await ok("/style-selections","POST",{xutiStyleNo:"COLLECT-ONE",supplierStyleNo:"OLD",color:"白",sizeRange:"S",vipPrice:"999.00",images:[{id:"shared-existing",url:uploadedImage.url,color:"白"}]});
  const collectOther = await ok("/style-selections","POST",{xutiStyleNo:"COLLECT-TWO",color:"黑",sizeRange:"M"});
  const collection = await ok("/selection-collections","POST",{title:"TEST COLLECTION",ids:[collectSource.id,collectOther.id],days:7});
  const ext = async(path="",method="GET",body?:any,token=collection.token,key=randomUUID())=>{
    const response=await fetch(base+"/public/selection-collection"+path,{method,headers:{"Content-Type":"application/json","X-Collection-Token":token,"Idempotency-Key":key,Origin:process.env.APP_ORIGIN!},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  };
  const shared = (await ext()).body.data;
  assert.equal(shared.items.length,2);
  assert.equal(shared.items[0].xutiStyleNo,"COLLECT-ONE");
  assert.equal(shared.items[0].vipPrice,undefined);
  assert.equal(shared.items[0].supplierCode,undefined);
  assert.equal((await ext("","GET",undefined,"0".repeat(64))).status,404);
  const sharedImage=await fetch(base+`/public/selection-collection/${collectSource.id}/images/shared-existing`,{headers:{"X-Collection-Token":collection.token}});
  assert.equal(sharedImage.status,200);
  assert.equal((await ext(`/${collectOther.id}/images/shared-existing`)).status,404);
  const info={supplierStyleNo:"NEW",color:"白",sizeRange:"S",material:"棉100%",supplyPriceExclTax:"20.00",sellingPoints:"柔软",reorderDays:7,inventory:[{color:"白",size:"S",available:3,production:5,sellOutDate:"2026-10-10",shipDate:"2026-10-12"}]};
  assert.equal((await ext("/"+collectSource.id,"POST",{revision:0,info:{...info,xutiStyleNo:"ILLEGAL"}})).status,400);
  assert.equal((await ext("/"+selection.id,"POST",{revision:0,info})).status,404);
  const saveKey=randomUUID();
  assert.equal((await ext("/"+collectSource.id,"POST",{revision:0,info},collection.token,saveKey)).status,201);
  assert.equal((await ext("/"+collectSource.id,"POST",{revision:0,info},collection.token,saveKey)).status,201);
  assert.equal((await ext("/"+collectSource.id,"POST",{revision:0,info})).status,409);
  assert.equal((await ok("/style-selections/"+collectSource.id)).supplierStyleNo,"OLD");
  assert.equal((await ext("/submit","POST",{revision:1,itemId:collectOther.id})).status,400);
  assert.equal((await ext("/submit","POST",{revision:1,itemId:collectSource.id})).status,201);
  assert.equal((await ext("/"+collectSource.id,"POST",{revision:2,info})).status,409);
  await ok("/selection-collections/"+collection.id+"/review","POST",{action:"reject",revision:2,reason:"补拍"});
  const oversizedPhoto=Buffer.alloc(500*1024);Buffer.from("89504e470d0a1a0a","hex").copy(oversizedPhoto);
  const oversizedData="data:image/png;base64,"+oversizedPhoto.toString("base64");
  assert.equal((await request("/style-selections/images","POST",{data:oversizedData})).status,400);
  assert.equal((await ext("/"+collectSource.id+"/photos","POST",{action:"add",revision:3,color:"白",data:oversizedData})).status,400);
  const photoData="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1sAAAAASUVORK5CYII=";
  assert.equal((await ext("/"+collectSource.id+"/photos","POST",{action:"add",revision:3,color:"白",data:photoData})).status,201);
  assert.equal((await ext("/submit","POST",{revision:4,itemId:collectSource.id})).status,201);
  await ok("/selection-collections/"+collection.id+"/review","POST",{action:"approve",revision:5});
  const appliedCollection=await ok("/style-selections/"+collectSource.id);
  assert.equal(appliedCollection.xutiStyleNo,"COLLECT-ONE");
  assert.equal(appliedCollection.supplierStyleNo,"NEW");
  assert.equal(appliedCollection.vipPrice,"999.00");
  assert.equal(appliedCollection.collectionInventory[0].available,3);
  assert.equal(appliedCollection.images.length,2);
  await ok("/selection-collections/"+collection.id+"/review","POST",{action:"close",revision:6});
  assert.equal((await ext()).status,404);
  assert.equal((await fetch(base+`/public/selection-collection/${collectSource.id}/images/shared-existing`,{headers:{"X-Collection-Token":collection.token}})).status,404);
  const conflictShare=await ok("/selection-collections","POST",{title:"CONFLICT",ids:[collectSource.id],days:7});
  assert.equal((await ext("/"+collectSource.id,"POST",{revision:0,info:{...info,material:"外部修改"}},conflictShare.token)).status,201);
  assert.equal((await ext("/submit","POST",{revision:1},conflictShare.token)).status,201);
  await ok("/style-selections/"+collectSource.id,"PATCH",{material:"internal edit"});
  const conflicted=(await ok("/selection-collections/"+conflictShare.id)).items[0];
  assert.deepEqual(conflicted.overwrittenFields,["材质成分"]);
  assert.equal(conflicted.current.material,"internal edit");
  await ok("/selection-collections/"+conflictShare.id+"/review","POST",{action:"approve",revision:2});
  assert.equal((await ok("/style-selections/"+collectSource.id)).material,"外部修改");
  await rows(db,"UPDATE selection_collections SET expires_at=now()-interval '1 second' WHERE id=$1::bigint",conflictShare.id);
  assert.equal((await ext("","GET",undefined,conflictShare.token)).status,404);
  const unrelatedShare=await ok("/selection-collections","POST",{title:"UNRELATED EDIT",ids:[collectSource.id],days:7});
  assert.equal((await ext("/submit","POST",{revision:0},unrelatedShare.token)).status,201);
  await ok("/style-selections/"+collectSource.id,"PATCH",{vipPrice:"888.00",material:"internal retained"});
  assert.deepEqual((await ok("/selection-collections/"+unrelatedShare.id)).items[0].overwrittenFields,[]);
  await ok("/selection-collections/"+unrelatedShare.id+"/review","POST",{action:"approve",revision:1});
  assert.equal((await ok("/style-selections/"+collectSource.id)).vipPrice,"888.00");
  assert.equal((await ok("/style-selections/"+collectSource.id)).material,"internal retained");
  const invalidMergeShare=await ok("/selection-collections","POST",{title:"INVALID MERGE",ids:[collectSource.id],days:7});
  assert.equal((await ext("/"+collectSource.id,"POST",{revision:0,info:{...info,material:"internal retained",sellingPoints:"外部卖点"}},invalidMergeShare.token)).status,201);
  assert.equal((await ext("/submit","POST",{revision:1},invalidMergeShare.token)).status,201);
  await ok("/style-selections/"+collectSource.id,"PATCH",{material:""});
  assert.deepEqual((await ok("/selection-collections/"+invalidMergeShare.id)).items[0].overwrittenFields,["材质成分"]);
  await ok("/selection-collections/"+invalidMergeShare.id+"/review","POST",{action:"approve",revision:2});
  assert.equal((await ok("/style-selections/"+collectSource.id)).material,"internal retained");
  const perItem=await ok("/selection-collections","POST",{title:"PER ITEM",ids:[collectSource.id,collectOther.id],days:7});
  const draftInfo={...info,inventory:info.inventory.map(item=>({...item,sellOutDate:null,shipDate:null}))};
  assert.equal((await ext("/"+collectSource.id,"POST",{revision:0,info:draftInfo},perItem.token)).status,201);
  assert.equal((await ext("/submit","POST",{revision:1,itemId:collectSource.id},perItem.token)).status,400);
  assert.equal((await ext("/"+collectSource.id,"POST",{revision:1,info},perItem.token)).status,201);
  assert.equal((await ext("/submit","POST",{revision:2,itemId:collectSource.id},perItem.token)).status,201);
  let itemStates=(await ext("","GET",undefined,perItem.token)).body.data.items;
  assert.deepEqual(itemStates.map((item:any)=>item.status),["SUBMITTED","DRAFT"]);
  assert.equal((await ext("/submit","POST",{revision:3,itemId:collectSource.id,action:"withdraw"},perItem.token)).status,201);
  assert.equal((await ext("/submit","POST",{revision:4,itemId:collectSource.id},perItem.token)).status,201);
  await ok("/selection-collections/"+perItem.id+"/review","POST",{action:"approve",revision:5,itemId:collectSource.id});
  itemStates=(await ext("","GET",undefined,perItem.token)).body.data.items;
  assert.deepEqual(itemStates.map((item:any)=>item.status),["APPROVED","DRAFT"]);
  assert.equal((await ext("/submit","POST",{revision:6,itemId:collectSource.id,action:"withdraw"},perItem.token)).status,409);
  assert.equal((await ext("/"+collectOther.id,"POST",{revision:6,info},perItem.token)).status,201);
  const batchSecond=await ok("/style-selections","POST",{color:"白",sizeRange:"S",images:[{id:"batch-existing",url:uploadedImage.url,color:"白"}]});
  const batchShare=await ok("/selection-collections","POST",{title:"BATCH SUBMIT",ids:[collectSource.id,batchSecond.id],days:7});
  assert.equal((await ext("/submit","POST",{revision:0,itemIds:[collectSource.id,batchSecond.id]},batchShare.token)).status,400);
  assert.deepEqual((await ext("","GET",undefined,batchShare.token)).body.data.items.map((item:any)=>item.status),["DRAFT","DRAFT"]);
  assert.equal((await ext("/"+batchSecond.id,"POST",{revision:0,info},batchShare.token)).status,201);
  assert.equal((await ext("/submit","POST",{revision:1,itemIds:[collectSource.id,batchSecond.id]},batchShare.token)).status,201);
  assert.deepEqual((await ext("","GET",undefined,batchShare.token)).body.data.items.map((item:any)=>item.status),["SUBMITTED","SUBMITTED"]);
  assert.equal((await ext("/submit","POST",{revision:2,itemIds:[collectSource.id,collectSource.id]},batchShare.token)).status,400);
  await ok("/style-selections/"+batchSecond.id,"PATCH",{material:"内部修改"});
  assert.deepEqual((await ok("/selection-collections/"+batchShare.id)).items[1].overwrittenFields,["材质成分"]);
  await ok("/selection-collections/"+batchShare.id+"/review","POST",{action:"approve",revision:2});
  assert.equal((await ok("/style-selections/"+batchSecond.id)).material,"棉100%");
  const correction=await ok("/selection-collections","POST",{title:"CORRECT ITEM",ids:[collectSource.id,batchSecond.id],days:7});
  await ok(`/selection-collections/${correction.id}/items/${collectSource.id}/edit`,"POST",{revision:0,action:"rename",xutiStyleNo:"COLLECT-CORRECTED"});
  assert.equal((await ext("","GET",undefined,correction.token)).body.data.items[0].xutiStyleNo,"COLLECT-CORRECTED");
  assert.equal((await ok("/style-selections/"+collectSource.id)).xutiStyleNo,"COLLECT-CORRECTED");
  assert.equal((await ext("/submit","POST",{revision:1,itemId:collectSource.id},correction.token)).status,201);
  await ok(`/selection-collections/${correction.id}/items/${collectSource.id}/edit`,"POST",{revision:2,action:"rename",xutiStyleNo:"COLLECT-CORRECTED-2"});
  assert.equal((await ext("","GET",undefined,correction.token)).body.data.items[0].status,"REJECTED");
  await ok(`/selection-collections/${correction.id}/items/${batchSecond.id}/edit`,"POST",{revision:3,action:"replace",targetId:collectOther.id});
  assert.deepEqual((await ext("","GET",undefined,correction.token)).body.data.items.map((item:any)=>String(item.id)),[String(collectSource.id),String(collectOther.id)]);
  assert.equal((await request(`/selection-collections/${correction.id}/items/${collectSource.id}/edit`,"POST",{revision:4,action:"replace",targetId:collectOther.id})).status,409);
  await ok(`/selection-collections/${correction.id}/items/${collectOther.id}/withdraw`,"POST",{revision:4});
  assert.equal((await ext("","GET",undefined,correction.token)).body.data.items.length,1);
  assert.equal((await ext("/submit","POST",{revision:5,itemId:collectSource.id},correction.token)).status,201);
  await ok("/selection-collections/"+correction.id+"/review","POST",{action:"approve",revision:6,itemId:collectSource.id});
  assert.equal((await request(`/selection-collections/${correction.id}/items/${collectSource.id}/withdraw`,"POST",{revision:7})).status,409);
  check("external collections isolate fields and images, save drafts, reject/resubmit, approve atomically, revoke and expire");

  const preview = await ok("/style-selections/import/preview", "POST", { rows: [
    { xutiStyleNo: "IMPORT-001", color: "黑/白", vipPrice: "99.00", images: [{ id: "first", url: uploadedImage.url, color: "黑" }] },
    { xutiStyleNo: selection.xutiStyleNo, material: "导入更新" }
  ] });
  assert.equal(preview.created, 1); assert.equal(preview.updated, 1);
  const importKey = randomUUID();
  const imported = await ok("/style-selections/import", "POST", { rows: preview.rows }, importKey);
  assert.deepEqual(imported, { created: 1, updated: 1 });
  assert.deepEqual(await ok("/style-selections/import", "POST", { rows: preview.rows }, importKey), imported);
  const kept = (await ok("/style-selections?q=" + selection.xutiStyleNo))[0];
  assert.equal(kept.images.length, manyImages.length);
  assert.deepEqual(kept.cellColors, manySaved.cellColors);
  assert.equal(kept.cellColors.vipPrice, "GREEN");
  assert.equal(kept.material, "导入更新");
  assert.equal((await request("/style-selections/import/preview", "POST", { rows: [{ xutiStyleNo: "DUP" }, { xutiStyleNo: " DUP " }] })).status, 400);
  assert.equal((await request("/style-selections/import/preview", "POST", { rows: [{ xutiStyleNo: "BAD-COLOR", color: "黑", images: [{ id: "x", url: uploadedImage.url, color: "白" }] }] })).status, 400);
  const stalePlan = await ok("/style-selections/import/preview", "POST", { rows: [{ xutiStyleNo: "ROLLBACK-NEW" }, { xutiStyleNo: "IMPORT-001", material: "旧预览" }] });
  const existingImport = (await ok("/style-selections?q=IMPORT-001"))[0];
  await ok("/style-selections/" + existingImport.id, "PATCH", { material: "并发修改", expectedUpdatedAt: existingImport.updatedAt });
  assert.equal((await request("/style-selections/import", "POST", { rows: stalePlan.rows })).status, 409);
  assert.equal((await ok("/style-selections?q=ROLLBACK-NEW")).length, 0);
  assert.equal((await request("/style-selections", "POST", { xutiStyleNo: "IMPORT-001" })).status, 400);
  assert.equal((await request("/style-selections/" + selection.id, "PATCH", { xutiStyleNo: "IMPORT-001" })).status, 400);
  const fillOnly = await ok("/style-selections", "POST", { cellColors: { supplierCode: "PINK" } });
  assert.equal((await ok("/style-selections?pageSize=100")).find((row: any) => row.id === fillOnly.id).cellColors.supplierCode, "PINK");
  const bulkPlan = await ok("/style-selections/import/preview", "POST", { rows: Array.from({ length: 500 }, (_, index) => ({ xutiStyleNo: `BULK-QA-${index}`, registrationBatch: "2026-09-28" })) });
  assert.deepEqual(await ok("/style-selections/import", "POST", { rows: bulkPlan.rows }), { created: 500, updated: 0 });
  assert.equal((await request("/style-selections?q=BULK-QA&pageSize=100&page=5")).body.total, 500);
  check("style workbook import matches, preserves blank fields, rejects duplicates, rolls back conflicts and retries idempotently");
  const syncA = await ok("/style-selections", "POST", { xutiStyleNo: "SYNC-A" });
  const syncB = await ok("/style-selections", "POST", { xutiStyleNo: "SYNC-B" });
  const syncQuery = { q: "SYNC-", sort: "xutiStyleNo", direction: "asc" };
  const firstSync = await ok("/style-selections/sync", "POST", syncQuery);
  assert.deepEqual(firstSync.index.map((item: any) => item.id), [syncA.id, syncB.id]);
  assert.equal(firstSync.data.length, 2);
  const parallelSync = await Promise.all(Array.from({ length: 10 }, () => request("/style-selections/sync", "POST", syncQuery)));
  assert.equal(new Set(parallelSync.map(result => result.body.requestId)).size, 10, "shared serialization must preserve individual request IDs");
  for (const result of parallelSync) assert.deepEqual(result.body.data, firstSync);
  assert.equal((await request("/style-selections/sync", "POST", syncQuery, randomUUID(), { cookie: "", csrf: "" })).status, 401);
  assert.equal((await request("/style-selections/sync", "POST", syncQuery, randomUUID(), { ...session, csrf: "invalid" })).status, 403);
  const known = Object.fromEntries(firstSync.index.map((item: any) => [item.id, item.token]));
  assert.equal((await ok("/style-selections/sync", "POST", { ...syncQuery, known })).data.length, 0);
  await ok("/style-selections/" + syncA.id, "PATCH", { xutiStyleNo: "SYNC-Z" });
  const changedSync = await ok("/style-selections/sync", "POST", { ...syncQuery, known });
  assert.deepEqual(changedSync.index.map((item: any) => item.id), [syncB.id, syncA.id]);
  assert.deepEqual(changedSync.data.map((item: any) => item.id), [syncA.id]);
  await ok("/style-selections/" + syncB.id, "DELETE");
  assert.deepEqual((await ok("/style-selections/sync", "POST", { ...syncQuery, known })).index.map((item: any) => item.id), [syncA.id]);
  assert.equal((await ok("/style-selections/sync", "POST", { q: "SYNC-A", known })).index.length, 0);
  await ok("/style-selections/" + syncA.id, "DELETE");
  check("incremental selection sync preserves ordering, includes changed rows, drops deleted and filtered rows");
  await ok("/style-selections/" + selection.id, "DELETE");
  assert.equal((await ok("/style-selections?q=SUP-SELECT-001&pageSize=100")).length, 0);
  check("style selections persist formatted cells, online presence, deletion and stale-edit protection");
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
  const warehouseSnapshot = (await ok("/warehouses")).find(
    (r: any) => r.id === wh.id,
  );
  await ok("/warehouses/" + wh.id, "PATCH", {
    address: "new address",
    expectedUpdatedAt: warehouseSnapshot.updatedAt,
  });
  assert.equal(
    (
      await request("/warehouses/" + wh.id, "PATCH", {
        address: "stale edit",
        expectedUpdatedAt: warehouseSnapshot.updatedAt,
      })
    ).status,
    409,
  );
  check("spreadsheet stale edits are rejected without overwriting newer data");
  const buyerRecord = (await ok("/users")).find(
    (r: any) => r.username === "buyer",
  );
  await ok("/users/" + buyerRecord.id, "PATCH", {
    displayName: "表格修改采购员",
  });
  const updatedBuyer = (await ok("/users")).find(
    (r: any) => r.id === buyerRecord.id,
  );
  assert.deepEqual(updatedBuyer.roleIds, buyerRecord.roleIds);
  assert.equal(updatedBuyer.status, buyerRecord.status);
  await ok("/roles/" + buyerRole.id, "PATCH", { name: "采购角色显示名" });
  const renamedRole = (await ok("/roles")).find(
    (r: any) => r.id === buyerRole.id,
  );
  assert.deepEqual(
    [...renamedRole.permissionCodes].sort(),
    [...buyerRole.permissionCodes].sort(),
  );
  check("spreadsheet profile edits preserve current roles and permissions");
  assert.equal((await ok("/integrations/vip/status")).mode, "disabled");
  assert.equal(
    (
      await request(
        "/integrations/vip/status",
        "GET",
        undefined,
        undefined,
        buyer,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("/integrations/vip/sync", "POST", {}, undefined, buyer))
      .status,
    403,
  );
  await rows(
    db,
    "INSERT INTO vop_connections(namespace,vendor_id,token_cipher,token_expires_at) VALUES('test:123',123,'never-expose-this',now()+interval '1 day') RETURNING namespace",
  );
  const vopState = await ok("/integrations/vip/status");
  assert.ok(
    Math.abs(
      new Date(vopState.connections[0].tokenExpiresAt).getTime() -
        Date.now() -
        86400000,
    ) < 10000,
    "VOP timestamps preserve the database instant across time zones",
  );
  assert.equal(vopState.mode, "catalog");
  assert.equal(JSON.stringify(vopState).includes("never-expose-this"), false);
  assert.equal((await ok("/integrations/vip/catalog")).total, 0);
  const requestKey = randomUUID();
  await ok("/integrations/vip/sync", "POST", {}, requestKey);
  await ok("/integrations/vip/sync", "POST", {}, requestKey);
  assert.equal(
    Number(
      (await one(
        db,
        "SELECT count(*) AS n FROM audit_logs WHERE action='VIP_SYNC_REQUEST'",
      ))!.n,
    ),
    1,
  );
  assert.ok(
    (await one(
      db,
      "SELECT requested_at FROM vop_connections WHERE namespace='test:123'",
    ))!.requested_at,
  );
  check(
    "VOP status and manual sync require permission, hide tokens, and audit idempotently",
  );
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
  if (process.env.SELECTION_LOAD_TEST === "1") {
    const { selectionLoad } = await import("./selection-load.js");
    await selectionLoad(base);
  }
} finally {
  child.kill();
  await objectStore.close();
  log.end();
  await db.$disconnect();
}

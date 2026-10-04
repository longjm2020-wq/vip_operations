// Each run creates an isolated localhost database. Production credentials are never used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
import { selectionBaseFields } from "../../packages/contracts/src/selection-migration.js";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";
import { archiveFieldIds as ids } from "../../packages/contracts/src/product-archive.js";
const root =
    process.env.SELECTION_TRANSFER_TEST_DATABASE_URL ||
    "postgresql://postgres@127.0.0.1:55433/postgres",
  name = "selection_transfer_test_" + Date.now();
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(root).hostname),
  "Transfer tests require a disposable localhost database",
);
const adminDb = new pg.Client({ connectionString: root });
await adminDb.connect();
await adminDb.query(`CREATE DATABASE ${name}`);
await adminDb.end();
const url = new URL(root);
url.pathname = "/" + name;
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  ADMIN_PASSWORD: "test-" + randomUUID(),
  SALES_SOURCE: "fixture",
  AWS_S3_BUCKET_NAME: "",
  PORT: "3103",
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
const log = createWriteStream(".local/selection-transfer-api.log");
child.stdout.pipe(log);
child.stderr.pipe(log);
const base = "http://127.0.0.1:3103/api/v1";
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
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = response.headers
    .get("content-type")
    ?.includes("application/json")
    ? await response.json()
    : await response.arrayBuffer();
  return { status: response.status, result, response };
}
async function ok(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
  user = session,
) {
  const r = await request(path, method, body, key, user);
  assert.ok(
    [200, 201].includes(r.status),
    JSON.stringify({ path, ...r.result }),
  );
  return r.result.data;
}
async function login(username: string, password: string) {
  const r = await request("/auth/login", "POST", { username, password });
  assert.equal(r.status, 200, JSON.stringify(r.result));
  return {
    cookie: r.response.headers.get("set-cookie")!.split(";")[0],
    csrf: r.result.data.csrfToken,
  } as Session;
}
async function userWith(username: string, permissions: string[]) {
  const password = "test-" + randomUUID(),
    user = await one(
      db,
      "INSERT INTO users(username,display_name,password_hash) VALUES($1,$1,$2) RETURNING id",
      username,
      passwordHash(password),
    ),
    role = await one(
      db,
      "INSERT INTO roles(code,name) VALUES($1,$1) RETURNING id",
      username,
    );
  await rows(
    db,
    "INSERT INTO user_roles(user_id,role_id) VALUES($1::bigint,$2::bigint)",
    user!.id,
    role!.id,
  );
  await rows(
    db,
    "INSERT INTO role_permissions(role_id,permission_id) SELECT $1::bigint,id FROM permissions WHERE code=ANY($2::text[])",
    role!.id,
    permissions,
  );
  return login(username, password);
}
const scoped = (table: { id: string }, endpoint = "") =>
  `/style-selections${endpoint}${endpoint.includes("?") ? "&" : "?"}tableId=${table.id}`;
const custom = {
  key: "custom:note",
  label: "核对备注",
  custom: true,
  width: 120,
  type: "text" as const,
};
const imageField = {
  key: "custom:photo",
  label: "补充图片",
  custom: true,
  width: 120,
  type: "image" as const,
};
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/health")).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  session = await login("admin", process.env.ADMIN_PASSWORD!);
  const category = await ok("/categories", "POST", {
    code: "TEST-LEAF",
    name: "测试末级品类",
  });
  const product = await ok("/products", "POST", {
    styleNo: "EXISTING",
    name: "原商品",
    categoryId: category.id,
    customFields: { [ids.unitPrice]: 88, [ids.composition]: "100%羊毛" },
    mainImageUrl: "https://example.com/original.jpg",
  });
  const archive = await ok("/product-archive-table");
  assert.equal((await ok("/product-archive-table")).id, archive.id);
  const old = (await ok(scoped(archive))).find(
    (row: any) => row.xutiStyleNo === "EXISTING",
  );
  assert.equal(old.productId, product.id);
  assert.equal(old.supplyPriceExclTax, "88.00");
  assert.equal(old.material, "100%羊毛");
  assert.equal(old.images[0].url, "https://example.com/original.jpg");
  assert.equal(
    (await ok("/project-tables")).some((table: any) => table.id === archive.id),
    false,
  );
  assert.equal(
    (await request(`/project-library/table/${archive.id}`, "DELETE", {}))
      .status,
    403,
  );
  passed++;
  console.log(
    "PASS archive seeds existing products once, preserves IDs and is not a normal library table",
  );
  const target = await ok("/project-tables", "POST", {
    name: "候选目标",
    visibility: "PUBLIC",
  });
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p1cAAAAASUVORK5CYII=";
  const upload = await ok("/style-selections/images", "POST", { data: png });
  const photo = { id: "photo-1", url: upload.url, color: "米白色" };
  const source = await ok("/style-selections", "POST", {
    xutiStyleNo: "TRANSMIT-01",
    material: "100%山羊绒",
    color: "米白色",
    images: [photo],
    labelImages: [{ ...photo, id: "label-1", color: "" }],
    supplyPriceExclTax: "169.80",
    extraFields: {
      [custom.key]: "同格\n多行备注",
      [imageField.key]: JSON.stringify([photo]),
    },
  });
  const body = {
    rowIds: [source.id],
    fields: [...selectionBaseFields, custom, imageField],
    target: target.id,
    mappings: [],
    copyMissingFields: true,
  };
  const preview = await ok("/style-selections/migration/preview", "POST", body);
  assert.equal(preview.created, 1);
  assert.equal(preview.addedFields, 15);
  const key = randomUUID(),
    sent = await ok(
      "/style-selections/migration",
      "POST",
      { ...body, token: preview.token },
      key,
    ),
    again = await ok(
      "/style-selections/migration",
      "POST",
      { ...body, token: preview.token },
      key,
    );
  assert.deepEqual(sent, again);
  const copied = (await ok(scoped(target)))[0],
    locked = await ok("/style-selections/" + source.id);
  assert.equal(locked.migrationLocked, true);
  assert.equal(locked.migrationTargetWorkspace, target.id);
  assert.equal(locked.migrationTargetRowId, copied.id);
  assert.equal(copied.extraFields[custom.key], "同格\n多行备注");
  assert.equal(copied.images[0].url, upload.url + "?tableId=" + target.id);
  assert.equal(
    JSON.parse(copied.extraFields[imageField.key])[0].url,
    copied.images[0].url,
  );
  assert.equal(
    (await request(copied.images[0].url.replace("/api/v1", ""))).status,
    200,
  );
  const destinationPrefs = await ok(scoped(target, "/layout-preferences"));
  assert.equal(destinationPrefs.preferences.columns.length, 15);
  assert.equal(
    (
      await request("/style-selections/" + source.id, "PATCH", {
        material: "bypass",
      })
    ).status,
    409,
  );
  assert.equal(
    (await request("/style-selections/" + source.id, "DELETE")).status,
    409,
  );
  assert.equal(
    (
      await request("/style-selections/" + source.id + "/photos", "POST", {
        action: "remove",
        imageId: photo.id,
      })
    ).status,
    409,
  );
  assert.equal(
    (await request("/style-selections/migration/preview", "POST", body)).status,
    409,
  );
  passed++;
  console.log(
    "PASS selected rows, multi-image attachments and new fields transfer atomically; retries and all source edits are blocked",
  );
  const readonly = await userWith("readonly-source", ["selection.read"]);
  assert.equal(
    (
      await request(
        "/style-selections/" + source.id + "/release-migration",
        "POST",
        { expectedUpdatedAt: locked.updatedAt },
        undefined,
        readonly,
      )
    ).status,
    403,
  );
  const released = await ok(
    "/style-selections/" + source.id + "/release-migration",
    "POST",
    { expectedUpdatedAt: locked.updatedAt },
  );
  assert.equal(released.migrationLocked, false);
  assert.equal((await ok(scoped(target))).length, 1);
  await ok("/style-selections/" + source.id, "PATCH", {
    material: "80%羊绒20%羊毛",
    expectedUpdatedAt: released.updatedAt,
  });
  const nextPreview = await ok("/style-selections/migration/preview", "POST", {
    ...body,
    mappings: destinationPrefs.preferences.columns.map((field: any) => ({
      source: field.key,
      target: field.key,
    })),
  });
  assert.equal(nextPreview.updated, 1);
  await ok("/style-selections/migration", "POST", {
    ...body,
    mappings: destinationPrefs.preferences.columns.map((field: any) => ({
      source: field.key,
      target: field.key,
    })),
    token: nextPreview.token,
  });
  assert.equal((await ok(scoped(target))).length, 1);
  assert.equal((await ok(scoped(target)))[0].material, "80%羊绒20%羊毛");
  passed++;
  console.log(
    "PASS pencil release preserves destination data and later sends update the linked row without duplicates",
  );
  const rowA = await ok("/style-selections", "POST", {
      xutiStyleNo: "BATCH-A",
      material: "before",
    }),
    rowB = await ok("/style-selections", "POST", {
      xutiStyleNo: "BATCH-B",
      material: "before",
    });
  const batch = {
    rowIds: [rowA.id, rowB.id],
    fields: selectionBaseFields,
    target: target.id,
    mappings: selectionBaseFields.map((field) => ({
      source: field.key,
      target: field.key,
    })),
    copyMissingFields: false,
  };
  const batchPreview = await ok(
    "/style-selections/migration/preview",
    "POST",
    batch,
  );
  await ok("/style-selections/" + rowB.id, "PATCH", {
    material: "concurrent",
    expectedUpdatedAt: rowB.updatedAt,
  });
  assert.equal(
    (
      await request("/style-selections/migration", "POST", {
        ...batch,
        token: batchPreview.token,
      })
    ).status,
    409,
  );
  assert.equal((await ok(scoped(target))).length, 1);
  assert.equal(
    (await ok("/style-selections/" + rowA.id)).migrationLocked,
    false,
  );
  const mappedBody = {
    rowIds: [rowA.id],
    fields: selectionBaseFields,
    target: target.id,
    mappings: [
      { source: "xutiStyleNo", target: "xutiStyleNo" },
      { source: "material", target: custom.key },
    ],
    copyMissingFields: false,
  };
  const mapPreview = await ok(
    "/style-selections/migration/preview",
    "POST",
    mappedBody,
  );
  await ok("/style-selections/migration", "POST", {
    ...mappedBody,
    token: mapPreview.token,
  });
  const mapped = (await ok(scoped(target))).find(
    (row: any) => row.xutiStyleNo === "BATCH-A",
  );
  assert.equal(mapped.extraFields[custom.key], "before");
  assert.equal(mapped.material, null);
  passed++;
  console.log(
    "PASS stale previews roll back the entire batch and explicit field mapping changes only chosen columns",
  );
  const toArchive = await ok("/style-selections", "POST", {
    xutiStyleNo: "NEW-ARCHIVE",
    material: "棉100%",
    supplyPriceExclTax: "29.90",
    color: "米白色",
    images: [photo],
    labelImages: [{ ...photo, id: "label", color: "" }],
  });
  const archiveBody = {
    rowIds: [toArchive.id],
    fields: selectionBaseFields,
    target: archive.id,
    mappings: selectionBaseFields.map((field) => ({
      source: field.key,
      target: field.key,
    })),
    copyMissingFields: true,
  };
  const archivePreview = await ok(
    "/style-selections/migration/preview",
    "POST",
    archiveBody,
  );
  await ok("/style-selections/migration", "POST", {
    ...archiveBody,
    token: archivePreview.token,
  });
  const archiveRow = (await ok(scoped(archive))).find(
    (row: any) => row.xutiStyleNo === "NEW-ARCHIVE",
  );
  const canonical = await one(
    db,
    "SELECT * FROM products WHERE id=$1::bigint",
    archiveRow.productId,
  );
  assert.equal(canonical!.custom_fields[ids.unitPrice], 29.9);
  assert.equal(canonical!.custom_fields[ids.composition], "棉100%");
  assert.equal(
    canonical!.main_image_url,
    "http://localhost:5174" + archiveRow.images[0].url,
  );
  await ok(scoped(archive, "/" + archiveRow.id), "PATCH", {
    material: "麻100%",
    extraFields: { "custom:product:name": "新档案名" },
    expectedUpdatedAt: archiveRow.updatedAt,
  });
  assert.equal(
    (await one(
      db,
      "SELECT name,custom_fields FROM products WHERE id=$1::bigint",
      archiveRow.productId,
    ))!.name,
    "新档案名",
  );
  assert.equal(
    (await one(
      db,
      "SELECT custom_fields FROM products WHERE id=$1::bigint",
      archiveRow.productId,
    ))!.custom_fields[ids.composition],
    "麻100%",
  );
  await ok("/products/" + archiveRow.productId, "PATCH", {
    name: "详情修改后",
  });
  const mirrored = await ok(scoped(archive, "/" + archiveRow.id));
  assert.equal(mirrored.extraFields["custom:product:name"], "详情修改后");
  assert.equal(mirrored.labelImages.length, 1);
  assert.equal(mirrored.images[0].url, archiveRow.images[0].url);
  assert.equal(
    (await request(scoped(archive, "/" + archiveRow.id), "DELETE")).status,
    409,
  );
  const draft = await ok(scoped(archive), "POST", {});
  assert.equal(draft.productId, null);
  await ok(scoped(archive, "/" + draft.id), "DELETE");
  passed++;
  console.log(
    "PASS archive transfers create real products; grid and master edits synchronize without losing pictures, links or drafts",
  );
  const validYear = await ok("/style-selections", "POST", {
      xutiStyleNo: "ROLLBACK-FIRST",
      supplierCode: "2026",
      color: "米白色",
      images: [photo],
    }),
    invalidYear = await ok("/style-selections", "POST", {
      xutiStyleNo: "ROLLBACK-SECOND",
      supplierCode: "2300",
      color: "米白色",
      images: [photo],
    });
  const failedBatch = {
    rowIds: [validYear.id, invalidYear.id],
    fields: selectionBaseFields,
    target: archive.id,
    mappings: [
      { source: "xutiStyleNo", target: "xutiStyleNo" },
      { source: "supplierCode", target: "custom:product:year" },
      { source: "images", target: "images" },
      { source: "color", target: "color" },
    ],
    copyMissingFields: false,
  };
  const failedPreview = await ok(
    "/style-selections/migration/preview",
    "POST",
    failedBatch,
  );
  const failedCommit = await request("/style-selections/migration", "POST", {
    ...failedBatch,
    token: failedPreview.token,
  });
  assert.equal(failedCommit.status, 400);
  assert.match(
    JSON.stringify(failedCommit.result),
    /2200/,
    "the second row reaches the master year validation after the first row has been saved in the transaction",
  );
  assert.equal(
    (await one(
      db,
      "SELECT count(*)::int AS n FROM products WHERE style_no LIKE 'ROLLBACK-%'",
    ))!.n,
    0,
  );
  assert.equal(
    (await ok(scoped(archive))).some((row: any) =>
      row.xutiStyleNo.startsWith("ROLLBACK-"),
    ),
    false,
  );
  assert.equal(
    (await ok("/style-selections/" + validYear.id)).migrationLocked,
    false,
  );
  assert.equal(
    (await ok("/style-selections/" + invalidYear.id)).migrationLocked,
    false,
  );
  const wrongType = {
    ...failedBatch,
    rowIds: [validYear.id],
    mappings: [{ source: "material", target: "custom:product:year" }],
  };
  await ok("/style-selections/" + validYear.id, "PATCH", {
    material: "并非数字",
  });
  assert.equal(
    (await request("/style-selections/migration/preview", "POST", wrongType))
      .status,
    400,
  );
  passed++;
  console.log(
    "PASS destination field types are validated and a later master validation failure rolls back every product, target row and source lock",
  );
  const productReader = await userWith("product-only-reader", ["product.read"]),
    productEditor = await userWith("product-only-editor", [
      "product.read",
      "product.update",
    ]);
  assert.equal(
    (await request(scoped(archive), "GET", undefined, undefined, productReader))
      .status,
    200,
  );
  assert.equal(
    (
      await request(
        scoped(archive, "/" + old.id),
        "PATCH",
        { material: "illegal" },
        undefined,
        productReader,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        scoped(archive, "/" + old.id),
        "PATCH",
        { material: "editor allowed" },
        undefined,
        productEditor,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        scoped(archive),
        "POST",
        { xutiStyleNo: "MISSING-CREATE" },
        undefined,
        productEditor,
      )
    ).status,
    403,
  );
  const projectEditor = await userWith("project-only-editor", [
    "project.read",
    "project.create",
  ]);
  assert.equal(
    (await request(scoped(archive), "GET", undefined, undefined, projectEditor))
      .status,
    403,
  );
  const available = await ok("/style-selections/migration/targets");
  assert(available.some((item: any) => item.key === archive.id));
  assert(available.some((item: any) => item.key === target.id));
  const projectTargets = await ok(
    scoped(target, "/migration/targets"),
    "GET",
    undefined,
    undefined,
    projectEditor,
  );
  assert.equal(
    projectTargets.some((item: any) => item.archive || item.key === "default"),
    false,
  );
  passed++;
  console.log(
    "PASS archive uses product permissions; normal tables cannot grant product writes or expose inaccessible destinations",
  );
  const archiveLocked = await ok("/style-selections/" + toArchive.id);
  const restored = await ok(
    "/style-selections/" + toArchive.id + "/release-migration",
    "POST",
    { expectedUpdatedAt: archiveLocked.updatedAt },
  );
  const config = {
    target: archive.id,
    mappings: [{ source: "material", target: "material" }],
    ignoredSources: ["images"],
    copyMissingFields: false,
  };
  const preferences = selectionLayoutSchema.parse({
    columns: selectionBaseFields,
    migrationConfig: config,
  });
  await ok("/style-selections/layout-preferences", "POST", {
    revision: 0,
    preferences,
  });
  const secondSession = await login("admin", process.env.ADMIN_PASSWORD!);
  assert.deepEqual(
    (
      await ok(
        "/style-selections/layout-preferences",
        "GET",
        undefined,
        undefined,
        secondSession,
      )
    ).preferences.migrationConfig,
    config,
  );
  assert.equal(restored.migrationLocked, false);
  passed++;
  console.log(
    "PASS transfer configuration belongs to the account and survives a second browser session",
  );
  console.log(`Passed ${passed} cross-table transfer integration scenarios`);
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

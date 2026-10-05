// Each run creates an isolated localhost database. Production credentials are never used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
import { selectionBaseFields } from "../../packages/contracts/src/selection-migration.js";
import {
  selectionLayoutSchema,
  type SelectionField,
} from "../../packages/contracts/src/selection-layout.js";
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
    registrationBatch: "2026-09-28",
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
    fields: [
      ...selectionBaseFields.map((field) =>
        field.key === "registrationBatch"
          ? { ...field, type: "date" as const }
          : field,
      ),
      custom,
      imageField,
    ],
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
  assert.equal(copied.registrationBatch, "2026-09-28");
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
  const washing: SelectionField = {
      key: "custom:washing",
      label: "洗涤标志核对",
      width: 120,
      custom: true,
      type: "single",
      options: ["规范", "不规范"],
      optionColors: { 规范: "green", 不规范: "gray" },
    },
    actions: SelectionField = {
      key: "custom:actions",
      label: "衣服整改措施",
      width: 120,
      custom: true,
      type: "multiple",
      options: ["换洗唛", "缝领标"],
      optionColors: { 换洗唛: "blue", 缝领标: "teal" },
    },
    tags: SelectionField = {
      key: "custom:tags",
      label: "质检标签",
      width: 120,
      custom: true,
      type: "tags",
      options: ["原候选"],
      tagConfig: {
        allowCustom: false,
        multiple: true,
        max: 30,
        order: "selection",
        color: "orange",
      },
    };
  let choiceLayout = await ok(scoped(archive, "/layout-preferences"));
  const originalColumns = choiceLayout.preferences.columns;
  choiceLayout = await ok(scoped(archive, "/layout-preferences"), "POST", {
    revision: choiceLayout.revision,
    preferences: selectionLayoutSchema.parse({
      ...choiceLayout.preferences,
      columns: [
        ...originalColumns,
        {
          ...washing,
          options: ["待复核", "规范", "目标独有选项"],
          optionColors: { 待复核: "brown", 规范: "orange" },
        },
        {
          ...actions,
          options: ["保留动作"],
          optionColors: { 保留动作: "brown" },
        },
        { ...tags, options: ["目标标签"] },
      ],
    }),
  });
  const choiceBefore = await ok(scoped(archive), "POST", {
      xutiStyleNo: "TRANSFER-CHOICES",
      material: "保留原内容",
      extraFields: { [washing.key]: "待复核" },
    }),
    choiceSource = await ok("/style-selections", "POST", {
      xutiStyleNo: "TRANSFER-CHOICES",
      extraFields: {
        [washing.key]: "不规范",
        [actions.key]: "换洗唛/缝领标",
        [tags.key]: "原候选",
      },
    }),
    choiceFields = [
      selectionBaseFields.find((field) => field.key === "xutiStyleNo")!,
      washing,
      actions,
      tags,
    ],
    choiceBody = {
      rowIds: [choiceSource.id],
      fields: choiceFields,
      target: archive.id,
      mappings: choiceFields.map((field) => ({
        source: field.key,
        target: field.key,
      })),
      copyMissingFields: false,
    };
  const choicePreview = await ok(
    "/style-selections/migration/preview",
    "POST",
    choiceBody,
  );
  assert.equal(choicePreview.created, 0);
  assert.equal(choicePreview.updated, 1);
  assert.equal(choicePreview.addedFields, 0);
  assert.deepEqual(choicePreview.optionChanges, [
    { key: washing.key, label: washing.label, addedOptions: ["不规范"] },
    {
      key: actions.key,
      label: actions.label,
      addedOptions: ["换洗唛", "缝领标"],
    },
    { key: tags.key, label: tags.label, addedOptions: ["原候选"] },
  ]);
  assert.deepEqual(
    await ok(scoped(archive, "/layout-preferences")),
    choiceLayout,
  );
  assert.deepEqual(
    await ok(scoped(archive, "/" + choiceBefore.id)),
    choiceBefore,
  );
  // A layout edit after preview invalidates the entire plan, including option additions.
  choiceLayout = await ok(scoped(archive, "/layout-preferences"), "POST", {
    revision: choiceLayout.revision,
    preferences: {
      ...choiceLayout.preferences,
      columns: choiceLayout.preferences.columns.map((field: SelectionField) =>
        field.key === washing.key ? { ...field, width: 140 } : field,
      ),
    },
  });
  assert.equal(
    (
      await request("/style-selections/migration", "POST", {
        ...choiceBody,
        token: choicePreview.token,
      })
    ).status,
    409,
  );
  assert.deepEqual(
    await ok(scoped(archive, "/" + choiceBefore.id)),
    choiceBefore,
  );
  assert.equal(
    (await ok("/style-selections/" + choiceSource.id)).migrationLocked,
    false,
  );
  const freshChoicePreview = await ok(
      "/style-selections/migration/preview",
      "POST",
      choiceBody,
    ),
    choiceCommand = { ...choiceBody, token: freshChoicePreview.token },
    choiceKey = randomUUID(),
    choiceResult = await ok(
      "/style-selections/migration",
      "POST",
      choiceCommand,
      choiceKey,
    );
  assert.deepEqual(
    await ok("/style-selections/migration", "POST", choiceCommand, choiceKey),
    choiceResult,
  );
  const choiceAfter = await ok(scoped(archive, "/" + choiceBefore.id));
  assert.equal(choiceAfter.productId, choiceBefore.productId);
  assert.equal(choiceAfter.material, "保留原内容");
  assert.equal(choiceAfter.extraFields[washing.key], "不规范");
  assert.equal(choiceAfter.extraFields[actions.key], "换洗唛/缝领标");
  assert.equal(choiceAfter.extraFields[tags.key], "原候选");
  choiceLayout = await ok(scoped(archive, "/layout-preferences"));
  const mergedWashing = choiceLayout.preferences.columns.find(
      (field: SelectionField) => field.key === washing.key,
    ),
    mergedActions = choiceLayout.preferences.columns.find(
      (field: SelectionField) => field.key === actions.key,
    );
  assert.deepEqual(mergedWashing.options, [
    "待复核",
    "规范",
    "目标独有选项",
    "不规范",
  ]);
  assert.deepEqual(mergedWashing.optionColors, {
    待复核: "brown",
    规范: "orange",
    不规范: "gray",
  });
  assert.equal(mergedWashing.type, "single");
  assert.equal(mergedWashing.width, 140);
  assert.deepEqual(mergedActions.options, ["保留动作", "换洗唛", "缝领标"]);
  assert.deepEqual(mergedActions.optionColors, {
    保留动作: "brown",
    换洗唛: "blue",
    缝领标: "teal",
  });
  passed++;
  console.log(
    "PASS existing choice fields merge configured options and colors atomically, with read-only previews, conflict checks and idempotent retries",
  );
  const invalidChoice = await ok("/style-selections", "POST", {
      xutiStyleNo: "INVALID-CHOICES",
      extraFields: { [washing.key]: "目标独有选项" },
    }),
    invalidBody = {
      ...choiceBody,
      rowIds: [invalidChoice.id],
      fields: [choiceFields[0], washing],
      mappings: choiceBody.mappings.slice(0, 2),
    };
  let invalidPreview = await request(
    "/style-selections/migration/preview",
    "POST",
    invalidBody,
  );
  assert.equal(invalidPreview.status, 400);
  assert.match(JSON.stringify(invalidPreview.result), /原字段/);
  await ok("/style-selections/" + invalidChoice.id, "PATCH", {
    extraFields: { [washing.key]: "纯文本未知选项" },
  });
  invalidPreview = await request(
    "/style-selections/migration/preview",
    "POST",
    {
      ...invalidBody,
      fields: [
        choiceFields[0],
        { ...washing, type: "text", options: ["纯文本未知选项"] },
      ],
    },
  );
  assert.equal(invalidPreview.status, 400);
  assert.match(JSON.stringify(invalidPreview.result), /请选择已配置的选项/);
  assert.deepEqual(
    await ok(scoped(archive, "/layout-preferences")),
    choiceLayout,
  );
  assert.equal(
    (await ok("/style-selections/" + invalidChoice.id)).migrationLocked,
    false,
  );
  const limitedLayout = await ok(
    scoped(archive, "/layout-preferences"),
    "POST",
    {
      revision: choiceLayout.revision,
      preferences: {
        ...choiceLayout.preferences,
        columns: choiceLayout.preferences.columns.map(
          (field: SelectionField) =>
            field.key === washing.key
              ? {
                  ...field,
                  options: Array.from(
                    { length: 100 },
                    (_, i) => "目标选项" + i,
                  ),
                }
              : field,
        ),
      },
    },
  );
  const overflowPreview = await request(
    "/style-selections/migration/preview",
    "POST",
    {
      ...invalidBody,
      fields: [choiceFields[0], washing],
    },
  );
  assert.equal(overflowPreview.status, 400);
  assert.match(JSON.stringify(overflowPreview.result), /100.*选项/);
  assert.deepEqual(
    await ok(scoped(archive, "/layout-preferences")),
    limitedLayout,
  );
  choiceLayout = await ok(scoped(archive, "/layout-preferences"), "POST", {
    revision: limitedLayout.revision,
    preferences: choiceLayout.preferences,
  });
  const productChoice = await ok("/product-fields", "POST", {
    name: "商品专用质检",
    type: "select",
    options: ["商品已配置"],
  });
  const productChoiceKey = "custom:product:" + productChoice.id;
  choiceLayout = await ok(scoped(archive, "/layout-preferences"), "POST", {
    revision: choiceLayout.revision,
    preferences: {
      ...choiceLayout.preferences,
      columns: [
        ...choiceLayout.preferences.columns,
        {
          ...washing,
          key: productChoiceKey,
          label: productChoice.name,
          options: productChoice.options,
        },
      ],
    },
  });
  const globalPreview = await request(
    "/style-selections/migration/preview",
    "POST",
    {
      ...invalidBody,
      fields: [
        choiceFields[0],
        { ...washing, type: "text", options: ["纯文本未知选项"] },
      ],
      mappings: [
        choiceBody.mappings[0],
        { source: washing.key, target: productChoiceKey },
      ],
    },
  );
  assert.equal(globalPreview.status, 400);
  assert.match(JSON.stringify(globalPreview.result), /请选择已配置的选项/);
  assert.deepEqual(
    (await one(
      db,
      "SELECT options FROM product_fields WHERE id=$1",
      productChoice.id,
    ))!.options,
    ["商品已配置"],
  );
  assert.deepEqual(
    await ok(scoped(archive, "/layout-preferences")),
    choiceLayout,
  );
  passed++;
  console.log(
    "PASS undeclared choices, text-to-choice values and personal option overflow remain invalid without expanding product choices",
  );
  await ok("/style-selections/" + invalidChoice.id, "PATCH", {
    extraFields: { [washing.key]: "规范" },
  });
  const sharedWashingKey = "custom:product:" + ids.washingCheck,
    sharedBefore = await one(
      db,
      "SELECT * FROM product_fields WHERE id=$1",
      ids.washingCheck,
    ),
    sharedBody = {
      ...invalidBody,
      fields: [choiceFields[0], washing],
      mappings: [
        choiceBody.mappings[0],
        { source: washing.key, target: sharedWashingKey },
      ],
    },
    sharedPreview = await ok(
      "/style-selections/migration/preview",
      "POST",
      sharedBody,
    );
  assert.deepEqual(sharedPreview.optionChanges, [
    {
      key: sharedWashingKey,
      label: washing.label,
      addedOptions: ["规范", "不规范"],
      shared: true,
    },
  ]);
  assert.deepEqual(
    (await one(
      db,
      "SELECT options FROM product_fields WHERE id=$1",
      ids.washingCheck,
    ))!.options,
    sharedBefore!.options,
  );
  assert.equal(
    (await ok("/style-selections/" + invalidChoice.id)).migrationLocked,
    false,
  );
  await ok("/product-fields/" + ids.washingCheck, "PATCH", {
    name: "共享洗涤核对",
    type: "select",
    options: sharedBefore!.options,
    expectedUpdatedAt: new Date(sharedBefore!.updated_at).toISOString(),
  });
  const sharedConflict = await request("/style-selections/migration", "POST", {
    ...sharedBody,
    token: sharedPreview.token,
  });
  assert.equal(sharedConflict.status, 409);
  assert.deepEqual(
    (await one(
      db,
      "SELECT options FROM product_fields WHERE id=$1",
      ids.washingCheck,
    ))!.options,
    sharedBefore!.options,
  );
  const sharedFreshPreview = await ok(
      "/style-selections/migration/preview",
      "POST",
      sharedBody,
    ),
    sharedCommand = { ...sharedBody, token: sharedFreshPreview.token },
    sharedCommandKey = randomUUID(),
    sharedResult = await ok(
      "/style-selections/migration",
      "POST",
      sharedCommand,
      sharedCommandKey,
    );
  assert.deepEqual(
    await ok(
      "/style-selections/migration",
      "POST",
      sharedCommand,
      sharedCommandKey,
    ),
    sharedResult,
  );
  const sharedOptions = [...sharedBefore!.options, "规范", "不规范"],
    sharedRow = (await ok(scoped(archive))).find(
      (row: any) => row.xutiStyleNo === invalidChoice.xutiStyleNo,
    );
  assert.deepEqual(
    (await one(
      db,
      "SELECT options FROM product_fields WHERE id=$1",
      ids.washingCheck,
    ))!.options,
    sharedOptions,
  );
  assert.equal(
    (await one(
      db,
      "SELECT custom_fields FROM products WHERE id=$1::bigint",
      sharedRow.productId,
    ))!.custom_fields[ids.washingCheck],
    "规范",
  );
  choiceLayout = await ok(scoped(archive, "/layout-preferences"));
  assert.deepEqual(
    choiceLayout.preferences.columns.find(
      (field: SelectionField) => field.key === sharedWashingKey,
    ).options,
    sharedOptions,
  );
  passed++;
  console.log(
    "PASS the built-in product washing field appends explicitly previewed shared choices and writes real product values, with catalog conflict checks and idempotency",
  );
  const rollbackSharedFirst = await ok("/style-selections", "POST", {
      xutiStyleNo: "GLOBAL-ROLLBACK-1",
      supplierCode: "2026",
      extraFields: { [washing.key]: "传送新选项" },
    }),
    rollbackSharedSecond = await ok("/style-selections", "POST", {
      xutiStyleNo: "GLOBAL-ROLLBACK-2",
      supplierCode: "2300",
      extraFields: { [washing.key]: "传送新选项" },
    }),
    rollbackSharedBody = {
      ...sharedBody,
      rowIds: [rollbackSharedFirst.id, rollbackSharedSecond.id],
      fields: [
        choiceFields[0],
        { ...washing, options: ["传送新选项"] },
        selectionBaseFields.find((field) => field.key === "supplierCode")!,
      ],
      mappings: [
        ...sharedBody.mappings,
        { source: "supplierCode", target: "custom:product:year" },
      ],
    },
    rollbackSharedPreview = await ok(
      "/style-selections/migration/preview",
      "POST",
      rollbackSharedBody,
    ),
    rollbackSharedResult = await request(
      "/style-selections/migration",
      "POST",
      { ...rollbackSharedBody, token: rollbackSharedPreview.token },
    );
  assert.equal(rollbackSharedResult.status, 400);
  assert.match(JSON.stringify(rollbackSharedResult.result), /2200/);
  assert.deepEqual(
    (await one(
      db,
      "SELECT options FROM product_fields WHERE id=$1",
      ids.washingCheck,
    ))!.options,
    sharedOptions,
  );
  assert.deepEqual(
    await ok(scoped(archive, "/layout-preferences")),
    choiceLayout,
  );
  assert.equal(
    (await one(
      db,
      "SELECT count(*)::int AS n FROM products WHERE style_no LIKE 'GLOBAL-ROLLBACK-%'",
    ))!.n,
    0,
  );
  assert.equal(
    (await ok("/style-selections/" + rollbackSharedFirst.id)).migrationLocked,
    false,
  );
  assert.equal(
    (await ok("/style-selections/" + rollbackSharedSecond.id)).migrationLocked,
    false,
  );
  passed++;
  console.log(
    "PASS a later product validation failure rolls back shared option additions, personal layouts, every product row and every source lock",
  );
  const maxProductChoice = await ok("/product-fields", "POST", {
      name: "50选项共享字段",
      type: "select",
      options: Array.from({ length: 50 }, (_, i) => "共享选项" + i),
    }),
    maxProductChoiceKey = "custom:product:" + maxProductChoice.id;
  choiceLayout = await ok(scoped(archive, "/layout-preferences"), "POST", {
    revision: choiceLayout.revision,
    preferences: {
      ...choiceLayout.preferences,
      columns: [
        ...choiceLayout.preferences.columns,
        {
          ...washing,
          key: maxProductChoiceKey,
          label: maxProductChoice.name,
          options: maxProductChoice.options,
        },
      ],
    },
  });
  const sharedLimitSource = await ok("/style-selections", "POST", {
      xutiStyleNo: "GLOBAL-LIMIT",
      extraFields: { [washing.key]: "规范", [actions.key]: "换洗唛/缝领标" },
    }),
    sharedOverflow = await request(
      "/style-selections/migration/preview",
      "POST",
      {
        ...sharedBody,
        rowIds: [sharedLimitSource.id],
        mappings: [
          choiceBody.mappings[0],
          { source: washing.key, target: maxProductChoiceKey },
        ],
      },
    );
  assert.equal(sharedOverflow.status, 400);
  assert.match(JSON.stringify(sharedOverflow.result), /50.*选项/);
  assert.deepEqual(
    (await one(
      db,
      "SELECT options FROM product_fields WHERE id=$1",
      maxProductChoice.id,
    ))!.options,
    maxProductChoice.options,
  );
  const sharedMultiple = await request(
    "/style-selections/migration/preview",
    "POST",
    {
      ...sharedBody,
      rowIds: [sharedLimitSource.id],
      fields: [choiceFields[0], actions],
      mappings: [
        choiceBody.mappings[0],
        { source: actions.key, target: sharedWashingKey },
      ],
    },
  );
  assert.equal(sharedMultiple.status, 400);
  assert.match(JSON.stringify(sharedMultiple.result), /请选择已配置的选项/);
  assert.deepEqual(
    (await one(
      db,
      "SELECT options FROM product_fields WHERE id=$1",
      ids.washingCheck,
    ))!.options,
    sharedOptions,
  );
  passed++;
  console.log(
    "PASS shared product options retain their 50-choice limit and single-choice business validation",
  );
  const productReader = await userWith("product-only-reader", ["product.read"]),
    productEditor = await userWith("product-only-editor", [
      "product.read",
      "product.update",
    ]);
  const readerLayout = await ok(
    scoped(archive, "/layout-preferences"),
    "POST",
    {
      revision: 0,
      preferences: selectionLayoutSchema.parse({
        columns: [
          {
            ...washing,
            key: sharedWashingKey,
            label: "个人质检名称",
            width: 222,
            options: sharedBefore!.options,
            optionColors: { 规范: "orange" },
          },
        ],
      }),
    },
    undefined,
    productReader,
  );
  const readerFreshLayout = await ok(
    scoped(archive, "/layout-preferences"),
    "GET",
    undefined,
    undefined,
    productReader,
  );
  assert.equal(readerFreshLayout.revision, readerLayout.revision);
  assert.deepEqual(
    readerFreshLayout.preferences.columns[0].options,
    sharedOptions,
  );
  assert.equal(readerFreshLayout.preferences.columns[0].label, "个人质检名称");
  assert.equal(readerFreshLayout.preferences.columns[0].width, 222);
  assert.deepEqual(readerFreshLayout.preferences.columns[0].optionColors, {
    规范: "orange",
  });
  assert.equal(
    (
      await request(
        scoped(archive, "/migration/preview"),
        "POST",
        { ...sharedBody, target: "default", rowIds: [sharedRow.id] },
        undefined,
        productReader,
      )
    ).status,
    403,
  );
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

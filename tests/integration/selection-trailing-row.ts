// Every run uses a disposable localhost database, never application data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { selectionRowHasContent } from "../../packages/contracts/src/selection-trailing-row.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";
import type { Context } from "../../apps/api/src/core.js";

const root = "postgresql://postgres@127.0.0.1:55433/postgres";
const name = "selection_trailing_row_test_" + Date.now();
const connection = new pg.Client({ connectionString: root });
await connection.connect();
await connection.query(`CREATE DATABASE ${name}`);
await connection.end();
const url = new URL(root);
url.pathname = "/" + name;
Object.assign(process.env, { DATABASE_URL: url.toString(), ADMIN_PASSWORD: "test-" + randomUUID(), SALES_SOURCE: "fixture", AWS_S3_BUCKET_NAME: "" });
await migrate();
const { seed } = await import("../../scripts/seed.js");
await seed();
const { db, one, rows, camel } = await import("../../packages/database/src/index.js");
const s = await import("../../apps/api/src/modules/style-selections/service.js");
const p = await import("../../apps/api/src/modules/style-selections/protection.js");
const { archiveMetadata } = await import("../../apps/api/src/modules/style-selections/archive.js");
const adminId = String((await one(db, "SELECT id FROM users WHERE username='admin'"))!.id);
const context = (id = adminId, roles = ["SUPER_ADMIN"]): Context => ({
  actor: { id, username: "test", displayName: "test", permissions: ["selection.read", "selection.manage", "product.read", "product.update", "product.create"], roleCodes: roles },
  requestId: randomUUID(), key: randomUUID(),
});
const count = async () => Number((await one(db, "SELECT count(*)::int AS count FROM style_selections"))!.count);
const tail = async () => camel((await one(db, "SELECT * FROM style_selections ORDER BY sort_order DESC,id ASC LIMIT 1"))!);
const reset = () => rows(db, "TRUNCATE style_selections CASCADE");
let passed = 0;
const check = (label: string) => { passed++; console.log("PASS", label); };

try {
  assert.equal(await count(), 0);
  await s.list(context(), {});
  assert.equal(await count(), 0);
  let row = await s.write(context(), { ensureTrailingBlank: true });
  row = await s.write(context(), { cellColors: { material: "BLUE" }, ensureTrailingBlank: true }, row.id);
  assert.equal(await count(), 1);
  check("opening an empty table and formatting a blank row do not append");

  const request = context(), body = { material: "羊毛", expectedUpdatedAt: row.updatedAt, ensureTrailingBlank: true };
  row = await s.write(request, body, row.id);
  assert.equal(await count(), 2);
  const blank = await tail();
  assert.equal(selectionRowHasContent(blank), false);
  assert.equal(blank.claimedBy, null);
  assert.equal(blank.sortOrder, row.sortOrder + 1);
  await s.write(request, body, row.id);
  assert.equal(await count(), 2);
  await s.write(context(), { material: "棉", ensureTrailingBlank: true }, row.id);
  assert.equal(await count(), 2);
  check("a successful final-row edit appends once; retries and earlier edits do not");

  await s.write(context(), { vipPrice: "0", ensureTrailingBlank: true }, blank.id);
  assert.equal(await count(), 3);
  await s.write(context(), { labelImages: [{ id: "label", url: "https://example.com/label.jpg" }], ensureTrailingBlank: true }, (await tail()).id);
  assert.equal(await count(), 4);
  await s.write(context(), { extraFields: { "custom:note": "备注" }, ensureTrailingBlank: true }, (await tail()).id);
  assert.equal(await count(), 5);
  await s.write(context(), { extraFields: { "custom:photo": "[]", "custom:note": " " }, ensureTrailingBlank: true }, (await tail()).id);
  assert.equal(await count(), 5);
  check("zero, pictures, and custom text count; cleared images and whitespace do not");

  await reset();
  const first = await s.write(context(), { material: "第一行", sortOrder: 1 });
  await s.write(context(), { material: "第二行", sortOrder: 2, ensureTrailingBlank: true });
  assert.equal(await count(), 3);
  assert.equal((await tail()).sortOrder, 3);
  const visible = await s.list(context(), { q: "第一行", page: 1, pageSize: 1 });
  assert.equal(visible.data.length, 1);
  await s.write(context(), { material: "第一行修改", ensureTrailingBlank: true }, first.id);
  assert.equal(await count(), 3);
  check("paste only requests an append for its final row; a filtered last row cannot append");

  await reset();
  await assert.rejects(() => s.write(context(), { vipPrice: "-1", ensureTrailingBlank: true }));
  assert.equal(await count(), 0);
  const concurrent = await s.write(context(), {});
  const edit = { material: "多人编辑", expectedUpdatedAt: concurrent.updatedAt, ensureTrailingBlank: true };
  const results = await Promise.allSettled([s.write(context(), edit, concurrent.id), s.write(context(), edit, concurrent.id)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(await count(), 2);
  check("a failed save adds nothing; concurrent edits keep one blank and report the conflict");

  await reset();
  await Promise.all([
    s.write(context(), { material: "甲", sortOrder: 1, ensureTrailingBlank: true }),
    s.write(context(), { material: "乙", sortOrder: 1, ensureTrailingBlank: true }),
  ]);
  assert.equal(await count(), 3);
  assert.equal(selectionRowHasContent(await tail()), false);
  check("concurrent new rows share one trailing blank");

  await reset();
  const buyerId = String((await one(db, "INSERT INTO users(username,display_name,password_hash) VALUES('trailing-buyer','test','unused') RETURNING id"))!.id);
  await rows(db, "INSERT INTO user_roles(user_id,role_id) SELECT $1::bigint,id FROM roles WHERE code='BUYER'", buyerId);
  const protectedRow = await s.write(context(), {});
  const settings = await p.readSettings(context());
  await p.saveSettings(context(), {
    revision: settings.revision,
    settings: { ...defaultProtection, enabled: true, claimsEnabled: false, regions: [{ id: randomUUID(), name: "只读列", scope: "columns", rowIds: [], columnKeys: ["supplierCode"], users: {}, others: "read" }] },
  });
  const saved = await s.write(context(buyerId, ["BUYER"]), { material: "允许编辑", ensureTrailingBlank: true }, protectedRow.id);
  assert.equal(saved.material, "允许编辑");
  assert.equal(await count(), 1);
  check("protected creation skips the blank while preserving an authorized edit");

  const table = await one(db, "INSERT INTO project_tables(name,created_by,initial_layout) VALUES('trailing-test',$1::bigint,'empty') RETURNING id", adminId);
  await rows(db, "SELECT create_project_table_workspace($1::bigint)::text", table!.id);
  await selectionScope.run(String(table!.id), async () => {
    assert.equal(await count(), 0);
    await s.write(context(), { extraFields: { "custom:text": "新表内容" }, ensureTrailingBlank: true });
    assert.equal(await count(), 2);
    assert.equal(selectionRowHasContent(await tail()), false);
  });
  assert.equal(await count(), 1);
  check("project tables append in their own workspace without touching selections");

  const archive = await archiveMetadata(context());
  const productCount = Number((await one(db, "SELECT count(*)::int AS count FROM products"))!.count);
  await selectionScope.run(String(archive.id), async () => {
    await reset();
    const draft = await s.write(context(), {});
    const editor = context();
    editor.actor.permissions = editor.actor.permissions.filter(permission => permission !== "product.create");
    await s.write(editor, { extraFields: { "custom:text": "编辑草稿" }, ensureTrailingBlank: true }, draft.id);
    assert.equal(await count(), 1);
    await s.write(context(), { extraFields: { "custom:text": "继续填写" }, ensureTrailingBlank: true }, draft.id);
    assert.equal(await count(), 2);
    assert.equal((await tail()).productId, null);
  });
  assert.equal(Number((await one(db, "SELECT count(*)::int AS count FROM products"))!.count), productCount);
  check("archive append requires product creation rights and never creates a product from a blank");
  console.log(`Passed ${passed} trailing-row integration scenarios`);
} finally {
  await db.$disconnect();
  const cleanup = new pg.Client({ connectionString: root });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await cleanup.end();
}

// Isolated localhost database only. Never run against an application database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
const root = "postgresql://postgres@127.0.0.1:55433/postgres",
  name = "selection_protection_test_" + Date.now();
const adminDb = new pg.Client({ connectionString: root });
await adminDb.connect();
await adminDb.query(`CREATE DATABASE ${name}`);
await adminDb.end();
const testUrl = new URL(root);
testUrl.pathname = "/" + name;
process.env.DATABASE_URL = testUrl.toString();
process.env.AWS_S3_BUCKET_NAME = "";
process.env.ADMIN_PASSWORD = "test-" + randomUUID();
process.env.SALES_SOURCE = "fixture";
await migrate();
const { seed } = await import("../../scripts/seed.js");
await seed();
const { db, one, rows, camel } =
  await import("../../packages/database/src/index.js");
const { passwordHash } = await import("../../apps/api/src/core.js");
const p =
  await import("../../apps/api/src/modules/style-selections/protection.js");
const s =
  await import("../../apps/api/src/modules/style-selections/service.js");
const collections =
  await import("../../apps/api/src/modules/style-selections/collections.js");
const { selectionScope } = await import("../../packages/database/src/selection-scope.js");
const { defaultProtection } =
  await import("../../packages/contracts/src/selection-protection.js");
type Context = import("../../apps/api/src/core.js").Context;
const makeContext = (id: string, roles: string[]): Context => ({
  actor: {
    id,
    username: "test",
    displayName: "test",
    permissions: ["selection.read", "selection.manage"],
    roleCodes: roles,
  },
  requestId: randomUUID(),
  key: randomUUID(),
});
const admin = makeContext(
  String((await one(db, "SELECT id FROM users WHERE username='admin'"))!.id),
  ["SUPER_ADMIN"],
);
async function user(username: string) {
  const value = await one(
    db,
    "INSERT INTO users(username,display_name,password_hash) VALUES($1,$1,$2) RETURNING id",
    username,
    passwordHash(randomUUID()),
  );
  await rows(
    db,
    "INSERT INTO user_roles(user_id,role_id) SELECT $1::bigint,id FROM roles WHERE code='BUYER'",
    value!.id,
  );
  return makeContext(String(value!.id), ["BUYER"]);
}
const a = await user("protection-a"),
  b = await user("protection-b");
const fresh = (c: Context) => ({ ...c, key: randomUUID() });
let passed = 0;
function check(label: string) {
  passed++;
  console.log("PASS", label);
}
async function forbidden(run: () => Promise<any>) {
  await assert.rejects(run, (error) => (error as any).getStatus?.() === 403);
}
async function settings(value: any) {
  const old = await p.readSettings(admin);
  return p.saveSettings(fresh(admin), {
    settings: value,
    revision: old.revision,
  });
}
try {
  const legacy = { enabled: false, claimsEnabled: false, autoHide: true, hiddenReaders: [], regions: [] };
  await rows(db, "UPDATE style_selection_protection SET settings=$1::jsonb WHERE id=1", JSON.stringify(legacy));
  assert.equal((await p.policy(db)).settings.autoHideRegions[0].scope, "sheet");
  const legacyTable = await one(db, "INSERT INTO project_tables(name,created_by) VALUES('legacy-auto-hide',$1::bigint) RETURNING id", admin.actor.id);
  await rows(db, "SELECT create_project_table_workspace($1::bigint)::text", legacyTable!.id);
  await selectionScope.run(String(legacyTable!.id), async () => {
    await rows(db, "UPDATE style_selection_protection SET settings=$1::jsonb WHERE id=1", JSON.stringify({ ...legacy, autoHide: false }));
    assert.deepEqual((await p.policy(db)).settings.autoHideRegions, []);
  });
  await db.$executeRawUnsafe(await readFile("packages/database/migrations/057_selection_auto_hide_regions.sql", "utf8"));
  const migrated = await one(db, "SELECT settings FROM style_selection_protection WHERE id=1");
  assert.equal(migrated!.settings.autoHideRegions[0].scope, "sheet");
  await selectionScope.run(String(legacyTable!.id), async () => {
    assert.deepEqual((await one(db, "SELECT settings FROM style_selection_protection WHERE id=1"))!.settings.autoHideRegions, []);
  });
  const futureTable = await one(db, "INSERT INTO project_tables(name,created_by) VALUES('new-auto-hide',$1::bigint) RETURNING id", admin.actor.id);
  await rows(db, "SELECT create_project_table_workspace($1::bigint)::text", futureTable!.id);
  await selectionScope.run(String(futureTable!.id), async () => {
    assert.deepEqual((await one(db, "SELECT settings FROM style_selection_protection WHERE id=1"))!.settings.autoHideRegions, []);
  });
  await settings(defaultProtection);
  check("legacy enabled / disabled policies migrate in every workspace and future tables start with no auto-hide area");
  for (const key of ["custom:secret","custom:public"])
    await rows(db,"INSERT INTO public.selection_field_registry(workspace_key,field_key,visibility,definition) VALUES('default',$1,'PUBLIC',$2::jsonb)",key,JSON.stringify({key,label:key,width:120,custom:true,type:"text"}));
  const image = (
    await s.uploadImage(fresh(admin), {
      data: "data:image/jpeg;base64,/9j/AA==",
    })
  ).url;
  const first = camel(
    await s.write(fresh(a), {
      xutiStyleNo: "PROTECTED-1",
      supplierStyleNo: "SUP-SECRET",
      color: "白",
      material: "SECRET-CONTENT",
      images: [{ id: "photo-1", url: image, color: "白" }],
      extraFields: {
        "custom:secret": "SECRET-CUSTOM",
        "custom:public": "hello",
      },
    }),
  );
  const second = camel(
    await s.write(fresh(admin), { xutiStyleNo: "PROTECTED-2", color: "白" }),
  );
  const cachedContext = fresh(b),
    cacheBody = { supplierCode: "before-protection" };
  await s.write(cachedContext, cacheBody, first.id);
  const metadata = await s.photoDetail(admin, first.id);
  assert.equal(metadata.createdBy, a.actor.id);
  assert.equal(metadata.updatedBy, b.actor.id);
  assert.equal(metadata.createdByUsername, "protection-a");
  assert.equal(metadata.updatedByUsername, "protection-b");
  const share = camel(
    await collections.create(fresh(a), {
      title: "permission share",
      ids: [first.id],
      days: 7,
    }),
  );
  const deniedKeys = ["supplierStyleNo", "material", "images", "custom:secret"];
  let region = {
    id: randomUUID(),
    name: "Restricted",
    scope: "cells",
    rowIds: [first.id],
    columnKeys: deniedKeys,
    users: { [a.actor.id]: "edit" },
    others: "deny",
  };
  await settings({ ...defaultProtection, enabled: true, regions: [region] });
  await forbidden(() =>
    p.saveSettings(fresh(b), { settings: defaultProtection, revision: 1 }),
  );
  check("administrator-only settings and selectable per-user grants");
  const detail = await s.photoDetail(b, first.id);
  assert.equal(detail.material, null);
  assert.equal(detail.extraFields["custom:secret"], "");
  assert.equal(detail.extraFields["custom:public"], "hello");
  assert.deepEqual(detail.images, []);
  assert.equal(detail.cellAccess.material, "deny");
  assert.ok(!JSON.stringify(detail).includes("SECRET"));
  const sync = JSON.parse(await s.sync(b, {}));
  assert.ok(!JSON.stringify(sync).includes("SECRET"));
  const adminSync = JSON.parse(await s.sync(admin, {}));
  assert.ok(JSON.stringify(adminSync).includes("SECRET-CONTENT"));
  assert.equal((await s.list(b, { q: "SECRET" })).total, 0);
  await forbidden(() => s.readImage(b, image.split("/").at(-1)!, true));
  await s.readImage(a, image.split("/").at(-1)!, true);
  check(
    "redaction, per-actor sync, projected search and direct image / ETag access",
  );
  await forbidden(() => s.write(fresh(b), { material: "bypass" }, first.id));
  await forbidden(() =>
    s.write(fresh(b), { extraFields: { "custom:secret": "bypass" } }, first.id),
  );
  await forbidden(() =>
    s.write(fresh(b), { cellColors: { material: "GREEN" } }, first.id),
  );
  await forbidden(() => s.remove(fresh(b), first.id));
  await forbidden(() =>
    s.changePhoto(fresh(b), first.id, { action: "remove", imageId: "photo-1" }),
  );
  await forbidden(() =>
    s.previewImport(b, {
      rows: [{ xutiStyleNo: "PROTECTED-1", material: "bypass" }],
    }),
  );
  await s.write(
    fresh(b),
    {
      extraFields: { "custom:public": "updated" },
      cellColors: { "custom:public": "GREEN" },
    },
    first.id,
  );
  assert.equal(
    (await s.photoDetail(a, first.id)).extraFields["custom:secret"],
    "SECRET-CUSTOM",
  );
  assert.equal(
    (await s.photoDetail(a, first.id)).extraFields["custom:public"],
    "updated",
  );
  check(
    "PATCH / maps / formatting / Delete / camera / import enforcement; partial map writes preserve hidden cells",
  );
  const known = Object.fromEntries(
    sync.index.map((row: any) => [row.id, row.token]),
  );
  const oldRevision = (await s.revision(b))!.revision;
  region = {
    ...region,
    columnKeys: [...deniedKeys, "supplierCode"],
    users: {},
  };
  await settings({ ...defaultProtection, enabled: true, regions: [region] });
  await forbidden(() => s.write(cachedContext, cacheBody, first.id));
  const delta = JSON.parse(await s.sync(b, { known }));
  assert.ok(delta.data.some((row: any) => row.id === first.id));
  assert.notEqual(oldRevision, (await s.revision(b))!.revision);
  await forbidden(() => collections.publicDetail(share.token));
  await forbidden(() => collections.detail(b, share.id));
  check(
    "revocation invalidates known tokens, cached commands and existing anonymous collection shares",
  );
  await assert.rejects(() => settings({ ...defaultProtection, autoHide: true }), (error) => (error as any).getStatus?.() === 400);
  const hideArea = { id: randomUUID(), name: "Filled material and photos", scope: "columns", rowIds: [], columnKeys: ["material", "images", "custom:secret"] };
  await settings({ ...defaultProtection, autoHide: true, autoHideRegions: [hideArea] });
  assert.equal((await s.photoDetail(a, first.id)).material, "SECRET-CONTENT");
  assert.equal((await s.photoDetail(b, first.id)).material, null);
  assert.equal((await s.photoDetail(b, first.id)).supplierStyleNo, "SUP-SECRET");
  assert.equal((await s.photoDetail(b, first.id)).extraFields["custom:secret"], "");
  assert.deepEqual((await s.photoDetail(b, first.id)).images, []);
  assert.deepEqual((await p.readSettings(b)).settings.autoHideRegions, []);
  await forbidden(() => s.readImage(b, image.split("/").at(-1)!, true));
  await s.readImage(a, image.split("/").at(-1)!, true);
  await s.write(fresh(b), { material: "first-filler" }, second.id);
  assert.equal((await s.photoDetail(b, second.id)).material, "first-filler");
  assert.equal((await s.photoDetail(a, second.id)).material, null);
  await settings({
    ...defaultProtection,
    autoHide: true,
    autoHideRegions: [hideArea],
    hiddenReaders: [a.actor.id],
  });
  assert.equal((await s.photoDetail(a, second.id)).material, "first-filler");
  check(
    "scoped automatic hiding enforces values / photos and follows row author / field filler / designated readers",
  );
  await settings({ ...defaultProtection, autoHide: true, autoHideRegions: [{ ...hideArea, scope: "cells", rowIds: [first.id], columnKeys: ["material"] }] });
  assert.equal((await s.photoDetail(b, first.id)).material, null);
  assert.equal((await s.photoDetail(b, first.id)).supplierStyleNo, "SUP-SECRET");
  assert.equal((await s.photoDetail(a, second.id)).material, "first-filler");
  await settings({ ...defaultProtection, autoHide: true, autoHideRegions: [{ ...hideArea, scope: "rows", rowIds: [first.id], columnKeys: [] }] });
  assert.equal((await s.photoDetail(b, first.id)).material, null);
  assert.equal((await s.photoDetail(b, first.id)).supplierStyleNo, null);
  assert.equal((await s.photoDetail(b, first.id)).supplierCode, "before-protection");
  assert.equal((await s.photoDetail(a, second.id)).material, "first-filler");
  await settings({ ...defaultProtection, autoHide: true, autoHideRegions: [{ ...hideArea, scope: "sheet", rowIds: [], columnKeys: [] }] });
  assert.equal((await s.photoDetail(a, second.id)).material, null);
  await settings({ ...defaultProtection, autoHide: true, autoHideRegions: [hideArea], hiddenReaders: [b.actor.id], enabled: true, regions: [{ ...region, columnKeys: ["material"], users: {}, others: "deny" }] });
  assert.equal((await s.photoDetail(b, first.id)).material, null);
  assert.equal((await s.photoDetail(a, first.id)).material, null);
  assert.equal((await s.photoDetail(admin, first.id)).material, "SECRET-CONTENT");
  check("cell / row / explicit sheet areas retain outside access and designated readers never override DENY");
  await settings({ ...defaultProtection, claimsEnabled: true });
  const empty = await s.write(fresh(b), {});
  assert.equal(empty.claimedBy, null);
  const anotherEmpty = await s.write(fresh(b), {});
  assert.equal(anotherEmpty.claimedBy, null);
  const claims = await Promise.allSettled([
    p.claim(fresh(a), first.id, { action: "claim" }),
    p.claim(fresh(b), first.id, { action: "claim" }),
  ]);
  assert.equal(
    claims.filter((result) => result.status === "fulfilled").length,
    1,
    JSON.stringify(
      claims.map((result) =>
        result.status === "rejected" ? String(result.reason) : "success",
      ),
    ),
  );
  const owner = (await one(
    db,
    "SELECT claimed_by FROM style_selections WHERE id=$1::bigint",
    first.id,
  ))!.claimed_by.toString();
  const winner = owner === a.actor.id ? a : b,
    loser = owner === a.actor.id ? b : a;
  await forbidden(() => s.write(fresh(loser), { material: "wrong" }, first.id));
  await assert.rejects(
    () => s.write(fresh(winner), { xutiStyleNo: "OWNED-NEW" }),
    (error) => (error as any).getStatus?.() === 409,
  );
  await assert.rejects(
    () => p.claim(fresh(winner), second.id, { action: "claim" }),
    (error) => (error as any).getStatus?.() === 409,
  );
  await forbidden(() => p.claim(fresh(loser), first.id, { action: "release" }));
  await p.claim(fresh(admin), first.id, { action: "release" });
  await s.write(fresh(loser), { material: "auto claim" }, first.id);
  assert.equal(
    (await s.photoDetail(loser, first.id)).claimedBy,
    loser.actor.id,
  );
  await p.claim(fresh(loser), first.id, { action: "release" });
  await p.claim(fresh(loser), second.id, { action: "claim" });
  check(
    "concurrent claims, one active row per user, first-write claim and administrator release",
  );
  const before = (await p.readSettings(admin)).revision;
  const changes = await Promise.allSettled([
    p.saveSettings(fresh(admin), {
      settings: defaultProtection,
      revision: before,
    }),
    p.saveSettings(fresh(admin), {
      settings: { ...defaultProtection, enabled: true },
      revision: before,
    }),
  ]);
  assert.equal(
    changes.filter((value) => value.status === "fulfilled").length,
    1,
  );
  await settings({
    ...defaultProtection,
    enabled: true,
    regions: [
      {
        ...region,
        scope: "sheet",
        rowIds: [],
        columnKeys: [],
        users: {},
        others: "read",
      },
    ],
  });
  await forbidden(() => s.write(fresh(b), { xutiStyleNo: "NEW-BYPASS" }));
  check(
    "administrator CAS conflicts and whole-sheet protection covers new rows",
  );
  const tableAdminUser = await user("protection-table-admin");
  await rows(db, "DELETE FROM user_roles WHERE user_id=$1::bigint", tableAdminUser.actor.id);
  await rows(db, "INSERT INTO user_roles(user_id,role_id) SELECT $1::bigint,id FROM roles WHERE code='ADMIN'", tableAdminUser.actor.id);
  await rows(db, "INSERT INTO project_library_acl(kind,resource_id,user_id,access,created_by) VALUES('table',$1::bigint,$2::bigint,'EDIT',$3::bigint)", futureTable!.id, tableAdminUser.actor.id, admin.actor.id);
  const scopedAdmin: Context = { ...tableAdminUser, actor: { ...tableAdminUser.actor, roleCodes: ["ADMIN"], selectionWorkspaceScoped: true } };
  await selectionScope.run(String(futureTable!.id), async () => {
    const tableRow = await s.write(fresh(admin), { xutiStyleNo: "TABLE-SHARE", material: "TABLE-PRIVATE-CONTENT" });
    const tableShare = await collections.create(fresh(scopedAdmin), { title: "scoped admin share", ids: [tableRow.id], days: 7 });
    await collections.publicDetail(tableShare.token);
    await settings({ ...defaultProtection, autoHide: true, autoHideRegions: [{ id: randomUUID(), name: "shared material", scope: "columns", rowIds: [], columnKeys: ["material"] }] });
    await forbidden(() => collections.publicDetail(tableShare.token));
    await settings({ ...defaultProtection, enabled: true, regions: [{ ...region, scope: "columns", rowIds: [], columnKeys: ["material"], users: {}, others: "deny" }] });
    await forbidden(() => collections.publicDetail(tableShare.token));
    await settings(defaultProtection);
    await collections.publicDetail(tableShare.token);
    await rows(db, "UPDATE public.project_library_acl SET access='READ' WHERE kind='table' AND resource_id=$1::bigint AND user_id=$2::bigint", futureTable!.id, tableAdminUser.actor.id);
    await forbidden(() => collections.publicDetail(tableShare.token));
    await rows(db, "UPDATE public.project_library_acl SET access='DENY' WHERE kind='table' AND resource_id=$1::bigint AND user_id=$2::bigint", futureTable!.id, tableAdminUser.actor.id);
    await assert.rejects(() => collections.publicDetail(tableShare.token), (error) => (error as any).getStatus?.() === 404);
  });
  check("anonymous table shares honor current scoped ADMIN hide / region rules and revoked EDIT / viewing grants");
  console.log(`Passed ${passed} selection protection integration scenarios`);
} finally {
  await db.$disconnect();
  const cleanup = new pg.Client({ connectionString: root });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await cleanup.end();
}

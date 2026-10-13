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
async function capabilityUser(username: string, permissions: string[]) {
  const context = await user(username);
  const roleCode = "PROTECTION_TEST_" + context.actor.id;
  const role = await one(db, "INSERT INTO roles(code,name) VALUES($1,$1) RETURNING id", roleCode);
  await rows(db, "DELETE FROM user_roles WHERE user_id=$1::bigint", context.actor.id);
  await rows(db, "INSERT INTO user_roles(user_id,role_id) VALUES($1::bigint,$2::bigint)", context.actor.id, role!.id);
  await rows(db, "INSERT INTO role_permissions(role_id,permission_id) SELECT $1::bigint,id FROM permissions WHERE code=ANY($2::text[])", role!.id, permissions);
  return { ...context, actor: { ...context.actor, permissions, roleCodes: [roleCode] } };
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
  const moduleReader = await capabilityUser("protection-module-reader", ["selection.read"]);
  const moduleEditor = await capabilityUser("protection-module-editor", ["selection.read", "selection.manage"]);
  const defaultUsers = await p.users(admin);
  assert.equal(defaultUsers.find(person => String(person.id) === moduleReader.actor.id)!.can_edit, false);
  assert.equal(defaultUsers.find(person => String(person.id) === moduleReader.actor.id)!.edit_block_reason, "账号没有选款登记编辑权限");
  assert.equal(defaultUsers.find(person => String(person.id) === moduleEditor.actor.id)!.can_edit, true);
  assert.equal(defaultUsers.find(person => String(person.id) === moduleEditor.actor.id)!.edit_block_reason, null);
  await forbidden(() => p.users(moduleEditor));
  check("protection user options distinguish actual default-module read and edit rights");
  const projectReader = await capabilityUser("protection-project-reader", ["project.read"]);
  const projectEditor = await capabilityUser("protection-project-editor", ["project.read"]);
  const projectDenied = await capabilityUser("protection-project-denied", ["project.read"]);
  const inheritedEditor = await capabilityUser("protection-project-inherited", []);
  for (const [person, access] of [[projectReader, "READ"], [projectEditor, "EDIT"], [projectDenied, "DENY"], [inheritedEditor, "EDIT"]] as const)
    await rows(db, "INSERT INTO public.project_library_acl(kind,resource_id,user_id,access,created_by) VALUES('table',$1::bigint,$2::bigint,$3,$4::bigint)", futureTable!.id, person.actor.id, access, admin.actor.id);
  await selectionScope.run(String(futureTable!.id), async () => {
    const options = await p.users(admin);
    const option = (context: Context) => options.find(person => String(person.id) === context.actor.id)!;
    assert.equal(option(projectReader).can_edit, false);
    assert.equal(option(projectReader).edit_block_reason, "账号只有本表查看权限");
    assert.equal(option(projectEditor).can_edit, true);
    assert.equal(option(projectEditor).can_manage, false);
    assert.equal(option(projectDenied).can_edit, false);
    assert.equal(option(projectDenied).edit_block_reason, "账号没有本表查看权限");
    assert.equal(option(inheritedEditor).can_edit, true);
  });
  check("protection user options honor project-table READ / EDIT / DENY and inherited table grants");
  const archiveReader = await capabilityUser("protection-archive-reader", ["product.read"]);
  const archiveEditor = await capabilityUser("protection-archive-editor", ["product.read", "product.update"]);
  const archiveTable = await one(db, "INSERT INTO project_tables(name,created_by,system_key) VALUES('protection-archive',$1::bigint,'PRODUCT_ARCHIVE') RETURNING id", admin.actor.id);
  await rows(db, "SELECT create_project_table_workspace($1::bigint)::text", archiveTable!.id);
  // An explicit table EDIT grant must not create the missing product.update permission.
  await rows(db, "INSERT INTO public.project_library_acl(kind,resource_id,user_id,access,created_by) VALUES('table',$1::bigint,$2::bigint,'EDIT',$3::bigint)", archiveTable!.id, archiveReader.actor.id, admin.actor.id);
  await selectionScope.run(String(archiveTable!.id), async () => {
    const options = await p.users(admin);
    assert.equal(options.find(person => String(person.id) === archiveReader.actor.id)!.can_edit, false);
    assert.equal(options.find(person => String(person.id) === archiveReader.actor.id)!.edit_block_reason, "账号没有商品档案编辑权限");
    assert.equal(options.find(person => String(person.id) === archiveEditor.actor.id)!.can_edit, true);
  });
  check("protection user options cap archive table grants by product.update");
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
  const privateKey = "custom:local-private";
  await rows(db, "INSERT INTO public.selection_field_registry(workspace_key,field_key,owner_id,visibility,definition) VALUES('default',$1,$2::bigint,'PRIVATE',$3::jsonb)", privateKey, a.actor.id, JSON.stringify({ key: privateKey, label: "Private local", width: 120, custom: true, type: "text" }));
  const localRow = await s.write(fresh(a), {
    xutiStyleNo: "LOCAL-EDIT-EXCEPTION", color: "白", material: "outside-local",
    images: [{ id: "local-photo", url: image, color: "白" }],
    extraFields: { "custom:public": "local-before", [privateKey]: "private-before" },
  });
  const sheetDefaultRead = { id: randomUUID(), name: "Whole sheet default read", scope: "sheet", rowIds: [], columnKeys: [], users: { [admin.actor.id]: "edit" }, others: "read" };
  const localEdit = { id: randomUUID(), name: "Named local editor", scope: "cells", rowIds: [localRow.id], columnKeys: ["images", "custom:public", privateKey], users: { [b.actor.id]: "edit" }, others: "read" };
  await settings({ ...defaultProtection, enabled: true, regions: [sheetDefaultRead, localEdit] });
  const localProjection = await s.photoDetail(b, localRow.id);
  assert.equal(localProjection.cellAccess.images, "edit");
  assert.equal(localProjection.cellAccess["custom:public"], "edit");
  assert.equal(localProjection.cellAccess.material, "read");
  assert.ok(!Object.hasOwn(localProjection.extraFields, privateKey));
  assert.ok(!Object.hasOwn(localProjection.cellAccess, privateKey));
  await s.write(fresh(b), { extraFields: { "custom:public": "local-after" } }, localRow.id);
  await s.changePhoto(fresh(b), localRow.id, { action: "remove", imageId: "local-photo" });
  assert.deepEqual((await s.photoDetail(b, localRow.id)).images, []);
  await s.changePhoto(fresh(b), localRow.id, { action: "add", image: { id: "local-photo-added", url: image, color: "白" } });
  assert.equal((await s.photoDetail(b, localRow.id)).images[0].id, "local-photo-added");
  assert.equal((await s.photoDetail(b, localRow.id)).extraFields["custom:public"], "local-after");
  await forbidden(() => s.write(fresh(b), { material: "outside-bypass" }, localRow.id));
  await forbidden(() => s.write(fresh(b), { extraFields: { "custom:public": "other-row-bypass" } }, first.id));
  await forbidden(() => s.write(fresh(a), { extraFields: { "custom:public": "not-designated" } }, localRow.id));
  await forbidden(() => s.write(fresh(b), { extraFields: { [privateKey]: "private-bypass" } }, localRow.id));
  await settings({ ...defaultProtection, enabled: true, regions: [sheetDefaultRead, localEdit,
    { ...localEdit, id: randomUUID(), columnKeys: ["images"], users: {}, others: "deny" },
  ] });
  assert.equal((await s.photoDetail(b, localRow.id)).cellAccess.images, "deny");
  assert.deepEqual((await s.photoDetail(b, localRow.id)).images, []);
  await forbidden(() => s.changePhoto(fresh(b), localRow.id, { action: "remove", imageId: "local-photo-added" }));
  await settings(defaultProtection);
  await s.remove(fresh(admin), localRow.id);
  check("named local edit overrides only whole-sheet default read for real image and custom-field writes; outside / unnamed / DENY / private-field restrictions remain");
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
      existingStrategy: "OVERWRITE",
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

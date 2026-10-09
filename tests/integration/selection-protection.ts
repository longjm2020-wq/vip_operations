// Isolated localhost database only. Never run against an application database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  await settings({ ...defaultProtection, autoHide: true });
  assert.equal((await s.photoDetail(a, first.id)).material, "SECRET-CONTENT");
  assert.equal((await s.photoDetail(b, first.id)).material, null);
  await s.write(fresh(b), { material: "first-filler" }, second.id);
  assert.equal((await s.photoDetail(b, second.id)).material, "first-filler");
  assert.equal((await s.photoDetail(a, second.id)).material, null);
  await settings({
    ...defaultProtection,
    autoHide: true,
    hiddenReaders: [a.actor.id],
  });
  assert.equal((await s.photoDetail(a, second.id)).material, "first-filler");
  check(
    "automatic hiding follows row author / field filler / designated readers",
  );
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
  console.log(`Passed ${passed} selection protection integration scenarios`);
} finally {
  await db.$disconnect();
  const cleanup = new pg.Client({ connectionString: root });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await cleanup.end();
}

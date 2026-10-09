// Disposable localhost database only. Never target application or production data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";
import type { Context } from "../../apps/api/src/core.js";
import type { Row } from "../../packages/database/src/index.js";

const rootUrl = "postgresql://postgres@127.0.0.1:55433/postgres";
const databaseName = "selection_field_visibility_" + Date.now();
const connection = new pg.Client({ connectionString: rootUrl });
await connection.connect();
await connection.query(`CREATE DATABASE ${databaseName}`);
await connection.end();
const url = new URL(rootUrl);
url.pathname = "/" + databaseName;
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  ADMIN_PASSWORD: "test-" + randomUUID(),
  SALES_SOURCE: "fixture",
  AWS_S3_BUCKET_NAME: "",
});
await migrate();
const { seed } = await import("../../scripts/seed.js");
await seed();
const { db, one, rows, camel } = await import("../../packages/database/src/index.js");
const service = await import("../../apps/api/src/modules/style-selections/service.js");
const protection = await import("../../apps/api/src/modules/style-selections/protection.js");
const collections = await import("../../apps/api/src/modules/style-selections/collections.js");
const auditLogs = await import("../../apps/api/src/modules/audit/service.js");
const { audit } = await import("../../apps/api/src/core.js");

const context = (id: string, permissions: string[], roleCodes: string[]): Context => ({
  actor: { id, username: "fixture", displayName: "fixture", permissions, roleCodes },
  requestId: randomUUID(),
  key: randomUUID(),
});
const adminId = String((await one(db, "SELECT id FROM users WHERE username='admin'"))!.id);
const admin = context(adminId, ["selection.read", "selection.manage"], ["SUPER_ADMIN"]);
const fresh = (value: Context) => ({ ...value, key: randomUUID() });
const serialized = (value: unknown) => JSON.stringify(value, (_key,item)=>typeof item === "bigint" ? String(item) : item);
let passed = 0;
const check = (description: string) => { passed++; console.log("PASS", description); };
const rejected = async (work: () => Promise<unknown>, status = 403) => {
  await assert.rejects(work, (error: { getStatus?: () => number }) => error.getStatus?.() === status);
};
async function createActor(username: string, roleCode = "BUYER") {
  const user = await one(db,
    "INSERT INTO users(username,display_name,password_hash) VALUES($1,$1,'unused-test-password') RETURNING id",
    username);
  await rows(db, "INSERT INTO user_roles(user_id,role_id) SELECT $1::bigint,id FROM roles WHERE code=$2", user!.id, roleCode);
  const permissions = await rows(db,
    "SELECT DISTINCT p.code FROM permissions p JOIN role_permissions rp ON rp.permission_id=p.id JOIN roles r ON r.id=rp.role_id WHERE r.code=$1",
    roleCode);
  return context(String(user!.id), permissions.map(row => row.code), [roleCode]);
}
async function registerField(key: string, ownerId: string | null, visibility: "PRIVATE" | "PUBLIC" = "PRIVATE", type = "text") {
  const workspace = selectionScope.getStore() || "default";
  await rows(db,
    `INSERT INTO public.selection_field_registry(workspace_key,table_id,field_key,owner_id,visibility,definition)
     VALUES($1,$2::bigint,$3,$4::bigint,$5,$6::jsonb)`,
    workspace, workspace === "default" ? null : workspace, key, ownerId, visibility,
    JSON.stringify({ key, label: "测试字段", width: 120, custom: true, type }));
}
async function changeVisibility(key: string, publicField: boolean) {
  await rows(db,
    "UPDATE public.selection_field_registry SET visibility=$3,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_key=$1 AND field_key=$2",
    selectionScope.getStore() || "default", key, publicField ? "PUBLIC" : "PRIVATE");
}
async function setProtection(settings: unknown) {
  const current = await protection.readSettings(admin);
  await protection.saveSettings(fresh(admin), { settings, revision: current.revision });
}
const maps = ["extraFields", "cellColors", "cellAlignments", "cellVerticalAlignments", "cellTextColors", "cellNumberFormats", "cellAccess"];
function omitted(row: Row, key: string) {
  for (const map of maps) assert.equal(Object.hasOwn(row[map] || {}, key), false, `${map} disclosed ${key}`);
  assert.equal((row.hiddenCells || []).includes(key), false);
}

try {
  const owner = await createActor("visibility-owner");
  const other = await createActor("visibility-other");
  const ordinaryAdmin = await createActor("visibility-ordinary-admin", "ADMIN");
  const reader = context(other.actor.id, ["selection.read"], ["BUYER"]);
  await rows(db, "DELETE FROM public.selection_field_registry WHERE workspace_key='default' AND visibility='PRIVATE'");
  const fastRow = await service.write(fresh(admin), { xutiStyleNo: "VISIBILITY-FAST", material: "normal public material" });
  await rows(db,
    "UPDATE style_selections SET extra_fields=$2::jsonb,cell_colors=$3::jsonb WHERE id=$1::bigint",
    fastRow.id, JSON.stringify({ "custom:orphan": "ORPHAN-FAST", plaintext: "ORPHAN-PLAIN" }),
    JSON.stringify({ "custom:orphan": "BLUE", plaintext: "GREEN" }));
  assert.equal(protection.activePolicy(await protection.policy(db)), false);
  const fastList = await service.list(other, {});
  const fastSync = JSON.parse(await service.sync(other, {}));
  for (const projected of [fastList.data[0], fastSync.data[0], await service.photoDetail(admin, fastRow.id)]) {
    omitted(projected, "custom:orphan");
    omitted(projected, "plaintext");
    assert.equal(JSON.stringify(projected).includes("ORPHAN"), false);
  }
  const fastShare = await collections.create(fresh(owner), { title: "fast allowlist", ids: [fastRow.id], days: 7 });
  assert.equal(JSON.stringify(camel(await collections.publicDetail(fastShare.token))).includes("ORPHAN"), false);
  await rows(db, "DELETE FROM selection_collection_events WHERE collection_id=$1::bigint", fastShare.id);
  await rows(db, "DELETE FROM selection_collections WHERE id=$1::bigint", fastShare.id);
  await rows(db, "DELETE FROM style_selections WHERE id=$1::bigint", fastRow.id);
  check("fast list and sync paths scrub orphan extras even without any registered private fields");

  const privateText = "custom:private:text";
  const privatePhoto = "custom:private:photo";
  const publicText = "custom:public:text";
  await registerField(privateText, owner.actor.id);
  await registerField(privatePhoto, owner.actor.id, "PRIVATE", "image");
  await registerField(publicText, owner.actor.id, "PUBLIC");

  // Each readable role can own a registered field; row editing remains governed
  // by its existing selection.manage permission, rather than field visibility.
  const readableRoles = await rows(db,
    `SELECT r.code FROM roles r JOIN role_permissions rp ON rp.role_id=r.id
     JOIN permissions p ON p.id=rp.permission_id WHERE p.code='selection.read' ORDER BY r.code`);
  assert.ok(readableRoles.length);
  const blank = await service.write(fresh(admin), {});
  for (const [index, role] of readableRoles.entries()) {
    const actor = await createActor(`visibility-role-${index}`, role.code);
    const key = `custom:role:${index}`;
    await registerField(key, actor.actor.id);
    const own = await service.photoDetail(actor, blank.id);
    assert.equal(own.cellAccess[key], actor.actor.permissions.includes("selection.manage") ? "edit" : "read");
    omitted(await service.photoDetail(other, blank.id), key);
  }
  check("every readable role can own an empty private field without granting row-edit permissions");

  const imageUrl = (await service.uploadImage(fresh(owner), { data: "data:image/jpeg;base64,/9j/AA==" })).url;
  const imageId = imageUrl.split("/").at(-1)!;
  const value = "PRIVATE-TEXT-CONTENT";
  let row = await service.write(fresh(owner), {
    xutiStyleNo: "VISIBILITY-1",
    extraFields: {
      [privateText]: value,
      [privatePhoto]: JSON.stringify([{ id: imageId, url: imageUrl, color: "" }]),
      [publicText]: "PUBLIC-CONTENT",
    },
    cellColors: { [privateText]: "BLUE", [publicText]: "GREEN" },
    cellAlignments: { [privateText]: "left" },
    cellVerticalAlignments: { [privateText]: "top" },
    cellTextColors: { [privateText]: "#cf1322" },
    cellNumberFormats: { [privateText]: { type: "number", decimals: 2 } },
  });
  assert.equal(row.extraFields[privateText], value);
  assert.equal(row.cellAccess[privateText], "edit");
  const readOnlyOwner = context(owner.actor.id, ["selection.read"], ["BUYER"]);
  assert.equal((await service.photoDetail(readOnlyOwner, row.id)).cellAccess[privateText], "read");
  await rejected(() => service.write(fresh(readOnlyOwner), { extraFields: { [privateText]: "not allowed" } }, row.id));
  for (const actor of [other, reader, ordinaryAdmin]) {
    const hidden = await service.photoDetail(actor, row.id);
    omitted(hidden, privateText);
    omitted(hidden, privatePhoto);
    assert.equal(hidden.extraFields[publicText], "PUBLIC-CONTENT");
    assert.equal(JSON.stringify(hidden).includes(value), false);
    await rejected(() => service.write(fresh(actor), { extraFields: { [privateText]: "not allowed" } }, row.id));
    await rejected(() => service.write(fresh(actor), { cellColors: { [privateText]: "GREEN" } }, row.id));
    await rejected(() => service.changePhoto(fresh(actor), row.id, { action: "remove", field: privatePhoto, imageId }));
    await rejected(() => service.readImage(actor, imageId, true));
  }
  await service.readImage(owner, imageId, true);
  assert.equal((await service.photoDetail(admin,row.id)).extraFields[privateText],value);
  await service.readImage(admin,imageId,true);
  await service.write(fresh(admin), { cellAlignments: { [privateText]: "center" } }, row.id);
  check("owner-only values, edits and image access apply to ordinary users and administrators; SUPER_ADMIN may view and edit");

  await rejected(() => service.write(fresh(admin), { extraFields: { "custom:unregistered": "bypass" } }, row.id));
  await rejected(() => service.write(fresh(admin), { extraFields: { plaintext: "bypass" } }, row.id), 400);
  await rows(db,
    `UPDATE style_selections SET extra_fields=extra_fields || $2::jsonb,
      cell_colors=cell_colors || $3::jsonb,cell_alignments=cell_alignments || $4::jsonb WHERE id=$1::bigint`,
    row.id, JSON.stringify({ "custom:orphan": "ORPHAN-CONTENT", plaintext: "ORPHAN-PLAINTEXT" }),
    JSON.stringify({ "custom:orphan": "GREEN", plaintext: "GREEN" }), JSON.stringify({ plaintext: "left" }));
  for (const actor of [owner, other, admin]) {
    const hidden = await service.photoDetail(actor, row.id);
    omitted(hidden, "custom:orphan");
    omitted(hidden, "plaintext");
    assert.equal(JSON.stringify(hidden).includes("ORPHAN"), false);
  }
  const listed = await service.list(other, { sort: "sortOrder", direction: "asc" });
  omitted(listed.data.find((item: Row) => String(item.id) === row.id)!, privateText);
  const snapshot = JSON.parse(await service.sync(other, {}));
  omitted(snapshot.data.find((item: Row) => item.id === row.id), privateText);
  const next = await service.nextPhotoStyle(other, blank.id, "");
  assert.equal(next?.id, row.id);
  omitted(next!, privateText);
  assert.equal(JSON.stringify(await protection.readSettings(admin)).includes(privateText), false);
  check("unknown custom and malformed legacy extra keys are rejected or entirely omitted on every row-read path");

  await service.heartbeat(owner, { editingId: row.id, editingColumn: privateText });
  const ownPresence = await service.presence(owner);
  assert.equal(ownPresence.find(item => String(item.user_id) === owner.actor.id)?.editing_column, privateText);
  for (const actor of [other, ordinaryAdmin]) {
    const presence = await service.presence(actor);
    assert.equal(presence.find(item => String(item.user_id) === owner.actor.id)?.editing_column, null);
    await rejected(() => service.heartbeat(actor, { editingId: row.id, editingColumn: privateText }));
  }
  const share = await collections.create(fresh(owner), { title: "visibility allowlist", ids: [row.id], days: 7 });
  const outside = JSON.stringify(camel(await collections.publicDetail(share.token)));
  assert.equal(outside.includes(privateText), false);
  assert.equal(outside.includes(value), false);
  assert.equal(outside.includes(imageId), false);
  await rejected(() => collections.image(share.token, row.id, imageId), 404);
  check("presence and anonymous collection links do not disclose private field keys, values or photos");

  // Visibility alone changes the snapshot, although no selection row is edited.
  await changeVisibility(privateText, true);
  assert.equal((await service.photoDetail(other, row.id)).extraFields[privateText], value);
  const successfulRequest = fresh(other);
  const successfulBody = { extraFields: { [privateText]: "PUBLIC-EDIT" } };
  row = await service.write(successfulRequest, successfulBody, row.id);
  const beforeRevocation = JSON.parse(await service.sync(other, {}));
  const known = Object.fromEntries(beforeRevocation.index.map((item: Row) => [item.id, item.token]));
  const oldRevision = (await service.revision(other)).revision;
  const policyRevision = (await protection.readSettings(admin)).revision;
  const untouched = await one(db, "SELECT version,updated_at FROM style_selections WHERE id=$1::bigint", row.id);
  await changeVisibility(privateText, false);
  assert.equal((await protection.readSettings(admin)).revision, policyRevision);
  assert.notEqual((await service.revision(other)).revision, oldRevision);
  assert.deepEqual(await one(db, "SELECT version,updated_at FROM style_selections WHERE id=$1::bigint", row.id), untouched);
  const revoked = JSON.parse(await service.sync(other, { known }));
  const removed = revoked.data.find((item: Row) => item.id === row.id);
  assert.ok(removed, "revocation must send a replacement row even when the record version is unchanged");
  omitted(removed, privateText);
  await rejected(() => service.write(successfulRequest, successfulBody, row.id));
  check("publication and withdrawal invalidate revision and sync tokens, remove full old projections and reauthorize cached writes");

  // A single private field must not take away public shared-filter functionality.
  let shared = await service.sharedView(other);
  await service.saveSharedView(fresh(other), { revision: shared!.revision, view: { filters: { [publicText]: { mode: "contains", value: "PUBLIC" } }, sort: null } });
  shared = await service.sharedView(owner);
  await rejected(() => service.saveSharedView(fresh(owner), { revision: shared!.revision, view: { filters: { [privateText]: { mode: "contains", value: "PRIVATE-FILTER" } }, sort: null } }));
  await changeVisibility(privateText, true);
  await service.saveSharedView(fresh(owner), { revision: shared!.revision, view: { filters: { [privateText]: { mode: "contains", value: "PUBLIC-FILTER" } }, sort: { key: privateText, direction: "asc" } } });
  await changeVisibility(privateText, false);
  for (const actor of [other, ordinaryAdmin]) {
    const hidden = await service.sharedView(actor);
    assert.deepEqual(hidden!.view.filters, {});
    assert.equal(hidden!.view.sort, null);
  }
  check("shared views reject private filters and retract filters and sort keys when publication is withdrawn");

  await setProtection({ ...defaultProtection, enabled: true, regions: [{ id: randomUUID(), name: "unchanged deny", scope: "columns", rowIds: [], columnKeys: [publicText], users: { [owner.actor.id]: "edit" }, others: "deny" }] });
  assert.equal((await service.photoDetail(other, row.id)).extraFields[publicText], "");
  await rejected(() => service.write(fresh(other), { extraFields: { [publicText]: "no bypass" } }, row.id));
  await setProtection({ ...defaultProtection, autoHide: true });
  assert.equal((await service.photoDetail(other, row.id)).extraFields[publicText], "");
  assert.equal((await service.photoDetail(owner, row.id)).extraFields[publicText], "PUBLIC-CONTENT");
  await setProtection(defaultProtection);
  check("public visibility never overrides existing forbidden regions or automatic hiding");

  const hiddenRegion = { id: randomUUID(), name: "PRIVATE REGION NAME", scope: "columns", rowIds: [], columnKeys: [privateText], users: { [owner.actor.id]: "edit" }, others: "deny" };
  await setProtection({ ...defaultProtection, enabled: true, regions: [hiddenRegion] });
  const managerSettings = await protection.readSettings(ordinaryAdmin);
  assert.equal(JSON.stringify(managerSettings).includes("PRIVATE REGION NAME"), false);
  assert.equal(JSON.stringify(managerSettings).includes(privateText), false);
  const managerSaved = await protection.saveSettings(fresh(ordinaryAdmin), { revision: managerSettings.revision, settings: { ...managerSettings.settings, claimsEnabled: true } });
  assert.equal(JSON.stringify(managerSaved).includes(privateText), false);
  assert.deepEqual((await protection.readSettings(admin)).settings.regions, [hiddenRegion]);
  await rejected(() => protection.saveSettings(fresh(ordinaryAdmin), { revision: managerSaved.revision, settings: { ...managerSaved.settings, regions: [hiddenRegion] } }));
  await setProtection(defaultProtection);
  check("ordinary administrators cannot inspect private protection regions; full saves preserve hidden rules while SUPER_ADMIN can manage them");

  const table = await one(db, "INSERT INTO project_tables(name,created_by,initial_layout) VALUES('visibility-scope',$1::bigint,'empty') RETURNING id", adminId);
  await rows(db, "SELECT create_project_table_workspace($1::bigint)::text", table!.id);
  await selectionScope.run(String(table!.id), async () => {
    await registerField(privateText, other.actor.id, "PUBLIC");
    const scoped = await service.write(fresh(other), { extraFields: { [privateText]: "OTHER-WORKSPACE" } });
    assert.equal((await service.photoDetail(owner, scoped.id)).extraFields[privateText], "OTHER-WORKSPACE");
  });
  omitted(await service.photoDetail(other, row.id), privateText);
  check("field ownership and visibility are independently scoped to each table");

  const auditAction = "FIELD_PRIVACY_AUDIT_TEST";
  const raw = await one(db,"SELECT * FROM style_selections WHERE id=$1::bigint",row.id);
  await audit(db,owner,auditAction,"style-selection",row.id,null,raw,"PRIVATE REASON");
  await audit(db,owner,auditAction,"selection-field",null,null,{fieldKey:privateText,label:"PRIVATE FIELD LABEL",options:["PRIVATE OPTION"]});
  await audit(db,owner,auditAction,"selection-field",null,null,{fieldKey:publicText,label:"PUBLIC FIELD LABEL",options:["PUBLIC OPTION"]});
  await audit(db,owner,auditAction,"selection-protection","1",null,{settings:{regions:[hiddenRegion]}});
  await audit(db,owner,auditAction,"style-selection-image",null,null,{id:imageId,type:"image/jpeg"});
  const auditor = { ...ordinaryAdmin,actor:{...ordinaryAdmin.actor,permissions:[...ordinaryAdmin.actor.permissions,"audit.read"]} };
  const superAuditor = { ...admin,actor:{...admin.actor,permissions:[...admin.actor.permissions,"audit.read"]} };
  const ownAuditor = { ...owner,actor:{...owner.actor,permissions:[...owner.actor.permissions,"audit.read"]} };
  const logs = await auditLogs.list(auditor,{action:auditAction});
  assert.equal(logs.total,5);
  const publicRow = logs.data.find(item=>item.entity_type === "style-selection")!;
  assert.equal(publicRow.after_data.extraFields[publicText],"PUBLIC-CONTENT");
  assert.equal(publicRow.reason,null);
  for(const secret of [privateText,imageId,"PRIVATE FIELD LABEL","PRIVATE OPTION","PRIVATE REGION NAME","PRIVATE REASON","ORPHAN"])assert.equal(serialized(logs).includes(secret),false,secret);
  assert.equal(serialized(logs).includes("PUBLIC FIELD LABEL"),true);
  assert.equal(serialized(await auditLogs.list(ownAuditor,{action:auditAction})).includes("PRIVATE FIELD LABEL"),true);
  assert.equal(serialized(await auditLogs.list(superAuditor,{action:auditAction})).includes(privateText),true);
  await changeVisibility(privateText,true);
  assert.equal(serialized(await auditLogs.list(auditor,{action:auditAction})).includes("PRIVATE FIELD LABEL"),true);
  await changeVisibility(privateText,false);
  assert.equal(serialized(await auditLogs.list(auditor,{action:auditAction})).includes("PRIVATE FIELD LABEL"),false);
  await selectionScope.run(String(table!.id),()=>audit(db,other,auditAction,"style-selection",row.id,null,{material:"SCOPED PUBLIC MATERIAL",extra_fields:{[privateText]:"SCOPED PUBLIC VALUE"}},"SCOPED REASON"));
  let tableLog = (await auditLogs.list(auditor,{action:auditAction})).data.find(item=>item.selection_table_id)!;
  assert.equal(tableLog.after_data,null);
  assert.equal(tableLog.reason,null);
  await rows(db,"INSERT INTO project_library_acl(kind,resource_id,user_id,access) VALUES('table',$1::bigint,$2::bigint,'READ')",table!.id,auditor.actor.id);
  tableLog = (await auditLogs.list(auditor,{action:auditAction})).data.find(item=>item.selection_table_id)!;
  assert.equal(tableLog.after_data.extraFields[privateText],"SCOPED PUBLIC VALUE");
  assert.equal(tableLog.after_data.material,"SCOPED PUBLIC MATERIAL");
  await rows(db,"UPDATE project_library_acl SET access='DENY' WHERE kind='table' AND resource_id=$1::bigint AND user_id=$2::bigint",table!.id,auditor.actor.id);
  assert.equal((await auditLogs.list(auditor,{action:auditAction})).data.find(item=>item.selection_table_id)!.after_data,null);
  check("audit readers receive only current visible values, definitions and pictures; SUPER sees original history and table ACL is checked per workspace");

  console.log(`Passed ${passed} field visibility integration scenarios`);
} finally {
  await db.$disconnect();
  const cleanup = new pg.Client({ connectionString: rootUrl });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
  await cleanup.end();
}

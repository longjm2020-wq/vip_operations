// Only disposable localhost data; no application or production database is used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
import type { Context } from "../../apps/api/src/core.js";
import type { LibraryKind } from "../../packages/contracts/src/project-library.js";

const rootUrl = "postgresql://postgres@127.0.0.1:55433/postgres";
const databaseName = "project_library_acl_" + Date.now();
const root = new pg.Client({ connectionString: rootUrl });
await root.connect();
await root.query(`CREATE DATABASE ${databaseName}`);
const url = new URL(rootUrl);
url.pathname = "/" + databaseName;
Object.assign(process.env, { DATABASE_URL: url.toString(), ADMIN_PASSWORD: randomUUID(), SALES_SOURCE: "fixture", AWS_S3_BUCKET_NAME: "" });
await migrate();
const { seed } = await import("../../scripts/seed.js");
await seed();
const { db, one, rows } = await import("../../packages/database/src/index.js");
const library = await import("../../apps/api/src/modules/projects/library.js");
const projects = await import("../../apps/api/src/modules/projects/service.js");
const auditLogs = await import("../../apps/api/src/modules/audit/service.js");
const { audit } = await import("../../apps/api/src/core.js");
const context = (id: string, permissions = ["project.read"], roleCodes = ["BUYER"]): Context => ({
  actor: { id, username: "acl-test", displayName: "acl-test", permissions, roleCodes }, requestId: randomUUID(), key: randomUUID(),
});
const fresh = (c: Context) => ({ ...c, key: randomUUID() });
const serialized = (value: unknown) => JSON.stringify(value, (_key,item)=>typeof item === "bigint" ? String(item) : item);
const rejected = (work: () => Promise<unknown>, status = 403) => assert.rejects(work, (error: { getStatus?: () => number }) => error.getStatus?.() === status);
let checks = 0;
const pass = (description: string) => { checks++; console.log("PASS", description); };
async function actor(username: string, permissions?: string[], roleCodes?: string[]) {
  const user = await one(db,"INSERT INTO users(username,display_name,password_hash) VALUES($1,$1,'unused-local-test') RETURNING id",username);
  return context(String(user!.id),permissions,roleCodes);
}
const body = { name: "ACL project", tag: "other", start: "", end: "", sopIds: [] as string[], collaborators: [] as string[], tasks: [], requirements: [] };
const sopBody = { name: "ACL SOP", department: "运营", steps: [{ id: "step", name: "step" }] };
async function grant(c: Context, kind: LibraryKind, id: string, members: { userId: string; access: "EDIT" | "READ" | "DENY" }[]) {
  const before = await library.collaborators(c,kind,id);
  return library.saveCollaborators(fresh(c),kind,id,{ version: before.version, members });
}
async function current(kind: LibraryKind, id: string) {
  return (await one(db,`SELECT * FROM ${library.libraryConfig[kind].table} WHERE id=$1::bigint`,id))!;
}

try {
  const owner = await actor("acl-owner",["project.read","project.create","sop.manage"],["SUPER_ADMIN"]);
  const readOnlyOwner = context(owner.actor.id);
  const editor = await actor("acl-editor");
  const reader = await actor("acl-reader");
  const creator = await actor("acl-global-creator",["project.read","project.create","sop.manage"]);
  const ordinaryAdmin = await actor("acl-ordinary-admin",["project.read","user.manage"],["ADMIN"]);
  const superId = String((await one(db,"SELECT id FROM users WHERE username='admin'"))!.id);
  await rows(db,"INSERT INTO user_roles(user_id,role_id) SELECT $1::bigint,id FROM roles WHERE code='SUPER_ADMIN' ON CONFLICT DO NOTHING",superId);
  const superAdmin = context(superId,["project.read"],["SUPER_ADMIN"]);
  const sop = (await projects.writeSop(fresh(owner),sopBody))!;
  const project = (await projects.save(fresh(owner),body))!;
  const table = (await one(db,"INSERT INTO project_tables(name,created_by) VALUES('ACL table',$1::bigint) RETURNING *",owner.actor.id))!;
  await rows(db,"SELECT create_project_table_workspace($1::bigint)::text",table.id);
  const resources = [["sop",String(sop.id)],["project",String(project.id)],["table",String(table.id)]] as const;

  for (const [kind,id] of resources) {
    assert.equal(await library.effectiveContentAccess(db,readOnlyOwner.actor,kind,id),"EDIT");
    assert.equal(library.canManageContent(readOnlyOwner.actor,kind,await current(kind,id)),true);
    assert.equal(await library.effectiveContentAccess(db,ordinaryAdmin.actor,kind,id),"DENY");
    await rejected(()=>library.collaborators(ordinaryAdmin,kind,id));
  }
  await projects.writeSop(fresh(readOnlyOwner),{...sopBody,name:"owner without global create",version:sop.version},String(sop.id));
  await projects.save(fresh(readOnlyOwner),{...body,name:"owner without global create",version:project.version},String(project.id));
  await rejected(()=>projects.writeSop(fresh(readOnlyOwner),sopBody));
  await rejected(()=>projects.save(fresh(readOnlyOwner),body));
  pass("existing owner can edit and manage without creation permissions; ordinary ADMIN is not a global resource administrator");

  for (const [kind,id] of resources) {
    await library.changeContent(fresh(readOnlyOwner),kind,id,"visibility",{visibility:"PUBLIC",version:(await current(kind,id)).version});
    assert.equal(await library.effectiveContentAccess(db,creator.actor,kind,id),"READ");
    await rejected(()=>library.changeContent(fresh(creator),kind,id,"delete"));
    await grant(readOnlyOwner,kind,id,[{userId:editor.actor.id,access:"EDIT"},{userId:reader.actor.id,access:"READ"},{userId:ordinaryAdmin.actor.id,access:"DENY"}]);
    assert.equal(await library.effectiveContentAccess(db,editor.actor,kind,id),"EDIT");
    assert.equal(await library.effectiveContentAccess(db,reader.actor,kind,id),"READ");
    assert.equal(await library.effectiveContentAccess(db,ordinaryAdmin.actor,kind,id),"DENY");
    await rejected(()=>library.collaborators(editor,kind,id));
    await rejected(()=>library.changeContent(fresh(editor),kind,id,"visibility",{visibility:"PRIVATE"}));
    await rejected(()=>library.changeContent(fresh(editor),kind,id,"delete"));
  }
  assert.equal((await projects.detail(creator,String(project.id))).can_edit,false);
  assert.equal((await projects.sops(creator)).find(row=>String(row.id)===String(sop.id))!.can_edit,false);
  assert.equal((await library.tableAccess(db,reader.actor,String(table.id))).can_edit,false);
  await rejected(async()=>projects.save(fresh(creator),{...body,collaborators:[editor.actor.id,reader.actor.id],version:(await current("project",String(project.id))).version},String(project.id)));
  pass("public defaults to READ even with global creation rights; explicit EDIT/READ/DENY controls SOP, project and table resources");

  await projects.writeSop(fresh(editor),{...sopBody,name:"editor update",version:(await current("sop",String(sop.id))).version},String(sop.id));
  await rejected(async()=>projects.writeSop(fresh(reader),{...sopBody,version:(await current("sop",String(sop.id))).version},String(sop.id)));
  const draft = await projects.detail(reader,String(project.id));
  assert.equal(draft.status,"DRAFT");
  assert.equal(draft.can_collaborate,false);
  await projects.save(fresh(editor),{...body,name:"editor update",collaborators:draft.document.collaborators,version:draft.version},String(project.id));
  for (const patch of [{visibility:"PRIVATE"},{collaborators:[editor.actor.id]}])
    await rejected(async()=>projects.save(fresh(editor),{...body,collaborators:draft.document.collaborators,...patch,version:(await current("project",String(project.id))).version},String(project.id)));
  for (const action of ["invite","publish","void"])
    await rejected(async()=>projects.act(fresh(editor),String(project.id),{action,users:[creator.actor.id],reason:"test",version:(await current("project",String(project.id))).version}));
  await rejected(()=>projects.send(fresh(reader),String(project.id),{body:"READ cannot send"}));
  pass("EDIT changes existing content without global create; READ can view drafts; only owner/SUPER manages visibility, members, publication or deletion");

  await rows(db,"UPDATE projects SET status='ACTIVE' WHERE id=$1::bigint",project.id);
  const retry = fresh(editor);
  await projects.send(retry,String(project.id),{body:"authorized message"});
  assert.equal((await projects.messages(reader,String(project.id))).length,1);
  await rows(db,"INSERT INTO project_notifications(user_id,project_id,body) VALUES($1::bigint,$2::bigint,'secret')",editor.actor.id,project.id);
  await grant(readOnlyOwner,"project",String(project.id),[{userId:editor.actor.id,access:"DENY"},{userId:reader.actor.id,access:"READ"}]);
  await rejected(()=>projects.send(retry,String(project.id),{body:"authorized message"}));
  await rejected(()=>projects.messages(editor,String(project.id)));
  assert.equal((await projects.notifications(editor)).length,0);
  assert.equal((await projects.list(editor,{})).some(row=>String(row.id)===String(project.id)),false);
  await rows(db,"INSERT INTO project_members(project_id,user_id,added_by) VALUES($1::bigint,$2::bigint,$3::bigint) ON CONFLICT DO NOTHING",project.id,editor.actor.id,owner.actor.id);
  assert.equal(await library.effectiveContentAccess(db,editor.actor,"project",String(project.id)),"DENY");
  pass("DENY hides public content, history and notifications, overrides legacy membership, and cached writes reauthorize after revocation");

  await rows(db,"INSERT INTO project_library_acl(kind,resource_id,user_id,access) VALUES('project',$1::bigint,$2::bigint,'DENY'),('project',$1::bigint,$3::bigint,'DENY')",project.id,owner.actor.id,superId);
  assert.equal(await library.effectiveContentAccess(db,readOnlyOwner.actor,"project",String(project.id)),"EDIT");
  assert.equal(await library.effectiveContentAccess(db,superAdmin.actor,"project",String(project.id)),"EDIT");
  assert.equal(library.canManageContent(superAdmin.actor,"project",await current("project",String(project.id))),true);
  const fixed = await library.collaborators(readOnlyOwner,"project",String(project.id));
  assert.equal(fixed.members.some(member=>[owner.actor.id,superId].includes(member.userId)),false);
  await rejected(()=>library.saveCollaborators(fresh(readOnlyOwner),"project",String(project.id),{version:fixed.version,members:[{userId:owner.actor.id,access:"DENY"}]}),400);
  await rejected(()=>library.saveCollaborators(fresh(readOnlyOwner),"project",String(project.id),{version:fixed.version,members:[{userId:superId,access:"READ"}]}),400);
  pass("owner and SUPER_ADMIN have fixed management rights and cannot be downgraded by ACL entries");

  const shared = await library.collaborators(readOnlyOwner,"table",String(table.id));
  const race = await Promise.allSettled([
    library.saveCollaborators(fresh(readOnlyOwner),"table",String(table.id),{version:shared.version,members:[{userId:reader.actor.id,access:"READ"}]}),
    library.saveCollaborators(fresh(readOnlyOwner),"table",String(table.id),{version:shared.version,members:[{userId:reader.actor.id,access:"EDIT"}]}),
  ]);
  assert.equal(race.filter(result=>result.status==="fulfilled").length,1);
  const loser = race.find(result=>result.status==="rejected") as PromiseRejectedResult;
  assert.equal(loser.reason.getStatus(),409);
  await grant(readOnlyOwner,"table",String(table.id),[]);
  assert.equal(await library.effectiveContentAccess(db,reader.actor,"table",String(table.id)),"READ");
  await library.changeContent(fresh(readOnlyOwner),"table",String(table.id),"visibility",{visibility:"PRIVATE",version:(await current("table",String(table.id))).version});
  assert.equal(await library.effectiveContentAccess(db,reader.actor,"table",String(table.id)),"DENY");
  await rejected(()=>library.tableAccess(db,reader.actor,String(table.id)),404);
  pass("ACL full saves use resource version CAS; removing a grant removes legacy membership and restores public READ or private DENY");

  const active = await projects.detail(readOnlyOwner,String(project.id));
  await rows(db,"UPDATE projects SET document=$2::jsonb WHERE id=$1::bigint",project.id,JSON.stringify({...active.document,stages:[{id:"step",name:"step",dependsOn:[]}],tasks:[{id:"delivery",stage:"step",title:"deliver",assignee:owner.actor.id,receiver:reader.actor.id,status:"PENDING"}]}));
  await grant(readOnlyOwner,"project",String(project.id),[{userId:editor.actor.id,access:"EDIT"},{userId:reader.actor.id,access:"EDIT"}]);
  await rejected(async()=>projects.act(fresh(editor),String(project.id),{action:"submit",taskId:"delivery",reason:"unassigned",version:(await current("project",String(project.id))).version}));
  await projects.act(fresh(superAdmin),String(project.id),{action:"submit",taskId:"delivery",reason:"super substituted",version:(await current("project",String(project.id))).version});
  await rejected(async()=>projects.act(fresh(editor),String(project.id),{action:"approve",taskId:"delivery",version:(await current("project",String(project.id))).version}));
  await projects.act(fresh(reader),String(project.id),{action:"approve",taskId:"delivery",version:(await current("project",String(project.id))).version});
  pass("EDIT does not replace assigned delivery/approval checks; SUPER may substitute and the designated receiver may approve");

  const fileId = randomUUID(),file = {id:fileId,name:"local test.txt",size:3,type:"text/plain",data:"",storageKey:"local-test-only"};
  const attachmentProject = (await projects.save(fresh(owner),body))!;
  await rows(db,"UPDATE projects SET document=jsonb_set(document,'{attachments}',$2::jsonb) WHERE id=$1::bigint",attachmentProject.id,JSON.stringify([file]));
  await rows(db,"INSERT INTO project_uploads(id,user_id,metadata) VALUES($1::uuid,$2::bigint,$3::jsonb)",fileId,editor.actor.id,JSON.stringify(file));
  await grant(readOnlyOwner,"project",String(attachmentProject.id),[{userId:editor.actor.id,access:"READ"}]);
  Object.assign(process.env,{AWS_ENDPOINT_URL:"http://127.0.0.1:1",AWS_S3_BUCKET_NAME:"local-test",AWS_ACCESS_KEY_ID:"local-test",AWS_SECRET_ACCESS_KEY:"local-test"});
  assert.ok((await projects.attachmentUrl(editor,String(attachmentProject.id),fileId,false)).includes("local-test-only"));
  assert.ok((await projects.uploadedAttachment(editor,fileId,false,String(attachmentProject.id))).includes("local-test-only"));
  await grant(readOnlyOwner,"project",String(attachmentProject.id),[{userId:editor.actor.id,access:"DENY"}]);
  await rejected(()=>projects.attachmentUrl(editor,String(attachmentProject.id),fileId,false));
  await rejected(()=>projects.uploadedAttachment(editor,fileId,false),404);
  await rejected(()=>projects.uploadedAttachment(editor,fileId,false,String(attachmentProject.id)));
  await rejected(()=>projects.uploadAttachment(reader,{},String(attachmentProject.id)));
  Object.assign(process.env,{AWS_S3_BUCKET_NAME:""});
  pass("attachment and old pending-upload links check live resource access; own upload does not bypass a revoked linked project");

  const action = "RESOURCE_AUDIT_ACL_TEST",auditor = { ...ordinaryAdmin,actor:{...ordinaryAdmin.actor,permissions:[...ordinaryAdmin.actor.permissions,"audit.read"]} };
  const superAuditor = { ...superAdmin,actor:{...superAdmin.actor,permissions:[...superAdmin.actor.permissions,"audit.read"]} };
  for (const [kind,id] of resources) {
    await audit(db,readOnlyOwner,action,kind,id,null,{name:"PRIVATE RESOURCE NAME",members:[{userId:editor.actor.id,access:"EDIT"}]},"PRIVATE RESOURCE REASON");
    await grant(readOnlyOwner,kind,id,[{userId:ordinaryAdmin.actor.id,access:"DENY"}]);
  }
  let entries = await auditLogs.list(auditor,{action});
  assert.equal(entries.total,3);
  for(const entry of entries.data) { assert.equal(entry.after_data,null); assert.equal(entry.reason,null); }
  assert.equal(serialized(entries).includes("PRIVATE RESOURCE NAME"),false);
  assert.equal(entries.data.some(entry=>entry.after_data?.members?.some((member:{userId:string})=>member.userId === editor.actor.id)),false);
  assert.equal(serialized(await auditLogs.list(superAuditor,{action})).includes("PRIVATE RESOURCE NAME"),true);
  for (const [kind,id] of resources) await grant(readOnlyOwner,kind,id,[{userId:ordinaryAdmin.actor.id,access:"READ"}]);
  entries = await auditLogs.list(auditor,{action});
  assert.equal(entries.data.every(entry=>entry.after_data.name === "PRIVATE RESOURCE NAME"),true);
  const archived = await library.changeContent(fresh(readOnlyOwner),"project",String(project.id),"delete");
  assert.equal((await auditLogs.list(auditor,{action})).data.find(entry=>entry.entity_type === "project")!.after_data,null);
  await library.changeContent(fresh(readOnlyOwner),"project",String(project.id),"restore",{version:archived!.version});
  pass("audit.read cannot bypass SOP/project/table DENY or deleted state; accessible bodies remain and SUPER has original history");

  const removed = await library.changeContent(fresh(readOnlyOwner),"sop",String(sop.id),"delete");
  assert.equal((await projects.sops(editor)).some(row=>String(row.id)===String(sop.id)),false);
  await rejected(()=>library.collaborators(readOnlyOwner,"sop",String(sop.id)),404);
  await rejected(()=>library.changeContent(fresh(editor),"sop",String(sop.id),"restore"));
  await library.changeContent(fresh(readOnlyOwner),"sop",String(sop.id),"restore",{version:removed!.version});
  assert.equal(await library.effectiveContentAccess(db,ordinaryAdmin.actor,"sop",String(sop.id)),"READ");
  await rows(db,"DELETE FROM public.project_sops WHERE id=$1::bigint",sop.id);
  assert.equal((await rows(db,"SELECT 1 FROM project_library_acl WHERE kind='sop' AND resource_id=$1::bigint",sop.id)).length,0);
  pass("soft deletion hides resources, restoration preserves grants, and permanent removal cleans orphan ACL entries");
  console.log(`Project library ACL integration: ${checks} scenarios passed`);
} finally {
  await db.$disconnect();
  await root.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
  await root.end();
}

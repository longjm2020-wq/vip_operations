// Localhost disposable database only: exercises the field ownership and layout commands.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";
import { selectionScope } from "../../packages/database/src/selection-scope.js";
import type { Context } from "../../apps/api/src/core.js";
const rootUrl = "postgresql://postgres@127.0.0.1:55433/postgres";
const name = "selection_field_management_" + Date.now();
const connection = new pg.Client({ connectionString:rootUrl });
await connection.connect(); await connection.query(`CREATE DATABASE ${name}`); await connection.end();
const url = new URL(rootUrl); url.pathname = "/" + name;
Object.assign(process.env,{DATABASE_URL:url.toString(),ADMIN_PASSWORD:"test-"+randomUUID(),SALES_SOURCE:"fixture",AWS_S3_BUCKET_NAME:""});
await migrate();
const { seed } = await import("../../scripts/seed.js"); await seed();
const { db,one,rows } = await import("../../packages/database/src/index.js");
const layouts = await import("../../apps/api/src/modules/style-selections/layout-preferences.js");
const registry = await import("../../apps/api/src/modules/style-selections/field-registry.js");
const service = await import("../../apps/api/src/modules/style-selections/service.js");
const transfer = await import("../../apps/api/src/modules/style-selections/migration.js");
const ctx = (id:string,edit=false):Context=>({actor:{id,username:"fixture",displayName:"fixture",permissions:["selection.read",...(edit?["selection.manage"]:[])]},requestId:randomUUID(),key:randomUUID()});
const fresh = (c:Context)=>({...c,key:randomUUID()});
const admin = ctx(String((await one(db,"SELECT id FROM users WHERE username='admin'"))!.id),true);
const readerRow = await one(db,"INSERT INTO users(username,display_name,password_hash) VALUES('field-reader','field-reader','test') RETURNING id");
const reader = ctx(String(readerRow!.id));
const field = {key:"custom:private-reader",label:"本人备注",width:130,custom:true,type:"text" as const};
const rejected = async (fn:()=>Promise<unknown>,status=403)=>assert.rejects(fn,(error:{getStatus?:()=>number})=>error.getStatus?.()===status);
let passed=0;
const check = (label:string)=>{passed++;console.log("PASS",label);};
try {
  const original = await layouts.layoutPreferences(reader,true);
  let personal: Record<string,any> = await layouts.saveLayoutPreferences(fresh(reader),{revision:original.revision,sharedRevision:original.sharedRevision,preferences:selectionLayoutSchema.parse({columns:[{...field,ownerId:admin.actor.id,visibility:"PUBLIC"}]})},true);
  let own = personal.preferences.columns.find((item:any)=>item.key===field.key);
  assert.equal(own.ownerId,reader.actor.id); assert.equal(own.visibility,"PRIVATE"); assert.equal(own.fieldRevision,1);
  assert.ok(!(await layouts.layoutPreferences(admin,true)).preferences?.columns.some((item:any)=>item.key===field.key));
  await rejected(()=>service.write(fresh(reader),{extraFields:{[field.key]:"not granted edit"}}));
  await rejected(()=>registry.setFieldVisibility(fresh(admin),field.key,{public:true,revision:1}));
  check("read-only user creates a private field; forged scope and owner cannot grant access");
  await rows(db,"INSERT INTO style_selections(xuti_style_no,extra_fields,created_by) VALUES('orphan-fixture', $1::jsonb,$2::bigint)",JSON.stringify({"custom:historical-orphan":"不可认领的历史资料"}),admin.actor.id);
  await rejected(()=>layouts.saveLayoutPreferences(fresh(reader),{revision:personal.revision,sharedRevision:personal.sharedRevision,preferences:selectionLayoutSchema.parse({...personal.preferences,columns:[...personal.preferences.columns,{key:"custom:historical-orphan",label:"历史资料",custom:true,type:"text",width:120}]})},true),400);
  assert.ok(!(await layouts.layoutPreferences(reader,true)).preferences?.columns.some(item=>item.key==="custom:historical-orphan"));
  check("a newly registered key cannot claim orphaned historical cell data");

  own = await registry.setFieldVisibility(fresh(reader),field.key,{public:true,revision:own.fieldRevision});
  assert.equal(own.visibility,"PUBLIC");
  assert.ok((await layouts.layoutPreferences(admin,true)).preferences?.columns.some((item:any)=>item.key===field.key));
  await rejected(()=>registry.setFieldVisibility(fresh(reader),field.key,{public:false,revision:1}),409);
  const row = await service.write(fresh(admin),{extraFields:{[field.key]:"公开内容"}});
  assert.equal((await service.photoDetail(reader,row.id)).extraFields[field.key],"公开内容");
  own = await registry.setFieldVisibility(fresh(reader),field.key,{public:false,revision:own.fieldRevision});
  assert.ok(!Object.hasOwn((await service.photoDetail(admin,row.id)).extraFields,field.key));
  check("only the creator can publish or withdraw; saved public content respects scope changes");

  // The selected editor's pre-existing layout can become the common initial template.
  let editor: Record<string,any> = await layouts.layoutPreferences(admin,true);
  const legacy = {key:"custom:legacy-editor",label:"旧质检",custom:true,width:270,type:"single" as const,options:["规范","不规范"]};
  const newPrivate = {key:"custom:new-editor",label:"新私有",custom:true,width:160,type:"text" as const};
  editor = await layouts.saveLayoutPreferences(fresh(admin),{revision:editor.revision,sharedRevision:editor.sharedRevision,preferences:selectionLayoutSchema.parse({columns:[{key:"material",label:"材质成分",width:300,type:"text"},legacy,newPrivate],columnGroups:[{id:"quality",name:"质检",columnKeys:["material",legacy.key]}],fixedColumns:["material"]})},true);
  await rows(db,"UPDATE public.selection_field_registry SET legacy=true WHERE workspace_key='default' AND field_key=$1",legacy.key);
  await rejected(()=>layouts.initializeSharedLayout(fresh(reader)));
  editor = await layouts.initializeSharedLayout(fresh(admin));
  assert.ok(editor.sharedPreferences.columns.some((item:any)=>item.key===legacy.key));
  assert.ok(!editor.sharedPreferences.columns.some((item:any)=>item.key===newPrivate.key));
  personal = await layouts.layoutPreferences(reader,true);
  assert.equal(personal.preferences.columns.find((item:any)=>item.key==="material").width,300);
  assert.ok(personal.preferences.columnGroups.some((group:any)=>group.name==="质检"));
  assert.ok(personal.preferences.columns.some((item:any)=>item.key===field.key && item.visibility==="PRIVATE"));
  assert.ok(!personal.preferences.columns.some((item:any)=>item.key===newPrivate.key));
  check("explicit initialization promotes the selected editor's legacy fields but keeps new private fields private");

  const beforeShared = personal.sharedRevision;
  const preferences = {...personal.preferences,columns:personal.preferences.columns.map((item:any)=>item.key===field.key?{...item,label:"本人新备注",width:185}:item)};
  personal = await layouts.saveLayoutPreferences(fresh(reader),{preferences,revision:personal.revision,sharedRevision:personal.sharedRevision},true);
  assert.equal(personal.sharedRevision,beforeShared);
  assert.equal(personal.preferences.columns.find((item:any)=>item.key===field.key).label,"本人新备注");
  await rejected(()=>layouts.saveLayoutPreferences(fresh(reader),{preferences:personal.preferences,revision:personal.revision,sharedRevision:personal.sharedRevision,sharedChanges:{rowHeight:"normal"}},true));
  check("private field updates remain personal; adding fields never grants shared layout editing");

  editor = await layouts.layoutPreferences(admin,true);
  const oldShared = editor.sharedRevision;
  editor = await layouts.saveLayoutPreferences(fresh(admin),{preferences:editor.preferences,revision:editor.revision,sharedRevision:oldShared,sharedChanges:{rowHeight:"normal"}},true);
  const second = ctx(admin.actor.id,true);
  await rejected(()=>layouts.saveLayoutPreferences(fresh(second),{preferences:editor.preferences,revision:editor.revision,sharedRevision:oldShared,sharedChanges:{rowHeight:"loose"}},true),409);
  assert.equal((await layouts.layoutPreferences(reader,true)).preferences!.rowHeight,"normal");
  check("public layout changes synchronize and concurrent revisions cannot silently overwrite them");
  personal = await layouts.layoutPreferences(reader,true);
  own = personal.preferences.columns.find((item:any)=>item.key===field.key);
  own = await registry.setFieldVisibility(fresh(reader),field.key,{public:true,revision:own.fieldRevision});
  personal = await layouts.layoutPreferences(reader,true);
  personal = await layouts.saveLayoutPreferences(fresh(reader),{revision:personal.revision,sharedRevision:personal.sharedRevision,preferences:{...personal.preferences,columns:personal.preferences.columns.map((item:any)=>item.key===field.key?{...item,label:"公开备注修改"}:item)}},true);
  assert.equal((await layouts.layoutPreferences(admin,true)).preferences!.columns.find(item=>item.key===field.key)!.label,"公开备注修改");
  check("a read-only creator can maintain their own public field definition without gaining row edit rights");

  admin.actor.permissions.push("project.read","project.create");
  const target = await one(db,"INSERT INTO project_tables(name,created_by,initial_layout,visibility) VALUES('private transfer',$1::bigint,'empty','PUBLIC') RETURNING id",admin.actor.id);
  await rows(db,"SELECT create_project_table_workspace($1::bigint)::text",target!.id);
  const targetId=String(target!.id);
  const privateDefinition=(await layouts.layoutPreferences(admin,true)).preferences!.columns.find(item=>item.key===newPrivate.key)!;
  const sourceRow=await service.write(fresh(admin),{extraFields:{[newPrivate.key]:"私有传送资料"}});
  const body={rowIds:[String(sourceRow.id)],fields:[privateDefinition],target:targetId,mappings:[],copyMissingFields:true};
  const plan=await transfer.preview(fresh(admin),body);
  await transfer.commit(fresh(admin),{...body,token:plan.token});
  await selectionScope.run(targetId,async()=>{
    const definition=(await layouts.layoutPreferences(admin,true)).preferences!.columns.find(item=>item.key===newPrivate.key)!;
    assert.equal(definition.visibility,"PRIVATE");assert.equal(definition.ownerId,admin.actor.id);
    const copied=(await service.list(admin,{})).data[0];
    assert.equal(copied.extraFields[newPrivate.key],"私有传送资料");
    assert.ok(!Object.hasOwn((await service.photoDetail(reader,String(copied.id))).extraFields,newPrivate.key));
  });
  check("a copied private field is registered before row persistence and remains private in the destination");
  console.log(`selection field management: ${passed} checks passed`);
} finally {
  await db.$disconnect();
  const cleanup=new pg.Client({connectionString:rootUrl});await cleanup.connect();await cleanup.query(`DROP DATABASE ${name} WITH (FORCE)`);await cleanup.end();
}

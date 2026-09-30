import { selectionUrl } from "../../../../../packages/database/src/selection-scope.js";
import { randomBytes, randomUUID } from "node:crypto";
import { insertImage, readStoredImage } from "./image-storage.js";
import { z } from "zod";
import * as protection from "./protection.js";
import { db, rows, one, json, type Tx, type Row } from "../../../../../packages/database/src/index.js";
import { parse, id, fail, command, hash, canonical, audit, type Context } from "../../core.js";
import { collectionInfoSchema, collectionSubmissionSchema, collectionDraftSchema, collectionInventory, collectionTags } from "../../../../../packages/contracts/src/selection-collection.js";

const snapshot = (row: Row) => ({
  supplierStyleNo: row.supplier_style_no || "", color: row.color || "", sizeRange: row.size_range || "",
  material: row.material || "", supplyPriceExclTax: row.supply_price_excl_tax == null ? null : String(row.supply_price_excl_tax),
  sellingPoints: row.selling_points || "", reorderDays: row.reorder_days ?? null,
  inventory: collectionInventory(row.color || "", row.size_range || "", row.collection_inventory || []), images: row.images || []
});
const collectionFields = ["supplierStyleNo", "color", "sizeRange", "material", "supplyPriceExclTax", "sellingPoints", "reorderDays", "inventory", "images"] as const;
const collectionFieldNames: Record<(typeof collectionFields)[number], string> = {
  supplierStyleNo: "供应商款号", color: "颜色", sizeRange: "尺码范围", material: "材质成分",
  supplyPriceExclTax: "供货价（不含税）", sellingPoints: "产品卖点/简介", reorderDays: "翻单周期",
  inventory: "库存数", images: "图片"
};
function reconcile(item: Row, source: Row) {
  const current = snapshot(source);
  let merged = {...current};
  for(const field of collectionFields) {
    const before=canonical(item.original[field]), outside=canonical(item.draft[field]);
    if(outside===before) continue;
    (merged as Row)[field]=item.draft[field];
  }
  const info=Object.fromEntries(Object.entries(merged).filter(([field])=>field!=="images"));
  if(!collectionInfoSchema.safeParse(info).success) merged=item.draft;
  const overwritten=collectionFields.filter(field=>canonical(current[field])!==canonical(item.original[field]) && canonical(current[field])!==canonical(merged[field]));
  return {merged,overwritten};
}
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const editable = (share: Row) => { if (!["DRAFT","REJECTED"].includes(share.status)) fail("INVALID_STATE","本款已提交或已确认，暂不可编辑",409); };
async function access(tx: Tx, token: string, lock = false) {
  parse(tokenSchema, token);
  const share = await one(tx, "SELECT *, (expires_at <= now()) AS expired FROM selection_collections WHERE token_hash=$1" + (lock ? " FOR UPDATE" : ""), hash(token));
  if (!share || share.closed || share.expired) fail("NOT_FOUND","链接已失效或已关闭，请联系分享人",404);
  await protection.delegatedShare(tx,share!,await protection.policy(tx,lock));
  return share!;
}
async function internal(tx: Tx, value: string) {
  const share = await one(tx,"SELECT * FROM selection_collections WHERE id=$1::bigint FOR UPDATE",value);
  if (!share) fail("NOT_FOUND","收集表不存在",404);
  return share!;
}
async function event(tx: Tx, share: Row, action: string, actor?: string) {
  await rows(tx,"INSERT INTO selection_collection_events(collection_id,actor_id,action) VALUES($1::bigint,$2::bigint,$3)",share.id,actor || null,action);
}
async function publicWrite(token: string, key: string, input: unknown, run: (tx: Tx, share: Row) => Promise<any>) {
  parse(z.string().min(1).max(128),key);
  return db.$transaction(async tx => {
    const share = await access(tx,token,true);
    const fingerprint = hash(canonical(input));
    const old = await one(tx,"SELECT * FROM selection_collection_requests WHERE collection_id=$1::bigint AND request_key=$2",share.id,key);
    if (old) { if (old.fingerprint !== fingerprint) fail("CONFLICT","请求标识冲突",409); return old.result; }
    const result = json(await run(tx,share));
    await rows(tx,"INSERT INTO selection_collection_requests(collection_id,request_key,fingerprint,result) VALUES($1::bigint,$2,$3,$4::jsonb)",share.id,key,fingerprint,JSON.stringify(result));
    return result;
  },{timeout:15000});
}
async function aggregate(tx: Tx, share: Row) {
  await rows(tx,`UPDATE selection_collections SET status=(
    SELECT CASE WHEN bool_and(status='APPROVED') THEN 'APPROVED'
      WHEN bool_or(status='SUBMITTED') THEN 'SUBMITTED'
      WHEN bool_or(status='REJECTED') THEN 'REJECTED' ELSE 'DRAFT' END
    FROM selection_collection_items WHERE collection_id=$1::bigint),feedback='' WHERE id=$1::bigint`,share.id);
}
async function bump(tx: Tx, share: Row, action: string) {
  await rows(tx,"UPDATE selection_collections SET revision=revision+1,updated_at=now() WHERE id=$1::bigint",share.id);
  await event(tx,share,action);
  return {revision:share.revision+1};
}
function version(share: Row, revision: number) {
  if (share.revision !== revision) fail("EDIT_CONFLICT","资料已在其他设备更新，请刷新后核对再编辑",409);
}
export async function create(c: Context, input: unknown) {
  const body = parse(z.object({title:z.string().trim().min(1).max(100),ids:z.array(id).min(1).max(100),days:z.union([z.literal(7),z.literal(30),z.literal(0)])}).strict(),input);
  await protection.collectionRights(db,c,body.ids,true);
  return command(c,"selection-collections/create",body,async tx => {
    const p=await protection.writeLocks(tx,c);
    await protection.collectionRights(tx,c,body.ids,true,p);
    const ids = [...new Set(body.ids)];
    const source = await rows(tx,"SELECT * FROM style_selections WHERE id=ANY($1::bigint[]) ORDER BY id FOR SHARE",ids);
    if (source.length !== ids.length) fail("NOT_FOUND","部分款式不存在，请刷新后重试",404);
    const token = randomBytes(32).toString("hex");
    const share = (await one(tx,"INSERT INTO selection_collections(title,token_hash,expires_at,created_by) VALUES($1,$2,CASE WHEN $3::int=0 THEN NULL ELSE now()+make_interval(days=>$3::int) END,$4::bigint) RETURNING id",body.title,hash(token),body.days,c.actor.id))!;
    for (const [index,value] of ids.entries()) {
      const row = source.find(row=>String(row.id)===value)!; const data = JSON.stringify(snapshot(row));
      await rows(tx,"INSERT INTO selection_collection_items(collection_id,selection_id,position,source_version,xuti_style_no,original,draft) VALUES($1::bigint,$2::bigint,$3,$4,$5,$6::jsonb,$6::jsonb)",share.id,value,index,row.version,row.xuti_style_no || "",data);
    }
    await event(tx,share,"CREATE",c.actor.id);
    await audit(tx,c,"CREATE","selection-collection",share.id,null,{title:body.title,ids,days:body.days});
    return {id:share.id,token};
  });
}
export async function list(c:Context) {
  const shares=await rows(db,"SELECT c.id,c.title,c.status,c.closed,c.expires_at,c.revision,c.feedback,c.created_at,count(i.selection_id)::int AS count FROM selection_collections c LEFT JOIN selection_collection_items i ON i.collection_id=c.id GROUP BY c.id ORDER BY c.id DESC LIMIT 100");
  const visible=[];
  for(const share of shares){try{await protection.shareRights(db,c,String(share.id));visible.push(share);}catch(error){if(![403,404].includes((error as {getStatus?:()=>number}).getStatus?.() || 0))throw error;}}
  return visible;
}
export async function detail(c:Context,value: string) {
  await protection.shareRights(db,c,value);
  const share = await one(db,"SELECT id,title,status,closed,expires_at,revision,feedback FROM selection_collections WHERE id=$1::bigint",value);
  if (!share) fail("NOT_FOUND","收集表不存在",404);
  const items=await rows(db,"SELECT selection_id AS id,xuti_style_no,status,feedback,source_version,original,draft FROM selection_collection_items WHERE collection_id=$1::bigint ORDER BY position",value);
  const sources=await rows(db,"SELECT id,supplier_style_no,color,size_range,material,supply_price_excl_tax,selling_points,reorder_days,collection_inventory,images FROM style_selections WHERE id=ANY($1::bigint[])",items.map(item=>item.id));
  const byId=new Map(sources.map(source=>[String(source.id),source]));
  return {...share,items:items.map(item=>{
    const source=byId.get(String(item.id));
    return {...item,current:source?snapshot(source):null,
      overwrittenFields:source?reconcile(item,source).overwritten.map(field=>collectionFieldNames[field]):[]};
  })};
}
export async function withdrawItem(c: Context, value: string, itemId: string, input: unknown) {
  const body=parse(z.object({revision:z.number().int().min(0)}).strict(),input);
  await protection.shareRights(db,c,value,true);
  return command(c,"selection-collections/withdraw-item/"+value+"/"+itemId,body,async tx=>{
    const policy=await protection.writeLocks(tx,c);await protection.shareRights(tx,c,value,true,policy);
    const share=await internal(tx,value);version(share,body.revision);
    if(share.closed)fail("INVALID_STATE","收集表已关闭，请先重新生成分享链接",409);
    const item=await one(tx,"SELECT * FROM selection_collection_items WHERE collection_id=$1::bigint AND selection_id=$2::bigint",value,itemId);
    if(!item)fail("NOT_FOUND","款式不在收集表内",404);
    if(item.status==="APPROVED")fail("INVALID_STATE","已确认款式不可撤回",409);
    await rows(tx,"DELETE FROM selection_collection_items WHERE collection_id=$1::bigint AND selection_id=$2::bigint",value,itemId);
    await aggregate(tx,share);
    await rows(tx,"UPDATE selection_collections SET revision=revision+1,updated_at=now() WHERE id=$1::bigint",value);
    await event(tx,share,"ITEM_WITHDRAW",c.actor.id);
    await audit(tx,c,"DELETE","selection-collection-item",itemId,item,null,`从收集表 ${value} 撤回单款`);
    return {revision:share.revision+1};
  });
}
export async function editItem(c: Context, value: string, itemId: string, input: unknown) {
  const body=parse(z.discriminatedUnion("action",[
    z.object({action:z.literal("rename"),revision:z.number().int().min(0),xutiStyleNo:z.string().trim().max(64)}).strict(),
    z.object({action:z.literal("replace"),revision:z.number().int().min(0),targetId:id}).strict(),
  ]),input);
  await protection.shareRights(db,c,value,true);
  if(body.action==="replace")await protection.collectionRights(db,c,[body.targetId],true);
  else await protection.preflight(c,itemId,{xutiStyleNo:body.xutiStyleNo || null});
  return command(c,"selection-collections/edit-item/"+value+"/"+itemId,body,async tx=>{
    const policy=await protection.writeLocks(tx,c);await protection.shareRights(tx,c,value,true,policy);
    const share=await internal(tx,value);version(share,body.revision);
    if(share.closed)fail("INVALID_STATE","收集表已关闭，请先重新生成分享链接",409);
    const item=await one(tx,"SELECT * FROM selection_collection_items WHERE collection_id=$1::bigint AND selection_id=$2::bigint",value,itemId);
    if(!item)fail("NOT_FOUND","款式不在收集表内",404);
    if(item.status==="APPROVED")fail("INVALID_STATE","已确认款式不可重新编辑",409);
    if(body.action==="rename"){
      const source=await one(tx,"SELECT * FROM style_selections WHERE id=$1::bigint FOR UPDATE",itemId);
      if(!source || source.version!==item.source_version)fail("EDIT_CONFLICT","原款资料已变化，请重新生成收集表后再编辑",409);
      const security=await protection.assertWrite(tx,c,source!,{xutiStyleNo:body.xutiStyleNo || null},policy);
      await rows(tx,"UPDATE style_selections SET cell_owners=$2::jsonb,claimed_by=coalesce($3::bigint,claimed_by),updated_by=$4::bigint WHERE id=$1::bigint",itemId,security.cellOwners,security.claimedBy || null,c.actor.id);
      const after=await one(tx,"UPDATE style_selections SET xuti_style_no=$2,version=version+1,updated_at=now() WHERE id=$1::bigint RETURNING *",itemId,body.xutiStyleNo || null);
      await audit(tx,c,"UPDATE","style-selection",itemId,source,after,`更正收集表 ${value} 的序缇款号`);
      await rows(tx,"UPDATE selection_collection_items SET xuti_style_no=$3,source_version=$4,status=CASE WHEN status='SUBMITTED' THEN 'REJECTED' ELSE status END,feedback='内部已更新序缇款号，请核对并重新提交' WHERE collection_id=$1::bigint AND selection_id=$2::bigint",value,itemId,body.xutiStyleNo,after!.version);
    } else {
      if(body.targetId===itemId)fail("VALIDATION_ERROR","请选择另一款替换",400);
      const exists=await one(tx,"SELECT selection_id FROM selection_collection_items WHERE collection_id=$1::bigint AND selection_id=$2::bigint",value,body.targetId);
      if(exists)fail("CONFLICT","目标款式已在这张收集表中",409);
      const source=await one(tx,"SELECT * FROM style_selections WHERE id=$1::bigint FOR SHARE",body.targetId);
      if(!source)fail("NOT_FOUND","目标款式不存在",404);
      await protection.collectionRights(tx,c,[body.targetId],true,policy);
      const draft=JSON.stringify(snapshot(source));
      await rows(tx,"UPDATE selection_collection_items SET selection_id=$3::bigint,source_version=$4,xuti_style_no=$5,original=$6::jsonb,draft=$6::jsonb,status='DRAFT',feedback='内部已更换款式，请重新填写本款' WHERE collection_id=$1::bigint AND selection_id=$2::bigint",value,itemId,body.targetId,source.version,source.xuti_style_no || "",draft);
    }
    await aggregate(tx,share);
    await rows(tx,"UPDATE selection_collections SET revision=revision+1,updated_at=now() WHERE id=$1::bigint",value);
    await event(tx,share,body.action==="rename"?"ITEM_RENAME":"ITEM_REPLACE",c.actor.id);
    const updated=await one(tx,"SELECT * FROM selection_collection_items WHERE collection_id=$1::bigint AND selection_id=$2::bigint",value,body.action==="replace"?body.targetId:itemId);
    await audit(tx,c,"UPDATE","selection-collection-item",itemId,item,updated,`更新收集表 ${value} 中的单款`);
    return {revision:share.revision+1};
  });
}
export async function publicDetail(token: string) {
  const share = await access(db,token);
  const items = await rows(db,"SELECT selection_id AS id,xuti_style_no,status,feedback,draft FROM selection_collection_items WHERE collection_id=$1::bigint ORDER BY position",share.id);
  // Explicit allowlist: never expose source data, audit metadata or internal prices.
  return {title:share.title,status:share.status,revision:share.revision,feedback:share.feedback,expiresAt:share.expires_at,items:items.map(item=>({id:item.id,xutiStyleNo:item.xuti_style_no,status:item.status,feedback:item.feedback,...item.draft,images:(item.draft.images || []).map((image:Row)=>({id:image.id,color:image.color,url:/^\/api\/v1\/style-selections\/images\//.test(image.url) ? null : image.url}))}))};
}
export async function save(token: string, key: string, value: string, input: unknown) {
  const body = parse(z.object({revision:z.number().int().min(0),info:collectionDraftSchema}).strict(),input);
  return publicWrite(token,key,{op:"save",value,body},async(tx,share)=>{
    version(share,body.revision);
    const item = await one(tx,"SELECT * FROM selection_collection_items WHERE collection_id=$1::bigint AND selection_id=$2::bigint",share.id,value);
    if (!item) fail("NOT_FOUND","本款已被内部撤回或替换，请刷新收集表核对",404);
    editable(item);
    const colors = collectionTags(body.info.color);
    if (item.draft.images.some((image:Row)=>image.color && !colors.includes(image.color))) fail("VALIDATION_ERROR","请保留已有图片的颜色，或先移除相关图片",400);
    await rows(tx,"UPDATE selection_collection_items SET draft=$3::jsonb WHERE collection_id=$1::bigint AND selection_id=$2::bigint",share.id,value,JSON.stringify({...body.info,images:item.draft.images}));
    return bump(tx,share,"SAVE");
  });
}
export async function submit(token: string,key: string,input: unknown) {
  const body=parse(z.object({revision:z.number().int().min(0),itemId:id.optional(),itemIds:z.array(id).min(1).max(100).optional(),action:z.enum(["submit","withdraw"]).default("submit")}).strict().superRefine((value,ctx)=>{
    if(value.itemId && value.itemIds)ctx.addIssue({code:"custom",message:"请选择单款或多款提交"});
    if(value.itemIds && new Set(value.itemIds).size!==value.itemIds.length)ctx.addIssue({code:"custom",message:"所选款式不可重复"});
    if(value.action==="withdraw" && value.itemIds)ctx.addIssue({code:"custom",message:"仅支持逐款撤回"});
  }),input);
  return publicWrite(token,key,{op:"submit",body},async(tx,share)=>{
    version(share,body.revision);
    const items=await rows(tx,"SELECT * FROM selection_collection_items WHERE collection_id=$1::bigint"+(body.itemId?" AND selection_id=$2::bigint":body.itemIds?" AND selection_id=ANY($2::bigint[])":"")+" ORDER BY position",share.id,...(body.itemId?[body.itemId]:body.itemIds?[body.itemIds]:[]));
    if(!items.length || (body.itemIds && items.length!==body.itemIds.length))fail("NOT_FOUND","所选款式不在收集表内",404);
    for (const item of items) {
      if(body.action==="withdraw") {
        if(item.status!=="SUBMITTED")fail("INVALID_STATE","仅未被内部确认的已提交款式可撤回",409);
      } else {
        editable(item);
        const {images,...info}=item.draft;
        const checked=collectionSubmissionSchema.safeParse({images,info});
        if(!checked.success)fail("VALIDATION_ERROR",`第${item.position+1}款：${checked.error.issues.map(issue=>issue.message).join("；")}`,400);
      }
      await rows(tx,"UPDATE selection_collection_items SET status=$3,feedback='' WHERE collection_id=$1::bigint AND selection_id=$2::bigint",share.id,item.selection_id,body.action==="withdraw"?"DRAFT":"SUBMITTED");
    }
    await aggregate(tx,share);
    return bump(tx,share,body.action==="withdraw"?"WITHDRAW":"SUBMIT");
  });
}
export async function photo(token: string,key: string,value: string,input: unknown) {
  const body=parse(z.discriminatedUnion("action",[
    z.object({action:z.literal("add"),revision:z.number().int(),color:z.string().max(100),data:z.string().max(1500000)}).strict(),
    z.object({action:z.literal("remove"),revision:z.number().int(),imageId:z.string().max(100)}).strict()
  ]),input);
  return publicWrite(token,key,{op:"photo",value,body},async(tx,share)=>{
    version(share,body.revision);
    const item=await one(tx,"SELECT * FROM selection_collection_items WHERE collection_id=$1::bigint AND selection_id=$2::bigint",share.id,value);
    if(!item) fail("NOT_FOUND","款式不在收集表内",404);
    editable(item);
    let images=item.draft.images || [];
    if(body.action==="remove") images=images.filter((image:Row)=>image.id!==body.imageId);
    else {
      if(!collectionTags(item.draft.color).includes(body.color)) fail("VALIDATION_ERROR","请先保存对应颜色",400);
      if(images.length>=30) fail("VALIDATION_ERROR","每款最多30张图片",400);
      const quota=await one(tx,"SELECT count(*)::int AS n FROM selection_collection_events WHERE collection_id=$1::bigint AND action='PHOTO_ADD'",share.id);
      if(quota!.n>=500) fail("VALIDATION_ERROR","本收集表上传已达500张，请联系分享人",400);
      const match=/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.data);
      if(!match) fail("VALIDATION_ERROR","仅支持 JPG、PNG、WebP 图片",400);
      const bytes=Buffer.from(match![2],"base64"),type=match![1];
      const valid=type==="image/png"?bytes.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex")):type==="image/jpeg"?bytes.subarray(0,3).equals(Buffer.from("ffd8ff","hex")):bytes.toString("ascii",0,4)==="RIFF" && bytes.toString("ascii",8,12)==="WEBP";
      if(!valid || !bytes.length || bytes.length>=500*1024) fail("VALIDATION_ERROR","图片无效或超过500KB",400);
      const imageId=randomUUID();
      await insertImage(tx,imageId,type,bytes,share.created_by);
      images=[...images,{id:imageId,url:selectionUrl("/api/v1/style-selections/images/"+imageId),color:body.color}];
    }
    await rows(tx,"UPDATE selection_collection_items SET draft=$3::jsonb WHERE collection_id=$1::bigint AND selection_id=$2::bigint",share.id,value,JSON.stringify({...item.draft,images}));
    return bump(tx,share,body.action==="add"?"PHOTO_ADD":"PHOTO_REMOVE");
  });
}
export async function image(token:string,value:string,imageId:string) {
  const share=await access(db,token);
  const item=await one(db,"SELECT draft FROM selection_collection_items WHERE collection_id=$1::bigint AND selection_id=$2::bigint",share.id,value);
  const image=item?.draft.images.find((image:Row)=>image.id===imageId);
  if(!image) fail("NOT_FOUND","图片不在收集表内",404);
  const match=/^\/api\/v1\/style-selections\/images\/([a-f0-9-]{36})(?:\?tableId=[1-9]\d*)?$/.exec(image.url);
  if(!match) fail("NOT_FOUND","图片不存在",404);
  return readStoredImage(match![1]);
}
export async function review(c:Context,value:string,input:unknown) {
  const body=parse(z.object({itemId:id.optional(),action:z.enum(["approve","reject","close","renew"]),revision:z.number().int(),reason:z.string().trim().max(1000).default(""),days:z.union([z.literal(7),z.literal(30),z.literal(0)]).optional()}).strict(),input);
  if(body.action!=="close" || !protection.protectionAdmin(c.actor))await protection.shareRights(db,c,value,body.action!=="close");
  return command(c,"selection-collections/review/"+value,body,async tx=>{
    const policy=await protection.writeLocks(tx,c);
    if(body.action!=="close" || !protection.protectionAdmin(c.actor))await protection.shareRights(tx,c,value,body.action!=="close",policy);
    const share=await internal(tx,value);version(share,body.revision);
    let token: string | undefined;
    if(body.action==="close") await rows(tx,"UPDATE selection_collections SET closed=true WHERE id=$1::bigint",value);
    else if(body.action==="renew") {
      if(body.days===undefined) fail("VALIDATION_ERROR","请选择有效期",400);
      token=randomBytes(32).toString("hex");
      await rows(tx,"UPDATE selection_collections SET token_hash=$2,closed=false,expires_at=CASE WHEN $3::int=0 THEN NULL ELSE now()+make_interval(days=>$3::int) END WHERE id=$1::bigint",value,hash(token),body.days);
    } else {
      const items=await rows(tx,"SELECT * FROM selection_collection_items WHERE collection_id=$1::bigint AND status='SUBMITTED'"+(body.itemId?" AND selection_id=$2::bigint":"")+" ORDER BY selection_id",value,...(body.itemId?[body.itemId]:[]));
      if(!items.length) fail("INVALID_STATE","没有待确认的款式，可能已被撤回或处理",409);
      if(body.action==="reject") {
        if(!body.reason) fail("VALIDATION_ERROR","请填写退回原因",400);
        for(const item of items) await rows(tx,"UPDATE selection_collection_items SET status='REJECTED',feedback=$3 WHERE collection_id=$1::bigint AND selection_id=$2::bigint",value,item.selection_id,body.reason);
      } else {
        for(const item of items) {
          const source=await one(tx,"SELECT * FROM style_selections WHERE id=$1::bigint FOR UPDATE",item.selection_id);
          if(!source) fail("EDIT_CONFLICT",`第${item.position+1}款原款已删除，本次未更新任何款式`,409);
          const {merged}=reconcile(item,source);
          const {images,...info}=merged;parse(collectionInfoSchema,info);
          const patch={supplierStyleNo:info.supplierStyleNo || null,color:info.color || null,sizeRange:info.sizeRange || null,material:info.material || null,supplyPriceExclTax:info.supplyPriceExclTax,sellingPoints:info.sellingPoints,reorderDays:info.reorderDays,collectionInventory:info.inventory,images};
          const security=await protection.assertWrite(tx,c,source!,patch,policy);
          await rows(tx,"UPDATE style_selections SET cell_owners=$2::jsonb,claimed_by=coalesce($3::bigint,claimed_by),updated_by=$4::bigint WHERE id=$1::bigint",item.selection_id,security.cellOwners,security.claimedBy || null,c.actor.id);
          const after=await one(tx,"UPDATE style_selections SET supplier_style_no=$2,color=$3,size_range=$4,material=$5,supply_price_excl_tax=$6::numeric,selling_points=$7,reorder_days=$8,collection_inventory=$9::jsonb,images=$10::jsonb,version=version+1,updated_at=now() WHERE id=$1::bigint RETURNING *",item.selection_id,info.supplierStyleNo || null,info.color || null,info.sizeRange || null,info.material || null,info.supplyPriceExclTax,info.sellingPoints,info.reorderDays,JSON.stringify(info.inventory),JSON.stringify(images));
          await audit(tx,c,"UPDATE","style-selection",item.selection_id,source,after,"确认外部产品信息收集表");
          await rows(tx,"UPDATE selection_collection_items SET status='APPROVED' WHERE collection_id=$1::bigint AND selection_id=$2::bigint",value,item.selection_id);
        }

      }
    }
    await aggregate(tx,share);
    await rows(tx,"UPDATE selection_collections SET revision=revision+1,updated_at=now() WHERE id=$1::bigint",value);
    await event(tx,share,body.action.toUpperCase(),c.actor.id);
    return {revision:share.revision+1,...(token?{token}:{})};
  });
}

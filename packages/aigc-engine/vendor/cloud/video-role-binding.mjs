import { selectedCast, normalizeUnitCast } from "../shared/project-cast.mjs";
import { videoRoleProfile } from "../shared/video-role-profile.mjs";
import { referenceEntries } from "./consistency.mjs";

export const ROLE_BINDING_VERSION = "model-cast-v1";
export function modelRoleBinding(project, unit, model, hasReviewedFrame) {
  const profile=videoRoleProfile(model), cast=selectedCast(project), entries=referenceEntries(project);
  const scope=normalizeUnitCast(project,unit);
  const roleIds=scope.character_ids || cast.roles.map(r=>r.id), productIds=scope.product_ids || cast.products.map(p=>p.id);
  // Legacy one-person projects keep their implicit group, while explicit casts
  // must have unambiguous ownership in the exact image array being submitted.
  if(project.cast){
    for(const groups of [cast.roles,cast.products]){
      if(new Set(groups.map(g=>g.id)).size!==groups.length)throw Error("角色或商品编号重复，未提交视频");
      const seen=new Map();
      for(const group of groups)for(const image of group.images){
        if(seen.has(image.path)&&seen.get(image.path)!==group.id)throw Error("同一原图被分配给不同角色或商品组，请拆分或更正归属；未提交视频");
        seen.set(image.path,group.id);
      }
    }
    for(const entry of entries)if(entry.kind!=="scene"&&!entry.ownerId)throw Error("参考图片没有可核对的角色或商品归属，未提交视频");
  }
  for(const role of cast.roles.filter(r=>roleIds.includes(r.id)))if(!entries.some(e=>e.kind==="identity"&&e.ownerId===role.id))throw Error("出镜角色缺少人物参考图，未提交视频");
  for(const product of cast.products.filter(p=>productIds.includes(p.id))){
    if(!roleIds.includes(product.roleId))throw Error("商品绑定角色未在本段出镜，未提交视频");
    if(!entries.some(e=>e.kind==="product"&&e.ownerId===product.id))throw Error("本段商品缺少参考图，未提交视频");
  }
  for(const shot of unit.shot_plan || []){
    const s=normalizeUnitCast(project,{...shot,character_ids:shot.character_ids??roleIds,product_ids:shot.product_ids??productIds});
    if(s.character_ids?.some(id=>!roleIds.includes(id))||s.product_ids?.some(id=>!productIds.includes(id)))throw Error("分镜角色或商品超出本段绑定范围，未提交视频");
  }
  const firstFrame=profile.mode==="first-frame";
  if(firstFrame&&!hasReviewedFrame)throw Error("单首帧模型需要已核对的多角色首帧，未提交视频");
  const imageCount=firstFrame?1:entries.length+Number(hasReviewedFrame);
  if(model.maxImages&&imageCount>model.maxImages)throw Error("多角色人物、商品与场景参考图超过当前模型上限，不能静默丢图；请精简或切换模型");
  const ref=n=>profile.syntax==="seedance"?"@Image "+n:profile.syntax==="h3"?"Image "+n:profile.syntax==="ordinal"?"第"+n+"张参考图":"<IMAGE_"+n+">";
  const lines=cast.roles.filter(r=>roleIds.includes(r.id)).map(r=>{
    const identity=firstFrame?"首帧内该人物":entries.filter(e=>e.kind==="identity"&&e.ownerId===r.id).map(e=>ref(e.index)).join("、");
    const products=cast.products.filter(p=>productIds.includes(p.id)&&p.roleId===r.id).map(p=>p.name+"（"+(firstFrame?"首帧内对应商品":entries.filter(e=>e.kind==="product"&&e.ownerId===p.id).map(e=>ref(e.index)).join("、"))+"）");
    return "角色「"+r.name+"」身份="+identity+"；仅穿戴/展示="+(products.join("、")||"无指定商品")+"。";
  });
  const header=profile.syntax==="generic"?"":[
    "【"+profile.label+"】",...lines,
    firstFrame?"所有出镜身份与穿戴组合必须已在唯一首帧中呈现；不生成首帧外新人物，不重新设计商品。":"同组人物多图是同一个人；商品图中的模特不参与身份绑定。每镜只出现脚本指定角色，同一角色多款按分镜区分，禁止融合成一件。",
  ].join("\n");
  return {version:ROLE_BINDING_VERSION,mode:profile.mode,syntax:profile.syntax,nativeSubjects:false,imageCount,roleCount:roleIds.length,productCount:productIds.length,header,
    adapt(text){if(firstFrame||profile.syntax==="generic")return text;return String(text).replace(/<?\bIMAGE_(\d+)\b>?/gi,(_,n)=>{if(+n<1||+n>imageCount)throw Error("提示词引用了未发送的图片编号 "+n+"，未提交视频");return ref(+n);});}};
}

export function validateRoleBindingPayload(binding, images) {
  if(!binding)return;
  if(binding.version!==ROLE_BINDING_VERSION||binding.imageCount!==images?.length)throw Error("多角色图片映射与实际提交素材数量不一致，未提交视频");
  if(binding.mode==="first-frame"&&images.length!==1)throw Error("多角色首帧模型只能提交一张已核对首帧");
}

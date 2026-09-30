export const fieldTypes = {text:"文本",number:"数字",date:"日期",single:"单选",multiple:"多选",checkbox:"复选框",currency:"货币",percent:"百分比",link:"超链接",image:"图片",tags:"自定义标签"} as const;
export type FieldType = keyof typeof fieldTypes;
export type SelectionField = {key:string;label:string;width:number;custom?:boolean;type?:FieldType;fallbackType?:FieldType;options?:string[];tagConfig?:{allowCustom:boolean;multiple:boolean;max:number;order:"selection"|"options"|"alphabetical";color:string};imageConfig?:{colors:boolean;links:boolean;upload:boolean;mobile:boolean;max:number}};
export function resetFieldTypes(fields:SelectionField[]):SelectionField[]{
  return fields.map(field=>({...field,fallbackType:field.type || field.fallbackType,type:undefined}));
}
export function allowedFieldTypes(field:SelectionField):FieldType[]{
  if(field.custom)return Object.keys(fieldTypes) as FieldType[];
  if(["images","labelImages"].includes(field.key))return ["image"];
  if(field.key==="registrationBatch")return ["date","text"];
  if(["supplyPriceExclTax","vipPrice","livePrice","tagPrice"].includes(field.key))return ["number","currency","percent","text"];
  if(["collectionInventory","reorderDays"].includes(field.key))return ["number","text"];
  return (Object.keys(fieldTypes) as FieldType[]).filter(type=>type!=="image");
}
export function fieldValueError(field:SelectionField,raw:unknown):string|null {
  const value=String(raw ?? "").trim();if(!value)return null;
  if(field.type==="image"){try{const images=JSON.parse(value);if(!Array.isArray(images) || images.length>(field.imageConfig?.max || 30) || images.some(item=>!item || typeof item.url!=="string" || !/^(https?:\/\/|\/api\/)/.test(item.url)))return "图片数据无效或超过数量上限";return null;}catch{return "图片数据无效";}}
  if(value.length>2000)return "内容最多2000字";
  const type=field.type || "text";
  if(["number","currency","percent"].includes(type) && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value))))return "请输入有效数字";
  if(type==="currency" && !/^[+-]?\d+(?:\.\d{1,2})?$/.test(value))return "货币最多两位小数";
  if(type==="date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value))return "请输入有效日期 YYYY-MM-DD";
  if(type==="checkbox" && !["true","false"].includes(value))return "复选框值应为 true 或 false";
  if(type==="link"){try{const url=new URL(value);if(!["https:","http:"].includes(url.protocol))return "仅支持 http(s) 链接";}catch{return "请输入完整 http(s) 链接";}}
  if(type==="tags"){
    const tags=splitFieldTags(value),config={...defaultTagConfig,...field.tagConfig};
    if(tags.some(tag=>tag.length>80))return "单个标签最多80字";
    if(tags.length>(config.multiple?config.max:1))return "标签数量超过字段设置上限";
    if(!config.allowCustom && tags.some(tag=>!field.options?.includes(tag)))return "只能选择候选标签";
  }
  if(type==="single" && !field.options?.includes(value))return "请选择已配置的选项";
  if(type==="multiple" && value.split("/").some(item=>!field.options?.includes(item)))return "多选值须来自已配置选项，使用 / 分隔";
  return null;
}

export const defaultImageConfig={colors:true,links:true,upload:true,mobile:true,max:30};
export function fieldImages(value:unknown):{id:string;url:string;color:string}[]{try{const parsed=JSON.parse(String(value || "[]"));return Array.isArray(parsed)?parsed.filter(item=>item && typeof item.id==="string" && typeof item.url==="string"):[];}catch{return [];}}

export const defaultTagConfig={allowCustom:true,multiple:true,max:30,order:"selection" as const,color:"orange"};
export function splitFieldTags(value:unknown):string[]{return [...new Set(String(value ?? "").split("/").map(tag=>tag.trim()).filter(Boolean))];}
export function orderedFieldTags(field:SelectionField,value:unknown):string[]{
 const tags=splitFieldTags(value),order=field.tagConfig?.order;
 if(order==="alphabetical")return tags.sort((a,b)=>a.localeCompare(b,"zh-CN"));
 if(order==="options"){const options=field.options || [];return tags.sort((a,b)=>{const rank=(tag:string)=>options.includes(tag)?options.indexOf(tag):options.length;return rank(a)-rank(b);});}
 return tags;
}

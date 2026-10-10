export const fieldTypes = {text:"文本",number:"数字",date:"日期",single:"单选",multiple:"多选",checkbox:"复选框",currency:"货币",percent:"百分比",link:"超链接",image:"图片",tags:"自定义标签",creator:"创建人",modifier:"最后修改人",createdTime:"创建时间",modifiedTime:"最后修改时间",autonumber:"编号"} as const;
export const systemFieldTypes=new Set<string>(["creator","modifier","createdTime","modifiedTime","autonumber"]);
export const systemField=(field:SelectionField)=>systemFieldTypes.has(field.type || field.fallbackType || "");
export type FieldType = keyof typeof fieldTypes;
import type { SelectionField } from "../../../packages/contracts/src/selection-layout.js";
export type { SelectionField };
import {splitFieldTags} from "../../../packages/contracts/src/selection-field-validation.js";
export {defaultTagConfig,splitFieldTags,fieldValueError,splitChoiceValues,joinChoiceValues,supportsSlashChoices,isEncodedChoiceValue} from "../../../packages/contracts/src/selection-field-validation.js";
export const selectionOptionPalette = [
  { key: "orange", label: "暖橙", background: "#ad4c0c" },
  { key: "green", label: "松绿", background: "#527761" },
  { key: "blue", label: "雾蓝", background: "#557399" },
  { key: "teal", label: "青色", background: "#427b80" },
  { key: "purple", label: "灰紫", background: "#80658b" },
  { key: "brown", label: "棕色", background: "#886447" },
  { key: "red", label: "陶红", background: "#aa5b4c" },
  { key: "gray", label: "暖灰", background: "#77736f" },
];
export function selectionOptionColor(field: SelectionField, value: string) {
  const configured = selectionOptionPalette.find(color => color.key === field.optionColors?.[value]);
  const index = Math.max(0, field.options?.indexOf(value) ?? 0);
  return configured || selectionOptionPalette[index % selectionOptionPalette.length];
}
export function resetFieldTypes(fields:SelectionField[]):SelectionField[]{
  return fields.map(field=>({...field,fallbackType:field.type || field.fallbackType,type:undefined}));
}
export function allowedFieldTypes(field:SelectionField):FieldType[]{
  if(field.custom)return Object.keys(fieldTypes) as FieldType[];
  if(["images","labelImages"].includes(field.key))return ["image"];
  if(field.key==="registrationBatch")return ["date","text"];
  if(["supplyPriceExclTax","vipPrice","livePrice","tagPrice"].includes(field.key))return ["number","currency","percent","text"];
  if(["collectionInventory","reorderDays"].includes(field.key))return ["number","text"];
  return (Object.keys(fieldTypes) as FieldType[]).filter(type=>type!=="image" && !systemFieldTypes.has(type));
}

export const defaultImageConfig={autoplay:true,colors:true,links:true,upload:true,mobile:true,max:30};
export function fieldImages(value:unknown):{id:string;url:string;color:string}[]{try{const parsed=JSON.parse(String(value || "[]"));return Array.isArray(parsed)?parsed.filter(item=>item && typeof item.id==="string" && typeof item.url==="string"):[];}catch{return [];}}

export function orderedFieldTags(field:SelectionField,value:unknown):string[]{
 const tags=splitFieldTags(value),order=field.tagConfig?.order;
 if(order==="alphabetical")return tags.sort((a,b)=>a.localeCompare(b,"zh-CN"));
 if(order==="options"){const options=field.options || [];return tags.sort((a,b)=>{const rank=(tag:string)=>options.includes(tag)?options.indexOf(tag):options.length;return rank(a)-rank(b);});}
 return tags;
}

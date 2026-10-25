export const fieldTypes = {text:"文本",number:"数字",date:"日期",single:"单选",multiple:"多选",checkbox:"复选框",currency:"货币",percent:"百分比",link:"超链接",image:"图片",tags:"自定义标签",vipTagPriceLimit:"唯品吊牌限价",creator:"创建人",modifier:"最后修改人",createdTime:"创建时间",modifiedTime:"最后修改时间",autonumber:"编号"} as const;
export const systemFieldTypes=new Set<string>(["creator","modifier","createdTime","modifiedTime","autonumber","vipTagPriceLimit"]);
export const systemField=(field:SelectionField)=>systemFieldTypes.has(field.type || field.fallbackType || "");
export type FieldType = keyof typeof fieldTypes;
import type { SelectionField } from "../../../packages/contracts/src/selection-layout.js";
export type { SelectionField };
import {splitFieldTags} from "../../../packages/contracts/src/selection-field-validation.js";
export {defaultTagConfig,splitFieldTags,fieldValueError,splitChoiceValues,joinChoiceValues,supportsSlashChoices,isEncodedChoiceValue} from "../../../packages/contracts/src/selection-field-validation.js";
export const selectionOptionPalette = [
  { key: "blue", label: "靛蓝", background: "#e8edff", color: "#354cb5", darkBackground: "#26335c", darkColor: "#bac8ff" },
  { key: "teal", label: "青蓝", background: "#e5f3f5", color: "#23616c", darkBackground: "#203d46", darkColor: "#9ed9e3" },
  { key: "purple", label: "雾紫", background: "#f0ebfa", color: "#654a98", darkBackground: "#383047", darkColor: "#d0bcef" },
  { key: "green", label: "薄荷", background: "#e8f2ef", color: "#386553", darkBackground: "#253d35", darkColor: "#b0d6c2" },
  { key: "orange", label: "琥珀", background: "#fff2dd", color: "#865820", darkBackground: "#443520", darkColor: "#e9c994" },
  { key: "red", label: "玫瑰", background: "#faeaef", color: "#944c65", darkBackground: "#472d38", darkColor: "#e8b0c2" },
  { key: "brown", label: "岩褐", background: "#f0ece8", color: "#6d5f55", darkBackground: "#39322f", darkColor: "#d3c2b6" },
  { key: "gray", label: "银灰", background: "#edeff4", color: "#586174", darkBackground: "#303540", darkColor: "#bac2d2" },
];
export function selectionOptionStyle(color: (typeof selectionOptionPalette)[number]) {
  return { "--choice-light-bg": color.background, "--choice-light-text": color.color, "--choice-dark-bg": color.darkBackground, "--choice-dark-text": color.darkColor };
}
export function selectionOptionColor(field: SelectionField, value: string) {
  const configured = selectionOptionPalette.find(color => color.key === field.optionColors?.[value]);
  const index = Math.max(0, field.options?.indexOf(value) ?? 0);
  return configured || selectionOptionPalette[index % selectionOptionPalette.length];
}
export function resetFieldTypes(fields:SelectionField[]):SelectionField[]{
  return fields.map(field=>({...field,fallbackType:field.type || field.fallbackType,type:undefined}));
}
export function allowedFieldTypes(field:SelectionField):FieldType[]{
  if(field.custom)return (Object.keys(fieldTypes) as FieldType[]).filter(type=>type!=="vipTagPriceLimit" || !field.key.startsWith("custom:product:"));
  if(["images","labelImages"].includes(field.key))return ["image"];
  if(field.key==="registrationBatch")return ["createdTime"];
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

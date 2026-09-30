import {describe,it,expect} from "vitest";
import {resetFieldTypes,allowedFieldTypes,defaultTagConfig,orderedFieldTags,fieldValueError,fieldImages,type SelectionField} from "../../apps/web/src/selection-field-types.js";
const field=(type:SelectionField["type"]):SelectionField=>({key:"custom:test",label:"测试",width:180,custom:true,type});
it("initializes type metadata without changing fields or old rendering",()=>{
 const original={...field("tags"),options:["A","B"],tagConfig:defaultTagConfig};
 const reset=resetFieldTypes([original])[0];expect(reset.type).toBeUndefined();expect(reset.fallbackType).toBe("tags");expect(reset.options).toEqual(["A","B"]);expect(reset.label).toBe(original.label);expect(original.type).toBe("tags");expect(resetFieldTypes([reset])[0].fallbackType).toBe("tags");
});
it("offers field types compatible with business storage",()=>{
 expect(allowedFieldTypes({...field(undefined),custom:false,key:"registrationBatch"})).toEqual(["date","text"]);
 expect(allowedFieldTypes({...field(undefined),custom:false,key:"color"})).toContain("tags");
 expect(allowedFieldTypes({...field(undefined),custom:false,key:"images"})).toEqual(["image"]);
 expect(allowedFieldTypes(field(undefined))).toContain("image");
});
describe("selection field values",()=>{
 it("keeps zero and validates decimal currency",()=>{expect(fieldValueError(field("number"),0)).toBeNull();expect(fieldValueError(field("currency"),"-12.20")).toBeNull();expect(fieldValueError(field("currency"),"12.201")).toBeTruthy();});
 it("rejects invalid calendar dates and active URL schemes",()=>{expect(fieldValueError(field("date"),"2026-02-30")).toBeTruthy();expect(fieldValueError(field("date"),"2028-02-29")).toBeNull();expect(fieldValueError(field("link"),"javascript:alert(1)")).toBeTruthy();});
 it("checks choices and checkbox values",()=>{expect(fieldValueError({...field("multiple"),options:["A","B"]},"A/B")).toBeNull();expect(fieldValueError({...field("single"),options:["A"]},"B")).toBeTruthy();expect(fieldValueError(field("checkbox"),"false")).toBeNull();});
 it("validates image limits and retains separate lists",()=>{const value=JSON.stringify([{id:"a",url:"https://example.com/a.png",color:"白"},{id:"b",url:"/api/v1/style-selections/images/b",color:""}]);expect(fieldImages(value)).toHaveLength(2);expect(fieldValueError({...field("image"),imageConfig:{colors:true,links:true,upload:true,mobile:true,max:1}},value)).toBeTruthy();expect(fieldImages("invalid")).toEqual([]);});
});

describe("custom tags",()=>{
 it("deduplicates and follows configured candidate order",()=>{const tags={...field("tags"),options:["S","M","L"],tagConfig:{...defaultTagConfig,order:"options" as const}};expect(orderedFieldTags(tags,"L/S/L/ 新标签 ")).toEqual(["S","L","新标签"]);});
 it("enforces free entry and count settings without clearing existing data",()=>{expect(fieldValueError({...field("tags"),options:["A"],tagConfig:{...defaultTagConfig,allowCustom:false}},"B")).toBeTruthy();expect(fieldValueError({...field("tags"),tagConfig:{...defaultTagConfig,multiple:false}},"A/B")).toBeTruthy();expect(fieldValueError(field("tags"),"新标签/新标签")).toBeNull();});
});

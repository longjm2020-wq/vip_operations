import {describe,it,expect} from "vitest";
import {fieldValueError,fieldImages,type SelectionField} from "../../apps/web/src/selection-field-types.js";
const field=(type:SelectionField["type"]):SelectionField=>({key:"custom:test",label:"测试",width:180,custom:true,type});
describe("selection field values",()=>{
 it("keeps zero and validates decimal currency",()=>{expect(fieldValueError(field("number"),0)).toBeNull();expect(fieldValueError(field("currency"),"-12.20")).toBeNull();expect(fieldValueError(field("currency"),"12.201")).toBeTruthy();});
 it("rejects invalid calendar dates and active URL schemes",()=>{expect(fieldValueError(field("date"),"2026-02-30")).toBeTruthy();expect(fieldValueError(field("date"),"2028-02-29")).toBeNull();expect(fieldValueError(field("link"),"javascript:alert(1)")).toBeTruthy();});
 it("checks choices and checkbox values",()=>{expect(fieldValueError({...field("multiple"),options:["A","B"]},"A/B")).toBeNull();expect(fieldValueError({...field("single"),options:["A"]},"B")).toBeTruthy();expect(fieldValueError(field("checkbox"),"false")).toBeNull();});
 it("validates image limits and retains separate lists",()=>{const value=JSON.stringify([{id:"a",url:"https://example.com/a.png",color:"白"},{id:"b",url:"/api/v1/style-selections/images/b",color:""}]);expect(fieldImages(value)).toHaveLength(2);expect(fieldValueError({...field("image"),imageConfig:{colors:true,links:true,upload:true,mobile:true,max:1}},value)).toBeTruthy();expect(fieldImages("invalid")).toEqual([]);});
});

import { captureVipPage } from "../../../packages/contracts/src/competitor-capture";
export { captureVipPage } from "../../../packages/contracts/src/competitor-capture";
export function captureBookmarkUrl() {
  return `javascript:(()=>{try{const collect=${captureVipPage.toString()};const data=collect({href:location.href,observedAt:new Date().toISOString()});const u=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download=data.brandName+'-'+data.kind+'-'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}catch(e){alert(e.message);}})()`;
}

import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Card, Checkbox, Collapse, Descriptions, Drawer, Empty, Form, Image, Input, InputNumber, Modal, Popconfirm, QRCode, Select, Space, Spin, Table, Tabs, Tag, Typography } from "antd";
import { AppstoreOutlined, EditOutlined, CheckCircleOutlined, CameraOutlined, ShareAltOutlined } from "@ant-design/icons";
import { api, queryClient } from "./api";
import { prepareUpload, readUpload } from "./upload-file";
import { CollectionStockEditor } from "./selection-collection-stock";
import { collectionSubmissionSchema, collectionDraftSchema, collectionInventory, collectionTags, type CollectionInfo } from "../../../packages/contracts/src/selection-collection";
import { selectionSizes, sortSelectionSizes } from "../../../packages/contracts/src/selection-sizes";
import "./selection-collections.css";
type Row = Record<string, any>;
const statusNames: Record<string,string> = {DRAFT:"填写中",SUBMITTED:"待内部确认",APPROVED:"已确认",REJECTED:"已退回"};
const shareUrl = (token:string,photo=false,itemId="") => location.origin+"/collect/products"+(photo?"?photo=1"+(itemId?"&item="+encodeURIComponent(itemId):""):"")+"#"+token;
async function external(token:string,path="",method="GET",body?:unknown,key?:string) {
  const response=await fetch("/api/v1/public/selection-collection"+path,{method,credentials:"omit",referrerPolicy:"no-referrer",headers:{"X-Collection-Token":token,...(body?{"Content-Type":"application/json","Idempotency-Key":key || crypto.randomUUID()}: {})},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();
  if(!response.ok) throw new Error(result.error?.message || "操作失败，请稍后重试");
  return result.data;
}
function CollectionImage({token,itemId,image}:{token?:string;itemId:string;image:Row}) {
  const [src,setSrc]=useState(image.url || "");
  useEffect(()=>{
    if(image.url || !token) {setSrc(image.url || "");return;}
    let active=true,url="";
    fetch(`/api/v1/public/selection-collection/${itemId}/images/${encodeURIComponent(image.id)}`,{credentials:"omit",referrerPolicy:"no-referrer",headers:{"X-Collection-Token":token}})
      .then(response=>{if(!response.ok)throw Error();return response.blob();})
      .then(blob=>{url=URL.createObjectURL(blob);if(active)setSrc(url);else URL.revokeObjectURL(url);}).catch(()=>{if(active)setSrc("");});
    return ()=>{active=false;if(url)URL.revokeObjectURL(url);};
  },[token,itemId,image.id,image.url]);
  return src?<Image src={src} alt={image.color || "产品图"} />:<span className="collection-image-missing">图片暂不可用</span>;
}
function Summary({info}:{info:Row}) {
  return <><Descriptions size="small" column={{xs:1,sm:2}} bordered items={[
    {key:"supplier",label:"供应商款号",children:info.supplierStyleNo || "—"},
    {key:"color",label:"颜色",children:info.color || "—"},{key:"size",label:"尺码范围",children:info.sizeRange || "—"},
    {key:"material",label:"材质成分",children:info.material || "—"},{key:"price",label:"供货价（不含税）",children:info.supplyPriceExclTax ?? "—"},
    {key:"points",label:"产品卖点/简介",children:info.sellingPoints || "—"},{key:"days",label:"翻单周期（天）",children:info.reorderDays ?? "—"}
  ]}/><CollectionStockEditor readOnly inventory={info.inventory || []} onChange={()=>{}}/><div className="collection-images">{(info.images || []).map((image:Row)=><div key={image.id}><CollectionImage itemId="" image={image}/><small>{image.color || "未标颜色"}</small></div>)}</div></>;
}
function SourceOverwrite({item}:{item:Row}) {
  if(item.status!=="SUBMITTED")return null;
  if(!item.current)return <Alert type="error" showIcon title="原款已删除" description="请撤回本款并重新选择记录，不能确认写回。" />;
  if(!item.overwrittenFields?.length)return null;
  return <Alert type="warning" showIcon title={`确认时外部稿将覆盖内部修改的${item.overwrittenFields.join("、")}`}
    description={<><p>外部没有修改的收集字段仍保留内部最新值。可展开查看当前选款登记资料，核对外部稿。</p><Collapse items={[{key:"current",label:"查看当前选款登记资料",children:<Summary info={item.current}/>}]} /></>} />;
}
export function SelectionCollections({selectedRows,blocked}:{selectedRows:Row[];blocked:boolean}) {
  const {message}=App.useApp();
  const [open,setOpen]=useState(false),[title,setTitle]=useState("产品信息收集表"),[busy,setBusy]=useState(false);
  const [list,setList]=useState<Row[]>([]),[detail,setDetail]=useState<Row|null>(null),[link,setLink]=useState(""),[reason,setReason]=useState("");
  const [codeEdits,setCodeEdits]=useState<Record<string,string>>({}),[replacementIds,setReplacementIds]=useState<Record<string,string>>({}),[candidateRows,setCandidateRows]=useState<Row[]>([]);
  const attempt=useRef<{body:string;key:string}|null>(null);
  const candidateRequest=useRef(0);
  const reload=async()=>{try{setList((await api("/selection-collections")).data);}catch(error){message.error((error as Error).message);}};
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);try{await action();}catch(error){message.error((error as Error).message);}finally{setBusy(false);}};
  const review=async(action:string,itemId?:string)=>{
    if(!detail)return;
    let result: Row;
    try {
      result=await api(`/selection-collections/${detail.id}/review`,"POST",{action,revision:detail.revision,reason,...(itemId?{itemId}:{}),...(action==="renew"?{days:7}:{})});
    } catch(error) {
      try {setDetail((await api("/selection-collections/"+detail.id)).data);} catch { /* Keep the last comparison visible if refresh fails. */ }
      throw error;
    }
    if(result.data.token)setLink(shareUrl(result.data.token));
    setDetail((await api("/selection-collections/"+detail.id)).data);await reload();
    await queryClient.invalidateQueries({queryKey:["style-selections"]});
    message.success(action==="approve"?"已确认并更新选款登记":"操作已完成");
  };
  const searchCandidates=async(query:string)=>{
    const request=++candidateRequest.current;
    try{const result=await api("/style-selections?pageSize=100&q="+encodeURIComponent(query));if(request===candidateRequest.current)setCandidateRows(result.data || []);}
    catch(error){message.error((error as Error).message);}
  };
  const changeItem=async(itemId:string,path:string,body:Row)=>{
    if(!detail)return;
    await api(`/selection-collections/${detail.id}/items/${itemId}/${path}`,"POST",{revision:detail.revision,...body});
    setDetail((await api("/selection-collections/"+detail.id)).data);
    setCodeEdits(previous=>{const next={...previous};delete next[itemId];return next;});
    setReplacementIds(previous=>{const next={...previous};delete next[itemId];return next;});
    await reload();
    await Promise.all([queryClient.invalidateQueries({queryKey:["style-selections"]}),queryClient.invalidateQueries({queryKey:["style-selection-style-counts"]})]);
    message.success("收集表已更新，外部打开原链接即可看到最新款式");
  };
  return <><Button icon={<ShareAltOutlined/>} onClick={()=>{setOpen(true);void reload();}}>产品信息收集表</Button>
    <Modal open={open} title="产品信息收集表" width={960} footer={null} onCancel={()=>setOpen(false)}>
      <Space wrap><Input aria-label="收集表名称" value={title} maxLength={100} onChange={event=>setTitle(event.target.value)}/><Button type="primary" loading={busy} disabled={blocked || !selectedRows.length || selectedRows.some(row=>!row.id)} onClick={()=>void run(async()=>{
        const body={title,ids:selectedRows.map(row=>String(row.id)),days:7},encoded=JSON.stringify(body);
        if(attempt.current?.body!==encoded)attempt.current={body:encoded,key:crypto.randomUUID()};
        const result=await api("/selection-collections","POST",body,attempt.current!.key);attempt.current=null;setLink(shareUrl(result.data.token));await reload();
      })}>将已选 {selectedRows.length} 款生成收集表</Button></Space>
      <p>默认 7 天有效，可提前关闭。持链接者无需登录即可查看和填写所选款式的指定字段；外部逐款提交后，需内部确认才更新选款登记。请将链接发给对应填写人。</p>
      {blocked && <Alert type="info" title="请先等待选款登记保存完成" />}
      <Table size="small" rowKey="id" dataSource={list} scroll={{x:650}} columns={[
        {title:"名称",dataIndex:"title"},{title:"款数",dataIndex:"count"},{title:"状态",render:(_,row)=>row.closed?"已关闭":statusNames[row.status]},
        {title:"有效期至",render:(_,row)=>row.expiresAt?new Date(row.expiresAt).toLocaleString():"长期"},
        {title:"操作",render:(_,row)=><Button type="link" onClick={()=>void run(async()=>{setDetail((await api("/selection-collections/"+row.id)).data);setReason("");})}>查看 / 管理</Button>}
      ]}/>
    </Modal>
    <Modal title="分享收集表" open={!!link} footer={null} onCancel={()=>setLink("")}><QRCode value={link}/><Typography.Paragraph copyable>{link}</Typography.Paragraph><p>请复制保存本次链接。后续可在管理中重新生成链接，旧链接会立即失效。</p></Modal>
    <Modal title={detail?.title} open={!!detail} width={1000} onCancel={()=>setDetail(null)} footer={null}>
      {detail && <><Alert type="info" title={statusNames[detail.status]+(detail.closed?" · 已关闭":"")} description={detail.feedback || "请核对外部填写稿与原始资料。可以逐款确认；批量确认仅处理待确认款式。确认时外部已修改的收集字段以外部稿为准，外部未修改的字段保留内部最新值。"} />
        <Collapse items={detail.items.map((item:Row)=>({key:item.id,label:`第${detail.items.indexOf(item)+1}款 · ${item.xuti_style_no || "未填序缇款号"} · ${statusNames[item.status]}`,children:<>{item.feedback && <Alert type="warning" title={item.feedback}/>}<h4>外部填写稿</h4><Summary info={item.draft}/><SourceOverwrite item={item}/>{item.status==="SUBMITTED" && <Space><Popconfirm title={item.overwrittenFields?.length?`外部稿将覆盖内部修改的${item.overwrittenFields.join("、")}。确认本款？`:"确认本款并更新选款登记？"} onConfirm={()=>run(()=>review("approve",String(item.id)))}><Button type="primary" disabled={busy || !item.current}>确认本款</Button></Popconfirm><Button disabled={busy || !reason.trim()} onClick={()=>void run(()=>review("reject",String(item.id)))}>退回本款</Button></Space>}{item.status!=="APPROVED" && !detail.closed && <div className="collection-internal-correction"><h4>内部纠错</h4><Space wrap><Input aria-label={`第${detail.items.indexOf(item)+1}款序缇款号`} placeholder="序缇款号（可留空）" maxLength={64} style={{width:210}} value={codeEdits[String(item.id)] ?? item.xuti_style_no ?? ""} onChange={event=>setCodeEdits(previous=>({...previous,[String(item.id)]:event.target.value}))}/><Popconfirm title="修改内部序缇款号并更新外部收集表？已提交款会退回待重新提交。" onConfirm={()=>run(()=>changeItem(String(item.id),"edit",{action:"rename",xutiStyleNo:codeEdits[String(item.id)] ?? item.xuti_style_no ?? ""}))}><Button disabled={busy || (codeEdits[String(item.id)] ?? item.xuti_style_no ?? "") === (item.xuti_style_no ?? "")}>保存款号</Button></Popconfirm></Space><Space wrap><Select showSearch filterOption={false} aria-label={`替换第${detail.items.indexOf(item)+1}款`} placeholder="搜索并选择正确款式" style={{width:260}} value={replacementIds[String(item.id)] || undefined} onFocus={()=>void searchCandidates("")} onSearch={value=>void searchCandidates(value)} onChange={value=>setReplacementIds(previous=>({...previous,[String(item.id)]:value}))} options={candidateRows.filter(row=>!detail.items.some((existing:Row)=>String(existing.id)===String(row.id))).map(row=>({value:String(row.id),label:`${row.xutiStyleNo || "未填序缇款号"} · ${row.supplierStyleNo || "未填供应商款号"} (#${row.id})`}))}/><Popconfirm title="替换后原款草稿会从这张收集表移除，新款需外部重新填写。继续？" onConfirm={()=>run(()=>changeItem(String(item.id),"edit",{action:"replace",targetId:replacementIds[String(item.id)]}))}><Button disabled={busy || !replacementIds[String(item.id)]}>替换本款</Button></Popconfirm><Popconfirm title="从当前收集表撤回本款？外部将不再看到这款。" onConfirm={()=>run(()=>changeItem(String(item.id),"withdraw",{}))}><Button danger disabled={busy}>撤回本款</Button></Popconfirm></Space></div>}<Collapse items={[{key:"original",label:"查看分享时原始资料",children:<Summary info={item.original}/>}]} /></>}))}/>
        {detail.status==="SUBMITTED" && <><Input.TextArea placeholder="退回原因（退回时必填）" value={reason} maxLength={1000} onChange={event=>setReason(event.target.value)}/><Space><Popconfirm title={detail.items.some((item:Row)=>item.status==="SUBMITTED" && item.overwrittenFields?.length)?"确认全部待审款？外部稿会覆盖已被内部修改的同名收集字段。":"确认所有待确认款式并更新选款登记？"} onConfirm={()=>run(()=>review("approve"))}><Button loading={busy} type="primary">确认全部待审款</Button></Popconfirm><Button disabled={busy || !reason.trim()} onClick={()=>void run(()=>review("reject"))}>退回全部待审款</Button></Space></>}
        <Space wrap style={{marginTop:16}}><Button disabled={busy || detail.closed} onClick={()=>void run(()=>review("close"))}>关闭外部访问</Button><Popconfirm title="重新生成7天链接？旧链接将失效" onConfirm={()=>run(()=>review("renew"))}><Button disabled={busy}>重新生成分享链接</Button></Popconfirm></Space>
      </>}
    </Modal>
  </>;
}
function infoOf(row:Row):CollectionInfo {
  return {supplierStyleNo:row.supplierStyleNo || "",color:row.color || "",sizeRange:row.sizeRange || "",material:row.material || "",supplyPriceExclTax:row.supplyPriceExclTax ?? null,sellingPoints:row.sellingPoints || "",reorderDays:row.reorderDays ?? null,inventory:row.inventory || []};
}
export function PublicSelectionCollection() {
  const token=location.hash.slice(1);
  const {message}=App.useApp();
  const [data,setData]=useState<Row|null>(null),[error,setError]=useState(""),[selected,setSelected]=useState(""),[query,setQuery]=useState(""),[busy,setBusy]=useState(false);
  const [info,setInfo]=useState<CollectionInfo|null>(null),[color,setColor]=useState(""),[qr,setQr]=useState(false),[saving,setSaving]=useState(false);
  const [view,setView]=useState("form"),[drawerOpen,setDrawerOpen]=useState(false);
  const [checkedIds,setCheckedIds]=useState<string[]>([]);
  const [scrollRequest,setScrollRequest]=useState({sequence:0,photo:false});
  const [picker,setPicker]=useState<"all"|"pending"|"submitted"|null>(null);
  const dataRef=useRef<Row|null>(null),infoRef=useRef<CollectionInfo|null>(null),selectedRef=useRef("");
  dataRef.current=data;infoRef.current=info;selectedRef.current=selected;
  const camera=useRef<HTMLInputElement>(null),album=useRef<HTMLInputElement>(null);
  const pending=useRef<{fingerprint:string;key:string}|null>(null);
  const saveTask=useRef<Promise<void>|null>(null),operationLock=useRef(false),failedDraft=useRef("");
  const captureTarget=useRef<{id:string;color:string}|null>(null);
  const mobile=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1);
  const current=data?.items.find((item:Row)=>String(item.id)===selected);
  const dirty=!!current && !!info && JSON.stringify(info)!==JSON.stringify(infoOf(current));
  const editable=!!current && ["DRAFT","REJECTED"].includes(current.status);
  const activate=(item:Row,initial=false)=>{
    if(!initial || new URLSearchParams(location.search).get("photo")==="1")setScrollRequest(previous=>({sequence:previous.sequence+1,photo:initial}));
    setPicker(null);
    selectedRef.current=String(item.id);infoRef.current=infoOf(item);setSelected(String(item.id));setInfo(infoRef.current);
    setColor(collectionTags(item.color)[0] || "");failedDraft.current="";
  };
  const load=async(initial=false)=>{
    try {
      const next=await external(token);dataRef.current=next;setData(next);
      if(initial && next.items.length){
        const wanted=new URLSearchParams(location.search).get("item");
        activate(next.items.find((item:Row)=>String(item.id)===wanted) || next.items[0],true);
      } else if(!initial && selectedRef.current && !next.items.some((item:Row)=>String(item.id)===selectedRef.current)) {
        if(next.items.length)activate(next.items[0]);
        else {selectedRef.current="";infoRef.current=null;setSelected("");setInfo(null);setDrawerOpen(false);}
      }
      return next;
    } catch(error){setError((error as Error).message);throw error;}
  };
  useEffect(()=>{void load(true).catch(()=>{});},[token]);
  useEffect(()=>{const before=(event:BeforeUnloadEvent)=>{if(dirty || busy || saving)event.preventDefault();};window.addEventListener("beforeunload",before);return()=>window.removeEventListener("beforeunload",before);},[dirty,busy,saving]);
  const run=async(action:()=>Promise<void>)=>{
    if(operationLock.current)return;
    operationLock.current=true;setBusy(true);
    try{await action();setError("");}catch(error){setError((error as Error).message);}finally{operationLock.current=false;setBusy(false);}
  };
  const mutate=async(path:string,body:unknown)=>{
    const fingerprint=JSON.stringify({path,body});if(pending.current?.fingerprint!==fingerprint)pending.current={fingerprint,key:crypto.randomUUID()};
    const result=await external(token,path,"POST",body,pending.current!.key);pending.current=null;return result;
  };
  const flush=async():Promise<void>=>{
    if(saveTask.current)await saveTask.current;
    const state=dataRef.current,value=infoRef.current,target=selectedRef.current;
    const item=state?.items.find((row:Row)=>String(row.id)===target);
    if(!state || !value || !item || JSON.stringify(value)===JSON.stringify(infoOf(item)))return;
    const parsed=collectionDraftSchema.safeParse(value);
    if(!parsed.success)throw Error(parsed.error.issues.map(issue=>issue.message).join("；"));
    const sent=JSON.stringify(value);
    setSaving(true);
    const task=(async()=>{
      try {
        const result=await mutate("/"+target,{revision:state.revision,info:parsed.data});
        const next={...state,revision:result.revision,items:state.items.map((row:Row)=>String(row.id)===target?{...row,...parsed.data}:row)};
        dataRef.current=next;setData(next);failedDraft.current="";setError("");
        if(selectedRef.current===target && JSON.stringify(infoRef.current)===sent){infoRef.current=parsed.data;setInfo(parsed.data);}
      }catch(error){failedDraft.current=sent;throw error;}
      finally{setSaving(false);}
    })();
    saveTask.current=task;
    try{await task;}finally{saveTask.current=null;}
  };
  useEffect(()=>{
    if(!editable || !dirty || busy || saving || JSON.stringify(info)===failedDraft.current)return;
    const timer=window.setTimeout(()=>{void flush().catch(error=>setError((error as Error).message));},650);
    return()=>window.clearTimeout(timer);
  },[info,dirty,busy,saving,editable]);
  useEffect(()=>{
    if(dirty || busy || saving)return;
    const timer=window.setInterval(()=>{
      const previous=JSON.stringify(infoRef.current),id=selectedRef.current;
      void load().then(next=>{
        if(selectedRef.current===id && JSON.stringify(infoRef.current)===previous){
          const item=next.items.find((item:Row)=>String(item.id)===id);
          if(item){infoRef.current=infoOf(item);setInfo(infoRef.current);}
        }
      }).catch(()=>{});
    },10000);
    return()=>window.clearInterval(timer);
  },[dirty,busy,saving,selected]);
  useEffect(()=>{
    if(!scrollRequest.sequence)return;
    let frame=0;
    frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(()=>{
      if(view==="table"){
        if(drawerOpen)document.querySelector(".collection-editor-drawer .ant-drawer-body")?.scrollTo({top:0,behavior:"instant"});
        return;
      }
      if(!scrollRequest.photo && !window.matchMedia("(max-width:650px)").matches)return;
      const target=document.getElementById(scrollRequest.photo?"collection-photos":"collection-current-editor");
      const header=document.querySelector(".collection-public > header");
      if(target)window.scrollTo({top:Math.max(0,window.scrollY+target.getBoundingClientRect().top-(header?.getBoundingClientRect().height || 0)-8),behavior:"instant"});
    });});
    return()=>cancelAnimationFrame(frame);
  },[scrollRequest,view,drawerOpen]);
  const choose=(item:Row)=>void run(async()=>{await flush();if(document.activeElement instanceof HTMLElement)document.activeElement.blur();activate(dataRef.current!.items.find((row:Row)=>String(row.id)===String(item.id)) || item);if(view==="table")setDrawerOpen(true);});
  const patch=(key:keyof CollectionInfo,value:any)=>setInfo(previous=>{
    if(!previous)return previous;const next={...previous,[key]:value};
    if(key==="color" || key==="sizeRange")next.inventory=collectionInventory(next.color,next.sizeRange,previous.inventory);
    infoRef.current=next;return next;
  });
  const upload=(files:File[])=>void run(async()=>{
    const target=captureTarget.current;
    if(!target || !target.color)throw Error("请先选择颜色");
    await flush();let revision=dataRef.current!.revision;
    try{for(const file of files){const prepared=await prepareUpload(file);const result=await mutate("/"+target.id+"/photos",{action:"add",revision,color:target.color,data:await readUpload(prepared)});revision=result.revision;}}
    finally{await load();}
  });
  const submitCurrent=()=>void run(async()=>{
    await flush();
    const id=selectedRef.current;
    const item=dataRef.current!.items.find((row:Row)=>String(row.id)===id);
    const parsed=collectionSubmissionSchema.safeParse({images:item.images,info:infoRef.current});
    if(!parsed.success)throw Error(parsed.error.issues.map(issue=>issue.message).join("；"));
    await mutate("/submit",{revision:dataRef.current!.revision,itemId:id,action:"submit"});
    const next=await load(),index=next.items.findIndex((item:Row)=>String(item.id)===id);
    setCheckedIds(previous=>previous.filter(value=>value!==id));
    const remaining=[...next.items.slice(index+1),...next.items.slice(0,index)].find((item:Row)=>["DRAFT","REJECTED"].includes(item.status));
    if(remaining){setQuery("");activate(remaining);message.success("本款已提交，已切换到下一款");}
    else {activate(next.items[index]);message.success("本款已提交，所有款式均已提交");}
  });
  if(!data)return <div className="collection-public">{error?<Alert type="error" title={error}/>:<Spin/>}</div>;
  const results=data.items.filter((item:Row)=>(item.xutiStyleNo+" "+item.supplierStyleNo).toLowerCase().includes(query.toLowerCase()));
  const isSubmitted=(item:Row)=>["SUBMITTED","APPROVED"].includes(item.status);
  const pendingItems=data.items.filter((item:Row)=>["DRAFT","REJECTED"].includes(item.status));
  const selectedPending=checkedIds.filter(id=>pendingItems.some((item:Row)=>String(item.id)===id));
  const submitSelected=()=>void run(async()=>{
    await flush();
    const items=dataRef.current!.items.filter((item:Row)=>selectedPending.includes(String(item.id)));
    if(!items.length)throw Error("请先选择待提交的款式");
    for(const item of items){
      const checked=collectionSubmissionSchema.safeParse({images:item.images,info:infoOf(item)});
      if(!checked.success)throw Error(`第${dataRef.current!.items.indexOf(item)+1}款：${checked.error.issues.map(issue=>issue.message).join("；")}`);
    }
    await mutate("/submit",{revision:dataRef.current!.revision,itemIds:items.map((item:Row)=>String(item.id)),action:"submit"});
    const next=await load();setCheckedIds([]);
    const remaining=next.items.find((item:Row)=>["DRAFT","REJECTED"].includes(item.status));
    if(remaining)activate(remaining);else if(next.items.length)activate(next.items[0]);
    message.success(`已提交 ${items.length} 款`);
  });
  const pickerItems=results.filter((item:Row)=>picker==="pending"?!isSubmitted(item):picker==="submitted"?isSubmitted(item):true);
  const styleButton=(item:Row)=><Button block type={String(item.id)===selected?"primary":"default"} disabled={busy} key={item.id} onClick={()=>choose(item)}>第{data.items.findIndex((row:Row)=>row.id===item.id)+1}款 · {item.status==="SUBMITTED"?"已提交":statusNames[item.status]}</Button>;
  const editor=current && info && <Card id="collection-current-editor" title={`第${data.items.findIndex((item:Row)=>item.id===current.id)+1}款${current.xutiStyleNo?" · "+current.xutiStyleNo:""}`}>
      <Form layout="vertical" disabled={!editable || busy}><div className="collection-fields">
        <Form.Item label="序缇款号" extra="仅内部可填写，不影响提交"><Input value={current.xutiStyleNo} readOnly disabled/></Form.Item>
        <Form.Item required label="供应商款号"><Input maxLength={64} value={info.supplierStyleNo} onChange={event=>patch("supplierStyleNo",event.target.value)}/></Form.Item>
        <Form.Item required label="颜色"><Select mode="tags" tokenSeparators={["/",";","；"]} value={collectionTags(info.color)} onChange={values=>patch("color",values.join("/"))}/></Form.Item>
        <Form.Item required label="尺码范围"><Select mode="tags" tokenSeparators={["/",";","；"]} value={collectionTags(info.sizeRange)} options={selectionSizes.map(value=>({value,label:value}))} onChange={values=>patch("sizeRange",sortSelectionSizes(values.join("/")))}/></Form.Item>
        <Form.Item required label="材质成分"><Input.TextArea maxLength={2000} value={info.material} onChange={event=>patch("material",event.target.value)}/></Form.Item>
        <Form.Item required label="供货价（不含税）"><InputNumber stringMode min="0" precision={2} value={info.supplyPriceExclTax} onChange={value=>patch("supplyPriceExclTax",value)}/></Form.Item>
        <Form.Item required label="产品卖点/简介"><Input.TextArea showCount maxLength={1000} value={info.sellingPoints} onChange={event=>patch("sellingPoints",event.target.value)}/></Form.Item>
        <Form.Item required label="翻单周期（天）"><InputNumber min={0} max={36500} precision={0} value={info.reorderDays} onChange={value=>patch("reorderDays",value)}/></Form.Item>
      </div></Form>
      <Form.Item required label="库存数"><CollectionStockEditor inventory={info.inventory} readOnly={!editable || busy} onChange={inventory=>patch("inventory",inventory)}/></Form.Item>
      <p className="collection-save-state">{saving?"正在自动保存…":dirty?"待自动保存":"已自动保存"}{error && dirty && <Button size="small" onClick={()=>void run(flush)}>重试保存</Button>}</p>
      <section id="collection-photos"><h3>产品图片 <span aria-label="必填">*</span></h3><Space wrap>{collectionTags(info.color).map(value=><Button key={value} type={color===value?"primary":"default"} disabled={busy} onClick={()=>setColor(value)}>{value}</Button>)}</Space>
        <div className="collection-images">{current.images.filter((image:Row)=>!color || image.color===color || !image.color).map((image:Row)=><div key={image.id}><CollectionImage token={token} itemId={selected} image={image}/><small>{image.color || "未标颜色"}</small>{editable && <Popconfirm title="移除此张图片？" onConfirm={()=>run(async()=>{await flush();await mutate("/"+selected+"/photos",{action:"remove",revision:dataRef.current!.revision,imageId:image.id});await load();})}><Button disabled={busy} size="small" danger>移除</Button></Popconfirm>}</div>)}</div>
        {editable && <><Space wrap><Button icon={<CameraOutlined/>} disabled={busy || !color} onClick={()=>{if(mobile){captureTarget.current={id:selected,color};camera.current?.click();}else void run(async()=>{await flush();setQr(true);});}}>拍照上传</Button><Button disabled={busy || !color} onClick={()=>{captureTarget.current={id:selected,color};album.current?.click();}}>相册 / 本地上传</Button></Space><p>填写内容自动保存。电脑点击拍照上传后扫码，手机可直接拍照；每张自动压缩至 500KB 以下。</p></>}
      </section>
      <Space wrap>{editable && <Button type="primary" loading={busy} onClick={submitCurrent}>提交</Button>}
        {current.status==="SUBMITTED" && <Button disabled={busy} onClick={()=>void run(async()=>{await mutate("/submit",{revision:dataRef.current!.revision,itemId:selected,action:"withdraw"});const next=await load();activate(next.items.find((item:Row)=>String(item.id)===selected));})}>撤回编辑</Button>}
        {current.status==="APPROVED" && <Tag color="green">本款已内部确认</Tag>}
      </Space>
    </Card>;
  return <div className={"collection-public"+(view==="table"?" collection-table-view":"")}>
    <header><h1>{data.title}</h1><Space wrap><Tag>已提交 {data.items.filter((item:Row)=>["SUBMITTED","APPROVED"].includes(item.status)).length}/{data.items.length} 款</Tag><span>有效期：{data.expiresAt?new Date(data.expiresAt).toLocaleString():"长期"}</span></Space><Input.Search aria-label="搜索款号" placeholder="搜索序缇款号 / 供应商款号" value={query} onChange={event=>{setQuery(event.target.value);setPicker("all");}}/></header>
    {error && <Alert closable onClose={()=>setError("")} type="error" title={error} description="未保存内容仍保留在当前页面；如提示其他设备更新，请先保留输入，再重新打开链接核对。" />}
    {current?.feedback && <Alert type="warning" title="本款退回意见" description={current.feedback}/>}
    <Tabs activeKey={view} onChange={key=>void run(async()=>{await flush();setView(key);setPicker(null);setDrawerOpen(false);})} items={[{key:"form",label:"收集表视图",disabled:busy},{key:"table",label:"表格视图",disabled:busy}]} />
    <div className="collection-submit-toolbar"><Space wrap><Button disabled={busy || !pendingItems.length} onClick={()=>setCheckedIds(pendingItems.map((item:Row)=>String(item.id)))}>全选待提交 {pendingItems.length} 款</Button><Button disabled={busy || !checkedIds.length} onClick={()=>setCheckedIds([])}>清空选择</Button><Button type="primary" disabled={busy || !selectedPending.length} loading={busy} onClick={submitSelected}>提交所选 {selectedPending.length} 款</Button></Space><span>必填字段完整后可逐款提交，也可勾选多款一起提交。</span></div>
    {view==="form" && <><div className="collection-mobile-picker">
      <nav aria-label="按提交状态选择款式">{([
        {key:"all",label:"全部",icon:<AppstoreOutlined/>,count:data.items.length},
        {key:"pending",label:"待提交",icon:<EditOutlined/>,count:data.items.filter((item:Row)=>!isSubmitted(item)).length},
        {key:"submitted",label:"已提交",icon:<CheckCircleOutlined/>,count:data.items.filter(isSubmitted).length}
      ] as const).map(group=><Button key={group.key} icon={group.icon} type={picker===group.key?"primary":"default"} aria-expanded={picker===group.key} aria-controls="collection-mobile-styles" onClick={()=>setPicker(picker===group.key?null:group.key)}>{group.label} {group.count}</Button>)}</nav>
      {picker && <div id="collection-mobile-styles" className="collection-mobile-styles">{pickerItems.map(styleButton)}{!pickerItems.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的款式"/>}</div>}
    </div>
    <div className="collection-layout"><aside>{results.map(styleButton)}{!results.length && <Empty description="没有匹配的款式"/>}</aside>
    {editor}</div></>}
    {view==="table" && <div className="collection-table-scroll"><table className="collection-data-table">
      <caption>产品信息汇总 · 点击填写或查看，在侧边栏编辑本款资料</caption>
      <thead><tr>{["选择","款式 / 状态","图片","序缇款号","供应商款号","颜色","尺码范围","材质成分","供货价（不含税）","产品卖点/简介","翻单周期（天）","库存数","操作"].map(label=><th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>{results.map((item:Row)=>{
        const active=String(item.id)===selected,value=active && info?info:infoOf(item);
        const cell=(label:string,content:React.ReactNode)=><td data-label={label}><div>{content ?? "—"}</div></td>;
        return <tr key={item.id} className={active?"collection-table-active":""}>
          {cell("选择",<Checkbox aria-label={`选择第${data.items.findIndex((row:Row)=>row.id===item.id)+1}款`} disabled={busy || isSubmitted(item)} checked={checkedIds.includes(String(item.id))} onChange={event=>setCheckedIds(previous=>event.target.checked?[...previous,String(item.id)]:previous.filter(id=>id!==String(item.id)))}/>)}
          {cell("款式 / 状态",<>第{data.items.findIndex((row:Row)=>row.id===item.id)+1}款<br/><Tag>{item.status==="SUBMITTED"?"已提交":statusNames[item.status]}</Tag></>)}
          {cell("图片",item.images?.length?<div className="collection-table-photo"><CollectionImage token={token} itemId={String(item.id)} image={item.images[0]}/><small>共 {item.images.length} 张</small></div>:"暂无图片")}
          {cell("序缇款号",item.xutiStyleNo || "—")}{cell("供应商款号",value.supplierStyleNo || "—")}
          {cell("颜色",value.color || "—")}{cell("尺码范围",value.sizeRange || "—")}{cell("材质成分",value.material || "—")}
          {cell("供货价（不含税）",value.supplyPriceExclTax)}{cell("产品卖点/简介",value.sellingPoints || "—")}{cell("翻单周期（天）",value.reorderDays)}
          {cell("库存数",<CollectionStockEditor inventory={value.inventory} readOnly={!active || !editable || busy} onChange={inventory=>patch("inventory",inventory)}/>)}
          {cell("操作",<Button disabled={busy} type={active?"primary":"default"} onClick={()=>choose(item)}>{["DRAFT","REJECTED"].includes(item.status)?"填写":"查看"}</Button>)}
        </tr>;
      })}{!results.length && <tr><td colSpan={13}><Empty description="没有匹配的款式"/></td></tr>}</tbody>
    </table></div>}
    <Drawer afterOpenChange={open=>{if(open)document.querySelector(".collection-editor-drawer .ant-drawer-body")?.scrollTo({top:0,behavior:"instant"});}} title="产品信息" placement="right" width="min(760px, 100vw)" open={view==="table" && drawerOpen} onClose={()=>void run(async()=>{await flush();setDrawerOpen(false);})} className="collection-editor-drawer">
      <div className="collection-public collection-drawer-body">
        {error && <Alert type="error" title={error} description="修改仍保留在当前侧边栏，请处理后重试保存或关闭。"/>}
        {current?.feedback && <Alert type="warning" title="本款退回意见" description={current.feedback}/>}
        {view==="table" && drawerOpen && editor}
      </div>
    </Drawer>
    <input hidden ref={camera} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={event=>{const files=Array.from(event.target.files || []);event.currentTarget.value="";upload(files);}}/>
    <input hidden ref={album} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={event=>{const files=Array.from(event.target.files || []);event.currentTarget.value="";upload(files);}}/>
    <Modal open={qr} title="手机免登录拍图" footer={null} onCancel={()=>setQr(false)}><QRCode value={shareUrl(token,true,selected)}/><p>手机扫码后直接进入本款拍图区，无需登录。照片先保存在收集表，本款提交并经内部确认后更新选款登记。</p></Modal>
  </div>;
}

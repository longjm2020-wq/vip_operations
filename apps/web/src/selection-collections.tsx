import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Card, Collapse, Descriptions, Empty, Form, Image, Input, InputNumber, Modal, Popconfirm, QRCode, Select, Space, Spin, Table, Tag, Typography } from "antd";
import { CameraOutlined, ShareAltOutlined } from "@ant-design/icons";
import { api, queryClient } from "./api";
import { prepareUpload, readUpload } from "./upload-file";
import { CollectionStockEditor } from "./selection-collection-stock";
import { collectionInfoSchema, collectionInventory, collectionTags, type CollectionInfo } from "../../../packages/contracts/src/selection-collection";
import { selectionSizes, sortSelectionSizes } from "../../../packages/contracts/src/selection-sizes";
import "./selection-collections.css";
type Row = Record<string, any>;
const statusNames: Record<string,string> = {DRAFT:"填写中",SUBMITTED:"待内部确认",APPROVED:"已确认",REJECTED:"已退回"};
const shareUrl = (token:string,photo=false) => location.origin+"/collect/products"+(photo?"?photo=1":"")+"#"+token;
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
export function SelectionCollections({selectedRows,blocked}:{selectedRows:Row[];blocked:boolean}) {
  const {message}=App.useApp();
  const [open,setOpen]=useState(false),[title,setTitle]=useState("产品信息收集表"),[busy,setBusy]=useState(false);
  const [list,setList]=useState<Row[]>([]),[detail,setDetail]=useState<Row|null>(null),[link,setLink]=useState(""),[reason,setReason]=useState("");
  const attempt=useRef<{body:string;key:string}|null>(null);
  const reload=async()=>{try{setList((await api("/selection-collections")).data);}catch(error){message.error((error as Error).message);}};
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);try{await action();}catch(error){message.error((error as Error).message);}finally{setBusy(false);}};
  const review=async(action:string)=>{
    if(!detail)return;
    const result=await api(`/selection-collections/${detail.id}/review`,"POST",{action,revision:detail.revision,reason,...(action==="renew"?{days:7}:{})});
    if(result.data.token)setLink(shareUrl(result.data.token));
    setDetail((await api("/selection-collections/"+detail.id)).data);await reload();
    await queryClient.invalidateQueries({queryKey:["style-selections"]});
    message.success(action==="approve"?"已确认并更新选款登记":"操作已完成");
  };
  return <><Button icon={<ShareAltOutlined/>} onClick={()=>{setOpen(true);void reload();}}>产品信息收集表</Button>
    <Modal open={open} title="产品信息收集表" width={960} footer={null} onCancel={()=>setOpen(false)}>
      <Space wrap><Input aria-label="收集表名称" value={title} maxLength={100} onChange={event=>setTitle(event.target.value)}/><Button type="primary" loading={busy} disabled={blocked || !selectedRows.length || selectedRows.some(row=>!row.id)} onClick={()=>void run(async()=>{
        const body={title,ids:selectedRows.map(row=>String(row.id)),days:7},encoded=JSON.stringify(body);
        if(attempt.current?.body!==encoded)attempt.current={body:encoded,key:crypto.randomUUID()};
        const result=await api("/selection-collections","POST",body,attempt.current!.key);attempt.current=null;setLink(shareUrl(result.data.token));await reload();
      })}>将已选 {selectedRows.length} 款生成收集表</Button></Space>
      <p>默认 7 天有效，可提前关闭。持链接者无需登录即可查看和填写所选款式的指定字段；外部提交后，需内部确认才更新选款登记。请将链接发给对应填写人。</p>
      {blocked && <Alert type="info" title="请先等待选款登记保存完成" />}
      <Table size="small" rowKey="id" dataSource={list} scroll={{x:650}} columns={[
        {title:"名称",dataIndex:"title"},{title:"款数",dataIndex:"count"},{title:"状态",render:(_,row)=>row.closed?"已关闭":statusNames[row.status]},
        {title:"有效期至",render:(_,row)=>row.expiresAt?new Date(row.expiresAt).toLocaleString():"长期"},
        {title:"操作",render:(_,row)=><Button type="link" onClick={()=>void run(async()=>{setDetail((await api("/selection-collections/"+row.id)).data);setReason("");})}>查看 / 管理</Button>}
      ]}/>
    </Modal>
    <Modal title="分享收集表" open={!!link} footer={null} onCancel={()=>setLink("")}><QRCode value={link}/><Typography.Paragraph copyable>{link}</Typography.Paragraph><p>请复制保存本次链接。后续可在管理中重新生成链接，旧链接会立即失效。</p></Modal>
    <Modal title={detail?.title} open={!!detail} width={1000} onCancel={()=>setDetail(null)} footer={null}>
      {detail && <><Alert type="info" title={statusNames[detail.status]+(detail.closed?" · 已关闭":"")} description={detail.feedback || "请核对外部填写稿与原始资料。确认将整批更新，原款期间发生修改则提示冲突，不覆盖。"} />
        <Collapse items={detail.items.map((item:Row)=>({key:item.id,label:item.xutiStyleNo || item.draft.supplierStyleNo || "未填写款号",children:<><h4>外部填写稿</h4><Summary info={item.draft}/><Collapse items={[{key:"original",label:"查看分享时原始资料",children:<Summary info={item.original}/>}]} /></>}))}/>
        {detail.status==="SUBMITTED" && <><Input.TextArea placeholder="退回原因（退回时必填）" value={reason} maxLength={1000} onChange={event=>setReason(event.target.value)}/><Space><Popconfirm title="确认整批资料并更新选款登记？" onConfirm={()=>run(()=>review("approve"))}><Button loading={busy} type="primary">确认并更新</Button></Popconfirm><Button disabled={busy || !reason.trim()} onClick={()=>void run(()=>review("reject"))}>退回补充</Button></Space></>}
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
  const {message,modal}=App.useApp();
  const [data,setData]=useState<Row|null>(null),[error,setError]=useState(""),[selected,setSelected]=useState(""),[query,setQuery]=useState(""),[busy,setBusy]=useState(false);
  const [info,setInfo]=useState<CollectionInfo|null>(null),[color,setColor]=useState(""),[qr,setQr]=useState(false);
  const camera=useRef<HTMLInputElement>(null),album=useRef<HTMLInputElement>(null);
  const pending=useRef<{fingerprint:string;key:string}|null>(null);
  const current=data?.items.find((item:Row)=>String(item.id)===selected);
  const dirty=!!current && !!info && JSON.stringify(info)!==JSON.stringify(infoOf(current));
  const editable=!!data && ["DRAFT","REJECTED"].includes(data.status);
  const load=async(initial=false)=>{
    try {const next=await external(token);setData(next);setError("");if(initial && next.items.length){setSelected(String(next.items[0].id));setInfo(infoOf(next.items[0]));setColor(collectionTags(next.items[0].color)[0] || "");}return next;}
    catch(error){setError((error as Error).message);throw error;}
  };
  useEffect(()=>{void load(true).catch(()=>{});},[token]);
  useEffect(()=>{const before=(event:BeforeUnloadEvent)=>{if(dirty || busy)event.preventDefault();};window.addEventListener("beforeunload",before);return()=>window.removeEventListener("beforeunload",before);},[dirty,busy]);
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);try{await action();}catch(error){setError((error as Error).message);}finally{setBusy(false);}};
  const mutate=async(path:string,body:unknown)=>{
    const fingerprint=JSON.stringify({path,body});if(pending.current?.fingerprint!==fingerprint)pending.current={fingerprint,key:crypto.randomUUID()};
    const result=await external(token,path,"POST",body,pending.current!.key);pending.current=null;return result;
  };
  const save=async()=>{
    if(!info || !data)return;
    const parsed=collectionInfoSchema.safeParse(info);
    if(!parsed.success)throw Error(parsed.error.issues.map(issue=>issue.message).join("；"));
    await mutate("/"+selected,{revision:data.revision,info:parsed.data});
    const next=await load();setInfo(infoOf(next.items.find((item:Row)=>String(item.id)===selected)));message.success("本款已保存，提交后等待内部确认");
  };
  const choose=(item:Row)=>{
    const apply=()=>{setSelected(String(item.id));setInfo(infoOf(item));setColor(collectionTags(item.color)[0] || "");};
    if(dirty)modal.confirm({title:"本款有未保存内容",content:"切换将放弃本次未保存修改，建议先保存本款。",okText:"放弃并切换",cancelText:"继续填写",onOk:apply});else apply();
  };
  const patch=(key:keyof CollectionInfo,value:any)=>setInfo(previous=>{
    if(!previous)return previous;const next={...previous,[key]:value};
    if(key==="color" || key==="sizeRange")next.inventory=collectionInventory(next.color,next.sizeRange,previous.inventory);
    return next;
  });
  const upload=(files:File[])=>void run(async()=>{
    if(!current || !data || !color || dirty)throw Error("请先保存本款资料并选择颜色，再拍图");
    const target=selected;let revision=data.revision;
    try{for(const file of files){const prepared=await prepareUpload(file);const result=await mutate("/"+target+"/photos",{action:"add",revision,color,data:await readUpload(prepared)});revision=result.revision;}}
    finally{await load();}
  });
  if(!data)return <div className="collection-public">{error?<Alert type="error" title={error}/>:<Spin/>}</div>;
  const results=data.items.filter((item:Row)=>(item.xutiStyleNo+" "+item.supplierStyleNo).toLowerCase().includes(query.toLowerCase()));
  return <div className="collection-public">
    <header><h1>{data.title}</h1><Space wrap><Tag>{statusNames[data.status]}</Tag><span>有效期：{data.expiresAt?new Date(data.expiresAt).toLocaleString():"长期"}</span></Space><Input.Search aria-label="搜索款号" placeholder="搜索序缇款号 / 供应商款号" value={query} onChange={event=>setQuery(event.target.value)}/></header>
    {error && <Alert closable onClose={()=>setError("")} type="error" title={error} description="未保存内容仍保留在当前页面；如提示其他设备更新，请先保留输入，再重新打开链接核对。" />}
    {data.feedback && <Alert type="warning" title="内部退回意见" description={data.feedback}/>}
    <div className="collection-layout"><aside>{results.map((item:Row,index:number)=><Button block type={String(item.id)===selected?"primary":"default"} disabled={busy} key={item.id} onClick={()=>choose(item)}>{index+1}. {item.xutiStyleNo || item.supplierStyleNo || "未填写款号"}</Button>)}{!results.length && <Empty description="没有匹配的款式"/>}</aside>
    {current && info && <Card title={current.xutiStyleNo || "产品资料"} extra={<Button icon={<CameraOutlined/>} onClick={()=>setQr(true)}>手机拍图</Button>}>
      <Form layout="vertical" disabled={!editable || busy}><div className="collection-fields">
        <Form.Item label="序缇款号"><Input value={current.xutiStyleNo} readOnly disabled/></Form.Item>
        <Form.Item label="供应商款号"><Input maxLength={64} value={info.supplierStyleNo} onChange={event=>patch("supplierStyleNo",event.target.value)}/></Form.Item>
        <Form.Item label="颜色"><Select mode="tags" tokenSeparators={["/",";","；"]} value={collectionTags(info.color)} onChange={values=>patch("color",values.join("/"))}/></Form.Item>
        <Form.Item label="尺码范围"><Select mode="tags" tokenSeparators={["/",";","；"]} value={collectionTags(info.sizeRange)} options={selectionSizes.map(value=>({value,label:value}))} onChange={values=>patch("sizeRange",sortSelectionSizes(values.join("/")))}/></Form.Item>
        <Form.Item label="材质成分"><Input.TextArea maxLength={2000} value={info.material} onChange={event=>patch("material",event.target.value)}/></Form.Item>
        <Form.Item label="供货价（不含税）"><InputNumber stringMode min="0" precision={2} value={info.supplyPriceExclTax} onChange={value=>patch("supplyPriceExclTax",value)}/></Form.Item>
        <Form.Item label="产品卖点/简介"><Input.TextArea showCount maxLength={1000} value={info.sellingPoints} onChange={event=>patch("sellingPoints",event.target.value)}/></Form.Item>
        <Form.Item label="翻单周期（天）"><InputNumber min={0} max={36500} precision={0} value={info.reorderDays} onChange={value=>patch("reorderDays",value)}/></Form.Item>
      </div></Form>
      <Form.Item label="库存数"><CollectionStockEditor inventory={info.inventory} readOnly={!editable || busy} onChange={inventory=>patch("inventory",inventory)}/></Form.Item>
      {editable && <Button type="primary" loading={busy} disabled={!dirty} onClick={()=>void run(save)}>保存本款资料</Button>}
      <section id="collection-photos"><h3>产品图片</h3><Space wrap>{collectionTags(current.color).map(value=><Button key={value} type={color===value?"primary":"default"} disabled={busy} onClick={()=>setColor(value)}>{value}</Button>)}</Space>
        <div className="collection-images">{current.images.filter((image:Row)=>!color || image.color===color || !image.color).map((image:Row)=><div key={image.id}><CollectionImage token={token} itemId={selected} image={image}/><small>{image.color || "未标颜色"}</small>{editable && <Popconfirm title="移除此张图片？" onConfirm={()=>run(async()=>{await mutate("/"+selected+"/photos",{action:"remove",revision:data.revision,imageId:image.id});await load();})}><Button disabled={busy || dirty} size="small" danger>移除</Button></Popconfirm>}</div>)}</div>
        {editable && <><Space wrap><Button icon={<CameraOutlined/>} disabled={busy || dirty || !color} onClick={()=>camera.current?.click()}>拍照上传</Button><Button disabled={busy || dirty || !color} onClick={()=>album.current?.click()}>相册 / 本地上传</Button></Space><p>先保存颜色后按颜色补拍；每张自动压缩至 500KB 以下。修改资料未保存时请先保存，再拍图。</p></>}
      </section>
      <Space wrap><Button disabled={busy} onClick={()=>{const index=results.findIndex((item:Row)=>String(item.id)===selected);if(index>=0 && index<results.length-1)choose(results[index+1]);else message.info("已是当前范围最后一款");}}>下一款</Button>{editable && <Popconfirm title="提交整张收集表供内部确认？" onConfirm={()=>run(async()=>{await mutate("/submit",{revision:data.revision});await load();message.success("已提交，等待内部确认");})}><Button type="primary" disabled={busy || dirty}>提交收集表</Button></Popconfirm>}</Space>
    </Card>}</div>
    <input hidden ref={camera} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={event=>{const files=Array.from(event.target.files || []);event.currentTarget.value="";upload(files);}}/>
    <input hidden ref={album} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={event=>{const files=Array.from(event.target.files || []);event.currentTarget.value="";upload(files);}}/>
    <Modal open={qr} title="手机免登录拍图" footer={null} onCancel={()=>setQr(false)}><QRCode value={shareUrl(token,true)}/><p>手机扫码后选择款式与颜色即可拍图，同样无需登录。照片先保存在收集表，内部确认后更新选款登记。</p></Modal>
  </div>;
}

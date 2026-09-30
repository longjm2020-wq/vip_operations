import {SelectionCustomPhoto} from "./selection-custom-photo";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Alert, App, Button, Empty, Form, Image, Input, Modal, Popconfirm, Select, Space, Spin, Tag } from "antd";
import { CameraOutlined, DeleteOutlined, PlusOutlined, UploadOutlined } from "@ant-design/icons";
import { api, queryClient } from "./api";
import { useCan, type Row } from "./shared";
import { prepareUpload, readUpload } from "./upload-file";
import { invalidSelectionImage } from "./selection-image-links";
import "./selection-mobile-photos.css";
const colorsOf = (row?: Row) => [...new Set(String(row?.color || "").split("/").map(value => value.trim()).filter(Boolean))];
type PhotoField = "images" | "labelImages";
type PendingPhoto = { id: string; rowId: string; field: PhotoField; color: string; file: File; url?: string; error?: string };
function PhotoMetadata({ row, onClose, onSaved }: { row?: Row; onClose: () => void; onSaved: (row: Row) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<{ body: string; key: string } | null>(null);
  return <Modal className="mobile-photo-metadata" open title={row ? "补充款号与颜色" : "新增款式"} footer={null} onCancel={() => { if (!busy) onClose(); }} mask={{closable:!busy}} closable={!busy}>
    {error && <Alert type="error" title={error} style={{marginBottom:12}} />}
    <Form layout="vertical" initialValues={{ xutiStyleNo: row?.xutiStyleNo || "", supplierStyleNo: row?.supplierStyleNo || "", supplierCode: row?.supplierCode || "", colors: colorsOf(row) }} onFinish={async values => {
      if (busy) return;
      const colors = [...new Set((values.colors as string[]).flatMap(value => value.split("/")).map(value=>value.trim()).filter(Boolean))];
      if (!colors.length || colors.join("/").length > 100) { setError("请填写颜色，全部颜色合计不超过100个字符"); return; }
      const body = { xutiStyleNo: values.xutiStyleNo?.trim() || null, supplierStyleNo: values.supplierStyleNo?.trim() || null, supplierCode: values.supplierCode?.trim() || null, color: colors.join("/"), ...(row ? { expectedUpdatedAt: row.updatedAt } : {}) };
      const encoded = JSON.stringify(body);
      if (!attempt.current || attempt.current.body !== encoded) attempt.current = { body: encoded, key: crypto.randomUUID() };
      setBusy(true); setError("");
      try { const result = await api(`/style-selections${row ? "/"+row.id : ""}`, row ? "PATCH" : "POST", body, attempt.current.key); onSaved(result.data); }
      catch (error) { setError((error as Error).message); } finally { setBusy(false); }
    }}>
      <Form.Item name="xutiStyleNo" label="序缇款号" rules={[{max:64}]}><Input maxLength={64} /></Form.Item>
      <Form.Item name="supplierStyleNo" label="供应商款号"><Input maxLength={64} /></Form.Item>
      <Form.Item name="supplierCode" label="供应商编码"><Input maxLength={50} /></Form.Item>
      <Form.Item name="colors" label="颜色" rules={[{required:true,message:"请至少添加一种颜色"}]}><Select mode="tags" tokenSeparators={["/",";","；",","]} placeholder="输入颜色后回车，多个颜色用 / 分隔" /></Form.Item>
      <p className="mobile-photo-hint">已有图片的颜色需保留；新增颜色后即可分别补拍。保存会同步到电脑端。</p>
      <Button block type="primary" htmlType="submit" loading={busy} size="large">保存并拍图</Button>
    </Form>
  </Modal>;
}
export function SelectionMobilePhotos(){return new URLSearchParams(location.search).get("field")?.startsWith("custom:")?<SelectionCustomPhoto/>:<StandardSelectionMobilePhotos/>;}
function StandardSelectionMobilePhotos() {
  const canRead = useCan("selection.read"), canEdit = useCan("selection.manage");
  const { message } = App.useApp();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("id") || "";
  const section = params.get("section");
  const [search, setSearch] = useState(params.get("q") || "");
  const [query, setQuery] = useState(search);
  const [page, setPage] = useState(1);
  const [showResults, setShowResults] = useState(!selectedId);
  const [edit, setEdit] = useState<"empty" | "current" | null>(null);
  const [emptyRow, setEmptyRow] = useState<Row | null>(null);
  const [color, setColor] = useState("");
  const [busy, setBusy] = useState(false);
  const uploadLock = useRef(false);
  const [progress, setProgress] = useState("");
  const [failed, setFailed] = useState<PendingPhoto[]>([]);
  const captureTarget = useRef<{ rowId: string; field: PhotoField; color: string } | null>(null);
  const camera = useRef<HTMLInputElement>(null), album = useRef<HTMLInputElement>(null);
  useEffect(() => { const timer = window.setTimeout(() => { setQuery(search.trim()); setPage(1); }, 250); return () => clearTimeout(timer); }, [search]);
  const list = useQuery({ queryKey:["mobile-photo-list",query,page], enabled:canRead, queryFn:()=>api("/style-selections?"+new URLSearchParams({q:query,photoSearch:"true",sort:"sortOrder",direction:"asc",page:String(page),pageSize:"20"})), refetchOnWindowFocus:!busy });
  const detail = useQuery({ queryKey:["mobile-photo-detail",selectedId], enabled:canRead && !!selectedId, queryFn:()=>api("/style-selections/"+selectedId), refetchInterval:busy || edit ? false : 10000, refetchOnWindowFocus:!busy && !edit });
  const current: Row | undefined = detail.data?.data;
  const colors = colorsOf(current);
  useEffect(() => { setColor(value => colors.includes(value) ? value : colors[0] || ""); }, [selectedId, current?.color]);
  useEffect(() => { if (!current || section !== "labels") return; const timer = window.setTimeout(() => document.getElementById("mobile-label-photos")?.scrollIntoView({block:"start"}), 100); return () => window.clearTimeout(timer); }, [current?.id, section]);
  const choose = (id: string) => { setParams({id,...(query?{q:query}:{})}); setShowResults(false); setEdit(null); };
  const refresh = async () => { await Promise.all([queryClient.invalidateQueries({queryKey:["mobile-photo-detail"]}),queryClient.invalidateQueries({queryKey:["mobile-photo-list"]}),queryClient.invalidateQueries({queryKey:["style-selections"]})]); };
  const addStyle = async () => {
    if (!canEdit || busy) return;
    setBusy(true);
    try {
      const response = await api("/style-selections/photo-next-blank", "POST", {});
      const row: Row = response.data;
      queryClient.setQueryData(["mobile-photo-detail", String(row.id)], { data: row });
      choose(String(row.id));
      setEmptyRow(row);
      setEdit("empty");
      void refresh();
    } catch (error) { message.error((error as Error).message); }
    finally { setBusy(false); }
  };
  const runUploads = async (tasks: PendingPhoto[]) => {
    if (!canEdit || uploadLock.current || !tasks.length) return;
    uploadLock.current = true; setBusy(true);
    const retryIds = new Set(tasks.map(task=>task.id));
    setFailed(previous=>previous.filter(task=>!retryIds.has(task.id)));
    const errors: PendingPhoto[] = [];
    try {
      for (let i=0;i<tasks.length;i++) {
        const task = tasks[i]; setProgress(`正在上传 ${i+1}/${tasks.length} · ${task.field==="labelImages"?"洗唛/吊牌图":task.color}`);
        try {
          if (!task.url) { task.file = await prepareUpload(task.file); const uploaded = await api("/style-selections/images","POST",{data:await readUpload(task.file)},task.id+"-upload"); task.url=uploaded.data.url; }
          await api(`/style-selections/${task.rowId}/photos`,"POST",{action:"add",field:task.field,image:{id:task.id,url:task.url,color:task.color}},task.id+"-attach");
        } catch (error) { errors.push({...task,error:(error as Error).message}); }
      }
      if (errors.length) setFailed(previous=>[...previous,...errors]);
      if (tasks.length>errors.length) message.success(`已上传 ${tasks.length-errors.length} 张图片`);
      await refresh();
    } finally { uploadLock.current=false;setBusy(false);setProgress(""); }
  };
  const capture = (files: File[]) => {
    const target = captureTarget.current;
    if (!target) { message.info("请先选择款式和拍图区域"); return; }
    void runUploads(files.map(file=>({id:crypto.randomUUID(),rowId:target.rowId,field:target.field,color:target.color,file})));
  };
  const removePhoto = async (id: string, field: PhotoField) => {
    if (!canEdit || busy || !current) return;
    setBusy(true);
    try { await api(`/style-selections/${current.id}/photos`,"POST",{action:"remove",field,imageId:id}); await refresh(); }
    catch (error) { message.error((error as Error).message); } finally { setBusy(false); }
  };
  const next = async () => {
    if (!current || busy) return;
    setBusy(true);
    try { const response = await api(`/style-selections/${current.id}/photo-next?q=${encodeURIComponent(query)}`); if (response.data) choose(String(response.data.id)); else message.info("已到当前搜索范围的最后一款，可搜索其他款或新增款式"); }
    catch(error) { message.error((error as Error).message); } finally { setBusy(false); }
  };
  if (!canRead) return <div className="mobile-photos"><Alert type="warning" title="当前账号没有选款登记查看权限" /><Link to="/">返回工作台</Link></div>;
  const photos: Row[] = (current?.images || []).filter((image:Row)=>image.color === color);
  const unassigned: Row[] = (current?.images || []).filter((image:Row)=>!image.color || !colors.includes(image.color));
  const labelPhotos: Row[] = current?.labelImages || [];
  const gallery = (items: Row[], field: PhotoField) => <Image.PreviewGroup><div className="mobile-photo-grid">{items.map(image=><div className="mobile-photo-item" key={image.id}><Image src={image.url} fallback={invalidSelectionImage} alt={field==="labelImages"?"洗唛/吊牌图":`${current?.xutiStyleNo || "款式"} ${image.color || "未标颜色"}`} />{field==="images" && <span>{image.color || "未标颜色"}</span>}{canEdit && <Popconfirm title="移除这张图片？" description={`会同步从电脑端该款${field==="labelImages"?"洗唛/吊牌图":"图片"}中移除。`} okText="移除" cancelText="取消" onConfirm={()=>removePhoto(image.id,field)}><Button danger size="small" disabled={busy} icon={<DeleteOutlined />} aria-label={field==="labelImages"?"删除洗唛/吊牌图":"删除图片"} /></Popconfirm>}</div>)}</div></Image.PreviewGroup>;
  return <div className="mobile-photos">
    <header className="mobile-photo-header"><div><strong>XUTI · 手机拍图</strong></div><Input.Search size="large" allowClear aria-label="搜索款号或供应商编码" placeholder="序缇款号 / 供应商款号 / 供应商编码" value={search} onChange={event=>{setSearch(event.target.value);setShowResults(true);}} onSearch={()=>{setQuery(search.trim());setShowResults(true);setPage(1);}} /><div className="mobile-photo-header-actions"><Button onClick={()=>setShowResults(value=>!value)}>{showResults?"收起搜索结果":"选择款式"}</Button>{canEdit && <Button icon={<PlusOutlined />} disabled={busy} onClick={()=>void addStyle()}>新增款式</Button>}</div></header>
    {showResults && <section className="mobile-photo-results">{list.isLoading?<Spin/>:list.error?<Alert type="error" title={(list.error as Error).message} action={<Button onClick={()=>void list.refetch()}>重试</Button>}/>:<><p>共 {list.data?.total || 0} 款</p>{(list.data?.data || []).map((row:Row)=><button key={row.id} className="mobile-photo-result" onClick={()=>choose(String(row.id))}><strong>{row.xutiStyleNo || "未填写序缇款号"}</strong><span>供应商款号：{row.supplierStyleNo || "—"} · 编码：{row.supplierCode || "—"}</span><small>{row.color || "未填写颜色"} · {row.images?.length || 0} 张款式图 · {row.labelImages?.length || 0} 张洗唛/吊牌图</small></button>)}{!list.data?.total && <Empty description="未找到款式，可新增款式后拍图"/>}<Space><Button disabled={page===1} onClick={()=>setPage(page-1)}>上一页</Button><span>第 {page} 页</span><Button disabled={page*20 >= (list.data?.total || 0)} onClick={()=>setPage(page+1)}>下一页</Button></Space></>}</section>}
    {detail.isLoading && selectedId && <Spin/>}{detail.error && <Alert type="error" title={(detail.error as Error).message} action={<Button onClick={()=>void detail.refetch()}>重试</Button>}/>}
    {current && <main><section className="mobile-photo-style"><div><h1>{current.xutiStyleNo || current.supplierStyleNo || "未填写序缇款号"}</h1>{canEdit && <Button disabled={busy} onClick={()=>setEdit("current")}>编辑款号 / 颜色</Button>}</div><p>供应商款号：{current.supplierStyleNo || "—"}　供应商编码：{current.supplierCode || "—"}</p><div className="mobile-photo-colors">{colors.map(value=><Button key={value} type={value===color?"primary":"default"} onClick={()=>setColor(value)}>{value} · {(current.images || []).filter((image:Row)=>image.color===value).length} 张</Button>)}</div>{(!colors.length) && <Alert type="info" title="先补充颜色，再按颜色拍图" action={canEdit?<Button onClick={()=>setEdit("current")}>补充资料</Button>:undefined}/>}</section>
      <section className="mobile-photo-current"><h2>当前拍图 {color && <Tag>{color}</Tag>} <small>{photos.length} 张</small></h2>{photos.length?gallery(photos,"images"):<Empty description={color?`还没有${color}的图片，请拍照补充`:"请选择或补充颜色"}/>}<div className="mobile-photo-capture"><Button type="primary" size="large" icon={<CameraOutlined/>} disabled={!canEdit || busy || !color} onClick={()=>{captureTarget.current={rowId:String(current.id),field:"images",color};camera.current?.click();}}>拍照上传</Button><Button size="large" icon={<UploadOutlined/>} disabled={!canEdit || busy || !color} onClick={()=>{captureTarget.current={rowId:String(current.id),field:"images",color};album.current?.click();}}>相册选择</Button></div><p className="mobile-photo-hint">每张自动压缩至 500 KB 以下，上传后电脑端自动同步。</p></section>
      <section id="mobile-label-photos"><h2>洗唛/吊牌图 <small>{labelPhotos.length} 张</small></h2>{labelPhotos.length?gallery(labelPhotos,"labelImages"):<Empty description="还没有洗唛/吊牌图，请拍照补充"/>}<div className="mobile-photo-capture"><Button type="primary" size="large" icon={<CameraOutlined/>} disabled={!canEdit || busy} onClick={()=>{captureTarget.current={rowId:String(current.id),field:"labelImages",color:""};camera.current?.click();}}>拍照上传</Button><Button size="large" icon={<UploadOutlined/>} disabled={!canEdit || busy} onClick={()=>{captureTarget.current={rowId:String(current.id),field:"labelImages",color:""};album.current?.click();}}>相册选择</Button></div><p className="mobile-photo-hint">洗唛/吊牌图不需要选择颜色，可连续拍摄或从相册多选；上传后与电脑端同字段同步。</p></section>
      {!!unassigned.length && <section><h2>未标颜色图片</h2>{gallery(unassigned,"images")}</section>}
      <footer className="mobile-photo-next"><Button block size="large" onClick={()=>void next()} disabled={busy}>完成本款 · 下一款</Button></footer>
    </main>}
    {busy && <Alert className="mobile-photo-progress" type="info" title={progress || "正在保存…"}/>}
    {!!failed.length && <section><Alert type="error" title={`${failed.length} 张图片未确认上传成功`} description="可重试，系统会避免重复添加。请保持页面打开。"/><ul>{failed.map(task=><li key={task.id}>{task.field==="labelImages"?"洗唛/吊牌图":task.color}：{task.error}</li>)}</ul><Button disabled={busy} onClick={()=>void runUploads(failed)}>重试失败图片</Button></section>}
    <input hidden ref={camera} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={event=>{const files=Array.from(event.target.files || []);event.currentTarget.value="";capture(files);}}/><input hidden ref={album} type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={event=>{const files=Array.from(event.target.files || []);event.currentTarget.value="";capture(files);}}/>
    {edit && <PhotoMetadata key={edit+":"+(edit === "empty" ? emptyRow?.id : current?.id || "")} row={edit==="empty"?emptyRow || undefined:current} onClose={()=>setEdit(null)} onSaved={row=>{queryClient.setQueryData(["mobile-photo-detail",String(row.id)],{data:row});setEdit(null);choose(String(row.id));void refresh();}}/>}
  </div>;
}

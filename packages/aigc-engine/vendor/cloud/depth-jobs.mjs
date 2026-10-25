import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import ffmpeg from "ffmpeg-static";
import { RunningHubDepthClient } from "./runninghub-depth.mjs";
import { selectVideoRoute } from "./video-providers.mjs";
import { probeReference, validateReferenceFiles } from "./media-references.mjs";
import { depthQuote } from "./depth-pricing.mjs";
import { reserve, markSubmitted, settle } from "./access.mjs";

const run = promisify(execFile), now = () => new Date().toISOString();
export const activeDepth = j => ["queued", "preparing", "submitting", "running", "downloading"].includes(j?.status);
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
export const DEPTH_ENGINE = "video-depth-anything-small-v1";
export function depthOutputUrl(value) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.port || u.username || u.password || ![
    "rh-images.xiaoyaoyou.com", "rh-images-switch-1252422369.cos.ap-guangzhou.myqcloud.com",
    // Returned by the verified paid task 2104423403833487362 on 2026-09-28.
    "rh-images-tos.xiaoyaoyou.com",
  ].includes(u.hostname)) throw new Error(`深度输出地址尚未核对，未下载（主机：${u.hostname.slice(0,180)}）`);
  return u.href;
}
export function depthInputLimit(info, cap) {
  const limit = Math.min(15, cap.maxSeconds, cap.maxTotalSeconds);
  if (!Number.isFinite(info.durationSeconds) || info.durationSeconds < Math.max(2, cap.minSeconds) || info.durationSeconds > limit) throw new Error(`原片深度参考首版支持完整 2～${limit} 秒视频，请先裁好片段；不会静默截短`);
  if (!(info.width > 0 && info.height > 0) || info.width * info.height > 3840 * 2160) throw new Error("原片尺寸过大，请先缩小到 4K 以内");
}

// Single independent execution slot. This is not part of CloudWorker's two
// compile/video slots. Provider IDs and submission intent survive restarts.
export class DepthJobs {
  constructor(store, config, { client, fetchImpl = fetch } = {}) {
    this.store = store; this.config = config; this.fetch = fetchImpl;
    this.client = client || new RunningHubDepthClient({ apiKey: config.runninghubApiKey, workflowId: config.runninghubWorkflowId });
    this.busy = false; this.stopped = false;
  }
  row(id) { return this.store.data.depthJobs?.[id]; }
  async init() {
    await this.store.mutate(data => {
      data.depthJobs ||= {};
      for (const j of Object.values(data.depthJobs)) {
        if (j.status === "preparing") j.status = "queued";
        if (j.status === "submitting") Object.assign(j, { status: "attention", message: "提交期间服务重启，需核实原请求；未自动重提" });
        if (j.status === "downloading") j.status = "running";
        if (j.status === "recovering") Object.assign(j, {status:"failed",message:"结果取回被重启中断，可再次取回原任务；不会重新生成"});
        if (["failed","cancelled","attention","ended_pending_review"].includes(j.status)) settle(data,j.operationId,false,"深度结果未交付，未交付结果，供应商请求另行核实");
      }
    });
  }
  project(ownerId, projectId) {
    const p = this.store.getAppState().projects.find(p => p.id === projectId && p.ownerId === ownerId && !p.deletedAt);
    if (!p) fail("项目不存在", 404);
    return p;
  }
  status(user, projectId) {
    const p = this.project(user.id, projectId);
    const j = Object.values(this.store.data.depthJobs || {}).filter(j => j.projectId === projectId && j.ownerId === user.id).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
    const asset = j?.outputAssetId && this.store.getAssetMetadata(j.outputAssetId);
    let quote=null;try {quote=depthQuote(this.store.data,user);} catch { /* Unpublished/disabled service is read-only. */ }
    return { configured: Boolean(this.config.runninghubApiKey), canStart: Boolean(quote), quote, maxSeconds: 15,
      job: j ? { id:j.id, status:j.status, message:j.message, ...(user.role==="super_admin"?{coins:j.coins,taskId:j.taskId}:{}), sourceId:j.sourceId, updatedAt:j.updatedAt, canRecover: j.status === "failed" && Boolean(j.taskId) } : null,
      file: asset && j.status === "completed" && j.sourceId === p.assets.video?.path ? { path:asset.id, name:asset.name, kind:asset.kind, size:asset.size, mime:asset.mime, mediaInfo:asset.mediaInfo } : null };
  }
  async start(user, projectId, input) {
    if (input?.action === "recover") return this.recover(user, projectId);
    depthQuote(this.store.data,user);
    if (!this.config.runninghubApiKey) fail("深度服务尚未配置", 503);
    if (input?.confirmRunningHubCharge !== true) fail("请先确认 RunningHub 费用和素材传输");
    const p = this.project(user.id, projectId), cap = selectVideoRoute(this.config,p.videoSelection).model.mediaReferences?.video;
    if (!cap) fail("当前模型不支持视频参考");
    if (["ended", "completed"].includes(p.status)) fail("请在未结束的项目中转换");
    const source = this.store.getAssetMetadata(p.assets.video?.path);
    if (!source || source.kind !== "video" || source.ownerId !== user.id || source.source !== "upload") fail("请先上传并保存拆解原片");
    if (source.size > 180*1024*1024) fail("原片不得超过 180MB");
    await this.store.mutate(data => {
      const latest = data.appState.projects.find(x => x.id === projectId && x.ownerId === user.id && !x.deletedAt);
      if (!latest || latest.assets.video?.path !== source.id || JSON.stringify(latest.videoSelection) !== JSON.stringify(p.videoSelection)) fail("项目已变化，请刷新后重试",409);
      if (Object.values(data.jobs).some(j => j.projectId === projectId && !["completed","failed","cancelled"].includes(j.status))) fail("请先结束当前项目任务",409);
      if (Object.values(data.depthJobs).some(j => j.ownerId === user.id && (activeDepth(j) || j.status === "attention"))) fail("已有深度任务或待核实请求，请先处理原请求",409);
      if (Object.values(data.depthJobs).some(j => j.projectId === projectId && j.sourceId === source.id && j.status === "completed" && data.assets[j.outputAssetId])) fail("此原片已有深度结果，请直接使用",409);
      if (Object.values(data.depthJobs).filter(activeDepth).length >= 10) fail("深度队列已满",429);
      const quote=depthQuote(data,user);
      if (quote.pricingVersion !== "internal" && (input.quotedCredits !== quote.credits || input.pricingVersion !== quote.pricingVersion)) fail("深度售价已变化，请刷新并确认新报价",409);
      const recent=Object.values(data.depthJobs).filter(j=>Date.parse(j.createdAt)>Date.now()-86400000);
      if(recent.filter(j=>j.ownerId===user.id).length>=10 || recent.length>=50) fail("深度试运营额度已用完：每人滚动24小时10次，全站50次",429);
      const id = randomUUID();
      const operationId=`${id}:depth`;
      reserve(data,{id:operationId,userId:user.id,jobId:id,quote,label:`${p.name || "项目"} · 原片深度转换`});
      data.depthJobs[id] = { id,operationId,quote,ownerId:user.id,projectId,sourceId:source.id,cap,status:"queued",message:"独立深度队列排队中",createdAt:now(),updatedAt:now() };
    });
    return this.status(user,projectId);
  }
  async recover(user, projectId) {
    this.project(user.id, projectId);
    const latest = this.status(user, projectId).job;
    if (!latest?.canRecover) fail("没有可取回的原任务结果",409);
    const j = this.row(latest.id);
    // Read the existing provider task only. Never upload, submit, or restart GPU.
    await this.store.mutate(data => {
      if (data.depthJobs[j.id].status !== "failed") fail("原任务正在处理",409);
      data.depthJobs[j.id].status = "recovering";
    });
    try {
      this.valid(j);
      const result = await this.client.poll(j.taskId);
      if (result.state !== "completed") throw new Error("原任务尚无可取回结果；不会重新付费生成");
      await this.download(j, result);
    } catch(e) { await this.update(j.id,{status:"failed",message:/深度|原任务|原片/.test(e.message)?e.message:"原任务结果暂不可取回；不会重新付费生成"}); }
    return this.status(user, projectId);
  }
  async update(id, patch) { return this.store.mutate(data => { const j = data.depthJobs[id]; if(j) {
    Object.assign(j,patch,{updatedAt:now()});
    if(patch.status==="completed") settle(data,j.operationId,true,"深度结果校验通过并已保存");
    if(["failed","cancelled","attention","ended_pending_review"].includes(patch.status)) settle(data,j.operationId,false,"深度结果未交付，未交付结果，供应商请求另行核实");
  } }); }
  valid(j) {
    const p = this.project(j.ownerId,j.projectId);
    if(this.store.data.platform && !this.store.data.platform.users.some(u=>u.id===j.ownerId&&!u.disabled)) throw new Error("深度任务账号已停用");
    if(p.assets.video?.path !== j.sourceId || ["ended","completed"].includes(p.status)) throw new Error("原片或项目状态已变化");
    if(this.row(j.id)?.cancelRequested || this.stopped) throw new Error("深度转换已停止");
    return p;
  }
  async tick() {
    if(this.busy || this.stopped || !this.config.runninghubApiKey) return;
    this.busy = true;
    try {
      const j = Object.values(this.store.data.depthJobs || {}).find(activeDepth);
      if(!j) return;
      if(j.cancelRequested) return await this.cancelRemote(j);
      if(j.status === "queued") await this.submit(j);
      else if(j.status === "running") await this.refresh(j);
    } catch { /* Failures are task-scoped, never kill the regular worker. */ }
    finally { this.busy = false; }
  }
  async submit(j) {
    let dir;
    try {
      await this.update(j.id,{status:"preparing",message:"检查原片、缩小尺寸并去除音轨"});
      this.valid(j);
      const source = await this.store.openAsset(j.sourceId);
      if(!source) throw new Error("原片已清理");
      const info = await probeReference(source.filePath,"referenceVideo","source.mp4"); depthInputLimit(info,j.cap);
      const {graph} = await this.client.preflight();
      dir = await mkdtemp(path.join(this.store.uploadsDir,"depth-"));
      const input = path.join(dir,"input.mp4");
      await run(ffmpeg,["-hide_banner","-loglevel","error","-nostdin","-protocol_whitelist","file,pipe","-threads","1","-i",source.filePath,"-map","0:v:0","-an","-map_metadata","-1","-vf","scale=768:768:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=24","-c:v","libx264","-threads","1","-pix_fmt","yuv420p","-crf","22",input],{timeout:90000,windowsHide:true,maxBuffer:262144});
      if((await stat(input)).size>30*1024*1024) throw new Error("深度输入超过 30MB，尚未提交推理");
      const prepared = await probeReference(input,"referenceVideo","input.mp4");
      this.valid(j);
      const fileName = await this.client.upload(input);
      this.valid(j);
      await this.store.mutate(data=>{
        markSubmitted(data,j.operationId);
        Object.assign(data.depthJobs[j.id],{status:"submitting",message:"提交 RunningHub（不会自动重提）",sourceInfo:prepared,submittedAt:now(),updatedAt:now()});
      });
      const taskId = await this.client.submit(fileName,graph);
      await this.update(j.id,{status:"running",taskId,message:"RunningHub 正在执行时序深度推理"});
    } catch(e) {
      const uncertain = this.row(j.id)?.status === "submitting" && !e.definitelyRejected;
      await this.update(j.id,{status:uncertain?"attention":this.row(j.id)?.cancelRequested?"cancelled":"failed",message:uncertain?"提交结果不明，需核实 RunningHub 原请求；其他项目不受影响":/原片|深度|RunningHub/.test(e.message)?e.message:"深度预处理失败，尚未启动推理"});
    } finally { if(dir) await rm(dir,{recursive:true,force:true}); }
  }
  async refresh(j) {
    try {
      try {this.valid(j);} catch {await this.update(j.id,{cancelRequested:true});return;}
      // Best-effort runtime guard, NOT a provider-enforced currency cap.
      if(!j.providerCompleted && Date.now()-Date.parse(j.submittedAt)>180000) {await this.update(j.id,{cancelRequested:true,message:"达到 180 秒时限，正在停止供应商任务"});return;}
      const result = await this.client.poll(j.taskId);
      if(result.state === "pending") return;
      if(result.state === "failed") return await this.update(j.id,{status:"failed",message:"RunningHub 推理失败，未重提；费用请核对供应商记录"});
      await this.download(j,result);
    } catch {await this.update(j.id,{message:"暂未取到结果，继续核对同一任务；不会重复提交"});}
  }
  async download(j,result) {
    let dir;
    try {
      await this.update(j.id,{status:"downloading",providerCompleted:true,message:"校验深度视频时长、比例与帧率",coins:result.coins});
      this.valid(j);
      const response = await this.fetch(depthOutputUrl(result.url),{redirect:"error",signal:AbortSignal.timeout(30000)});
      if(!response.ok) throw new Error("深度结果下载失败");
      dir = await mkdtemp(path.join(this.store.uploadsDir,"depth-"));const output=path.join(dir,"output.mp4");let size=0;
      await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_,cb){size+=chunk.length;cb(size>50*1024*1024?new Error("深度输出超过 50MB"):null,chunk);}}),createWriteStream(output),{signal:AbortSignal.timeout(30000)});
      const info = await probeReference(output,"referenceVideo","depth.mp4");
      if(info.hasAudio || Math.abs(info.durationSeconds-j.sourceInfo.durationSeconds)>.13 || Math.abs(info.width/info.height-j.sourceInfo.width/j.sourceInfo.height)>.025 || Math.abs(info.fps-24)>.01) throw new Error("深度结果音轨、时长、比例或帧率不符，未用于生成");
      const mediaInfo = {...info,referenceType:"depth",engine:DEPTH_ENGINE,sourceAssetId:j.sourceId};
      validateReferenceFiles({mediaReferences:{video:j.cap}},"video",[{name:"depth.mp4",size,mediaInfo}]);
      this.valid(j);
      const asset = await this.store.putAssetFromUpload({tempPath:output,name:"原片深度参考.mp4",kind:"referenceVideo",mime:"video/mp4",mediaInfo,ownerId:j.ownerId,projectId:j.projectId});
      await this.update(j.id,{status:"completed",message:"深度参考已生成；选择使用后才发送给视频模型",outputAssetId:asset.path});
    } catch(e) {await this.update(j.id,{status:"failed",message:/深度|原片/.test(e.message)?e.message:"深度结果校验失败，未用于生成；不会重新提交"});}
    finally {if(dir) await rm(dir,{recursive:true,force:true});}
  }
  async cancelRemote(j) {
    if(!j.taskId) return this.update(j.id,{status:j.status==="submitting"?"attention":"cancelled",message:"深度转换已停止；提交不明的请求仍需核实"});
    try {const ok=await this.client.cancel(j.taskId);await this.update(j.id,{status:ok?"cancelled":"attention",message:ok?"供应商已接受停止；最终费用以任务记录为准":"供应商未确认停止，请核实原任务"});}
    catch {await this.update(j.id,{status:"attention",message:"取消结果待核实，不再占用本地执行位；不会重提"});}
  }
  async cancel(user,projectId,input={}) {
    this.project(user.id,projectId);
    await this.store.mutate(data=>{for(const j of Object.values(data.depthJobs||{}))if(j.ownerId===user.id&&j.projectId===projectId){
      if(activeDepth(j)){j.cancelRequested=true;j.updatedAt=now();}
      if(j.status==="attention"&&input.acknowledgeUncertain===true){j.status="ended_pending_review";j.message="本地记录已结束；供应商请求与费用仍需核实，不代表退款";j.updatedAt=now();}
    }});
    return this.status(user,projectId);
  }
  stop(){this.stopped=true;}
}

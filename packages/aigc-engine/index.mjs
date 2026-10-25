import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import sharp from "sharp";
import { CloudStore } from "./vendor/cloud/store.mjs";
import { TemplateLibrary } from "./vendor/cloud/template-library.mjs";
import { CloudWorker, MAX_WORKER_CONCURRENCY } from "./vendor/cloud/worker.mjs";
import { initialKernel } from "./vendor/cloud/kernel.mjs";
import { videoProviders, selectVideoRoute } from "./vendor/cloud/video-providers.mjs";
import { quoteVideo } from "./vendor/cloud/video-pricing.mjs";
import { imageCatalog, keyframeImageRoute, assertImageSelection } from "./vendor/cloud/image-provider.mjs";
import { checkedKeyframe } from "./vendor/cloud/keyframes.mjs";
import { InternalAccess, fail, requireRole } from "./vendor/cloud/access.mjs";
import { catalogFor, selectionForSave, projectForClient, taskForClient, reviewForClient, customerText } from "./vendor/cloud/customer-view.mjs";
import { enhancementQuote, enhancementDownloadOwner } from "./vendor/cloud/generation-enhancement.mjs";
import { videoPoster } from "./vendor/cloud/video-poster.mjs";
import { AssetLibrary } from "./vendor/cloud/asset-library.mjs";
import { listDetailAssetGroups, saveDetailAssetGroup, useDetailAssetGroup, removeDetailAssetGroup } from "./vendor/cloud/detail-asset-library.mjs";
import { compilerCatalog, saveCompilerSettings, publicCompiler } from "./vendor/cloud/compile-providers.mjs";
import { enhancementCatalog, createEnhancement, refreshEnhancement } from "./vendor/cloud/video-enhance.mjs";
import { detailRules, saveDetailRules, listDetailAssets, listDetailProjects, getDetailProject, saveDetailProject, listDetailFrameworks, saveDetailFramework, saveDetailVersion, restoreDetailVersion, planDetailProject, compileDetailPrompts, analyzeDetailTemplate, queueDetailImages, processDetailJobs } from "./vendor/cloud/detail-workspace.mjs";
import { listDetailProjectSummaries, listDetailTaskRuns, changeDetailProjectState } from "./vendor/cloud/detail-projects.mjs";
import { submissionStatus } from "./vendor/cloud/submission-status.mjs";
import { probeReference, validateReferenceFiles, projectMediaReferences, referenceDownloadOwner } from "./vendor/cloud/media-references.mjs";
import { preflightRunningHubDepth } from "./vendor/cloud/runninghub-depth.mjs";
import { DepthJobs } from "./vendor/cloud/depth-jobs.mjs";
import { DigitalHumanService, handleDigitalHuman } from "./vendor/cloud/digital-human.mjs";
import { gpuConfigFromEnv } from "./vendor/cloud/compshare-gpu.mjs";


/** Internal adapter for the selected upstream creation workflows. No standalone auth or billing server. */
export async function createStudio({ config, persistence, users = [] }) {
  const store = new CloudStore({ dataDir: config.dataDir, kernel: initialKernel(), persistence });
  await store.init();
  const platform = new InternalAccess(store);
  await platform.init(users);
  const templates = new TemplateLibrary(store); await templates.init();
  const assetLibrary = new AssetLibrary(store);
  const worker = new CloudWorker({ store, config });
  const depthJobs = new DepthJobs(store, config); await depthJobs.init();
  const digitalHuman = new DigitalHumanService(store, config); await digitalHuman.init();
  const timers = [];
  let stopped = true;
  function start() {
    stopped = false; worker.start();
    timers.push(setInterval(() => { if (!stopped) void depthJobs.tick().catch(() => {}); }, 3000));
    timers.push(setInterval(() => { if (!stopped) void digitalHuman.tick().catch(() => {}); }, 3000));
    timers.push(setInterval(() => { if (!stopped) void processDetailJobs(store, config).catch(() => {}); }, 3000));
  }
  function stop() { stopped = true; for(const timer of timers) clearInterval(timer); timers.length=0; worker.stop(); depthJobs.stop(); }
function json(response, status, value, headers = {}) {
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", ...headers });
  response.end(JSON.stringify(value));
}

function error(response, status, message) { json(response, status, { error: message }); }

function sessionFor(request) { return request.aigcUser; }

async function readBody(request, maximum = config.maxUploadBytes) {
  const expected = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(expected) && expected > maximum) throw Object.assign(new Error("上传文件超过当前云端安全上限"), { statusCode: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error("上传文件超过当前云端安全上限"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) fail("请使用 JSON 请求", 415);
  const content = await readBody(request, 2 * 1024 * 1024);
  try { const body = JSON.parse(content.toString("utf8")); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(); return body; }
  catch { throw Object.assign(new Error("请求 JSON 格式不正确"), { statusCode: 400 }); }
}

/**
 * Stream a single multipart file directly onto the mounted volume. The old
 * Web FormData parser retained the entire multipart body, the File payload and
 * a second Buffer in RAM at once. A 60 MB image could therefore stall the
 * worker while the page was also trying to render previews.
 */
async function readKeyframeForm(request) {
  const contentType = request.headers["content-type"];
  if (!contentType?.startsWith("multipart/form-data")) throw Object.assign(new Error("请使用表单上传关键帧"), { statusCode: 415 });
  // Large project originals use the streaming route; keyframes are bounded.
  const content = await readBody(request, 20 * 1024 * 1024 + 64 * 1024);
  return new Request("http://localhost/keyframe-upload", { method: "POST", headers: { "content-type": contentType }, body: content }).formData();
}

async function receiveAssetUpload(request, user, source = "upload") {
  platform.throttle(`asset-upload:${user.id}`, 120, 3600000);
  if (source === "library-draft") await assetLibrary.pruneDrafts(user);
  const contentType = request.headers["content-type"];
  if (!contentType?.startsWith("multipart/form-data")) throw Object.assign(new Error("必须使用 multipart/form-data 上传素材"), { statusCode: 415 });
  const expected = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(expected) && expected > config.maxUploadBytes) throw Object.assign(new Error("上传文件超过当前云端安全上限"), { statusCode: 413 });

  const tempPath = store.createUploadTempPath();
  const fields = {};
  let fileInfo = null;
  let fileLimitExceeded = false;
  let parseFailure = null;
  let writePromise = null;

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (reason) => {
        if (settled) return;
        settled = true;
        reject(reason);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      let parser;
      try {
        parser = Busboy({
          headers: request.headers,
          defParamCharset: "utf8",
          limits: {
            files: 1,
            fields: 8,
            fieldSize: 32 * 1024,
            parts: 10,
            fileSize: config.maxUploadBytes,
          },
        });
      } catch {
        fail(Object.assign(new Error("上传请求格式不正确"), { statusCode: 400 }));
        return;
      }

      parser.on("field", (name, value) => {
        if (name === "kind" || name === "projectId") fields[name] = value;
      });
      parser.on("file", (name, file, info) => {
        if (name !== "file" || fileInfo) {
          parseFailure ??= Object.assign(new Error("每次只能上传一个素材文件"), { statusCode: 400 });
          file.resume();
          return;
        }
        fileInfo = { name: info.filename, type: info.mimeType || "application/octet-stream" };
        file.on("limit", () => { fileLimitExceeded = true; });
        writePromise = pipeline(file, createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));
        writePromise.catch(() => undefined); // Keep early disk errors handled until parser completion.
      });
      parser.on("filesLimit", () => { parseFailure ??= Object.assign(new Error("每次只能上传一个素材文件"), { statusCode: 400 }); });
      parser.on("fieldsLimit", () => { parseFailure ??= Object.assign(new Error("上传字段过多"), { statusCode: 400 }); });
      parser.on("partsLimit", () => { parseFailure ??= Object.assign(new Error("上传请求字段不完整"), { statusCode: 400 }); });
      parser.on("error", fail);
      parser.on("finish", async () => {
        try {
          await writePromise;
          if (parseFailure) throw parseFailure;
          if (fileLimitExceeded) throw Object.assign(new Error("上传文件超过当前云端安全上限"), { statusCode: 413 });
          if (!fileInfo) throw Object.assign(new Error("未收到素材文件"), { statusCode: 400 });
          succeed();
        } catch (error) {
          fail(error);
        }
      });
      request.on("aborted", () => fail(Object.assign(new Error("上传已取消"), { statusCode: 499 })));
      request.pipe(parser);
    });

    const kind = String(fields.kind || "");
    if (source === "library-draft" && (!["model", "product"].includes(kind) || fields.projectId)) fail("资产库只接受人物或商品图片");
    if (!["video", "referenceVideo", "referenceAudio", "model", "product", "scene", "template", "text"].includes(kind)) throw Object.assign(new Error("素材类型或文件不正确"), { statusCode: 400 });
    if (!assetAllowed(kind, fileInfo)) throw Object.assign(new Error("该素材类型不受支持，请上传视频、JPG/PNG/WebP 或 TXT/MD/JSON 文件"), { statusCode: 415 });
    if (kind === "template" && (await stat(tempPath)).size > 5 * 1024 * 1024) fail("C 模板文件须在 5MB 以内", 413);
    if (fields.projectId) owned(user, "projects", fields.projectId);
    let mediaInfo;
    if (["referenceVideo", "referenceAudio"].includes(kind)) {
      const project = owned(user, "projects", fields.projectId);
      const route = selectVideoRoute(config, project.videoSelection);
      const type = kind === "referenceVideo" ? "video" : "audio";
      const cap = route.model.mediaReferences?.[type];
      if (!cap) fail("当前模型不支持此类生成参考，请先选择支持的模型");
      const size = (await stat(tempPath)).size;
      if (size > cap.maxBytes) fail(`单个参考文件不能超过 ${cap.maxBytes / 1024 / 1024}MB`, 413);
      try {
        mediaInfo = await probeReference(tempPath, kind, fileInfo.name);
        validateReferenceFiles(route.model, type, [{ name: fileInfo.name, size, mediaInfo }]);
      } catch (error) { fail(error.message, 400); }
    }
    const total = Object.values(store.data.assets).filter(a => a.ownerId === user.id && ["upload", "library-draft"].includes(a.source)).reduce((sum, a) => sum + a.size, 0);
    if (total + (await stat(tempPath)).size > 1024 * 1024 * 1024) fail("当前账号临时素材已超过 1GB，请先完成已有项目释放素材", 413);
    return store.putAssetFromUpload({
      tempPath,
      name: fileInfo.name,
      kind,
      mime: mediaInfo?.mime || fileInfo.type,
      mediaInfo,
      projectId: typeof fields.projectId === "string" ? fields.projectId : undefined,
      ownerId: user.id,
      source,
    });
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function assetAllowed(kind, file) {
  const mime = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  if (kind === "referenceVideo") return /\.(mp4|mov)$/i.test(name);
  if (kind === "referenceAudio") return /\.(mp3|wav)$/i.test(name);
  if (kind === "video") return mime.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(name);
  if (["model", "product", "scene"].includes(kind)) return mime.startsWith("image/") || /\.(jpg|jpeg|png|webp)$/i.test(name);
  if (["template", "text"].includes(kind)) return /^(text\/|application\/(json|pdf))/.test(mime) || /\.(txt|md|json)$/i.test(name);
  return false;
}

async function existingFile(file) {
  try {
    const info = await stat(file);
    if (info.isDirectory()) return path.join(file, "index.html");
    return info.isFile() ? file : null;
  } catch { return null; }
}

const previewJobs = new Map();

async function imagePreviewPath(asset) {
  if (!asset.metadata.mime.startsWith("image/")) return null;
  const target = store.getPreviewPath(asset.metadata.id);
  if (!target) return null;
  if (await existingFile(target)) return target;
  let job = previewJobs.get(target);
  if (!job) {
    job = (async () => {
      const temporary = `${target}.${process.pid}.tmp`;
      try {
        await sharp(asset.filePath, { limitInputPixels: false, sequentialRead: true })
          .rotate()
          .resize({ width: 960, height: 960, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 72, effort: 3 })
          .toFile(temporary);
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      return target;
    })().finally(() => previewJobs.delete(target));
    previewJobs.set(target, job);
  }
  return job;
}

function stateForClient(user) {
  const state = store.getAppState(user.id);
  state.detailProjects = listDetailProjectSummaries(store, user, { includeTrash: true });
  state.digitalHumanProjects = digitalHuman.summaries(user);
  state.accounts = accountsForClient(user);
  state.recycledProjects = state.projects.filter(p => p.deletedAt).map(p => projectForClient(p, user, config));
  const recycledIds = new Set([...state.recycledProjects.map(p => p.id), ...state.detailProjects.filter(p => p.deletedAt).map(p => p.id), ...state.digitalHumanProjects.filter(p => p.deletedAt).map(p => p.id)]);
  state.projects = state.projects.filter(p => !p.deletedAt).map(p => projectForClient(p, user, config));
  state.tasks = state.tasks.filter(t => !recycledIds.has(t.projectId)).map(t => taskForQueueClient(t, user));
  state.works = state.works.filter(w => !recycledIds.has(w.projectId));
  if (user.role !== "super_admin") state.learningCases = [];
  state.templateDownloads = templates.localCopies(user);
  return state;
}

function taskForQueueClient(task, user) {
  const job = store.getJob(task.id);
  const status = submissionStatus(job, task);
  const currentItem = status.providerRequestInFlight
    ? `${task.currentItem ?? "等待供应商响应"}（供应商处理中，百分比为阶段节点）`
    : task.currentItem;
  return taskForClient({ ...task, ...status, currentItem }, user, config);
}

function accountsForClient(user) {
  const accounts = worker.providerAccounts();
  if (user.role === "super_admin") return accounts;
  const ready = catalogFor(user, config).some(p => p.configured);
  accounts.grok.status = ready ? "signed_in" : "signed_out";
  accounts.chatgpt.status = publicCompiler(config, store.data.compileSettings).apiKey ? "signed_in" : "signed_out";
  for (const [key, value] of Object.entries(accounts)) value.detail = `${key === "grok" ? "视频" : "编译"}服务${value.status === "signed_in" ? "可用" : "暂不可用，请联系管理员"}`;
  return accounts;
}
function owned(user, collection, id) {
  const item = store.data.appState[collection]?.find(i => i.id === id && i.ownerId === user.id);
  if (!item) fail("记录不存在或不属于当前账号", 404);
  if (collection === "projects" && item.deletedAt) fail("项目已移入回收站，请先恢复", 409);
  return item;
}
function accessibleAsset(user, id) {
  const asset = store.getAssetMetadata(id);
  if (!asset || asset.ownerId !== user.id) fail("文件不存在或不属于当前账号", 404);
}

async function handleAsset(request, response, assetId, wantText, user, templateId) {
  if (templateId) { if (templates.media(user, templateId, Number(new URL(request.url, "http://localhost").searchParams.get("clip") || 0)) !== assetId) fail("展示视频不存在", 404); }
  else accessibleAsset(user, assetId);
  const item = await store.openAsset(assetId);
  if (!item) return error(response, 404, "文件不存在或已被清理");
  if (wantText) {
    if (!/^(text\/|application\/json)/.test(item.metadata.mime)) return error(response, 415, "该文件不是可读取的文本文件");
    response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "Content-Length": item.size, "X-Content-Type-Options": "nosniff" });
    if (request.method === "HEAD") return response.end();
    createReadStream(item.filePath).on("error", (error) => response.destroy(error)).pipe(response);
    return;
  }
  const download = new URL(request.url, "http://localhost").searchParams.get("download") === "1";
  const preview = new URL(request.url, "http://localhost").searchParams.get("variant") === "preview";
  if (preview) {
    const video = item.metadata.mime.startsWith("video/") || item.metadata.kind === "video";
    if (!video && !item.metadata.mime.startsWith("image/")) return error(response, 415, "只有图片或视频素材可以生成缩略图");
    const previewPath = video
      ? await videoPoster(item.filePath, store.getPreviewPath(assetId)).catch(() => undefined)
      : await imagePreviewPath(item);
    const previewInfo = previewPath && await stat(previewPath);
    if (!previewPath || !previewInfo?.isFile()) return error(response, 404, "缩略图暂不可用");
    response.writeHead(200, { "Cache-Control": "private, no-store", "Content-Type": "image/webp", "Content-Length": previewInfo.size, "X-Content-Type-Options": "nosniff" });
    if (request.method === "HEAD") return response.end();
    createReadStream(previewPath).on("error", (error) => response.destroy(error)).pipe(response);
    return;
  }
  const length = item.size;
  const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  const filename = encodeURIComponent(item.metadata.name).replace(/['()]/g, escape);
  const common = { "Cache-Control": "private, no-store", "Content-Type": item.metadata.mime || "application/octet-stream", "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${filename}`, "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" };
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : length - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= length) { response.writeHead(416, { "Content-Range": `bytes */${length}` }); response.end(); return; }
    const safeEnd = Math.min(end, length - 1);
    response.writeHead(206, { ...common, "Content-Length": safeEnd - start + 1, "Content-Range": `bytes ${start}-${safeEnd}/${length}` });
    if (request.method === "HEAD") return response.end();
    createReadStream(item.filePath, { start, end: safeEnd }).on("error", (error) => response.destroy(error)).pipe(response);
    return;
  }
  response.writeHead(200, { ...common, "Content-Length": length });
  if (request.method === "HEAD") return response.end();
  createReadStream(item.filePath).on("error", (error) => response.destroy(error)).pipe(response);
}

async function handleApi(request, response, url) {
  const { pathname } = url;
  const taskAccess = pathname.match(/^\/api\/tasks\/([^/]+)\//);
  if (taskAccess && !['compile','generate'].includes(taskAccess[1])) owned(request.aigcUser, 'tasks', decodeURIComponent(taskAccess[1]));
  const enhancementSource = pathname.match(/^\/api\/enhancement-source\/([a-zA-Z0-9_-]+)$/);
  if (enhancementSource && ["GET", "HEAD"].includes(request.method)) {
    const ownerId = enhancementDownloadOwner(store, config, enhancementSource[1], url.searchParams);
    if (!ownerId) return error(response, 404, "超分源文件链接已失效");
    return handleAsset(request, response, enhancementSource[1], false, { id: ownerId });
  }
  const mediaDownload = pathname.match(/^\/api\/generation-reference\/([a-zA-Z0-9_-]+)$/);
  if (mediaDownload && ["GET", "HEAD"].includes(request.method)) {
    const ownerId = referenceDownloadOwner(store, config, mediaDownload[1], url.searchParams);
    if (!ownerId) return error(response, 404, "参考文件链接已失效");
    return handleAsset(request, response, mediaDownload[1], false, { id: ownerId });
  }
  const user = sessionFor(request);
  if (!user) return error(response, 401, "请先登录云端工作台");
  if (await handleDigitalHuman({ request, response, url, user, service: digitalHuman, readJson, readBody, json, platform })) return;

  const depthMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/depth$/);
  if (depthMatch) {
    if (request.method === "GET") return json(response, 200, depthJobs.status(user, depthMatch[1]));
    if (request.method === "POST") return json(response, 202, await depthJobs.start(user, depthMatch[1], await readJson(request)));
    if (request.method === "DELETE") return json(response, 200, await depthJobs.cancel(user, depthMatch[1], await readJson(request)));
  }
  if (pathname === "/api/detail-frameworks") {
    if (request.method === "GET") return json(response, 200, listDetailFrameworks(store, user));
    if (request.method === "POST") return json(response, 201, await saveDetailFramework(store, user, await readJson(request)));
  }
  if (pathname === "/api/detail-rules") {
    if (request.method === "GET") return json(response, 200, detailRules(store.data));
    if (request.method === "PATCH") return json(response, 200, await saveDetailRules(store, user, await readJson(request)));
  }
  if (pathname === "/api/detail-assets" && request.method === "GET") return json(response, 200, listDetailAssets(store, user));
  if (pathname === "/api/detail-asset-library" && request.method === "GET") return json(response, 200, listDetailAssetGroups(store, user));
  if (pathname === "/api/detail-asset-library" && request.method === "POST") {
    const input = await readJson(request);
    return json(response, 201, await saveDetailAssetGroup(store, user, input.projectId, input.kind));
  }
  const detailLibraryMatch = pathname.match(/^\/api\/detail-asset-library\/([^/]+)(?:\/(use))?$/);
  if (detailLibraryMatch) {
    const id = decodeURIComponent(detailLibraryMatch[1]), input = await readJson(request);
    if (detailLibraryMatch[2] === "use" && request.method === "POST") return json(response, 200, await useDetailAssetGroup(store, user, id, input.projectId));
    if (!detailLibraryMatch[2] && request.method === "DELETE") return json(response, 200, await removeDetailAssetGroup(store, user, id, input.revision));
  }
  if (pathname === "/api/detail-projects") {
    if (request.method === "GET") return json(response, 200, listDetailProjects(store, user));
    if (request.method === "POST") return json(response, 201, await saveDetailProject(store, user, await readJson(request)));
  }
  if (pathname === "/api/detail-tasks" && request.method === "GET") return json(response, 200, listDetailTaskRuns(store, user).map(run => ({ ...run, jobs: run.jobs.map(job => ({ ...job, error: user.role === "super_admin" ? job.error : customerText(job.error, config) })) })));
  const detailStateAction = pathname.match(/^\/api\/detail-projects\/([^/]+)\/(trash|untrash)$/);
  if (detailStateAction && request.method === "POST") return json(response, 200, await changeDetailProjectState(store, user, decodeURIComponent(detailStateAction[1]), detailStateAction[2]));
  const detailAction = pathname.match(/^\/api\/detail-projects\/([^/]+)\/(plan|compile|analyze-template|versions|restore|generate)$/);
  if (detailAction) {
    const id = decodeURIComponent(detailAction[1]), action = detailAction[2];
    if (request.method !== "POST") return error(response, 405, "不支持的请求方法");
    const input = await readJson(request);
    if (action === "compile") return json(response, 200, compileDetailPrompts(getDetailProject(store, user, id), detailRules(store.data)));
    if (action === "plan") { getDetailProject(store, user, id); const plan = planDetailProject(store.data.detailProjects[id], detailRules(store.data), listDetailFrameworks(store, user)); await store.mutate(data => { const project = data.detailProjects[id]; project.modules = plan.modules; project.triggerLog = plan.triggers; project.updatedAt = new Date().toISOString(); project.version++; }); return json(response, 200, getDetailProject(store, user, id)); }
    if (action === "analyze-template") return json(response, 200, await analyzeDetailTemplate(store, user, id, input.assetId));
    if (action === "versions") return json(response, 200, await saveDetailVersion(store, user, id, input.reason));
    if (action === "restore") return json(response, 200, await restoreDetailVersion(store, user, id, input.version));
    if (action === "generate") return json(response, 202, await queueDetailImages(store, config, user, id, input.moduleId));
  }
  const detailMatch = pathname.match(/^\/api\/detail-projects\/([^/]+)$/);
  if (detailMatch) {
    const id = decodeURIComponent(detailMatch[1]);
    if (request.method === "GET") return json(response, 200, getDetailProject(store, user, id));
    if (request.method === "PATCH") return json(response, 200, await saveDetailProject(store, user, await readJson(request), id));
    if (request.method === "DELETE") return json(response, 200, await store.deleteDetailProject(id, user.id));
  }
  if (pathname === "/api/admin/compiler") {
    requireRole(user, ["super_admin"]);
    if (request.method === "GET") return json(response, 200, compilerCatalog(config, store.data.compileSettings));
    if (request.method === "PUT") return json(response, 200, await saveCompilerSettings(store, config, user, await readJson(request)));
  }
  if (pathname === "/api/admin/depth/preflight" && request.method === "GET") {
    requireRole(user, ["super_admin"]);
    try {
      const { graph, ...result } = await preflightRunningHubDepth({ apiKey: process.env.RUNNINGHUB_API_KEY, workflowId: process.env.RUNNINGHUB_DEPTH_WORKFLOW_ID });
      return json(response, 200, { ...result, ok: true, billableTaskCreated: false });
    } catch (issue) { return error(response, 503, issue.message); }
  }
  if (pathname === "/api/admin/video-enhancements") {
    requireRole(user, ["super_admin"]);
    if (request.method === "GET") return json(response, 200, { catalog: enhancementCatalog(config), tasks: Object.values(store.data.videoEnhancements || {}).filter(item => item.ownerId === user.id).slice(-30).reverse() });
    if (request.method === "POST") return json(response, 202, await createEnhancement(store, config, user, await readJson(request)));
  }
  const enhancementMatch = pathname.match(/^\/api\/admin\/video-enhancements\/([^/]+)$/);
  if (enhancementMatch && request.method === "GET") { requireRole(user, ["super_admin"]); return json(response, 200, await refreshEnhancement(store, config, decodeURIComponent(enhancementMatch[1]), user.id)); }
  if (pathname === "/api/asset-library" && request.method === "GET") return json(response, 200, assetLibrary.list(user, Object.fromEntries(url.searchParams)));
  if (pathname === "/api/asset-library" && request.method === "POST") {
    const body = await readJson(request);
    return json(response, 201, await assetLibrary.save(user, body.kind, null, body));
  }
  if (pathname === "/api/asset-library/uploads" && request.method === "POST") return json(response, 201, await receiveAssetUpload(request, user, "library-draft"));
  if (pathname === "/api/asset-library/drafts/discard" && request.method === "POST") {
    const body = await readJson(request);
    if (!Array.isArray(body.ids) || body.ids.length > 50) fail("图片列表无效");
    await store.discardLibraryAssets(body.ids.filter(id => store.getAssetMetadata(id)?.source === "library-draft"), user.id);
    return json(response, 200, { ok: true });
  }
  const libraryMatch = pathname.match(/^\/api\/asset-library\/([^/]+)(?:\/(use))?$/);
  if (libraryMatch) {
    const id = decodeURIComponent(libraryMatch[1]);
    if (libraryMatch[2] === "use" && request.method === "POST") return json(response, 201, await assetLibrary.use(user, id, (await readJson(request)).projectId));
    if (!libraryMatch[2] && request.method === "GET") return json(response, 200, assetLibrary.get(user, id));
    if (!libraryMatch[2] && request.method === "PUT") { const body = await readJson(request); return json(response, 200, await assetLibrary.save(user, body.kind, id, body)); }
    if (!libraryMatch[2] && request.method === "DELETE") return json(response, 200, await assetLibrary.remove(user, id, (await readJson(request)).revision));
  }
  if (pathname === "/api/templates" && request.method === "GET") return json(response, 200, templates.list(user, Object.fromEntries(url.searchParams)));
  const templateMatch = pathname.match(/^\/api\/templates\/([^/]+)(?:\/(file|video|poster|use))?$/);
  if (templateMatch) {
    const id = decodeURIComponent(templateMatch[1]), action = templateMatch[2];
    if (action === "file" && ["GET", "HEAD"].includes(request.method)) {
      const localAccount = request.headers["x-xuti-account-id"];
      if (localAccount && (localAccount !== user.id || templates.entry(user, id).ownerId !== user.id)) fail("登录账号已变化，请重新打开本地模板库", 409);
      const file = await templates.file(user, id);
      if (url.searchParams.get("download") !== "1") return json(response, 200, { text: file.text, name: file.name });
      const filename = encodeURIComponent(file.name).replace(/['()]/g, escape);
      response.writeHead(200, { "Cache-Control": "private, no-store", "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(file.text), "Content-Disposition": `attachment; filename*=UTF-8''${filename}`, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" });
      return response.end(request.method === "HEAD" ? undefined : file.text);
    }
    if (action === "video" && ["GET", "HEAD"].includes(request.method)) return handleAsset(request, response, templates.media(user, id, Number(url.searchParams.get("clip") || 0)), false, user, id);
    if (action === "poster" && ["GET", "HEAD"].includes(request.method)) {
      const assetId = templates.media(user, id), asset = await store.openAsset(assetId);
      if (!asset) return error(response, 404, "作品暂不可用");
      const poster = await videoPoster(asset.filePath, store.getPreviewPath(assetId));
      templates.media(user, id);
      const info = await stat(poster);
      response.writeHead(200, { "Cache-Control": "private, no-store", "Content-Type": "image/webp", "Content-Length": info.size, "X-Content-Type-Options": "nosniff" });
      if (request.method === "HEAD") return response.end();
      return createReadStream(poster).on("error", error => response.destroy(error)).pipe(response);
    }
    if (action === "use" && request.method === "POST") return json(response, 201, projectForClient(await templates.use(user, id), user, config));
    if (!action && request.method === "PATCH") return json(response, 200, await templates.update(user, id, await readJson(request)));
    return error(response, 404, "未找到模板接口");
  }
  if (pathname.startsWith("/api/admin/")) {
    requireRole(user, ["super_admin"]);
    const adminTask = pathname.match(/^\/api\/admin\/tasks\/([^/]+)\/control$/);
    const diagnosticTask = pathname.match(/^\/api\/admin\/tasks\/([^/]+)\/fidelity$/);
    if (diagnosticTask && request.method === "GET") {
      requireRole(user, ["super_admin"]);
      const id = decodeURIComponent(diagnosticTask[1]);
      if (!store.getJob(id)?.payload?.visualReview) fail("没有保存的视觉扫描记录", 404);
      const { automatic } = await worker.fidelity.view(id);
      // Operations can read diagnostics without inheriting the user's media or
      // gaining a new way to mutate/restart a billed request.
      return json(response, 200, { canStartAutomatic: false, automatic: { ...automatic, canSetVideoReview: false, canRecoverSaved: false, viewChoice: undefined }, references: [], videos: [] }, { "Cache-Control": "private, no-store" });
    }
    const receiptTask = pathname.match(/^\/api\/admin\/tasks\/([^/]+)\/compile-receipt$/);
    if (receiptTask && ["GET", "POST"].includes(request.method)) {
      requireRole(user, ["super_admin"]);
      const job = store.getJob(decodeURIComponent(receiptTask[1]));
      if (!job?.payload?.compileReceipt) fail("没有保存的编译回包", 404);
      if (request.method === "GET") return json(response, 200, { outputText: job.payload.compileReceipt.outputText || "" }, { "Cache-Control": "private, no-store" });
      const result = await worker.reprocessCompile(job.id);
      await store.mutate(data => { data.platform.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actorId: user.id, actorName: user.username, action: "compile_local_recovery", target: job.id }); });
      return json(response, 200, { id: result.id, stage: result.stage });
    }
    const validationTask = pathname.match(/^\/api\/admin\/tasks\/([^/]+)\/compile-validation$/);
    if (validationTask && request.method === "POST") {
      requireRole(user, ["super_admin"]);
      const source = store.getJob(decodeURIComponent(validationTask[1]));
      if (!source) fail("任务不存在", 404);
      const input = await readJson(request);
      const result = await worker.startCompile(source.projectId, input.pricingVersion, { validationOf: source.id, actorId: user.id, compileOnly: true, confirmed: input.confirmed, maxCredits: input.maxCredits });
      return json(response, 201, { id: result.id, stage: result.stage });
    }
    if (adminTask && request.method === "POST") {
      const task = store.getJob(decodeURIComponent(adminTask[1]));
      const target = store.data.platform.users.find(u => u.id === task?.ownerId);
      if (!target || (user.role === "admin" && target.role !== "operator")) fail("没有管理该任务的权限", 403);
      const input = await readJson(request);
      if (!["pause", "resume", "cancel"].includes(input.action)) fail("任务操作无效");
      const result = await worker.controlTask(task.id, input.action);
      await store.mutate(data => { data.platform.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actorId: user.id, actorName: user.username, action: `task_${input.action}`, target: task.id }); });
      return json(response, 200, { id: result.id, stage: result.stage });
    }
    return error(response, 404, "未找到管理接口");
  }

  if (pathname === "/api/image/catalog" && request.method === "GET") return json(response, 200, imageCatalog(config, user.role));
  if (pathname === "/api/video/catalog" && request.method === "GET") return json(response, 200, catalogFor(user, config));
  if (pathname === "/api/state" && request.method === "GET") return json(response, 200, stateForClient(user));
  if (pathname === "/api/kernel" && request.method === "GET") { requireRole(user, ["super_admin"]); return json(response, 200, store.getKernel()); }
  if (pathname === "/api/kernel/info" && request.method === "GET") { const kernel = store.getKernel(); return json(response, 200, { version: kernel.version, sha256: kernel.sha256 }); }
  if (pathname === "/api/kernel" && request.method === "PUT") { requireRole(user, ["super_admin"]); const body = await readJson(request); return json(response, 200, await store.updateKernel(String(body.text || ""), String(body.summary || ""))); }
  const revisionMatch = pathname.match(/^\/api\/kernel\/revisions\/([^/]+)$/);
  if (revisionMatch && request.method === "PATCH") { requireRole(user, ["super_admin"]); const body = await readJson(request); return json(response, 200, await store.updateKernelRevisionSummary(decodeURIComponent(revisionMatch[1]), String(body.summary || ""))); }

  if (pathname === "/api/projects" && request.method === "PUT") { const project = await readJson(request); project.videoSelection = selectionForSave(user, config, project.videoSelection); if (project.imageSelection?.modelId) assertImageSelection(user, keyframeImageRoute(config, project.imageSelection)); if (selectVideoRoute(config, project.videoSelection).model.inputMode === "first-frame") { const imageRoute = keyframeImageRoute(config, project.imageSelection); assertImageSelection(user, imageRoute); project.imageSelection = { modelId: imageRoute.model }; } return json(response, 200, projectForClient(await store.saveProject(project, user.id), user, config)); }
  const projectActionMatch = pathname.match(/^\/api\/projects\/([^/]+)\/(trash|restore)$/);
  if (projectActionMatch && request.method === "POST") {
    const id = decodeURIComponent(projectActionMatch[1]);
    const project = projectActionMatch[2] === "trash" ? await store.trashProject(id, user.id) : await store.restoreProject(id, user.id);
    return json(response, 200, projectForClient(project, user, config));
  }
  const endProjectMatch = pathname.match(/^\/api\/projects\/([^/]+)\/end$/);
  if (endProjectMatch && request.method === "POST") return json(response, 200, projectForClient(await worker.endProject(decodeURIComponent(endProjectMatch[1]), user.id), user, config));
  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && request.method === "DELETE") return json(response, 200, await store.deleteProject(decodeURIComponent(projectMatch[1]), user.id));
  if (pathname === "/api/settings" && request.method === "PUT") return json(response, 200, await store.saveSettings(await readJson(request), user.id));

  if (pathname === "/api/assets" && request.method === "POST") return json(response, 201, await receiveAssetUpload(request, user));
  const textMatch = pathname.match(/^\/api\/assets\/([^/]+)\/text$/);
  if (textMatch && ["GET", "HEAD"].includes(request.method)) return handleAsset(request, response, decodeURIComponent(textMatch[1]), true, user);
  const assetMatch = pathname.match(/^\/api\/assets\/([^/]+)$/);
  if (assetMatch && ["GET", "HEAD"].includes(request.method)) return handleAsset(request, response, decodeURIComponent(assetMatch[1]), false, user);

  if (pathname === "/api/model-library" && request.method === "POST") return error(response, 409, "云端隐私模式不保存人物素材库。请保留原图在您的本机；每个云端项目完成后会自动删除其临时上传副本。");
  const modelMatch = pathname.match(/^\/api\/model-library\/([^/]+)$/);
  if (modelMatch && request.method === "DELETE") { owned(user, "modelLibrary", decodeURIComponent(modelMatch[1])); await store.deleteModelProfile(decodeURIComponent(modelMatch[1])); return json(response, 200, { ok: true }); }
  const workSameMatch = pathname.match(/^\/api\/works\/([^/]+)\/same-style$/);
  if (workSameMatch && request.method === "POST") { owned(user, "works", decodeURIComponent(workSameMatch[1])); return json(response, 201, projectForClient(await store.createSameStyleProject(decodeURIComponent(workSameMatch[1])), user, config)); }
  const workActionMatch = pathname.match(/^\/api\/works\/([^/]+)\/(favorite|trash|restore)$/);
  if (workActionMatch && request.method === "POST") { owned(user, "works", decodeURIComponent(workActionMatch[1])); return json(response, 200, await store.updateWork(decodeURIComponent(workActionMatch[1]), workActionMatch[2])); }
  const workMatch = pathname.match(/^\/api\/works\/([^/]+)$/);
  if (workMatch && request.method === "DELETE") { owned(user, "works", decodeURIComponent(workMatch[1])); await store.removeWork(decodeURIComponent(workMatch[1])); return json(response, 200, { ok: true }); }

  // The browser polls tasks frequently while work is running. Keep that route
  // small instead of repeatedly serialising every project, work and asset.
  if (pathname === "/api/tasks" && request.method === "GET") return json(response, 200, store.getTasks(user.id).map(t => taskForQueueClient(t, user)));
  const sceneMatch = pathname.match(/^\/api\/projects\/([^/]+)\/scene-recommendations$/);
  if (sceneMatch) {
    const projectId = decodeURIComponent(sceneMatch[1]); owned(user, "projects", projectId);
    if (request.method === "GET") { const view = worker.scenes.view(projectId); return json(response, 200, { ...view, error: customerText(view.error, config), issue: customerText(view.issue, config) }); }
    if (request.method === "POST") { const body = await readJson(request); return json(response, 200, await worker.scenes.start(projectId, body.pricingVersion)); }
  }
  if (pathname === "/api/tasks/compile" && request.method === "POST") { const body = await readJson(request); owned(user, "projects", body.projectId); return json(response, 201, taskForClient(await worker.startCompile(String(body.projectId || ""), undefined, { compileOnly: true }), user, config)); }
  if (pathname === "/api/tasks/generate" && request.method === "POST") { const body = await readJson(request); owned(user, "projects", body.projectId); return json(response, 201, taskForClient(await worker.startGeneration(String(body.projectId || "")), user, config)); }
  const anyTask = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/|$)/);
  if (anyTask) owned(user, "tasks", decodeURIComponent(anyTask[1]));
  const fidelityMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/fidelity$/);
  if (fidelityMatch && request.method === "GET") {
    const view = await worker.fidelity.view(decodeURIComponent(fidelityMatch[1]));
    if (user.role !== "super_admin") view.automatic.records = view.automatic.records.map(({ validationIssue, ...record }) => ({ ...record, error: customerText(record.error, config), issues: record.issues.map(issue => ({ ...issue, message: customerText(issue.message, config) })) }));
    return json(response, 200, view);
  }
  if (fidelityMatch && request.method === "POST") {
    const id = decodeURIComponent(fidelityMatch[1]), body = await readJson(request);
    if (body.action === "auto") return json(response, 200, await worker.visual.start(id, user.id));
    if (body.action === "video-review") return json(response, 200, await worker.visual.setVideoReview(id, body.enabled, user.id));
    if (body.action === "view-choice") return json(response, 200, await worker.visual.chooseView(id, body, user.id));
    return error(response, 400, "素材与画面由视觉模型扫描，不支持手动确认放行");
  }
  const keyframesMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/keyframes$/);
  if (keyframesMatch && request.method === "GET") return json(response, 200, reviewForClient(await worker.keyframes.view(decodeURIComponent(keyframesMatch[1])), user, config));
  if (keyframesMatch && request.method === "POST") {
    const id = decodeURIComponent(keyframesMatch[1]);
    const body = await readJson(request);
    if (!["generate", "regenerate", "release", "select-model"].includes(body.action)) return error(response, 400, "关键帧需由视觉扫描通过，不支持手动确认放行");
    if (body.action === "select-model") assertImageSelection(user, keyframeImageRoute(config, { modelId: body.modelId }));
    if (["generate", "regenerate"].includes(body.action)) assertImageSelection(user, store.getJob(id)?.payload?.keyframeGate?.imageRoute);
    const result = await worker.keyframes.action(id, { action: body.action, unitId: body.unitId, revision: body.revision, truthRevision: body.truthRevision, checks: body.checks, correction: body.correction, pricingVersion: body.pricingVersion, modelId: body.modelId, imageModelId: body.imageModelId });
    worker.wake();
    return json(response, 200, result);
  }
  const keyframeUploadMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/keyframes\/upload$/);
  if (keyframeUploadMatch && request.method === "POST") {
    const id = decodeURIComponent(keyframeUploadMatch[1]);
    const job = store.getJob(id);
    if (!job || job.type !== "generate") return error(response, 404, "任务不存在");
    const form = await readKeyframeForm(request);
    const file = form.get("file");
    if (!(file instanceof File)) return error(response, 400, "请上传关键帧图片");
    const buffer = Buffer.from(await file.arrayBuffer());
    const review = await worker.keyframes.view(id);
    const info = await checkedKeyframe(buffer, review?.videoInputMode === "first-frame" ? review.aspectRatio : undefined, job.payload?.videoRoute?.model?.minImageSide || 240);
    const asset = await store.putAsset({ buffer, name: file.name, kind: "output", mime: info.mime, projectId: job.projectId, source: "keyframe-upload" });
    await worker.keyframes.action(id, { action: "upload", asset, dimensions: `${info.width}×${info.height}`, unitId: String(form.get("unitId")), revision: String(form.get("revision")) });
    worker.wake();
    return json(response, 201, { ok: true });
  }
  const controlMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/control$/);
  if (controlMatch && request.method === "POST") { const id = decodeURIComponent(controlMatch[1]); owned(user, "tasks", id); const body = await readJson(request); return json(response, 200, taskForClient(await worker.controlTask(id, String(body.action || ""), { acknowledged: body.acknowledged === true }), user, config)); }
  const recoverMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/recover$/);
  if (recoverMatch && request.method === "POST") { const id = decodeURIComponent(recoverMatch[1]); owned(user, "tasks", id); return json(response, 200, taskForClient(await worker.controlTask(id, "resume"), user, config)); }
  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && request.method === "DELETE") { const id = decodeURIComponent(taskMatch[1]); owned(user, "tasks", id); await worker.deleteFailedTask(id); return json(response, 200, { ok: true }); }
  const queueRunMatch = pathname.match(/^\/api\/task-runs\/([^/]+)$/);
  if (queueRunMatch && request.method === "DELETE") return json(response, 200, await worker.removeEndedRunFromQueue(decodeURIComponent(queueRunMatch[1]), user.id));

  if (pathname === "/api/learning" && request.method === "POST") { const input = await readJson(request); owned(user, "tasks", input.taskId); return json(response, 201, await worker.submitFeedback(input)); }
  const learningMatch = pathname.match(/^\/api\/learning\/([^/]+)$/);
  if (learningMatch && request.method === "PATCH") { requireRole(user, ["super_admin"]); return json(response, 200, await worker.updateLearningCase(decodeURIComponent(learningMatch[1]), await readJson(request))); }
  const accountMatch = pathname.match(/^\/api\/accounts\/(chatgpt|grok)$/);
  if (accountMatch && ["GET", "POST"].includes(request.method)) return json(response, 200, accountsForClient(user)[accountMatch[1]]);
  if (pathname.match(/^\/api\/tasks\/[^/]+\/browser$/)) return error(response, 410, "云端版已取消内嵌浏览器，任务通过 API 执行");

  return error(response, 404, "未找到云端 API 路由");
}


  return { store, config, worker, digitalHuman, start, stop,
    syncUsers: users => platform.syncUsers(users),
    handle: async (request, response, url, user) => {
      request.aigcUser = user;
      return handleApi(request, response, url);
    }
  };
}
